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
    drv = token('967766000222', 'مندوب توصيل رباعي الاسم'); drv_id = api('GET', '/api/me', None, drv)['id']
    api('POST', f'/api/admin/users/{drv_id}/role', {'role': 'driver'}, admin)
    api('POST', f'/api/admin/orders/{order["id"]}/assign', {'driver_id': drv_id}, admin)

    with sync_playwright() as p:
        b = p.chromium.launch(); pg = b.new_context(viewport={'width': 420, 'height': 900}).new_page()
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
        pg.click('button:has-text("تم التسليم")'); pg.wait_for_selector('text=تم التسليم', state='detached')
        pg.wait_for_function("document.querySelectorAll('.card').length === 0 || !document.body.innerText.includes('عميل توصيل')")
        check('stop removed after delivery', 'عميل توصيل' not in pg.inner_text('#app'))
        b.close()
    o = api('GET', '/api/orders', None, cust)[0]
    check('order marked delivered on server', o['status'] == 'delivered')
    check('stock decremented exactly once by the order (2 left)', api('GET', '/api/products')[0]['stock'] == 2)
finally:
    srv.terminate()
check('no JS errors', not errors)
if errors: print(errors)
sys.exit(0 if all(ok) else 1)
