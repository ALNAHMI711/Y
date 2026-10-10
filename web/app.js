// Thaqafat Watan web app — vanilla JS, DOM built with h() so user data is never parsed as HTML.
const $ = (s) => document.querySelector(s);
const BASE = (window.TW_API_BASE || '').replace(/\/$/, '');
const preview = new URLSearchParams(location.search).has('preview');
const st = { token: localStorage.tw_token || null, me: null, tab: 'store', cart: JSON.parse(localStorage.tw_cart || '[]'), vault: null };
const money = (n) => `${Number(n).toLocaleString('ar-YE')} ر.ي`;

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
async function api(method, path, body, extra = {}) {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(st.token ? { authorization: `Bearer ${st.token}` } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'حدث خطأ');
  return data;
}
const toast = (m) => { const b = $('#banner'); b.className = 'banner'; b.textContent = m; setTimeout(() => { b.className = ''; b.textContent = ''; }, 4000); };
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message); } };

// ---------- offline catalog + order queue ----------
const cache = { get: (k, d) => { try { return JSON.parse(localStorage[k]) ?? d; } catch { return d; } }, set: (k, v) => (localStorage[k] = JSON.stringify(v)) };
async function syncCatalog() {
  try {
    const since = cache.get('tw_seq', 0), d = await api('GET', `/api/sync?since=${since}`);
    let prods = since === 0 ? d.products : cache.get('tw_products', []);
    if (since) { const m = new Map(prods.map((p) => [p.id, p])); d.products.forEach((p) => m.set(p.id, p)); d.deleted.filter((x) => x.entity === 'products').forEach((x) => m.delete(x.id)); prods = [...m.values()]; }
    cache.set('tw_products', prods); cache.set('tw_seq', d.seq);
    if (d.features.length) cache.set('tw_features', d.features);
    if (d.zones.length || since === 0) cache.set('tw_zones', since === 0 ? d.zones : d.zones);
  } catch { /* offline: use cached data */ }
}
async function flushQueue() {
  const q = cache.get('tw_queue', []), rest = [];
  for (const o of q) { try { await api('POST', '/api/orders', o); } catch (e) { if (!navigator.onLine || e instanceof TypeError || e.message === 'يلزم تسجيل الدخول') rest.push(o); } }
  cache.set('tw_queue', rest);
  if (q.length && !rest.length) toast('تمت مزامنة الطلبات المحفوظة');
}
addEventListener('online', () => { flushQueue(); syncCatalog().then(render); });
const featureOn = (k) => cache.get('tw_features', []).find((f) => f.key === k)?.enabled !== 0;

// ---------- layout ----------
function renderNav() {
  const nav = $('#nav'); nav.replaceChildren();
  if (!st.me || preview) return;
  const tabs = [['store', 'المتجر'], ['wallet', 'المحفظة'], ['orders', 'طلباتي']];
  if (featureOn('vendors')) tabs.push(['vendor', 'التاجر']);
  if (['admin', 'staff'].includes(st.me.role)) tabs.push(['admin', 'الإدارة']);
  if (st.me.role === 'driver') tabs.push(['driver', 'المندوب']);
  for (const [k, l] of tabs) nav.append(h('button', { class: st.tab === k ? '' : 'ghost', onclick: () => { st.tab = k; render(); } }, l));
  nav.append(h('button', { class: 'ghost', onclick: () => { localStorage.removeItem('tw_token'); st.token = null; st.me = null; render(); } }, 'خروج'));
}
async function render() {
  const app = $('#app'); app.replaceChildren();
  if (!st.token) return app.append(loginView());
  if (!st.me) { try { st.me = await api('GET', '/api/me'); } catch { st.token = null; return render(); } }
  renderNav();
  const views = { store: storeView, wallet: walletView, orders: ordersView, admin: adminView, driver: driverView, vendor: vendorView };
  try { app.append(await views[st.tab]()); } catch (e) { app.append(h('div', { class: 'card' }, e.message)); }
}

// ---------- login ----------
function loginView() {
  const phone = h('input', { placeholder: 'رقم الهاتف مع المفتاح (967...)', inputmode: 'tel' });
  const name = h('input', { placeholder: 'الاسم الرباعي (للحسابات الجديدة)' });
  const code = h('input', { placeholder: 'رمز التحقق', inputmode: 'numeric', style: 'display:none' });
  const go = h('button', {}, 'إرسال رمز واتساب');
  let sent = false;
  go.onclick = guard(async () => {
    if (!sent) { const r = await api('POST', '/api/auth/request-otp', { phone: phone.value }); sent = true; code.style.display = ''; go.textContent = 'تأكيد'; if (r.dev_code) toast(`رمز التجربة: ${r.dev_code}`); return; }
    const r = await api('POST', '/api/auth/verify', { phone: phone.value, code: code.value, name: name.value });
    st.token = r.token; localStorage.tw_token = r.token; st.me = null; await syncCatalog(); render();
  });
  return h('div', { class: 'card' }, h('h2', {}, 'تسجيل الدخول'), phone, name, code, go);
}

