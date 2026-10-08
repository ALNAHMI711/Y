# Browser end-to-end: vendor registers (contract + ID photos) -> admin reviews & activates -> vendor adds wallet account + product -> product visible in store.
# Needs: pip install playwright && playwright install chromium. Run: python3 e2e/vendor_test.py
import json, os, pathlib, re, struct, subprocess, sys, tempfile, time, urllib.request, zlib
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
WORK = tempfile.mkdtemp(prefix='tw-vend-'); PORT = '3335'; BASE = f'http://localhost:{PORT}'
env = dict(os.environ, DATA_DIR=WORK + '/data', PORT=PORT, DEV_OTP='1', ADMIN_PHONE='967700000001')
srv = subprocess.Popen(['node', '--disable-warning=ExperimentalWarning', str(ROOT / 'server/src/index.js')], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(2)
errors, ok = [], []
def check(name, cond):
    ok.append(bool(cond)); print(('PASS ' if cond else 'FAIL ') + name)
def png(path, w=120, h=80):
    raw = b''.join(b'\x00' + bytes([90, 120, 60]) * w for _ in range(h))
    ch = lambda t, d: struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    open(path, 'wb').write(b'\x89PNG\r\n\x1a\n' + ch(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + ch(b'IDAT', zlib.compress(raw)) + ch(b'IEND', b''))
png(WORK + '/id.png')

def login(pg, phone, name):
    pg.goto(BASE + '/')
    pg.fill('input[placeholder^="رقم الهاتف"]', phone); pg.fill('input[placeholder^="الاسم"]', name)
    pg.click('text=إرسال رمز واتساب'); pg.wait_for_selector('#banner:has-text("رمز التجربة")')
    pg.fill('input[placeholder="رمز التحقق"]', re.search(r'(\d{6})', pg.inner_text('#banner')).group(1)); pg.click('button:has-text("تأكيد")')
    pg.wait_for_selector('nav button:has-text("خروج")')

try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        v = b.new_context(viewport={'width': 420, 'height': 900}).new_page(); a = b.new_context(viewport={'width': 420, 'height': 900}).new_page()
        c = b.new_context(viewport={'width': 420, 'height': 900}).new_page()
        for pg in (v, a, c): pg.on('pageerror', lambda e: errors.append(str(e)))

        login(v, '967733000111', 'تاجر تجربة رباعي الاسم')
        v.click('nav button:has-text("التاجر")'); v.wait_for_selector('h3:has-text("تسجيل متجر")')
        v.fill('input[placeholder="الاسم الرباعي"]', 'تاجر تجربة رباعي الاسم'); v.fill('input[placeholder="اسم المحل"]', 'محل النخبة'); v.fill('input[placeholder="موقع المحل"]', 'صنعاء - شارع الستين')
        v.fill('input[placeholder="رقم البطاقة الشخصية"]', '01234567'); v.fill('input[placeholder^="التوقيع"]', 'تاجر تجربة رباعي الاسم')
        files = v.locator('input[type=file]')
        files.nth(0).set_input_files(WORK + '/id.png'); v.wait_for_selector('#banner:has-text("الصورة")'); files.nth(1).set_input_files(WORK + '/id.png'); v.wait_for_timeout(600)
        v.click('button:has-text("إرسال العقد")'); v.wait_for_selector('#banner:has-text("أُرسل العقد")')
        check('contract submitted', True)

        login(a, '967700000001', 'مدير النظام الاول الرئيسي'); a.click('nav button:has-text("الإدارة")'); a.click('button:text-is("التجار")')
        a.wait_for_selector('.card:has-text("محل النخبة")'); check('admin sees pending vendor', 'قيد المراجعة' in a.inner_text('#app'))
        seen = []; a.once('dialog', lambda d: (seen.append(d.message), d.accept()))
        a.click('button:has-text("عرض العقد")'); a.wait_for_timeout(800)
        check('encrypted contract decrypts for admin (id number visible)', seen and '01234567' in seen[0])
        a.click('button:text-is("تفعيل")'); a.wait_for_selector('.card:has-text("مفعّل")')
        check('vendor activated', True)

        v.reload(); v.wait_for_selector('nav button:has-text("التاجر")'); v.click('nav button:has-text("التاجر")'); v.wait_for_selector('h3:has-text("محل النخبة")')
        v.fill('input[placeholder^="المحفظة"]', 'جيب'); v.fill('input[placeholder="رقم الحساب"]', '777000111'); v.click('button:has-text("إضافة حساب")')
        v.wait_for_selector('text=جيب: 777000111')
        v.fill('.card:has(h4:text-is("منتج جديد")) input[placeholder="اسم المنتج"]', 'قبعة النخبة'); v.fill('.card:has(h4:text-is("منتج جديد")) input[placeholder="السعر"]', '9000'); v.fill('.card:has(h4:text-is("منتج جديد")) input[placeholder="المخزون"]', '6')
        v.click('.card:has(h4:text-is("منتج جديد")) button:text-is("إضافة")'); v.wait_for_selector('#banner:has-text("أضيف")')
        check('vendor wallet account saved', True)

        login(c, '967744000222', 'عميل تجربة رباعي الاسم'); c.wait_for_selector('.grid .card')
        check('vendor product visible to customers', 'قبعة النخبة' in c.inner_text('.grid'))
        b.close()
finally:
    srv.terminate()
check('no JS errors', not errors)
if errors: print(errors)
sys.exit(0 if all(ok) else 1)
