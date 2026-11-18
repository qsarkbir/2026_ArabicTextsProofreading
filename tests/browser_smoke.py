"""Optional real-browser checks: pip install playwright; python -m tests.browser_smoke."""
import base64
import io
import json
import os
import re
import signal
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

from playwright.sync_api import sync_playwright, expect
from tests.preview_server import synthetic_pdf, jpx_pdf, flate_pdf

BLANK_FLAG = '''async ([b64, off]) => { globalThis.PDF_NO_ASSETS = off; const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0)); const url = URL.createObjectURL(new Blob([bytes], {type: 'application/pdf'}));
    try { return (await renderPdfPage(url, 0, 600)).dataset.blank || null; } finally { globalThis.PDF_NO_ASSETS = false; await releasePdf(url); URL.revokeObjectURL(url); } }'''


def main():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    base = f'http://127.0.0.1:{port}'
    process = subprocess.Popen([sys.executable, '-m', 'tests.preview_server'],
                               env={**os.environ, 'PROOF_PREVIEW_PORT':str(port)},
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(100):
            try:
                with urllib.request.urlopen(base + '/api/projects', timeout=1):
                    break
            except OSError:
                time.sleep(.1)
        else:
            raise RuntimeError('Fixture server did not start')
        with tempfile.TemporaryDirectory() as tmp, sync_playwright() as pw:
            proxy = os.environ.get('HTTPS_PROXY')
            browser = pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium') or pw.chromium.executable_path,
                                         headless=True, args=['--no-sandbox'],
                                         proxy={'server':proxy, 'bypass':'127.0.0.1,localhost'} if proxy else None)
            context = browser.new_context(accept_downloads=True)
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.on('console', lambda m: errors.append(m.text) if 'Content Security Policy' in m.text else None)
            wasm = []
            page.on('response', lambda r: wasm.append((r.url.rsplit('/', 1)[-1], r.status, r.headers.get('content-type'))) if '.wasm' in r.url else None)
            page.goto(base + '/#/p/ui-fixture/0')
            editor = page.get_by_role('textbox', name='校正テキスト', exact=True)
            expect(editor).to_be_enabled()
            editor.fill('alpha edited beta')
            expect(page.get_by_role('button', name='保存を再試行')).to_be_visible()
            page.get_by_role('button', name='保存を再試行').click()
            expect(page.locator('#saved')).to_have_text('保存済み')
            page.reload()
            expect(editor).to_have_value('alpha edited beta')
            print('PASS save failure, retry and reload', flush=True)

            other = context.new_page()
            other.goto(base + '/#/p/ui-fixture/0')
            other_editor = other.get_by_role('textbox', name='校正テキスト', exact=True)
            expect(other_editor).to_have_value('alpha edited beta')
            editor.fill('first tab wins')
            expect(page.locator('#saved')).to_have_text('保存済み')
            other_editor.fill('stale tab edit')
            expect(other.get_by_role('button', name='保存を再試行')).to_be_visible()
            expect(other.locator('#toast')).to_contain_text('別のタブ')
            other.close()
            page.reload()
            expect(editor).to_have_value('first tab wins')
            print('PASS stale tab conflict', flush=True)

            # saves within a few minutes share one entry: the latest is the text before this burst of edits
            page.get_by_role('button', name='保存履歴', exact=True).click()
            expect(page.locator('dialog .history-preview')).to_have_text('alpha beta')
            page.get_by_role('button', name='この本文を復元').click()
            expect(editor).to_have_value(re.compile(r'^\s*alpha beta\s*$'))
            expect(page.locator('#saved')).to_have_text('保存済み')
            page.get_by_role('button', name='保存履歴', exact=True).click()
            expect(page.locator('dialog .history-preview')).to_have_text('first tab wins')
            page.locator('dialog').get_by_role('button', name='閉じる').click()
            print('PASS persistent history restoration', flush=True)

            page.get_by_label('AI提供元').select_option('openai')
            expect(page.locator('#ocrm')).to_have_value('fixture-model')
            expect(page.locator('#ocrmsel')).to_be_hidden()
            page.get_by_role('button', name='読み直す', exact=True).click()
            expect(page.locator('#ocrmsg')).to_contain_text('fixture-model')
            expect(page.locator('#readings option')).to_have_count(3)
            editor.fill('wrong %~% bad beta extra')
            expect(page.locator('#diff .chip').first).to_be_disabled()
            editor.fill('alpha beta extra')
            expect(page.locator('#diff .nodiff')).to_contain_text('AIの読みと本文は一致しています')
            expect(page.locator('#ocrmsg')).to_contain_text('食い違いなし')
            print('PASS provider selection, reading archive and markup protection', flush=True)

            page.get_by_role('link', name='OpenITI 校正', exact=True).click()
            page.get_by_role('link', name='OpenITIにないテキストをPDFから作成する').click()
            pdf = Path(tmp) / 'fixture.pdf'
            pdf.write_bytes(synthetic_pdf(3))
            page.get_by_label('書名', exact=True).fill('Synthetic edition')
            page.get_by_label('著者', exact=True).fill('Synthetic author')
            page.get_by_label('底本（版・出版者・出版年）').fill('Synthetic publisher, 2026')
            page.get_by_label('利用・公開条件').fill('Test data only')
            page.locator('#draftpdf').set_input_files(str(pdf))
            expect(page.locator('#pdfcount')).to_contain_text('3ページ', timeout=60000)
            page.get_by_label('最初の本文画像（PDFの通し番号）').fill('2')
            page.get_by_label('最初の印刷ページ番号').fill('10')
            page.get_by_role('button', name='校正を始める').click()
            expect(editor).to_be_enabled(timeout=30000)
            expect(page.locator('#psel')).to_have_value('V01P010')
            expect(page.locator('#imgview canvas')).to_be_visible(timeout=60000)
            editor.fill('# نص تجريبي\n~~ تتمة النص\n')
            expect(page.locator('#saved')).to_have_text('保存済み')
            print('PASS PDF import, page mapping and PDF.js rendering', flush=True)

            page.get_by_role('button', name='書誌', exact=True).click()
            expect(page.get_by_label('著者', exact=True)).to_have_value('Synthetic author')
            page.get_by_label('著者', exact=True).fill('Updated author')
            page.get_by_role('button', name='保存', exact=True).click()
            expect(page.locator('dialog[open]')).to_have_count(0)
            page.get_by_role('button', name='書き出し', exact=True).click()
            with page.expect_download() as downloaded:
                page.get_by_role('button', name='TEI XML（基本構造）').click()
            root = ET.parse(downloaded.value.path()).getroot()
            ns = {'t':'http://www.tei-c.org/ns/1.0'}
            assert root.find('.//t:author', ns).text == 'Updated author'
            assert root.find('.//t:pb', ns).get('n') == '10'
            assert 'نص تجريبي' in ''.join(root.find('.//t:body', ns).itertext())
            with page.expect_download() as downloaded:
                page.get_by_role('button', name='本文・書誌パッケージ（ZIP）').click()
            with zipfile.ZipFile(downloaded.value.path()) as archive:
                assert 'Updated author' in archive.read('bibliography.json').decode()
            with page.expect_download() as downloaded:
                page.get_by_role('button', name='バックアップを書き出す（.proofreader.json）').click()
            assert downloaded.value.suggested_filename.endswith('.proofreader.json')
            backup = json.loads(Path(downloaded.value.path()).read_text(encoding='utf-8'))
            assert backup['app']['mode'] == 'http' and backup['project']['author'] == 'Updated author'
            assert backup['work']['edits'] and 'نص تجريبي' in list(backup['work']['edits'].values())[0]
            backup['project']['source'] = None  # PDFs are not part of a backup: a restored project goes to setup to attach one
            restored = Path(tmp) / 'restored.proofreader.json'
            restored.write_text(json.dumps(backup, ensure_ascii=False), encoding='utf-8')
            page.goto(base + '/')
            page.locator('#bundle').set_input_files(str(restored))
            expect(page).to_have_url(re.compile(r'#/p/[^/]+_2/setup$'))
            page.goto(base + '/')
            expect(page.locator('tbody tr', has_text='Updated author')).to_have_count(2)
            print('PASS bibliography, TEI, ZIP and backup downloads; backup import', flush=True)
            # a scanned book: one JPEG 2000 image per page needs pdf.js's WebAssembly decoder (vendor/pdfjs/6.5.438/wasm/)
            page.goto(base + '/')
            page.get_by_role('link', name='OpenITIにないテキストをPDFから作成する').click()
            jpx = Path(tmp) / 'scan.pdf'
            jpx.write_bytes(jpx_pdf(2))
            page.get_by_label('書名', exact=True).fill('Scanned edition')
            page.get_by_label('著者', exact=True).fill('Scanned author')
            page.get_by_label('底本（版・出版者・出版年）').fill('Synthetic publisher, 2026')
            page.get_by_label('利用・公開条件').fill('Test data only')
            page.locator('#draftpdf').set_input_files(str(jpx))
            expect(page.locator('#pdfcount')).to_contain_text('2ページ', timeout=60000)
            page.get_by_role('button', name='校正を始める').click()
            expect(editor).to_be_enabled(timeout=30000)
            expect(page.locator('#imgview canvas')).to_be_visible(timeout=60000)
            dark = page.evaluate('''() => { const c = document.querySelector('#imgview canvas'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 100) n++; return n; }''')
            assert dark > 1000, f'JPEG 2000 page rendered blank ({dark} dark pixels)'
            assert ('openjpeg.wasm', 200, 'application/wasm') in wasm, wasm
            print('PASS scanned PDF (JPEG 2000) renders through the vendored WebAssembly decoder', flush=True)
            flag = lambda data, off=False: page.evaluate(BLANK_FLAG, [base64.b64encode(data).decode(), off])
            assert flag(flate_pdf(True)) is None, 'a page with sparse ink (a page number) is not blank'
            assert flag(jpx_pdf(1)) is None
            assert flag(flate_pdf(False)) == '1' and flag(jpx_pdf(1), True) == '1'  # a blank verso and a JPEG 2000 page without decoders are flagged (a note, not an error)
            print('PASS blank-page detection: sparse ink is not flagged; blank and undecodable pages get a note', flush=True)

            # deleting: cancel keeps everything, a typed confirmation removes the project and its folder (PROOF_DATA is the fixture server's, so check through the API)
            slugs = lambda: [p['slug'] for p in page.evaluate("api('GET', '/api/projects')")]
            before = slugs()
            page.goto(base + '/')
            row = page.locator('tbody tr', has_text='Scanned author')
            row.get_by_role('button', name='削除').click()
            dialog = page.locator('dialog.delete-dialog')
            expect(dialog).to_contain_text('元に戻すことはできません')
            expect(dialog).to_contain_text('バックアップ')
            expect(dialog.locator('#delgo')).to_be_disabled()
            dialog.locator('#delword').fill('削')
            expect(dialog.locator('#delgo')).to_be_disabled()
            dialog.get_by_role('button', name='キャンセル').click()
            expect(page.locator('dialog.delete-dialog')).to_have_count(0)
            assert slugs() == before
            row.get_by_role('button', name='削除').click()
            with page.expect_download() as saved:
                dialog.get_by_role('button', name='バックアップを書き出す').click()
            assert saved.value.suggested_filename.endswith('.proofreader.json')
            dialog.locator('#delword').fill('削除')
            dialog.locator('#delgo').click()
            expect(page.locator('dialog.delete-dialog')).to_have_count(0)
            expect(page.locator('tbody tr', has_text='Scanned author')).to_have_count(0)
            after = slugs()
            assert len(after) == len(before) - 1, (before, after)
            gone = (set(before) - set(after)).pop()
            assert page.evaluate("slug => api('GET', '/api/projects/' + slug).then(() => 'found', e => e.message)", gone) == '見つかりません'
            page.reload()
            expect(page.locator('tbody tr', has_text='Scanned author')).to_have_count(0)
            print('PASS project deletion: cancel keeps it, confirmation removes it', flush=True)
            assert not errors, errors
            browser.close()
    finally:
        process.send_signal(signal.SIGINT)
        process.wait(timeout=10)


if __name__ == '__main__':
    main()