// ---------- store ----------
async function storeView() {
  await syncCatalog();
  const prods = cache.get('tw_products', []).filter((p) => !p.hidden);
  const wrap = h('div', {});
  wrap.append(...(await api('GET', '/api/announcements').catch(() => [])).map((a) => h('div', { class: 'card' }, a.text)));
  wrap.append(h('div', { class: 'grid' }, prods.map((p) => h('div', { class: 'card' },
    p.image ? h('img', { src: p.image, alt: p.name, style: 'width:100%;border-radius:8px' }) : null, h('b', {}, p.name), h('div', { class: 'price' }, money(p.price)), h('div', { class: 'mute' }, p.stock > 0 ? `متوفر: ${p.stock}` : 'نفد'),
    h('button', { disabled: p.stock < 1, onclick: () => { const l = st.cart.find((c) => c.product_id === p.id); l ? l.qty++ : st.cart.push({ product_id: p.id, qty: 1, name: p.name, price: p.price }); localStorage.tw_cart = JSON.stringify(st.cart); toast('أضيف إلى السلة'); render(); } }, 'أضف')))));
  if (st.cart.length) wrap.append(await cartView());
  return wrap;
}
async function cartView() {
  const zones = cache.get('tw_zones', []);
  let addrs = []; try { addrs = await api('GET', '/api/addresses'); } catch { /* offline */ }
  const sub = st.cart.reduce((a, c) => a + c.price * c.qty, 0);
  const sel = h('select', {}, addrs.map((a) => h('option', { value: a.id }, a.label)));
  const wallet = h('input', { type: 'number', placeholder: 'مبلغ من رصيدك (اختياري)', min: 0 });
  const quote = h('div', { class: 'mute' }, `المنتجات: ${money(sub)}`);
  if (addrs.length) api('POST', '/api/quote', { address_id: sel.value, items: st.cart }).then((q) => { quote.textContent = `المنتجات ${money(q.subtotal)} + توصيل ${money(q.shipping)} = ${money(q.total)}`; }).catch(() => {});
  const lab = h('input', { placeholder: 'اسم عنوان جديد (المنزل، العمل...)' });
  const zs = h('select', {}, zones.map((z) => h('option', { value: z.id }, `${z.name} — ${z.free ? 'مجاني' : money(z.fee)}`)));
  const addAddr = h('button', { class: 'ghost', onclick: guard(async () => {
    const pos = await new Promise((res) => navigator.geolocation ? navigator.geolocation.getCurrentPosition((p) => res(p.coords), () => res(null)) : res(null));
    await api('POST', '/api/addresses', { label: lab.value, zone_id: zs.value, lat: pos?.latitude, lng: pos?.longitude }); render();
  }) }, 'حفظ العنوان (مع موقعي)');
  const order = h('button', { onclick: guard(async () => {
    const body = { client_id: crypto.randomUUID(), address_id: Number(sel.value), wallet_amount: Number(wallet.value || 0), items: st.cart.map(({ product_id, qty }) => ({ product_id, qty })) };
    try { await api('POST', '/api/orders', body); } catch (e) {
      if (navigator.onLine) throw e;
      cache.set('tw_queue', [...cache.get('tw_queue', []), body]); toast('لا يوجد اتصال — سيُرسل الطلب تلقائياً عند عودة الإنترنت');
    }
    st.cart = []; localStorage.tw_cart = '[]'; st.tab = 'orders'; render();
  }) }, 'تأكيد الطلب');
  return h('div', { class: 'card' }, h('h3', {}, 'السلة'),
    st.cart.map((c) => h('div', { class: 'row' }, `${c.name} × ${c.qty}`, h('span', { class: 'price' }, money(c.price * c.qty)))),
    quote, h('h4', {}, 'التوصيل'), addrs.length ? sel : h('div', { class: 'mute' }, 'أضف عنواناً أولاً'),
    h('div', { class: 'row' }, lab, zs, addAddr), wallet, order,
    h('button', { class: 'ghost', onclick: () => { st.cart = []; localStorage.tw_cart = '[]'; render(); } }, 'تفريغ السلة'));
}

