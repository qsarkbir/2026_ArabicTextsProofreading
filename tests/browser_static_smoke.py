"""Browser-mode checks on plain static files, no Python API: pip install playwright; python -m tests.browser_static_smoke.

OpenITI requests are answered with synthetic text through page.route; real OpenITI text is never used.
"""
import functools
import http.server
import json
import os
import re
import shutil
import tempfile
import threading
from pathlib import Path

from unittest.mock import patch

from playwright.sync_api import sync_playwright, expect

from proofreader import bundle, openiti, store
from proofreader.exporters import tei

STATIC = Path(__file__).resolve().parent.parent / 'proofreader' / 'static'
PYTHON_BUNDLE = Path(__file__).resolve().parent / 'fixtures' / 'bundle' / 'python-export.proofreader.json'
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
            errors, api_calls, csp = [], [], []
            page.on('console', lambda m: csp.append(m.text) if 'Content Security Policy' in m.text else None)
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.on('request', lambda request: api_calls.append(request.url) if '/api/' in request.url else None)
            editor = page.get_by_role('textbox', name='校正テキスト', exact=True)

            page.goto(base + '/')
            assert page.evaluate('PROOF_MODE') == 'browser'
            expect(page.get_by_role('button', name='読み込む', exact=True)).to_be_visible()
            expect(page.get_by_role('button', name='アプリを終了')).to_be_hidden()
            expect(page.get_by_role('link', name='OpenITIにないテキストをPDFから作成する')).to_be_hidden()
            unsupported = page.evaluate("api('GET', '/api/ia/search?q=x').then(() => 'no error', e => e.status + ' ' + e.message)")
            assert unsupported == '501 この機能はローカル版で利用できます', unsupported
            print('PASS browser mode home hides server-only features', flush=True)

            page.locator('#ref').fill('not a uri')
            page.get_by_role('button', name='読み込む', exact=True).click()
            expect(page.locator('#toast')).to_contain_text('OpenITIのバージョンURI')
            page.locator('#ref').fill(URI)
            page.get_by_role('button', name='読み込む', exact=True).click()
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
            expect(page.get_by_role('button', name='TEI XML（基本構造）')).to_be_visible()
            expect(page.get_by_role('button', name='バックアップを書き出す（.proofreader.json）')).to_be_visible()
            for name in ('本文・書誌パッケージ（ZIP）', '元テキストとの差分（.diff）'):
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

            before = page.evaluate(f'LocalStore.page({json.dumps(slug)}, 0)')
            stale = page.evaluate(f"LocalStore.savePage({json.dumps(slug)}, 0, {{text: 'stale write', revision: 0}}).then(() => 'saved', e => e.status + ' ' + e.message)")
            assert stale.startswith('409 ') and '別のタブ' in stale, stale
            assert page.evaluate(f'LocalStore.page({json.dumps(slug)}, 0)') == before
            assert before['revision'] > 0 and before['text'] == 'first tab wins'
            print('PASS stale revision is a 409 and leaves the record unchanged', flush=True)

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
            page.get_by_role('button', name='書き出し', exact=True).click()
            with page.expect_download() as downloaded:
                page.get_by_role('button', name='TEI XML（基本構造）').click()
            assert downloaded.value.suggested_filename == URI + '.tei.xml'
            browser_tei = Path(downloaded.value.path()).read_bytes()
            assert browser_tei.startswith(b"<?xml version='1.0' encoding='utf-8'?>\n<TEI ") and b'Edited title' in browser_tei
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
            page.get_by_role('button', name='読み込む', exact=True).click()
            expect(page).to_have_url(re.compile(f'#/p/{re.escape(URI)}_2/0$'), timeout=15000)
            page.get_by_role('link', name='OpenITI 校正', exact=True).click()
            expect(page.locator('tbody tr')).to_have_count(3)
            expect(page.locator('tbody')).to_contain_text('Edited title')
            print('PASS upload, byte-exact unedited export and slug dedupe', flush=True)

            # ---- backup: browser -> Python, Python -> browser, and the home screen ----
            page.get_by_role('link', name='OpenITI 校正', exact=True).click()
            expect(page.locator('#usage')).to_contain_text('使用量')
            expect(page.locator('tbody tr').first.locator('td').nth(5)).to_have_text('未バックアップ')
            with page.expect_download() as downloaded:
                page.locator('a[data-bundle]').first.click()
            assert downloaded.value.suggested_filename == URI + '.proofreader.json'
            exported = json.loads(Path(downloaded.value.path()).read_text(encoding='utf-8'))
            assert exported['format'] == 'openiti-proofreader-project' and exported['format_version'] == 1
            assert exported['app']['mode'] == 'browser' and exported['original'] == OPENITI
            expect(page.locator('tbody tr').first.locator('td').nth(5)).not_to_have_text('未バックアップ')
            expect(page.locator('tbody tr').nth(1).locator('td').nth(5)).to_have_text('未バックアップ')
            with patch.object(store, 'ROOT', Path(tmp) / 'python-store'):
                store._cache.clear()
                copy = store.create_from_bundle(*bundle.parse(exported))['slug']
                assert store.original_text(copy) == OPENITI
                assert openiti.join(store.parts(copy), store.work(copy)['edits']) == expected.decode('utf-8')
                py_tei = tei.export(store.load(copy), store.parts(copy), store.work(copy))[0]
                store._cache.clear()
            assert py_tei == browser_tei, 'tei.js and exporters/tei.py differ for the same project'
            print('PASS browser backup imports into Python; TEI is byte-identical to the Python export', flush=True)

            watcher = context.new_page()
            watcher.goto(base + '/')
            expect(watcher.locator('tbody tr')).to_have_count(3)
            fixture = json.loads(PYTHON_BUNDLE.read_text(encoding='utf-8'))
            page.locator('#bundle').set_input_files(str(PYTHON_BUNDLE))
            expect(editor).to_be_enabled(timeout=15000)
            expect(page).to_have_url(re.compile(f'#/p/{re.escape(URI)}_3/0$'))
            expect(editor).to_have_value('edited alpha')
            expect(page.locator('#done')).to_be_checked()
            expect(page.locator('#note')).to_have_value('synthetic note')
            expect(watcher.locator('tbody tr')).to_have_count(4)  # another tab's list follows over BroadcastChannel
            watcher.close()
            page.get_by_role('button', name='書き出し', exact=True).click()
            with page.expect_download() as downloaded:
                page.get_by_role('button', name='校正済みテキスト（OpenITI形式）').click()
            assert Path(downloaded.value.path()).read_bytes().decode('utf-8') == openiti.join(openiti.split(fixture['original']), fixture['work']['edits'])
            kept = page.evaluate(f"LocalStore.getProject('{URI}_3').then(p => [p.slug, p.source])")
            assert kept == [URI + '_3', fixture['project']['source']], kept
            page.get_by_role('button', name='書き出し', exact=True).click()
            with page.expect_download() as downloaded:
                page.get_by_role('button', name='バックアップを書き出す（.proofreader.json）').click()
            again = json.loads(Path(downloaded.value.path()).read_text(encoding='utf-8'))
            assert again['original'] == fixture['original'] and again['work'] == fixture['work']
            assert {k: v for k, v in again['project'].items() if k != 'slug'} == {k: v for k, v in fixture['project'].items() if k != 'slug'}
            print('PASS Python backup imports into the browser and exports back unchanged', flush=True)

            page.get_by_role('link', name='OpenITI 校正', exact=True).click()
            with page.expect_download() as downloaded:
                page.locator('tbody tr', has_text='upload').locator('a[data-bundle]').click()
            upload_bundle = Path(tmp) / 'upload.proofreader.json'
            shutil.copy(downloaded.value.path(), upload_bundle)
            page.locator('#bundle').set_input_files(str(upload_bundle))
            expect(page).to_have_url(re.compile('#/p/upload_2/0$'), timeout=15000)
            expect(editor).to_be_enabled()
            page.get_by_role('button', name='書き出し', exact=True).click()
            with page.expect_download() as downloaded:
                page.get_by_role('button', name='校正済みテキスト（OpenITI形式）').click()
            assert Path(downloaded.value.path()).read_bytes() == UPLOAD.encode('utf-8')  # BOM and CRLF survive the round trip
            page.get_by_role('link', name='OpenITI 校正', exact=True).click()
            newer_file = Path(tmp) / 'newer.json'
            newer_file.write_text(json.dumps({**exported, 'format_version': 2}), encoding='utf-8')
            page.locator('#bundle').set_input_files(str(newer_file))
            expect(page.locator('#toast')).to_contain_text('新しい版のアプリで作られたデータです')
            broken = Path(tmp) / 'broken.json'
            broken.write_text('{nope', encoding='utf-8')
            page.locator('#bundle').set_input_files(str(broken))
            expect(page.locator('#toast')).to_contain_text('JSONとして読めません')
            expect(page.locator('tbody tr')).to_have_count(5)
            print('PASS bundle round trip keeps BOM and CRLF; newer or broken files are refused', flush=True)

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
            assert not csp, csp
            violation = context.new_page()
            violation.goto(base + '/')
            blocked = violation.evaluate("""new Promise(done => {
                document.addEventListener('securitypolicyviolation', e => done(e.violatedDirective), {once: true});
                const s = document.createElement('script'); s.textContent = 'window.__ran = true'; document.head.appendChild(s);
                setTimeout(() => done('not blocked'), 1000); })""")
            assert blocked.startswith('script-src'), blocked  # the CSP meta tag is really enforced
            print('PASS no CSP violations, and inline script is blocked', flush=True)
            browser.close()
    finally:
        httpd.shutdown()


if __name__ == '__main__':
    main()
