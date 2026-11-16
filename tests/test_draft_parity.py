"""importers/draft.py against tests/fixtures/draft (tests/draft.test.js checks the same files against static/local/draft.js).

expected.json holds the Python output of every input (or "error"); the random URI is replaced by a placeholder.
Regenerate it after an intended change with UPDATE_FIXTURES=1 python -m unittest tests.test_draft_parity. The inputs are synthetic."""
import json
import os
import re
import unittest
from pathlib import Path

from proofreader.importers import draft

FIXTURES = Path(__file__).parent / "fixtures" / "draft"
inputs = json.loads((FIXTURES / "inputs.json").read_text(encoding="utf-8"))
URI = re.compile(r"^local-[0-9a-f]{12}$")


def compute():
    out = {}
    for c in inputs:
        try:
            fetched, details = draft.build(c["metadata"])
        except (ValueError, TypeError, AttributeError):  # what server.create_pdf_draft turns into one message
            out[c["name"]] = {"error": True}
            continue
        assert URI.match(fetched["uri"]), fetched["uri"]
        out[c["name"]] = {"fetched": {**fetched, "uri": "local-XXXXXXXXXXXX"}, "details": details}
    return out


class DraftParityTests(unittest.TestCase):
    def test_matches_shared_expected_json(self):
        got = compute()
        path = FIXTURES / "expected.json"
        if os.environ.get("UPDATE_FIXTURES"):
            path.write_text(json.dumps(got, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        self.assertEqual(got, json.loads(path.read_text(encoding="utf-8")))

    def test_errors_are_exactly_the_cases_that_expect_them(self):
        got = compute()
        for c in inputs:
            with self.subTest(c["name"]):
                self.assertEqual("error" in got[c["name"]], bool(c.get("expect_error")))

    def test_uris_are_random(self):
        self.assertNotEqual(draft.build({"title": "T", "count": 1})[0]["uri"], draft.build({"title": "T", "count": 1})[0]["uri"])


if __name__ == "__main__":
    unittest.main()