// ---------- wallet / orders ----------
async function walletView() {
  const w = await api('GET', '/api/wallet');
  const amount = h('input', { type: 'number', placeholder: 'المبلغ المحوّل' }), ref = h('input', { placeholder: 'رقم العملية' });
  return h('div', {}, h('div', { class: 'card' }, h('div', { class: 'mute' }, 'رصيدك'), h('div', { class: 'price', style: 'font-size:26px' }, money(w.balance))),
    h('div', { class: 'card' }, h('h3', {}, 'شحن الرصيد'), h('div', { class: 'mute' }, 'حوّل إلى حساب المحفظة ثم أدخل رقم العملية؛ تتم المطابقة تلقائياً أو بموافقة الدعم.'), amount, ref,
      h('button', { onclick: guard(async () => { const r = await api('POST', '/api/transfers', { amount: Number(amount.value), ref: ref.value }); toast(r.status === 'credited' ? 'تم شحن الرصيد' : 'بانتظار المطابقة'); render(); }) }, 'إرسال')),
    h('div', { class: 'card' }, h('h3', {}, 'السجل'), h('table', {}, w.history.map((x) => h('tr', {}, h('td', {}, x.type), h('td', {}, money(x.amount)), h('td', { class: 'mute' }, x.at.slice(0, 10)))))));
}
async function ordersView() {
  const q = cache.get('tw_queue', []);
  const o = await api('GET', '/api/orders');
  return h('div', {}, q.length ? h('div', { class: 'card' }, `${q.length} طلب بانتظار الإرسال (دون اتصال)`) : null,
    o.map((x) => h('div', { class: 'card' }, h('b', {}, `طلب #${x.id}`), ` — ${x.status}`, h('div', { class: 'price' }, money(x.total)), x.cod_due ? h('div', { class: 'mute' }, `عند الاستلام: ${money(x.cod_due)}`) : null,
      x.status === 'out_for_delivery' && featureOn('live_tracking') ? h('a', { class: 'btn', href: `${BASE}/api/track/${x.track_token}`, target: '_blank' }, 'تتبع المندوب') : null)));
}

// ---------- driver (works offline: cached route + queued deliveries) ----------
function routeSketch(stops) {
  const pts = stops.map((s, i) => ({ s, i })).filter((x) => x.s.lat != null && x.s.lng != null);
  const NS = 'http://www.w3.org/2000/svg', W = 320, H = 200, pad = 24, el = (t, a = {}) => { const e = document.createElementNS(NS, t); for (const [k, v] of Object.entries(a)) e.setAttribute(k, v); return e; };
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', 'aria-label': 'مخطط المحطات' });
  svg.append(el('rect', { width: W, height: H, rx: 12, fill: '#1a1e14', stroke: '#434d35' }));
  if (!pts.length) return svg;
  const la = pts.map((x) => x.s.lat), ln = pts.map((x) => x.s.lng), minA = Math.min(...la), maxA = Math.max(...la), minN = Math.min(...ln), maxN = Math.max(...ln);
  const sx = (v) => (maxN === minN ? W / 2 : pad + ((v - minN) / (maxN - minN)) * (W - 2 * pad)), sy = (v) => (maxA === minA ? H / 2 : H - pad - ((v - minA) / (maxA - minA)) * (H - 2 * pad));
  svg.append(el('polyline', { points: pts.map((x) => `${sx(x.s.lng)},${sy(x.s.lat)}`).join(' '), fill: 'none', stroke: '#6b7a52', 'stroke-width': 2, 'stroke-dasharray': '5 4' }));
  for (const x of pts) { const g = el('g'); g.append(el('circle', { cx: sx(x.s.lng), cy: sy(x.s.lat), r: 11, fill: '#d9c98a' })); const t = el('text', { x: sx(x.s.lng), y: sy(x.s.lat) + 5, 'text-anchor': 'middle', 'font-size': 14, 'font-weight': 700, fill: '#1f2418' }); t.textContent = x.i + 1; g.append(t); svg.append(g); }
  return svg;
}
async function flushDeliveries() {
  const q = cache.get('tw_deliveries', []), rest = [];
  for (const id of q) { try { await api('POST', `/api/driver/orders/${id}/deliver`); } catch (e) { if (!navigator.onLine || e instanceof TypeError || e.message === 'يلزم تسجيل الدخول') rest.push(id); } }
  cache.set('tw_deliveries', rest);
  if (q.length && !rest.length) toast('تمت مزامنة التسليمات');
}
addEventListener('online', () => { flushDeliveries().then(() => st.tab === 'driver' && render()); });
async function driverView() {
  let stops;
  try { ({ stops } = await api('GET', '/api/driver/route')); cache.set('tw_route', stops); }
  catch (e) { if (navigator.onLine && !(e instanceof TypeError)) throw e; stops = cache.get('tw_route', []); toast('دون اتصال: عرض المسار المحفوظ'); }
  const done = new Set(cache.get('tw_deliveries', [])); stops = stops.filter((x) => !done.has(x.order_id));
  const pending = cache.get('tw_deliveries', []).length;
  const share = h('button', { onclick: () => navigator.geolocation?.getCurrentPosition((p) => api('POST', '/api/driver/location', { lat: p.coords.latitude, lng: p.coords.longitude }).then(() => toast('تم تحديث موقعك')).catch(() => toast('تعذر الإرسال دون اتصال'))) }, 'مشاركة موقعي');
  const deliver = (s) => guard(async () => {
    try { await api('POST', `/api/driver/orders/${s.order_id}/deliver`); }
    catch (e) { if (navigator.onLine && !(e instanceof TypeError)) throw e; cache.set('tw_deliveries', [...cache.get('tw_deliveries', []), s.order_id]); cache.set('tw_route', cache.get('tw_route', []).filter((x) => x.order_id !== s.order_id)); toast('حُفظ التسليم وسيُرسل عند عودة الاتصال'); }
    render();
  });
  return h('div', {}, pending ? h('div', { class: 'card' }, `${pending} تسليم بانتظار المزامنة`) : null, h('div', { class: 'row' }, share), h('div', { class: 'card' }, h('div', { class: 'mute' }, 'مخطط تقريبي للمحطات بالترتيب (ليس خريطة طرق)'), routeSketch(stops)),
    stops.map((s, i) => h('div', { class: 'card' }, h('b', {}, `${i + 1}. ${s.customer}`), h('div', { class: 'mute' }, `${s.phone} — ${s.details ?? ''}`),
      s.cod_due ? h('div', { class: 'price' }, `تحصيل: ${money(s.cod_due)}`) : null,
      s.lat != null ? h('a', { class: 'btn', href: `geo:${s.lat},${s.lng}` }, 'فتح الخريطة') : null,
      h('button', { onclick: deliver(s) }, 'تم التسليم'))));
}

