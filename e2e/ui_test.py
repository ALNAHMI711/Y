# Browser end-to-end test: login -> admin -> product with image processor -> store -> health meter -> vault.
# Needs: pip install playwright && playwright install chromium. Run: python3 e2e/ui_test.py
import re, sys, subprocess, time, os, shutil, tempfile, pathlib
ROOT = pathlib.Path(__file__).resolve().parent.parent
WORK = tempfile.mkdtemp(prefix='tw-e2e-'); os.chdir(WORK)  # screenshots + temp png land here
from playwright.sync_api import sync_playwright

data = os.path.join(WORK, 'data')
env = dict(os.environ, DATA_DIR=data, PORT='3333', DEV_OTP='1', ADMIN_PHONE='967700000001')
srv = subprocess.Popen(['node','--disable-warning=ExperimentalWarning',str(ROOT / 'server/src/index.js')], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
time.sleep(2)
errors = []
try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={'width':420,'height':900})
        pg.on('pageerror', lambda e: errors.append(f'pageerror: {e}'))
        pg.on('console', lambda m: errors.append(f'console.{m.type}: {m.text}') if m.type in ('error',) else None)
        pg.goto('http://localhost:3333/')
        pg.wait_for_selector('input[placeholder^="رقم الهاتف"]')
        pg.fill('input[placeholder^="رقم الهاتف"]', '967700000001')
        pg.fill('input[placeholder^="الاسم"]', 'مدير النظام الاول الرئيسي')
        pg.click('text=إرسال رمز واتساب')
        pg.wait_for_selector('#banner:has-text("رمز التجربة")')
        code = re.search(r'(\d{6})', pg.inner_text('#banner')).group(1)
        pg.fill('input[placeholder="رمز التحقق"]', code); pg.click('button:has-text("تأكيد")')
        pg.wait_for_selector('nav button:has-text("الإدارة")')
        print('login ok; nav =', pg.inner_text('#nav').replace('\n',' | '))
        pg.click('nav button:has-text("الإدارة")')
        pg.wait_for_selector('iframe')
        pg.screenshot(path='admin_preview.png')
        # add zone + product through the admin UI
        pg.click('button:has-text("المنتجات والمناطق")')
        pg.fill('input[placeholder="اسم المنطقة"]', 'صنعاء'); pg.fill('input[placeholder^="سعر التوصيل"]', '1000'); pg.click('button:text-is("حفظ")')
        pg.wait_for_selector('input[placeholder="اسم المنتج"]')
        pg.fill('input[placeholder="اسم المنتج"]', 'قبعة ميدانية'); pg.fill('input[placeholder="السعر"]', '15000'); pg.fill('input[placeholder="المخزون"]', '4')
        # real image through the processor
        import base64, struct, zlib
        def png(w,h):
            raw = b''.join(b'\x00'+bytes([200,50,50])*w for _ in range(h))
            ch = lambda t,d: struct.pack('>I',len(d))+t+d+struct.pack('>I',zlib.crc32(t+d)&0xffffffff)
            return b'\x89PNG\r\n\x1a\n'+ch(b'IHDR',struct.pack('>IIBBBBB',w,h,8,2,0,0,0))+ch(b'IDAT',zlib.compress(raw))+ch(b'IEND',b'')
        open('t.png','wb').write(png(300,200))
        pg.set_input_files('input[type=file]', 't.png'); pg.wait_for_selector('#banner:has-text("الصورة")')
        pg.click('button:has-text("إضافة")'); pg.wait_for_selector('#banner:has-text("تم")')
        # store shows it with image
        pg.click('nav button:has-text("المتجر")'); pg.wait_for_selector('.grid .card img')
        print('store product with processed image: ok')
        pg.screenshot(path='store.png')
        # reports + health meter
        pg.click('nav button:has-text("الإدارة")'); pg.click('button:has-text("التقارير")'); pg.wait_for_selector('.meter')
        print('health meter:', pg.inner_text('.meter').strip(), '| class =', pg.get_attribute('.meter','class'))
        # vault: setup via prompts, open with dial
        pg.click('button:has-text("الخزنة")'); pg.wait_for_selector('.dial')
        answers = iter(['1111111111','2222222222'])
        pg.on('dialog', lambda d: d.accept(next(answers, '')))
        pg.click('button:has-text("إعداد أولي")'); pg.wait_for_selector('#banner:has-text("تم إعداد الخزنة")')
        for _ in range(2):  # spin every wheel to 2 : press ▲ twice per wheel
            for i in range(10): pg.locator('.dial > div').nth(i).locator('button').first.click()
        vals = pg.locator('.dial b').all_inner_texts(); print('dial shows', ''.join(vals))
        pg.click('button:has-text("فتح الخزنة")'); pg.wait_for_selector('text=الربح الصافي')
        print('vault opened with 2222222222: ok')
        pg.screenshot(path='vault.png')
        pg.click('button:has-text("إخفاء")'); pg.wait_for_selector('.dial'); print('vault hidden/relocked: ok')
        b.close()
finally:
    srv.terminate()
print('JS errors:', errors or 'none'); print('screenshots in', WORK)
sys.exit(1 if errors else 0)
