/**
 * موتور جلوه‌های تعاملی Immersive Web Design برای «مطب دندان‌پزشکی آویدا»
 * الهام‌گرفته از:
 * 1. nextlevelbuilder/ui-ux-pro-max-skill (سیستم طراحی Bento Grid، کنتراست استاندارد، تایمینگ هدفمند GSAP)
 * 2. 21st.dev (Container Scroll 3D Animation, Spotlight Cards, Border Beam, Interactive Smile Slider)
 * 3. reactbits.dev (Scroll Reveal BlurText, Magnetic Buttons, CountUp Persian Metrics, Scroll-Synced 3D Chapters)
 */

(function (global) {
  'use strict';

  const PERSIAN_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];
  function toFaDigits(val) {
    return String(val).replace(/\d/g, (d) => PERSIAN_DIGITS[Number(d)]);
  }

  function isReducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  let story3d = null;
  let progressListener = null;
  function cleanup() {
    if (story3d) story3d.destroy();
    story3d = null;
    if (progressListener) window.removeEventListener('scroll', progressListener);
    progressListener = null;
    if (global.ScrollTrigger) global.ScrollTrigger.killAll();
  }

  function initImmersiveEffects(root = document, hero3dInstance = null) {
    cleanup();
    // The comparison remains usable with reduced motion and without animation libraries.
    const sliderRange = root.querySelector('#smile-compare-range');
    const afterOverlay = root.querySelector('#smile-after-layer');
    const dividerLine = root.querySelector('#smile-divider-line');
    if (sliderRange && afterOverlay && dividerLine) {
      const updateSlider = () => {
        const val = Number(sliderRange.value);
        afterOverlay.style.clipPath = `inset(0 0 0 ${100 - val}%)`;
        dividerLine.style.left = `${100 - val}%`;
        sliderRange.setAttribute('aria-valuetext', `${toFaDigits(val)} درصد از نمای پس از طراحی`);
      };
      sliderRange.addEventListener('input', updateSlider);
      updateSlider();
    }
    const storyCanvas = document.getElementById('story-3d-canvas');
    if (storyCanvas && global.Avida3D) story3d = new global.Avida3D.AvidaHero3D(storyCanvas);
    const gsap = global.gsap;
    const ScrollTrigger = global.ScrollTrigger;
    if (!gsap || !ScrollTrigger) return;

    gsap.registerPlugin(ScrollTrigger);
    ScrollTrigger.killAll();

    // ۱. نوار پیشرفت اسکرول بالای صفحه (Scroll Progress Beam - 21st.dev pattern)
    let progBar = document.getElementById('avida-scroll-progress');
    if (!progBar) {
      progBar = document.createElement('div');
      progBar.id = 'avida-scroll-progress';
      progBar.className = 'scroll-progress-beam';
      progBar.setAttribute('aria-hidden', 'true');
      document.body.appendChild(progBar);
    }
    progressListener = () => {
        const doc = document.documentElement;
        const maxScroll = Math.max(1, doc.scrollHeight - doc.clientHeight);
        const pct = Math.min(100, Math.max(0, (window.scrollY / maxScroll) * 100));
        progBar.style.width = `${pct.toFixed(1)}%`;
      };
    window.addEventListener('scroll', progressListener, { passive: true });
    progressListener();

    if (isReducedMotion()) return;

    // ۲. ReactBits BlurText / ScrollReveal برای تیترهای فارسی
    const splitHeadings = root.querySelectorAll('[data-rb-split]');
    splitHeadings.forEach((heading) => {
      if (heading.dataset.rbProcessed === '1') return;
      heading.dataset.rbProcessed = '1';
      const rawText = heading.textContent.trim();
      const words = rawText.split(/\s+/);
      heading.textContent = '';
      words.forEach((word) => {
        const span = document.createElement('span');
        span.className = 'rb-word';
        span.style.cssText = 'display:inline-block; margin-left:0.28em;';
        span.textContent = word;
        heading.append(span, document.createTextNode(' '));
      });
      const wordSpans = heading.querySelectorAll('.rb-word');
      gsap.fromTo(
        wordSpans,
        { y: 18, opacity: 0.18, blur: 5 },
        {
          y: 0,
          opacity: 1,
          blur: 0,
          duration: 0.7,
          stagger: 0.04,
          ease: 'power3.out',
          scrollTrigger: {
            trigger: heading,
            start: 'top 90%',
          },
        }
      );
    });

    // ۳. GSAP + ScrollTrigger Staggered Card & Section Reveal (UI/UX Pro Max Preset)
    const staggerGrids = root.querySelectorAll('.cards-grid-3, .cards-grid-2, .cards-grid-4, .bento-grid');
    staggerGrids.forEach((grid) => {
      const children = Array.from(grid.children);
      if (!children.length) return;
      gsap.fromTo(
        children,
        { y: 28, opacity: 0.12, scale: 0.97 },
        {
          y: 0,
          opacity: 1,
          scale: 1,
          duration: 0.68,
          stagger: 0.08,
          ease: 'power3.out',
          scrollTrigger: {
            trigger: grid,
            start: 'top 88%',
          },
        }
      );
    });

    // ۴. 21st.dev Container Scroll 3D Perspective Animation
    const scrollContainers = root.querySelectorAll('[data-scroll-3d-container]');
    scrollContainers.forEach((box) => {
      gsap.fromTo(
        box,
        { rotateX: 12, scale: 0.94, y: 24 },
        {
          rotateX: 0,
          scale: 1,
          y: 0,
          ease: 'power2.out',
          scrollTrigger: {
            trigger: box,
            start: 'top 90%',
            scrub: true,
          },
        }
      );
    });

    // ۵. همگام‌سازی اسکرول با کالبدشکافی سه‌بعدی دندان (ScrollTrigger 3D Anatomy Chapters)
    const chapterCards = root.querySelectorAll('[data-3d-scroll-chapter]');

    if (chapterCards.length > 0) {
      chapterCards.forEach((card) => {
        const mode = card.getAttribute('data-3d-scroll-chapter');
        ScrollTrigger.create({
          trigger: card,
          start: 'top 75%',
          onEnter() {
            chapterCards.forEach((c) => c.classList.remove('active-chapter'));
            card.classList.add('active-chapter');
            if (story3d) story3d.setMode(mode);
            if (hero3dInstance) hero3dInstance.setMode(mode);
            const badgeEl = document.getElementById('story-3d-active-label');
            if (badgeEl) {
              badgeEl.textContent =
                mode === 'enamel'
                  ? 'حالت فعال: ۱. اسکن دیجیتال مینای طبیعی دندان'
                  : mode === 'anatomy'
                  ? 'حالت فعال: ۲. کالبدشکافی میکروسکوپی عاج و پالپ ریشه'
                  : 'حالت فعال: ۳. جایگذاری ایمپلنت تیتانیومی سه‌بعدی';
            }
          },
          onUpdate(self) {
            if (story3d) {
              story3d.targetRotY = 0.4 + self.progress * Math.PI * 1.4;
              story3d.renderFrame();
            }
          },
        });
      });
    }

    // ۶. دکمه‌های مغناطیسی (ReactBits Magnetic Effect)
    const magBtns = root.querySelectorAll('.btn-primary, .btn-coral, .btn-magnetic');
    magBtns.forEach((btn) => {
      if (btn.dataset.magBound === '1') return;
      btn.dataset.magBound = '1';
      btn.addEventListener('pointermove', (e) => {
        const r = btn.getBoundingClientRect();
        const dx = (e.clientX - (r.left + r.width / 2)) * 0.22;
        const dy = (e.clientY - (r.top + r.height / 2)) * 0.22;
        gsap.to(btn, { x: dx, y: dy, duration: 0.25, ease: 'power2.out' });
      });
      btn.addEventListener('pointerleave', () => {
        gsap.to(btn, { x: 0, y: 0, duration: 0.4, ease: 'elastic.out' });
      });
    });

    // ۷. شمارنده‌های پویا به اعداد فارسی (ReactBits CountUp)
    const counters = root.querySelectorAll('[data-countup]');
    counters.forEach((el) => {
      if (el.dataset.counted === '1') return;
      const targetNum = Number(el.getAttribute('data-countup') || 0);
      const suffix = el.getAttribute('data-suffix') || '';
      ScrollTrigger.create({
        trigger: el,
        start: 'top 90%',
        onEnter() {
          if (el.dataset.counted === '1') return;
          el.dataset.counted = '1';
          const proxy = { val: 0 };
          gsap.to(proxy, {
            val: targetNum,
            duration: 1.4,
            ease: 'power3.out',
            onUpdate() {
              el.textContent = toFaDigits(Math.round(proxy.val)) + suffix;
            },
          });
        },
      });
    });

    // ۸. اسلایدر تعاملی قبل و بعد اصلاح طرح لبخند (21st.dev Interactive Compare Slider)
    ScrollTrigger.refresh();
  }

  global.AvidaImmersive = {
    initImmersiveEffects,
    cleanup,
  };
})(window);