// ---------- image processor (runs in the browser; toggled by the image_processor feature) ----------
async function processImage(file, enhance) {
  const bmp = await createImageBitmap(file), S = 800, c = document.createElement('canvas'); c.width = c.height = S;
  const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, S, S);
  const k = Math.min((S - 40) / bmp.width, (S - 40) / bmp.height);
  if (enhance) x.filter = 'contrast(1.08) saturate(1.1) brightness(1.03)';
  x.drawImage(bmp, (S - bmp.width * k) / 2, (S - bmp.height * k) / 2, bmp.width * k, bmp.height * k);
  x.filter = 'none';
  if (enhance) { x.strokeStyle = '#3d4a2a'; x.lineWidth = 14; x.strokeRect(7, 7, S - 14, S - 14); x.fillStyle = '#3d4a2a'; x.fillRect(0, S - 56, S, 56); x.fillStyle = '#d9c98a'; x.font = 'bold 28px sans-serif'; x.textAlign = 'center'; x.fillText('ثقافة وطن', S / 2, S - 18); }
  return c.toDataURL('image/jpeg', 0.82);
}


// ---------- vendor ----------
function fileToJpeg(file, max = 1000) {
  return createImageBitmap(file).then((bmp) => { const k = Math.min(1, max / Math.max(bmp.width, bmp.height)), c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k); c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height); return c.toDataURL('image/jpeg', 0.8); });
}
async function vendorView() {
  const me = await api('GET', '/api/vendor/me');
  if (me.status === 'none') return vendorRegisterView();
  if (me.status !== 'active') {
    const msg = { pending: 'عقدك قيد المراجعة من الإدارة. ستتمكن من إضافة المنتجات بعد التفعيل.', suspended: 'حساب متجرك موقوف مؤقتاً. تواصل مع الإدارة.', deleted: 'حساب هذا المتجر محذوف.' }[me.status];
    return h('div', { class: 'card' }, h('h3', {}, me.shop_name), h('div', { class: 'price' }, { pending: 'قيد المراجعة', suspended: 'موقوف', deleted: 'محذوف' }[me.status]), h('p', {}, msg));
  }
  const d = await api('GET', '/api/vendor/statement');
  const v = d.vendor, stat = (t, x) => h('div', { class: 'card' }, h('div', { class: 'mute' }, t), h('div', { class: 'price', style: 'font-size:22px' }, money(x)));
  const prov = h('input', { placeholder: 'المحفظة (جيب، الكريمي...)' }), num = h('input', { placeholder: 'رقم الحساب', inputmode: 'numeric' });
  const wsel = h('select', {}, v.wallet_accounts.map((a) => h('option', { value: a.number }, `${a.provider} — ${a.number}`))), wamt = h('input', { type: 'number', placeholder: 'المبلغ' });
  const pn = h('input', { placeholder: 'اسم المنتج' }), pp = h('input', { type: 'number', placeholder: 'السعر' }), ps = h('input', { type: 'number', placeholder: 'المخزون' });
  return h('div', {}, h('h3', {}, v.shop_name), h('div', { class: 'grid' }, stat('متاح للسحب', v.available), stat('محجوز (35 يوماً)', v.pending)),
    h('div', { class: 'card' }, h('h4', {}, 'حساباتي في المحافظ'), v.wallet_accounts.map((a) => h('div', {}, `${a.provider}: ${a.number}`)), prov, num,
      h('button', { onclick: guard(async () => { await api('PUT', '/api/vendor/accounts', { accounts: [...v.wallet_accounts, { provider: prov.value, number: num.value }] }); render(); }) }, 'إضافة حساب')),
    h('div', { class: 'card' }, h('h4', {}, 'سحب'), wsel, wamt, h('button', { onclick: guard(async () => { await api('POST', '/api/vendor/withdraw', { account: wsel.value, amount: Number(wamt.value) }); toast('تم تسجيل طلب السحب'); render(); }) }, 'اسحب')),
    h('div', { class: 'card' }, h('h4', {}, 'منتج جديد'), pn, pp, ps, h('button', { onclick: guard(async () => { await api('POST', '/api/vendor/products', { name: pn.value, price: Number(pp.value), stock: Number(ps.value) }); toast('أضيف المنتج'); render(); }) }, 'إضافة')),
    h('div', { class: 'card' }, h('h4', {}, 'المبالغ المحجوزة'), h('table', {}, d.escrow.map((e) => h('tr', {}, h('td', {}, `طلب #${e.order_id}`), h('td', {}, money(e.amount)), h('td', { class: 'mute' }, `${e.release_at.slice(0, 10)} — ${e.status}`))))));
}
function vendorRegisterView() {
  const f = {}; const inp = (k, ph) => (f[k] = h('input', { placeholder: ph }));
  const imgs = {}; const pick = (k, label) => h('label', { class: 'mute' }, label, h('input', { type: 'file', accept: 'image/*', onchange: guard(async (e) => { if (e.target.files[0]) { imgs[k] = await fileToJpeg(e.target.files[0]); toast('تم تجهيز الصورة'); } }) }));
  return h('div', { class: 'card' }, h('h3', {}, 'تسجيل متجر'), h('div', { class: 'mute' }, 'بياناتك وصور البطاقة تُحفظ مشفّرة ولا تظهر للجمهور؛ يظهر اسم المتجر ومنتجاته فقط. بعد الإرسال تراجع الإدارة العقد وتفعّل حسابك.'),
    inp('full_name', 'الاسم الرباعي'), inp('shop_name', 'اسم المحل'), inp('location', 'موقع المحل'), inp('id_number', 'رقم البطاقة الشخصية'),
    pick('id_front_b64', 'صورة البطاقة (الوجه)'), pick('id_back_b64', 'صورة البطاقة (الخلف)'), inp('signature', 'التوقيع: اكتب اسمك الكامل للموافقة على شروط العقد'),
    h('button', { onclick: guard(async () => { const c = { ...Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value])), ...imgs }; const r = await api('POST', '/api/vendors/register', { contract: c }); toast('أُرسل العقد للمراجعة'); st.tab = 'store'; render(); }) }, 'إرسال العقد'));
}

