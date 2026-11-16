"""The project backup (proofreader/bundle.py) and its HTTP routes; tests/bundle.test.js checks the same fixtures
against static/local/bundle.js.

tests/fixtures/bundle/cases.json: bundles that must be refused (with the message) or accepted (with the cleaned result).
tests/fixtures/bundle/python-export.proofreader.json: what this server exports for a synthetic project; the browser
smoke test imports it. Regenerate both after an intended change with UPDATE_FIXTURES=1 python -m unittest tests.test_bundle."""
import http.client
import json
import os
import re
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from proofreader import bundle, server, store
from tests.test_regressions import Request

FIXTURES = Path(__file__).parent / "fixtures" / "bundle"
STATIC = Path(__file__).parent.parent / "proofreader" / "static"
ORIGINAL = "\ufeff#META#Header#End#\r\n# alpha beta PageV01P001\r\n# gamma\r\n~~ delta PageV01P002\r\n# epsilon PageV02P001\r\n"


def outcome(case):
    try:
        project, text, work = bundle.parse(case["bundle"])
    except bundle.BundleError as e:
        return {"error": str(e)}
    return {"project": project, "text": text, "work": work}


class BundleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.root = patch.object(store, "ROOT", Path(self.temp.name))
        self.root.start()
        store._cache.clear()

    def tearDown(self):
        store._cache.clear()
        self.root.stop()
        self.temp.cleanup()

    def project(self, uri="fixture", text=ORIGINAL):
        slug = store.create({"uri": uri, "text": text, "meta": {}})["slug"]
        store.update_page(slug, 0, text="edited alpha", done=True, note="check & <this>")
        store.update_page(slug, 2, note="only a note")
        return slug

    def test_cases_match_shared_expected_json(self):
        cases = json.loads((FIXTURES / "cases.json").read_text(encoding="utf-8"))
        got = {c["name"]: outcome(c) for c in cases}
        path = FIXTURES / "expected.json"
        if os.environ.get("UPDATE_FIXTURES"):
            path.write_text(json.dumps(got, ensure_ascii=True, indent=1) + "\n", encoding="utf-8")
        self.assertEqual(got, json.loads(path.read_text(encoding="utf-8")))

    def test_newer_versions_are_refused_with_the_documented_message(self):
        for name in ("format-version-newer", "project-schema-newer", "work-schema-newer"):
            cases = json.loads((FIXTURES / "cases.json").read_text(encoding="utf-8"))
            case = next(c for c in cases if c["name"] == name)
            with self.assertRaises(server.ApiError) as cm:
                server.import_bundle(Request(case["bundle"]))
            self.assertIn("新しい版のアプリで作られたデータです", str(cm.exception))
            self.assertEqual(cm.exception.status, 400)
        self.assertEqual(store.list_projects(), [])

    def test_export_has_the_documented_shape(self):
        slug = self.project()
        out = json.loads(server.export(type("R", (Request,), {"send_download": lambda s, data, *a: data})(query={"fmt": ["bundle"]}), slug))
        self.assertEqual([out[k] for k in ("format", "format_version")], ["openiti-proofreader-project", 1])
        self.assertEqual(out["app"], {"mode": "http", "version": bundle.APP_VERSION})
        self.assertRegex(out["exported"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
        self.assertEqual(out["original"], ORIGINAL)
        self.assertEqual(sorted(out["work"]), ["edits", "history", "revisions", "schema_version", "status"])
        self.assertEqual(out["work"]["status"], {"0": {"done": True, "note": "check & <this>"}, "2": {"note": "only a note"}})

    def test_round_trip_keeps_original_work_and_project(self):
        for bom in ("", "\ufeff"):
            for nl in ("\n", "\r\n"):
                with self.subTest(bom=bool(bom), nl=repr(nl)):
                    text = bom + nl.join(["#META#Header#End#", "# a PageV01P001", "# b PageV01P002", "tail", ""])
                    slug = store.create({"uri": f"rt{len(bom)}{len(nl)}", "text": text, "meta": {}})["slug"]
                    store.update_page(slug, 1, text="changed")
                    data = bundle.build(slug)
                    project, original, work = bundle.parse(json.loads(json.dumps(data)))
                    copy = store.create_from_bundle(project, original, work)
                    self.assertNotEqual(copy["slug"], slug)
                    self.assertEqual(copy["slug"], f"{slug}_2")
                    self.assertEqual(store.original_text(copy["slug"]), text)
                    self.assertEqual(server.export(Request(), copy["slug"]), server.export(Request(), slug))
                    self.assertEqual(store.work(copy["slug"]), store.work(slug) | {"schema_version": 2})
                    self.assertEqual({k: v for k, v in store.load(copy["slug"]).items() if k != "slug"},
                                     {k: v for k, v in store.load(slug).items() if k != "slug"})
                    self.assertTrue((store.ROOT / copy["slug"] / "files").is_dir())

    def test_unedited_export_is_byte_identical_after_import(self):
        slug = store.create({"uri": "plain", "text": ORIGINAL, "meta": {}})["slug"]
        project, text, work = bundle.parse(json.loads(json.dumps(bundle.build(slug))))
        copy = store.create_from_bundle(project, text, work)["slug"]
        self.assertEqual(server.export(Request(), copy), ORIGINAL.encode("utf-8"))
        with (store.ROOT / copy / "original.txt").open("rb") as f:
            self.assertEqual(f.read(), ORIGINAL.encode("utf-8"))

    def test_incoming_slug_is_never_trusted(self):
        data = bundle.build(self.project())
        data["project"]["slug"] = "../../escaped"
        data["project"]["uri"] = "../../evil/name"
        view = server.import_bundle(Request(data))
        self.assertEqual(view["slug"], ".._.._evil_name")
        self.assertEqual(sorted(p.name for p in store.ROOT.iterdir()), sorted([view["slug"], "fixture"]))
        self.assertFalse((store.ROOT.parent / "escaped").exists())
        data["project"]["uri"] = ".."
        self.assertEqual(server.import_bundle(Request(data))["slug"], ".._2")
        data["project"]["uri"] = "日本語"
        self.assertEqual(server.import_bundle(Request(data))["slug"], "_")

    def test_import_route_returns_the_project_view_and_dedupes(self):
        slug = self.project()
        data = json.loads(json.dumps(bundle.build(slug)))
        view = server.import_bundle(Request(data))
        self.assertEqual((view["slug"], view["done"], view["edited"], view["noted"]), ("fixture_2", [0], [0], [0, 2]))
        self.assertEqual(server.import_bundle(Request(data))["slug"], "fixture_3")
        with self.assertRaises(server.ApiError):
            server.import_bundle(Request({"format": "nope"}))

    def test_missing_pdf_does_not_break_the_project(self):
        slug = self.project()
        data = bundle.build(slug)
        data["project"]["source"] = {"type": "ia", "id": "book", "revision": "r", "pdf_file": "ia-r.pdf",
                                     "pages": [{"label": "1", "service": "https://iiif.archive.org/x", "w": 1, "h": 1}] * 4}
        copy = server.import_bundle(Request(data))["slug"]
        self.assertEqual(store.load(copy)["source"]["pdf_file"], "ia-r.pdf")
        image = server.image_for(store.load(copy), 0)
        self.assertIn("url", image)
        self.assertNotIn("pdf", image)

    def test_failed_install_leaves_no_folder_and_frees_the_slug(self):
        with patch.object(store, "_write_json", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                store.create({"uri": "doomed", "text": ORIGINAL, "meta": {}})
        self.assertEqual(list(store.ROOT.iterdir()), [])
        self.assertEqual(store.create({"uri": "doomed", "text": ORIGINAL, "meta": {}})["slug"], "doomed")

    def test_install_never_removes_a_folder_it_did_not_make(self):
        original, made = store.Path.mkdir, []

        def racing(path, *a, **k):  # another process takes the slug between our look and our mkdir
            if path.name == "racy" and not made:
                made.append(1)
                original(path)
                (path / "project.json").write_text("{}", encoding="utf-8")
                raise FileExistsError(str(path))
            return original(path, *a, **k)
        with patch.object(store.Path, "mkdir", racing), patch.object(store, "_write_json", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                store.create({"uri": "racy", "text": ORIGINAL, "meta": {}})
        self.assertEqual(sorted(p.name for p in store.ROOT.iterdir()), ["racy"])  # the other process's project survives; ours is gone
        self.assertEqual((store.ROOT / "racy" / "project.json").read_text(encoding="utf-8"), "{}")
        made.clear()
        with patch.object(store.Path, "mkdir", racing):
            self.assertEqual(store.create({"uri": "racy", "text": ORIGINAL, "meta": {}})["slug"], "racy_2")

    def test_deeply_nested_backup_is_refused_not_a_crash(self):
        data = json.loads((FIXTURES / "cases.json").read_text(encoding="utf-8"))[0]["bundle"]
        deep = []
        for _ in range(5000):
            deep = [deep]
        data["project"]["meta"] = {"deep": deep}
        with self.assertRaises(bundle.BundleError):
            bundle.parse(data)

    def test_constants_match_bundle_js(self):
        js = (STATIC / "local" / "bundle.js").read_text(encoding="utf-8")
        for name in ("FORMAT", "APP_VERSION"):
            self.assertEqual(re.search(rf"const {name} = '([^']+)'", js)[1], getattr(bundle, name), name)
        for name in ("FORMAT_VERSION", "SCHEMA_VERSION"):
            self.assertEqual(int(re.search(rf"const {name} = (\d+)", js)[1]), getattr(bundle, name), name)

    def test_python_export_fixture(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(store, "ROOT", Path(tmp)), patch.object(store.time, "time", lambda: 1800000000):
            store._cache.clear()
            slug = store.create({"uri": "0999SyntheticAuthor.SyntheticBook.Test0001-ara1", "text": ORIGINAL, "meta": {}, "raw_url": "https://example.org/x"})["slug"]
            store.update_page(slug, 0, text="edited alpha", done=True, note="synthetic note")
            store.update_page(slug, 2, note="note only")
            p = store.load(slug)
            p["created"], p["bibliography"] = "2026-11-16 00:00", {"edition": "Synthetic edition"}
            p["source"] = {"type": "pdf", "file": "gone.pdf", "revision": "r", "title": "Synthetic", "count": 3}
            store.save_project(slug, p)
            data = bundle.build(slug) | {"exported": "2026-11-16T00:00:00Z"}
            store._cache.clear()
        path = FIXTURES / "python-export.proofreader.json"
        if os.environ.get("UPDATE_FIXTURES"):
            path.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
        self.assertEqual(data, json.loads(path.read_text(encoding="utf-8")))


class StaticRedirectTests(unittest.TestCase):
    def test_unknown_paths_redirect_to_the_root(self):
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        try:
            def get(path):
                c = http.client.HTTPConnection("127.0.0.1", httpd.server_address[1])
                c.request("GET", path)
                r = c.getresponse()
                return r.status, r.getheader("Location"), r.read()
            for path in ("/x/mode.js", "/x/", "/x/app.js", "/nope", "/local/nope.js", "/..%2f..%2fREADME.md", "/vendor/pdfjs"):
                with self.subTest(path):
                    self.assertEqual(get(path)[:2], (302, "/"))
            status, _, body = get("/")
            self.assertEqual(status, 200)
            self.assertIn(b"<title>", body)
            self.assertEqual(get("/index.html")[0], 200)
            self.assertEqual(get("/mode.js")[2], b"const PROOF_MODE = 'http';\n")
            self.assertEqual(get("/app.js")[0], 200)
            self.assertEqual(get("/local/tei.js")[0], 200)
            self.assertEqual(get("/api/nothing")[0], 404)
        finally:
            httpd.shutdown()
            httpd.server_close()


if __name__ == "__main__":
    unittest.main()
