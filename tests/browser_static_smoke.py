"""Browser-mode checks on plain static files, no Python API: pip install playwright; python -m tests.browser_static_smoke.

OpenITI requests are answered with synthetic text through page.route; real OpenITI text is never used.
"""
import functools
import http.server
import os
import re
import shutil
import tempfile
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright, expect

STATIC = Path(__file__).resolve().parent.parent / 'proofreader' / 'static'
URI = '0999SyntheticAuthor.SyntheticBook.Test0001-ara1'
# CRLF line ends and a BOM on purpose: unedited pages must come back byte for byte
OPENITI = ('﻿######OpenITI#\r\n\r\n#META# 000.SortField :: Synthetic\r\n#META#Header#End#\r\n\r\n'
           '# alpha beta gamma PageV01P001\r\n# delta epsilon\r\n~~ zeta eta PageV01P002\r\n# theta iota PageV02P001\r\n')
UPLOAD = '﻿#META#Header#End#\r\nuploaded one PageV01P001\r\nuploaded two\r\nPageV01P002\r\n'
BOOK_YML = '10#BOOK#TITLEA#AR####: كتاب تجريبي\n'


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def fulfill(route):
    url = route.request.url
    cors = {'access-control-allow-origin': '*'}
    if url.endswith('.SyntheticBook.yml'):
        return route.fulfill(status=200, body=BOOK_YML, content_type='text/plain; charset=utf-8', headers=cors)
    if url.endswith('.yml'):
        return route.fulfill(status=404, body='', headers=cors)
    if url.endswith(URI):
        return route.fulfill(status=200, body=OPENITI.encode('utf-8'), content_type='text/plain; charset=utf-8', headers=cors)
    return route.fulfill(status=404, body='', headers=cors)