// ---------- admin ----------
let adminTab = 'preview';
async function adminView() {
  const tabs = [['preview', 'المعاينة'], ['reports', 'التقارير'], ['features', 'الميزات'], ['catalog', 'المنتجات والمناطق'], ['vendors', 'التجار'], ['transfers', 'التحويلات'], ['copilot', 'المساعد'], ['backups', 'النسخ'], ['vault', 'الخزنة']];
  const bar = h('div', { class: 'row card' }, tabs.map(([k, l]) => h('button', { class: adminTab === k ? '' : 'ghost', onclick: () => { adminTab = k; render(); } }, l)));
  const pages = { preview: previewPane, reports: reportsPane, features: featuresPane, catalog: catalogPane, vendors: vendorsPane, transfers: transfersPane, copilot: copilotPane, backups: backupsPane, vault: vaultPane };
  return h('div', {}, bar, await pages[adminTab]());
}
async function previewPane() {
  return h('div', {}, h('div', { class: 'row card' },
    h('button', { class: 'ghost', onclick: () => toast('النشر على المتاجر يتطلب حسابات مطورين وخط بناء خارجياً — راجع README') }, 'نشر في المتاجر'),
    h('button', { class: 'ghost', onclick: () => toast('ثبّت التطبيق من قائمة المتصفح: «إضافة إلى الشاشة الرئيسية»') }, 'تحميل على الهاتف'),
    h('button', { onclick: () => { adminTab = 'reports'; render(); } }, 'تقارير')),
    h('iframe', { src: '/?preview=1', title: 'معاينة التطبيق' }));
}
async function reportsPane() {
  const [r, hl] = await Promise.all([api('GET', '/api/admin/reports'), api('GET', '/api/admin/health')]);
  const meter = h('div', { class: `meter ${hl.status}`, style: `--p:${hl.score}%` }, h('span', {}, `${hl.score}%`));
  const stat = (t, v) => h('div', { class: 'card' }, h('div', { class: 'mute' }, t), h('div', { class: 'price', style: 'font-size:22px' }, v));
  return h('div', {}, h('div', { class: 'card' }, meter, hl.checks.filter((c) => !c.ok).map((c) => h('div', {}, `⚠ ${c.name}: ${c.detail}`)),
    hl.repairable ? h('button', { onclick: guard(async () => { await api('POST', '/api/admin/health/repair'); render(); }) }, 'إصلاح آلي') : null),
    h('div', { class: 'grid' }, stat('المستخدمون', r.users.total), stat('نشطون (30 يوماً)', r.users.active_30d), stat('جدد (7 أيام)', r.users.new_7d), stat('متاجر مفعّلة', r.vendors.active), stat('متاجر معلّقة', r.vendors.pending),
      stat('منتجات معروضة', r.inventory.listed), stat('وحدات بالمخزون', r.inventory.units), stat('منشورات التواصل', r.social.posts)),
    h('div', { class: 'card' }, h('h4', {}, 'أوشكت على النفاد'), r.inventory.low.map((p) => h('div', {}, `${p.name}: ${p.stock}`)), h('h4', {}, 'نفدت'), r.inventory.out.map((p) => h('div', {}, p.name))),
    h('button', { class: 'ghost', onclick: guard(async () => { const m = await api('POST', '/api/admin/backups'); const res = await fetch(`${BASE}/api/admin/backups/${m.name}`, { headers: { authorization: `Bearer ${st.token}` } }); const b = await res.blob(); const a = h('a', { href: URL.createObjectURL(b), download: m.name }); a.click(); toast('تم إنشاء نسخة احتياطية وتنزيلها'); }) }, 'نسخة احتياطية'),
    h('button', { onclick: guard(async () => { const res = await fetch(BASE + '/api/admin/delivery-export', { headers: { authorization: `Bearer ${st.token}` } }); const b = await res.blob(); const a = h('a', { href: URL.createObjectURL(b), download: 'delivery.xlsx' }); a.click(); }) }, 'تصدير ملف التوصيل (Excel)'));
}
async function featuresPane() {
  const f = await api('GET', '/api/features');
  return h('div', { class: 'card' }, f.map((x) => h('div', { class: 'row' }, x.label, h('button', { class: x.enabled ? '' : 'ghost', onclick: guard(async () => { await api('PUT', `/api/admin/features/${x.key}`, { enabled: !x.enabled }); render(); }) }, x.enabled ? 'ظاهر' : 'مخفي'))));
}
async function catalogPane() {
  const n = h('input', { placeholder: 'اسم المنتج' }), p = h('input', { type: 'number', placeholder: 'السعر' }), s = h('input', { type: 'number', placeholder: 'المخزون' });
  let image = null; const enh = featureOn('image_processor');
  const img = h('input', { type: 'file', accept: 'image/*', onchange: guard(async () => { if (img.files[0]) { image = await processImage(img.files[0], enh); toast(enh ? 'تمت معالجة الصورة' : 'تم تجهيز الصورة'); } }) });
  const c = h('select', {}, [['none', 'بدون دفع عند الاستلام'], ['partial', 'دفع جزئي'], ['full', 'دفع كامل عند الاستلام']].map(([v, l]) => h('option', { value: v }, l)));
  const zn = h('input', { placeholder: 'اسم المنطقة' }), zf = h('input', { type: 'number', placeholder: 'سعر التوصيل (0 = مجاني)' });
  return h('div', {}, h('div', { class: 'card' }, h('h3', {}, 'منتج جديد'), n, p, s, c, h('div', { class: 'mute' }, enh ? 'صورة المنتج (تُحسَّن وتُؤطَّر تلقائياً)' : 'صورة المنتج'), img, h('button', { onclick: guard(async () => { await api('POST', '/api/admin/products', { name: n.value, price: Number(p.value), stock: Number(s.value), cod_mode: c.value, image }); toast('تم'); render(); }) }, 'إضافة')),
    h('div', { class: 'card' }, h('h3', {}, 'منطقة توصيل'), zn, zf, h('button', { onclick: guard(async () => { await api('POST', '/api/admin/zones', { name: zn.value, fee: Number(zf.value || 0), free: Number(zf.value || 0) === 0 }); toast('تم'); render(); }) }, 'حفظ')));
}
async function transfersPane() {
  const t = await api('GET', '/api/admin/transfers');
  return h('div', {}, t.length ? null : h('div', { class: 'card mute' }, 'لا توجد تحويلات معلّقة'), t.map((x) => h('div', { class: 'card row' }, `#${x.id} — مستخدم ${x.user_id} — ${money(x.amount)} — ${x.ref ?? ''}`,
    h('button', { onclick: guard(async () => { await api('POST', `/api/admin/transfers/${x.id}/approve`); render(); }) }, 'اعتماد'),
    h('button', { class: 'danger', onclick: guard(async () => { await api('POST', `/api/admin/transfers/${x.id}/reject`); render(); }) }, 'رفض'))));
}




