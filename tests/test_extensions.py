import io
import json
import os
import tempfile
import unittest
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path
from unittest.mock import patch

from proofreader import net, ocr, openiti, providers, server, store
from proofreader.exporters import tei
from proofreader.importers import draft
from proofreader.presence import Presence
from tests.test_regressions import Request


class ExtensionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = patch.object(store, 'ROOT', Path(self.tmp.name))
        self.root.start()
        self.addCleanup(self.root.stop)
        store._cache.clear()
        self.addCleanup(store._cache.clear)
        self.p = store.create({'uri':'test', 'text':'# alpha beta\nPageV01P001\n', 'meta':{}})
        self.slug = self.p['slug']

    def save(self, revision, **fields):
        return server.put_page(Request({'revision':revision, **fields}), self.slug, '0')

    def test_stale_save_rejected_and_first_edit_preserved(self):
        self.save(0, text='ALPHA beta')
        with self.assertRaises(server.ApiError) as error:
            self.save(0, text='alpha BETA')
        self.assertEqual(error.exception.status, 409)
        self.assertEqual(server.get_page(Request(), self.slug, '0')['text'], 'ALPHA beta')

    def test_legacy_work_gets_revision_and_history_without_changing_original(self):
        original = (store.ROOT / self.slug / 'original.txt').read_bytes()
        self.assertEqual(server.get_page(Request(), self.slug, '0')['revision'], 0)
        self.assertEqual(self.save(0, text='changed')['revision'], 1)
        entries = server.page_history(Request(), self.slug, '0')
        self.assertEqual(entries[0]['text'], '# alpha beta\n')
        self.assertEqual((store.ROOT / self.slug / 'original.txt').read_bytes(), original)
        self.save(1, text=entries[0]['text'])
        self.assertNotIn('0', store.work(self.slug)['edits'])

    def test_missing_revision_rejected(self):
        with self.assertRaises(server.ApiError) as error:
            server.put_page(Request({'text':'unsafe'}), self.slug, '0')
        self.assertEqual(error.exception.status, 428)

    def test_edited_confirmed_page_needs_review(self):
        self.save(0, done=True)
        self.save(1, text='new text')
        self.assertFalse(server.get_page(Request(), self.slug, '0')['done'])

    def test_tail_is_editable_searchable_and_lossless(self):
        text = '\ufeff#META#Header#End#\r\nfirst PageV01P001\r\nTAIL'
        p = store.create({'uri':'tail', 'text':text, 'meta':{}})
        self.assertEqual(server.export(Request(), p['slug']), text.encode())
        pg = server.get_page(Request(), p['slug'], '1')
        self.assertTrue(pg['unassigned'])
        self.assertIsNone(pg['image'])
        self.assertEqual(server.search_pages(Request(query={'q':['TAIL']}), p['slug'])[0]['i'], 1)
        server.put_page(Request({'revision':0, 'text':'fixed tail'}), p['slug'], '1')
        self.assertTrue(server.export(Request(), p['slug']).endswith(b'fixed tail'))

    def test_url_and_uri_resolve_to_same_metadata(self):
        uri = '1014IbnMaryamTilimsani.Bustan.Kraken22021817402301-ara1'
        for extension in ('.mARkdown', '.completed', '.inProgress'):
            raw, name = openiti.resolve(uri + extension)
            expected = openiti.yml_urls(raw, name)
            for url in (raw, raw.replace('raw.githubusercontent.com/OpenITI/1025AH/master/', 'github.com/OpenITI/1025AH/blob/master/')):
                self.assertEqual(openiti.yml_urls(*openiti.resolve(url)), expected)

    def test_readings_remain_available_after_reread(self):
        a = store.ocr_put(self.slug, 0, {'text':'first', 'image_key':'image', 'model':'a'})
        b = store.ocr_put(self.slug, 0, {'text':'second', 'image_key':'image', 'model':'b'})
        self.assertNotEqual(a['reading_id'], b['reading_id'])
        self.assertEqual(len(store.ocr_history(self.slug, 0, 'image')), 2)
        self.assertEqual(store.ocr_history(self.slug, 0, 'different'), [])
        self.assertEqual(store.ocr_get(self.slug, 0)['text'], 'second')

    def test_legacy_reading_is_archived(self):
        store._write_json(store.ROOT / self.slug / 'ocr/0.json', {'text':'old', 'image_key':'image'})
        store.ocr_put(self.slug, 0, {'text':'new', 'image_key':'image'})
        self.assertEqual({r['text'] for r in store.ocr_history(self.slug, 0, 'image')}, {'old', 'new'})

    def test_model_alias_reuses_reading_without_another_paid_call(self):
        p = store.load(self.slug)
        p['source'] = {'type':'pdf', 'file':'source.pdf', 'revision':'r', 'count':1}
        store.save_project(self.slug, p)
        key = server.image_for(p, 0)['key']
        store.ocr_put(self.slug, 0, {'text':'reading', 'image_key':key, 'provider':'openai',
                                   'model':'model-dated', 'requested_model':'model-alias'})
        with patch.object(providers, 'transcribe') as call:
            result = server.run_ocr(Request({'provider':'openai', 'model':'model-alias'}), self.slug, '0')
            self.assertEqual(result['text'], 'reading')
            call.assert_not_called()

    def test_pdf_job_prevents_autoexit_and_releases_on_failure(self):
        presence = Presence()
        presence.beat('tab', 0); presence.bye('tab', 1)
        p = store.load(self.slug)
        p['source'] = {'type':'ia', 'id':'test', 'revision':'r', 'pages':[]}
        store.save_project(self.slug, p)
        with patch.object(server, 'PRESENCE', presence), patch.object(server, 'PDF_JOBS', {}), \
                patch.object(server, 'PDF_MISMATCH', {}), patch.object(server.sources, 'ia_pdf', return_value={'name':'x.pdf','size':10}), \
                patch.object(server.threading, 'Thread') as thread:
            server.ia_pdf_start(Request(), self.slug)
            self.assertFalse(presence.should_exit(100))
            args = thread.call_args.kwargs['args']
            with patch.object(net, 'download', side_effect=net.FetchError('fixture failure')):
                server.pdf_download(*args)
            self.assertTrue(presence.should_exit(100))

    def test_new_pdf_draft_mapping_and_package(self):
        metadata = {'title':'Example', 'author':'Author', 'count':5, 'start':2, 'end':4,
                    'first_page':10, 'volume':2, 'edition':'Edition', 'rights':'Local rights'}
        result = server.create_pdf_draft(Request(data=b'%PDF-fixture', headers={'X-Metadata':json.dumps(metadata)}))
        self.assertEqual(result['pages'][0]['page'], 10)
        self.assertEqual(result['pages'][-1]['page'], 12)
        self.assertEqual(result['offset'], 1)
        self.assertTrue(result['draft'])
        self.assertEqual(result['done'], [])
        archive = server.export(Request(query={'fmt':['package']}), result['slug'])
        with zipfile.ZipFile(io.BytesIO(archive)) as z:
            self.assertIn(f"{result['slug']}.mARkdown", z.namelist())
            self.assertIn('Local rights', z.read('bibliography.json').decode())

    def test_draft_rejects_invalid_range(self):
        for values in ({'start':0}, {'start':4,'end':2}, {'volume':-1}, {'title':''}):
            with self.assertRaises(ValueError):
                draft.build({'title':'Example', 'count':3, **values})

    def test_tei_pages_precede_text_and_notes_escape(self):
        self.save(0, note='note & <literal>')
        data = server.export(Request(query={'fmt':['tei']}), self.slug)
        root = ET.fromstring(data)
        ns = {'t':tei.NS}
        body = root.find('.//t:body', ns)
        tags = [el.tag.split('}')[-1] for el in body.iter()]
        self.assertLess(tags.index('pb'), tags.index('p'))
        self.assertEqual(root.find('.//t:note', ns).text, 'note & <literal>')
        self.assertEqual(root.find('.//t:pb', ns).get('n'), '1')

    def test_tei_preserves_cross_page_paragraph_and_poetry(self):
        parts = openiti.split('# one PageV01P001\n~~ two\n# left %~% right\nPageV01P002\n')
        data, warnings = tei.export(self.p, parts, {'edits':{}, 'status':{}})
        root = ET.fromstring(data)
        ns = {'t':tei.NS}
        paragraphs = root.findall('.//t:body/t:p', ns)
        self.assertEqual(len(paragraphs), 1)
        self.assertIn('two', ''.join(paragraphs[0].itertext()))
        self.assertEqual(paragraphs[0].find('t:pb', ns).get('n'), '2')
        self.assertIsNotNone(root.find('.//t:l/t:caesura', ns))

    def test_tei_rejects_xml_control_characters(self):
        self.save(0, note='invalid\x00note')
        with self.assertRaises(server.ApiError):
            server.export(Request(query={'fmt':['tei']}), self.slug)


