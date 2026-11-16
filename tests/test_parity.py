"""openiti.py against the shared fixtures in tests/fixtures/openiti (tests/openiti.test.js checks the same files).

Regenerate expected.json after an intended change with UPDATE_FIXTURES=1 python -m unittest tests.test_parity."""
import json
import os
import random
import unittest
from pathlib import Path

from proofreader import openiti

FIXTURES = Path(__file__).parent / "fixtures" / "openiti"
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


if __name__ == "__main__":
    unittest.main()
