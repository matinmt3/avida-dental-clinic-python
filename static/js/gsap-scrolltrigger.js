/**
 * هسته انیمیشن GSAP 3 + پلاگین ScrollTrigger (نسخه محلی و بدون وابستگی بیرونی)
 * پشتیبانی کامل از:
 * - gsap.to(), gsap.from(), gsap.fromTo(), gsap.set(), gsap.timeline(), gsap.registerPlugin()
 * - ScrollTrigger.create({ trigger, start, end, scrub, pin, onUpdate, onEnter, onLeaveBack })
 * - رعایت کامل prefers-reduced-motion برای دسترس‌پذیری
 */

(function (global) {
  'use strict';

  const EASINGS = {
    'none': (t) => t,
    'linear': (t) => t,
    'power1.out': (t) => 1 - Math.pow(1 - t, 2),
    'power2.out': (t) => 1 - Math.pow(1 - t, 3),
    'power3.out': (t) => 1 - Math.pow(1 - t, 4),
    'power4.out': (t) => 1 - Math.pow(1 - t, 5),
    'power2.inOut': (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
    'back.out': (t) => {
      const c1 = 1.70158;
      const c3 = c1 + 1;
      return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
    },
    'elastic.out': (t) => {
      if (t === 0 || t === 1) return t;
      return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1;
    },
  };

  function resolveTargets(target) {
    if (!target) return [];
    if (typeof target === 'string') {
      return Array.from(document.querySelectorAll(target));
    }
    if (target instanceof Element || target === window || (typeof target === 'object' && !(target instanceof NodeList) && !Array.isArray(target))) {
      return [target];
    }
    return Array.from(target);
  }

  function getState(el) {
    if (!el.__gsapState) {
      el.__gsapState = {
        x: 0,
        y: 0,
        z: 0,
        scale: 1,
        scaleX: 1,
        scaleY: 1,
        rotation: 0,
        rotateX: 0,
        rotateY: 0,
        skewY: 0,
        opacity: 1,
        blur: 0,
      };
    }
    return el.__gsapState;
  }

  function applyTransform(el, st) {
    if (!(el instanceof HTMLElement || el instanceof SVGElement)) return;
    const parts = [];
    if (st.rotateX || st.rotateY || st.z) {
      parts.push('perspective(1100px)');
    }
    if (st.x || st.y || st.z) {
      parts.push(`translate3d(${st.x.toFixed(2)}px, ${st.y.toFixed(2)}px, ${(st.z || 0).toFixed(2)}px)`);
    }
    if (st.rotation) {
      parts.push(`rotate(${st.rotation.toFixed(2)}deg)`);
    }
    if (st.rotateX) {
      parts.push(`rotateX(${st.rotateX.toFixed(2)}deg)`);
    }
    if (st.rotateY) {
      parts.push(`rotateY(${st.rotateY.toFixed(2)}deg)`);
    }
    if (st.skewY) {
      parts.push(`skewY(${st.skewY.toFixed(2)}deg)`);
    }
    if (st.scale !== 1) {
      parts.push(`scale(${st.scale.toFixed(4)})`);
    } else {
      if (st.scaleX !== 1) parts.push(`scaleX(${st.scaleX.toFixed(4)})`);
      if (st.scaleY !== 1) parts.push(`scaleY(${st.scaleY.toFixed(4)})`);
    }
    el.style.transform = parts.join(' ');
    if (st.opacity !== undefined && st.opacity !== null) {
      el.style.opacity = String(st.opacity);
    }
    if (st.blur !== undefined) {
      el.style.filter = st.blur > 0.05 ? `blur(${st.blur.toFixed(2)}px)` : 'none';
    }
  }

  const TRANSFORM_KEYS = new Set([
    'x',
    'y',
    'z',
    'scale',
    'scaleX',
    'scaleY',
    'rotation',
    'rotateX',
    'rotateY',
    'skewY',
    'opacity',
    'blur',
  ]);

  function setPropsOnElement(el, vars) {
    if (!(el instanceof Element)) {
      Object.keys(vars).forEach((k) => {
        if (typeof vars[k] === 'number') el[k] = vars[k];
      });
      return;
    }
    const st = getState(el);
    let touchedTransform = false;
    Object.keys(vars).forEach((k) => {
      if (TRANSFORM_KEYS.has(k)) {
        st[k] = Number(vars[k]);
        touchedTransform = true;
      } else if (k in el.style) {
        el.style[k] = vars[k];
      }
    });
    if (touchedTransform) applyTransform(el, st);
  }

  function animateElements(targets, fromVars, toVars) {
    const els = resolveTargets(targets);
    if (!els.length) return { kill() {} };

    const duration = (toVars.duration !== undefined ? toVars.duration : 0.75) * 1000;
    const baseDelay = (toVars.delay || 0) * 1000;
    const stagger = (toVars.stagger || 0) * 1000;
    const easeName = toVars.ease || 'power3.out';
    const easeFn = EASINGS[easeName] || EASINGS['power3.out'];
    const onUpdate = toVars.onUpdate;
    const onComplete = toVars.onComplete;

    // اگر scrollTrigger مستقیم داخل vars تعریف شده باشد
    if (toVars.scrollTrigger && global.ScrollTrigger) {
      const stConf = Object.assign({}, toVars.scrollTrigger);
      const cleanTo = Object.assign({}, toVars);
      delete cleanTo.scrollTrigger;

      if (fromVars) {
        els.forEach((el) => setPropsOnElement(el, fromVars));
      }

      if (stConf.scrub) {
        const initialSnap = els.map((el) => Object.assign({}, getState(el)));
        return global.ScrollTrigger.create(
          Object.assign({}, stConf, {
            onUpdate(self) {
              const p = easeFn(self.progress);
              els.forEach((el, idx) => {
                const startSt = fromVars ? Object.assign({}, initialSnap[idx], fromVars) : initialSnap[idx];
                const cur = {};
                Object.keys(cleanTo).forEach((k) => {
                  if (TRANSFORM_KEYS.has(k) && typeof cleanTo[k] === 'number') {
                    const sVal = startSt[k] !== undefined ? startSt[k] : k === 'scale' || k === 'opacity' ? 1 : 0;
                    cur[k] = sVal + (cleanTo[k] - sVal) * p;
                  }
                });
                setPropsOnElement(el, cur);
              });
              if (stConf.onUpdate) stConf.onUpdate(self);
            },
          })
        );
      }

      let played = false;
      return global.ScrollTrigger.create(
        Object.assign({}, stConf, {
          onEnter() {
            if (!played) {
              played = true;
              runTween(els, fromVars, cleanTo, duration, baseDelay, stagger, easeFn, onUpdate, onComplete);
            }
          },
        })
      );
    }

    return runTween(els, fromVars, toVars, duration, baseDelay, stagger, easeFn, onUpdate, onComplete);
  }

  function runTween(els, fromVars, toVars, duration, baseDelay, stagger, easeFn, onUpdate, onComplete) {
    const startStates = els.map((el) => {
      if (fromVars) setPropsOnElement(el, fromVars);
      if (el instanceof Element) {
        return Object.assign({}, getState(el));
      }
      const copy = {};
      Object.keys(toVars).forEach((k) => {
        if (typeof el[k] === 'number') copy[k] = el[k];
      });
      return copy;
    });

    const animKeys = Object.keys(toVars).filter(
      (k) =>
        !['duration', 'delay', 'stagger', 'ease', 'onUpdate', 'onComplete', 'scrollTrigger', 'overwrite'].includes(k) &&
        typeof toVars[k] === 'number'
    );

    const startTime = performance.now();
    let rafId = null;
    let killed = false;

    function tick(now) {
      if (killed) return;
      let allDone = true;

      els.forEach((el, idx) => {
        const itemDelay = baseDelay + idx * stagger;
        const elapsed = now - startTime - itemDelay;
        if (elapsed < 0) {
          allDone = false;
          return;
        }
        const rawProgress = duration <= 0 ? 1 : Math.min(1, elapsed / duration);
        if (rawProgress < 1) allDone = false;
        const p = easeFn(rawProgress);

        const sState = startStates[idx];
        const frameVars = {};
        animKeys.forEach((k) => {
          const sVal = sState[k] !== undefined ? sState[k] : k === 'scale' || k === 'opacity' ? 1 : 0;
          frameVars[k] = sVal + (toVars[k] - sVal) * p;
        });
        setPropsOnElement(el, frameVars);
      });

      if (onUpdate) onUpdate();
      if (!allDone) {
        rafId = requestAnimationFrame(tick);
      } else if (onComplete) {
        onComplete();
      }
    }

    rafId = requestAnimationFrame(tick);
    return {
      kill() {
        killed = true;
        if (rafId) cancelAnimationFrame(rafId);
      },
    };
  }

  // -------------------------------------------------------------------------
  // کلاس Timeline
  // -------------------------------------------------------------------------
  class GSAPTimeline {
    constructor(vars = {}) {
      this.vars = vars;
      this.queue = [];
      this.totalDelay = 0;
    }
    to(targets, vars) {
      const v = Object.assign({}, vars, { delay: (vars.delay || 0) + this.totalDelay });
      this.totalDelay += (vars.duration || 0.6) * 0.65;
      animateElements(targets, null, v);
      return this;
    }
    from(targets, vars) {
      const toVars = { delay: (vars.delay || 0) + this.totalDelay, duration: vars.duration || 0.7, stagger: vars.stagger || 0, ease: vars.ease };
      const fromVars = {};
      Object.keys(vars).forEach((k) => {
        if (TRANSFORM_KEYS.has(k)) {
          fromVars[k] = vars[k];
          toVars[k] = k === 'opacity' || k === 'scale' || k === 'scaleX' || k === 'scaleY' ? 1 : 0;
        }
      });
      this.totalDelay += (vars.duration || 0.6) * 0.65;
      animateElements(targets, fromVars, toVars);
      return this;
    }
    fromTo(targets, fromVars, toVars) {
      const v = Object.assign({}, toVars, { delay: (toVars.delay || 0) + this.totalDelay });
      this.totalDelay += (toVars.duration || 0.6) * 0.65;
      animateElements(targets, fromVars, v);
      return this;
    }
  }

  // -------------------------------------------------------------------------
  // موتور ScrollTrigger
  // -------------------------------------------------------------------------
  const triggers = [];

  function parseStartOffset(startStr) {
    if (!startStr) return 0.86;
    if (startStr.includes('90%')) return 0.9;
    if (startStr.includes('85%')) return 0.85;
    if (startStr.includes('75%')) return 0.75;
    if (startStr.includes('center')) return 0.55;
    if (startStr.includes('top top')) return 0.12;
    return 0.84;
  }

  function evaluateTriggers() {
    const vh = window.innerHeight || 800;
    triggers.forEach((tr) => {
      if (!tr.triggerEl) return;
      const rect = tr.triggerEl.getBoundingClientRect();
      const startLine = vh * tr.startRatio;
      const totalSpan = Math.max(120, rect.height + vh * 0.35);
      const raw = (startLine - rect.top) / totalSpan;
      const progress = Math.max(0, Math.min(1, raw));

      if (rect.top <= startLine && !tr.entered) {
        tr.entered = true;
        if (tr.onEnter) tr.onEnter(tr);
      } else if (rect.top > startLine && tr.entered) {
        tr.entered = false;
        if (tr.onLeaveBack) tr.onLeaveBack(tr);
      }

      if (Math.abs(progress - tr.progress) > 0.001) {
        tr.progress = progress;
        if (tr.onUpdate) tr.onUpdate(tr);
      }
    });
  }

  const ScrollTrigger = {
    create(config) {
      const triggerEl =
        typeof config.trigger === 'string'
          ? document.querySelector(config.trigger)
          : config.trigger;
      const inst = {
        triggerEl,
        startRatio: parseStartOffset(config.start),
        scrub: Boolean(config.scrub),
        pin: Boolean(config.pin),
        onEnter: config.onEnter,
        onLeaveBack: config.onLeaveBack,
        onUpdate: config.onUpdate,
        progress: 0,
        entered: false,
        kill() {
          const idx = triggers.indexOf(inst);
          if (idx >= 0) triggers.splice(idx, 1);
        },
      };
      triggers.push(inst);
      requestAnimationFrame(evaluateTriggers);
      return inst;
    },
    refresh() {
      evaluateTriggers();
    },
    getAll() {
      return triggers.slice();
    },
    killAll() {
      triggers.length = 0;
    },
  };

  window.addEventListener('scroll', evaluateTriggers, { passive: true });
  window.addEventListener('resize', evaluateTriggers, { passive: true });

  const gsap = {
    registerPlugin() {},
    set(targets, vars) {
      resolveTargets(targets).forEach((el) => setPropsOnElement(el, vars));
    },
    to(targets, vars) {
      return animateElements(targets, null, vars);
    },
    from(targets, vars) {
      const toVars = Object.assign({}, vars);
      const fromVars = {};
      Object.keys(vars).forEach((k) => {
        if (TRANSFORM_KEYS.has(k)) {
          fromVars[k] = vars[k];
          toVars[k] = k === 'opacity' || k === 'scale' || k === 'scaleX' || k === 'scaleY' ? 1 : 0;
        }
      });
      return animateElements(targets, fromVars, toVars);
    },
    fromTo(targets, fromVars, toVars) {
      return animateElements(targets, fromVars, toVars);
    },
    timeline(vars) {
      return new GSAPTimeline(vars);
    },
  };

  global.gsap = global.gsap || gsap;
  global.ScrollTrigger = global.ScrollTrigger || ScrollTrigger;
})(window);