class ProviderTests(unittest.TestCase):
    def test_openai_payload_and_response(self):
        response = {'status':'completed','model':'test-model','output':[{'type':'message','content':[{'type':'output_text','text':'reading'}]}],
                    'usage':{'input_tokens':12,'output_tokens':3}}
        with patch.dict(os.environ, {'OPENAI_API_KEY':'synthetic-key'}), patch.object(net, 'post_json', return_value=response) as request:
            result = providers.transcribe(b'image', 'image/png', 'openai', 'test-model')
        self.assertEqual(result['text'], 'reading')
        self.assertEqual(result['provider'], 'openai')
        self.assertEqual(result['requested_model'], 'test-model')
        payload = request.call_args.args[1]
        self.assertFalse(payload['store'])
        self.assertEqual(payload['input'][0]['content'][1]['image_url'], 'data:image/png;base64,aW1hZ2U=')
        self.assertNotIn('synthetic-key', json.dumps(result))

    def test_empty_and_refused_readings_do_not_enter_cache(self):
        for content in ([], [{'type':'refusal','refusal':'no'}]):
            with patch.dict(os.environ, {'OPENAI_API_KEY':'synthetic-key'}), patch.object(net, 'post_json', return_value={
                    'status':'completed','output':[{'type':'message','content':content}]}):
                with self.assertRaises(ocr.OCRUnavailable):
                    providers.transcribe(b'image', 'image/jpeg', 'openai', 'test')

    def test_incomplete_reading_is_flagged(self):
        with patch.dict(os.environ, {'OPENAI_API_KEY':'synthetic-key'}), patch.object(net, 'post_json', return_value={
                'status':'incomplete','output':[{'type':'message','content':[{'type':'output_text','text':'partial'}]}]}):
            result = providers.transcribe(b'image', 'image/jpeg', 'openai', 'test')
            self.assertTrue(result['truncated'])

    def test_missing_configuration_has_no_network_call(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(net, 'post_json') as request:
            with self.assertRaises(ocr.OCRUnavailable):
                providers.transcribe(b'image', 'image/jpeg', 'openai', 'test')
            request.assert_not_called()


if __name__ == '__main__':
    unittest.main()
