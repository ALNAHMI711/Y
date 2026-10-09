# Browser end-to-end: driver sees the assigned route, collects COD, marks delivered; escrow starts for the order.
# Needs: pip install playwright && playwright install chromium. Run: python3 e2e/driver_test.py
import json, os, pathlib, re, subprocess, sys, tempfile, time, urllib.request
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
WORK = tempfile.mkdtemp(prefix='tw-drv-'); PORT = '3336'; BASE = f'http://localhost:{PORT}'
env = dict(os.environ, DATA_DIR=WORK + '/data', PORT=PORT, DEV_OTP='1', ADMIN_PHONE='967700000001')
srv = subprocess.Popen(['node', '--disable-warning=ExperimentalWarning', str(ROOT / 'server/src/index.js')], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(2)

def api(method, path, body=None, token=None):
    req = urllib.request.Request(BASE + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={'content-type': 'application/json', **({'authorization': f'Bearer {token}'} if token else {})})
    with urllib.request.urlopen(req) as r: return json.loads(r.read())
def token(phone, name):
    code = api('POST', '/api/auth/request-otp', {'phone': phone})['dev_code']
    return api('POST', '/api/auth/verify', {'phone': phone, 'code': code, 'name': name})['token']

errors, ok = [], []
def check(name, cond):
    ok.append(bool(cond)); print(('PASS ' if cond else 'FAIL ') + name)
try:
    admin = token('967700000001', 'مدير النظام الاول الرئيسي')
    zone = api('POST', '/api/admin/zones', {'name': 'صنعاء', 'fee': 1000}, admin)['id']
    pid = api('POST', '/api/admin/products', {'name': 'حقيبة ميدانية', 'price': 30000, 'stock': 3, 'cod_mode': 'full'}, admin)['id']
    cust = token('967755000111', 'عميل توصيل رباعي الاسم')
    addr = api('POST', '/api/addresses', {'label': 'المنزل', 'zone_id': zone, 'lat': 15.35, 'lng': 44.2, 'details': 'بجوار المسجد'}, cust)['id']
    order = api('POST', '/api/orders', {'address_id': addr, 'items': [{'product_id': pid, 'qty': 1}]}, cust)
    cust2 = token('967755000333', 'عميل ثاني رباعي الاسم')
    addr2 = api('POST', '/api/addresses', {'label': 'العمل', 'zone_id': zone, 'lat': 15.40, 'lng': 44.25, 'details': 'شارع الزبيري'}, cust2)['id']
    order2 = api('POST', '/api/orders', {'address_id': addr2, 'items': [{'product_id': pid, 'qty': 1}]}, cust2)
    drv = token('967766000222', 'مندوب توصيل رباعي الاسم'); drv_id = api('GET', '/api/me', None, drv)['id']
    api('POST', f'/api/admin/users/{drv_id}/role', {'role': 'driver'}, admin)
    api('POST', f'/api/admin/orders/{order["id"]}/assign', {'driver_id': drv_id}, admin)
    api('POST', f'/api/admin/orders/{order2["id"]}/assign', {'driver_id': drv_id}, admin)

    with sync_playwright() as p:
        b = p.chromium.launch(); ctx = b.new_context(viewport={'width': 420, 'height': 900}); pg = ctx.new_page()
        pg.on('pageerror', lambda e: errors.append(str(e)))
        pg.goto(BASE + '/')
        pg.fill('input[placeholder^="رقم الهاتف"]', '967766000222'); pg.fill('input[placeholder^="الاسم"]', 'مندوب توصيل رباعي الاسم')
        pg.click('text=إرسال رمز واتساب'); pg.wait_for_selector('#banner:has-text("رمز التجربة")')
        pg.fill('input[placeholder="رمز التحقق"]', re.search(r'(\d{6})', pg.inner_text('#banner')).group(1)); pg.click('button:has-text("تأكيد")')
        pg.wait_for_selector('nav button:has-text("المندوب")'); pg.click('nav button:has-text("المندوب")')
        pg.wait_for_selector('.card:has-text("عميل توصيل")')
        t = pg.inner_text('#app')
        check('driver sees stop with customer, address details and COD to collect', 'عميل توصيل' in t and 'بجوار المسجد' in t and 'تحصيل' in t)
        check('map link uses the customer coordinates', pg.get_attribute('a:has-text("فتح الخريطة")', 'href') == 'geo:15.35,44.2')
        check('route sketch shows 2 numbered stops', pg.locator('svg g circle').count() == 2)
        pg.locator('.card:has-text("عميل توصيل")').locator('button:has-text("تم التسليم")').click()
        pg.wait_for_function("() => !document.body.innerText.includes('عميل توصيل')")
        check('stop removed after online delivery', 'عميل توصيل' not in pg.inner_text('#app'))
        # offline: cached route stays usable, delivery is queued and synced on reconnect
        pg.reload(); pg.wait_for_selector('nav button:has-text("المندوب")'); pg.click('nav button:has-text("المندوب")'); pg.wait_for_selector('.card:has-text("عميل ثاني")')
        ctx.set_offline(True)
        pg.locator('.card:has-text("عميل ثاني")').locator('button:has-text("تم التسليم")').click()
        pg.wait_for_function("() => JSON.parse(localStorage.tw_deliveries||'[]').length===1")
        check('offline delivery queued locally and stop hidden', 'عميل ثاني' not in pg.inner_text('#app'))
        ctx.set_offline(False); pg.evaluate("window.dispatchEvent(new Event('online'))")
        pg.wait_for_function("() => JSON.parse(localStorage.tw_deliveries||'[]').length===0", timeout=10000)
        b.close()
    o = api('GET', '/api/orders', None, cust)[0]; o2 = api('GET', '/api/orders', None, cust2)[0]
    check('both orders delivered on server', o['status'] == 'delivered' and o2['status'] == 'delivered')
    check('stock decremented once per order (1 left of 3)', api('GET', '/api/products')[0]['stock'] == 1)
finally:
    srv.terminate()
check('no JS errors', not errors)
if errors: print(errors)
sys.exit(0 if all(ok) else 1)
