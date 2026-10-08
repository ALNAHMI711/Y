# Browser end-to-end: customer journey incl. COD order and offline order queue.
# Needs: pip install playwright && playwright install chromium. Run: python3 e2e/customer_test.py
import json, os, pathlib, re, subprocess, sys, tempfile, time, urllib.request
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
WORK = tempfile.mkdtemp(prefix='tw-cust-'); PORT = '3334'; BASE = f'http://localhost:{PORT}'
env = dict(os.environ, DATA_DIR=WORK + '/data', PORT=PORT, DEV_OTP='1', ADMIN_PHONE='967700000001')
srv = subprocess.Popen(['node', '--disable-warning=ExperimentalWarning', str(ROOT / 'server/src/index.js')], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(2)

def api(method, path, body=None, token=None):
    req = urllib.request.Request(BASE + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={'content-type': 'application/json', **({'authorization': f'Bearer {token}'} if token else {})})
    with urllib.request.urlopen(req) as r: return json.loads(r.read())

errors, ok = [], []
def check(name, cond):
    ok.append((name, bool(cond))); print(('PASS ' if cond else 'FAIL ') + name)

try:
    code = api('POST', '/api/auth/request-otp', {'phone': '967700000001'})['dev_code']
    admin = api('POST', '/api/auth/verify', {'phone': '967700000001', 'code': code, 'name': 'مدير النظام الاول الرئيسي'})['token']
    api('POST', '/api/admin/zones', {'name': 'صنعاء', 'fee': 1000}, admin)
    api('POST', '/api/admin/products', {'name': 'حذاء ميداني', 'price': 20000, 'stock': 5, 'cod_mode': 'full'}, admin)

    with sync_playwright() as p:
        b = p.chromium.launch(); ctx = b.new_context(viewport={'width': 420, 'height': 900}); pg = ctx.new_page()
        pg.on('pageerror', lambda e: errors.append(f'pageerror: {e}'))
        pg.goto(BASE + '/')
        pg.fill('input[placeholder^="رقم الهاتف"]', '967711000111'); pg.fill('input[placeholder^="الاسم"]', 'عميل تجربة رباعي الاسم')
        pg.click('text=إرسال رمز واتساب'); pg.wait_for_selector('#banner:has-text("رمز التجربة")')
        pg.fill('input[placeholder="رمز التحقق"]', re.search(r'(\d{6})', pg.inner_text('#banner')).group(1)); pg.click('button:has-text("تأكيد")')
        pg.wait_for_selector('.grid .card')
        check('customer sees store, no admin tab', 'الإدارة' not in pg.inner_text('#nav'))

        pg.click('.grid .card button:has-text("أضف")'); pg.wait_for_selector('h3:has-text("السلة")')
        pg.fill('input[placeholder^="اسم عنوان"]', 'المنزل'); pg.click('button:has-text("حفظ العنوان")')
        pg.wait_for_selector('select option:text("المنزل")', state='attached')
        pg.wait_for_selector('.mute:has-text("توصيل")')
        check('quote shows shipping 1000 and total 21000', re.search(r'١٬٠٠٠|1,000|١٠٠٠', pg.inner_text('.mute:has-text("توصيل")')) is not None and re.search(r'٢١|21', pg.inner_text('.mute:has-text("توصيل")')) is not None)

        pg.click('button:has-text("تأكيد الطلب")'); pg.wait_for_selector('.card:has-text("طلب #")')
        txt = pg.inner_text('#app')
        check('order created and COD amount shown', 'طلب #' in txt and 'عند الاستلام' in txt)
        o = api('GET', '/api/orders', None, api('POST', '/api/auth/verify', {'phone': '967711000111', 'code': api('POST', '/api/auth/request-otp', {'phone': '967711000111'})['dev_code']})['token'])
        check('server has exactly 1 order, total 21000, cod_due 21000', len(o) == 1 and o[0]['total'] == 21000 and o[0]['cod_due'] == 21000)

        # offline: build the cart while online, drop the network, confirm -> queued; reconnect -> synced
        pg.click('nav button:has-text("المتجر")'); pg.wait_for_selector('.grid .card')
        pg.click('.grid .card button:has-text("أضف")'); pg.wait_for_selector('h3:has-text("السلة")'); pg.wait_for_selector('.mute:has-text("توصيل")')
        ctx.set_offline(True)
        pg.click('button:has-text("تأكيد الطلب")'); pg.wait_for_function("JSON.parse(localStorage.tw_queue||'[]').length===1")
        check('offline order queued locally', True)
        ctx.set_offline(False); pg.evaluate("window.dispatchEvent(new Event('online'))")
        pg.wait_for_function("JSON.parse(localStorage.tw_queue||'[]').length===0", timeout=10000)
        tok = api('POST', '/api/auth/verify', {'phone': '967711000111', 'code': api('POST', '/api/auth/request-otp', {'phone': '967711000111'})['dev_code']})['token']
        o2 = api('GET', '/api/orders', None, tok)
        check('queued order synced exactly once (2 orders, stock 3)', len(o2) == 2 and api('GET', '/api/products')[0]['stock'] == 3)
        b.close()
finally:
    srv.terminate()
check('no JS errors', not errors)
if errors: print(errors)
sys.exit(0 if all(c for _, c in ok) else 1)
