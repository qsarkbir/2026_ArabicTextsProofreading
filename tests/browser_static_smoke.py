"""Browser-mode checks on plain static files, no Python API: pip install playwright; python -m tests.browser_static_smoke.

OpenITI requests are answered with synthetic text through page.route; real OpenITI text is never used.
"""
import functools
import http.server
import json
import os
import re
import shutil
import struct
import tempfile
import threading
import zlib
from urllib.parse import unquote
from pathlib import Path

from unittest.mock import patch

from playwright.sync_api import sync_playwright, expect

from proofreader import bundle, openiti, store
from proofreader.exporters import tei
from tests.preview_server import synthetic_pdf, jpx_pdf

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
LEFTOVER = '''slug => LocalStore.open().then(db => Promise.all([...db.objectStoreNames].map(name => new Promise((resolve, reject) => { const r = db.transaction(name).objectStore(name).getAllKeys();
    r.onsuccess = () => resolve(r.result.filter(k => k === slug || k === 'backup:' + slug || (Array.isArray(k) && k[0] === slug)).map(k => name + ':' + k)); r.onerror = () => reject(r.error); })))).then(l => l.flat())'''
DOCS = 'Object.keys(pdfDocs).length'  # pdf.js documents that are loaded (each keeps its whole Blob in memory)
STORED_FILES = '''slug => LocalStore.open().then(db => new Promise((resolve, reject) => { const r = db.transaction('files').objectStore('files').getAll();
    r.onsuccess = () => resolve(r.result.filter(x => x.slug === slug).map(x => [x.name, x.blob.size])); r.onerror = () => reject(r.error); }))'''
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


def png(width=40, height=60, shade=30):
    raw = b''.join(b'\x00' + bytes([shade]) * width for _ in range(height))
    chunk = lambda kind, data: struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 0, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')


# A synthetic Internet Archive: no request leaves the machine. archive.org and iiif.archive.org are served from here, and anything else is refused
IA_ORIGIN = re.compile(r'^https://([a-z0-9-]+\.)*archive\.org/')
IA_CORS = {'access-control-allow-origin': '*'}
IA_PAGES = 4
XSS_COUNT = '<img src=x onerror="window.__xss = 1">'  # imagecount arrives from the search response: only an integer may be shown
ia = {'manifest_failures': 0, 'image_failures': {}, 'dead': set(), 'images': {}, 'manifests': 0, 'searches': [], 'metadata': [], 'unexpected': [], 'private_pdf': True}


def ia_manifest(identifier):
    def canvas(n):
        return {'id': f'https://iiif.archive.org/iiif/{identifier}/canvas/{n}', 'type': 'Canvas', 'label': {'none': [str(n)]}, 'width': 400, 'height': 600,
                'items': [{'type': 'AnnotationPage', 'items': [{'type': 'Annotation', 'body': {'type': 'Image', 'service': [
                    {'id': f'https://iiif.archive.org/image/iiif/3/{identifier}%2Fp{n}', 'type': 'ImageService3'}]}}]}]}
    return {'label': {'none': ['Smoke Book']}, 'items': [canvas(n) for n in range(IA_PAGES)]}


