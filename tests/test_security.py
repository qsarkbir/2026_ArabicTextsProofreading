"""The server only answers pages that were opened from its own address (CSRF and DNS rebinding)."""
import http.client
import json
import threading
import unittest
from http.server import ThreadingHTTPServer

from proofreader import server


class OriginHostTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def call(self, method, path, headers=None, body=b"{}", host=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port)
        c.putrequest(method, path, skip_host=True)
        c.putheader("Host", host or f"127.0.0.1:{self.port}")
        for k, v in (headers or {}).items():
            c.putheader(k, v)
        c.putheader("Content-Length", str(len(body)))
        c.endheaders(body)
        r = c.getresponse()
        return r.status, r.read()

    def test_cross_origin_posts_are_refused(self):
        for origin in ("https://evil.example", "http://127.0.0.1:1", f"http://127.0.0.1:{self.port}.evil.example",
                       f"https://127.0.0.1:{self.port}", "null", f"http://localhost:{self.port + 1}"):
            for method, path in (("POST", "/api/projects/import-bundle"), ("POST", "/api/shutdown"), ("PUT", "/api/projects/x/pages/0")):
                with self.subTest(origin=origin, path=path):
                    status, body = self.call(method, path, {"Origin": origin, "Content-Type": "text/plain"})
                    self.assertEqual(status, 403)
                    self.assertIn("error", json.loads(body))

    def test_same_origin_and_originless_requests_are_served(self):
        for origin in (f"http://127.0.0.1:{self.port}", f"http://localhost:{self.port}", None):
            with self.subTest(origin=origin):
                status, _ = self.call("POST", "/api/projects/import-bundle", {"Origin": origin} if origin else {})
                self.assertEqual(status, 400)  # reached the handler, which refuses the empty bundle

    def test_fetch_metadata_marks_cross_site_writes(self):
        for site in ("cross-site", "same-site"):
            with self.subTest(site=site):
                self.assertEqual(self.call("POST", "/api/projects/import-bundle", {"Sec-Fetch-Site": site})[0], 403)
        for site in ("same-origin", "none"):
            with self.subTest(site=site):
                self.assertEqual(self.call("POST", "/api/projects/import-bundle", {"Sec-Fetch-Site": site})[0], 400)
        self.assertEqual(self.call("GET", "/", {"Sec-Fetch-Site": "cross-site"})[0], 200)

    def test_port_less_host_is_accepted_only_on_port_80(self):
        def check(port, host, origin=None):
            stub = type("S", (), {"server": type("V", (), {"server_address": ("127.0.0.1", port)})(),
                                  "headers": {k: v for k, v in (("Host", host), ("Origin", origin)) if v}})()
            return server.Handler.origin_ok(stub, "POST")
        self.assertTrue(check(80, "127.0.0.1", "http://localhost"))
        self.assertTrue(check(80, "localhost:80", "http://localhost:80"))
        self.assertFalse(check(80, "evil.example"))
        self.assertFalse(check(8765, "127.0.0.1"))
        self.assertFalse(check(8765, "localhost", "http://localhost"))

    def test_json_body_refuses_nan_and_deep_nesting(self):
        def parse(raw):
            return server.Handler.json(type("S", (), {"body": lambda self: raw})())
        for raw in (b'{"a": NaN}', b'[Infinity]', b'-Infinity', b"[" * 100000):
            with self.subTest(raw=raw[:12]):
                with self.assertRaises(server.ApiError) as cm:
                    parse(raw)
                self.assertEqual((cm.exception.status, str(cm.exception)), (400, "JSONとして読めません"))
        self.assertEqual(parse(b'{"a": 1.5}'), {"a": 1.5})

    def test_bad_host_is_refused_for_every_method(self):
        for host in ("evil.example", "evil.example:80", f"127.0.0.1.evil.example:{self.port}", "127.0.0.1:1", "localhost"):
            for method, path in (("GET", "/"), ("GET", "/api/projects"), ("POST", "/api/projects/import-bundle")):
                with self.subTest(host=host, path=path):
                    self.assertEqual(self.call(method, path, host=host)[0], 403)
        self.assertEqual(self.call("GET", "/", host=f"localhost:{self.port}")[0], 200)
        self.assertEqual(self.call("GET", "/", {"Origin": "https://other.example"})[0], 200)  # plain navigation and image loads


if __name__ == "__main__":
    unittest.main()
