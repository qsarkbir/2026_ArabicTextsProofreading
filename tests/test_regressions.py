import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from proofreader import net, ocr, openiti, server, sources, store
from proofreader.presence import Presence


class Request:
    def __init__(self, body=None, query=None, data=b'', headers=None):
        self.value = body or {}
        self.query = query or {}
        self.headers = headers or {}
        self.data = data

    def json(self):
        return self.value

    def body(self):
        return self.data

    def send_download(self, data, *args):
        return data

    def _send(self, status, data, ctype, extra=None, cache='no-store'):
        self.sent = (status, data, ctype, cache)


class RegressionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.root = patch.object(store, 'ROOT', Path(self.temp.name))
        self.root.start()
        store._cache.clear()

    def tearDown(self):
        store._cache.clear()
        server.DRAFTS.clear()
        self.root.stop()
        self.temp.cleanup()

    def project(self, text='alpha PageV01P001\nbeta PageV01P002\n'):
        p = store.create({'uri': 'fixture', 'text': text, 'meta': {}})
        p['source'] = {'type': 'ia', 'id': 'book', 'revision': 'one', 'pages': [
            {'label': str(i), 'service': 'https://iiif.archive.org/test', 'w': 1, 'h': 1} for i in range(4)]}
        store.save_project(p['slug'], p)
        return p

    def test_unedited_export_preserves_bytes(self):
        for bom in ('', '\ufeff'):
            for newline in ('\n', '\r\n', '\r'):
                with self.subTest(bom=bool(bom), newline=repr(newline)):
                    text = bom + newline.join(['#META#Header#End#', 'ألف', 'PageV01P001', 'tail', ''])
                    p = self.project(text)
                    self.assertEqual(server.export(Request(), p['slug']), text.encode())

    def test_upload_preserves_bom(self):
        raw = '\ufefftext\r\nPageV01P001\r\n'.encode()
        p = server.create_from_file(Request(data=raw, headers={'X-Filename': 'fixture.txt'}))
        self.assertEqual(server.export(Request(), p['slug']), raw)

    def test_edits_leave_other_segments_unchanged(self):
        raw = '\ufeff#META#Header#End#\r\nalpha PageV01P001\r\nbeta PageV01P002\r\n'
        p = self.project(raw)
        parts = store.parts(p['slug'])
        store.update_page(p['slug'], 1, text='changed')
        self.assertEqual(server.export(Request(), p['slug']).decode(),
                         openiti.join(parts, {'1': 'changed'}))
        self.assertIn('\r\nalpha PageV01P001', server.export(Request(), p['slug']).decode())

    def test_cache_requires_same_source_and_image(self):
        p = self.project()
        key = server.image_for(p, 0)['key']
        cached = {'text': 'cached', 'image_key': key, 'image_index': 0}
        store.ocr_put(p['slug'], 0, cached)
        self.assertEqual(server.run_ocr(Request(), p['slug'], '0'), cached)
        p['source']['revision'] = 'two'
        store.save_project(p['slug'], p)
        self.assertIsNone(server.get_page(Request(), p['slug'], '0')['ocr'])
        with self.assertRaises(server.ApiError):
            server.run_ocr(Request({'image_key': key}), p['slug'], '0')

    def test_legacy_cache_is_shown_for_ia_with_same_image_index(self):
        p = self.project()
        store.ocr_put(p['slug'], 0, {'text': 'old', 'image_index': 0})
        ocr = server.get_page(Request(), p['slug'], '0')['ocr']
        self.assertEqual((ocr['text'], ocr['legacy']), ('old', True))
        self.assertNotIn('legacy', store.ocr_get(p['slug'], 0))

    def test_legacy_cache_is_hidden_when_image_index_differs(self):
        p = self.project()
        store.ocr_put(p['slug'], 0, {'text': 'old', 'image_index': 0})
        p['offset'] = 1
        store.save_project(p['slug'], p)
        self.assertIsNone(server.get_page(Request(), p['slug'], '0')['ocr'])
        store.ocr_put(p['slug'], 0, {'text': 'old'})
        self.assertIsNone(server.get_page(Request(), p['slug'], '0')['ocr'])

    def test_legacy_cache_is_never_shown_for_pdf(self):
        p = self.project()
        self.choose_pdf(p['slug'])
        store.ocr_put(p['slug'], 0, {'text': 'old', 'image_index': 0})
        self.assertIsNone(server.get_page(Request(), p['slug'], '0')['ocr'])

    def test_legacy_cache_is_not_a_hit_for_run_ocr(self):
        p = self.project()
        store.ocr_put(p['slug'], 0, {'text': 'old', 'image_index': 0})
        with patch.object(server.net, 'get_bytes', return_value=(b'image', 'image/jpeg')), \
                patch.object(server.ocr, 'transcribe', return_value={'text': 'new'}) as transcribe:
            res = server.run_ocr(Request(), p['slug'], '0')
        transcribe.assert_called_once()
        self.assertEqual(res['text'], 'new')
        self.assertNotIn('legacy', res)

    def test_ocr_is_discarded_if_mapping_changes_during_request(self):
        p = self.project()
        image = server.image_for(p, 0)

        def transcribe(*args, **kwargs):
            changed = store.load(p['slug'])
            changed['offset'] = 1
            store.save_project(p['slug'], changed)
            return {'text': 'stale'}

        with patch.object(server.net, 'get_bytes', return_value=(b'image', 'image/jpeg')), \
                patch.object(server.ocr, 'transcribe', side_effect=transcribe):
            with self.assertRaises(server.ApiError):
                server.run_ocr(Request({'image_key': image['key']}), p['slug'], '0')
        self.assertIsNone(store.ocr_get(p['slug'], 0))

    def test_mapping_change_hides_cache_and_restoring_it_recovers_cache(self):
        p = self.project()
        store.ocr_put(p['slug'], 0, {'text': 'cached', 'image_key': server.image_for(p, 0)['key']})
        server.set_mapping(Request({'anchor': [0, 1]}), p['slug'])
        self.assertIsNone(server.get_page(Request(), p['slug'], '0')['ocr'])
        server.set_mapping(Request({'anchor': [0, 0]}), p['slug'])
        self.assertEqual(server.get_page(Request(), p['slug'], '0')['ocr']['text'], 'cached')

    def test_preview_does_not_change_anchors(self):
        p = self.project()
        p['anchors'] = [[1, 3]]
        store.save_project(p['slug'], p)
        result = server.preview_image(Request(query={'index': ['2']}), p['slug'])
        self.assertEqual(result['index'], 2)
        self.assertEqual(store.load(p['slug'])['anchors'], [[1, 3]])

    def choose_pdf(self, slug):
        draft = server.set_pdf(Request(data=b'%PDF-test', headers={'X-Page-Count': '2'}), slug)['draft']
        server.set_mapping(Request({'source': draft['revision'], 'offset': 0}), slug)
        return draft

    def test_pdf_replacements_have_distinct_urls(self):
        p = self.project()
        self.choose_pdf(p['slug'])
        first = server.image_for(store.load(p['slug']), 0)
        self.choose_pdf(p['slug'])
        second = server.image_for(store.load(p['slug']), 0)
        self.assertNotEqual(first['pdf'], second['pdf'])
        self.assertNotEqual(first['key'], second['key'])
        self.assertTrue(server.image_for(store.load(p['slug']), 2)['missing'])

    def test_choosing_a_source_changes_nothing_until_confirmed(self):
        p = self.project()
        p['anchors'] = [[1, 3]]
        store.save_project(p['slug'], p)
        before = store.load(p['slug'])
        draft = server.set_pdf(Request(data=b'%PDF-test', headers={'X-Page-Count': '5'}), p['slug'])['draft']
        self.assertEqual(store.load(p['slug']), before)
        preview = server.preview_image(Request(query={'index': ['4'], 'draft': [draft['revision']]}), p['slug'])
        self.assertIn(draft['file'], preview['pdf'])
        self.assertFalse(preview['missing'])
        server.set_mapping(Request({'source': draft['revision'], 'offset': 1, 'clear_anchors': True}), p['slug'])
        after = store.load(p['slug'])
        self.assertEqual((after['source']['file'], after['offset'], after['anchors']), (draft['file'], 1, []))
        with self.assertRaises(server.ApiError):
            server.set_mapping(Request({'source': draft['revision']}), p['slug'])

    def test_stale_draft_is_rejected_without_changes(self):
        p = self.project()
        first = server.set_pdf(Request(data=b'%PDF-test', headers={'X-Page-Count': '2'}), p['slug'])['draft']
        server.set_pdf(Request(data=b'%PDF-test', headers={'X-Page-Count': '3'}), p['slug'])
        with self.assertRaises(server.ApiError):
            server.set_mapping(Request({'source': first['revision'], 'offset': 4}), p['slug'])
        self.assertEqual(store.load(p['slug'])['source']['type'], 'ia')
        self.assertEqual(store.load(p['slug'])['offset'], 0)

    def test_search_uses_edits_notes_and_status(self):
        p = self.project()
        store.update_page(p['slug'], 0, text='replacement', done=True)
        store.update_page(p['slug'], 1, note='check this')
        for query, expected in [({'q': ['replacement']}, [0]), ({'q': ['alpha']}, []),
                                ({'filter': ['todo']}, [1]), ({'filter': ['noted']}, [1]),
                                ({'filter': ['edited']}, [0]), ({'q': ['check']}, [1])]:
            self.assertEqual([r['i'] for r in server.search_pages(Request(query=query), p['slug'])], expected)

    def scan(self, p, idx=0, query=None):
        req = Request(query=query)
        server.scan(req, p['slug'], str(idx))
        return req.sent

    def test_scan_is_cached_on_disk(self):
        p = self.project()
        with patch.object(server.net, 'get_bytes', return_value=(b'jpeg', 'image/jpeg')) as get:
            first = self.scan(p, 1)
            second = self.scan(p, 1)
        self.assertEqual(get.call_count, 1)
        self.assertEqual(first, (200, b'jpeg', 'image/jpeg', 'private, max-age=86400'))
        self.assertEqual(second, first)
        self.assertEqual([f.suffix for f in (store.ROOT / p['slug'] / 'cache' / 'scan').iterdir()], ['.jpg'])

    def test_scan_falls_back_to_bookreader(self):
        p = self.project()
        calls = []

        def get(url, timeout=60):
            calls.append(url)
            if 'iiif' in url:
                raise net.FetchError('timeout')
            return b'jpeg', 'image/jpeg'
        with patch.object(server.net, 'get_bytes', side_effect=get):
            self.assertEqual(self.scan(p, 2)[1], b'jpeg')
        self.assertEqual(calls, ['https://iiif.archive.org/test/full/1600,/0/default.jpg',
                                 'https://archive.org/download/book/page/n2_w1600.jpg'])

    def test_scan_reports_failure_of_both_sources(self):
        p = self.project()
        with patch.object(server.net, 'get_bytes', side_effect=TimeoutError('slow')):
            with self.assertRaises(server.ApiError) as cm:
                self.scan(p, 0)
        self.assertEqual(cm.exception.status, server.HTTPStatus.BAD_GATEWAY)
        self.assertFalse((store.ROOT / p['slug'] / 'cache' / 'scan').exists())

    def test_scan_uses_draft_source(self):
        p = self.project()
        draft = {'type': 'ia', 'id': 'other', 'revision': 'two', 'pages': [
            {'label': '0', 'service': 'https://iiif.archive.org/other', 'w': 1, 'h': 1}]}
        server.DRAFTS[p['slug']] = draft
        self.assertIn('draft=two', server.preview_image(Request(query={'draft': ['two']}), p['slug'])['url'])
        with patch.object(server.net, 'get_bytes', return_value=(b'jpeg', 'image/jpeg')) as get:
            self.scan(p, 0, {'draft': ['two']})
            with self.assertRaises(server.ApiError):
                self.scan(p, 1, {'draft': ['two']})
        get.assert_called_once_with('https://iiif.archive.org/other/full/1600,/0/default.jpg', timeout=10)

    def test_image_url_points_to_scan_api(self):
        p = self.project()
        self.assertEqual(server.image_for(p, 0)['url'], f"/api/projects/{p['slug']}/scan/0?w=1600&v=one")

    def test_scan_url_changes_with_source_revision(self):
        p = self.project()
        before = server.image_for(p, 0)['url']
        p['source']['revision'] = 'two'
        after = server.image_for(p, 0)['url']
        self.assertNotEqual(before, after)
        self.assertIn('/scan/0?', after)

    def test_scan_does_not_cache_non_images(self):
        p = self.project()
        with patch.object(server.net, 'get_bytes', return_value=(b'<html>', 'text/html')):
            with self.assertRaises(server.ApiError) as cm:
                self.scan(p, 0)
        self.assertEqual(cm.exception.status, server.HTTPStatus.BAD_GATEWAY)
        self.assertFalse((store.ROOT / p['slug'] / 'cache' / 'scan').exists())

    def test_cached_png_is_served_as_png(self):
        p = self.project()
        png = b'xPNGrest'
        with patch.object(server.net, 'get_bytes', return_value=(png, 'image/png')):
            self.scan(p, 0)
        with patch.object(server.net, 'get_bytes', side_effect=AssertionError('network')):
            self.assertEqual(self.scan(p, 0)[1:3], (png, 'image/png'))

    def test_scan_survives_failing_replace(self):
        p = self.project()
        with patch.object(server.net, 'get_bytes', return_value=(b'jpeg', 'image/jpeg')),                 patch.object(server.os, 'replace', side_effect=PermissionError):
            self.assertEqual(self.scan(p, 0)[1], b'jpeg')
        self.assertEqual(list((store.ROOT / p['slug'] / 'cache' / 'scan').iterdir()), [])

    def test_redirects_are_limited_to_allowed_hosts(self):
        handler = net._Redirects()
        req = net.urllib.request.Request('https://archive.org/download/x')
        with self.assertRaises(net.FetchError):
            handler.redirect_request(req, None, 302, 'Found', {}, 'https://evil.example.com/x.jpg')
        ok = handler.redirect_request(req, None, 302, 'Found', {}, 'https://ia800000.us.archive.org/x.jpg')
        self.assertEqual(ok.full_url, 'https://ia800000.us.archive.org/x.jpg')



class VenvRelaunchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def venv(self):
        py = self.root / '.venv' / 'Scripts' / 'python.exe'
        py.parent.mkdir(parents=True)
        py.write_text('')
        return py

    def test_relaunches_when_anthropic_is_missing(self):
        py = self.venv()
        self.assertEqual(server.venv_python(self.root, self.root / 'system.exe', {}, False), py)

    def test_no_relaunch_when_disabled_current_available_or_no_venv(self):
        py = self.venv()
        self.assertIsNone(server.venv_python(self.root, self.root / 'system.exe', {'PROOFREADER_NO_REEXEC': '1'}, False))
        self.assertIsNone(server.venv_python(self.root, py, {}, False))
        self.assertIsNone(server.venv_python(self.root, self.root / 'system.exe', {}, True))
        self.assertIsNone(server.venv_python(self.root / 'none', self.root / 'system.exe', {}, False))

    def test_project_view_reports_ocr_reason(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as d, patch.object(store, 'ROOT', Path(d)):
            store._cache.clear()
            p = store.create({'uri': 'fixture', 'text': 'alpha PageV01P001\n', 'meta': {}})
            with patch.object(ocr, 'available', return_value=False):
                self.assertIn('anthropic', server.project_view(p['slug'])['ocr_reason'])
            with patch.object(ocr, 'available', return_value=True):
                self.assertIsNone(server.project_view(p['slug'])['ocr_reason'])
            store._cache.clear()

    def test_reason_depends_on_virtual_environment(self):
        with patch.object(ocr, 'available', return_value=False):
            with patch.object(ocr.sys, 'prefix', 'a'), patch.object(ocr.sys, 'base_prefix', 'b'):
                self.assertIn('pip install', ocr.reason())
            with patch.object(ocr.sys, 'prefix', 'a'), patch.object(ocr.sys, 'base_prefix', 'a'):
                self.assertIn('start.bat', ocr.reason())
        with patch.object(ocr, 'available', return_value=True):
            self.assertIsNone(ocr.reason())

    def test_relaunch_runs_child_and_exits_with_its_status(self):
        calls = []

        class Child:
            def wait(self):
                return 3

        def popen(argv, **kw):
            calls.append((argv, kw))
            return Child()

        py = server.ENV_FILE.parent / '.venv' / 'Scripts' / 'python.exe'
        with patch.object(server.subprocess, 'Popen', popen), patch.object(server.sys, 'argv', ['x', '--port', '1']):
            with self.assertRaises(SystemExit) as cm:
                server.relaunch(py)
        argv, kw = calls[0]
        self.assertEqual((cm.exception.code, argv[1:3], argv[3:]), (3, ['-m', 'proofreader'], ['--port', '1']))
        self.assertEqual(kw['env']['PROOFREADER_NO_REEXEC'], '1')
        self.assertEqual(Path(kw['cwd']), server.ENV_FILE.parent)


class PresenceTests(unittest.TestCase):
    def test_exit_rules(self):
        p = Presence()
        self.assertFalse(p.should_exit(1000))
        p.beat('a', 0)
        self.assertFalse(p.should_exit(100))
        p.bye('a', 100)
        self.assertFalse(p.should_exit(129))
        self.assertTrue(p.should_exit(130))
        p.beat('a', 131)
        self.assertFalse(p.should_exit(200))

    def test_two_clients_and_silence(self):
        p = Presence()
        p.beat('a', 0)
        p.beat('b', 0)
        p.bye('a', 10)
        self.assertFalse(p.should_exit(100))
        self.assertFalse(p.should_exit(179))
        self.assertTrue(p.should_exit(180))

    def test_inflight_blocks_exit(self):
        p = Presence()
        p.beat('a', 0)
        p.bye('a', 0)
        p.request_started()
        self.assertFalse(p.should_exit(500))
        p.request_finished()
        self.assertTrue(p.should_exit(500))

    def test_dispatch_counts_failing_route(self):
        class Stub:
            path = '/api/boom'
            sent = []
            _send = lambda self, status, *a, **k: self.sent.append(status)
        def boom(h):
            raise RuntimeError('x')
        saved, server.PRESENCE = server.PRESENCE, Presence()
        try:
            with patch.object(server, 'ROUTES', [('GET', server.re.compile('^/api/boom$'), boom)]):
                with self.assertRaises(RuntimeError):
                    server.Handler.dispatch(Stub(), 'GET')
            self.assertEqual(server.PRESENCE.inflight, 0)
            self.assertEqual(Stub.sent, [500])
        finally:
            server.PRESENCE = saved

    def test_wait_idle(self):
        p = Presence()
        p.request_started()
        naps = []
        self.assertFalse(server.wait_idle(p, 1, naps.append, 0.5))
        self.assertEqual(len(naps), 2)
        naps.clear()
        self.assertTrue(server.wait_idle(p, 1, lambda s: p.request_finished(), 0.5))
        self.assertTrue(server.wait_idle(Presence(), 1, naps.append))
        self.assertEqual(naps, [])

    def test_routes(self):
        saved = server.PRESENCE
        server.PRESENCE = Presence()
        try:
            self.assertEqual(server.heartbeat(Request({'client': 'abc-123'})), {})
            self.assertEqual(server.bye(Request({'client': 'abc-123'})), {})
            self.assertIn('abc-123', server.PRESENCE.clients)
            for bad in ({}, {'client': ''}, {'client': 'a/b'}, {'client': 'x' * 65}, {'client': 5}):
                with self.assertRaises(server.ApiError):
                    server.heartbeat(Request(bad))
        finally:
            server.PRESENCE = saved


if __name__ == '__main__':
    unittest.main()
