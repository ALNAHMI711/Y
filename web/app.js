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
  for (const o of q) { try { await api('POST', '/api/orders', o); } catch (e) { if (!navigator.onLine || e instanceof TypeError) rest.push(o); } }
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
  const views = { store: storeView, wallet: walletView, orders: ordersView, admin: adminView, driver: driverView };
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

// ---------- driver ----------
async function driverView() {
  const { stops } = await api('GET', '/api/driver/route');
  cache.set('tw_route', stops);
  const share = h('button', { onclick: () => navigator.geolocation?.getCurrentPosition((p) => api('POST', '/api/driver/location', { lat: p.coords.latitude, lng: p.coords.longitude }).then(() => toast('تم تحديث موقعك'))) }, 'مشاركة موقعي');
  return h('div', {}, share, stops.map((s, i) => h('div', { class: 'card' }, h('b', {}, `${i + 1}. ${s.customer}`), h('div', { class: 'mute' }, `${s.phone} — ${s.details ?? ''}`),
    s.cod_due ? h('div', { class: 'price' }, `تحصيل: ${money(s.cod_due)}`) : null,
    s.lat != null ? h('a', { class: 'btn', href: `geo:${s.lat},${s.lng}` }, 'فتح الخريطة') : null,
    h('button', { onclick: guard(async () => { await api('POST', `/api/driver/orders/${s.order_id}/deliver`); render(); }) }, 'تم التسليم'))));
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

// ---------- admin ----------
let adminTab = 'preview';
async function adminView() {
  const tabs = [['preview', 'المعاينة'], ['reports', 'التقارير'], ['features', 'الميزات'], ['catalog', 'المنتجات والمناطق'], ['transfers', 'التحويلات'], ['vault', 'الخزنة']];
  const bar = h('div', { class: 'row card' }, tabs.map(([k, l]) => h('button', { class: adminTab === k ? '' : 'ghost', onclick: () => { adminTab = k; render(); } }, l)));
  const pages = { preview: previewPane, reports: reportsPane, features: featuresPane, catalog: catalogPane, transfers: transfersPane, vault: vaultPane };
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
syncCatalog().then(flushQueue).then(render);
