/**
 * موتور گرافیکی سه‌بعدی اختصاصی «مطب دندان‌پزشکی آویدا» (Avida 3D Dental Engine)
 * شامل:
 * ۱. مدل سه‌بعدی واقعی دندان، ریشه و ایمپلنت دیجیتال با نورپردازی PBR/Phong و واکنش به نشانگر
 * ۲. توقف خودکار هنگام خروج از دید (IntersectionObserver) و رعایت prefers-reduced-motion
 * ۳. تصویرسازی‌های سه‌بعدی اختصاصی برای خدمات دندان‌پزشکی
 * ۴. کارت‌های دارای عمق بصری سه‌بعدی (3D Perspective Tilt & Specular Highlight)
 * ۵. صحنه سه‌بعدی جشن تکمیل موفق رزرو نوبت
 */

(function (global) {
  'use strict';

  const prefersReducedMotion = () =>
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // -------------------------------------------------------------------------
  // ۱. تولید هندسه سه‌بعدی دندان (تاج ۴ کاسپی، طوق، دو ریشه، کانال پالپ و ایمپلنت)
  // -------------------------------------------------------------------------
  function buildToothMesh() {
    const faces = [];
    const latSteps = 22;
    const lonSteps = 28;

    // تابع شعاع و فرم کالبدشناختی دندان مولر در مختصات استوانه‌ای-کروی
    function toothVertex(u, v, scale = 1.0, yOffset = 0) {
      // u از 0 تا 1 (از نوک ریشه در پایین تا سطح جونده تاج در بالا)
      // v از 0 تا 2*PI (زاویه پیرامونی)
      const angle = v;
      let y = (u - 0.48) * 2.55; // محدوده ارتفاع
      let r = 0;
      let xShift = 0;
      let zShift = 0;

      if (u >= 0.48) {
        // بخش تاج دندان (Crown) با ۴ کاسپ آناتومیک
        const t = (u - 0.48) / 0.52; // 0 در طوق، 1 در سقف تاج
        const bulge = Math.sin(t * Math.PI * 0.88) * 0.92 + (1 - t) * 0.58;
        const squareness = 1 + 0.08 * Math.cos(4 * angle);
        r = bulge * squareness * (1 - 0.12 * Math.pow(t, 3));

        // برجستگی ۴ کاسپ جونده در بالای تاج
        if (t > 0.68) {
          const cuspFactor = (t - 0.68) / 0.32;
          const cuspWave = Math.pow(Math.abs(Math.sin(2 * angle)), 1.3) * 0.24 * cuspFactor;
          const centralFossa = t > 0.88 ? -0.16 * ((t - 0.88) / 0.12) : 0;
          y += cuspWave + centralFossa;
        }
        if (t > 0.96) {
          r *= 0.18;
        }
      } else {
        // بخش ریشه دوگانه (Bifurcated Roots)
        const t = (0.48 - u) / 0.48; // 0 در طوق، 1 در اپکس ریشه
        const taper = Math.pow(1 - t * 0.88, 1.15) * 0.62;
        const rootSplit = Math.sin(t * Math.PI * 0.85) * 0.36;
        // ایجاد فرورفتگی بین دو ریشه
        const pinch = 1 - 0.42 * Math.min(1, t * 2.2) * Math.pow(Math.sin(angle), 2);
        r = taper * pinch;
        xShift = (Math.cos(angle) >= 0 ? 1 : -1) * rootSplit * 0.28 * t;
        zShift = Math.sin(t * Math.PI) * 0.06;
      }

      return {
        x: (r * Math.cos(angle) + xShift) * scale,
        y: -(y + yOffset) * scale, // در بوم دوبعدی، Y منفی به سمت بالاست
        z: (r * Math.sin(angle) + zShift) * scale,
        u,
        v,
      };
    }

    // الف) پوسته بیرونی مینا و ریشه
    for (let i = 0; i < latSteps; i++) {
      const u0 = i / latSteps;
      const u1 = (i + 1) / latSteps;
      for (let j = 0; j < lonSteps; j++) {
        const v0 = (j / lonSteps) * Math.PI * 2;
        const v1 = ((j + 1) / lonSteps) * Math.PI * 2;

        const p00 = toothVertex(u0, v0, 1.0, 0);
        const p10 = toothVertex(u1, v0, 1.0, 0);
        const p11 = toothVertex(u1, v1, 1.0, 0);
        const p01 = toothVertex(u0, v1, 1.0, 0);

        const isCrown = (u0 + u1) * 0.5 >= 0.47;
        faces.push({
          verts: [p00, p10, p11, p01],
          layer: isCrown ? 'enamel' : 'root',
          uMid: (u0 + u1) * 0.5,
          vMid: (v0 + v1) * 0.5,
        });
      }
    }

    // ب) هسته پالپ و کانال ریشه (Pulp Chamber) برای نمای کالبدشکافی
    const pulpLat = 12;
    const pulpLon = 16;
    for (let i = 1; i < pulpLat; i++) {
      const u0 = (i / pulpLat) * 0.85 + 0.08;
      const u1 = ((i + 1) / pulpLat) * 0.85 + 0.08;
      for (let j = 0; j < pulpLon; j++) {
        const v0 = (j / pulpLon) * Math.PI * 2;
        const v1 = ((j + 1) / pulpLon) * Math.PI * 2;
        const p00 = toothVertex(u0, v0, 0.42, 0.02);
        const p10 = toothVertex(u1, v0, 0.42, 0.02);
        const p11 = toothVertex(u1, v1, 0.42, 0.02);
        const p01 = toothVertex(u0, v1, 0.42, 0.02);
        faces.push({
          verts: [p00, p10, p11, p01],
          layer: 'pulp',
          uMid: (u0 + u1) * 0.5,
          vMid: (v0 + v1) * 0.5,
        });
      }
    }

    // ج) پایه تیتانیومی رزوه‌دار ایمپلنت دیجیتال (Titanium Implant Screw)
    const impLat = 14;
    const impLon = 18;
    for (let i = 0; i < impLat; i++) {
      const t0 = i / impLat;
      const t1 = (i + 1) / impLat;
      const y0 = 0.05 + t0 * 1.22;
      const y1 = 0.05 + t1 * 1.22;
      const thread0 = 0.36 * (1 - t0 * 0.32) + (i % 2 === 0 ? 0.045 : -0.02);
      const thread1 = 0.36 * (1 - t1 * 0.32) + ((i + 1) % 2 === 0 ? 0.045 : -0.02);

      for (let j = 0; j < impLon; j++) {
        const a0 = (j / impLon) * Math.PI * 2;
        const a1 = ((j + 1) / impLon) * Math.PI * 2;
        faces.push({
          verts: [
            { x: thread0 * Math.cos(a0), y: y0, z: thread0 * Math.sin(a0) },
            { x: thread1 * Math.cos(a0), y: y1, z: thread1 * Math.sin(a0) },
            { x: thread1 * Math.cos(a1), y: y1, z: thread1 * Math.sin(a1) },
            { x: thread0 * Math.cos(a1), y: y0, z: thread0 * Math.sin(a1) },
          ],
          layer: 'implant',
          uMid: t0,
          vMid: a0,
        });
      }
    }

    return faces;
  }

  // محاسبه بردار نرمال صفحه و مرکز ثقل چهارضلعی
  function computeFaceGeometry(verts) {
    const cx = (verts[0].x + verts[1].x + verts[2].x + verts[3].x) * 0.25;
    const cy = (verts[0].y + verts[1].y + verts[2].y + verts[3].y) * 0.25;
    const cz = (verts[0].z + verts[1].z + verts[2].z + verts[3].z) * 0.25;

    const ux = verts[1].x - verts[0].x;
    const uy = verts[1].y - verts[0].y;
    const uz = verts[1].z - verts[0].z;

    const vx = verts[3].x - verts[0].x;
    const vy = verts[3].y - verts[0].y;
    const vz = verts[3].z - verts[0].z;

    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;

    return { cx, cy, cz, nx, ny, nz };
  }

  function rotatePoint(p, rx, ry, rz) {
    // چرخش حول Y
    const cosY = Math.cos(ry);
    const sinY = Math.sin(ry);
    let x1 = p.x * cosY + p.z * sinY;
    let y1 = p.y;
    let z1 = -p.x * sinY + p.z * cosY;

    // چرخش حول X
    const cosX = Math.cos(rx);
    const sinX = Math.sin(rx);
    let x2 = x1;
    let y2 = y1 * cosX - z1 * sinX;
    let z2 = y1 * sinX + z1 * cosX;

    // چرخش حول Z
    const cosZ = Math.cos(rz);
    const sinZ = Math.sin(rz);
    let x3 = x2 * cosZ - y2 * sinZ;
    let y3 = x2 * sinZ + y2 * cosZ;
    let z3 = z2;

    return { x: x3, y: y3, z: z3 };
  }

  // -------------------------------------------------------------------------
  // ۲. کلاس کنترلر صحنه سه‌بعدی اصلی (Hero 3D Controller)
  // -------------------------------------------------------------------------
  class AvidaHero3D {
    constructor(canvasEl) {
      this.canvas = canvasEl;
      if (!this.canvas) return;
      this.ctx = this.canvas.getContext('2d');
      if (!this.ctx) return;
      this.destroyed = false;
      this.eventController = new AbortController();
      this.faces = buildToothMesh();
      this.mode = 'enamel'; // 'enamel' | 'anatomy' | 'implant'
      this.pausedByUser = prefersReducedMotion();
      this.inViewport = true;
      this.tabVisible = !document.hidden;

      this.rotY = 0.45;
      this.rotX = -0.16;
      this.targetRotY = 0.45;
      this.targetRotX = -0.16;
      this.pointerX = 0;
      this.pointerY = 0;
      this.isDragging = false;
      this.lastClientX = 0;
      this.lastClientY = 0;
      this.time = 0;
      this.rafId = null;

      // ذرات معلق لبخند و مواد معدنی مینا
      this.particles = Array.from({ length: 28 }, (_, idx) => ({
        angle: (idx / 28) * Math.PI * 2,
        radius: 1.35 + (idx % 5) * 0.16,
        y: ( (idx % 7) - 3 ) * 0.28,
        speed: 0.004 + (idx % 4) * 0.0015,
        size: 1.8 + (idx % 3) * 1.1,
        isCoral: idx % 7 === 0,
      }));

      this.bindEvents();
      this.resize();
      this.renderFrame();
      if (!this.pausedByUser) {
        this.startLoop();
      }
    }

    bindEvents() {
      this.onResize = () => {
        this.resize();
        this.renderFrame();
      };
      window.addEventListener('resize', this.onResize, { passive: true, signal: this.eventController.signal });

      // واکنش نرم به حرکت نشانگر و کشیدن
      this.canvas.addEventListener('pointermove', (e) => {
        const rect = this.canvas.getBoundingClientRect();
        const nx = ((e.clientX - rect.left) / (rect.width || 1)) * 2 - 1;
        const ny = ((e.clientY - rect.top) / (rect.height || 1)) * 2 - 1;
        this.pointerX = nx;
        this.pointerY = ny;

        if (this.isDragging) {
          const dx = e.clientX - this.lastClientX;
          const dy = e.clientY - this.lastClientY;
          this.targetRotY += dx * 0.012;
          this.targetRotX = Math.max(-0.65, Math.min(0.65, this.targetRotX + dy * 0.01));
          this.lastClientX = e.clientX;
          this.lastClientY = e.clientY;
        } else {
          this.targetRotX = -0.16 + ny * 0.28;
        }
        if (this.pausedByUser) this.renderFrame();
      }, { signal: this.eventController.signal });

      this.canvas.addEventListener('pointerdown', (e) => {
        this.isDragging = true;
        this.lastClientX = e.clientX;
        this.lastClientY = e.clientY;
      }, { signal: this.eventController.signal });

      window.addEventListener('pointerup', () => {
        this.isDragging = false;
      }, { signal: this.eventController.signal });

      // توقف خودکار هنگام خروج از دید (IntersectionObserver)
      if ('IntersectionObserver' in window) {
        this.observer = new IntersectionObserver(
          (entries) => {
            entries.forEach((entry) => {
              this.inViewport = entry.isIntersecting;
              this.updateLoopState();
            });
          },
          { threshold: 0.05 }
        );
        this.observer.observe(this.canvas);
      }

      document.addEventListener('visibilitychange', () => {
        this.tabVisible = !document.hidden;
        this.updateLoopState();
      }, { signal: this.eventController.signal });
      this.motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
      this.motionPreference.addEventListener('change', () => this.updateLoopState(), { signal: this.eventController.signal });
    }

    destroy() {
      this.destroyed = true;
      if (this.rafId) cancelAnimationFrame(this.rafId);
      this.rafId = null;
      if (this.observer) this.observer.disconnect();
      if (this.eventController) this.eventController.abort();
    }

    setMode(newMode) {
      this.mode = newMode;
      this.renderFrame();
    }

    togglePause() {
      this.pausedByUser = !this.pausedByUser;
      this.updateLoopState();
      return this.pausedByUser;
    }

    updateLoopState() {
      const shouldRun = !this.destroyed && !this.pausedByUser && this.inViewport && this.tabVisible && !prefersReducedMotion();
      if (shouldRun && !this.rafId) {
        this.startLoop();
      } else if (!shouldRun && this.rafId) {
        cancelAnimationFrame(this.rafId);
        this.rafId = null;
      }
    }

    startLoop() {
      if (this.destroyed || this.rafId || prefersReducedMotion()) return;
      const step = () => {
        if (this.destroyed || this.canvas.isConnected === false || this.pausedByUser || !this.inViewport || !this.tabVisible || prefersReducedMotion()) {
          this.rafId = null;
          return;
        }
        this.time += 0.018;
        if (!this.isDragging) {
          this.targetRotY += 0.0075;
        }
        this.rotY += (this.targetRotY + this.pointerX * 0.35 - this.rotY) * 0.08;
        this.rotX += (this.targetRotX - this.rotX) * 0.08;
        this.renderFrame();
        this.rafId = requestAnimationFrame(step);
      };
      this.rafId = requestAnimationFrame(step);
    }

    resize() {
      if (!this.canvas) return;
      const rect = this.canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(300, rect.width || 460);
      const h = Math.max(260, rect.height || 330);
      this.canvas.width = w * dpr;
      this.canvas.height = h * dpr;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.width = w;
      this.height = h;
    }

    renderFrame() {
      if (!this.ctx || this.destroyed) return;
      const ctx = this.ctx;
      const w = this.width || 460;
      const h = this.height || 330;
      const cx = w * 0.5;
      const cy = h * 0.52 + Math.sin(this.time * 1.4) * 4;
      const fov = Math.min(w, h) * 0.46;

      ctx.clearRect(0, 0, w, h);

      // ۱. هاله نوری پس‌زمینه و حلقه‌های مداری اسکن دیجیتال سه‌بعدی
      const glow = ctx.createRadialGradient(cx, cy - 10, 12, cx, cy, fov * 1.35);
      glow.addColorStop(0, 'rgba(16, 185, 129, 0.28)');
      glow.addColorStop(0.55, 'rgba(13, 148, 136, 0.09)');
      glow.addColorStop(1, 'rgba(9, 21, 27, 0)');
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, w, h);

      // حلقه اسکن سه‌بعدی دور دندان
      ctx.save();
      ctx.translate(cx, cy + 18);
      ctx.scale(1, 0.36);
      ctx.beginPath();
      ctx.arc(0, 0, fov * 1.05, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(52, 211, 153, 0.32)';
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(0, 0, fov * 1.24, this.time * 0.8, this.time * 0.8 + Math.PI * 1.35);
      ctx.strokeStyle = 'rgba(244, 63, 94, 0.55)';
      ctx.lineWidth = 2.2;
      ctx.stroke();
      ctx.restore();

      // ۲. پردازش و مرتب‌سازی عمق سطوح سه‌بعدی (Painter's Algorithm + Blinn-Phong Shading)
      const renderList = [];
      const lightKey = { x: 0.52, y: -0.65, z: -0.55 }; // نور کلینیکی سفید
      const lightRim = { x: -0.7, y: 0.3, z: 0.64 };   // نور لبه سبز زمردی

      for (let i = 0; i < this.faces.length; i++) {
        const f = this.faces[i];

        // فیلتر لایه‌ها بر اساس حالت انتخابی کاربر
        if (this.mode === 'enamel' && (f.layer === 'pulp' || f.layer === 'implant')) continue;
        if (this.mode === 'anatomy' && f.layer === 'implant') continue;
        if (this.mode === 'implant' && (f.layer === 'root' || f.layer === 'pulp')) continue;

        // در حالت ایمپلنت، تاج کمی بالاتر قرار می‌گیرد تا اتصال ایمپلنت دیده شود
        const crownLift = this.mode === 'implant' && f.layer === 'enamel' ? -0.14 : 0;

        const rVerts = f.verts.map((v) => {
          const shifted = { x: v.x, y: v.y + crownLift, z: v.z };
          return rotatePoint(shifted, this.rotX, this.rotY, 0.04 * Math.sin(this.time));
        });

        const geom = computeFaceGeometry(rVerts);
        // تبدیل پرسپکتیو
        const projVerts = rVerts.map((rv) => {
          const dist = 3.4 + rv.z;
          const scale = fov / Math.max(0.8, dist);
          return {
            x: cx + rv.x * scale,
            y: cy + rv.y * scale,
          };
        });

        renderList.push({
          projVerts,
          zDepth: geom.cz,
          nx: geom.nx,
          ny: geom.ny,
          nz: geom.nz,
          layer: f.layer,
          uMid: f.uMid,
        });
      }

      // مرتب‌سازی از دورترین (z بزرگ‌تر) به نزدیک‌ترین (z کوچک‌تر)
      renderList.sort((a, b) => b.zDepth - a.zDepth);

      // ۳. رندر صفحات سه‌بعدی با شیدر اختصاصی هر بافت
      for (let i = 0; i < renderList.length; i++) {
        const item = renderList[i];
        const { nx, ny, nz, layer, projVerts } = item;

        const diffKey = Math.max(0, -(nx * lightKey.x + ny * lightKey.y + nz * lightKey.z));
        const diffRim = Math.max(0, -(nx * lightRim.x + ny * lightRim.y + nz * lightRim.z));
        const spec = Math.pow(Math.max(0, -nz * 0.7 + diffKey * 0.5), 14);

        let fillStyle = '';
        let strokeStyle = '';

        if (layer === 'enamel') {
          if (this.mode === 'anatomy') {
            // نمای نیمه‌شفاف کالبدشکافی
            const alpha = 0.24 + diffRim * 0.22;
            fillStyle = `rgba(209, 250, 229, ${alpha.toFixed(2)})`;
            strokeStyle = 'rgba(52, 211, 153, 0.28)';
          } else {
            // مینای مرواریدی طبیعی با درخشش سبز کلینیکال
            const r = Math.min(255, Math.round(218 + diffKey * 34 + spec * 28 - diffRim * 15));
            const g = Math.min(255, Math.round(234 + diffKey * 20 + spec * 22 + diffRim * 10));
            const b = Math.min(255, Math.round(232 + diffKey * 20 + spec * 25 + diffRim * 6));
            fillStyle = `rgb(${r}, ${g}, ${b})`;
            strokeStyle = `rgba(16, 185, 129, ${(0.08 + diffRim * 0.18).toFixed(2)})`;
          }
        } else if (layer === 'root') {
          const alpha = this.mode === 'anatomy' ? 0.28 : 0.96;
          const r = Math.min(255, Math.round(205 + diffKey * 36));
          const g = Math.min(255, Math.round(196 + diffKey * 34));
          const b = Math.min(255, Math.round(176 + diffKey * 28));
          fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
          strokeStyle = 'rgba(148, 163, 184, 0.15)';
        } else if (layer === 'pulp') {
          // پالپ و عصب دندان با رنگ قرمز مرجانی درخشان
          const pulse = 0.85 + 0.15 * Math.sin(this.time * 3);
          const r = Math.min(255, Math.round((215 + diffKey * 40) * pulse));
          const g = Math.min(255, Math.round(45 + diffKey * 35));
          const b = Math.min(255, Math.round(82 + diffKey * 40));
          fillStyle = `rgba(${r}, ${g}, ${b}, 0.92)`;
          strokeStyle = 'rgba(251, 113, 133, 0.45)';
        } else if (layer === 'implant') {
          // تیتانیوم متالیک جراحی
          const base = 115 + diffKey * 90 + spec * 55;
          const r = Math.min(255, Math.round(base * 0.88));
          const g = Math.min(255, Math.round(base * 0.98 + diffRim * 25));
          const b = Math.min(255, Math.round(base * 1.04 + diffRim * 20));
          fillStyle = `rgb(${r}, ${g}, ${b})`;
          strokeStyle = 'rgba(52, 211, 153, 0.35)';
        }

        ctx.beginPath();
        ctx.moveTo(projVerts[0].x, projVerts[0].y);
        ctx.lineTo(projVerts[1].x, projVerts[1].y);
        ctx.lineTo(projVerts[2].x, projVerts[2].y);
        ctx.lineTo(projVerts[3].x, projVerts[3].y);
        ctx.closePath();
        ctx.fillStyle = fillStyle;
        ctx.fill();
        if (strokeStyle) {
          ctx.strokeStyle = strokeStyle;
          ctx.lineWidth = 0.65;
          ctx.stroke();
        }
      }

      // ۴. ذرات معلق سه‌بعدی در اطراف مدل دندان
      for (let i = 0; i < this.particles.length; i++) {
        const pt = this.particles[i];
        const ang = pt.angle + this.time * (pt.speed * 60) + this.rotY * 0.5;
        const px3 = Math.cos(ang) * pt.radius;
        const pz3 = Math.sin(ang) * pt.radius;
        const py3 = pt.y + Math.sin(this.time * 1.5 + i) * 0.08;
        const dist = 3.4 + pz3;
        const sc = fov / Math.max(0.8, dist);
        const sx = cx + px3 * sc;
        const sy = cy + py3 * sc;

        ctx.beginPath();
        ctx.arc(sx, sy, pt.size * (sc / fov), 0, Math.PI * 2);
        ctx.fillStyle = pt.isCoral
          ? 'rgba(244, 63, 94, 0.78)'
          : 'rgba(52, 211, 153, 0.72)';
        ctx.fill();
      }
    }
  }

  // -------------------------------------------------------------------------
  // ۳. تصویرسازی‌های سه‌بعدی اختصاصی برای کارت‌های خدمات (Service 3D SVG/Depth)
  // -------------------------------------------------------------------------
  function getService3DSVG(modelType) {
    const commonDefs = `
      <defs>
        <radialGradient id="enamelGrad" cx="35%" cy="28%" r="70%">
          <stop offset="0%" stop-color="#FFFFFF"/>
          <stop offset="58%" stop-color="#D1FAE5"/>
          <stop offset="100%" stop-color="#059669"/>
        </radialGradient>
        <linearGradient id="titaniumGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#E2E8F0"/>
          <stop offset="50%" stop-color="#64748B"/>
          <stop offset="100%" stop-color="#0F172A"/>
        </linearGradient>
        <linearGradient id="coralGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#FDA4AF"/>
          <stop offset="100%" stop-color="#E11D48"/>
        </linearGradient>
      </defs>
    `;

    if (modelType === 'implant') {
      return `
        <svg viewBox="0 0 220 130" width="100%" height="100%" role="img" aria-label="مدل سه‌بعدی ایمپلنت دیجیتال">
          ${commonDefs}
          <ellipse cx="110" cy="112" rx="54" ry="10" fill="rgba(52,211,153,0.18)"/>
          <path d="M84,22 C84,12 100,12 110,18 C120,12 136,12 136,22 C139,38 132,54 126,58 L94,58 C88,54 81,38 84,22 Z" fill="url(#enamelGrad)"/>
          <rect x="97" y="58" width="26" height="10" rx="3" fill="#34D399"/>
          <path d="M98,68 L122,68 L117,108 L103,108 Z" fill="url(#titaniumGrad)"/>
          <line x1="96" y1="76" x2="124" y2="79" stroke="#A7F3D0" stroke-width="2.5"/>
          <line x1="98" y1="86" x2="122" y2="89" stroke="#A7F3D0" stroke-width="2.5"/>
          <line x1="100" y1="96" x2="120" y2="99" stroke="#A7F3D0" stroke-width="2.5"/>
          <circle cx="155" cy="34" r="6" fill="url(#coralGrad)"/>
        </svg>
      `;
    }

    if (modelType === 'laminate') {
      return `
        <svg viewBox="0 0 220 130" width="100%" height="100%" role="img" aria-label="مدل سه‌بعدی لمینت سرامیکی و طراحی لبخند">
          ${commonDefs}
          <ellipse cx="110" cy="110" rx="64" ry="10" fill="rgba(52,211,153,0.18)"/>
          <path d="M72,30 C72,18 98,18 104,28 L102,88 C92,94 76,88 72,68 Z" fill="rgba(255,255,255,0.35)" stroke="#34D399" stroke-width="1.5"/>
          <path d="M96,24 C96,12 128,12 134,24 L131,92 C118,100 100,94 96,72 Z" fill="url(#enamelGrad)"/>
          <path d="M126,18 L131,28 L141,30 L132,36 L135,46 L126,39 L117,46 L120,36 L111,30 L121,28 Z" fill="#34D399"/>
        </svg>
      `;
    }

    if (modelType === 'ortho') {
      return `
        <svg viewBox="0 0 220 130" width="100%" height="100%" role="img" aria-label="مدل سه‌بعدی ارتودنسی شفاف">
          ${commonDefs}
          <path d="M48,78 Q110,24 172,78" fill="none" stroke="#34D399" stroke-width="14" stroke-linecap="round" opacity="0.32"/>
          <rect x="64" y="48" width="20" height="28" rx="8" fill="url(#enamelGrad)"/>
          <rect x="88" y="42" width="20" height="32" rx="8" fill="url(#enamelGrad)"/>
          <rect x="112" y="42" width="20" height="32" rx="8" fill="url(#enamelGrad)"/>
          <rect x="136" y="48" width="20" height="28" rx="8" fill="url(#enamelGrad)"/>
          <path d="M56,62 Q110,46 164,62" fill="none" stroke="#FFFFFF" stroke-width="3" stroke-dasharray="5 4"/>
        </svg>
      `;
    }

    if (modelType === 'endo') {
      return `
        <svg viewBox="0 0 220 130" width="100%" height="100%" role="img" aria-label="مدل سه‌بعدی درمان ریشه میکروسکوپی">
          ${commonDefs}
          <path d="M82,22 C82,12 102,14 110,20 C118,14 138,12 138,22 C142,42 132,60 126,74 L120,110 L113,78 L107,78 L100,110 L94,74 C88,60 78,42 82,22 Z" fill="rgba(209,250,229,0.28)" stroke="#34D399" stroke-width="1.8"/>
          <path d="M98,36 Q110,32 122,36 L118,74 L118,104 M102,74 L102,104" fill="none" stroke="url(#coralGrad)" stroke-width="4.5" stroke-linecap="round"/>
          <circle cx="110" cy="46" r="9" fill="url(#coralGrad)"/>
        </svg>
      `;
    }

    if (modelType === 'bleaching') {
      return `
        <svg viewBox="0 0 220 130" width="100%" height="100%" role="img" aria-label="مدل سه‌بعدی سفیدکردن دندان با لیزر">
          ${commonDefs}
          <path d="M85,26 C85,14 103,14 110,21 C117,14 135,14 135,26 C138,48 128,74 122,98 L113,72 L107,72 L98,98 C92,74 82,48 85,26 Z" fill="url(#enamelGrad)"/>
          <circle cx="65" cy="35" r="5" fill="#34D399"/>
          <circle cx="156" cy="42" r="7" fill="#A7F3D0"/>
          <path d="M45,22 L88,48 M175,22 L132,48" stroke="#34D399" stroke-width="2.5" stroke-linecap="round"/>
        </svg>
      `;
    }

    // pediatric / default
    return `
      <svg viewBox="0 0 220 130" width="100%" height="100%" role="img" aria-label="مدل سه‌بعدی دندان‌پزشکی پیشگیرانه">
        ${commonDefs}
        <path d="M86,28 C86,16 103,16 110,23 C117,16 134,16 134,28 C136,48 128,72 121,94 L112,72 L108,72 L99,94 C92,72 84,48 86,28 Z" fill="url(#enamelGrad)"/>
        <path d="M100,46 Q110,56 120,46" fill="none" stroke="#064E3B" stroke-width="3" stroke-linecap="round"/>
        <circle cx="101" cy="36" r="2.8" fill="#064E3B"/>
        <circle cx="119" cy="36" r="2.8" fill="#064E3B"/>
        <circle cx="148" cy="30" r="8" fill="url(#coralGrad)"/>
      </svg>
    `;
  }

  // -------------------------------------------------------------------------
  // ۴. فعال‌سازی عمق سه‌بعدی کارت‌ها (3D Card Tilt & Glare)
  // -------------------------------------------------------------------------
  function attach3DCards(rootEl = document) {
    if (prefersReducedMotion()) return;
    const cards = rootEl.querySelectorAll('.card-3d');
    cards.forEach((card) => {
      if (card.dataset.tiltBound === '1') return;
      card.dataset.tiltBound = '1';

      card.addEventListener('pointermove', (e) => {
        const rect = card.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const pctX = (x / (rect.width || 1)) - 0.5;
        const pctY = (y / (rect.height || 1)) - 0.5;

        card.style.setProperty('--mouse-x', `${x}px`);
        card.style.setProperty('--mouse-y', `${y}px`);
        card.style.transform = `perspective(900px) rotateX(${(-pctY * 5.5).toFixed(2)}deg) rotateY(${(pctX * 5.5).toFixed(2)}deg) translateY(-4px)`;
      });

      card.addEventListener('pointerleave', () => {
        card.style.transform = '';
      });
    });
  }

  // -------------------------------------------------------------------------
  // ۵. صحنه سه‌بعدی جشن تکمیل موفق رزرو نوبت (Booking Celebration 3D)
  // -------------------------------------------------------------------------
  function playBookingCelebration3D(canvasEl) {
    if (!canvasEl) return;
    const ctx = canvasEl.getContext('2d');
    if (!ctx) return;
    const w = (canvasEl.width = 280);
    const h = (canvasEl.height = 170);
    let t = 0;
    let frames = 0;
    let rafId = null;
    let stopped = false;
    const maxFrames = prefersReducedMotion() ? 1 : 180;

    const confetti = Array.from({ length: 26 }, (_, i) => ({
      angle: (i / 26) * Math.PI * 2,
      r: 22 + (i % 5) * 14,
      speed: 0.03 + (i % 3) * 0.015,
      color: i % 4 === 0 ? '#F43F5E' : i % 2 === 0 ? '#10B981' : '#34D399',
      size: 3 + (i % 3) * 1.5,
    }));

    function draw() {
      if (stopped || canvasEl.isConnected === false) return;
      t += 0.05;
      frames++;
      ctx.clearRect(0, 0, w, h);

      const cx = w / 2;
      const cy = h / 2;

      // هاله سبز جشن
      const grad = ctx.createRadialGradient(cx, cy, 8, cx, cy, 78);
      grad.addColorStop(0, 'rgba(16, 185, 129, 0.35)');
      grad.addColorStop(1, 'rgba(16, 185, 129, 0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);

      // ذرات مداری جشن
      confetti.forEach((c, idx) => {
        const a = c.angle + t * c.speed * 18;
        const rad = c.r + Math.sin(t + idx) * 6;
        const px = cx + Math.cos(a) * rad * 1.25;
        const py = cy + Math.sin(a) * rad * 0.75;
        ctx.beginPath();
        ctx.arc(px, py, c.size, 0, Math.PI * 2);
        ctx.fillStyle = c.color;
        ctx.fill();
      });

      // گوی سه‌بعدی مرکزی و نماد دندان تأییدشده
      ctx.save();
      ctx.translate(cx, cy + Math.sin(t * 2) * 3);
      ctx.beginPath();
      ctx.arc(0, 0, 38, 0, Math.PI * 2);
      ctx.fillStyle = '#065F46';
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#34D399';
      ctx.stroke();

      // تاج دندان سفید در مرکز
      ctx.beginPath();
      ctx.moveTo(-14, -12);
      ctx.bezierCurveTo(-14, -22, -2, -22, 0, -16);
      ctx.bezierCurveTo(2, -22, 14, -22, 14, -12);
      ctx.bezierCurveTo(16, 2, 11, 14, 7, 22);
      ctx.lineTo(2, 8);
      ctx.lineTo(-2, 8);
      ctx.lineTo(-7, 22);
      ctx.bezierCurveTo(-11, 14, -16, 2, -14, -12);
      ctx.closePath();
      ctx.fillStyle = '#FFFFFF';
      ctx.fill();

      // تیک سبز زمردی روی دندان
      ctx.beginPath();
      ctx.moveTo(-6, -2);
      ctx.lineTo(-1, 3);
      ctx.lineTo(8, -6);
      ctx.strokeStyle = '#059669';
      ctx.lineWidth = 3.2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke();
      ctx.restore();

      if (frames < maxFrames) {
        rafId = requestAnimationFrame(draw);
      }
    }

    draw();
    return () => {
      stopped = true;
      if (rafId) cancelAnimationFrame(rafId);
    };
  }

  global.Avida3D = {
    AvidaHero3D,
    getService3DSVG,
    attach3DCards,
    playBookingCelebration3D,
  };
})(window);