def main():
    handler = functools.partial(Quiet, directory=str(STATIC))
    httpd = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{httpd.server_address[1]}'
    try:
        with tempfile.TemporaryDirectory() as tmp, sync_playwright() as pw:
            proxy = os.environ.get('HTTPS_PROXY')
            browser = pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium') or pw.chromium.executable_path,
                                         headless=True, args=['--no-sandbox'],
                                         proxy={'server': proxy, 'bypass': '127.0.0.1,localhost'} if proxy else None)
            context = browser.new_context(accept_downloads=True)
            context.route('https://raw.githubusercontent.com/**', fulfill)
            page = context.new_page()
            errors, api_calls = [], []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.on('request', lambda request: api_calls.append(request.url) if '/api/' in request.url else None)
            editor = page.get_by_role('textbox', name='校正テキスト', exact=True)

            page.goto(base + '/')
            assert page.evaluate('PROOF_MODE') == 'browser'
            expect(page.get_by_role('button', name='読み込む')).to_be_visible()
            expect(page.get_by_role('button', name='アプリを終了')).to_be_hidden()
            expect(page.get_by_role('link', name='OpenITIにないテキストをPDFから作成する')).to_be_hidden()
            unsupported = page.evaluate("api('GET', '/api/ia/search?q=x').then(() => 'no error', e => e.status + ' ' + e.message)")
            assert unsupported == '501 この機能はローカル版で利用できます', unsupported
            print('PASS browser mode home hides server-only features', flush=True)

            page.locator('#ref').fill('not a uri')
            page.get_by_role('button', name='読み込む').click()
            expect(page.locator('#toast')).to_contain_text('OpenITIのバージョンURI')
            page.locator('#ref').fill(URI)
            page.get_by_role('button', name='読み込む').click()
            expect(editor).to_be_enabled(timeout=15000)
            slug = re.search(r'#/p/([^/]+)/0', page.url).group(1)
            assert slug == URI, slug
            expect(page.locator('#psel')).to_have_value('V01P001')
            expect(editor).to_have_value(re.compile(r'alpha beta gamma'))
            print('PASS project from OpenITI URI', flush=True)

            for name, visible in (('資料・ページ対応', False), ('比較の設定', False), ('書誌', True)):
                button = page.get_by_role('button', name=name, exact=True) if visible else page.get_by_text(name, exact=True)
                expect(button).to_be_visible() if visible else expect(button).to_be_hidden()
            expect(page.get_by_role('button', name='AIで読み取る')).to_be_hidden()
            page.get_by_role('button', name='書き出し', exact=True).click()
            expect(page.get_by_role('button', name='校正済みテキスト（OpenITI形式）')).to_be_visible()
            for name in ('TEI XML（基本構造）', '本文・書誌パッケージ（ZIP）', '元テキストとの差分（.diff）'):
                expect(page.get_by_role('button', name=name)).to_be_hidden()
            page.get_by_role('button', name='書き出し', exact=True).click()
            print('PASS unsupported buttons are hidden', flush=True)

            editor.fill('edited alpha')
            page.locator('#done').check()
            page.locator('#note').fill('synthetic note')
            expect(page.locator('#saved')).to_have_text('保存済み')
            page.reload()
            expect(editor).to_have_value('edited alpha')
            expect(page.locator('#done')).to_be_checked()
            expect(page.locator('#note')).to_have_value('synthetic note')
            print('PASS save and persistence across reload', flush=True)

            other = context.new_page()
            other.goto(base + f'/#/p/{slug}/0')
            other_editor = other.get_by_role('textbox', name='校正テキスト', exact=True)
            expect(other_editor).to_have_value('edited alpha')
            editor.fill('first tab wins')
            expect(page.locator('#saved')).to_have_text('保存済み')
            other_editor.fill('stale tab edit')
            expect(other.get_by_role('button', name='保存を再試行')).to_be_visible()
            expect(other.locator('#toast')).to_contain_text('別のタブ')
            other.close()
            page.reload()
            expect(editor).to_have_value('first tab wins')
            print('PASS stale tab conflict', flush=True)

            page.get_by_role('button', name='保存履歴', exact=True).click()
            expect(page.locator('dialog .history-preview')).to_have_text(re.compile(r'^\s*# alpha beta gamma\s*$'))
            page.get_by_role('button', name='この本文を復元').click()
            expect(editor).to_have_value(re.compile(r'^\s*# alpha beta gamma\s*$'))
            expect(page.locator('#saved')).to_have_text('保存済み')
            page.get_by_role('button', name='保存履歴', exact=True).click()
            expect(page.locator('dialog .history-preview')).to_have_text('first tab wins')
            page.locator('dialog').get_by_role('button', name='閉じる').click()
            print('PASS history and restore', flush=True)

            editor.fill('searchable needle')
            expect(page.locator('#saved')).to_have_text('保存済み')
            page.get_by_role('button', name='ページを探す').click()
            page.locator('#findq').fill('NEEDLE')
            page.get_by_role('button', name='検索', exact=True).click()
            expect(page.locator('#findresults')).to_contain_text('1ページ')
            expect(page.locator('#findresults button')).to_have_text(re.compile('PageV01P001'))
            page.locator('#findfilter').select_option('noted')
            page.get_by_role('button', name='検索', exact=True).click()
            expect(page.locator('#findresults')).to_contain_text('synthetic note')
            page.get_by_role('button', name='閉じる').first.click()
            print('PASS search', flush=True)

            page.get_by_role('button', name='書誌', exact=True).click()
            page.get_by_label('書名', exact=True).fill('Edited title')
            page.get_by_role('button', name='保存', exact=True).click()
            expect(page.locator('dialog[open]')).to_have_count(0)
            page.get_by_role('button', name='書き出し', exact=True).click()
            with page.expect_download() as downloaded:
                page.get_by_role('button', name='校正済みテキスト（OpenITI形式）').click()
            assert downloaded.value.suggested_filename == URI + '.corrected'
            exported = Path(downloaded.value.path()).read_bytes()
            expected = OPENITI.replace('\r\n\r\n# alpha beta gamma ', 'searchable needle').encode('utf-8')
            assert exported == expected, (exported, expected)
            print('PASS bibliography and edited export', flush=True)

            upload = Path(tmp) / 'upload.mARkdown'
            upload.write_bytes(UPLOAD.encode('utf-8'))
            page.get_by_role('link', name='OpenITI 校正', exact=True).click()
            page.locator('#file').set_input_files(str(upload))
            expect(editor).to_be_enabled(timeout=15000)
            expect(page).to_have_url(re.compile(r'#/p/upload/0$'))
            page.get_by_role('button', name='書き出し', exact=True).click()
            with page.expect_download() as downloaded:
                page.get_by_role('button', name='校正済みテキスト（OpenITI形式）').click()
            assert Path(downloaded.value.path()).read_bytes() == UPLOAD.encode('utf-8')
            page.get_by_role('button', name='次 →').click()
            expect(page.locator('#psel')).to_have_value('V01P002')
            page.get_by_role('link', name='OpenITI 校正', exact=True).click()
            page.locator('#ref').fill(URI)
            page.get_by_role('button', name='読み込む').click()
            expect(page).to_have_url(re.compile(f'#/p/{re.escape(URI)}_2/0$'), timeout=15000)
            page.get_by_role('link', name='OpenITI 校正', exact=True).click()
            expect(page.locator('tbody tr')).to_have_count(3)
            expect(page.locator('tbody')).to_contain_text('Edited title')
            print('PASS upload, byte-exact unedited export and slug dedupe', flush=True)

            newer = browser.new_context()
            probe = newer.new_page()
            probe.goto(base + '/mode.js')
            probe.evaluate("new Promise((res, rej) => { const r = indexedDB.open('proofreader', 99); r.onsuccess = () => { r.result.close(); res(); }; r.onerror = () => rej(r.error); })")
            probe.goto(base + '/')
            expect(probe.locator('#view')).to_contain_text('新しい版のアプリ')
            newer.close()
            print('PASS refuses a database from a newer app', flush=True)

            assert not api_calls, api_calls  # nothing reached a server API
            assert not errors, errors
            browser.close()
    finally:
        httpd.shutdown()


if __name__ == '__main__':
    main()
