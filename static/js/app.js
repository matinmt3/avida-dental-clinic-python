/**
 * برنامه جامع فرانت‌اند «مطب دندان‌پزشکی آویدا» (Avida Dental Clinic SPA & Router)
 * متصل به سرور بک‌اند و پایگاه داده SQLite (/api/...) همراه با موتور پشتیبان محلی
 * برای کارکرد ۱۰۰٪ در پیش‌نمایش مستقل (Standalone HTML Preview).
 */

(function () {
  'use strict';

  const PERSIAN_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];
  const WEEKDAYS_FA = ['شنبه', 'یکشنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنجشنبه', 'جمعه'];

  function toFa(val) {
    if (val === null || val === undefined) return '';
    return String(val).replace(/\d/g, (d) => PERSIAN_DIGITS[Number(d)]);
  }

  function toEn(val) {
    if (!val) return '';
    return String(val)
      .replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
      .replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
  }

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function statusLabel(status) {
    return ({ pending: 'در انتظار بررسی', waiting: 'در انتظار پاسخ', confirmed: 'تأییدشده', rescheduled: 'جابه‌جاشده', cancelled: 'لغوشده', completed: 'انجام‌شده', answered: 'پاسخ‌داده‌شده', closed: 'بسته‌شده' })[String(status).toLowerCase()] || 'نامشخص';
  }

  function currentTehranTime() {
    return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tehran', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
  }

  function appointmentIsFuture(appointment) {
    return `${appointment.jalali_date} ${appointment.start_time}` >= `${state.today_jalali} ${currentTehranTime()}`;
  }

  // -------------------------------------------------------------------------
  // وضعیت سراسری برنامه و ذخیره‌سازی مرحله رزرو در sessionStorage
  // -------------------------------------------------------------------------

  const PAGE_TO_ROUTE = {
    'index.html': '/',
    'services.html': '/services',
    'doctors.html': '/doctors',
    'booking.html': '/booking',
    'consultation.html': '/consultation',
    'contact.html': '/contact',
    'auth.html': '/auth',
    'dashboard.html': '/dashboard',
    'admin.html': '/admin',
  };

  const ROUTE_TO_PAGE = {
    '/': 'index.html',
    '/services': 'services.html',
    '/doctors': 'doctors.html',
    '/booking': 'booking.html',
    '/consultation': 'consultation.html',
    '/contact': 'contact.html',
    '/auth': 'auth.html',
    '/dashboard': 'dashboard.html',
    '/admin': 'admin.html',
  };

  function routeToHref(route) {
    const base = window.location.protocol === 'file:' ? '' : '/';
    if (route.startsWith('/services/')) {
      const slug = route.replace('/services/', '');
      return `${base}services.html?slug=${encodeURIComponent(slug)}`;
    }
    return `${base}${ROUTE_TO_PAGE[route] || 'index.html'}`;
  }

  const WIZARD_STORAGE_KEY = 'avida_booking_wizard_v1';
  const AUTH_TOKEN_KEY = 'avida_auth_token_v1';
  const AUTH_USER_KEY = 'avida_auth_user_v1';
  const AUTH_RETURN_KEY = 'avida_auth_return_v1';

  function currentRouteFromLocation() {
    if (window.location.hash.startsWith('#/')) return window.location.hash.slice(1);
    const pathname = window.location.pathname || '/';
    const filename = pathname.split('/').pop();
    const slug = new URLSearchParams(window.location.search).get('slug');
    if (slug && (pathname === '/services' || filename === 'services.html')) return `/services/${slug}`;
    return PAGE_TO_ROUTE[filename] || pathname.replace(/\.html$/, '') || '/';
  }

  function loadWizardState() {
    let saved = {};
    try {
      const raw = sessionStorage.getItem(WIZARD_STORAGE_KEY);
      if (raw) saved = JSON.parse(raw) || {};
    } catch (e) {}
    const wizard = Object.assign({
      step: 1,
      service_id: 1,
      doctor_id: 1,
      jalali_date: '',
      start_time: '',
      patient_name: '',
      patient_phone: '',
      notes: '',
      completedAppointment: null,
      conflictAlternatives: null,
      conflictMessage: '',
    }, saved);
    wizard.step = Math.min(5, Math.max(1, Number(wizard.step) || 1));
    if (wizard.step === 5 && !wizard.completedAppointment) wizard.step = 1;
    return wizard;
  }

  function saveWizardState() {
    try {
      sessionStorage.setItem(WIZARD_STORAGE_KEY, JSON.stringify(state.wizard));
    } catch (e) {}
  }

  const state = {
    route: '/',
    token: localStorage.getItem(AUTH_TOKEN_KEY) || '',
    user: (function () {
      try {
        return JSON.parse(localStorage.getItem(AUTH_USER_KEY) || 'null');
      } catch (e) {
        return null;
      }
    })(),
    today_jalali: '1405/07/22',
    today_human: 'چهارشنبه ۲۲ مهر ۱۴۰۵',
    settings: {},
    services: [],
    doctors: [],
    faqs: [],
    upcoming_days: [],
    currentSlotsData: null,
    dashboardData: null,
    adminData: null,
    dashboardTab: 'appointments',
    adminTab: 'overview',
    authTab: 'login', // 'login' | 'register' | 'recover'
    recoveryDemoCode: null,
    recoveryIdentifier: '',
    wizard: loadWizardState(),
    hero3dInstance: null,
    rescheduleModal: null, // { appointment }
    confirmModal: null, // { title, body, onConfirm }
    slotsError: '',
    celebrationCleanup: null,
    modalReturnAppointmentId: null,
  };

  function clearSession() {
    state.token = '';
    state.user = null;
    state.dashboardData = null;
    state.adminData = null;
    localStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.removeItem(AUTH_USER_KEY);
  }

  function resetBookingSelection() {
    state.wizard.start_time = '';
    state.wizard.completedAppointment = null;
    state.wizard.conflictAlternatives = null;
    state.wizard.conflictMessage = '';
  }

  async function finishAuthentication(res) {
    if (state.user && Number(state.user.id) !== Number(res.user.id)) {
      state.wizard.patient_name = '';
      state.wizard.patient_phone = '';
      state.wizard.notes = '';
      resetBookingSelection();
      state.wizard.step = Math.min(3, state.wizard.step);
    }
    state.token = res.token;
    state.user = res.user;
    state.dashboardData = null;
    state.adminData = null;
    state.wizard.patient_name = state.wizard.patient_name || res.user.name || '';
    state.wizard.patient_phone = state.wizard.patient_phone || res.user.phone || '';
    saveWizardState();
    localStorage.setItem(AUTH_TOKEN_KEY, res.token);
    localStorage.setItem(AUTH_USER_KEY, JSON.stringify(res.user));
    const returnRoute = sessionStorage.getItem(AUTH_RETURN_KEY);
    sessionStorage.removeItem(AUTH_RETURN_KEY);
    showToast(res.message);
    await navigateTo(returnRoute === '/booking' ? '/booking' : ['admin', 'doctor'].includes(res.user.role) ? '/admin' : '/dashboard');
  }

  // -------------------------------------------------------------------------
  // اعلان‌های شناور (Toast)
  // -------------------------------------------------------------------------
  let slotRequestVersion = 0;
  function showToast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const item = document.createElement('div');
    item.className = `toast-item ${type === 'error' ? 'error' : ''}`;
    item.setAttribute('role', 'status');
    item.textContent = message;
    container.appendChild(item);
    setTimeout(() => {
      item.style.opacity = '0';
      setTimeout(() => item.remove(), 250);
    }, 4200);
  }

  // -------------------------------------------------------------------------
  // ارتباط با سرور بک‌اند (همراه با پشتیبان هوشمند در صورت اجرای آفلاین فایل)
  // -------------------------------------------------------------------------
  async function apiFetch(path, options = {}) {
    const headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
    if (state.token) {
      headers['Authorization'] = `Bearer ${state.token}`;
    }
    try {
      const resp = await fetch(path, Object.assign({}, options, { headers }));
      const data = await resp.json();
      if (!resp.ok) {
        if (resp.status === 401) clearSession();
        const err = new Error(data.error || 'خطایی در ارتباط با سرور رخ داد.');
        err.status = resp.status;
        err.payload = data;
        throw err;
      }
      return data;
    } catch (err) {
      if (err.status) throw err;
      // اگر در محیط فایل مستقل (بدون سرور HTTP) باز شده باشد، از موتور محلی استفاده کن
      if (window.location.protocol === 'file:' && window.AvidaOfflineFallback) {
        return window.AvidaOfflineFallback.handle(path, options, state);
      }
      throw new Error('ارتباط با سرور برقرار نشد. اتصال و اجرای سرور را بررسی کنید و دوباره تلاش کنید.');
    }
  }

  async function bootstrapApp() {
    try {
      const data = await apiFetch('/api/bootstrap');
      state.today_jalali = data.today_jalali;
      state.today_human = data.today_human;
      state.settings = data.settings || {};
      state.services = data.services || [];
      state.doctors = data.doctors || [];
      state.faqs = data.faqs || [];
      state.upcoming_days = data.upcoming_days || [];
      if (data.user) {
        state.user = data.user;
        localStorage.setItem(AUTH_USER_KEY, JSON.stringify(data.user));
      } else {
        clearSession();
      }
      if (!state.services.some((s) => Number(s.id) === Number(state.wizard.service_id))) {
        state.wizard.service_id = state.services[0] ? state.services[0].id : null;
        resetBookingSelection();
        state.wizard.step = 1;
      }
      if (!state.doctors.some((d) => Number(d.id) === Number(state.wizard.doctor_id))) {
        state.wizard.doctor_id = state.doctors[0] ? state.doctors[0].id : null;
        resetBookingSelection();
        state.wizard.step = Math.min(2, state.wizard.step);
      }
      if (!state.upcoming_days.some((d) => d.jalali_date === state.wizard.jalali_date) && state.upcoming_days.length > 0 && !state.wizard.completedAppointment) {
        const firstOpen = state.upcoming_days.find((d) => !d.is_holiday) || state.upcoming_days[0];
        state.wizard.jalali_date = firstOpen.jalali_date;
        state.wizard.start_time = '';
        state.wizard.step = Math.min(3, state.wizard.step);
      }
      if (state.user && !state.wizard.patient_name) {
        state.wizard.patient_name = state.user.name || '';
        state.wizard.patient_phone = state.user.phone || '';
      }
      saveWizardState();
    } catch (e) {
      console.error('Bootstrap error:', e);
    }
  }

  // -------------------------------------------------------------------------
  // مسیریاب واقعی (History API + Hash Support + SEO Title/Meta Updater)
  // -------------------------------------------------------------------------
  const SEO_CLIENT_MAP = {
    '/': {
      title: 'مطب دندان‌پزشکی آویدا | دندان‌پزشکی دیجیتال، طراحی لبخند سه‌بعدی و نوبت‌دهی آنلاین',
      desc: 'مطب دندان‌پزشکی آویدا؛ ارائه‌دهنده خدمات ایمپلنت دیجیتال، طراحی لبخند سه‌بعدی، ارتودنسی شفاف و درمان ریشه با نوبت‌دهی آنلاین شمسی.',
      robots: 'index, follow',
    },
    '/services': {
      title: 'خدمات دندان‌پزشکی و تعرفه‌های نمونه | مطب دندان‌پزشکی آویدا',
      desc: 'معرفی کامل خدمات ایمپلنت دیجیتال، لمینت سرامیکی، ارتودنسی شفاف و درمان ریشه همراه با مدت جلسه و هزینه‌های نمونه.',
      robots: 'index, follow',
    },
    '/doctors': {
      title: 'معرفی دندان‌پزشکان متخصص و برنامه حضور | مطب دندان‌پزشکی آویدا',
      desc: 'آشنایی با دندان‌پزشکان متخصص مطب آویدا، برنامه حضور هفتگی و استانداردهای کنترل عفونت.',
      robots: 'index, follow',
    },
    '/booking': {
      title: 'رزرو آنلاین نوبت دندان‌پزشکی (تقویم شمسی) | مطب دندان‌پزشکی آویدا',
      desc: 'رزرو مرحله‌به‌مرحله نوبت دندان‌پزشکی با تقویم شمسی و دریافت کد پیگیری آنی.',
      robots: 'noindex, nofollow',
    },
    '/consultation': {
      title: 'مشاوره آنلاین دندان‌پزشکی | مطب دندان‌پزشکی آویدا',
      desc: 'ثبت درخواست مشاوره متنی با دندان‌پزشکان و کارشناسان مطب آویدا.',
      robots: 'noindex, nofollow',
    },
    '/contact': {
      title: 'تماس با مطب و پشتیبانی مراجعان | مطب دندان‌پزشکی آویدا',
      desc: 'اطلاعات تماس، ساعت کاری، نشانی مطب آویدا و ثبت درخواست پشتیبانی.',
      robots: 'index, follow',
    },
    '/auth': {
      title: 'ورود و ثبت‌نام حساب کاربری | مطب دندان‌پزشکی آویدا',
      desc: 'ورود به حساب کاربری مراجعان و پرسنل مطب دندان‌پزشکی آویدا.',
      robots: 'noindex, nofollow',
    },
    '/dashboard': {
      title: 'داشبورد اختصاصی مراجع | مطب دندان‌پزشکی آویدا',
      desc: 'مدیریت نوبت‌ها، مشاوره‌های آنلاین و پیام‌های پشتیبانی مراجع.',
      robots: 'noindex, nofollow',
    },
    '/admin': {
      title: 'پنل مدیریت صاحب مطب | مطب دندان‌پزشکی آویدا',
      desc: 'پنل مدیریت خدمات، پزشکان، نوبت‌ها، مشاوره‌ها و تنظیمات مطب دندان‌پزشکی آویدا.',
      robots: 'noindex, nofollow',
    },
  };

  function updateSeoHead(route) {
    let meta = SEO_CLIENT_MAP[route] || SEO_CLIENT_MAP['/'];
    if (route.startsWith('/services/')) {
      const slug = route.replace('/services/', '');
      const srv = state.services.find((s) => s.slug === slug);
      if (srv) {
        meta = {
          title: `${srv.title} | مطب دندان‌پزشکی آویدا`,
          desc: srv.short_desc,
          robots: 'index, follow',
        };
      }
    }
    document.title = meta.title;
    const descEl = document.querySelector('meta[name="description"]');
    if (descEl) descEl.setAttribute('content', meta.desc);
    const robotsEl = document.querySelector('meta[name="robots"]');
    if (robotsEl) robotsEl.setAttribute('content', meta.robots);
  }

  async function navigateTo(route, pushHistory = true) {
    const normalizedRoute = PAGE_TO_ROUTE[String(route).split('/').pop()] || route;
    const cleanRoute = normalizedRoute.startsWith('/') ? normalizedRoute : `/${normalizedRoute}`;
    state.route = cleanRoute;
    state.rescheduleModal = null;

    if (pushHistory) {
      try {
        if (window.location.protocol.startsWith('http')) {
          window.history.pushState({ route: cleanRoute }, '', cleanRoute);
        } else {
          window.location.hash = cleanRoute;
        }
      } catch (e) {
        window.location.hash = cleanRoute;
      }
    }

    updateSeoHead(cleanRoute);
    const navMenu = document.getElementById('main-nav-menu');
    if (navMenu) navMenu.classList.remove('open');

    // بارگذاری داده‌های اختصاصی مسیر
    if (cleanRoute === '/booking') {
      await loadSlotsForWizard();
    } else if (cleanRoute === '/dashboard') {
      if (!state.user) {
        showToast('لطفاً ابتدا وارد حساب کاربری خود شوید.', 'error');
        return navigateTo('/auth', true);
      }
      await loadDashboardData();
    } else if (cleanRoute === '/admin') {
      if (!state.user || (state.user.role !== 'admin' && state.user.role !== 'doctor')) {
        showToast('برای مشاهده پنل مدیریت، با حساب صاحب مطب یا پزشک وارد شوید.', 'error');
        return navigateTo('/auth', true);
      }
      await loadAdminData();
    } else if (cleanRoute === '/consultation' && state.user) {
      await loadDashboardData();
    } else if (cleanRoute === '/contact' && state.user) {
      await loadDashboardData();
    }

    renderApp();
    window.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    const main = document.getElementById('main-content');
    if (main && pushHistory) main.focus({ preventScroll: true });
  }

  async function loadSlotsForWizard() {
    const requestVersion = ++slotRequestVersion;
    if (!state.wizard.service_id && state.services[0]) {
      state.wizard.service_id = state.services[0].id;
    }
    if (!state.wizard.doctor_id && state.doctors[0]) {
      state.wizard.doctor_id = state.doctors[0].id;
    }
    if (!state.wizard.jalali_date && state.upcoming_days[0]) {
      const openDay = state.upcoming_days.find((d) => !d.is_holiday) || state.upcoming_days[0];
      state.wizard.jalali_date = openDay.jalali_date;
    }
    try {
      const q = new URLSearchParams({
        service_id: state.wizard.service_id,
        doctor_id: state.wizard.doctor_id,
        jalali_date: state.wizard.jalali_date,
      });
      const requestKey = q.toString();
      state.slotsError = '';
      state.currentSlotsData = null;
      const slotData = await apiFetch(`/api/slots?${requestKey}`);
      const currentKey = new URLSearchParams({ service_id: state.wizard.service_id, doctor_id: state.wizard.doctor_id, jalali_date: state.wizard.jalali_date }).toString();
      if (requestVersion === slotRequestVersion && currentKey === requestKey) state.currentSlotsData = slotData;
    } catch (e) {
      if (requestVersion !== slotRequestVersion) return;
      state.currentSlotsData = null;
      state.slotsError = e.message;
      console.error('Slot load error:', e);
    }
  }

  async function loadDashboardData() {
    try {
      state.dashboardData = await apiFetch('/api/dashboard');
    } catch (e) {
      state.dashboardData = null;
      showToast(e.message, 'error');
      console.error('Dashboard load error:', e);
    }
  }

  async function loadAdminData() {
    try {
      state.adminData = await apiFetch('/api/admin/overview');
    } catch (e) {
      state.adminData = null;
      showToast(e.message, 'error');
      console.error('Admin load error:', e);
    }
  }

  function getRescheduleDays(appointment) {
    const doctor = state.doctors.find((item) => Number(item.id) === Number(appointment.doctor_id));
    return state.upcoming_days.filter((day) => !day.is_holiday && doctor && doctor.schedule && doctor.schedule[String(day.weekday_idx)] && doctor.schedule[String(day.weekday_idx)].active);
  }

  async function loadRescheduleSlots(appointment, date) {
    const query = new URLSearchParams({
      service_id: appointment.service_id,
      doctor_id: appointment.doctor_id,
      jalali_date: date,
      appointment_id: appointment.id,
    });
    return apiFetch(`/api/slots?${query.toString()}`);
  }

  // -------------------------------------------------------------------------
  // رندر هدر، ناوبری و فوتر
  // -------------------------------------------------------------------------
  function renderHeader() {
    const info = state.settings.clinic_info || {};
    const r = state.route;
    const unreadCount =
      state.dashboardData && state.dashboardData.notifications
        ? state.dashboardData.notifications.filter((n) => !n.is_read).length
        : 0;

    return `
      <div class="top-demo-bar" role="region" aria-label="نوار اطلاعات نسخه آزمایشی">
        <div class="container top-demo-inner">
          <div>
            <span class="demo-pill">نسخه نمایشی و آزمایشی</span>
            <span style="margin-right:0.5rem;">امروز: <strong>${escapeHtml(state.today_human)}</strong> | تلفن مطب: <strong>${escapeHtml(info.phone_primary || '۰۲۱-۸۸۹۹۴۴۱۱')}</strong></span>
          </div>
          <div class="top-quick-links">
            <button type="button" data-action="quick-demo-login" data-role="patient">ورود آزمایشی مراجع</button>
            <button type="button" data-action="quick-demo-login" data-role="doctor">ورود آزمایشی پزشک</button>
            <button type="button" data-action="quick-demo-login" data-role="admin">ورود آزمایشی صاحب مطب</button>
          </div>
        </div>
      </div>

      <header class="site-header">
        <div class="container header-inner">
          <a href="/" data-route="/" class="brand-logo" aria-label="صفحه اصلی مطب دندان‌پزشکی آویدا">
            <div class="brand-emblem" aria-hidden="true">
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                <path d="M7 3C4.5 3 3 5.5 3 8.5C3 12.5 5 15 6.5 20.5C7 22 8.5 22 9 20L10.5 14.5H13.5L15 20C15.5 22 17 22 17.5 20.5C19 15 21 12.5 21 8.5C21 5.5 19.5 3 17 3C15 3 13.5 4.5 12 4.5C10.5 4.5 9 3 7 3Z"/>
              </svg>
            </div>
            <div class="brand-text">
              <span class="brand-title">${escapeHtml(info.name || 'مطب دندان‌پزشکی آویدا')}</span>
              <span class="brand-subtitle">${escapeHtml(info.tagline || 'دقت دیجیتال و آرامش کلینیکال')}</span>
            </div>
          </a>

          <nav id="main-nav-menu" class="main-nav" aria-label="منوی اصلی سایت">
            <a href="index.html" class="nav-link ${r === '/' ? 'active' : ''}" data-route="/">صفحه اصلی</a>
            <a href="services.html" class="nav-link ${r.startsWith('/services') ? 'active' : ''}" data-route="/services">خدمات و تعرفه‌ها</a>
            <a href="doctors.html" class="nav-link ${r === '/doctors' ? 'active' : ''}" data-route="/doctors">پزشکان و مطب</a>
            <a href="booking.html" class="nav-link ${r === '/booking' ? 'active' : ''}" data-route="/booking">رزرو نوبت</a>
            <a href="consultation.html" class="nav-link ${r === '/consultation' ? 'active' : ''}" data-route="/consultation">مشاوره آنلاین</a>
            <a href="contact.html" class="nav-link ${r === '/contact' ? 'active' : ''}" data-route="/contact">تماس و پشتیبانی</a>
          </nav>

          <div class="header-actions">
            ${
              state.user
                ? `
                  ${
                    state.user.role === 'admin' || state.user.role === 'doctor'
                      ? `<button type="button" class="btn btn-coral btn-sm" data-route="/admin">پنل مدیریت مطب</button>`
                      : ''
                  }
                  <button type="button" class="btn btn-outline btn-sm" data-route="/dashboard">
                    داشبورد من
                    ${unreadCount > 0 ? `<span class="badge badge-coral">${toFa(unreadCount)}</span>` : ''}
                  </button>
                `
                : `<button type="button" class="btn btn-outline btn-sm" data-route="/auth">ورود / ثبت‌نام</button>`
            }
            <button type="button" class="btn btn-primary btn-sm" data-route="/booking">نوبت‌دهی آنلاین</button>
            <button type="button" class="mobile-menu-btn" id="mobile-menu-toggle" aria-label="باز کردن منوی موبایل" aria-controls="main-nav-menu" aria-expanded="false">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                <line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>
              </svg>
            </button>
          </div>
        </div>
      </header>
    `;
  }

  function renderFooter() {
    const info = state.settings.clinic_info || {};
    return `
      <footer class="site-footer">
        <div class="container">
          <div class="footer-grid">
            <div>
              <h3 class="footer-title">${escapeHtml(info.name || 'مطب دندان‌پزشکی آویدا')}</h3>
              <p style="font-size:0.9rem; color:#CBD5E1; margin-bottom:1rem;">
                ${escapeHtml(info.about_text || '')}
              </p>
              <span class="demo-pill">اطلاعات، تعرفه‌ها و پزشکان این سامانه نمونه آزمایشی هستند</span>
            </div>
            <div>
              <h4 class="footer-title">دسترسی سریع</h4>
              <ul class="footer-links">
                <li><button type="button" data-route="/booking">رزرو آنلاین نوبت (تقویم شمسی)</button></li>
                <li><button type="button" data-route="/consultation">دریافت مشاوره آنلاین متنی</button></li>
                <li><button type="button" data-route="/services">فهرست خدمات و هزینه‌های نمونه</button></li>
                <li><button type="button" data-route="/doctors">معرفی پزشکان و برنامه حضور</button></li>
                <li><button type="button" data-route="/contact">تماس با مطب و پشتیبانی</button></li>
              </ul>
            </div>
            <div>
              <h4 class="footer-title">پرتال مراجعان و مدیریت</h4>
              <ul class="footer-links">
                <li><button type="button" data-route="/dashboard">داشبورد مراجع (پیگیری و جابه‌جایی نوبت)</button></li>
                <li><button type="button" data-route="/admin">پنل مدیریت صاحب مطب</button></li>
                <li><button type="button" data-route="/auth">ورود، ثبت‌نام و بازیابی دسترسی</button></li>
                <li><a href="/sitemap.xml" target="_blank" rel="noopener">نقشه سایت (Sitemap XML)</a></li>
              </ul>
            </div>
            <div>
              <h4 class="footer-title">ارتباط با مطب آویدا</h4>
              <p style="font-size:0.88rem; color:#CBD5E1; margin-bottom:0.5rem;">
                <strong>نشانی:</strong> ${escapeHtml(info.address || '')}
              </p>
              <p style="font-size:0.88rem; color:#CBD5E1; margin-bottom:0.5rem;">
                <strong>تلفن پذیرش:</strong> ${escapeHtml(info.phone_primary || '۰۲۱-۸۸۹۹۴۴۱۱')}
              </p>
              <p style="font-size:0.88rem; color:#CBD5E1;">
                <strong>ساعات کاری:</strong> ${escapeHtml(info.working_hours_text || '')}
              </p>
            </div>
          </div>
          <div style="border-top:1px solid rgba(255,255,255,0.12); padding-top:1.25rem; display:flex; justify-content:space-between; flex-wrap:wrap; gap:1rem; font-size:0.82rem; color:#94A3B8;">
            <span>© ۱۴۰۵ مطب دندان‌پزشکی آویدا — طراحی‌شده با استانداردهای دسترس‌پذیری و امنیت وب.</span>
            <span>پشتیبانی از تقویم شمسی و زمان رسمی ایران (Asia/Tehran)</span>
          </div>
        </div>
      </footer>
    `;
  }

  // -------------------------------------------------------------------------
  // ۱. صفحه اصلی (Home Page with 3D Dental Showcase)
  // -------------------------------------------------------------------------
  function renderHomePage() {
    const info = state.settings.clinic_info || {};
    const rules = state.settings.scheduling_rules || {};

    const servicesCards = state.services
      .map(
        (s) => `
        <article class="card-3d">
          <div>
            <div class="service-3d-thumb">
              ${window.Avida3D ? window.Avida3D.getService3DSVG(s.model_type) : ''}
            </div>
            <span class="badge badge-green" style="margin-bottom:0.55rem;">${escapeHtml(s.category)}</span>
            <h3 style="font-size:1.18rem; margin-bottom:0.5rem;">${escapeHtml(s.title)}</h3>
            <p style="font-size:0.92rem; color:var(--ink-600);">${escapeHtml(s.short_desc)}</p>
          </div>
          <div>
            <div class="service-meta-row">
              <span>مدت جلسه: <strong>${toFa(s.duration_min)} دقیقه</strong></span>
              <span style="color:var(--green-800); font-weight:700;">${escapeHtml(s.price_sample)}</span>
            </div>
            <div style="display:flex; gap:0.5rem;">
              <button type="button" class="btn btn-primary btn-sm" style="flex:1;" data-action="book-service" data-service-id="${s.id}">رزرو این خدمت</button>
              <button type="button" class="btn btn-outline btn-sm" data-route="/services/${escapeHtml(s.slug)}">جزئیات</button>
            </div>
          </div>
        </article>
      `
      )
      .join('');

    const doctorsCards = state.doctors
      .map((d) => {
        const activeDays = WEEKDAYS_FA.filter((_, idx) => d.schedule && d.schedule[String(idx)] && d.schedule[String(idx)].active);
        return `
          <article class="card-3d">
            <div>
              <div style="display:flex; align-items:center; gap:0.9rem; margin-bottom:1rem;">
                <div style="width:60px; height:60px; border-radius:18px; background:linear-gradient(135deg, var(--green-800), var(--green-600)); color:#FFF; display:flex; align-items:center; justify-content:center; font-weight:700; font-size:1.25rem; flex-shrink:0;">
                  ${escapeHtml(d.name.replace('دکتر ', '').slice(0, 1))}
                </div>
                <div>
                  <h3 style="font-size:1.12rem;">${escapeHtml(d.name)}</h3>
                  <p style="font-size:0.85rem; color:var(--green-800); font-weight:700;">${escapeHtml(d.specialty)}</p>
                  <span style="font-size:0.76rem; color:var(--ink-600);">${escapeHtml(d.medical_code)}</span>
                </div>
              </div>
              <p style="font-size:0.9rem; color:var(--ink-600); margin-bottom:0.9rem;">${escapeHtml(d.bio)}</p>
            </div>
            <div>
              <div style="background:var(--bg-page); padding:0.65rem 0.85rem; border-radius:var(--radius-sm); font-size:0.82rem; margin-bottom:0.9rem;">
                <strong>روزهای حضور:</strong> ${escapeHtml(activeDays.join('، '))}
              </div>
              <button type="button" class="btn btn-outline btn-sm" style="width:100%;" data-action="book-doctor" data-doctor-id="${d.id}">انتخاب پزشک و مشاهده نوبت‌های آزاد</button>
            </div>
          </article>
        `;
      })
      .join('');

    const faqItems = state.faqs
      .map(
        (f) => `
        <details style="background:var(--bg-surface); border:1px solid var(--border-subtle); border-radius:var(--radius-md); padding:1.1rem 1.35rem; margin-bottom:0.85rem;">
          <summary style="font-weight:700; cursor:pointer; font-size:1.02rem; color:var(--ink-950);">
            ${escapeHtml(f.question)}
          </summary>
          <p style="margin-top:0.75rem; color:var(--ink-700); font-size:0.94rem;">
            ${escapeHtml(f.answer)}
          </p>
        </details>
      `
      )
      .join('');

    return `
      <!-- ویترین آغازین سه‌بعدی -->
      <section class="hero-section" aria-labelledby="hero-main-heading">
        <div class="container hero-grid">
          <div>
            <div class="hero-badge">
              <span class="hero-badge-dot" aria-hidden="true"></span>
              <span>${escapeHtml(info.hero_badge || 'نسل نوین دندان‌پزشکی دیجیتال و سه‌بعدی')}</span>
            </div>
            <h1 id="hero-main-heading" class="hero-title">
              ${escapeHtml(info.hero_title || 'تجربه‌ای آرام، شفاف و دقیق از مراقبت و زیبایی لبخند')}
            </h1>
            <p class="hero-subtitle">
              ${escapeHtml(info.hero_subtitle || '')}
            </p>
            <div class="hero-cta-group">
              <button type="button" class="btn btn-primary" data-route="/booking">
                رزرو آنلاین نوبت (تقویم شمسی)
              </button>
              <button type="button" class="btn btn-coral" data-route="/consultation">
                دریافت مشاوره آنلاین
              </button>
              <button type="button" class="btn btn-outline" data-route="/contact">
                تماس و پشتیبانی
              </button>
            </div>
            <div class="hero-trust-metrics">
              <div class="trust-metric-card">
                <div class="trust-metric-val">اسکن سه‌بعدی</div>
                <div class="trust-metric-lbl">بررسی دیجیتال تاج و ریشه پیش از درمان</div>
              </div>
              <div class="trust-metric-card">
                <div class="trust-metric-val">${toFa(rules.buffer_minutes ?? 15)} دقیقه فاصله</div>
                <div class="trust-metric-lbl">ضدعفونی کامل یونیت میان هر دو مراجع</div>
              </div>
              <div class="trust-metric-card">
                <div class="trust-metric-val">نوبت‌دهی بدون تداخل</div>
                <div class="trust-metric-lbl">اختصاص زمان انحصاری با کد پیگیری آنی</div>
              </div>
            </div>
          </div>

          <!-- صحنه سه‌بعدی تعاملی دندان -->
          <div class="hero-3d-stage" id="hero-3d-stage-box" aria-label="مدل سه‌بعدی تعاملی دندان و ایمپلنت مطب آویدا">
            <div class="stage-top-bar">
              <span class="stage-status-chip">نمایشگر سه‌بعدی زنده • واکنش به حرکت نشانگر</span>
              <button type="button" class="mode-btn" id="hero-3d-pause-btn" aria-label="توقف یا پخش چرخش سه‌بعدی">
                توقف / پخش حرکت
              </button>
            </div>

            <div class="stage-canvas-wrap">
              <!-- تصویر جایگزین باکیفیت برای دستگاه‌های ضعیف -->
              <div class="hero-3d-fallback" aria-hidden="true">
                ${window.Avida3D ? window.Avida3D.getService3DSVG('implant') : ''}
              </div>
              <canvas id="hero-3d-canvas" aria-label="مدل سه‌بعدی دندان با قابلیت چرخش و تغییر لایه"></canvas>
              <div class="stage-annotations" id="hero-3d-annotations">
                <span class="stage-annotation-tag" style="top:14%; right:6%;">تاج سرامیکی / مینای دندان</span>
                <span class="stage-annotation-tag" style="bottom:18%; left:6%; border-color:rgba(244,63,94,0.6);">ریشه و کانال آناتومیک</span>
              </div>
            </div>

            <div class="stage-controls-bar">
              <div class="mode-switch-group" role="group" aria-label="انتخاب لایه نمایش سه‌بعدی">
                <button type="button" class="mode-btn active" data-3d-mode="enamel">۱. نمای مینای طبیعی</button>
                <button type="button" class="mode-btn" data-3d-mode="anatomy">۲. کالبدشکافی عاج و پالپ</button>
                <button type="button" class="mode-btn" data-3d-mode="implant">۳. ایمپلنت دیجیتال تیتانیومی</button>
              </div>
              <span style="font-size:0.75rem; color:#94A3B8;">با ماوس یا لمس بچرخانید</span>
            </div>
          </div>
        </div>
      </section>


      <!-- نوار ویژگی‌های کلینیکال و شمارنده‌های پویا (ReactBits CountUp) -->
      <div class="clinical-ribbon" role="region" aria-label="شاخص‌های کلیدی مطب آویدا">
        <div class="container clinical-ribbon-inner">
          <div>فاصله بین نوبت‌ها: <strong>${toFa((state.settings.scheduling_rules || {}).buffer_minutes ?? 15)} دقیقه</strong></div>
          <div>خدمات معرفی‌شده: <strong>${toFa(state.services.length)} خدمت</strong></div>
          <div>پزشکان نمونه: <strong>${toFa(state.doctors.length)} پزشک</strong></div>
          <div><strong>بررسی ظرفیت پیش از ثبت نهایی</strong></div>
        </div>
      </div>

      <!-- بخش داستان‌سرایی اسکرول‌محور سه‌بعدی با GSAP و ScrollTrigger -->
      <section class="immersive-story-section" id="immersive-story-section" aria-labelledby="story-3d-heading">
        <div class="container">
          <div class="section-header">
            <div>
              <span class="demo-pill" style="background:rgba(16,185,129,0.2); color:#6EE7B7; border-color:rgba(52,211,153,0.45); margin-bottom:0.6rem;">آشنایی تصویری با ساختار دندان و مراحل درمان</span>
              <h2 id="story-3d-heading" class="section-title" style="color:#FFFFFF;" data-rb-split>کالبدشکافی تعاملی دندان همگام با اسکرول شما</h2>
              <p class="section-desc" style="color:#CBD5E1;">با حرکت در طول این بخش، مدل سه‌بعدی دندان به‌صورت خودکار می‌چرخد و لایه‌های درونی درمان دیجیتال را نمایش می‌دهد.</p>
            </div>
          </div>

          <div class="story-grid">
            <div class="story-sticky-stage">
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.75rem;">
                <span class="stage-status-chip" id="story-3d-active-label">حالت فعال: ۱. اسکن دیجیتال مینای طبیعی دندان</span>
                <span style="font-size:0.78rem; color:#94A3B8;">با پیمایش صفحه، نما را تغییر دهید</span>
              </div>
              <div style="height:310px; position:relative;">
                <canvas id="story-3d-canvas" style="width:100%; height:100%; display:block;" aria-label="بوم سه‌بعدی همگام با اسکرول"></canvas>
              </div>
            </div>

            <div>
              <article class="story-chapter-card active-chapter" data-3d-scroll-chapter="enamel">
                <span class="badge badge-green" style="margin-bottom:0.6rem;">مرحله ۰۱ • نمای مینای طبیعی</span>
                <h3 style="color:#FFFFFF; font-size:1.22rem; margin-bottom:0.5rem;">اسکن نوری سه‌بعدی تاج و بررسی خط لبخند</h3>
                <p style="color:#CBD5E1; font-size:0.93rem;">در گام نخست، بدون نیاز به خمیرهای قالب‌گیری سنتی، سطح جونده چهارکاسپی و انحنای مینای دندان با اسکنر اپتیکال سه‌بعدی ثبت می‌شود تا تناسب دقیق لبخند مشخص گردد.</p>
              </article>

              <article class="story-chapter-card" data-3d-scroll-chapter="anatomy">
                <span class="badge badge-coral" style="margin-bottom:0.6rem;">مرحله ۰۲ • کالبدشکافی عاج و پالپ</span>
                <h3 style="color:#FFFFFF; font-size:1.22rem; margin-bottom:0.5rem;">تحلیل میکروسکوپی ریشه و کانال‌های عصبی</h3>
                <p style="color:#CBD5E1; font-size:0.93rem;">با فعال‌سازی لایه کالبدشکافی، ساختار درونی عاج و اتاقک پالپ در فضای سه‌بعدی بررسی می‌شود تا درمان ریشه (اندو) با بزرگ‌نمایی اپتیکال و کمترین دستکاری بافت سالم انجام شود.</p>
              </article>

              <article class="story-chapter-card" data-3d-scroll-chapter="implant">
                <span class="badge badge-green" style="margin-bottom:0.6rem;">مرحله ۰۳ • ایمپلنت دیجیتال تیتانیومی</span>
                <h3 style="color:#FFFFFF; font-size:1.22rem; margin-bottom:0.5rem;">هدایت دیجیتال پایه تیتانیومی با شابلون سه‌بعدی</h3>
                <p style="color:#CBD5E1; font-size:0.93rem;">در مرحله سوم، زاویه و عمق دقیق قرارگیری فیکسچر تیتانیومی و روکش سرامیکی پیش از جلسه جراحی شبیه‌سازی می‌شود تا درمانی آرام، سریع و بادقت رقم بخورد.</p>
              </article>
            </div>
          </div>
        </div>
      </section>

      <!-- چیدمان Bento Grid و اسلایدر مقایسه قبل و بعد طرح لبخند (الگوی 21st.dev و UI/UX Pro Max) -->
      <section class="section-block" aria-labelledby="bento-heading">
        <div class="container">
          <div class="section-header">
            <div>
              <span class="section-eyebrow">آشنایی با درمان و طراحی لبخند</span>
              <h2 id="bento-heading" class="section-title" data-rb-split>فناوری‌های کلینیکال و شبیه‌ساز قبل و بعد لبخند</h2>
            </div>
            <a href="booking.html" class="btn btn-primary btn-sm" data-route="/booking">رزرو جلسه ارزیابی سه‌بعدی</a>
          </div>

          <div class="bento-grid" data-scroll-3d-container>
            <div class="bento-card bento-span-8">
              <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.5rem; margin-bottom:1rem;">
                <div>
                  <span class="badge badge-green">شبیه‌ساز تعاملی طراحی لبخند (DSD)</span>
                  <h3 style="font-size:1.2rem; margin-top:0.35rem;">مقایسه تعاملی پیش و پس از اصلاح طرح لبخند دیجیتال</h3>
                </div>
                <span style="font-size:0.82rem; color:var(--ink-600);">نوار میانی را به چپ و راست بکشید</span>
              </div>

              <div class="smile-compare-wrap">
                <div class="smile-layer smile-before-layer">
                  <span class="badge badge-slate" style="margin-bottom:0.75rem;">پیش از اصلاح طرح لبخند (Before)</span>
                  <svg viewBox="0 0 360 110" width="290" height="90" aria-label="نمای دندان پیش از اصلاح">
                    <rect x="35" y="20" width="38" height="62" rx="10" fill="#CBD5E1" transform="rotate(-5 54 51)"/>
                    <rect x="82" y="16" width="44" height="68" rx="12" fill="#E2E8F0" transform="rotate(3 104 50)"/>
                    <rect x="136" y="18" width="42" height="64" rx="12" fill="#CBD5E1"/>
                    <rect x="188" y="15" width="44" height="68" rx="12" fill="#E2E8F0" transform="rotate(-4 210 49)"/>
                    <rect x="240" y="22" width="38" height="60" rx="10" fill="#CBD5E1" transform="rotate(4 259 52)"/>
                    <rect x="284" y="25" width="34" height="54" rx="9" fill="#94A3B8"/>
                  </svg>
                  <p style="font-size:0.84rem; margin-top:0.5rem;">فاصله‌های بین‌دندانی (دیاستم) و ناهماهنگی لبه برنده</p>
                </div>

                <div class="smile-layer smile-after-layer" id="smile-after-layer">
                  <span class="badge badge-green" style="margin-bottom:0.75rem;">پس از طراحی لبخند سه‌بعدی (After DSD)</span>
                  <svg viewBox="0 0 360 110" width="290" height="90" aria-label="نمای دندان پس از طراحی سه‌بعدی">
                    <rect x="38" y="20" width="40" height="64" rx="12" fill="#FFFFFF"/>
                    <rect x="82" y="16" width="46" height="70" rx="13" fill="#F0FDF4"/>
                    <rect x="132" y="14" width="46" height="72" rx="14" fill="#FFFFFF"/>
                    <rect x="182" y="14" width="46" height="72" rx="14" fill="#FFFFFF"/>
                    <rect x="232" y="16" width="46" height="70" rx="13" fill="#F0FDF4"/>
                    <rect x="282" y="20" width="40" height="64" rx="12" fill="#FFFFFF"/>
                  </svg>
                  <p style="font-size:0.84rem; margin-top:0.5rem; color:#D1FAE5;">تناسب طلایی قوس لبخند با حفظ کامل بافت سالم مینا</p>
                </div>

                <div class="smile-divider-line" id="smile-divider-line"></div>
                <input type="range" min="5" max="95" value="50" id="smile-compare-range" class="smile-range-input" aria-label="اسلایدر مقایسه قبل و بعد طرح لبخند" />
              </div>
            </div>

            <div class="bento-card dark-glass bento-span-4" style="display:flex; flex-direction:column; justify-content:space-between;">
              <div>
                <span class="demo-pill" style="margin-bottom:0.75rem;">نوبت‌دهی آنلاین</span>
                <h3 style="color:#FFFFFF; font-size:1.2rem; margin-bottom:0.65rem;">انتخاب نوبت از میان ساعت‌های آزاد پزشک</h3>
                <p style="color:#CBD5E1; font-size:0.9rem;">پیش از ثبت نهایی، ظرفیت نوبت دوباره بررسی می‌شود. اگر ساعت انتخابی رزرو شده باشد، می‌توانید زمان آزاد دیگری را انتخاب کنید.</p>
              </div>
              <div style="margin-top:1.25rem; padding-top:1rem; border-top:1px solid rgba(255,255,255,0.12);">
                <a href="booking.html" class="btn btn-primary btn-sm" style="width:100%;" data-route="/booking">مشاهده روزها و ساعت‌های آزاد</a>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- مسیر ۵ مرحله‌ای نوبت‌گیری -->
      <section class="section-block alt-bg" aria-labelledby="steps-heading">
        <div class="container">
          <div class="section-header">
            <div>
              <span class="section-eyebrow">فرآیند شفاف و سریع</span>
              <h2 id="steps-heading" class="section-title">چگونه در کمتر از ۲ دقیقه نوبت خود را ثبت کنید؟</h2>
            </div>
            <button type="button" class="btn btn-primary btn-sm" data-route="/booking">شروع رزرو نوبت</button>
          </div>
          <div class="cards-grid-4" style="grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));">
            <div class="card-3d">
              <span class="badge badge-green" style="width:fit-content; margin-bottom:0.65rem;">گام اول</span>
              <h3 style="font-size:1.05rem; margin-bottom:0.4rem;">۱. انتخاب خدمت</h3>
              <p style="font-size:0.88rem; color:var(--ink-600);">خدمت مورد نظر خود را به همراه مدت زمان جلسه و حدود هزینه نمونه انتخاب کنید.</p>
            </div>
            <div class="card-3d">
              <span class="badge badge-green" style="width:fit-content; margin-bottom:0.65rem;">گام دوم</span>
              <h3 style="font-size:1.05rem; margin-bottom:0.4rem;">۲. انتخاب دندان‌پزشک</h3>
              <p style="font-size:0.88rem; color:var(--ink-600);">پزشک متخصص مرتبط و روزهای حضور هفتگی ایشان را بررسی و انتخاب نمایید.</p>
            </div>
            <div class="card-3d">
              <span class="badge badge-green" style="width:fit-content; margin-bottom:0.65rem;">گام سوم</span>
              <h3 style="font-size:1.05rem; margin-bottom:0.4rem;">۳. انتخاب روز و ساعت شمسی</h3>
              <p style="font-size:0.88rem; color:var(--ink-600);">در تقویم شمسی، ساعت‌های آزاد، رزروشده و تعطیلی‌ها را به‌روشنی ببینید.</p>
            </div>
            <div class="card-3d">
              <span class="badge badge-coral" style="width:fit-content; margin-bottom:0.65rem;">گام چهارم و پنجم</span>
              <h3 style="font-size:1.05rem; margin-bottom:0.4rem;">۴. تأیید و دریافت کد پیگیری</h3>
              <p style="font-size:0.88rem; color:var(--ink-600);">اطلاعات تماس را تأیید کرده و کد پیگیری اختصاصی خود را بلافاصله دریافت کنید.</p>
            </div>
          </div>
        </div>
      </section>

      <!-- خدمات تخصصی با تصویرسازی سه‌بعدی -->
      <section class="section-block" aria-labelledby="home-services-heading">
        <div class="container">
          <div class="section-header">
            <div>
              <span class="section-eyebrow">خدمات تخصصی کلینیکال</span>
              <h2 id="home-services-heading" class="section-title">خدمات دندان‌پزشکی آویدا با شبیه‌سازی سه‌بعدی</h2>
              <p class="section-desc">مدت زمان هر جلسه و فاصله ضدعفونی به صورت خودکار در ظرفیت نوبت‌دهی محاسبه می‌شود.</p>
            </div>
            <button type="button" class="btn btn-outline btn-sm" data-route="/services">مشاهده همه خدمات</button>
          </div>
          <div class="cards-grid-3">
            ${servicesCards}
          </div>
        </div>
      </section>

      <!-- معرفی پزشکان مطب -->
      <section class="section-block alt-bg" aria-labelledby="home-doctors-heading">
        <div class="container">
          <div class="section-header">
            <div>
              <span class="section-eyebrow">تیم درمانی مطب (داده‌های نمونه)</span>
              <h2 id="home-doctors-heading" class="section-title">دندان‌پزشکان و برنامه حضور هفتگی</h2>
              <p class="section-desc">تمامی پزشکان و کدهای نظام پزشکی درج‌شده نمونه آزمایشی جهت نمایش امکانات سامانه هستند.</p>
            </div>
            <button type="button" class="btn btn-outline btn-sm" data-route="/doctors">آشنایی بیشتر با پزشکان و مطب</button>
          </div>
          <div class="cards-grid-2">
            ${doctorsCards}
          </div>
        </div>
      </section>

      <!-- پرسش‌های متداول -->
      <section class="section-block" aria-labelledby="home-faq-heading">
        <div class="container">
          <div class="section-header">
            <div>
              <span class="section-eyebrow">پاسخ به پرسش‌های پرتکرار</span>
              <h2 id="home-faq-heading" class="section-title">پرسش‌های متداول مراجعان</h2>
            </div>
            <button type="button" class="btn btn-coral btn-sm" data-route="/consultation">طرح پرسش در مشاوره آنلاین</button>
          </div>
          <div>
            ${faqItems}
          </div>
        </div>
      </section>
    `;
  }

  // -------------------------------------------------------------------------
  // ۲. صفحه خدمات و صفحه جزئیات هر خدمت (/services و /services/:slug)
  // -------------------------------------------------------------------------
  function renderServicesPage(slug = null) {
    if (slug) {
      const s = state.services.find((item) => item.slug === slug) || state.services[0];
      if (!s) return renderServicesPage(null);
      return `
        <section class="section-block">
          <div class="container">
            <div style="margin-bottom:1.5rem;">
              <button type="button" class="btn btn-outline btn-sm" data-route="/services">← بازگشت به فهرست همه خدمات</button>
            </div>
            <div class="hero-grid" style="background:var(--bg-surface); padding:2rem; border-radius:var(--radius-xl); border:1px solid var(--border-subtle); box-shadow:var(--shadow-md);">
              <div>
                <span class="badge badge-green" style="margin-bottom:0.75rem;">${escapeHtml(s.category)}</span>
                <h1 style="font-size:2rem; margin-bottom:1rem;">${escapeHtml(s.title)}</h1>
                <p style="font-size:1.02rem; color:var(--ink-700); margin-bottom:1.5rem;">${escapeHtml(s.full_desc)}</p>

                <div class="cards-grid-2" style="margin-bottom:1.5rem;">
                  <div style="background:var(--bg-mint-soft); padding:1rem; border-radius:var(--radius-md); border:1px solid var(--border-green);">
                    <div style="font-size:0.82rem; color:var(--green-800); font-weight:700;">مدت تقریبی جلسه</div>
                    <div style="font-size:1.25rem; font-weight:700; color:var(--ink-950);">${toFa(s.duration_min)} دقیقه (+ ${toFa((state.settings.scheduling_rules || {}).buffer_minutes || 15)} دقیقه آماده‌سازی اتاق)</div>
                  </div>
                  <div style="background:var(--bg-page); padding:1rem; border-radius:var(--radius-md); border:1px solid var(--border-subtle);">
                    <div style="font-size:0.82rem; color:var(--ink-600); font-weight:700;">حدود هزینه نمونه (آزمایشی)</div>
                    <div style="font-size:1.1rem; font-weight:700; color:var(--green-800);">${escapeHtml(s.price_sample)}</div>
                  </div>
                </div>

                <div style="background:var(--bg-page); padding:1.15rem; border-radius:var(--radius-md); margin-bottom:1rem;">
                  <h2 style="font-size:1.05rem; margin-bottom:0.4rem;">آمادگی‌های پیش از جلسه</h2>
                  <p style="font-size:0.92rem; color:var(--ink-700);">${escapeHtml(s.prep_tips)}</p>
                </div>

                <div style="background:var(--bg-page); padding:1.15rem; border-radius:var(--radius-md); margin-bottom:1.5rem;">
                  <h2 style="font-size:1.05rem; margin-bottom:0.4rem;">مراقبت‌های پس از جلسه</h2>
                  <p style="font-size:0.92rem; color:var(--ink-700);">${escapeHtml(s.aftercare_tips)}</p>
                </div>

                <div style="display:flex; gap:0.85rem; flex-wrap:wrap;">
                  <button type="button" class="btn btn-primary" data-action="book-service" data-service-id="${s.id}">رزرو مستقیم نوبت برای این خدمت</button>
                  <button type="button" class="btn btn-outline" data-route="/consultation">دریافت مشاوره آنلاین درباره این خدمت</button>
                </div>
              </div>

              <div class="service-3d-thumb" style="height:360px;">
                ${window.Avida3D ? window.Avida3D.getService3DSVG(s.model_type) : ''}
              </div>
            </div>
          </div>
        </section>
      `;
    }

    return `
      <section class="section-block">
        <div class="container">
          <div class="section-header">
            <div>
              <span class="section-eyebrow">فهرست کامل خدمات و تعرفه‌های نمونه</span>
              <h1 class="section-title">خدمات دندان‌پزشکی آویدا</h1>
              <p class="section-desc">هر خدمت دارای معرفی روشن، مدت تقریبی جلسه و حدود هزینه نمونه (آزمایشی) است تا پیش از رزرو نوبت، دیدی شفاف داشته باشید.</p>
            </div>
            <button type="button" class="btn btn-primary" data-route="/booking">ورود به تقویم رزرو نوبت</button>
          </div>
          <div class="cards-grid-3">
            ${state.services
              .map(
                (s) => `
              <article class="card-3d">
                <div>
                  <div class="service-3d-thumb">
                    ${window.Avida3D ? window.Avida3D.getService3DSVG(s.model_type) : ''}
                  </div>
                  <span class="badge badge-green" style="margin-bottom:0.5rem;">${escapeHtml(s.category)}</span>
                  <h2 style="font-size:1.18rem; margin-bottom:0.5rem;">${escapeHtml(s.title)}</h2>
                  <p style="font-size:0.91rem; color:var(--ink-600); margin-bottom:0.75rem;">${escapeHtml(s.short_desc)}</p>
                </div>
                <div>
                  <div class="service-meta-row">
                    <span>مدت: <strong>${toFa(s.duration_min)} دقیقه</strong></span>
                    <span style="color:var(--green-800); font-weight:700;">${escapeHtml(s.price_sample)}</span>
                  </div>
                  <div style="display:flex; gap:0.5rem;">
                    <button type="button" class="btn btn-primary btn-sm" style="flex:1;" data-action="book-service" data-service-id="${s.id}">رزرو نوبت</button>
                    <button type="button" class="btn btn-outline btn-sm" data-route="/services/${escapeHtml(s.slug)}">توضیحات کامل</button>
                  </div>
                </div>
              </article>
            `
              )
              .join('')}
          </div>
        </div>
      </section>
    `;
  }

  // -------------------------------------------------------------------------
  // ۳. صفحه معرفی پزشکان و مطب (/doctors)
  // -------------------------------------------------------------------------
  function renderDoctorsPage() {
    const info = state.settings.clinic_info || {};
    return `
      <section class="section-block">
        <div class="container">
          <div class="section-header">
            <div>
              <span class="section-eyebrow">معرفی مطب و تیم دندان‌پزشکان (داده آزمایشی)</span>
              <h1 class="section-title">پزشکان متخصص و برنامه حضور هفتگی در مطب آویدا</h1>
              <p class="section-desc">${escapeHtml(info.about_text || '')}</p>
            </div>
            <button type="button" class="btn btn-primary" data-route="/booking">رزرو نوبت با پزشک منتخب</button>
          </div>

          <div class="cards-grid-2" style="margin-bottom:3rem;">
            ${state.doctors
              .map((d) => {
                const schedRows = WEEKDAYS_FA.map((wName, idx) => {
                  const sc = d.schedule && d.schedule[String(idx)];
                  if (!sc || !sc.active) {
                    return `<span class="badge badge-slate" style="opacity:0.6;">${wName}: عدم حضور</span>`;
                  }
                  return `<span class="badge badge-green">${wName}: ${toFa(sc.start)} تا ${toFa(sc.end)}</span>`;
                }).join(' ');

                return `
                  <article class="card-3d">
                    <div>
                      <div style="display:flex; align-items:center; gap:1rem; margin-bottom:1rem;">
                        <div style="width:68px; height:68px; border-radius:20px; background:linear-gradient(135deg, var(--green-900), var(--green-600)); color:#FFF; display:flex; align-items:center; justify-content:center; font-size:1.45rem; font-weight:700;">
                          ${escapeHtml(d.name.replace('دکتر ', '').slice(0, 1))}
                        </div>
                        <div>
                          <h2 style="font-size:1.22rem;">${escapeHtml(d.name)}</h2>
                          <p style="color:var(--green-800); font-weight:700; font-size:0.92rem;">${escapeHtml(d.specialty)}</p>
                          <span class="badge badge-amber" style="margin-top:0.25rem;">${escapeHtml(d.medical_code)}</span>
                        </div>
                      </div>
                      <p style="font-size:0.93rem; color:var(--ink-700); margin-bottom:0.75rem;">${escapeHtml(d.bio)}</p>
                      <p style="font-size:0.84rem; color:var(--ink-600); margin-bottom:1rem;">${escapeHtml(d.experience_note)}</p>
                      <div style="background:var(--bg-page); padding:0.9rem; border-radius:var(--radius-md); margin-bottom:1.1rem;">
                        <div style="font-weight:700; font-size:0.85rem; margin-bottom:0.5rem;">برنامه حضور هفتگی در مطب:</div>
                        <div style="display:flex; flex-wrap:wrap; gap:0.4rem;">
                          ${schedRows}
                        </div>
                      </div>
                    </div>
                    <button type="button" class="btn btn-primary btn-sm" data-action="book-doctor" data-doctor-id="${d.id}">رزرو نوبت با ${escapeHtml(d.name)}</button>
                  </article>
                `;
              })
              .join('')}
          </div>

          <div class="card-3d" style="background:linear-gradient(135deg, #09151B 0%, #102A32 100%); color:#FFFFFF; border-color:rgba(52,211,153,0.35);">
            <h2 style="color:#FFFFFF; font-size:1.35rem; margin-bottom:0.75rem;">استانداردهای پاکیزگی، استریلیزاسیون و آرامش در مطب آویدا</h2>
            <div class="cards-grid-3" style="margin-top:0.75rem;">
              <div style="background:rgba(255,255,255,0.06); padding:1.1rem; border-radius:var(--radius-md);">
                <h3 style="color:#34D399; font-size:1.02rem; margin-bottom:0.4rem;">اتوکلاو کلاس B و پایش دیجیتال</h3>
                <p style="font-size:0.88rem; color:#CBD5E1;">تمامی اینسترومنت‌ها و هندپیس‌ها در پک‌های استریل مجزا با نشانگرهای شیمیایی و بیولوژیک برای هر مراجع آماده می‌شوند.</p>
              </div>
              <div style="background:rgba(255,255,255,0.06); padding:1.1rem; border-radius:var(--radius-md);">
                <h3 style="color:#34D399; font-size:1.02rem; margin-bottom:0.4rem;">فاصله اجباری ضدعفونی بین نوبت‌ها</h3>
                <p style="font-size:0.88rem; color:#CBD5E1;">سامانه نوبت‌دهی آویدا به‌طور خودکار میان هر دو نوبت یک بازه تنفس و ضدعفونی سطوح لحاظ می‌کند تا تداخل و ازدحام ایجاد نشود.</p>
              </div>
              <div style="background:rgba(255,255,255,0.06); padding:1.1rem; border-radius:var(--radius-md);">
                <h3 style="color:#FDA4AF; font-size:1.02rem; margin-bottom:0.4rem;">شفافیت اطلاعات و اخلاق حرفه‌ای</h3>
                <p style="font-size:0.88rem; color:#CBD5E1;">در این وب‌سایت هیچ‌گونه آمار تأییدنشده، نظر ساختگی یا وعده نتیجه قطعی درمانی درج نمی‌شود و طرح درمان پس از معاینه حضوری تعیین می‌گردد.</p>
              </div>
            </div>
          </div>
        </div>
      </section>
    `;
  }

  // -------------------------------------------------------------------------
  // ۴. صفحه رزرو نوبت ۵ مرحله‌ای (/booking)
  // -------------------------------------------------------------------------
  function renderBookingPage() {
    const w = state.wizard;
    const selectedService = state.services.find((s) => Number(s.id) === Number(w.service_id)) || state.services[0];
    const selectedDoctor = state.doctors.find((d) => Number(d.id) === Number(w.doctor_id)) || state.doctors[0];
    const slotsInfo = state.currentSlotsData || { slots: [], human_date: '' };
    const rules = state.settings.scheduling_rules || {};

    const stepLabels = [
      { n: 1, title: '۱. انتخاب خدمت' },
      { n: 2, title: '۲. انتخاب پزشک' },
      { n: 3, title: '۳. انتخاب روز و ساعت' },
      { n: 4, title: '۴. تأیید اطلاعات' },
      { n: 5, title: '۵. ثبت نوبت' },
    ];

    const stepsBarHtml = stepLabels
      .map((st) => {
        const cls = w.step === st.n ? 'active' : w.step > st.n ? 'completed' : '';
        return `
          <div class="wizard-step-item ${cls}">
            <span class="step-num-circle">${toFa(st.n)}</span>
            <span>${st.title}</span>
          </div>
        `;
      })
      .join('');

    let stepContentHtml = '';

    if (w.step === 1) {
      stepContentHtml = `
        <h2 style="font-size:1.3rem; margin-bottom:1rem;">گام اول: خدمت دندان‌پزشکی مورد نظر خود را انتخاب کنید</h2>
        <div class="cards-grid-3">
          ${state.services
            .map((s) => {
              const isSel = Number(s.id) === Number(w.service_id);
              return `
                <div class="card-3d" style="border-width:2px; border-color:${isSel ? 'var(--green-700)' : 'var(--border-subtle)'}; background:${isSel ? 'var(--bg-mint-soft)' : 'var(--bg-surface)'};">
                  <div>
                    <span class="badge badge-green" style="margin-bottom:0.5rem;">${escapeHtml(s.category)}</span>
                    <h3 style="font-size:1.1rem; margin-bottom:0.4rem;">${escapeHtml(s.title)}</h3>
                    <p style="font-size:0.86rem; color:var(--ink-600);">${escapeHtml(s.short_desc)}</p>
                  </div>
                  <div>
                    <div class="service-meta-row">
                      <span>مدت جلسه: <strong>${toFa(s.duration_min)} دقیقه</strong></span>
                      <span style="font-weight:700; color:var(--green-800);">${escapeHtml(s.price_sample)}</span>
                    </div>
                    <button type="button" class="btn ${isSel ? 'btn-primary' : 'btn-outline'} btn-sm" style="width:100%;" data-action="wizard-pick-service" data-service-id="${s.id}">
                      ${isSel ? '✓ انتخاب‌شده — ادامه به گام بعد' : 'انتخاب این خدمت'}
                    </button>
                  </div>
                </div>
              `;
            })
            .join('')}
        </div>
      `;
    } else if (w.step === 2) {
      stepContentHtml = `
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.75rem; margin-bottom:1.25rem;">
          <div>
            <h2 style="font-size:1.3rem;">گام دوم: دندان‌پزشک معالج را انتخاب کنید</h2>
            <p style="font-size:0.9rem; color:var(--ink-600);">خدمت انتخاب‌شده: <strong>${escapeHtml(selectedService ? selectedService.title : '')}</strong> (${toFa(selectedService ? selectedService.duration_min : 45)} دقیقه)</p>
          </div>
          <button type="button" class="btn btn-outline btn-sm" data-action="wizard-goto-step" data-step="1">← تغییر خدمت</button>
        </div>
        <div class="cards-grid-2">
          ${state.doctors
            .map((d) => {
              const isSel = Number(d.id) === Number(w.doctor_id);
              const activeDays = WEEKDAYS_FA.filter((_, idx) => d.schedule && d.schedule[String(idx)] && d.schedule[String(idx)].active);
              return `
                <div class="card-3d" style="border-width:2px; border-color:${isSel ? 'var(--green-700)' : 'var(--border-subtle)'}; background:${isSel ? 'var(--bg-mint-soft)' : 'var(--bg-surface)'};">
                  <div>
                    <h3 style="font-size:1.15rem;">${escapeHtml(d.name)}</h3>
                    <p style="color:var(--green-800); font-weight:700; font-size:0.88rem; margin-bottom:0.5rem;">${escapeHtml(d.specialty)}</p>
                    <p style="font-size:0.86rem; color:var(--ink-600); margin-bottom:0.75rem;">${escapeHtml(d.bio)}</p>
                    <div style="font-size:0.82rem; margin-bottom:1rem;"><strong>روزهای حضور:</strong> ${escapeHtml(activeDays.join('، '))}</div>
                  </div>
                  <button type="button" class="btn ${isSel ? 'btn-primary' : 'btn-outline'} btn-sm" style="width:100%;" data-action="wizard-pick-doctor" data-doctor-id="${d.id}">
                    ${isSel ? '✓ انتخاب‌شده — مشاهده تقویم و ساعت‌ها' : 'انتخاب این پزشک'}
                  </button>
                </div>
              `;
            })
            .join('')}
        </div>
      `;
    } else if (w.step === 3) {
      const daysHtml = state.upcoming_days
        .map((d) => {
          const isSel = d.jalali_date === w.jalali_date;
          const docSched = selectedDoctor && selectedDoctor.schedule ? selectedDoctor.schedule[String(d.weekday_idx)] : null;
          const docWorks = docSched && docSched.active && !d.is_holiday;
          return `
            <button type="button"
              class="jalali-day-btn ${isSel ? 'selected' : ''} ${d.is_holiday ? 'is-holiday' : ''}"
              data-action="wizard-pick-date"
              data-date="${escapeHtml(d.jalali_date)}"
              aria-label="${escapeHtml(d.human)} ${d.is_holiday ? 'تعطیل' : docWorks ? 'حضور پزشک' : 'عدم حضور پزشک'}">
              <span style="font-size:0.76rem; opacity:0.85;">${escapeHtml(d.weekday_name)}</span>
              <strong style="font-size:1.2rem; margin:0.15rem 0;">${escapeHtml(d.day_num_fa)} ${escapeHtml(d.month_name)}</strong>
              <span style="font-size:0.72rem; font-weight:700;">
                ${d.is_holiday ? 'تعطیل' : docWorks ? 'دارای نوبت' : 'عدم حضور'}
              </span>
            </button>
          `;
        })
        .join('');

      let slotsHtml = '';
      if (state.slotsError) {
        slotsHtml = `<div role="alert">${escapeHtml(state.slotsError)} <button type="button" class="btn btn-outline btn-sm" data-action="wizard-goto-step" data-step="3">تلاش دوباره</button></div>`;
      } else if (slotsInfo.is_holiday) {
        slotsHtml = `
          <div style="background:var(--coral-50); border:1px solid #FECDD3; color:var(--coral-700); padding:1.25rem; border-radius:var(--radius-md); font-weight:700;">
            مطب در تاریخ ${escapeHtml(slotsInfo.human_date)} به علت «${escapeHtml(slotsInfo.holiday_reason)}» تعطیل است. لطفاً روز دیگری را از تقویم شمسی بالا انتخاب کنید.
          </div>
        `;
      } else if (!slotsInfo.doctor_working) {
        slotsHtml = `
          <div style="background:var(--amber-100); border:1px solid #FDE68A; color:var(--amber-700); padding:1.25rem; border-radius:var(--radius-md); font-weight:700;">
            ${escapeHtml(selectedDoctor ? selectedDoctor.name : 'پزشک')} در روز ${escapeHtml(slotsInfo.human_date)} برنامه حضور ندارد. لطفاً یکی از روزهای دارای برچسب «دارای نوبت» را انتخاب کنید.
          </div>
        `;
      } else {
        slotsHtml = `
          <div class="slots-grid">
            ${(slotsInfo.slots || [])
              .map((s) => {
                const isSelectedSlot = s.start_time === w.start_time && s.status === 'available';
                const statusLabel =
                  s.status === 'available'
                    ? 'آزاد'
                    : s.status === 'booked'
                    ? 'رزروشده'
                    : 'مسدودشده';
                return `
                  <button type="button"
                    class="slot-chip ${s.status} ${isSelectedSlot ? 'selected' : ''}"
                    ${s.status !== 'available' ? 'disabled' : ''}
                    data-action="wizard-pick-slot"
                    data-start="${escapeHtml(s.start_time)}"
                    aria-label="ساعت ${s.start_time_fa} تا ${s.end_time_fa} وضعیت ${statusLabel}">
                    <strong style="font-size:1.05rem;">${escapeHtml(s.start_time_fa)} تا ${escapeHtml(s.end_time_fa)}</strong>
                    <span style="font-size:0.75rem;">${escapeHtml(statusLabel)}${s.status === 'blocked' ? ` (${escapeHtml(s.reason)})` : ''}</span>
                  </button>
                `;
              })
              .join('')}
          </div>
        `;
      }

      stepContentHtml = `
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.75rem; margin-bottom:1.25rem;">
          <div>
            <h2 style="font-size:1.3rem;">گام سوم: انتخاب روز و ساعت در تقویم شمسی (به وقت ایران)</h2>
            <p style="font-size:0.88rem; color:var(--ink-600);">
              خدمت: <strong>${escapeHtml(selectedService ? selectedService.title : '')}</strong> (${toFa(selectedService ? selectedService.duration_min : 45)} دقیقه) + <strong>${toFa(rules.buffer_minutes ?? 15)} دقیقه</strong> فاصله ضدعفونی | پزشک: <strong>${escapeHtml(selectedDoctor ? selectedDoctor.name : '')}</strong>
            </p>
          </div>
          <button type="button" class="btn btn-outline btn-sm" data-action="wizard-goto-step" data-step="2">← تغییر پزشک</button>
        </div>

        <h3 style="font-size:1rem; margin-bottom:0.65rem;">۱. روز مراجعه را از تقویم شمسی ۱۴ روز آینده انتخاب کنید:</h3>
        <div class="jalali-calendar-grid">
          ${daysHtml}
        </div>

        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.5rem; margin-bottom:0.85rem;">
          <h3 style="font-size:1rem;">۲. ساعت‌های روز ${escapeHtml(slotsInfo.human_date || '')}:</h3>
          <div style="display:flex; gap:0.5rem; flex-wrap:wrap; font-size:0.78rem;">
            <span class="badge badge-green">آزاد و قابل رزرو</span>
            <span class="badge badge-slate">رزروشده توسط سایر مراجعان</span>
            <span class="badge badge-coral">مسدودشده / استراحت / تعطیل</span>
          </div>
        </div>
        ${slotsHtml}
      `;
    } else if (w.step === 4) {
      const conflictHtml =
        w.conflictAlternatives && w.conflictAlternatives.length > 0
          ? `
            <div style="background:var(--coral-50); border:2px solid var(--coral-600); padding:1.25rem; border-radius:var(--radius-md); margin-bottom:1.5rem;" role="alert">
              <h3 style="color:var(--coral-700); font-size:1.05rem; margin-bottom:0.4rem;">⚠️ تداخل زمانی شناسایی شد</h3>
              <p style="font-size:0.9rem; color:var(--ink-900); margin-bottom:0.85rem;">${escapeHtml(w.conflictMessage)}</p>
              <div style="font-weight:700; font-size:0.86rem; margin-bottom:0.5rem;">ساعت‌های آزاد جایگزین پیشنهادی (با یک کلیک انتخاب کنید):</div>
              <div style="display:flex; flex-wrap:wrap; gap:0.5rem;">
                ${w.conflictAlternatives
                  .map(
                    (alt) => `
                  <button type="button" class="btn btn-outline btn-sm" data-action="wizard-pick-alternative" data-date="${escapeHtml(alt.jalali_date)}" data-start="${escapeHtml(alt.start_time)}">
                    ${escapeHtml(alt.human_date)} — ساعت ${escapeHtml(alt.start_time_fa)}
                  </button>
                `
                  )
                  .join('')}
              </div>
            </div>
          `
          : '';

      stepContentHtml = `
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.75rem; margin-bottom:1.25rem;">
          <h2 style="font-size:1.3rem;">گام چهارم: بررسی خلاصه نوبت و تأیید اطلاعات مراجع</h2>
          <button type="button" class="btn btn-outline btn-sm" data-action="wizard-goto-step" data-step="3">← تغییر روز یا ساعت</button>
        </div>

        ${conflictHtml}

        <div class="cards-grid-2">
          <div style="background:var(--bg-mint-soft); border:1px solid var(--border-green); border-radius:var(--radius-lg); padding:1.5rem;">
            <h3 style="font-size:1.12rem; margin-bottom:1rem; color:var(--green-900);">خلاصه نوبت انتخابی شما</h3>
            <p style="margin-bottom:0.55rem;"><strong>خدمت:</strong> ${escapeHtml(selectedService ? selectedService.title : '')}</p>
            <p style="margin-bottom:0.55rem;"><strong>پزشک معالج:</strong> ${escapeHtml(selectedDoctor ? selectedDoctor.name : '')}</p>
            <p style="margin-bottom:0.55rem;"><strong>تاریخ شمسی:</strong> ${escapeHtml(slotsInfo.human_date || toFa(w.jalali_date))}</p>
            <p style="margin-bottom:0.55rem;"><strong>ساعت حضور:</strong> ${toFa(w.start_time)} (مدت جلسه: ${toFa(selectedService ? selectedService.duration_min : 45)} دقیقه)</p>
            <p style="margin-bottom:0.85rem;"><strong>حدود هزینه نمونه:</strong> ${escapeHtml(selectedService ? selectedService.price_sample : '')}</p>
            <div style="font-size:0.82rem; color:var(--ink-700); background:rgba(255,255,255,0.75); padding:0.75rem; border-radius:var(--radius-sm);">
              <strong>قوانین لغو و جابه‌جایی مطب:</strong> ${escapeHtml(rules.policy_text || '')}
            </div>
          </div>

          <form id="booking-confirm-form">
            <div class="form-group">
              <label class="form-label" for="bk-patient-name">نام و نام خانوادگی مراجع *</label>
              <input id="bk-patient-name" class="form-input" type="text" required value="${escapeHtml(w.patient_name || (state.user ? state.user.name : ''))}" placeholder="مانند: سارا مرادی" />
            </div>
            <div class="form-group">
              <label class="form-label" for="bk-patient-phone">شماره همراه (جهت ثبت کد پیگیری) *</label>
              <input id="bk-patient-phone" class="form-input" type="tel" dir="ltr" style="text-align:right;" required value="${escapeHtml(w.patient_phone || (state.user && state.user.phone ? state.user.phone : ''))}" placeholder="09121112233" />
            </div>
            <div class="form-group">
              <label class="form-label" for="bk-notes">توضیحات تکمیلی برای پزشک (اختیاری)</label>
              <textarea id="bk-notes" class="form-textarea" placeholder="اگر حساسیت دارویی یا توضیح خاصی درباره دندان خود دارید بنویسید...">${escapeHtml(w.notes || '')}</textarea>
            </div>
            ${!state.user ? '<p role="status" style="margin-bottom:0.75rem;">برای ثبت نهایی و مدیریت نوبت، وارد حساب کاربری شوید. انتخاب‌های شما حفظ می‌شود.</p><button type="button" class="btn btn-primary" style="width:100%;" data-action="booking-login">ورود یا ثبت‌نام و ادامه رزرو</button>' : '<button type="submit" class="btn btn-primary" style="width:100%;">ثبت نهایی نوبت و دریافت کد پیگیری</button>'}
          </form>
        </div>
      `;
    } else if (w.step === 5 && w.completedAppointment) {
      const ap = w.completedAppointment;
      stepContentHtml = `
        <div style="text-align:center; padding:1rem 0;">
          <div style="display:flex; justify-content:center; margin-bottom:1rem;">
            <canvas id="booking-celebration-canvas" width="280" height="170" aria-label="انیمیشن سه‌بعدی تکمیل موفق رزرو نوبت"></canvas>
          </div>
          <span class="badge badge-green" style="font-size:0.9rem; margin-bottom:0.65rem;">نوبت شما با موفقیت در پایگاه داده ثبت شد</span>
          <h2 style="font-size:1.65rem; margin-bottom:0.5rem;">کد پیگیری اختصاصی: <span style="color:var(--green-800); font-family:monospace;">${escapeHtml(ap.tracking_code)}</span></h2>
          <p style="color:var(--ink-600); margin-bottom:1.5rem;">جزئیات نوبت در داشبورد حساب کاربری شما ذخیره گردید.</p>

          <div style="max-width:560px; margin:0 auto 1.75rem; text-align:right; background:var(--bg-mint-soft); border:1px solid var(--border-green); border-radius:var(--radius-lg); padding:1.5rem;">
            <p style="margin-bottom:0.45rem;"><strong>نام مراجع:</strong> ${escapeHtml(ap.patient_name)} (${toFa(ap.patient_phone)})</p>
            <p style="margin-bottom:0.45rem;"><strong>خدمت:</strong> ${escapeHtml(ap.service_title)}</p>
            <p style="margin-bottom:0.45rem;"><strong>پزشک معالج:</strong> ${escapeHtml(ap.doctor_name)}</p>
            <p style="margin-bottom:0.45rem;"><strong>تاریخ و ساعت:</strong> ${escapeHtml(ap.human_date)} — ساعت ${toFa(ap.start_time)} تا ${toFa(ap.end_time)}</p>
            <p><strong>وضعیت:</strong> <span class="badge badge-green">تأییدشده نهایی</span></p>
          </div>

          <div style="display:flex; justify-content:center; gap:0.85rem; flex-wrap:wrap;">
            <button type="button" class="btn btn-primary" data-route="/dashboard">مشاهده و مدیریت در داشبورد مراجع</button>
            <button type="button" class="btn btn-outline" data-action="wizard-reset">ثبت یک نوبت جدید دیگر</button>
          </div>
        </div>
      `;
    }

    return `
      <section class="section-block">
        <div class="container">
          <div class="section-header">
            <div>
              <span class="section-eyebrow">نوبت‌دهی هوشمند با جلوگیری از تداخل هم‌زمان</span>
              <h1 class="section-title">رزرو آنلاین نوبت در مطب دندان‌پزشکی آویدا</h1>
              <p class="section-desc">مراحل انتخابی شما به‌صورت خودکار در مرورگر حفظ می‌شود تا با بازخوانی صفحه از بین نرود.</p>
            </div>
          </div>

          <div class="wizard-shell">
            <div class="wizard-steps-bar" role="navigation" aria-label="مراحل رزرو نوبت">
              ${stepsBarHtml}
            </div>
            ${stepContentHtml}
          </div>
        </div>
      </section>
    `;
  }

  // -------------------------------------------------------------------------
  // ۵. صفحه مشاوره آنلاین (/consultation)
  // -------------------------------------------------------------------------
  function renderConsultationPage() {
    const info = state.settings.clinic_info || {};
    const userConsults =
      state.dashboardData && state.dashboardData.consultations
        ? state.dashboardData.consultations
        : [];

    return `
      <section class="section-block">
        <div class="container">
          <div class="section-header">
            <div>
              <span class="section-eyebrow">گفت‌وگوی متنی خصوصی با پزشک یا کارشناس مجاز</span>
              <h1 class="section-title">مشاوره آنلاین دندان‌پزشکی آویدا</h1>
              <p class="section-desc">${escapeHtml(info.response_time_label || '')}</p>
            </div>
            <span class="badge badge-green">${escapeHtml(info.staff_availability_status || 'پاسخگویی در ساعات کاری مطب')}</span>
          </div>

          <div style="background:var(--amber-100); border:1px solid #FDE68A; color:var(--amber-700); padding:1rem 1.25rem; border-radius:var(--radius-md); margin-bottom:2rem; font-size:0.9rem; font-weight:700;">
            ⚖️ ${escapeHtml(info.medical_disclaimer || 'توجه: مشاوره آنلاین جهت راهنمایی اولیه بوده و تشخیص قطعی، تجویز دارو یا وعده نتیجه قطعی درمان محسوب نمی‌شود.')}
          </div>

          <div class="cards-grid-2">
            <div class="card-3d">
              <h2 style="font-size:1.22rem; margin-bottom:1rem;">ثبت درخواست مشاوره جدید</h2>
              ${
                !state.user
                  ? `
                    <div style="background:var(--bg-page); padding:1.25rem; border-radius:var(--radius-md); border:1px solid var(--border-subtle);">
                      <p style="margin-bottom:1rem; color:var(--ink-700);">برای حفظ محرمانگی پرسش‌های درمانی و امکان مشاهده پاسخ پزشک در حساب خصوصی خودتان، لطفاً ابتدا وارد حساب کاربری شوید.</p>
                      <div style="display:flex; gap:0.65rem; flex-wrap:wrap;">
                        <button type="button" class="btn btn-primary btn-sm" data-route="/auth">ورود / ثبت‌نام</button>
                        <button type="button" class="btn btn-outline btn-sm" data-action="quick-demo-login" data-role="patient">ورود فوری با حساب آزمایشی مراجع</button>
                      </div>
                    </div>
                  `
                  : `
                    <form id="new-consultation-form">
                      <div class="form-group">
                        <label class="form-label" for="cns-service">خدمت مرتبط</label>
                        <select id="cns-service" class="form-select">
                          ${state.services.map((s) => `<option value="${s.id}">${escapeHtml(s.title)}</option>`).join('')}
                        </select>
                      </div>
                      <div class="form-group">
                        <label class="form-label" for="cns-doctor">پزشک مورد نظر</label>
                        <select id="cns-doctor" class="form-select">
                          ${state.doctors.map((d) => `<option value="${d.id}">${escapeHtml(d.name)} (${escapeHtml(d.specialty)})</option>`).join('')}
                        </select>
                      </div>
                      <div class="form-group">
                        <label class="form-label" for="cns-urgency">فوریت پرسش</label>
                        <select id="cns-urgency" class="form-select">
                          <option value="عادی">عادی (بررسی طرح درمان و سؤالات عمومی)</option>
                          <option value="حساسیت یا درد خفیف">حساسیت دندانی یا پرسش پس از درمان</option>
                          <option value="نیاز به راهنمایی سریع">نیاز به راهنمایی پیش از رزرو نوبت</option>
                        </select>
                      </div>
                      <div class="form-group">
                        <label class="form-label" for="cns-subject">موضوع مشاوره *</label>
                        <input id="cns-subject" class="form-input" type="text" required placeholder="مانند: سؤال درباره مراحل ایمپلنت دیجیتال" />
                      </div>
                      <div class="form-group">
                        <label class="form-label" for="cns-message">شرح کامل پرسش یا علائم *</label>
                        <textarea id="cns-message" class="form-textarea" required placeholder="لطفاً سؤال خود را با جزئیات بنویسید تا پزشک راهنمایی دقیقی ارائه دهد..."></textarea>
                      </div>
                      <button type="submit" class="btn btn-primary" style="width:100%;">ثبت و ارسال خصوصی برای پزشک</button>
                    </form>
                  `
              }
            </div>

            <div>
              <h2 style="font-size:1.22rem; margin-bottom:1rem;">گفت‌وگوهای مشاوره شما</h2>
              ${
                !state.user
                  ? `<div class="card-3d"><p style="color:var(--ink-600);">پس از ورود به حساب کاربری، فهرست گفت‌وگوهای خصوصی شما در این بخش نمایش داده می‌شود.</p></div>`
                  : userConsults.length === 0
                  ? `<div class="card-3d"><p style="color:var(--ink-600);">هنوز گفت‌وگوی مشاوره‌ای ثبت نکرده‌اید.</p></div>`
                  : userConsults
                      .map((c) => {
                        const stBadge =
                          c.status === 'answered'
                            ? `<span class="badge badge-green">پاسخ‌داده‌شده</span>`
                            : c.status === 'closed'
                            ? `<span class="badge badge-slate">بسته‌شده</span>`
                            : `<span class="badge badge-amber">در انتظار پاسخ</span>`;
                        return `
                          <div class="card-3d" style="margin-bottom:1rem;">
                            <div style="display:flex; justify-content:space-between; align-items:center; gap:0.5rem; margin-bottom:0.5rem;">
                              <strong>${escapeHtml(c.subject)}</strong>
                              ${stBadge}
                            </div>
                            <div style="font-size:0.8rem; color:var(--ink-600); margin-bottom:0.5rem;">
                              کد: ${escapeHtml(c.tracking_code)} | پزشک: ${escapeHtml(c.doctor_name || 'تیم پزشکی آویدا')}
                            </div>
                            <div class="thread-box">
                              ${(c.messages || [])
                                .map(
                                  (m) => `
                                <div class="chat-bubble ${m.sender_role === 'patient' ? 'patient' : 'staff'}">
                                  <div style="font-size:0.76rem; font-weight:700; color:var(--green-800); margin-bottom:0.2rem;">${escapeHtml(m.sender_name)}</div>
                                  <div style="font-size:0.9rem;">${escapeHtml(m.message)}</div>
                                </div>
                              `
                                )
                                .join('')}
                            </div>
                            ${
                              c.status !== 'closed'
                                ? `
                                  <form class="consult-reply-form" data-cid="${c.id}" style="display:flex; gap:0.5rem; margin-top:0.75rem;">
                                    <input type="text" class="form-input" name="reply_text" required placeholder="ارسال پیام تکمیلی در این گفت‌وگو..." />
                                    <button type="submit" class="btn btn-primary btn-sm">ارسال</button>
                                  </form>
                                `
                                : ''
                            }
                          </div>
                        `;
                      })
                      .join('')
              }
            </div>
          </div>
        </div>
      </section>
    `;
  }

  // -------------------------------------------------------------------------
  // ۶. صفحه تماس و پشتیبانی (/contact)
  // -------------------------------------------------------------------------
  function renderContactPage() {
    const info = state.settings.clinic_info || {};
    const tickets =
      state.dashboardData && state.dashboardData.support_tickets
        ? state.dashboardData.support_tickets
        : [];

    return `
      <section class="section-block">
        <div class="container">
          <div class="section-header">
            <div>
              <span class="section-eyebrow">ارتباط مستقیم با پذیرش و پشتیبانی مراجعان</span>
              <h1 class="section-title">تماس با مطب دندان‌پزشکی آویدا و ثبت درخواست پشتیبانی</h1>
              <p class="section-desc">${escapeHtml(info.response_time_label || '')}</p>
            </div>
          </div>

          <div class="cards-grid-3" style="margin-bottom:2.25rem;">
            <div class="card-3d">
              <span class="badge badge-green" style="width:fit-content; margin-bottom:0.5rem;">تلفن‌های پذیرش</span>
              <h2 style="font-size:1.15rem; margin-bottom:0.4rem;">${escapeHtml(info.phone_primary || '۰۲۱-۸۸۹۹۴۴۱۱')}</h2>
              <p style="font-size:0.88rem; color:var(--ink-600);">پاسخگویی تلفنی و هماهنگی نوبت در ساعات کاری مطب (${escapeHtml(info.phone_support || '۰۹۱۲-۰۰۰-۰۰۰۱')})</p>
            </div>
            <div class="card-3d">
              <span class="badge badge-green" style="width:fit-content; margin-bottom:0.5rem;">نشانی مطب (نمونه)</span>
              <h2 style="font-size:1.05rem; margin-bottom:0.4rem;">تهران، خیابان ولیعصر</h2>
              <p style="font-size:0.88rem; color:var(--ink-600);">${escapeHtml(info.address || '')}</p>
            </div>
            <div class="card-3d">
              <span class="badge badge-coral" style="width:fit-content; margin-bottom:0.5rem;">ساعات کاری رسمی</span>
              <h2 style="font-size:1.05rem; margin-bottom:0.4rem;">شنبه تا پنجشنبه</h2>
              <p style="font-size:0.88rem; color:var(--ink-600);">${escapeHtml(info.working_hours_text || '')}</p>
            </div>
          </div>

          <div class="cards-grid-2">
            <div class="card-3d">
              <h2 style="font-size:1.22rem; margin-bottom:1rem;">ارسال پیام به پشتیبانی مطب</h2>
              <form id="support-ticket-form">
                <div class="form-grid">
                  <div class="form-group">
                    <label class="form-label" for="sup-name">نام و نام خانوادگی *</label>
                    <input id="sup-name" class="form-input" type="text" required value="${escapeHtml(state.user ? state.user.name : '')}" placeholder="نام کامل شما" />
                  </div>
                  <div class="form-group">
                    <label class="form-label" for="sup-contact">شماره همراه یا ایمیل *</label>
                    <input id="sup-contact" class="form-input" type="text" required value="${escapeHtml(state.user ? state.user.phone || state.user.email || '' : '')}" placeholder="0912..." />
                  </div>
                </div>
                <div class="form-grid">
                  <div class="form-group">
                    <label class="form-label" for="sup-category">بخش مربوطه</label>
                    <select id="sup-category" class="form-select">
                      <option value="پذیرش و نوبت‌دهی">پذیرش و هماهنگی نوبت</option>
                      <option value="مالی و بیمه">امور مالی و گواهی بیمه تکمیلی</option>
                      <option value="پشتیبانی فنی سایت">پشتیبانی سامانه آنلاین</option>
                      <option value="انتقادات و پیشنهادها">انتقادات و پیشنهادها</option>
                    </select>
                  </div>
                  <div class="form-group">
                    <label class="form-label" for="sup-subject">موضوع درخواست *</label>
                    <input id="sup-subject" class="form-input" type="text" required placeholder="موضوع پیام..." />
                  </div>
                </div>
                <div class="form-group">
                  <label class="form-label" for="sup-message">متن پیام *</label>
                  <textarea id="sup-message" class="form-textarea" required placeholder="جزئیات درخواست خود را بنویسید..."></textarea>
                </div>
                <button type="submit" class="btn btn-primary" style="width:100%;">ثبت درخواست پشتیبانی و دریافت کد پیگیری</button>
              </form>
            </div>

            <div>
              <h2 style="font-size:1.22rem; margin-bottom:1rem;">پیگیری درخواست‌های پشتیبانی شما</h2>
              ${
                tickets.length === 0
                  ? `<div class="card-3d"><p style="color:var(--ink-600);">برای مشاهده تاریخچه درخواست‌های پشتیبانی و تبادل پیام با پذیرش، با حساب کاربری خود وارد شوید یا فرم روبه‌رو را تکمیل نمایید.</p></div>`
                  : tickets
                      .map((t) => {
                        const badge =
                          t.status === 'answered'
                            ? `<span class="badge badge-green">پاسخ‌داده‌شده</span>`
                            : t.status === 'closed'
                            ? `<span class="badge badge-slate">بسته‌شده</span>`
                            : `<span class="badge badge-amber">در انتظار بررسی</span>`;
                        return `
                          <div class="card-3d" style="margin-bottom:1rem;">
                            <div style="display:flex; justify-content:space-between; align-items:center;">
                              <strong>${escapeHtml(t.subject)}</strong>
                              ${badge}
                            </div>
                            <div style="font-size:0.8rem; color:var(--ink-600); margin:0.35rem 0;">کد پیگیری: ${escapeHtml(t.tracking_code)} | دسته‌بندی: ${escapeHtml(t.category)}</div>
                            <div class="thread-box">
                              ${(t.messages || [])
                                .map(
                                  (m) => `
                                <div class="chat-bubble ${m.sender_role === 'patient' ? 'patient' : 'staff'}">
                                  <div style="font-size:0.75rem; font-weight:700; color:var(--green-800);">${escapeHtml(m.sender_name)}</div>
                                  <div style="font-size:0.9rem;">${escapeHtml(m.message)}</div>
                                </div>
                              `
                                )
                                .join('')}
                            </div>
                            <form class="support-reply-form" data-tid="${t.id}" style="display:flex; gap:0.5rem; margin-top:0.75rem;">
                              <input type="text" class="form-input" name="reply_text" required placeholder="ارسال پاسخ به پشتیبانی..." />
                              <button type="submit" class="btn btn-outline btn-sm">ارسال</button>
                            </form>
                          </div>
                        `;
                      })
                      .join('')
              }
            </div>
          </div>
        </div>
      </section>
    `;
  }

  // -------------------------------------------------------------------------
  // ۷. صفحه ورود، ثبت‌نام و بازیابی دسترسی (/auth)
  // -------------------------------------------------------------------------
  function renderAuthPage() {
    const tab = state.authTab;

    return `
      <section class="section-block">
        <div class="container" style="max-width:640px;">
          <div class="card-3d" style="padding:2.2rem;">
            <div style="text-align:center; margin-bottom:1.5rem;">
              <span class="section-eyebrow">حساب کاربری امن مطب آویدا</span>
              <h1 style="font-size:1.55rem;">ورود، ثبت‌نام و بازیابی دسترسی</h1>
            </div>

            <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:0.5rem; margin-bottom:1.75rem; background:var(--bg-page); padding:0.4rem; border-radius:var(--radius-md);">
              <button type="button" class="btn btn-sm ${tab === 'login' ? 'btn-primary' : 'btn-outline'}" data-action="auth-switch-tab" data-tab="login">ورود به حساب</button>
              <button type="button" class="btn btn-sm ${tab === 'register' ? 'btn-primary' : 'btn-outline'}" data-action="auth-switch-tab" data-tab="register">ثبت‌نام مراجع جدید</button>
              <button type="button" class="btn btn-sm ${tab === 'recover' ? 'btn-primary' : 'btn-outline'}" data-action="auth-switch-tab" data-tab="recover">بازیابی رمز عبور</button>
            </div>

            ${
              tab === 'login'
                ? `
                  <form id="auth-login-form">
                    <div class="form-group">
                      <label class="form-label" for="login-identifier">شماره همراه یا ایمیل *</label>
                      <input id="login-identifier" class="form-input" type="text" required placeholder="مانند: 09121112233 یا admin@avidadental.ir" />
                    </div>
                    <div class="form-group">
                      <label class="form-label" for="login-password">رمز عبور *</label>
                      <div class="password-field-wrap">
                        <input id="login-password" class="form-input" type="password" required placeholder="رمز عبور خود را وارد کنید" />
                        <button type="button" class="password-toggle-btn" data-action="toggle-password" data-target="login-password">نمایش رمز</button>
                      </div>
                    </div>
                    <button type="submit" class="btn btn-primary" style="width:100%; margin-top:0.5rem;">ورود به حساب کاربری</button>
                  </form>
                `
                : tab === 'register'
                ? `
                  <form id="auth-register-form">
                    <div class="form-group">
                      <label class="form-label" for="reg-name">نام و نام خانوادگی *</label>
                      <input id="reg-name" class="form-input" type="text" required placeholder="مانند: مریم احمدی" />
                    </div>
                    <div class="form-group">
                      <label class="form-label" for="reg-identifier">شماره همراه (۱۱ رقمی) یا ایمیل *</label>
                      <input id="reg-identifier" class="form-input" type="text" required placeholder="مانند: 09123456789 یا maryam@example.ir" />
                    </div>
                    <div class="form-group">
                      <label class="form-label" for="reg-password">رمز عبور (حداقل ۶ کاراکتر) *</label>
                      <div class="password-field-wrap">
                        <input id="reg-password" class="form-input" type="password" required placeholder="حداقل ۶ کاراکتر" />
                        <button type="button" class="password-toggle-btn" data-action="toggle-password" data-target="reg-password">نمایش رمز</button>
                      </div>
                    </div>
                    <button type="submit" class="btn btn-primary" style="width:100%; margin-top:0.5rem;">ایجاد حساب کاربری و ورود</button>
                  </form>
                `
                : `
                  <div>
                    <div style="background:var(--bg-mint-soft); border:1px solid var(--border-green); padding:0.95rem; border-radius:var(--radius-sm); font-size:0.86rem; margin-bottom:1.25rem;">
                      <strong>شفافیت حالت آزمایشی:</strong> از آنجا که سامانه پیامک/ایمیل بیرونی در این محیط آزمایشی متصل نیست، کد بازیابی ۶ رقمی مستقیماً روی صفحه نمایش داده می‌شود و هیچ پیامک واقعی ارسال نمی‌گردد.
                    </div>
                    <form id="auth-recover-request-form" style="margin-bottom:1.25rem;">
                      <div class="form-group">
                        <label class="form-label" for="rec-identifier">شماره همراه یا ایمیل ثبت‌شده *</label>
                        <input id="rec-identifier" class="form-input" type="text" required value="${escapeHtml(state.recoveryIdentifier || '09121112233')}" placeholder="09121112233" />
                      </div>
                      <button type="submit" class="btn btn-outline" style="width:100%;">دریافت کد بازیابی آزمایشی</button>
                    </form>

                    ${
                      state.recoveryDemoCode
                        ? `
                          <form id="auth-recover-confirm-form" style="border-top:1px dashed var(--border-subtle); padding-top:1.25rem;">
                            <div style="background:var(--amber-100); padding:0.75rem; border-radius:var(--radius-sm); margin-bottom:1rem; font-weight:700; color:var(--amber-700);">
                              کد بازیابی آزمایشی تولیدشده در سرور: <span style="font-family:monospace; font-size:1.15rem;">${escapeHtml(state.recoveryDemoCode)}</span>
                            </div>
                            <div class="form-group">
                              <label class="form-label" for="rec-code">کد بازیابی ۶ رقمی *</label>
                              <input id="rec-code" class="form-input" type="text" required value="${escapeHtml(state.recoveryDemoCode)}" />
                            </div>
                            <div class="form-group">
                              <label class="form-label" for="rec-new-pass">رمز عبور جدید *</label>
                              <div class="password-field-wrap">
                                <input id="rec-new-pass" class="form-input" type="password" required placeholder="حداقل ۶ کاراکتر" />
                                <button type="button" class="password-toggle-btn" data-action="toggle-password" data-target="rec-new-pass">نمایش رمز</button>
                              </div>
                            </div>
                            <button type="submit" class="btn btn-primary" style="width:100%;">ثبت رمز عبور جدید</button>
                          </form>
                        `
                        : ''
                    }
                  </div>
                `
            }

            <!-- راهنمای حساب‌های آزمایشی برای بررسی سریع -->
            <div style="margin-top:2rem; padding-top:1.25rem; border-top:1px solid var(--border-subtle);">
              <div style="font-weight:700; font-size:0.9rem; margin-bottom:0.65rem;">حساب‌های آزمایشی آماده (ورود با یک کلیک):</div>
              <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:0.5rem;">
                <button type="button" class="btn btn-outline btn-sm" data-action="quick-demo-login" data-role="patient">مراجع (سارا مرادی)</button>
                <button type="button" class="btn btn-outline btn-sm" data-action="quick-demo-login" data-role="doctor">پزشک (دکتر فرهمند)</button>
                <button type="button" class="btn btn-coral btn-sm" data-action="quick-demo-login" data-role="admin">صاحب مطب (مدیر)</button>
              </div>
            </div>
          </div>
        </div>
      </section>
    `;
  }

  // -------------------------------------------------------------------------
  // ۸. داشبورد اختصاصی مراجع (/dashboard)
  // -------------------------------------------------------------------------
  function renderDashboardPage() {
    if (!state.user) return renderAuthPage();
    const d = state.dashboardData || {
      appointments: [],
      consultations: [],
      support_tickets: [],
      notifications: [],
    };
    const appts = d.appointments || [];
    const upcomingAppts = appts.filter(
      (a) => ['confirmed', 'pending', 'rescheduled'].includes(a.status) && appointmentIsFuture(a)
    ).sort((a, b) => `${a.jalali_date} ${a.start_time}`.localeCompare(`${b.jalali_date} ${b.start_time}`));
    const pastOrCancelledAppts = appts.filter((a) => !upcomingAppts.includes(a));
    const nearestAppt = upcomingAppts[0] || null;
    const unreadNotifs = (d.notifications || []).filter((n) => !n.is_read).length;

    let mainPanelHtml = '';

    if (state.dashboardTab === 'appointments') {
      mainPanelHtml = `
        <!-- نزدیک‌ترین نوبت پیش‌رو -->
        <div class="card-3d" style="background:linear-gradient(135deg, #064E3B 0%, #047857 100%); color:#FFFFFF; margin-bottom:1.75rem;">
          <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:1rem;">
            <div>
              <span class="badge" style="background:rgba(255,255,255,0.18); color:#FFF; margin-bottom:0.5rem;">نزدیک‌ترین نوبت پیش‌روی شما</span>
              ${
                nearestAppt
                  ? `
                    <h2 style="color:#FFFFFF; font-size:1.35rem; margin-bottom:0.35rem;">${escapeHtml(nearestAppt.service_title)} — ${escapeHtml(nearestAppt.doctor_name)}</h2>
                    <p style="color:#D1FAE5; font-size:0.95rem;">تاریخ: <strong>${escapeHtml(nearestAppt.human_date)}</strong> | ساعت: <strong>${toFa(nearestAppt.start_time)} تا ${toFa(nearestAppt.end_time)}</strong> | کد پیگیری: <strong>${escapeHtml(nearestAppt.tracking_code)}</strong></p>
                  `
                  : `<h2 style="color:#FFFFFF; font-size:1.2rem;">در حال حاضر نوبت فعالی در پیش ندارید.</h2>`
              }
            </div>
            <button type="button" class="btn btn-ghost-dark" data-route="/booking">+ رزرو نوبت جدید</button>
          </div>
        </div>

        <h2 style="font-size:1.2rem; margin-bottom:1rem;">نوبت‌های آینده (${toFa(upcomingAppts.length)} مورد)</h2>
        ${
          upcomingAppts.length === 0
            ? `<div class="card-3d" style="margin-bottom:1.75rem;"><p style="color:var(--ink-600);">نوبت آینده‌ای ثبت نشده است. از دکمه «رزرو نوبت جدید» استفاده کنید.</p></div>`
            : `<div class="cards-grid-2" style="margin-bottom:2rem;">
                ${upcomingAppts
                  .map(
                    (a) => `
                  <div class="card-3d">
                    <div>
                      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.5rem;">
                        <span class="badge badge-green">${statusLabel(a.status)}</span>
                        <span style="font-family:monospace; font-weight:700; color:var(--ink-600);">${escapeHtml(a.tracking_code)}</span>
                      </div>
                      <h3 style="font-size:1.1rem; margin-bottom:0.35rem;">${escapeHtml(a.service_title)}</h3>
                      <p style="font-size:0.9rem; color:var(--green-800); font-weight:700; margin-bottom:0.5rem;">${escapeHtml(a.doctor_name)}</p>
                      <p style="font-size:0.88rem; margin-bottom:0.3rem;"><strong>زمان:</strong> ${escapeHtml(a.human_date)} ساعت ${toFa(a.start_time)} تا ${toFa(a.end_time)}</p>
                      <p style="font-size:0.84rem; color:var(--ink-600); margin-bottom:1rem;">مدت جلسه: ${toFa(a.duration_min)} دقیقه | دفعات جابه‌جایی: ${toFa(a.reschedule_count)}</p>
                    </div>
                    <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
                      <button type="button" class="btn btn-outline btn-sm" style="flex:1;" data-action="open-reschedule-modal" data-appt-id="${a.id}">جابه‌جایی زمان نوبت</button>
                      <button type="button" class="btn btn-coral btn-sm" data-action="cancel-appointment" data-appt-id="${a.id}">لغو نوبت</button>
                    </div>
                  </div>
                `
                  )
                  .join('')}
              </div>`
        }

        <h2 style="font-size:1.2rem; margin-bottom:1rem;">تاریخچه نوبت‌های گذشته و لغوشده (${toFa(pastOrCancelledAppts.length)} مورد)</h2>
        <div class="cards-grid-2">
          ${pastOrCancelledAppts
            .map(
              (a) => `
            <div class="card-3d" style="opacity:0.88;">
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.4rem;">
                <span class="badge ${a.status === 'cancelled' ? 'badge-coral' : 'badge-slate'}">
                  ${a.status === 'cancelled' ? 'لغوشده' : a.status === 'completed' ? 'انجام‌شده' : 'گذشته'}
                </span>
                <span style="font-family:monospace; font-size:0.85rem;">${escapeHtml(a.tracking_code)}</span>
              </div>
              <h3 style="font-size:1.05rem;">${escapeHtml(a.service_title)} — ${escapeHtml(a.doctor_name)}</h3>
              <p style="font-size:0.86rem; color:var(--ink-600); margin-top:0.3rem;">${escapeHtml(a.human_date)} ساعت ${toFa(a.start_time)}</p>
            </div>
          `
            )
            .join('')}
        </div>
      `;
    } else if (state.dashboardTab === 'consultations') {
      mainPanelHtml = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1.25rem;">
          <h2 style="font-size:1.25rem;">گفت‌وگوهای مشاوره آنلاین شما</h2>
          <button type="button" class="btn btn-primary btn-sm" data-route="/consultation">+ ثبت مشاوره جدید</button>
        </div>
        ${
          (d.consultations || []).length === 0
            ? `<div class="card-3d"><p>هنوز گفت‌وگوی مشاوره‌ای ندارید.</p></div>`
            : (d.consultations || [])
                .map(
                  (c) => `
                <div class="card-3d" style="margin-bottom:1rem;">
                  <div style="display:flex; justify-content:space-between; align-items:center;">
                    <strong>${escapeHtml(c.subject)} (${escapeHtml(c.tracking_code)})</strong>
                    <span class="badge ${c.status === 'answered' ? 'badge-green' : 'badge-amber'}">${c.status === 'answered' ? 'پاسخ‌داده‌شده' : 'در انتظار پاسخ'}</span>
                  </div>
                  <div class="thread-box">
                    ${(c.messages || [])
                      .map(
                        (m) => `
                      <div class="chat-bubble ${m.sender_role === 'patient' ? 'patient' : 'staff'}">
                        <div style="font-size:0.75rem; font-weight:700; color:var(--green-800);">${escapeHtml(m.sender_name)}</div>
                        <div>${escapeHtml(m.message)}</div>
                      </div>
                    `
                      )
                      .join('')}
                  </div>
                  <form class="consult-reply-form" data-cid="${c.id}" style="display:flex; gap:0.5rem; margin-top:0.75rem;">
                    <input type="text" class="form-input" name="reply_text" required placeholder="ارسال پیام در این گفت‌وگو..." />
                    <button type="submit" class="btn btn-primary btn-sm">ارسال</button>
                  </form>
                </div>
              `
                )
                .join('')
        }
      `;
    } else if (state.dashboardTab === 'support') {
      mainPanelHtml = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1.25rem;">
          <h2 style="font-size:1.25rem;">پیام‌ها و تیکت‌های پشتیبانی شما</h2>
          <button type="button" class="btn btn-primary btn-sm" data-route="/contact">+ ارسال تیکت جدید</button>
        </div>
        ${(d.support_tickets || [])
          .map(
            (t) => `
          <div class="card-3d" style="margin-bottom:1rem;">
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <strong>${escapeHtml(t.subject)} (${escapeHtml(t.tracking_code)})</strong>
              <span class="badge ${t.status === 'answered' ? 'badge-green' : 'badge-amber'}">${t.status === 'answered' ? 'پاسخ‌داده‌شده' : 'در انتظار بررسی'}</span>
            </div>
            <div class="thread-box">
              ${(t.messages || [])
                .map(
                  (m) => `
                <div class="chat-bubble ${m.sender_role === 'patient' ? 'patient' : 'staff'}">
                  <div style="font-size:0.75rem; font-weight:700;">${escapeHtml(m.sender_name)}</div>
                  <div>${escapeHtml(m.message)}</div>
                </div>
              `
                )
                .join('')}
            </div>
            <form class="support-reply-form" data-tid="${t.id}" style="display:flex; gap:0.5rem; margin-top:0.75rem;">
              <input type="text" class="form-input" name="reply_text" required placeholder="ارسال پاسخ به پشتیبانی..." />
              <button type="submit" class="btn btn-outline btn-sm">ارسال</button>
            </form>
          </div>
        `
          )
          .join('')}
      `;
    } else if (state.dashboardTab === 'notifications') {
      mainPanelHtml = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1.25rem;">
          <h2 style="font-size:1.25rem;">اعلان‌ها و پیام‌های خوانده‌نشده</h2>
          <button type="button" class="btn btn-outline btn-sm" data-action="mark-notifications-read">علامت‌گذاری همه به‌عنوان خوانده‌شده</button>
        </div>
        ${(d.notifications || [])
          .map(
            (n) => `
          <div class="card-3d" style="margin-bottom:0.75rem; border-right:4px solid ${n.is_read ? 'var(--border-subtle)' : 'var(--coral-600)'};">
            <div style="display:flex; justify-content:space-between;">
              <strong>${escapeHtml(n.title)}</strong>
              ${!n.is_read ? `<span class="badge badge-coral">جدید</span>` : `<span class="badge badge-slate">خوانده‌شده</span>`}
            </div>
            <p style="font-size:0.9rem; color:var(--ink-700); margin-top:0.35rem;">${escapeHtml(n.body)}</p>
          </div>
        `
          )
          .join('')}
      `;
    } else if (state.dashboardTab === 'profile') {
      mainPanelHtml = `
        <div class="card-3d" style="max-width:560px;">
          <h2 style="font-size:1.25rem; margin-bottom:1rem;">ویرایش اطلاعات حساب و تغییر رمز عبور</h2>
          <form id="profile-update-form">
            <div class="form-group">
              <label class="form-label" for="prof-name">نام و نام خانوادگی *</label>
              <input id="prof-name" class="form-input" type="text" required value="${escapeHtml(state.user.name || '')}" />
            </div>
            <div class="form-group">
              <label class="form-label" for="prof-phone">شماره همراه (نام کاربری)</label>
              <input id="prof-phone" class="form-input" type="text" disabled value="${escapeHtml(state.user.phone || '')}" />
            </div>
            <div class="form-group">
              <label class="form-label" for="prof-email">نشانی ایمیل</label>
              <input id="prof-email" class="form-input" type="email" value="${escapeHtml(state.user.email || '')}" />
            </div>
            <div class="form-group">
              <label class="form-label" for="prof-pass">رمز عبور جدید (در صورت تمایل به تغییر وارد کنید)</label>
              <input id="prof-pass" class="form-input" type="password" placeholder="حداقل ۶ کاراکتر" />
            </div>
            <button type="submit" class="btn btn-primary">ذخیره تغییرات حساب</button>
          </form>
        </div>
      `;
    }

    return `
      <section class="section-block">
        <div class="container">
          <div class="section-header">
            <div>
              <span class="section-eyebrow">پرتال اختصاصی مراجع</span>
              <h1 class="section-title">خوش آمدید، ${escapeHtml(state.user.name)}</h1>
            </div>
            <div style="display:flex; gap:0.65rem;">
              <button type="button" class="btn btn-primary btn-sm" data-route="/booking">+ رزرو نوبت جدید</button>
              <button type="button" class="btn btn-outline btn-sm" data-action="logout">خروج از حساب</button>
            </div>
          </div>

          <div class="portal-layout">
            <aside class="portal-sidebar" aria-label="منوی داشبورد مراجع">
              <button type="button" class="portal-nav-btn ${state.dashboardTab === 'appointments' ? 'active' : ''}" data-action="dash-tab" data-tab="appointments">
                <span>نوبت‌های من</span>
                <span class="badge badge-green">${toFa(upcomingAppts.length)}</span>
              </button>
              <button type="button" class="portal-nav-btn ${state.dashboardTab === 'consultations' ? 'active' : ''}" data-action="dash-tab" data-tab="consultations">
                <span>مشاوره‌های آنلاین</span>
                <span class="badge badge-slate">${toFa((d.consultations || []).length)}</span>
              </button>
              <button type="button" class="portal-nav-btn ${state.dashboardTab === 'support' ? 'active' : ''}" data-action="dash-tab" data-tab="support">
                <span>تیکت‌های پشتیبانی</span>
                <span class="badge badge-slate">${toFa((d.support_tickets || []).length)}</span>
              </button>
              <button type="button" class="portal-nav-btn ${state.dashboardTab === 'notifications' ? 'active' : ''}" data-action="dash-tab" data-tab="notifications">
                <span>اعلان‌ها</span>
                ${unreadNotifs > 0 ? `<span class="badge badge-coral">${toFa(unreadNotifs)}</span>` : ''}
              </button>
              <button type="button" class="portal-nav-btn ${state.dashboardTab === 'profile' ? 'active' : ''}" data-action="dash-tab" data-tab="profile">
                <span>ویرایش حساب و رمز</span>
              </button>
            </aside>

            <div>
              ${mainPanelHtml}
            </div>
          </div>
        </div>
      </section>
    `;
  }

  // -------------------------------------------------------------------------
  // ۹. پنل مدیریت صاحب مطب (/admin)
  // -------------------------------------------------------------------------
  function renderAdminPage() {
    if (!state.user || (state.user.role !== 'admin' && state.user.role !== 'doctor')) {
      return renderAuthPage();
    }
    const ad = state.adminData || {
      stats: {},
      appointments: [],
      consultations: [],
      support_tickets: [],
      services: state.services,
      doctors: state.doctors,
      faqs: state.faqs,
      trash: [],
      settings: state.settings,
    };
    const st = ad.stats || {};
    const tab = state.adminTab;
    const info = (ad.settings && ad.settings.clinic_info) || {};
    const rules = (ad.settings && ad.settings.scheduling_rules) || {};
    const holidays = (ad.settings && ad.settings.holidays) || [];
    const blocked = (ad.settings && ad.settings.blocked_slots) || [];

    let adminContentHtml = '';

    if (tab === 'overview') {
      adminContentHtml = `
        <h2 style="font-size:1.25rem; margin-bottom:1rem;">مدیریت و جست‌وجوی نوبت‌های مراجعان</h2>
        <div style="margin-bottom:1rem;">
          <input type="search" id="admin-appt-search" class="form-input" aria-label="جست‌وجوی نوبت‌های مراجعان" placeholder="جست‌وجو بر اساس نام مراجع، کد پیگیری، پزشک یا تاریخ شمسی..." />
        </div>
        <div id="admin-appts-list">
          ${(ad.appointments || [])
            .map(
              (a) => `
            <div class="card-3d admin-appt-item" data-search="${escapeHtml(`${a.tracking_code} ${a.patient_name} ${a.doctor_name} ${a.service_title} ${a.jalali_date}`)}" style="margin-bottom:0.85rem;">
              <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.75rem;">
                <div>
                  <span class="badge ${a.status === 'cancelled' ? 'badge-coral' : 'badge-green'}">${statusLabel(a.status)}</span>
                  <strong style="margin-right:0.5rem;">${escapeHtml(a.patient_name)} (${toFa(a.patient_phone)})</strong>
                  <span style="font-family:monospace; color:var(--ink-600); margin-right:0.5rem;">[${escapeHtml(a.tracking_code)}]</span>
                  <div style="font-size:0.88rem; color:var(--ink-700); margin-top:0.3rem;">
                    خدمت: <strong>${escapeHtml(a.service_title)}</strong> | پزشک: <strong>${escapeHtml(a.doctor_name)}</strong> | زمان: <strong>${escapeHtml(a.human_date)} ساعت ${toFa(a.start_time)} تا ${toFa(a.end_time)}</strong>
                  </div>
                </div>
                <div style="display:flex; gap:0.4rem; flex-wrap:wrap;">
                  ${a.status === 'pending' && appointmentIsFuture(a) ? `<button type="button" class="btn btn-primary btn-sm" data-action="admin-appt-status" data-id="${a.id}" data-status="confirmed">تأیید</button>` : ''}
                  ${['confirmed', 'pending', 'rescheduled'].includes(a.status) && appointmentIsFuture(a) ? `<button type="button" class="btn btn-outline btn-sm" data-action="open-reschedule-modal" data-appt-id="${a.id}">جابه‌جایی</button><button type="button" class="btn btn-coral btn-sm" data-action="admin-appt-status" data-id="${a.id}" data-status="cancelled">لغو نوبت</button>` : ''}
                  ${['confirmed', 'pending', 'rescheduled'].includes(a.status) && !appointmentIsFuture(a) ? `<button type="button" class="btn btn-primary btn-sm" data-action="admin-appt-status" data-id="${a.id}" data-status="completed">ثبت انجام نوبت</button>` : ''}
                </div>
              </div>
            </div>
          `
            )
            .join('')}
        </div>
      `;
    } else if (tab === 'consultations') {
      adminContentHtml = `
        <h2 style="font-size:1.25rem; margin-bottom:1rem;">پاسخگویی به مشاوره‌های آنلاین و تیکت‌های پشتیبانی</h2>
        <h3 style="font-size:1.08rem; margin-bottom:0.75rem; color:var(--green-800);">۱. درخواست‌های مشاوره آنلاین</h3>
        ${(ad.consultations || [])
          .map(
            (c) => `
          <div class="card-3d" style="margin-bottom:1rem;">
            <div style="display:flex; justify-content:space-between;">
              <strong>${escapeHtml(c.subject)} — مراجع: ${escapeHtml(c.patient_name)} (${escapeHtml(c.tracking_code)})</strong>
              <span class="badge ${c.status === 'answered' ? 'badge-green' : 'badge-amber'}">${statusLabel(c.status)}</span>
            </div>
            <div class="thread-box">
              ${(c.messages || [])
                .map(
                  (m) => `
                <div class="chat-bubble ${m.sender_role === 'patient' ? 'patient' : 'staff'}">
                  <div style="font-size:0.75rem; font-weight:700;">${escapeHtml(m.sender_name)}</div>
                  <div>${escapeHtml(m.message)}</div>
                </div>
              `
                )
                .join('')}
            </div>
            <form class="consult-reply-form" data-cid="${c.id}" style="display:flex; gap:0.5rem; margin-top:0.75rem;">
              <input type="text" class="form-input" name="reply_text" required placeholder="پاسخ تخصصی پزشک / کارشناس..." />
              <select name="status" class="form-select" style="width:160px;">
                <option value="answered">پاسخ‌داده‌شده</option>
                <option value="closed">بستن گفت‌وگو</option>
              </select>
              <button type="submit" class="btn btn-primary btn-sm">ثبت پاسخ</button>
            </form>
          </div>
        `
          )
          .join('')}

        <h3 style="font-size:1.08rem; margin:1.75rem 0 0.75rem; color:var(--green-800);">۲. تیکت‌های پشتیبانی مراجعان</h3>
        ${(ad.support_tickets || [])
          .map(
            (t) => `
          <div class="card-3d" style="margin-bottom:1rem;">
            <div style="display:flex; justify-content:space-between;">
              <strong>${escapeHtml(t.subject)} — ${escapeHtml(t.name)} (${escapeHtml(t.tracking_code)})</strong>
              <span class="badge ${t.status === 'answered' ? 'badge-green' : 'badge-amber'}">${statusLabel(t.status)}</span>
            </div>
            <div class="thread-box">
              ${(t.messages || [])
                .map(
                  (m) => `
                <div class="chat-bubble ${m.sender_role === 'patient' ? 'patient' : 'staff'}">
                  <div style="font-size:0.75rem; font-weight:700;">${escapeHtml(m.sender_name)}</div>
                  <div>${escapeHtml(m.message)}</div>
                </div>
              `
                )
                .join('')}
            </div>
            <form class="support-reply-form" data-tid="${t.id}" style="display:flex; gap:0.5rem; margin-top:0.75rem;">
              <input type="text" class="form-input" name="reply_text" required placeholder="پاسخ واحد پشتیبانی..." />
              <button type="submit" class="btn btn-primary btn-sm">ارسال پاسخ</button>
            </form>
          </div>
        `
          )
          .join('')}
      `;
    } else if (tab === 'services') {
      adminContentHtml = `
        <div class="card-3d" style="margin-bottom:1.75rem;">
          <h2 style="font-size:1.2rem; margin-bottom:1rem;">افزودن یا ویرایش خدمت دندان‌پزشکی</h2>
          <form id="admin-service-form">
            <input type="hidden" id="adm-srv-id" value="" />
            <div class="form-grid">
              <div class="form-group">
                <label class="form-label" for="adm-srv-title">عنوان خدمت *</label>
                <input id="adm-srv-title" class="form-input" type="text" required placeholder="مانند: جرم‌گیری و بروساژ اولتراسونیک" />
              </div>
              <div class="form-group">
                <label class="form-label" for="adm-srv-cat">دسته‌بندی *</label>
                <input id="adm-srv-cat" class="form-input" type="text" required value="زیبایی و پیشگیری" />
              </div>
            </div>
            <div class="form-grid">
              <div class="form-group">
                <label class="form-label" for="adm-srv-dur">مدت جلسه (دقیقه) *</label>
                <input id="adm-srv-dur" class="form-input" type="number" min="15" max="180" step="15" required value="45" />
              </div>
              <div class="form-group">
                <label class="form-label" for="adm-srv-price">هزینه نمونه (تومان) *</label>
                <input id="adm-srv-price" class="form-input" type="text" required placeholder="مانند: ۲,۵۰۰,۰۰۰ تا ۳,۲۰۰,۰۰۰ تومان (نمونه)" />
              </div>
            </div>
            <div class="form-group">
              <label class="form-label" for="adm-srv-model">مدل سه‌بعدی نمایشی</label>
              <select id="adm-srv-model" class="form-select">
                <option value="implant">ایمپلنت دیجیتال تیتانیومی</option>
                <option value="laminate">لمینت سرامیکی و طراحی لبخند</option>
                <option value="ortho">ارتودنسی شفاف</option>
                <option value="endo">درمان ریشه میکروسکوپی</option>
                <option value="bleaching">سفیدکردن دندان (بلیچینگ)</option>
                <option value="pediatric">دندان‌پزشکی کودکان</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label" for="adm-srv-desc">معرفی کوتاه و قابل فهم *</label>
              <textarea id="adm-srv-desc" class="form-textarea" required placeholder="توضیح روشن خدمت برای نمایش در سایت عمومی..."></textarea>
            </div>
            <button type="submit" class="btn btn-primary">ذخیره خدمت و اعمال در سایت عمومی</button>
          </form>
        </div>

        <h3 style="font-size:1.15rem; margin-bottom:1rem;">خدمات فعلی مطب (برای ویرایش کلیک کنید)</h3>
        <div class="cards-grid-2">
          ${(ad.services || [])
            .map(
              (s) => `
            <div class="card-3d">
              <div>
                <strong>${escapeHtml(s.title)}</strong>
                <p style="font-size:0.85rem; color:var(--ink-600); margin:0.35rem 0;">مدت: ${toFa(s.duration_min)} دقیقه | هزینه: ${escapeHtml(s.price_sample)}</p>
              </div>
              <button type="button" class="btn btn-outline btn-sm" data-action="admin-edit-service" data-id="${s.id}">بارگذاری در فرم ویرایش بالا</button>
            </div>
          `
            )
            .join('')}
        </div>
      `;
    } else if (tab === 'doctors') {
      adminContentHtml = `
        <div class="card-3d" style="margin-bottom:1.75rem;">
          <h2 style="font-size:1.2rem; margin-bottom:1rem;">مدیریت پزشکان، تخصص و برنامه حضور هفتگی</h2>
          <form id="admin-doctor-form">
            <input type="hidden" id="adm-doc-id" value="" />
            <div class="form-grid">
              <div class="form-group">
                <label class="form-label" for="adm-doc-name">نام دندان‌پزشک *</label>
                <input id="adm-doc-name" class="form-input" type="text" required placeholder="مانند: دکتر پارسا علوی" />
              </div>
              <div class="form-group">
                <label class="form-label" for="adm-doc-spec">تخصص *</label>
                <input id="adm-doc-spec" class="form-input" type="text" required placeholder="مانند: متخصص پروتزهای دندانی و ایمپلنت" />
              </div>
            </div>
            <div class="form-group">
              <label class="form-label" for="adm-doc-code">کد نظام پزشکی (با قید نمونه آزمایشی) *</label>
              <input id="adm-doc-code" class="form-input" type="text" required value="کد نظام پزشکی نمونه: ۱۸۴۲۱۰ (داده آزمایشی)" />
            </div>
            <div class="form-group">
              <label class="form-label" for="adm-doc-bio">معرفی کوتاه حرفه‌ای *</label>
              <textarea id="adm-doc-bio" class="form-textarea" required placeholder="معرفی کوتاه پزشک..."></textarea>
            </div>
            <button type="submit" class="btn btn-primary">ذخیره اطلاعات پزشک در سایت</button>
          </form>
        </div>

        <div class="cards-grid-2">
          ${(ad.doctors || [])
            .map(
              (d) => `
            <div class="card-3d">
              <div>
                <strong>${escapeHtml(d.name)}</strong>
                <p style="font-size:0.86rem; color:var(--green-800); font-weight:700;">${escapeHtml(d.specialty)}</p>
                <p style="font-size:0.82rem; color:var(--ink-600); margin:0.35rem 0;">${escapeHtml(d.bio)}</p>
              </div>
              <button type="button" class="btn btn-outline btn-sm" data-action="admin-edit-doctor" data-id="${d.id}">ویرایش اطلاعات این پزشک</button>
            </div>
          `
            )
            .join('')}
        </div>
      `;
    } else if (tab === 'schedule') {
      adminContentHtml = `
        <div class="cards-grid-2">
          <div class="card-3d">
            <h2 style="font-size:1.18rem; margin-bottom:1rem;">تنظیم قوانین لغو، جابه‌جایی و فاصله بین نوبت‌ها</h2>
            <form id="admin-rules-form">
              <div class="form-group">
                <label class="form-label" for="rule-buffer">فاصله ضدعفونی و تنفس بین دو نوبت (دقیقه)</label>
                <input id="rule-buffer" class="form-input" type="number" min="0" max="60" value="${rules.buffer_minutes ?? 15}" />
              </div>
              <div class="form-group">
                <label class="form-label" for="rule-cancel-hrs">حداقل فاصله زمانی مجاز برای لغو نوبت توسط مراجع (ساعت)</label>
                <input id="rule-cancel-hrs" class="form-input" type="number" min="1" max="72" value="${rules.min_hours_before_cancel || 12}" />
              </div>
              <div class="form-group">
                <label class="form-label" for="rule-resched-hrs">حداقل فاصله زمانی مجاز برای جابه‌جایی نوبت (ساعت)</label>
                <input id="rule-resched-hrs" class="form-input" type="number" min="1" max="72" value="${rules.min_hours_before_reschedule || 6}" />
              </div>
              <div class="form-group">
                <label class="form-label" for="rule-policy-text">متن قانون نمایش‌داده‌شده به مراجع</label>
                <textarea id="rule-policy-text" class="form-textarea">${escapeHtml(rules.policy_text || '')}</textarea>
              </div>
              <button type="submit" class="btn btn-primary" style="width:100%;">ذخیره قوانین نوبت‌دهی</button>
            </form>
          </div>

          <div class="card-3d">
            <h2 style="font-size:1.18rem; margin-bottom:1rem;">ثبت تعطیلی جدید یا مسدودسازی ساعت خاص</h2>
            <form id="admin-block-form" style="margin-bottom:1.5rem;">
              <div class="form-group">
                <label class="form-label" for="blk-date">تاریخ شمسی (مانند 1405/07/26)</label>
                <input id="blk-date" class="form-input" type="text" required value="${escapeHtml(state.today_jalali)}" />
              </div>
              <div class="form-grid">
                <div class="form-group">
                  <label class="form-label" for="blk-start">از ساعت</label>
                  <input id="blk-start" class="form-input" type="text" value="13:00" />
                </div>
                <div class="form-group">
                  <label class="form-label" for="blk-end">تا ساعت</label>
                  <input id="blk-end" class="form-input" type="text" value="14:30" />
                </div>
              </div>
              <div class="form-group">
                <label class="form-label" for="blk-reason">علت مسدودسازی</label>
                <input id="blk-reason" class="form-input" type="text" value="ضدعفونی دوره‌ای و جلسه داخلی مطب" />
              </div>
              <button type="submit" class="btn btn-coral" style="width:100%;">افزودن به بازه‌های مسدودشده</button>
            </form>

            <h3 style="font-size:1rem; margin-bottom:0.5rem;">بازه‌های مسدودشده فعلی:</h3>
            ${blocked
              .map(
                (b, idx) => `
              <div style="display:flex; justify-content:space-between; align-items:center; background:var(--bg-page); padding:0.55rem 0.75rem; border-radius:var(--radius-sm); margin-bottom:0.4rem; font-size:0.84rem;">
                <span>${toFa(b.jalali_date)} (${toFa(b.start_time)} تا ${toFa(b.end_time)}) — ${escapeHtml(b.reason)}</span>
                <button type="button" class="btn btn-outline btn-sm" data-action="admin-remove-block" data-idx="${idx}">حذف</button>
              </div>
            `
              )
              .join('')}
          </div>
        </div>
      `;
    } else if (tab === 'content') {
      adminContentHtml = `
        <div class="card-3d" style="margin-bottom:1.75rem;">
          <h2 style="font-size:1.2rem; margin-bottom:1rem;">ویرایش متن‌های اصلی سایت، اطلاعات تماس و پیش‌نمایش زنده</h2>
          <form id="admin-content-form">
            <div class="form-grid">
              <div class="form-group">
                <label class="form-label" for="cnt-name">نام مطب</label>
                <input id="cnt-name" class="form-input" type="text" value="${escapeHtml(info.name || '')}" />
              </div>
              <div class="form-group">
                <label class="form-label" for="cnt-phone">تلفن اصلی پذیرش</label>
                <input id="cnt-phone" class="form-input" type="text" value="${escapeHtml(info.phone_primary || '')}" />
              </div>
            </div>
            <div class="form-group">
              <label class="form-label" for="cnt-hero-title">عنوان اصلی ویترین سه‌بعدی (Hero Title)</label>
              <input id="cnt-hero-title" class="form-input" type="text" value="${escapeHtml(info.hero_title || '')}" />
            </div>
            <div class="form-group">
              <label class="form-label" for="cnt-hero-sub">زیرعنوان معرفی مطب</label>
              <textarea id="cnt-hero-sub" class="form-textarea">${escapeHtml(info.hero_subtitle || '')}</textarea>
            </div>
            <div class="form-group">
              <label class="form-label" for="cnt-address">نشانی مطب</label>
              <input id="cnt-address" class="form-input" type="text" value="${escapeHtml(info.address || '')}" />
            </div>
            <div class="form-group">
              <label class="form-label" for="cnt-hours">متن ساعات کاری و زمان پاسخگویی</label>
              <input id="cnt-hours" class="form-input" type="text" value="${escapeHtml(info.working_hours_text || '')}" />
            </div>
            <button type="submit" class="btn btn-primary">ذخیره و انتشار آنی در سایت عمومی</button>
          </form>
        </div>
      `;
    } else if (tab === 'trash') {
      adminContentHtml = `
        <div class="card-3d">
          <h2 style="font-size:1.2rem; margin-bottom:0.75rem;">سطل بازیابی عملیات حساس (Undo / Restore)</h2>
          <p style="font-size:0.9rem; color:var(--ink-600); margin-bottom:1.25rem;">هرگونه تغییر وضعیت نوبت، تغییر تنظیمات یا حذف پرسش متداول در این بخش نگهداری می‌شود تا در صورت نیاز با یک کلیک به حالت قبل بازگردد.</p>
          ${
            (ad.trash || []).length === 0
              ? `<p style="color:var(--ink-600);">موردی در سطل بازیابی وجود ندارد.</p>`
              : (ad.trash || [])
                  .map(
                    (tr) => `
                  <div style="display:flex; justify-content:space-between; align-items:center; padding:0.85rem; background:var(--bg-page); border:1px solid var(--border-subtle); border-radius:var(--radius-sm); margin-bottom:0.6rem;">
                    <div>
                      <strong>${escapeHtml(tr.title)}</strong>
                      <div style="font-size:0.78rem; color:var(--ink-600);">توسط: ${escapeHtml(tr.deleted_by)}</div>
                    </div>
                    <button type="button" class="btn btn-primary btn-sm" data-action="admin-restore-trash" data-id="${tr.id}">بازیابی به وضعیت قبل</button>
                  </div>
                `
                  )
                  .join('')
          }
        </div>
      `;
    }

    return `
      <section class="section-block">
        <div class="container">
          <div class="section-header">
            <div>
              <span class="section-eyebrow">پنل مدیریت صاحب مطب (بدون نیاز به دانش فنی)</span>
              <h1 class="section-title">مدیریت یکپارچه مطب دندان‌پزشکی آویدا</h1>
            </div>
            <div style="display:flex; gap:0.65rem;">
              <button type="button" class="btn btn-outline btn-sm" data-route="/">مشاهده سایت عمومی</button>
              <button type="button" class="btn btn-coral btn-sm" data-action="logout">خروج</button>
            </div>
          </div>

          <div class="stat-cards-row">
            <div class="stat-box">
              <div class="stat-box-num">${toFa(st.active_appointments || 0)}</div>
              <div style="font-size:0.85rem; color:var(--ink-600);">نوبت‌های فعال و تأییدشده</div>
            </div>
            <div class="stat-box">
              <div class="stat-box-num">${toFa(st.today_appointments || 0)}</div>
              <div style="font-size:0.85rem; color:var(--ink-600);">نوبت‌های امروز مطب</div>
            </div>
            <div class="stat-box">
              <div class="stat-box-num" style="color:var(--coral-600);">${toFa(st.pending_consultations || 0)}</div>
              <div style="font-size:0.85rem; color:var(--ink-600);">مشاوره در انتظار پاسخ</div>
            </div>
            <div class="stat-box">
              <div class="stat-box-num">${toFa(st.pending_tickets || 0)}</div>
              <div style="font-size:0.85rem; color:var(--ink-600);">تیکت پشتیبانی باز</div>
            </div>
          </div>

          <div class="portal-layout">
            <aside class="portal-sidebar" aria-label="منوی پنل مدیریت">
              <button type="button" class="portal-nav-btn ${tab === 'overview' ? 'active' : ''}" data-action="admin-tab" data-tab="overview">مدیریت نوبت‌ها</button>
              <button type="button" class="portal-nav-btn ${tab === 'consultations' ? 'active' : ''}" data-action="admin-tab" data-tab="consultations">مشاوره‌ها و پشتیبانی</button>
              <button type="button" class="portal-nav-btn ${tab === 'services' ? 'active' : ''}" data-action="admin-tab" data-tab="services">خدمات و هزینه‌ها</button>
              <button type="button" class="portal-nav-btn ${tab === 'doctors' ? 'active' : ''}" data-action="admin-tab" data-tab="doctors">پزشکان و برنامه حضور</button>
              <button type="button" class="portal-nav-btn ${tab === 'schedule' ? 'active' : ''}" data-action="admin-tab" data-tab="schedule">ساعت کاری، تعطیلات و قوانین</button>
              <button type="button" class="portal-nav-btn ${tab === 'content' ? 'active' : ''}" data-action="admin-tab" data-tab="content">ویرایش متن‌ها و تماس</button>
              <button type="button" class="portal-nav-btn ${tab === 'trash' ? 'active' : ''}" data-action="admin-tab" data-tab="trash">سطل بازیابی (${toFa((ad.trash || []).length)})</button>
            </aside>
            <div>
              ${adminContentHtml}
            </div>
          </div>
        </div>
      </section>
    `;
  }

  // -------------------------------------------------------------------------
  // ۱۰. مودال جابه‌جایی نوبت (Reschedule Modal)
  // -------------------------------------------------------------------------
  function renderModals() {
    if (!state.rescheduleModal) return '';
    const ap = state.rescheduleModal.appointment;
    const slots = (state.rescheduleModal.slotsData && state.rescheduleModal.slotsData.slots) || [];
    const availSlots = slots.filter((s) => s.status === 'available');
    const availableDays = getRescheduleDays(ap);

    return `
      <div class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="resched-modal-title">
        <div class="modal-card">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1rem;">
            <h2 id="resched-modal-title" style="font-size:1.25rem;">جابه‌جایی زمان نوبت (${escapeHtml(ap.tracking_code)})</h2>
            <button type="button" class="btn btn-outline btn-sm" data-action="close-modal">بستن ×</button>
          </div>
          <p style="font-size:0.9rem; color:var(--ink-600); margin-bottom:1rem;">
            نوبت فعلی: <strong>${escapeHtml(ap.human_date)} ساعت ${toFa(ap.start_time)}</strong> | پزشک: <strong>${escapeHtml(ap.doctor_name)}</strong>
          </p>
          <form id="reschedule-submit-form" data-appt-id="${ap.id}">
            <div class="form-group">
              <label class="form-label" for="resched-date-select">۱. انتخاب تاریخ شمسی جدید</label>
              <select id="resched-date-select" class="form-select" ${availableDays.length ? '' : 'disabled'}>
                ${availableDays
                  .map(
                    (d) => `
                  <option value="${escapeHtml(d.jalali_date)}" ${d.jalali_date === state.rescheduleModal.selectedDate ? 'selected' : ''}>
                    ${escapeHtml(d.human)}
                  </option>
                `
                  )
                  .join('')}
              </select>
            </div>
            <div class="form-group">
              <label class="form-label" for="resched-time-select">۲. انتخاب ساعت آزاد در این روز</label>
              ${
                availSlots.length === 0
                  ? `<div style="color:var(--coral-700); font-weight:700; padding:0.5rem 0;">${availableDays.length ? 'در این تاریخ ساعت آزادی برای این پزشک وجود ندارد. لطفاً روز دیگری را انتخاب کنید.' : 'برای این پزشک در روزهای آینده برنامه حضوری ثبت نشده است. لطفاً با مطب تماس بگیرید.'}</div>`
                  : `<select id="resched-time-select" class="form-select" required>
                      ${availSlots
                        .map(
                          (s) => `<option value="${escapeHtml(s.start_time)}">ساعت ${escapeHtml(s.start_time_fa)} تا ${escapeHtml(s.end_time_fa)}</option>`
                        )
                        .join('')}
                    </select>`
              }
            </div>
            <div style="display:flex; gap:0.65rem; margin-top:1.25rem;">
              <button type="submit" class="btn btn-primary" style="flex:1;" ${availSlots.length === 0 ? 'disabled' : ''}>تأیید و ثبت جابه‌جایی نوبت</button>
              <button type="button" class="btn btn-outline" data-action="close-modal">انصراف</button>
            </div>
          </form>
        </div>
      </div>
    `;
  }

  // -------------------------------------------------------------------------
  // رندر کل برنامه و اتصال رویدادها
  // -------------------------------------------------------------------------
  function renderApp() {
    const root = document.getElementById('app-root');
    if (!root) return;

    if (state.hero3dInstance) {
      state.hero3dInstance.destroy();
      state.hero3dInstance = null;
    }
    if (state.celebrationCleanup) {
      state.celebrationCleanup();
      state.celebrationCleanup = null;
    }
    if (window.AvidaImmersive) window.AvidaImmersive.cleanup();
    const focusedId = state.rescheduleModal && document.activeElement ? document.activeElement.id : '';

    const r = state.route;
    let pageHtml = '';
    if (r === '/') {
      pageHtml = renderHomePage();
    } else if (r === '/services') {
      pageHtml = renderServicesPage(null);
    } else if (r.startsWith('/services/')) {
      pageHtml = renderServicesPage(r.replace('/services/', ''));
    } else if (r === '/doctors') {
      pageHtml = renderDoctorsPage();
    } else if (r === '/booking') {
      pageHtml = renderBookingPage();
    } else if (r === '/consultation') {
      pageHtml = renderConsultationPage();
    } else if (r === '/contact') {
      pageHtml = renderContactPage();
    } else if (r === '/auth') {
      pageHtml = renderAuthPage();
    } else if (r === '/dashboard') {
      pageHtml = renderDashboardPage();
    } else if (r === '/admin') {
      pageHtml = renderAdminPage();
    } else {
      pageHtml = renderHomePage();
    }

    root.innerHTML = `
      ${renderHeader()}
      <main id="main-content" tabindex="-1">
        ${pageHtml}
      </main>
      ${renderModals()}
      ${renderFooter()}
    `;

    // راه‌اندازی صحنه سه‌بعدی در صفحه اصلی
    const heroCanvas = document.getElementById('hero-3d-canvas');
    if (heroCanvas && window.Avida3D) {
      state.hero3dInstance = new window.Avida3D.AvidaHero3D(heroCanvas);
    }

    // راه‌اندازی جشن سه‌بعدی در گام ۵ رزرو نوبت
    const celebCanvas = document.getElementById('booking-celebration-canvas');
    if (celebCanvas && window.Avida3D) {
      state.celebrationCleanup = window.Avida3D.playBookingCelebration3D(celebCanvas);
    }

    // فعال‌سازی عمق سه‌بعدی کارت‌ها
    if (window.Avida3D) {
      window.Avida3D.attach3DCards(root);
    }

    bindDynamicForms();
    if (window.AvidaImmersive) {
      window.AvidaImmersive.initImmersiveEffects(root, state.hero3dInstance);
    }
    root.querySelectorAll('a[data-route]').forEach((link) => { link.href = routeToHref(link.dataset.route); });
    if (state.rescheduleModal) {
      root.querySelectorAll('.site-header, .top-demo-bar, main, .site-footer').forEach((el) => { el.inert = true; });
      const focusTarget = (focusedId && document.getElementById(focusedId)) || root.querySelector('.modal-backdrop button');
      if (focusTarget) focusTarget.focus({ preventScroll: true });
    }
  }

  function bindDynamicForms() {
    // منوی موبایل
    const mobBtn = document.getElementById('mobile-menu-toggle');
    const navMenu = document.getElementById('main-nav-menu');
    if (mobBtn && navMenu) {
      mobBtn.onclick = () => {
        const isOpen = navMenu.classList.toggle('open');
        mobBtn.setAttribute('aria-expanded', String(isOpen));
        mobBtn.setAttribute('aria-label', isOpen ? 'بستن منوی موبایل' : 'باز کردن منوی موبایل');
      };
    }

    // دکمه توقف/پخش صحنه سه‌بعدی
    const pauseBtn = document.getElementById('hero-3d-pause-btn');
    if (pauseBtn && state.hero3dInstance) {
      pauseBtn.onclick = () => {
        const isPaused = state.hero3dInstance.togglePause();
        pauseBtn.textContent = isPaused ? 'پخش حرکت سه‌بعدی' : 'توقف حرکت سه‌بعدی';
      };
    }

    // فرم ثبت نهایی نوبت در گام ۴
    const bkForm = document.getElementById('booking-confirm-form');
    if (bkForm) {
      bkForm.oninput = () => {
        state.wizard.patient_name = document.getElementById('bk-patient-name').value.trim();
        state.wizard.patient_phone = toEn(document.getElementById('bk-patient-phone').value.trim());
        state.wizard.notes = document.getElementById('bk-notes').value.trim();
        saveWizardState();
      };
      bkForm.onsubmit = async (e) => {
        e.preventDefault();
        if (!state.user) {
          sessionStorage.setItem(AUTH_RETURN_KEY, '/booking');
          await navigateTo('/auth');
          return;
        }
        state.wizard.patient_name = document.getElementById('bk-patient-name').value.trim();
        state.wizard.patient_phone = toEn(document.getElementById('bk-patient-phone').value.trim());
        state.wizard.notes = document.getElementById('bk-notes').value.trim();
        saveWizardState();

        try {
          const res = await apiFetch('/api/appointments', {
            method: 'POST',
            body: JSON.stringify({
              service_id: state.wizard.service_id,
              doctor_id: state.wizard.doctor_id,
              jalali_date: state.wizard.jalali_date,
              start_time: state.wizard.start_time,
              patient_name: state.wizard.patient_name,
              patient_phone: state.wizard.patient_phone,
              notes: state.wizard.notes,
            }),
          });
          state.wizard.completedAppointment = res.appointment;
          state.wizard.conflictAlternatives = null;
          state.wizard.conflictMessage = '';
          state.wizard.step = 5;
          saveWizardState();
          showToast(res.message);
          renderApp();
        } catch (err) {
          if (err.status === 409 && err.payload) {
            state.wizard.conflictMessage = err.payload.error;
            state.wizard.conflictAlternatives = err.payload.alternatives || [];
            if (!state.wizard.conflictAlternatives.length) {
              state.wizard.step = 3;
              state.wizard.start_time = '';
              await loadSlotsForWizard();
            }
            saveWizardState();
            showToast(err.payload.error, 'error');
            renderApp();
          } else {
            showToast(err.message, 'error');
          }
        }
      };
    }

    // فرم‌های احراز هویت
    const loginForm = document.getElementById('auth-login-form');
    if (loginForm) {
      loginForm.onsubmit = async (e) => {
        e.preventDefault();
        const identifier = document.getElementById('login-identifier').value.trim();
        const password = document.getElementById('login-password').value;
        try {
          const res = await apiFetch('/api/auth/login', {
            method: 'POST',
            body: JSON.stringify({ identifier, password }),
          });
          await finishAuthentication(res);
        } catch (err) {
          showToast(err.message, 'error');
        }
      };
    }

    const regForm = document.getElementById('auth-register-form');
    if (regForm) {
      regForm.onsubmit = async (e) => {
        e.preventDefault();
        const name = document.getElementById('reg-name').value.trim();
        const identifier = document.getElementById('reg-identifier').value.trim();
        const password = document.getElementById('reg-password').value;
        try {
          const res = await apiFetch('/api/auth/register', {
            method: 'POST',
            body: JSON.stringify({ name, identifier, password }),
          });
          await finishAuthentication(res);
        } catch (err) {
          showToast(err.message, 'error');
        }
      };
    }

    const recReqForm = document.getElementById('auth-recover-request-form');
    if (recReqForm) {
      recReqForm.onsubmit = async (e) => {
        e.preventDefault();
        const identifier = document.getElementById('rec-identifier').value.trim();
        try {
          const res = await apiFetch('/api/auth/recover-request', {
            method: 'POST',
            body: JSON.stringify({ identifier }),
          });
          state.recoveryIdentifier = identifier;
          state.recoveryDemoCode = res.demo_code;
          showToast(res.message);
          renderApp();
        } catch (err) {
          showToast(err.message, 'error');
        }
      };
    }

    const recConfForm = document.getElementById('auth-recover-confirm-form');
    if (recConfForm) {
      recConfForm.onsubmit = async (e) => {
        e.preventDefault();
        const code = document.getElementById('rec-code').value.trim();
        const new_password = document.getElementById('rec-new-pass').value;
        try {
          const res = await apiFetch('/api/auth/recover-confirm', {
            method: 'POST',
            body: JSON.stringify({
              identifier: state.recoveryIdentifier,
              code,
              new_password,
            }),
          });
          state.recoveryDemoCode = null;
          state.authTab = 'login';
          showToast(res.message);
          renderApp();
        } catch (err) {
          showToast(err.message, 'error');
        }
      };
    }

    // فرم ثبت مشاوره جدید
    const cnsForm = document.getElementById('new-consultation-form');
    if (cnsForm) {
      cnsForm.onsubmit = async (e) => {
        e.preventDefault();
        try {
          const res = await apiFetch('/api/consultations', {
            method: 'POST',
            body: JSON.stringify({
              service_id: Number(document.getElementById('cns-service').value),
              doctor_id: Number(document.getElementById('cns-doctor').value),
              urgency: document.getElementById('cns-urgency').value,
              subject: document.getElementById('cns-subject').value.trim(),
              message: document.getElementById('cns-message').value.trim(),
            }),
          });
          showToast(res.message);
          await loadDashboardData();
          renderApp();
        } catch (err) {
          showToast(err.message, 'error');
        }
      };
    }

    // فرم پاسخ به مشاوره
    document.querySelectorAll('.consult-reply-form').forEach((f) => {
      f.onsubmit = async (e) => {
        e.preventDefault();
        const cid = Number(f.dataset.cid);
        const msgInput = f.querySelector('input[name="reply_text"]');
        const stSelect = f.querySelector('select[name="status"]');
        try {
          const res = await apiFetch('/api/consultations/reply', {
            method: 'POST',
            body: JSON.stringify({
              consultation_id: cid,
              message: msgInput.value.trim(),
              status: stSelect ? stSelect.value : undefined,
            }),
          });
          showToast(res.message);
          if (state.route === '/admin') await loadAdminData();
          else await loadDashboardData();
          renderApp();
        } catch (err) {
          showToast(err.message, 'error');
        }
      };
    });

    // فرم ثبت تیکت پشتیبانی
    const supForm = document.getElementById('support-ticket-form');
    if (supForm) {
      supForm.onsubmit = async (e) => {
        e.preventDefault();
        try {
          const res = await apiFetch('/api/support', {
            method: 'POST',
            body: JSON.stringify({
              name: document.getElementById('sup-name').value.trim(),
              contact: document.getElementById('sup-contact').value.trim(),
              category: document.getElementById('sup-category').value,
              subject: document.getElementById('sup-subject').value.trim(),
              message: document.getElementById('sup-message').value.trim(),
            }),
          });
          showToast(`${res.message} (کد پیگیری: ${res.tracking_code})`);
          if (state.user) await loadDashboardData();
          renderApp();
        } catch (err) {
          showToast(err.message, 'error');
        }
      };
    }

    // فرم پاسخ به تیکت پشتیبانی
    document.querySelectorAll('.support-reply-form').forEach((f) => {
      f.onsubmit = async (e) => {
        e.preventDefault();
        const tid = Number(f.dataset.tid);
        const msgInput = f.querySelector('input[name="reply_text"]');
        try {
          const res = await apiFetch('/api/support/reply', {
            method: 'POST',
            body: JSON.stringify({
              ticket_id: tid,
              message: msgInput.value.trim(),
            }),
          });
          showToast(res.message);
          if (state.route === '/admin') await loadAdminData();
          else await loadDashboardData();
          renderApp();
        } catch (err) {
          showToast(err.message, 'error');
        }
      };
    });

    // فرم ویرایش پروفایل
    const profForm = document.getElementById('profile-update-form');
    if (profForm) {
      profForm.onsubmit = async (e) => {
        e.preventDefault();
        try {
          const res = await apiFetch('/api/profile/update', {
            method: 'POST',
            body: JSON.stringify({
              name: document.getElementById('prof-name').value.trim(),
              email: document.getElementById('prof-email').value.trim(),
              new_password: document.getElementById('prof-pass').value,
            }),
          });
          state.user = res.user;
          localStorage.setItem(AUTH_USER_KEY, JSON.stringify(res.user));
          showToast(res.message);
          renderApp();
        } catch (err) {
          showToast(err.message, 'error');
        }
      };
    }

    // جست‌وجوی نوبت‌ها در پنل مدیریت
    const apptSearch = document.getElementById('admin-appt-search');
    if (apptSearch) {
      apptSearch.oninput = () => {
        const q = apptSearch.value.trim().toLowerCase();
        document.querySelectorAll('.admin-appt-item').forEach((el) => {
          const hay = (el.dataset.search || '').toLowerCase();
          el.style.display = !q || hay.includes(q) ? '' : 'none';
        });
      };
    }

    // فرم افزودن/ویرایش خدمت در پنل مدیریت
    const admSrvForm = document.getElementById('admin-service-form');
    if (admSrvForm) {
      admSrvForm.onsubmit = async (e) => {
        e.preventDefault();
        try {
          const existing = state.services.find((s) => Number(s.id) === Number(document.getElementById('adm-srv-id').value));
          const res = await apiFetch('/api/admin/service/save', {
            method: 'POST',
            body: JSON.stringify({
              id: document.getElementById('adm-srv-id').value || null,
              title: document.getElementById('adm-srv-title').value.trim(),
              category: document.getElementById('adm-srv-cat').value.trim(),
              duration_min: Number(document.getElementById('adm-srv-dur').value),
              price_sample: document.getElementById('adm-srv-price').value.trim(),
              model_type: document.getElementById('adm-srv-model').value,
              short_desc: document.getElementById('adm-srv-desc').value.trim(),
              full_desc: existing ? existing.full_desc : document.getElementById('adm-srv-desc').value.trim(),
              prep_tips: existing ? existing.prep_tips : undefined,
              aftercare_tips: existing ? existing.aftercare_tips : undefined,
              active: existing ? !!existing.active : true,
            }),
          });
          showToast(res.message);
          await bootstrapApp();
          await loadAdminData();
          renderApp();
        } catch (err) {
          showToast(err.message, 'error');
        }
      };
    }

    // فرم افزودن/ویرایش پزشک در پنل مدیریت
    const admDocForm = document.getElementById('admin-doctor-form');
    if (admDocForm) {
      admDocForm.onsubmit = async (e) => {
        e.preventDefault();
        const defaultSched = {
          '0': { active: true, start: '09:00', end: '17:00' },
          '1': { active: true, start: '09:00', end: '17:00' },
          '2': { active: true, start: '09:00', end: '17:00' },
          '3': { active: true, start: '09:00', end: '17:00' },
          '4': { active: true, start: '09:00', end: '17:00' },
          '5': { active: false, start: '09:00', end: '14:00' },
          '6': { active: false, start: '00:00', end: '00:00' },
        };
        try {
          const existing = state.doctors.find((d) => Number(d.id) === Number(document.getElementById('adm-doc-id').value));
          const res = await apiFetch('/api/admin/doctor/save', {
            method: 'POST',
            body: JSON.stringify({
              id: document.getElementById('adm-doc-id').value || null,
              name: document.getElementById('adm-doc-name').value.trim(),
              specialty: document.getElementById('adm-doc-spec').value.trim(),
              medical_code: document.getElementById('adm-doc-code').value.trim(),
              bio: document.getElementById('adm-doc-bio').value.trim(),
              schedule: existing ? existing.schedule : defaultSched,
              experience_note: existing ? existing.experience_note : undefined,
              avatar_theme: existing ? existing.avatar_theme : undefined,
              active: existing ? !!existing.active : true,
            }),
          });
          showToast(res.message);
          await bootstrapApp();
          await loadAdminData();
          renderApp();
        } catch (err) {
          showToast(err.message, 'error');
        }
      };
    }

    // فرم قوانین نوبت‌دهی در پنل مدیریت
    const admRulesForm = document.getElementById('admin-rules-form');
    if (admRulesForm) {
      admRulesForm.onsubmit = async (e) => {
        e.preventDefault();
        try {
          const newRules = Object.assign({}, state.settings.scheduling_rules || {}, {
            buffer_minutes: Number(document.getElementById('rule-buffer').value),
            min_hours_before_cancel: Number(document.getElementById('rule-cancel-hrs').value),
            min_hours_before_reschedule: Number(document.getElementById('rule-resched-hrs').value),
            policy_text: document.getElementById('rule-policy-text').value.trim(),
          });
          const res = await apiFetch('/api/admin/settings/save', {
            method: 'POST',
            body: JSON.stringify({ key: 'scheduling_rules', value: newRules }),
          });
          showToast(res.message);
          await bootstrapApp();
          await loadAdminData();
          renderApp();
        } catch (err) {
          showToast(err.message, 'error');
        }
      };
    }

    // فرم افزودن بازه مسدودشده در پنل مدیریت
    const admBlockForm = document.getElementById('admin-block-form');
    if (admBlockForm) {
      admBlockForm.onsubmit = async (e) => {
        e.preventDefault();
        try {
          const curBlocked = (state.settings.blocked_slots || []).slice();
          curBlocked.push({
            id: `blk-${Date.now()}`,
            jalali_date: toEn(document.getElementById('blk-date').value.trim()),
            doctor_id: null,
            start_time: toEn(document.getElementById('blk-start').value.trim()),
            end_time: toEn(document.getElementById('blk-end').value.trim()),
            reason: document.getElementById('blk-reason').value.trim(),
          });
          const res = await apiFetch('/api/admin/settings/save', {
            method: 'POST',
            body: JSON.stringify({ key: 'blocked_slots', value: curBlocked }),
          });
          showToast(res.message);
          await bootstrapApp();
          await loadAdminData();
          renderApp();
        } catch (err) {
          showToast(err.message, 'error');
        }
      };
    }

    // فرم ویرایش متن‌های سایت در پنل مدیریت
    const admContentForm = document.getElementById('admin-content-form');
    if (admContentForm) {
      admContentForm.onsubmit = async (e) => {
        e.preventDefault();
        try {
          const newInfo = Object.assign({}, state.settings.clinic_info || {}, {
            name: document.getElementById('cnt-name').value.trim(),
            phone_primary: document.getElementById('cnt-phone').value.trim(),
            hero_title: document.getElementById('cnt-hero-title').value.trim(),
            hero_subtitle: document.getElementById('cnt-hero-sub').value.trim(),
            address: document.getElementById('cnt-address').value.trim(),
            working_hours_text: document.getElementById('cnt-hours').value.trim(),
          });
          const res = await apiFetch('/api/admin/settings/save', {
            method: 'POST',
            body: JSON.stringify({ key: 'clinic_info', value: newInfo }),
          });
          showToast(res.message);
          await bootstrapApp();
          await loadAdminData();
          renderApp();
        } catch (err) {
          showToast(err.message, 'error');
        }
      };
    }

    // مودال جابه‌جایی نوبت
    const reschedDateSel = document.getElementById('resched-date-select');
    if (reschedDateSel && state.rescheduleModal) {
      reschedDateSel.onchange = async () => {
        const newDate = reschedDateSel.value;
        state.rescheduleModal.selectedDate = newDate;
        const ap = state.rescheduleModal.appointment;
        try {
          const slotsData = await loadRescheduleSlots(ap, newDate);
          if (!state.rescheduleModal || state.rescheduleModal.selectedDate !== newDate) return;
          state.rescheduleModal.slotsData = slotsData;
        } catch (err) {
          if (state.rescheduleModal) state.rescheduleModal.slotsData = { slots: [] };
          showToast(err.message, 'error');
        }
        renderApp();
      };
    }

    const reschedForm = document.getElementById('reschedule-submit-form');
    if (reschedForm && state.rescheduleModal) {
      reschedForm.onsubmit = async (e) => {
        e.preventDefault();
        const apptId = Number(reschedForm.dataset.apptId);
        const newDate = document.getElementById('resched-date-select').value;
        const newTime = document.getElementById('resched-time-select').value;
        try {
          const res = await apiFetch('/api/appointments/reschedule', {
            method: 'POST',
            body: JSON.stringify({
              appointment_id: apptId,
              new_jalali_date: newDate,
              new_start_time: newTime,
            }),
          });
          state.rescheduleModal = null;
          showToast(res.message);
          if (state.route === '/admin') await loadAdminData();
          else await loadDashboardData();
          renderApp();
        } catch (err) {
          showToast(err.message, 'error');
        }
      };
    }
    document.querySelectorAll('form').forEach((form) => {
      const submit = form.onsubmit;
      if (!submit) return;
      form.onsubmit = async (event) => {
        event.preventDefault();
        if (form.dataset.submitting === 'true') return;
        form.dataset.submitting = 'true';
        form.setAttribute('aria-busy', 'true');
        const buttons = Array.from(form.querySelectorAll('button[type="submit"]'));
        const previousDisabled = buttons.map((button) => button.disabled);
        buttons.forEach((button) => { button.disabled = true; });
        try { await submit.call(form, event); }
        finally {
          form.dataset.submitting = 'false';
          form.removeAttribute('aria-busy');
          buttons.forEach((button, index) => { button.disabled = previousDisabled[index]; });
        }
      };
    });
  }

  // -------------------------------------------------------------------------
  // مدیریت متمرکز کلیک‌ها (Event Delegation)
  // -------------------------------------------------------------------------
  document.addEventListener('click', async (e) => {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    try {
    const routeEl = e.target.closest('[data-route]');
    if (routeEl) {
      e.preventDefault();
      const targetRoute = routeEl.getAttribute('data-route');
      await navigateTo(targetRoute, true);
      return;
    }

    const modeEl = e.target.closest('[data-3d-mode]');
    if (modeEl && state.hero3dInstance) {
      const m = modeEl.getAttribute('data-3d-mode');
      document.querySelectorAll('[data-3d-mode]').forEach((b) => b.classList.remove('active'));
      modeEl.classList.add('active');
      state.hero3dInstance.setMode(m);
      return;
    }

    const actEl = e.target.closest('[data-action]');
    if (!actEl) return;
    if (actEl.disabled) return;
    const action = actEl.getAttribute('data-action');

    if (action === 'book-service') {
      resetBookingSelection();
      state.wizard.service_id = Number(actEl.dataset.serviceId);
      state.wizard.step = 2;
      saveWizardState();
      await navigateTo('/booking');
    } else if (action === 'book-doctor') {
      resetBookingSelection();
      state.wizard.doctor_id = Number(actEl.dataset.doctorId);
      state.wizard.step = 3;
      saveWizardState();
      await navigateTo('/booking');
    } else if (action === 'wizard-pick-service') {
      resetBookingSelection();
      state.wizard.service_id = Number(actEl.dataset.serviceId);
      state.wizard.step = 2;
      saveWizardState();
      renderApp();
    } else if (action === 'wizard-pick-doctor') {
      resetBookingSelection();
      state.wizard.doctor_id = Number(actEl.dataset.doctorId);
      state.wizard.step = 3;
      saveWizardState();
      await loadSlotsForWizard();
      renderApp();
    } else if (action === 'wizard-pick-date') {
      resetBookingSelection();
      state.wizard.jalali_date = actEl.dataset.date;
      state.wizard.start_time = '';
      saveWizardState();
      await loadSlotsForWizard();
      renderApp();
    } else if (action === 'wizard-pick-slot') {
      state.wizard.start_time = actEl.dataset.start;
      state.wizard.conflictAlternatives = null;
      state.wizard.conflictMessage = '';
      state.wizard.step = 4;
      saveWizardState();
      renderApp();
    } else if (action === 'wizard-pick-alternative') {
      state.wizard.jalali_date = actEl.dataset.date;
      state.wizard.start_time = actEl.dataset.start;
      state.wizard.conflictAlternatives = null;
      state.wizard.conflictMessage = '';
      saveWizardState();
      await loadSlotsForWizard();
      renderApp();
    } else if (action === 'wizard-goto-step') {
      state.wizard.step = Number(actEl.dataset.step);
      saveWizardState();
      if (state.wizard.step === 3) await loadSlotsForWizard();
      renderApp();
    } else if (action === 'wizard-reset') {
      resetBookingSelection();
      state.wizard.step = 1;
      state.wizard.completedAppointment = null;
      state.wizard.start_time = '';
      saveWizardState();
      renderApp();
    } else if (action === 'booking-login') {
      state.authTab = 'login';
      sessionStorage.setItem(AUTH_RETURN_KEY, '/booking');
      await navigateTo('/auth');
    } else if (action === 'auth-switch-tab') {
      state.authTab = actEl.dataset.tab;
      renderApp();
    } else if (action === 'toggle-password') {
      const targetId = actEl.dataset.target;
      const inp = document.getElementById(targetId);
      if (inp) {
        const isPass = inp.type === 'password';
        inp.type = isPass ? 'text' : 'password';
        actEl.textContent = isPass ? 'پنهان‌کردن رمز' : 'نمایش رمز';
      }
    } else if (action === 'quick-demo-login') {
      const role = actEl.dataset.role;
      const creds =
        role === 'admin'
          ? { identifier: '09120000001', password: 'AvidaAdmin@1405' }
          : role === 'doctor'
          ? { identifier: '09120000002', password: 'AvidaDoc@1405' }
          : { identifier: '09121112233', password: 'AvidaUser@1405' };
      try {
        const res = await apiFetch('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify(creds),
        });
        await finishAuthentication(res);
      } catch (err) {
        showToast(err.message, 'error');
      }
    } else if (action === 'logout') {
      try {
        await apiFetch('/api/auth/logout', { method: 'POST' });
      } catch (e) {}
      clearSession();
      sessionStorage.removeItem(AUTH_RETURN_KEY);
      state.wizard.patient_name = '';
      state.wizard.patient_phone = '';
      state.wizard.notes = '';
      resetBookingSelection();
      state.wizard.step = 1;
      saveWizardState();
      showToast('با موفقیت از حساب کاربری خارج شدید.');
      await navigateTo('/');
    } else if (action === 'dash-tab') {
      state.dashboardTab = actEl.dataset.tab;
      renderApp();
    } else if (action === 'admin-tab') {
      state.adminTab = actEl.dataset.tab;
      renderApp();
    } else if (action === 'cancel-appointment') {
      const apptId = Number(actEl.dataset.apptId);
      try {
        const res = await apiFetch('/api/appointments/cancel', {
          method: 'POST',
          body: JSON.stringify({ appointment_id: apptId }),
        });
        showToast(res.message);
        await loadDashboardData();
        renderApp();
      } catch (err) {
        showToast(err.message, 'error');
      }
    } else if (action === 'open-reschedule-modal') {
      const apptId = Number(actEl.dataset.apptId);
      const list =
        state.route === '/admin' && state.adminData
          ? state.adminData.appointments
          : state.dashboardData
          ? state.dashboardData.appointments
          : [];
      const ap = list.find((item) => Number(item.id) === apptId);
      if (!ap) return;
      const availableDays = getRescheduleDays(ap);
      const selectedDay = availableDays.find((day) => day.jalali_date === ap.jalali_date) || availableDays[0];
      const selectedDate = selectedDay ? selectedDay.jalali_date : '';
      const slotsData = selectedDate ? await loadRescheduleSlots(ap, selectedDate) : { slots: [] };
      state.rescheduleModal = {
        appointment: ap,
        selectedDate,
        slotsData,
      };
      state.modalReturnAppointmentId = apptId;
      renderApp();
    } else if (action === 'close-modal') {
      state.rescheduleModal = null;
      renderApp();
      const trigger = document.querySelector(`[data-action="open-reschedule-modal"][data-appt-id="${state.modalReturnAppointmentId}"]`);
      if (trigger) trigger.focus({ preventScroll: true });
    } else if (action === 'mark-notifications-read') {
      await apiFetch('/api/notifications/read', { method: 'POST' });
      await loadDashboardData();
      showToast('همه اعلان‌ها خوانده شدند.');
      renderApp();
    } else if (action === 'admin-appt-status') {
      const apptId = Number(actEl.dataset.id);
      const newStatus = actEl.dataset.status;
      try {
        const res = await apiFetch('/api/admin/appointment/status', {
          method: 'POST',
          body: JSON.stringify({ appointment_id: apptId, status: newStatus }),
        });
        showToast(res.message);
        await loadAdminData();
        renderApp();
      } catch (err) {
        showToast(err.message, 'error');
      }
    } else if (action === 'admin-edit-service') {
      const sid = Number(actEl.dataset.id);
      const srv = state.services.find((s) => Number(s.id) === sid);
      if (srv) {
        document.getElementById('adm-srv-id').value = srv.id;
        document.getElementById('adm-srv-title').value = srv.title;
        document.getElementById('adm-srv-cat').value = srv.category;
        document.getElementById('adm-srv-dur').value = srv.duration_min;
        document.getElementById('adm-srv-price').value = srv.price_sample;
        document.getElementById('adm-srv-model').value = srv.model_type;
        document.getElementById('adm-srv-desc').value = srv.short_desc;
        window.scrollTo({ top: 180, behavior: 'smooth' });
      }
    } else if (action === 'admin-edit-doctor') {
      const did = Number(actEl.dataset.id);
      const doc = state.doctors.find((d) => Number(d.id) === did);
      if (doc) {
        document.getElementById('adm-doc-id').value = doc.id;
        document.getElementById('adm-doc-name').value = doc.name;
        document.getElementById('adm-doc-spec').value = doc.specialty;
        document.getElementById('adm-doc-code').value = doc.medical_code;
        document.getElementById('adm-doc-bio').value = doc.bio;
        window.scrollTo({ top: 180, behavior: 'smooth' });
      }
    } else if (action === 'admin-remove-block') {
      const idx = Number(actEl.dataset.idx);
      const curBlocked = (state.settings.blocked_slots || []).slice();
      curBlocked.splice(idx, 1);
      const res = await apiFetch('/api/admin/settings/save', {
        method: 'POST',
        body: JSON.stringify({ key: 'blocked_slots', value: curBlocked }),
      });
      showToast(res.message);
      await bootstrapApp();
      await loadAdminData();
      renderApp();
    } else if (action === 'admin-restore-trash') {
      const tid = Number(actEl.dataset.id);
      try {
        const res = await apiFetch('/api/admin/trash/restore', {
          method: 'POST',
          body: JSON.stringify({ trash_id: tid }),
        });
        showToast(res.message);
        await bootstrapApp();
        await loadAdminData();
        renderApp();
      } catch (err) {
        showToast(err.message, 'error');
      }
    }
    } catch (err) {
      showToast(err.message || 'انجام عملیات ممکن نشد. دوباره تلاش کنید.', 'error');
    }
  });

  window.addEventListener('popstate', () => {
    navigateTo(currentRouteFromLocation(), false);
  });
  window.addEventListener('hashchange', () => {
    const route = currentRouteFromLocation();
    if (route !== state.route) navigateTo(route, false);
  });
  document.addEventListener('keydown', (event) => {
    const modal = document.querySelector('.modal-backdrop');
    if (!modal) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      modal.querySelector('[data-action="close-modal"]').click();
    } else if (event.key === 'Tab') {
      const focusable = Array.from(modal.querySelectorAll('button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea:not([disabled]), a[href]'));
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });

  window.addEventListener('DOMContentLoaded', async () => {
    await bootstrapApp();
    await navigateTo(currentRouteFromLocation(), false);
  });
})();