async function backupsPane() {
  const ts = await api('GET', '/api/admin/backup-targets');
  const n = h('input', { placeholder: 'اسم الوجهة (سيرفري الخاص)' }), u = h('input', { placeholder: 'https://... رابط يقبل PUT', dir: 'ltr' }), t = h('input', { placeholder: 'رمز الدخول (اختياري)', type: 'password', dir: 'ltr' });
  return h('div', {}, h('div', { class: 'card' }, h('div', { class: 'mute' }, 'تُرفع كل نسخة احتياطية تلقائياً إلى وجهاتك (حتى 5). يجب أن يكون الرابط https لخادم عام؛ العناوين الداخلية مرفوضة.'),
    h('button', { onclick: guard(async () => { const r = await api('POST', '/api/admin/backups'); toast(`نسخة ${r.name}: ${r.uploads.filter((x) => x.status === 'ok').length}/${r.uploads.length} وجهات`); render(); }) }, 'نسخة احتياطية الآن')),
    ts.map((x) => h('div', { class: 'card' }, h('b', {}, x.name), h('div', { class: 'mute', dir: 'ltr' }, x.url), h('div', { class: x.last_status === 'ok' ? '' : 'mute' }, x.last_status ? `${x.last_status === 'ok' ? '✔' : '✖'} ${x.last_status} — ${x.last_at.slice(0, 16)}` : 'لم تُجرَّب'),
      h('div', { class: 'row' }, h('button', { class: 'ghost', onclick: guard(async () => { await api('POST', `/api/admin/backup-targets/${x.id}/test`); toast('الاتصال ناجح'); render(); }) }, 'اختبار'),
        h('button', { class: 'danger', onclick: guard(async () => { if (confirm('حذف هذه الوجهة؟')) { await api('DELETE', `/api/admin/backup-targets/${x.id}`); render(); } }) }, 'حذف')))),
    h('div', { class: 'card' }, h('h4', {}, 'وجهة جديدة'), n, u, t, h('button', { onclick: guard(async () => { await api('POST', '/api/admin/backup-targets', { name: n.value, url: u.value, token: t.value }); toast('أضيفت الوجهة'); render(); }) }, 'إضافة')));
}

