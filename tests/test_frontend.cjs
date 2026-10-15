const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const project = path.resolve(__dirname, '..');
const js = name => fs.readFileSync(path.join(project, 'static/js', name), 'utf8');
const results = [];
function storage(seed = {}) { const items = new Map(Object.entries(seed)); return { getItem: k => items.get(k) ?? null, setItem: (k,v) => items.set(k,String(v)), removeItem: k => items.delete(k) }; }
function setup(savedWizard = {}) {
  const elements = {};
  const events = {};
  let forms = [];
  const context = {
    console: { log() {}, error() {} }, URLSearchParams, Intl, Date, AbortController,
    localStorage: storage(), sessionStorage: storage({ avida_booking_wizard_v1: JSON.stringify(savedWizard) }),
    setTimeout: () => 1, clearTimeout() {},
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    document: {
      getElementById: id => elements[id] || null,
      querySelector: () => null,
      querySelectorAll: selector => selector === 'form' ? forms : [],
      addEventListener: (name, handler) => { events['doc:'+name] = handler; },
      body: { getAttribute: () => '/' },
      activeElement: null,
    },
  };
  context.window = {
    location: { protocol: 'http:', pathname: '/', hash: '', search: '' },
    addEventListener: (name, handler) => { events[name] = handler; },
    matchMedia: () => ({matches: false}), history: { pushState() {} }, scrollTo() {},
  };
  vm.createContext(context);
  const exposed = js('app.js').replace(/\}\)\(\);\s*$/, 'window.audit = {state, currentRouteFromLocation, routeToHref, loadWizardState, bootstrapApp, apiFetch, loadSlotsForWizard, bindDynamicForms, renderBookingPage, renderDashboardPage, renderAdminPage, getRescheduleDays, loadRescheduleSlots, renderModals};})();');
  vm.runInContext(exposed, context);
  return {context, elements, events, api: context.window.audit, setForms: value => { forms = value; }};
}
async function test(name, fn) { await fn(); results.push({name, passed:true}); }
(async () => {
  await test('All .html URLs, clean routes, deep services and back navigation resolve correctly', async () => {
    const {context,api,events} = setup();
    const routes = { '/index.html':'/', '/services.html':'/services', '/booking.html':'/booking', '/auth.html':'/auth', '/admin.html':'/admin', '/doctors.html':'/doctors', '/dashboard.html':'/dashboard', '/consultation.html':'/consultation', '/contact.html':'/contact', '/services/implant':'/services/implant', '/booking':'/booking' };
    for(const [pathname,expected] of Object.entries(routes)) { context.window.location.pathname=pathname; assert.equal(api.currentRouteFromLocation(),expected); }
    context.window.location.pathname='/services.html'; context.window.location.search='?slug=implant';
    assert.equal(api.currentRouteFromLocation(),'/services/implant');
    context.window.location.pathname='/contact.html'; context.window.location.search='';
    events.popstate(); await Promise.resolve(); assert.equal(api.state.route,'/contact');
    context.window.location.pathname='/booking.html'; await events.DOMContentLoaded();assert.equal(api.state.route,'/booking');
  });
  await test('Saved partial/corrupt wizard receives complete defaults', () => {
    const {api}=setup({step:999}); assert.equal(api.state.wizard.step,1); assert.equal(api.state.wizard.patient_name,'');
  });
  await test('New-tab links stay at HTTP origin root from deep routes while file preview stays relative', () => {
    const {context,api}=setup();context.window.location.pathname='/services/digital-implant';
    for(const protocol of ['http:','https:']) {
      context.window.location.protocol=protocol;
      assert.equal(api.routeToHref('/'),'/index.html');assert.equal(api.routeToHref('/booking'),'/booking.html');
      assert.equal(new URL(api.routeToHref('/'),`${protocol}//127.0.0.1:8082/services/digital-implant`).pathname,'/index.html');
      assert.equal(api.routeToHref('/services/digital-implant'),'/services.html?slug=digital-implant');
    }
    context.window.location.protocol='file:';
    assert.equal(api.routeToHref('/'),'index.html');assert.equal(api.routeToHref('/booking'),'booking.html');
    assert.equal(api.routeToHref('/services/digital-implant'),'services.html?slug=digital-implant');
  });
  await test('HTTP network failure never falls back to fake API success', async () => {
    const {context,api}=setup(); let fallbacks=0;
    context.fetch=async () => {throw new Error('offline');};
    context.window.AvidaOfflineFallback={handle:async () => {fallbacks++; return {token:'fake'};}};
    await assert.rejects(api.apiFetch('/api/auth/login',{method:'POST'})); assert.equal(fallbacks,0);
  });
  await test('Expired session removes cached user and private dashboard state', async () => {
    const {context,api}=setup(); api.state.user={id:7}; api.state.token='stale'; api.state.dashboardData={appointments:[{id:1}]};
    context.fetch=async () => ({ok:true,status:200,json:async () => ({user:null,upcoming_days:[],services:[],doctors:[]})});
    await api.bootstrapApp(); assert.equal(api.state.user,null); assert.equal(api.state.dashboardData,null); assert.equal(api.state.token,'');
  });
  await test('HTTP 401 clears authentication and cached private data', async () => {
    const {context,api}=setup(); api.state.user={id:3}; api.state.token='invalid'; api.state.adminData={appointments:[1]};
    context.fetch=async () => ({ok:false,status:401,json:async () => ({error:'expired'})});
    await assert.rejects(api.apiFetch('/api/dashboard'), {status:401}); assert.equal(api.state.adminData,null); assert.equal(api.state.user,null);
  });
  await test('Old slot responses cannot overwrite a newer selected date', async () => {
    const {context,api}=setup(); const pending=[];
    context.fetch=() => new Promise(resolve => pending.push(resolve));
    api.state.wizard.jalali_date='1405/07/23'; const old=api.loadSlotsForWizard();
    api.state.wizard.jalali_date='1405/07/24'; const recent=api.loadSlotsForWizard();
    pending[1]({ok:true,json:async () => ({human_date:'latest',slots:[]})}); await recent;
    pending[0]({ok:true,json:async () => ({human_date:'stale',slots:[]})}); await old;
    assert.equal(api.state.currentSlotsData.human_date,'latest');
  });
  await test('Guest final step requests login and never prepopulates another patient phone', () => {
    const {api}=setup({step:4}); const html=api.renderBookingPage();
    assert.match(html,/data-action="booking-login"/); assert.doesNotMatch(html,/value="09121112233"/);
  });
  await test('Service edit preserves long description and care instructions', async () => {
    const {api,context,elements,setForms}=setup(); let saved;
    const form={dataset:{},querySelectorAll:() => [], setAttribute(){},removeAttribute(){}};
    elements['admin-service-form']=form; setForms([form]);
    const values={'adm-srv-id':'7','adm-srv-title':'Edited service','adm-srv-cat':'Category','adm-srv-dur':'60','adm-srv-price':'123','adm-srv-model':'implant','adm-srv-desc':'New short'};
    Object.entries(values).forEach(([id,value]) => {elements[id]={value};});
    api.state.services=[{id:7,full_desc:'Long detail',prep_tips:'Prepare',aftercare_tips:'After',active:1}];
    context.fetch=async (endpoint,opts) => {if(endpoint.includes('service/save')) saved=JSON.parse(opts.body); return {ok:true,json:async () => ({services:api.state.services,doctors:[],upcoming_days:[]})};};
    api.bindDynamicForms(); await form.onsubmit({preventDefault(){}});
    assert.equal(saved.full_desc,'Long detail'); assert.equal(saved.prep_tips,'Prepare'); assert.equal(saved.aftercare_tips,'After');
  });
  await test('Doctor edit preserves saved schedule and profile fields', async () => {
    const {api,context,elements,setForms}=setup(); let saved;
    const form={dataset:{},querySelectorAll:() => [],setAttribute(){},removeAttribute(){}}; elements['admin-doctor-form']=form;setForms([form]);
    Object.entries({'adm-doc-id':'2','adm-doc-name':'Doctor Name','adm-doc-spec':'Specialty','adm-doc-code':'123','adm-doc-bio':'Changed bio'}).forEach(([id,value]) => {elements[id]={value};});
    api.state.doctors=[{id:2,schedule:{'0':{active:false,start:'11:00',end:'14:00'}},experience_note:'Original experience',avatar_theme:'blue',active:1}];
    context.fetch=async (endpoint,opts) => {if(endpoint.includes('doctor/save')) saved=JSON.parse(opts.body);return {ok:true,json:async () => ({services:[],doctors:api.state.doctors,upcoming_days:[]})};};
    api.bindDynamicForms();await form.onsubmit({preventDefault(){}});
    assert.equal(saved.schedule['0'].active,false);assert.equal(saved.schedule['0'].start,'11:00');assert.equal(saved.experience_note,'Original experience');assert.equal(saved.avatar_theme,'blue');
  });
  await test('Repeated submit starts only one request while form is busy', async () => {
    const {api,context,elements,setForms}=setup();let requests=0;let complete;
    const button={disabled:false};const form={dataset:{},querySelectorAll:() => [button],setAttribute(){},removeAttribute(){}};
    elements['auth-login-form']=form;elements['login-identifier']={value:'user'};elements['login-password']={value:'bad'};setForms([form]);
    context.fetch=async () => {requests++;return await new Promise(resolve => {complete=resolve;});};
    api.bindDynamicForms();const first=form.onsubmit({preventDefault(){}});const second=form.onsubmit({preventDefault(){}});
    assert.equal(requests,1);assert.equal(button.disabled,true);complete({ok:false,status:400,json:async () => ({error:'Invalid credentials'})});await Promise.all([first,second]);assert.equal(button.disabled,false);
  });
  await test('Offline preview explicitly rejects login and mutations', async () => {
    const {context}=setup();vm.runInContext(js('offline-fallback.js'),context);
    await assert.rejects(context.window.AvidaOfflineFallback.handle('/api/auth/login',{body:'{}'},{}),{status:503});
    const data=await context.window.AvidaOfflineFallback.handle('/api/bootstrap',{}, {user:{id:1}});assert.equal(data.user,null);
  });
  await test('Completed admin appointments show Persian status without invalid actions', () => {
    const {api}=setup();api.state.user={id:1,role:'admin'};
    api.state.adminData={appointments:[{id:9,status:'completed',patient_name:'Patient',jalali_date:'1405/07/20',start_time:'09:00'}]};
    const html=api.renderAdminPage();assert.match(html,/انجام‌شده/);assert.doesNotMatch(html,/data-action="open-reschedule-modal"/);assert.doesNotMatch(html,/data-action="admin-appt-status"/);assert.doesNotMatch(html,/>completed</);
  });
  await test('Dashboard nearest appointment is chronological even if API list is unordered', () => {
    const {api}=setup();api.state.user={id:3,name:'Patient'};api.state.today_jalali='1405/07/22';
    api.state.dashboardData={appointments:[{id:1,status:'confirmed',service_title:'Later service',jalali_date:'1405/07/28',start_time:'09:00'},{id:2,status:'confirmed',service_title:'Nearest service',jalali_date:'1405/07/24',start_time:'09:00'}]};
    const html=api.renderDashboardPage();assert.ok(html.indexOf('Nearest service')<html.indexOf('Later service'));
  });
  await test('3D scene destroy cancels animation and all lifecycle listeners', () => {
    const listeners=[];const pending=new Map();let next=1;let disconnected=0;
    const listen=(name,handler,options={}) => listeners.push({name,signal:options.signal});
    const sceneContext={console,AbortController,Math,window:{matchMedia:() => ({matches:false,addEventListener:listen}),addEventListener:listen,devicePixelRatio:1},document:{hidden:false,addEventListener:listen},requestAnimationFrame:fn=>{const id=next++;pending.set(id,fn);return id;},cancelAnimationFrame:id=>pending.delete(id)};
    sceneContext.window.IntersectionObserver=true;sceneContext.IntersectionObserver=class{observe(){}disconnect(){disconnected++;}};
    vm.createContext(sceneContext);vm.runInContext(js('scene3d.js'),sceneContext);
    const Scene=sceneContext.window.Avida3D.AvidaHero3D;Scene.prototype.renderFrame=function(){};
    const canvas={getContext:()=>({setTransform(){}}),getBoundingClientRect:()=>({width:500,height:330}),addEventListener:listen,isConnected:true};
    const instance=new Scene(canvas);assert.equal(pending.size,1);instance.destroy();assert.equal(pending.size,0);assert.equal(disconnected,1);assert.ok(listeners.every(item=>item.signal && item.signal.aborted));
    instance.startLoop();assert.equal(pending.size,0);
  });
  await test('Reduced-motion comparison slider remains functional and scroll listeners do not accumulate', () => {
    const scrollListeners=new Set();let input;
    const slider={value:'50',addEventListener:(name,handler)=>{input=handler;},setAttribute(){}};
    const after={style:{}};const divider={style:{}};const progress={style:{}};
    const root={querySelector:id=>({'#smile-compare-range':slider,'#smile-after-layer':after,'#smile-divider-line':divider}[id]||null),querySelectorAll:()=>[]};
    const ctx={console,window:{matchMedia:()=>({matches:true}),addEventListener:(name,fn)=>scrollListeners.add(fn),removeEventListener:(name,fn)=>scrollListeners.delete(fn),scrollY:0},document:{getElementById:id=>id==='avida-scroll-progress'?progress:null,documentElement:{scrollHeight:1000,clientHeight:500}}};
    ctx.window.gsap={registerPlugin(){}};ctx.window.ScrollTrigger={killAll(){}};
    vm.createContext(ctx);vm.runInContext(js('immersive-effects.js'),ctx);
    ctx.window.AvidaImmersive.initImmersiveEffects(root);slider.value='75';input();assert.equal(after.style.clipPath,'inset(0 0 0 25%)');
    ctx.window.AvidaImmersive.initImmersiveEffects(root);assert.equal(scrollListeners.size,1);ctx.window.AvidaImmersive.cleanup();assert.equal(scrollListeners.size,0);
  });
  await test('Reschedule availability excludes the current appointment while new booking does not', async () => {
    const {api,context}=setup();const requests=[];
    context.fetch=async endpoint => {requests.push(endpoint);return {ok:true,json:async () => ({slots:[]})};};
    await api.loadRescheduleSlots({id:19,service_id:2,doctor_id:3},'1405/07/25');
    assert.equal(new URLSearchParams(requests[0].split('?')[1]).get('appointment_id'),'19');
    await api.loadSlotsForWizard();assert.equal(new URLSearchParams(requests[1].split('?')[1]).has('appointment_id'),false);
  });
  await test('Reschedule calendar offers only active doctor days excluding holidays', () => {
    const {api}=setup();api.state.doctors=[{id:3,schedule:{'0':{active:true},'1':{active:false},'2':{active:true}}}];
    api.state.upcoming_days=[{jalali_date:'1405/07/25',weekday_idx:0,is_holiday:false},{jalali_date:'1405/07/26',weekday_idx:1,is_holiday:false},{jalali_date:'1405/07/27',weekday_idx:2,is_holiday:true}];
    const appointment={id:19,doctor_id:3};assert.equal(api.getRescheduleDays(appointment).length,1);assert.equal(api.getRescheduleDays(appointment)[0].jalali_date,'1405/07/25');
    api.state.rescheduleModal={appointment,selectedDate:'1405/07/25',slotsData:{slots:[]}};
    const html=api.renderModals();assert.match(html,/value="1405\/07\/25"/);assert.doesNotMatch(html,/value="1405\/07\/26"/);assert.doesNotMatch(html,/value="1405\/07\/27"/);
  });
  fs.writeFileSync(path.join(__dirname,'frontend-regression-results.json'),JSON.stringify({total:results.length,passed:results.length,results},null,2));
  console.log(`${results.length} focused frontend regressions passed`);
})().catch(error => {console.error(error);process.exitCode=1;});
