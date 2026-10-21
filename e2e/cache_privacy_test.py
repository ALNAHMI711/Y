# Browser end-to-end: the service-worker cache must never keep per-user API responses (wallet, orders, addresses...).
# Needs: pip install playwright && playwright install chromium. Run: python3 e2e/cache_privacy_test.py
import json, os, pathlib, re, subprocess, sys, tempfile, time, urllib.request
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
# TW_SRC=<dir> tests another checkout (e.g. a clean `git archive HEAD` extract); default is this working tree.
ROOT = pathlib.Path(os.environ.get('TW_SRC', ROOT))
WORK = tempfile.mkdtemp(prefix='tw-priv-'); PORT = '3338'; BASE = f'http://localhost:{PORT}'
env = dict(os.environ, DATA_DIR=WORK + '/data', PORT=PORT, DEV_OTP='1', ADMIN_PHONE='967700000001')
srv = subprocess.Popen(['node', '--disable-warning=ExperimentalWarning', str(ROOT / 'server/src/index.js')], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(2)
PUBLIC = ('/api/features', '/api/zones', '/api/products', '/api/sync', '/api/announcements')
errors, ok = [], []
def check(name, cond):
    ok.append(bool(cond)); print(('PASS ' if cond else 'FAIL ') + name)
try:
    with sync_playwright() as p:
        b = p.chromium.launch(); pg = b.new_context(viewport={'width': 420, 'height': 900}).new_page()
        pg.on('pageerror', lambda e: errors.append(str(e)))
        pg.goto(BASE + '/')
        pg.fill('input[placeholder^="رقم الهاتف"]', '967711555111'); pg.fill('input[placeholder^="الاسم"]', 'عميل خصوصية رباعي الاسم')
        pg.click('text=إرسال رمز واتساب'); pg.wait_for_selector('#banner:has-text("رمز التجربة")')
        pg.fill('input[placeholder="رمز التحقق"]', re.search(r'(\d{6})', pg.inner_text('#banner')).group(1)); pg.click('button:has-text("تأكيد")')
        pg.wait_for_selector('nav button:has-text("المحفظة")')
        pg.reload(); pg.wait_for_selector('nav button:has-text("المحفظة")'); pg.wait_for_function("navigator.serviceWorker.controller !== null", timeout=10000)
        for tab in ('المحفظة', 'طلباتي', 'المتجر'):  # these views fetch /api/wallet, /api/orders, /api/addresses, /api/notifications...
            pg.click(f'nav button:has-text("{tab}")'); pg.wait_for_timeout(700)
        keys = pg.evaluate("caches.keys().then(async ns => (await Promise.all(ns.map(n => caches.open(n).then(c => c.keys())))).flat().map(k => new URL(k.url).pathname))")
        private = sorted({k for k in keys if k.startswith('/api/') and k not in PUBLIC})
        check('SW cache holds no per-user API data (found: %s)' % private, not private)
        check('SW cache still holds the app shell and public catalog', '/app.js' in keys and '/api/sync' in keys)
        b.close()
finally:
    srv.terminate()
check('no JS errors', not errors)
sys.exit(0 if all(ok) else 1)
