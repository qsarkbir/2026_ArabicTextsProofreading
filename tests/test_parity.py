"""openiti.py against the shared fixtures in tests/fixtures/openiti (tests/openiti.test.js checks the same files).

Regenerate expected.json after an intended change with UPDATE_FIXTURES=1 python -m unittest tests.test_parity."""
import json
import os
import random
import re
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from proofreader import ocr, openiti, providers, server, store
from tests.test_regressions import Request

FIXTURES = Path(__file__).parent / "fixtures" / "openiti"
WORK = Path(__file__).parent / "fixtures" / "work"
STATIC = Path(__file__).parent.parent / "proofreader" / "static" / "local"
inputs = json.loads((FIXTURES / "inputs.json").read_text(encoding="utf-8"))


def resolved(ref):
    try:
        raw_url, uri = openiti.resolve(ref)
    except ValueError as e:
        return {"error": str(e)}
    return {"raw_url": raw_url, "uri": uri, "yml_urls": openiti.yml_urls(raw_url, uri)}


def compute():
    split = {k: openiti.split(v) for k, v in {**inputs["texts"], **{f"fuzz{i}": s for i, s in enumerate(inputs["fuzz"])}}.items()}
    meta = {k: openiti.parse_yml(v) for k, v in inputs["yml"].items()}
    return {
        "split": split,
        "join_edits": {k: openiti.join(split[k], e) for k, e in inputs["edits"].items()},
        "yml": meta,
        "scan_links": openiti.scan_links(meta),
        "metas": [{"title": openiti.title_of(m["meta"], m["text"], m["uri"]), "author": openiti.author_of(m["meta"], m["text"], m["uri"])}
                  for m in inputs["metas"]],
        "resolve": [resolved(r) for r in inputs["resolve"]],
        "repo_for": {str(y): openiti.repo_for(y) for y in (1, 25, 26, 1014, 1025, 1026, 9999)},
    }


class ParityTests(unittest.TestCase):
    def test_matches_shared_expected_json(self):
        got = compute()
        path = FIXTURES / "expected.json"
        if os.environ.get("UPDATE_FIXTURES"):
            path.write_text(json.dumps(got, ensure_ascii=True, indent=1) + "\n", encoding="utf-8")
        self.assertEqual(got, json.loads(path.read_text(encoding="utf-8")))

    def test_fixtures_round_trip(self):
        for name, text in inputs["texts"].items():
            with self.subTest(name):
                self.assertEqual(openiti.join(openiti.split(text)), text)

    def test_random_round_trip(self):
        rnd = random.Random(7)
        atoms = ["PageV01P001", "PageV2P13", "#META#Header#End#", "\n", "\r\n", "\r", " ", "﻿", "\U0001F600", "بِسْمِ", "abc", "Page", " "]
        for _ in range(500):
            s = "".join(rnd.choice(atoms) for _ in range(rnd.randint(0, 40)))
            self.assertEqual(openiti.join(openiti.split(s)), s, repr(s))


def status_of(o):
    return {k: v for k, v in (("done", True if o.get("done") else None), ("note", o.get("note") or None)) if v}


def normalized(work):
    """Status compared semantically: only a true done and a non-empty note count."""
    status = {k: status_of(v) for k, v in work.get("status", {}).items()}
    history = {k: [{"text": e["text"], **status_of(e), "revision": e["revision"], "time": e["time"]} for e in v]
               for k, v in work.get("history", {}).items()}
    return {"edits": work["edits"], "status": {k: v for k, v in status.items() if v}, "history": history,
            "revisions": work.get("revisions", {}), "schema_version": work["schema_version"]}


def replay_ops():
    ops = json.loads((WORK / "ops.json").read_text(encoding="utf-8"))
    out = {}
    for seq in ops["sequences"]:
        with tempfile.TemporaryDirectory() as tmp, patch.object(store, "ROOT", Path(tmp)), \
                patch.object(store, "HISTORY_WINDOW", seq.get("window", store.HISTORY_WINDOW)), \
                patch.object(store, "HISTORY_LIMIT", seq.get("limit", store.HISTORY_LIMIT)):
            store._cache.clear()
            slug = store.create({"uri": seq["name"], "text": ops["original"], "meta": {}})["slug"]
            results = []
            for op in seq["ops"]:
                body = {k: op[k] for k in ("revision", "text", "done", "note", "checkpoint") if k in op}
                with patch.object(store.time, "time", lambda: op["now"]):
                    try:
                        server.put_page(Request(body), slug, str(op["i"]))
                        results.append({"work": normalized(store.work(slug))})
                    except server.ApiError as e:
                        results.append({"error": int(e.status)})
            store._cache.clear()
        out[seq["name"]] = results
    return out


class WorkParityTests(unittest.TestCase):
    def test_constants_match_work_js(self):
        js = (STATIC / "work.js").read_text(encoding="utf-8")
        for name in ("HISTORY_WINDOW", "HISTORY_LIMIT"):
            self.assertEqual(int(re.search(rf"const {name} = (\d+)", js)[1]), getattr(store, name), name)

    def test_save_operations_match_shared_expected_json(self):
        got = replay_ops()
        path = WORK / "expected.json"
        if os.environ.get("UPDATE_FIXTURES"):
            path.write_text(json.dumps(got, ensure_ascii=True, indent=1) + "\n", encoding="utf-8")
        self.assertEqual(got, json.loads(path.read_text(encoding="utf-8")))


class OcrParityTests(unittest.TestCase):
    """local/ocr.js (browser version) sends the same request as ocr.py: same prompt, models and versions (D-40)."""
    js = (STATIC / "ocr.js").read_text(encoding="utf-8")

    def test_prompt_and_versions_match(self):
        self.assertEqual(re.search(r"const PROMPT = `(.*?)`;", self.js, re.S)[1], ocr.PROMPT)
        self.assertEqual(re.search(r"const PROMPT_VERSION = '([^']*)'", self.js)[1], providers.PROMPT_VERSION)
        self.assertEqual(re.search(r"const MODEL = '([^']*)'", self.js)[1], ocr.MODEL)

    def test_models_match(self):
        block = re.search(r"const MODELS = \{(.*?)\n  \};", self.js, re.S)[1]
        self.assertEqual(dict(re.findall(r"'([^']+)': '([^']+)'", block)), ocr.MODELS)
        names = re.search(r"const NO_FALLBACK = \[(.*?)\]", self.js)[1]
        self.assertEqual(set(re.findall(r"'([^']+)'", names)), ocr.NO_FALLBACK)

    def test_request_parameters_match(self):
        py = Path(ocr.__file__).read_text(encoding="utf-8")
        beta = re.search(r"const BETA = '([^']*)'", self.js)[1]
        self.assertIn(f'"betas": ["{beta}"]', py)
        for js_part, py_part in (("max_tokens: 16000", "max_tokens=16000"), ("output_config: {effort: 'medium'}", 'effort="medium"'),
                                 ("fallbacks: 'default'", '"fallbacks": "default"')):
            self.assertIn(js_part, self.js)
            self.assertIn(py_part, py)


if __name__ == "__main__":
    unittest.main()
