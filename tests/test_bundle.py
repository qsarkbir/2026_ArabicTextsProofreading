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
import itertools
import threading
import time
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from proofreader import bundle, server, store
from tests.test_regressions import Request

FIXTURES = Path(__file__).parent / "fixtures" / "bundle"
STATIC = Path(__file__).parent.parent / "proofreader" / "static"
ORIGINAL = "\ufeff#META#Header#End#\r\n# alpha beta PageV01P001\r\n# gamma\r\n~~ delta PageV01P002\r\n# epsilon PageV02P001\r\n"


def fixed_clock():
    """Deterministic reading ids and times (one minute apart) for store.ocr_put."""
    from contextlib import ExitStack
    real, count = time.gmtime, itertools.count()
    ids = (type("U", (), {"hex": f"{n:032x}"}) for n in itertools.count(1))
    stack = ExitStack()
    stack.enter_context(patch.object(store.time, "gmtime", lambda *a: real(1800000000 + 60 * next(count))))
    stack.enter_context(patch.object(store.uuid, "uuid4", lambda: next(ids)))
    return stack


def outcome(case):
    try:
        project, text, work, ocr = bundle.parse(case["bundle"])
    except bundle.BundleError as e:
        return {"error": str(e)}
    return {"project": project, "text": text, "work": work, "ocr": ocr}


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
                    project, original, work, ocr = bundle.parse(json.loads(json.dumps(data)))
                    copy = store.create_from_bundle(project, original, work, ocr)
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
        project, text, work, ocr = bundle.parse(json.loads(json.dumps(bundle.build(slug))))
        copy = store.create_from_bundle(project, text, work, ocr)["slug"]
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
        for name in ("FORMAT_VERSION", "BASE_VERSION", "SCHEMA_VERSION"):
            self.assertEqual(int(re.search(rf"const {name} = (\d+)", js)[1]), getattr(bundle, name), name)

    def readings(self, slug):
        """Three readings on page 0 (the middle one replaced a legacy file without an id) and one on page 2."""
        folder = store.ROOT / slug / "ocr"
        store._write_json(folder / "0.json", {"text": "legacy", "model": "claude-opus-5-5", "image_index": 0})  # written before readings had ids
        with fixed_clock():
            store.ocr_put(slug, 0, {"text": "one", "image_key": "k", "usage": {"input": 5, "output": 6}})
            store.ocr_put(slug, 0, {"text": "two", "image_key": "k", "truncated": True})
            store.ocr_put(slug, 2, {"text": "three", "image_key": "z", "provider": "openai"})

    def test_ocr_round_trip_through_a_backup(self):
        slug = self.project()
        self.readings(slug)
        data = json.loads(json.dumps(bundle.build(slug)))
        self.assertEqual(data["format_version"], 2)
        self.assertEqual(sorted(data["ocr"]), ["0", "2"])
        self.assertEqual([r["text"] for r in data["ocr"]["0"]["history"]], ["legacy", "one", "two"])  # legacy first: it has no time
        self.assertEqual(data["ocr"]["0"]["current"]["text"], "two")
        project, text, work, ocr = bundle.parse(data)
        copy = store.create_from_bundle(project, text, work, ocr)["slug"]
        self.assertEqual(store.ocr_get(copy, 0), store.ocr_get(slug, 0))
        self.assertEqual(store.ocr_get(copy, 2), store.ocr_get(slug, 2))
        self.assertEqual(store.ocr_history(copy, 0, "k"), store.ocr_history(slug, 0, "k"))
        self.assertEqual(sorted(p.name for p in (store.ROOT / copy / "ocr" / "history" / "0").iterdir()),
                         sorted(p.name for p in (store.ROOT / slug / "ocr" / "history" / "0").iterdir()))
        self.assertEqual(json.loads(json.dumps(bundle.build(copy)))["ocr"], data["ocr"])  # a second round trip changes nothing

    def test_current_reading_missing_from_history_is_kept_by_the_next_ocr_put(self):
        slug = self.project()
        data = json.loads(json.dumps(bundle.build(slug)))
        data["format_version"] = 2
        data["ocr"] = {"0": {"current": {"text": "cur", "reading_id": "Cur1", "time": "2026-11-16T01:02:03Z"},
                             "history": [{"text": "old", "reading_id": "old1", "time": "2026-11-16T01:00:00Z"}]}}
        project, text, work, ocr = bundle.parse(data)
        copy = store.create_from_bundle(project, text, work, ocr)["slug"]
        folder = store.ROOT / copy / "ocr" / "history" / "0"
        self.assertEqual(sorted(p.name for p in folder.iterdir()), ["Cur1.json", "old1.json"])
        with fixed_clock():
            store.ocr_put(copy, 0, {"text": "new", "image_key": "k"})
        self.assertEqual(sorted(r["text"] for r in bundle.build(copy)["ocr"]["0"]["history"]), ["cur", "new", "old"])
        data["ocr"]["0"]["history"].append({"text": "same", "reading_id": "CUR1"})  # a history id that differs only in case: the current one is not written again
        copy2 = store.create_from_bundle(*bundle.parse(data))["slug"]
        self.assertEqual(sorted(x.name for x in (store.ROOT / copy2 / "ocr" / "history" / "0").iterdir()), ["CUR1.json", "old1.json"])

    def test_generated_reading_ids_are_never_windows_device_names(self):
        slug = self.project()
        rid = store.ocr_put(slug, 0, {"text": "x"})["reading_id"]
        self.assertRegex(rid, r"^[0-9a-f]{32}$")
        self.assertIsNone(bundle.RESERVED_NAME.fullmatch(rid))
        for bad in ("CON", "nul", "Com9", "lpt1"):
            self.assertTrue(bundle.RESERVED_NAME.fullmatch(bad), bad)

    def test_backup_without_ocr_stays_format_1_and_ocr_can_be_left_out(self):
        slug = self.project()
        self.assertEqual((bundle.build(slug)["format_version"], "ocr" in bundle.build(slug)), (1, False))
        self.readings(slug)
        request = lambda q: type("R", (Request,), {"send_download": lambda s, data, *a: data})(query={"fmt": ["bundle"], **q})
        self.assertEqual(json.loads(server.export(request({}), slug))["format_version"], 2)
        plain = json.loads(server.export(request({"ocr": ["0"]}), slug))
        self.assertEqual((plain["format_version"], "ocr" in plain), (1, False))

    def test_backup_never_holds_an_api_key_field(self):
        slug = self.project()
        self.readings(slug)
        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "sk-ant-secret-123", "OPENAI_API_KEY": "sk-secret-456"}):
            text = json.dumps(bundle.build(slug))
        self.assertNotIn("secret", text)

    def test_unreadable_or_invalid_readings_are_left_out_of_the_backup(self):
        slug = self.project()
        self.readings(slug)
        (store.ROOT / slug / "ocr" / "history" / "0" / "broken.json").write_text("{not json", encoding="utf-8")
        store._write_json(store.ROOT / slug / "ocr" / "history" / "0" / "odd.json", {"text": 5})
        store._write_json(store.ROOT / slug / "ocr" / "1.json", {"text": "bad time", "time": "yesterday"})
        data = bundle.build(slug)
        self.assertEqual(len(data["ocr"]["0"]["history"]), 3)
        self.assertNotIn("1", data["ocr"])
        bundle.parse(json.loads(json.dumps(data)))  # still readable

    def test_install_with_a_bad_reading_id_writes_nothing(self):
        data = json.loads((FIXTURES / "cases.json").read_text(encoding="utf-8"))[0]["bundle"]
        project, text, work, _ = bundle.parse(data)
        for ocr in ({"0": {"history": [{"text": "x", "reading_id": "../escape"}]}}, {"../0": {"history": []}}):
            with self.assertRaises(ValueError):
                store.create_from_bundle(project, text, work, ocr)
        self.assertEqual(list(store.ROOT.iterdir()), [])
        self.assertFalse((store.ROOT.parent / "escape.json").exists())

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
            with fixed_clock():
                for i, text in ((0, "first reading"), (0, "second reading"), (1, "page two")):
                    store.ocr_put(slug, i, {"text": text, "model": "claude-opus-5-5", "provider": "anthropic", "requested_model": "claude-opus-5-5",
                                            "prompt_version": "printed-arabic-3", "truncated": False, "usage": {"input": 1000, "output": 200 + i},
                                            "image_index": i, "image_key": f"key{i}"})
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
