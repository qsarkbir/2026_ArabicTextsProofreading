import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from proofreader import openiti, server, store


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

    def test_legacy_cache_is_not_trusted(self):
        p = self.project()
        store.ocr_put(p['slug'], 0, {'text': 'old', 'image_index': 0})
        self.assertIsNone(server.get_page(Request(), p['slug'], '0')['ocr'])
        p['offset'] = 99
        store.save_project(p['slug'], p)
        self.assertIsNone(server.get_page(Request(), p['slug'], '0')['ocr'])
        with self.assertRaises(server.ApiError):
            server.run_ocr(Request(), p['slug'], '0')

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


if __name__ == '__main__':
    unittest.main()
