"""IA parsing (sources.ia_pages, ia_pdf, ia_search, ia_image_url) against tests/fixtures/ia.

inputs.json holds synthetic IA responses (no real data). expected.json is what sources.py makes of them (and the requested
URLs, as decoded query parameters); tests/sources.test.js checks that static/local/sources.js gives the same results.
Regenerate after an intended change with UPDATE_FIXTURES=1 python -m unittest tests.test_ia_parity."""
import json
import os
import unittest
import urllib.parse
from pathlib import Path
from unittest.mock import patch

from proofreader import net, sources

FIXTURES = Path(__file__).parent / "fixtures" / "ia"


def describe(url):
    """The URL without its query, and the query as decoded pairs (Python and JS escape differently)."""
    u = urllib.parse.urlsplit(url)
    return {"url": urllib.parse.urlunsplit(u._replace(query="")), "query": [list(kv) for kv in urllib.parse.parse_qsl(u.query)]}


def compute():
    data = json.loads((FIXTURES / "inputs.json").read_text(encoding="utf-8"))
    out = {"manifests": [], "metadata": [], "searches": []}
    for case in data["manifests"]:
        calls = []
        with patch.object(net, "get_json", lambda url: calls.append(url) or case["manifest"]):
            result = sources.ia_pages(case["id"])
        out["manifests"].append({"id": case["id"], "requested": calls, "result": result,
                                 "images": [sources.ia_image_url(p["service"]) for p in result["pages"]]
                                 + [sources.ia_image_url(p["service"], 800) for p in result["pages"][:1]]})
    for case in data["metadata"]:
        calls = []
        with patch.object(net, "get_json", lambda url: calls.append(url) or case["metadata"]):
            result = sources.ia_pdf(case["id"])
        out["metadata"].append({"id": case["id"], "requested": calls, "result": result})
    for case in data["searches"]:
        calls = []
        with patch.object(net, "get_json", lambda url: calls.append(url) or case["response"]):
            result = sources.ia_search(case["query"], case["rows"])
        out["searches"].append({"query": case["query"], "requested": [describe(u) for u in calls], "result": result})
    return out


class IaParityTests(unittest.TestCase):
    def test_matches_shared_expected_json(self):
        got = compute()
        path = FIXTURES / "expected.json"
        if os.environ.get("UPDATE_FIXTURES"):
            path.write_text(json.dumps(got, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        self.assertEqual(got, json.loads(path.read_text(encoding="utf-8")))


if __name__ == "__main__":
    unittest.main()