const VST = { pending: 'قيد المراجعة', active: 'مفعّل', suspended: 'موقوف', deleted: 'محذوف' };
async function vendorsPane() {
  const vs = await api('GET', '/api/admin/vendors');
  const setSt = (id, status) => guard(async () => { await api('POST', `/api/admin/vendors/${id}/status`, { status }); render(); });
  return h('div', {}, vs.length ? null : h('div', { class: 'card mute' }, 'لا يوجد تجار'), vs.map((v) => h('div', { class: 'card' }, h('b', {}, v.shop_name), ` — ${VST[v.status]}`,
    h('div', { class: 'mute' }, `متاح ${money(v.available)} | محجوز ${money(v.pending)} | اشتراك حتى ${v.paid_until ? v.paid_until.slice(0, 10) : '—'}`),
    h('div', { class: 'row' },
      h('button', { class: 'ghost', onclick: guard(async () => { const c = await api('GET', `/api/admin/contracts/${v.contract_id}`); alert(`${c.data.full_name}\nالمحل: ${c.data.shop_name}\nالموقع: ${c.data.location ?? ''}\nرقم البطاقة: ${c.data.id_number}`); }) }, 'عرض العقد'),
      v.status !== 'active' ? h('button', { onclick: setSt(v.id, 'active') }, 'تفعيل') : h('button', { class: 'ghost', onclick: setSt(v.id, 'suspended') }, 'إيقاف'),
      h('button', { class: 'ghost', onclick: guard(async () => { const r = await api('POST', `/api/admin/vendors/${v.id}/subscription`, { months: 1 }); toast(`سُجّل اشتراك شهر: ${money(r.amount)}`); render(); }) }, 'تسجيل اشتراك'),
      h('button', { class: 'danger', onclick: () => confirm('حذف التاجر وإخفاء منتجاته؟') && setSt(v.id, 'deleted')() }, 'حذف')))));
}