def ia_route(route):
    url = route.request.url
    path = url.split('archive.org', 1)[1]
    json_reply = lambda data: route.fulfill(status=200, body=json.dumps(data), content_type='application/json', headers=IA_CORS)
    if path.startswith('/advancedsearch.php'):
        ia['searches'].append(url)
        return json_reply({'response': {'docs': [
            {'identifier': 'smoke-book', 'title': '<b>Smoke</b> book', 'creator': ['A', 'B'], 'date': '1900', 'imagecount': IA_PAGES},
            {'identifier': 'smoke-two', 'title': ['Two', 'parts'], 'imagecount': XSS_COUNT}]}})
    if path.startswith('/metadata/'):
        ia['metadata'].append(url)
        files = [{'name': 'smoke-book.pdf', 'format': 'Image Container PDF', 'size': '1048576'}, {'name': 'smoke-book_text.pdf', 'format': 'Text PDF', 'size': '2000'}]
        if ia['private_pdf']:
            files.append({'name': 'locked.pdf', 'format': 'Image Container PDF', 'size': '9999999', 'private': 'true'})
        return json_reply({'files': files})
    m = re.match(r'^/iiif/([A-Za-z0-9._-]+)/manifest\.json$', path) if url.startswith('https://iiif.') else None
    if m:
        ia['manifests'] += 1
        if ia['manifest_failures'] > 0:
            ia['manifest_failures'] -= 1
            return route.fulfill(status=504, body='')  # the real one has no CORS header either: the page sees "Failed to fetch"
        return json_reply(ia_manifest(m.group(1)))
    m = re.match(r'^/image/iiif/3/[^/]+%2F([^/]+)/full/1600,/0/default\.jpg$', path) if url.startswith('https://iiif.') else None
    if m:
        name = m.group(1)
        ia['images'][name] = ia['images'].get(name, 0) + 1
        if name in ia['dead'] or ia['image_failures'].get(name, 0) > 0:
            ia['image_failures'][name] = ia['image_failures'].get(name, 0) - 1
            return route.fulfill(status=504, body='')
        return route.fulfill(status=200, body=png(), content_type='image/png', headers=IA_CORS)
    if path.startswith('/services/img/'):
        return route.fulfill(status=200, body=png(20, 30), content_type='image/png')
    ia['unexpected'].append(url)  # e.g. /download/<id>/<file>.pdf: the page must only link to it
    return route.abort()


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
            context.route(IA_ORIGIN, ia_route)
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
            unsupported = page.evaluate("api('POST', '/api/projects/x/source/ia/pdf').then(() => 'no error', e => e.status + ' ' + e.message)")
            assert unsupported == '501 この機能はローカル版で利用できます', unsupported
            print('PASS browser mode home hides server-only features', flush=True)

            page.locator('#ref').fill('not a uri')
            page.get_by_role('button', name='読み込む', exact=True).click()
            expect(page.locator('#toast')).to_contain_text('OpenITIのバージョンURI')
            page.locator('#ref').fill(URI)
            page.get_by_role('button', name='読み込む', exact=True).click()
            expect(page).to_have_url(re.compile(f'#/p/{re.escape(URI)}/setup$'), timeout=15000)  # no source yet: setup (D-32)
            page.goto(base + f'/#/p/{URI}/0')
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
            expect(page.locator('.imgpane')).to_be_visible()  # no source yet: a message and a way to setup (D-32)
            expect(page.locator('#nosource')).to_contain_text('ページ画像の資料がまだ設定されていません。')
            for sel in ('#zo', '#zi', '#shl', '#shr', '#ialink', '#imginfo'):
                expect(page.locator(sel)).to_be_hidden()
            page.get_by_role('button', name='ページ画像の資料を設定する').click()
            expect(page).to_have_url(re.compile(f'#/p/{re.escape(URI)}/setup$'))
            page.go_back()
            expect(editor).to_be_enabled()
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
            expect(page).to_have_url(re.compile(r'#/p/upload/setup$'), timeout=15000)
            page.goto(base + '/#/p/upload/0')
            expect(editor).to_be_enabled(timeout=15000)
            page.get_by_role('button', name='書き出し', exact=True).click()
            with page.expect_download() as downloaded:
                page.get_by_role('button', name='校正済みテキスト（OpenITI形式）').click()
            assert Path(downloaded.value.path()).read_bytes() == UPLOAD.encode('utf-8')
            page.get_by_role('button', name='次 →').click()
            expect(page.locator('#psel')).to_have_value('V01P002')
            page.get_by_role('link', name='OpenITI 校正', exact=True).click()
            page.locator('#ref').fill(URI)
            page.get_by_role('button', name='読み込む', exact=True).click()
            expect(page).to_have_url(re.compile(f'#/p/{re.escape(URI)}_2/setup$'), timeout=15000)
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
            expect(page).to_have_url(re.compile('#/p/upload_2/setup$'), timeout=15000)  # the backup has no source
            page.goto(base + '/#/p/upload_2/0')
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
            for shown in ('Internet Archive を検索', '識別子・URLを直接指定'):
                expect(page.get_by_role('heading', name=shown)).to_be_visible()
            assert not ia['searches'], ia['searches']  # nothing is sent to Internet Archive until the user searches
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

            # ---- pdf.js documents do not pile up; replacing a source deletes the old Blob in IndexedDB; a cancelled draft is dropped ----
            page.evaluate("t => api('POST', '/api/projects/upload-text', new Blob([t]), {'X-Filename': 'docs'})", UPLOAD)
            page.goto(base + '/#/p/docs/setup')
            page.locator('#pdf').set_input_files(str(pdf4))
            expect(page.locator('#mimg canvas')).to_be_visible(timeout=60000)
            assert page.evaluate(DOCS) == 1  # the staged draft only
            page.locator('#ok').click()
            expect(page.locator('#imgview canvas')).to_be_visible(timeout=60000)
            assert page.evaluate(DOCS) == 1  # the draft's document was released when it was confirmed
            first_files = page.evaluate(STORED_FILES, 'docs')
            assert [f[1] for f in first_files] == [pdf4.stat().st_size], first_files
            page.get_by_role('link', name='資料・ページ対応').click()
            page.get_by_role('button', name='資料を選び直す').click()
            page.locator('#pdf').set_input_files(str(pdf3))
            expect(page.locator('#mimg canvas')).to_be_visible(timeout=60000)
            assert page.evaluate(DOCS) == 2  # the current source and the draft
            page.locator('#ok').click()
            expect(page.locator('#imgview canvas')).to_be_visible(timeout=60000)
            page.wait_for_function(DOCS + ' === 1')
            replaced_files = page.evaluate(STORED_FILES, 'docs')
            assert [f[1] for f in replaced_files] == [pdf3.stat().st_size] and replaced_files[0][0] != first_files[0][0], (first_files, replaced_files)
            for _ in range(3):  # staged and cancelled: nothing is left behind
                page.get_by_role('link', name='資料・ページ対応').click()
                page.get_by_role('button', name='資料を選び直す').click()
                page.locator('#pdf').set_input_files(str(pdf4))
                expect(page.locator('#mimg canvas')).to_be_visible(timeout=60000)
                page.locator('#cancel').click()
                expect(page.locator('#imgview canvas')).to_be_visible(timeout=60000)
                page.wait_for_function(DOCS + ' === 1')
                assert len(page.evaluate("LocalRouter.urlsOf('docs', true)")) == 1
            page.get_by_role('link', name='資料・ページ対応').click()  # leaving setup by the browser's back button drops the draft too
            page.get_by_role('button', name='資料を選び直す').click()
            page.locator('#pdf').set_input_files(str(pdf4))
            expect(page.locator('#mimg canvas')).to_be_visible(timeout=60000)
            page.goto(base + '/#/')
            page.wait_for_function(DOCS + ' === 0')
            assert page.evaluate("LocalRouter.urlsOf('docs', true)") == []
            assert [f[1] for f in page.evaluate(STORED_FILES, 'docs')] == [pdf3.stat().st_size]
            print('PASS pdf.js documents are released (confirm, replace, cancel, leaving) and a replaced source deletes its old Blob in IndexedDB', flush=True)

            # ---- backup carries no PDF: restored in a fresh browser profile, the PDF is chosen again ----
            with page.expect_download() as downloaded:
                page.locator('tbody tr', has_text='upload').first.locator('a[data-bundle]').click()
            pdf_bundle = Path(tmp) / 'pdf-project.proofreader.json'
            shutil.copy(downloaded.value.path(), pdf_bundle)
            pdf_data = json.loads(pdf_bundle.read_text(encoding='utf-8'))
            assert pdf_data['project']['source']['file'] == stored[0]['file'] and 'pdf' not in json.dumps(pdf_data['work']).lower()
            assert bundle.parse(pdf_data)[0]['source']['count'] == 4  # Python reads what the browser wrote
            ia_data = json.loads(PYTHON_BUNDLE.read_text(encoding='utf-8'))
            ia_data['project']['source'] = {'type': 'ia', 'id': 'book', 'revision': 'r', 'title': 'IA book', 'pages': [{'label': '1', 'service': 'https://iiif.archive.org/image/iiif/3/book%2Fn0', 'w': 1, 'h': 1}]}
            ia_bundle = Path(tmp) / 'ia-project.proofreader.json'
            ia_bundle.write_text(json.dumps(ia_data), encoding='utf-8')
            fresh = browser.new_context(accept_downloads=True)
            fresh.route(IA_ORIGIN, ia_route)
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
            assert other.evaluate(DOCS) == 1
            print('PASS restored PDF project asks for the PDF, warns on a different page count, then renders after a reload', flush=True)

            # the setup screen of a restored PDF project offers the same file input, keeps the mapping, and updates count and revision on a confirmed different PDF
            third = fresh.new_page()
            third.on('dialog', lambda d: d.accept())
            third.goto(base + '/')
            third.locator('#bundle').set_input_files(str(pdf_bundle))
            expect(third.locator('#imgview')).to_contain_text('このブラウザにありません', timeout=15000)
            restored = re.search(r'#/p/([^/]+)/0', third.url).group(1)
            before_source = third.evaluate(f"LocalStore.getProject({json.dumps(restored)}).then(p => [p.source, p.offset, p.anchors])")
            third.goto(base + f'/#/p/{restored}/setup')
            expect(third.locator('#mimg #reattach')).to_be_visible(timeout=15000)
            third.locator('#reattach').set_input_files(str(pdf3))  # 3 pages instead of the recorded 4: confirmed by the dialog handler
            expect(third.locator('#mimg canvas')).to_be_visible(timeout=60000)
            after_source = third.evaluate(f"LocalStore.getProject({json.dumps(restored)}).then(p => [p.source, p.offset, p.anchors])")
            assert after_source[0]['count'] == 3 and after_source[0]['revision'] != before_source[0]['revision'], (before_source, after_source)
            assert after_source[1:] == before_source[1:], (before_source, after_source)  # offset and anchors kept
            assert third.evaluate(f"LocalStore.fileSizes().then(s => s[{json.dumps(restored)}])") == pdf3.stat().st_size
            third.close()
            print('PASS setup screen of a restored PDF project re-attaches without touching the mapping; a different page count updates count and revision', flush=True)

            IMG_OK = "sel => { const i = document.querySelector(sel); return !!i && i.complete && i.naturalWidth > 0; }"
            other.goto(base + '/')
            other.locator('#bundle').set_input_files(str(ia_bundle))
            expect(other_editor).to_be_enabled(timeout=15000)
            expect(other.locator('#imgview img')).to_be_visible(timeout=15000)  # a restored IA project shows its images again
            assert other.evaluate(IMG_OK, '#imgview img')
            expect(other.locator('#shr')).to_be_enabled()
            other_editor.fill('still editable')
            expect(other.locator('#saved')).to_have_text('保存済み')
            other.get_by_role('link', name='資料・ページ対応').click()
            expect(other.locator('#mimg img')).to_be_visible(timeout=15000)
            for control in ('m10', 'm1', 'p1', 'p10', 'imgn', 'ok'):
                expect(other.locator('#' + control)).to_be_enabled()
            expect(other.locator('#pdfrow')).to_contain_text('smoke-book.pdf', timeout=15000)
            other.get_by_role('button', name='資料を選び直す').click()
            expect(other.get_by_role('heading', name='Internet Archive を検索')).to_be_visible()
            print('PASS restored IA project shows its images, the mapping controls work and the editor stays usable', flush=True)

            # shifting the mapping on an IA project: offset 5, page 1 -> image 7; shifting anchors page 1 at image 8, the setup screen then sets offset 7 (image 9 on page 1)
            ia_long = json.loads(PYTHON_BUNDLE.read_text(encoding='utf-8'))
            ia_long['project']['source'] = {'type': 'ia', 'id': 'book', 'revision': 'r', 'title': 'IA long', 'pages': [{'label': str(i), 'service': f'https://iiif.archive.org/image/iiif/3/book%2Fn{i}', 'w': 1, 'h': 1} for i in range(20)]}
            ia_long['project']['offset'], ia_long['project']['anchors'] = 5, []
            ia_long_bundle = Path(tmp) / 'ia-long.proofreader.json'
            ia_long_bundle.write_text(json.dumps(ia_long), encoding='utf-8')
            other.goto(base + '/')
            other.locator('#bundle').set_input_files(str(ia_long_bundle))
            expect(other_editor).to_be_enabled(timeout=15000)
            ia_slug = re.search(r'#/p/([^/]+)/0', other.url).group(1)
            other.goto(base + f'/#/p/{ia_slug}/1')
            expect(other.locator('#imginfo')).to_have_text('画像 7/20', timeout=15000)  # offset 5 + page index 1
            expect(other.locator('#imgview img')).to_be_visible(timeout=15000)
            other.locator('#shr').click()
            expect(other.locator('#imginfo')).to_have_text('画像 8/20')
            assert other.evaluate(f"LocalStore.getProject({json.dumps(ia_slug)}).then(p => [p.offset, p.anchors])") == [5, [[1, 7]]]
            other.get_by_role('link', name='資料・ページ対応').click()
            expect(other.locator('#imgn')).to_have_value('8', timeout=15000)
            other.locator('#p1').click()
            expect(other.locator('#imgn')).to_have_value('9')
            expect(other.locator('#mimg img')).to_be_visible()
            other.locator('#ok').click()
            expect(other.locator('#imginfo')).to_have_text('画像 9/20', timeout=15000)
            assert other.evaluate(f"LocalStore.getProject({json.dumps(ia_slug)}).then(p => [p.offset, p.anchors])") == [7, []]  # img 8 - page 1
            print('PASS IA project: shift and setup controls move the mapping', flush=True)

            # ---- Internet Archive (stage 2): search, choose, map, retry, local PDF, all against the synthetic archive ----
            flow_txt = Path(tmp) / 'ia-flow.txt'
            flow_txt.write_bytes(UPLOAD.encode('utf-8'))
            other.goto(base + '/')
            other.locator('#file').set_input_files(str(flow_txt))
            expect(other).to_have_url(re.compile(r'#/p/[^/]+/setup$'), timeout=15000)
            flow = re.search(r'#/p/([^/]+)/setup', other.url).group(1)
            other.goto(base + f'/#/p/{flow}/0')
            expect(other_editor).to_be_enabled(timeout=15000)
            other.evaluate('Sources.retry.delay = 30')  # the real delay is 3 s
            other.get_by_role('link', name='資料・ページ対応').click()
            other.locator('#q').fill('smoke')
            other.get_by_role('button', name='検索', exact=True).click()
            expect(other.locator('.res')).to_have_count(2, timeout=15000)
            assert len(ia['searches']) == 1 and 'smoke' in unquote(ia['searches'][0]).replace('+', ' ') and 'mediatype:texts' in unquote(ia['searches'][0]), ia['searches']
            assert other.locator('.res .t img').count() == 0 and other.evaluate('window.__xss') is None, 'imagecount must not become markup'
            assert '枚' not in other.locator('.res').nth(1).inner_text() and 'onerror' not in other.locator('.res').nth(1).inner_text()
            assert other.locator('.res .t b').first.inner_text() == '<b>Smoke</b> book' and other.locator('.res .t b b').count() == 0  # external titles are escaped
            expect(other.locator('.res').first).to_contain_text('A; B 1900 ・4枚')
            assert other.evaluate("document.querySelector('.res img').complete && document.querySelector('.res img').naturalWidth > 0")
            assert other.locator('.res a').first.get_attribute('href') == 'https://archive.org/details/smoke-book'
            ia['manifest_failures'] = 2
            other.locator('.res button.use').first.click()
            expect(other.locator('#mimg img')).to_be_visible(timeout=15000)
            assert other.evaluate(IMG_OK, '#mimg img') and ia['manifests'] == 3 and ia['manifest_failures'] == 0, ia['manifests']  # two 504s, then the manifest
            expect(other.locator('.card')).to_contain_text('Smoke Book')
            assert other.evaluate(f"LocalStore.getProject({json.dumps(flow)}).then(p => p.source)") is None  # not confirmed yet
            assert other.locator('#mimg img').get_attribute('src') == 'https://iiif.archive.org/image/iiif/3/smoke-book%2Fp0/full/1600,/0/default.jpg'
            other.locator('#p1').click()
            expect(other.locator('#imgn')).to_have_value('2')
            expect(other.locator('#mimg img')).to_have_attribute('src', re.compile('smoke-book%2Fp1/'))
            other.locator('#ok').click()
            expect(other.locator('#imginfo')).to_have_text('画像 2/4', timeout=15000)
            expect(other.locator('#imgview img')).to_be_visible(timeout=15000)
            assert other.evaluate(IMG_OK, '#imgview img')
            stored_ia = other.evaluate(f"LocalStore.getProject({json.dumps(flow)}).then(p => [p.source, p.offset, p.anchors])")
            assert [stored_ia[0]['type'], stored_ia[0]['id'], stored_ia[0]['title'], len(stored_ia[0]['pages']), 'pdf_file' in stored_ia[0], stored_ia[1], stored_ia[2]] == ['ia', 'smoke-book', 'Smoke Book', 4, False, 1, []], stored_ia
            assert stored_ia[0]['pages'][1] == {'label': '1', 'w': 400, 'h': 600, 'service': 'https://iiif.archive.org/image/iiif/3/smoke-book%2Fp1'}, stored_ia[0]['pages'][1]
            print('PASS IA: search escapes external text, manifest retried after 504s, source and mapping saved, image shown', flush=True)

            # an image that fails with a 504 is requested again (the second page is image 3 = p2); one that never loads ends in the D-27 message
            ia['image_failures']['p2'] = 2
            other.get_by_role('button', name='次 →').click()
            expect(other.locator('#imginfo')).to_have_text('画像 3/4')
            expect(other.locator('#imgview img')).to_be_visible(timeout=15000)
            assert ia['images']['p2'] == 3 and other.evaluate(IMG_OK, '#imgview img'), ia['images']
            ia['dead'].add('p3')
            other.locator('#shr').click()
            expect(other.locator('#imgview')).to_contain_text('IA の画像サーバーが応答しません。時間をおいて試すか、ローカル版を使ってください', timeout=15000)
            assert ia['images']['p3'] == 4, ia['images']  # one request and three retries
            ia['dead'].clear()
            other.locator('#imgretry').click()
            expect(other.locator('#imgview img')).to_be_visible(timeout=15000)
            other.locator('#shl').click()
            expect(other.locator('#imginfo')).to_have_text('画像 3/4')
            print('PASS IA: a 504 image is retried; a dead one shows the message and can be retried by hand', flush=True)

            # the PDF: only a link (the browser cannot fetch it), then the user's own file is stored and used; detaching goes back to the IIIF image
            ia_pdf3, ia_pdf4 = Path(tmp) / 'ia-three.pdf', Path(tmp) / 'ia-four.pdf'
            ia_pdf3.write_bytes(synthetic_pdf(3))
            ia_pdf4.write_bytes(synthetic_pdf(4))
            other.get_by_role('link', name='資料・ページ対応').click()
            expect(other.locator('#pdfrow')).to_contain_text('smoke-book.pdf（1.0 MB）', timeout=15000)  # the best public PDF; the private one is ignored
            link = other.locator('#pdfrow a')
            assert [link.get_attribute('href'), link.get_attribute('target'), link.get_attribute('rel')] == ['https://archive.org/download/smoke-book/smoke-book.pdf', '_blank', 'noopener']
            expect(other.get_by_role('button', name=re.compile('作業フォルダーに保存'))).to_have_count(0)  # the server-side download job is not offered
            files_before = other.evaluate("LocalStore.fileSizes()")
            other.locator('#pdfpick').set_input_files(str(ia_pdf3))
            expect(other.locator('#toast')).to_contain_text('PDFのページ数（3）が資料の画像数（4）と一致しないため使えません')
            expect(other.locator('#pdfpick')).to_be_enabled()
            assert other.evaluate("LocalStore.fileSizes()") == files_before
            other.evaluate(QUOTA)  # a full disk: the PDF is refused in Japanese, nothing is stored or changed, and a retry works
            project_before = other.evaluate(f"LocalStore.getProject({json.dumps(flow)})")
            other.locator('#pdfpick').set_input_files(str(ia_pdf4))
            expect(other.locator('#toast')).to_contain_text('ブラウザの保存容量が足りません', timeout=60000)
            expect(other.locator('#pdfpick')).to_be_enabled()
            assert other.evaluate("LocalStore.fileSizes()") == files_before
            assert other.evaluate(f"LocalStore.getProject({json.dumps(flow)})") == project_before and 'pdf_file' not in project_before['source']
            other.evaluate('window.__restorePut()')
            other.locator('#pdfpick').set_input_files(str(ia_pdf4))
            expect(other.locator('#pdfrow')).to_contain_text('保存済み', timeout=60000)
            expect(other.locator('#mimg canvas')).to_be_visible(timeout=60000)
            assert other.evaluate(CANVAS, '#mimg canvas')['dark'] > 200
            assert other.evaluate("LocalStore.fileSizes()") == {**files_before, flow: ia_pdf4.stat().st_size}
            attached = other.evaluate(f"LocalStore.getProject({json.dumps(flow)}).then(p => p.source.pdf_file)")
            assert re.fullmatch(r'ia-[0-9a-f]{32}\.pdf', attached), attached
            other.locator('#ok').click()
            expect(other.locator('#imgview canvas')).to_be_visible(timeout=60000)
            other.reload()
            expect(other.locator('#imginfo')).to_have_text('画像 3/4', timeout=30000)
            expect(other.locator('#imgview canvas')).to_be_visible(timeout=60000)
            assert other.evaluate(CANVAS, '#imgview canvas')['dark'] > 200 and other.evaluate(DOCS) == 1
            other.get_by_role('link', name='資料・ページ対応').click()
            expect(other.locator('#pdfrow')).to_contain_text(f'保存済み（{attached}）', timeout=15000)
            other.get_by_role('button', name='オンラインの画像に戻す').click()
            expect(other.locator('#mimg img')).to_be_visible(timeout=15000)
            assert other.evaluate("LocalStore.fileSizes()") == files_before
            assert other.evaluate(f"LocalStore.getProject({json.dumps(flow)}).then(p => 'pdf_file' in p.source)") is False
            expect(other.locator('#pdfrow a')).to_be_visible(timeout=15000)
            other.reload()
            expect(other.locator('#mimg img')).to_be_visible(timeout=15000)
            other.locator('#ok').click()
            expect(other.locator('#imgview img')).to_be_visible(timeout=15000)
            assert other.evaluate(DOCS) == 0
            print('PASS IA PDF: link only, the page count is checked, the chosen file is stored and used, detach returns to the IIIF image', flush=True)
            assert not ia['unexpected'], ia['unexpected']  # nothing but the allowed endpoints was requested (the PDF link was never followed)

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
            assert other.evaluate("LocalStore.fileSizes()") == {'upload': pdf4.stat().st_size, restored: pdf3.stat().st_size}
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
            assert other.evaluate("LocalStore.fileSizes()") == {'upload': pdf4.stat().st_size, restored: pdf3.stat().st_size, draft_slug: pdf3.stat().st_size}
            print('PASS new draft from a PDF selection, all-or-nothing on a full disk', flush=True)
            # ---- a scanned PDF (JPEG 2000 images) renders through the vendored WebAssembly decoder ----
            wasm = []
            other.on('response', lambda r: wasm.append((r.url.rsplit('/', 1)[-1], r.status, r.headers.get('content-type'))) if '.wasm' in r.url else None)
            scan = Path(tmp) / 'scan.pdf'
            scan.write_bytes(jpx_pdf(2))
            other.goto(base + '/')
            other.get_by_role('link', name='OpenITIにないテキストをPDFから作成する').click()
            other.get_by_label('書名', exact=True).fill('Scanned edition')
            other.get_by_label('著者', exact=True).fill('Scanned author')
            other.locator('#draftpdf').set_input_files(str(scan))
            expect(other.locator('#pdfcount')).to_contain_text('2ページ', timeout=60000)
            other.get_by_role('button', name='校正を始める').click()
            expect(other_editor).to_be_enabled(timeout=30000)
            expect(other.locator('#imgview canvas')).to_be_visible(timeout=60000)
            assert other.evaluate(CANVAS, '#imgview canvas')['dark'] > 1000, 'the JPEG 2000 page is blank'
            assert ('openjpeg.wasm', 200, 'application/wasm') in wasm, wasm
            print('PASS scanned PDF (JPEG 2000) renders through the vendored WebAssembly decoder', flush=True)

            # ---- project deletion: cancel keeps it; confirming removes every key of the project; another tab showing it goes home ----
            viewer = fresh.new_page()
            viewer.goto(base + f'/#/p/{draft_slug}/0')
            expect(viewer.locator('#imgview canvas')).to_be_visible(timeout=60000)
            other.evaluate(f"LocalStore.setSetting('backup:{draft_slug}', '2026-11-16T00:00:00.000Z')")  # a recorded backup time is removed too
            other.goto(base + '/')
            delete = other.locator(f'button[data-delete="{draft_slug}"]')
            delete.click()
            dialog = other.locator('dialog.delete-dialog')
            expect(dialog).to_contain_text('元に戻すことはできません')
            expect(dialog).to_contain_text('バックアップ')
            expect(dialog.locator('#delgo')).to_be_disabled()
            dialog.get_by_role('button', name='キャンセル').click()
            expect(other.locator('dialog.delete-dialog')).to_have_count(0)
            assert other.evaluate(LEFTOVER, draft_slug), 'cancel must keep the project'
            delete.click()
            dialog.locator('#delword').fill('削除')
            dialog.locator('#delgo').click()
            expect(other.locator('dialog.delete-dialog')).to_have_count(0)
            expect(other.locator(f'button[data-delete="{draft_slug}"]')).to_have_count(0)
            assert other.evaluate(LEFTOVER, draft_slug) == [], other.evaluate(LEFTOVER, draft_slug)
            assert draft_slug not in other.evaluate("LocalStore.fileSizes()")
            assert other.evaluate(f"api('GET', '/api/projects/{draft_slug}').then(() => 'found', e => e.status)") == 404
            assert other.evaluate(f"api('DELETE', '/api/projects/{draft_slug}').then(() => 'deleted', e => e.status)") == 404
            expect(viewer).to_have_url(re.compile(r'#/$'))
            expect(viewer.locator('#toast')).to_contain_text('別のタブで削除')
            assert other.evaluate("Object.keys(pdfDocs).length") == 0
            kept = other.evaluate("LocalStore.listProjects().then(l => l.map(p => p.slug))")
            assert 'upload' in kept and restored in kept, kept  # other projects are untouched
            assert other.evaluate("LocalStore.fileSizes()")['upload'] == pdf4.stat().st_size
            viewer.close()
            print('PASS project deletion: cancel keeps it, confirmation removes all its data, other tabs leave it', flush=True)
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
