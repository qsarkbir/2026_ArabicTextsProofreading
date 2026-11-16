"""exporters/tei.py against tests/fixtures/tei (tests/tei.test.js checks the same files against static/local/tei.js).

expected.json holds the Python output of every input (or the error message). Regenerate it after an intended change with
UPDATE_FIXTURES=1 python -m unittest tests.test_tei_parity. The inputs are synthetic; never put real OpenITI text there."""
import json
import os
import unittest
from pathlib import Path
from xml.etree import ElementTree as ET

from proofreader import openiti
from proofreader.exporters import tei

FIXTURES = Path(__file__).parent / "fixtures" / "tei"
inputs = json.loads((FIXTURES / "inputs.json").read_text(encoding="utf-8"))


def compute():
    out = {}
    for c in inputs:
        work = {"edits": c["work"]["edits"], "status": c["work"]["status"]}
        try:
            data, warnings = tei.export(c["project"], openiti.split(c["text"]), work)
            out[c["name"]] = {"xml": data.decode("utf-8"), "warnings": warnings}
        except ValueError as e:
            out[c["name"]] = {"error": str(e)}
    return out


class TeiParityTests(unittest.TestCase):
    def test_matches_shared_expected_json(self):
        got = compute()
        path = FIXTURES / "expected.json"
        if os.environ.get("UPDATE_FIXTURES"):
            path.write_text(json.dumps(got, ensure_ascii=True, indent=1) + "\n", encoding="utf-8")
        self.assertEqual(got, json.loads(path.read_text(encoding="utf-8")))

    def test_expected_outputs_are_well_formed(self):
        for name, r in json.loads((FIXTURES / "expected.json").read_text(encoding="utf-8")).items():
            if "xml" in r:
                with self.subTest(name):
                    ET.fromstring(r["xml"].encode("utf-8"))


if __name__ == "__main__":
    unittest.main()
