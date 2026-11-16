"""Project deletion: store.delete_project and DELETE /api/projects/<slug>, including path safety and the Origin check."""
import http.client
import json
import mimetypes
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from proofreader import server, store


class DeleteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.root = patch.object(store, "ROOT", Path(self.temp.name))
        self.root.start()
        store._cache.clear()
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        store._cache.clear()
        server.DRAFTS.clear()
        self.root.stop()
        self.temp.cleanup()

    def project(self, uri="fixture"):
        p = store.create({"uri": uri, "text": "alpha PageV01P001\nbeta PageV01P002\n", "meta": {}})
        d = store.ROOT / p["slug"]
        for rel in ("ocr/0.json", "ocr/history/0/a.json", "files/source.pdf", "cache/scan/0.jpg"):
            (d / rel).parent.mkdir(parents=True, exist_ok=True)
            (d / rel).write_bytes(b"x")
        store.parts(p["slug"])
        return p["slug"]

    def call(self, method, path, headers=None, host=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port)
        c.putrequest(method, path, skip_host=True)
        c.putheader("Host", host or f"127.0.0.1:{self.port}")
        for k, v in (headers or {}).items():
            c.putheader(k, v)
        c.putheader("Content-Length", "0")
        c.endheaders()
        r = c.getresponse()
        return r.status, json.loads(r.read() or b"{}")

    def test_store_removes_everything_and_the_caches(self):
        a, b = self.project("a"), self.project("b")
        self.assertIn(a, store._cache)
        store.delete_project(a)
        self.assertFalse((store.ROOT / a).exists())
        self.assertNotIn(a, store._cache)
        self.assertEqual([p["slug"] for p in store.list_projects()], [b])
        self.assertEqual([x.name for x in store.ROOT.iterdir()], [b])  # no leftover trash folder
        with self.assertRaises(KeyError):
            store.delete_project(a)
        self.assertEqual(store.original_text(b), "alpha PageV01P001\nbeta PageV01P002\n")

    def test_store_refuses_paths_outside_root(self):
        outside = Path(self.temp.name) / "outside"
        outside.mkdir()
        (outside / "project.json").write_text("{}")
        (store.ROOT / "inner").mkdir()
        for bad in ("..", ".", "", "../outside", "a/b", "inner/../../outside", "x\0"):
            with self.subTest(slug=bad), self.assertRaises(KeyError):
                store.delete_project(bad)
        self.assertTrue(outside.exists())
        link = store.ROOT / "link"
        try:
            link.symlink_to(outside, target_is_directory=True)
        except OSError:
            self.skipTest("symlinks are not available")
        with self.assertRaises(KeyError):
            store.delete_project("link")
        self.assertTrue((outside / "project.json").exists())

    def test_route_deletes_and_clears_server_state(self):
        slug = self.project()
        server.DRAFTS[slug] = {"revision": "r"}
        server.PDF_JOBS[slug] = {"state": "done"}
        status, body = self.call("DELETE", f"/api/projects/{slug}")
        self.assertEqual((status, body), (200, {"deleted": slug}))
        self.assertFalse((store.ROOT / slug).exists())
        self.assertNotIn(slug, server.DRAFTS)
        self.assertNotIn(slug, server.PDF_JOBS)
        self.assertEqual(self.call("DELETE", f"/api/projects/{slug}")[0], 404)
        self.assertEqual(self.call("GET", f"/api/projects/{slug}")[0], 404)

    def test_route_refuses_odd_slugs_and_keeps_other_projects(self):
        slug = self.project()
        for path in ("/api/projects/..", "/api/projects/%2e%2e", "/api/projects/a%2Fb", "/api/projects/missing"):
            with self.subTest(path=path):
                self.assertIn(self.call("DELETE", path)[0], (404,))
        self.assertTrue((store.ROOT / slug / "project.json").exists())

    def test_cross_origin_delete_is_refused(self):
        slug = self.project()
        for headers in ({"Origin": "https://evil.example"}, {"Origin": "null"}, {"Sec-Fetch-Site": "cross-site"}, {"Sec-Fetch-Site": "same-site"}):
            with self.subTest(headers=headers):
                status, body = self.call("DELETE", f"/api/projects/{slug}", headers)
                self.assertEqual(status, 403)
                self.assertIn("error", body)
        self.assertEqual(self.call("DELETE", f"/api/projects/{slug}", host="evil.example")[0], 403)  # DNS rebinding
        self.assertTrue((store.ROOT / slug / "project.json").exists())
        self.assertEqual(self.call("DELETE", f"/api/projects/{slug}", {"Origin": f"http://127.0.0.1:{self.port}"})[0], 200)

    def test_pdf_assets_have_usable_types(self):
        self.assertEqual(mimetypes.guess_type("openjpeg.wasm")[0], "application/wasm")
        self.assertEqual(mimetypes.guess_type("FoxitSerif.pfb")[0], "application/octet-stream")


if __name__ == "__main__":
    unittest.main()