const LV = { high: 'عالية', medium: 'متوسطة', low: 'منخفضة', small: 'صغير', large: 'كبير' };
function cardView(x) {
  const c = x.card, list = (t, a) => (a.length ? h('div', {}, h('b', {}, t), h('ul', {}, a.map((i) => h('li', {}, i)))) : null);
  return h('div', { class: 'card' }, h('div', { class: 'mute' }, x.request), h('p', {}, c.summary),
    h('div', {}, `الجدوى: ${LV[c.feasibility]} — الجهد: ${LV[c.effort] ?? c.effort}`), h('div', {}, c.impact),
    list('مخاطر', c.risks), list('قد تتأثر', c.conflicts), list('بدائل أفضل', c.better_alternatives),
    x.status === 'analyzed' ? h('div', { class: 'row' },
      h('button', { onclick: guard(async () => { const r = await api('POST', `/api/admin/copilot/${x.id}/decision`, { decision: 'approved' }); toast(r.note); render(); }) }, 'موافق'),
      h('button', { class: 'danger', onclick: guard(async () => { await api('POST', `/api/admin/copilot/${x.id}/decision`, { decision: 'rejected' }); render(); }) }, 'رفض')) : h('div', { class: 'mute' }, x.status === 'approved' ? '✔ معتمد — بانتظار التنفيذ' : '✖ مرفوض'));
}
async function copilotPane() {
  const t = h('input', { placeholder: 'صف الميزة التي تريدها...' });
  const list = await api('GET', '/api/admin/copilot');
  return h('div', {}, h('div', { class: 'card' }, h('div', { class: 'mute' }, 'يحلل المساعد الطلب ويعرض الجدوى والمخاطر. الاعتماد يسجّل الطلب فقط؛ التنفيذ والنشر يتمان بمراجعة مطوّر.'), t,
    h('button', { onclick: guard(async () => { const r = await api('POST', '/api/admin/copilot', { request: t.value }); toast(r.engine === 'llm' ? 'تم التحليل' : 'تحليل مبدئي (بدون نموذج لغوي)'); render(); }) }, 'حلّل')),
    list.map(cardView));
}

// ---------- vault: 10-wheel dial ----------
function dial() {
  const v = Array(10).fill(0), nums = [];
  const el = h('div', { class: 'dial' }, v.map((_, i) => { const b = h('b', {}, '0'); nums.push(b);
    return h('div', {}, h('button', { onclick: () => { v[i] = (v[i] + 1) % 10; b.textContent = v[i]; } }, '▲'), b, h('button', { onclick: () => { v[i] = (v[i] + 9) % 10; b.textContent = v[i]; } }, '▼')); }));
  return { el, value: () => v.join(''), reset: () => v.fill(0).forEach((_, i) => (nums[i].textContent = '0')) };
}
async function vaultPane() {
  if (st.vault) return vaultOpen();
  const d = dial(), box = h('div', {});
  const open = h('button', { onclick: guard(async () => { const r = await api('POST', '/api/vault/open', { code: d.value() }); st.vault = r.vault_token; render(); }) }, 'فتح الخزنة');
  const recover = h('button', { class: 'ghost', onclick: guard(async () => {
    const r = await api('POST', '/api/vault/recover', { code: d.value() }); const nd = dial(), cd = dial();
    box.replaceChildren(h('h4', {}, 'رمز الفتح الجديد'), nd.el, h('h4', {}, 'تأكيد الرمز'), cd.el, h('button', { onclick: guard(async () => { await api('POST', '/api/vault/change-open-code', { reset_token: r.reset_token, new_code: nd.value(), confirm_code: cd.value() }); toast('تم تغيير الرمز'); render(); }) }, 'حفظ'));
  }) }, 'استعادة / تغيير الرمز');
  const setup = h('button', { class: 'ghost', onclick: guard(async () => {
    const r1 = prompt('رمز الاستعادة (10 أرقام)'), r2 = prompt('رمز فتح الخزنة (10 أرقام)');
    if (r1 && r2) { await api('POST', '/api/vault/setup', { reset_code: r1, open_code: r2 }); toast('تم إعداد الخزنة'); }
  }) }, 'إعداد أولي');
  return h('div', { class: 'card' }, h('h3', {}, 'الخزنة المالية'), d.el, h('div', { class: 'row' }, open, recover, setup), box);
}
async function vaultOpen() {
  try {
    const f = await api('GET', '/api/vault/finance', null, { 'x-vault-token': st.vault });
    const stat = (t, v) => h('div', { class: 'card' }, h('div', { class: 'mute' }, t), h('div', { class: 'price' }, v));
    return h('div', {}, h('div', { class: 'grid' }, stat('الربح الصافي', money(f.net_app_profit)), stat('أرباح أبل', money(f.stores.apple)), stat('أرباح بلي', money(f.stores.google)), stat('عمولات التجار', money(f.from_vendors.commissions)),
      stat('اشتراكات التجار', money(f.from_vendors.subscriptions)), stat('مبيعات المتجر الرئيسي', money(f.main_store.direct_sales)), stat('قيمة المخزون', money(f.main_store.stock_value)), stat('أصناف مباعة', f.items.sold_units), stat('أصناف نفدت', f.items.sold_out)),
      h('button', { class: 'danger', onclick: () => { st.vault = null; render(); } }, 'إخفاء'));
  } catch (e) { st.vault = null; throw e; }
}

if ('serviceWorker' in navigator && !preview) navigator.serviceWorker.register('/sw.js').catch(() => {});
if (preview) { $('#banner').className = 'banner'; $('#banner').textContent = 'وضع المعاينة'; }
syncCatalog().then(flushQueue).then(() => (st.token ? flushDeliveries() : null)).then(render);
