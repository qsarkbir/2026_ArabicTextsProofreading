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
from tests.preview_server import synthetic_pdf

STATIC = Path(__file__).resolve().parent.parent / 'proofreader' / 'static'
PYTHON_BUNDLE = Path(__file__).resolve().parent / 'fixtures' / 'bundle' / 'python-export.proofreader.json'
URI = '0999SyntheticAuthor.SyntheticBook.Test0001-ara1'
# CRLF line ends and a BOM on purpose: unedited pages must come back byte for byte
OPENITI = ('﻿######OpenITI#\r\n\r\n#META# 000.SortField :: Synthetic\r\n#META#Header#End#\r\n\r\n'
           '# alpha beta gamma PageV01P001\r\n# delta epsilon\r\n~~ zeta eta PageV01P002\r\n# theta iota PageV02P001\r\n')
UPLOAD = '﻿#META#Header#End#\r\nuploaded one PageV01P001\r\nuploaded two\r\nPageV01P002\r\n'
BOOK_YML = '10#BOOK#TITLEA#AR####: كتاب تجريبي\n'
# a canvas that holds a rendered page has plenty of dark pixels; the hash tells two different pages apart
CANVAS = '''sel => { const c = document.querySelector(sel); if (!c) return null; const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let dark = 0, hash = 0; for (let i = 0; i < d.length; i += 4) { if (d[i] < 100) dark++; hash = (hash * 31 + d[i] + i) | 0; } return {dark, hash, width: c.width}; }'''
QUOTA = '''() => { const put = IDBObjectStore.prototype.put; window.__restorePut = () => { IDBObjectStore.prototype.put = put; };
    IDBObjectStore.prototype.put = function (...args) { if (this.name === 'files') throw new DOMException('quota', 'QuotaExceededError'); return put.apply(this, args); }; }'''


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
            expect(page.get_by_role('link', name='OpenITIにないテキストをPDFから作成する')).to_be_visible()
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

            for name, visible in (('比較の設定', False), ('書誌', True)):
                button = page.get_by_role('button', name=name, exact=True) if visible else page.get_by_text(name, exact=True)
                expect(button).to_be_visible() if visible else expect(button).to_be_hidden()
            expect(page.get_by_role('link', name='資料・ページ対応')).to_be_visible()
            expect(page.locator('.imgpane')).to_be_hidden()  # no source yet
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

            # ---- local PDF as the source (stage 1b) ----
            pdf4, pdf3 = Path(tmp) / 'four.pdf', Path(tmp) / 'three.pdf'
            pdf4.write_bytes(synthetic_pdf(4))
            pdf3.write_bytes(synthetic_pdf(3))
            page.goto(base + '/#/p/upload/0')
            expect(editor).to_be_enabled(timeout=15000)
            page.get_by_role('link', name='資料・ページ対応').click()
            expect(page.get_by_role('heading', name='ページ画像を選ぶ')).to_be_visible()
            for hidden in ('Internet Archive を検索', '識別子・URLを直接指定'):
                expect(page.get_by_role('heading', name=hidden)).to_be_hidden()
            page.evaluate(QUOTA)  # a full disk: nothing may change
            page.locator('#pdf').set_input_files(str(pdf4))
            expect(page.locator('#mimg canvas')).to_be_visible(timeout=60000)
            expect(page.locator('.card')).to_contain_text('four.pdf')
            assert page.evaluate(CANVAS, '#mimg canvas')['dark'] > 200
            page.locator('#p1').click()
            expect(page.locator('#imgn')).to_have_value('2')
            page.locator('#ok').click()
            expect(page.locator('#toast')).to_contain_text('ブラウザの保存容量が足りません')
            assert page.evaluate("LocalStore.fileSizes()") == {}
            unchanged = page.evaluate("LocalStore.getProject('upload')")
            assert unchanged['source'] is None and unchanged['offset'] == 0, unchanged
            page.evaluate('window.__restorePut()')
            page.locator('#ok').click()
            expect(page).to_have_url(re.compile(r'#/p/upload/0$'))
            expect(page.locator('#imginfo')).to_have_text('画像 2/4', timeout=30000)
            expect(page.locator('#imgview canvas')).to_be_visible(timeout=60000)
            first = page.evaluate(CANVAS, '#imgview canvas')
            assert first['dark'] > 200 and first['width'] == 1600, first
            stored = page.evaluate("LocalStore.getProject('upload').then(async p => [p.source, p.offset, p.anchors, (await LocalStore.getFile('upload', p.source.file)).size])")
            assert stored[0]['type'] == 'pdf' and stored[0]['count'] == 4 and stored[0]['title'] == 'four.pdf', stored
            assert re.fullmatch(r'source-[0-9a-f]{32}\.pdf', stored[0]['file']) and stored[0]['revision'], stored
            assert stored[1:3] == [1, []] and stored[3] == pdf4.stat().st_size, stored
            print('PASS local PDF: upload in setup, all-or-nothing on a full disk, mapping and rendering', flush=True)

            page.reload()
            expect(page.locator('#imginfo')).to_have_text('画像 2/4', timeout=30000)
            expect(page.locator('#imgview canvas')).to_be_visible(timeout=60000)
            reloaded = page.evaluate(CANVAS, '#imgview canvas')
            assert reloaded == first, (reloaded, first)
            page.locator('#shr').click()
            expect(page.locator('#imginfo')).to_have_text('画像 3/4')
            expect(page.locator('#imgview canvas')).to_be_visible(timeout=60000)
            shifted = page.evaluate(CANVAS, '#imgview canvas')
            assert shifted['dark'] > 200 and shifted['hash'] != first['hash']
            assert page.evaluate("LocalStore.getProject('upload').then(p => p.anchors)") == [[0, 2]]
            page.get_by_role('button', name='次 →').click()
            expect(page.locator('#imginfo')).to_have_text('画像 4/4')
            page.get_by_role('link', name='OpenITI 校正', exact=True).click()
            expect(page.locator('tbody tr', has_text='upload').first.locator('td').first).to_contain_text('PDF ')
            print('PASS local PDF: persistence, anchors and storage size on the home screen', flush=True)

            # ---- backup carries no PDF: restored in a fresh browser profile, the PDF is chosen again ----
            with page.expect_download() as downloaded:
                page.locator('tbody tr', has_text='upload').first.locator('a[data-bundle]').click()
            pdf_bundle = Path(tmp) / 'pdf-project.proofreader.json'
            shutil.copy(downloaded.value.path(), pdf_bundle)
            pdf_data = json.loads(pdf_bundle.read_text(encoding='utf-8'))
            assert pdf_data['project']['source']['file'] == stored[0]['file'] and 'pdf' not in json.dumps(pdf_data['work']).lower()
            assert bundle.parse(pdf_data)[0]['source']['count'] == 4  # Python reads what the browser wrote
            ia_data = json.loads(PYTHON_BUNDLE.read_text(encoding='utf-8'))
            ia_data['project']['source'] = {'type': 'ia', 'id': 'book', 'revision': 'r', 'title': 'IA book', 'pages': [{'label': '1', 'service': 'https://example.invalid/x', 'w': 1, 'h': 1}]}
            ia_bundle = Path(tmp) / 'ia-project.proofreader.json'
            ia_bundle.write_text(json.dumps(ia_data), encoding='utf-8')
            fresh = browser.new_context(accept_downloads=True)
            other = fresh.new_page()
            other_errors, other_csp, messages = [], [], []
            other.on('pageerror', lambda error: other_errors.append(str(error)))
            other.on('console', lambda m: other_csp.append(m.text) if 'Content Security Policy' in m.text else None)
            other.on('dialog', lambda d: (messages.append(d.message), d.dismiss()))
            other.goto(base + '/')
            other.locator('#bundle').set_input_files(str(pdf_bundle))
            other_editor = other.get_by_role('textbox', name='校正テキスト', exact=True)
            expect(other_editor).to_be_enabled(timeout=15000)
            expect(other.locator('#imgview')).to_contain_text('このブラウザにありません')
            assert other.evaluate("LocalStore.fileSizes()") == {}
            other.locator('#reattach').set_input_files(str(pdf3))
            expect(other.locator('#reattach')).to_be_enabled()
            assert len(messages) == 1 and '3ページ' in messages[0] and '4ページ' in messages[0], messages
            expect(other.locator('#imgview')).to_contain_text('このブラウザにありません')
            assert other.evaluate("LocalStore.fileSizes()") == {}  # declined: nothing stored
            other.locator('#reattach').set_input_files(str(pdf4))
            expect(other.locator('#imgview canvas')).to_be_visible(timeout=60000)
            assert len(messages) == 1  # a PDF with the recorded page count needs no question
            expect(other.locator('#imginfo')).to_have_text('画像 3/4')  # the anchor travels with the backup
            expect(other.locator('#imgview canvas')).to_be_visible()
            assert other.evaluate(CANVAS, '#imgview canvas')['dark'] > 200
            other.reload()
            expect(other.locator('#imgview canvas')).to_be_visible(timeout=60000)
            assert other.evaluate("LocalStore.fileSizes()") == {'upload': pdf4.stat().st_size}
            print('PASS restored PDF project asks for the PDF, warns on a different page count, then renders after a reload', flush=True)

            other.goto(base + '/')
            other.locator('#bundle').set_input_files(str(ia_bundle))
            expect(other_editor).to_be_enabled(timeout=15000)
            expect(other.locator('#imgview')).to_contain_text('Internet Archive の画像です')
            other_editor.fill('still editable')
            expect(other.locator('#saved')).to_have_text('保存済み')
            other.get_by_role('link', name='資料・ページ対応').click()
            expect(other.locator('#mimg')).to_contain_text('ブラウザ版では表示できません')
            expect(other.locator('#pdfrow')).to_have_count(0)
            other.get_by_role('button', name='資料を選び直す').click()
            expect(other.get_by_role('heading', name='ページ画像を選ぶ')).to_be_visible()
            expect(other.get_by_role('heading', name='Internet Archive を検索')).to_be_hidden()
            print('PASS restored IA project opens without images and stays editable', flush=True)

            # ---- a new draft from a PDF selection ----
            other.goto(base + '/')
            other.get_by_role('link', name='OpenITIにないテキストをPDFから作成する').click()
            other.get_by_label('書名', exact=True).fill('Synthetic edition')
            other.get_by_label('著者', exact=True).fill('Synthetic author')
            other.locator('#draftpdf').set_input_files(str(pdf3))
            expect(other.locator('#pdfcount')).to_contain_text('3ページ', timeout=60000)
            other.get_by_label('最初の本文画像（PDFの通し番号）').fill('2')
            other.get_by_label('最初の印刷ページ番号').fill('10')
            before = other.evaluate("LocalStore.listProjects().then(l => l.length)")
            other.evaluate(QUOTA)
            other.get_by_role('button', name='校正を始める').click()
            expect(other.locator('#draftmsg')).to_contain_text('ブラウザの保存容量が足りません')
            assert other.evaluate("LocalStore.listProjects().then(l => l.length)") == before  # no project, no PDF
            assert other.evaluate("LocalStore.fileSizes()") == {'upload': pdf4.stat().st_size}
            other.evaluate('window.__restorePut()')
            other.get_by_role('button', name='校正を始める').click()
            expect(other_editor).to_be_enabled(timeout=30000)
            expect(other.locator('#psel')).to_have_value('V01P010')
            expect(other.locator('#imginfo')).to_have_text('画像 2/3', timeout=60000)
            expect(other.locator('#imgview canvas')).to_be_visible(timeout=60000)
            assert other.evaluate(CANVAS, '#imgview canvas')['dark'] > 200
            draft_slug = re.search(r'#/p/([^/]+)/0', other.url).group(1)
            draft_project = other.evaluate(f"LocalStore.getProject({json.dumps(draft_slug)})")
            assert draft_project['draft'] is True and draft_project['offset'] == 1 and draft_project['author'] == 'Synthetic author'
            assert draft_project['source']['file'] == 'source.pdf' and draft_project['source']['count'] == 3 and draft_project['source']['title'] == 'three.pdf'
            other.get_by_role('button', name='次 →').click()
            expect(other.locator('#imginfo')).to_have_text('画像 3/3')
            other.reload()
            expect(other.locator('#imginfo')).to_have_text('画像 3/3')
            other.goto(base + f'/#/p/{draft_slug}/0')
            expect(other.locator('#imgview canvas')).to_be_visible(timeout=60000)
            assert other.evaluate("LocalStore.fileSizes()") == {'upload': pdf4.stat().st_size, draft_slug: pdf3.stat().st_size}
            print('PASS new draft from a PDF selection, all-or-nothing on a full disk', flush=True)
            assert not other_errors and not other_csp, (other_errors, other_csp)
            fresh.close()

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
