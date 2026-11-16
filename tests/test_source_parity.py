"""PDF source routes (set_pdf, set_mapping, preview_image, image_for) against tests/fixtures/source.

expected.json holds the shapes server.py returns for the steps in ops.json (random revisions, file names and URLs are
replaced by placeholders); tests/router.test.js replays the same steps against static/local/router.js.
Regenerate after an intended change with UPDATE_FIXTURES=1 python -m unittest tests.test_source_parity."""
import json
import os
import re
import tempfile
import unittest
import urllib.parse
from pathlib import Path
from unittest.mock import patch

from proofreader import server, store
from tests.test_regressions import Request

FIXTURES = Path(__file__).parent / "fixtures" / "source"
ops = json.loads((FIXTURES / "ops.json").read_text(encoding="utf-8"))
HEX = re.compile(r"^[0-9a-f]{32}$")


def norm(value, volatile):
    """Placeholders for what differs between runs (and between the Python and browser versions)."""
    if isinstance(value, dict):
        out = {}
        for k, v in value.items():
            if k == "pdf" and v:
                v = "<pdf>"
            elif k == "file" and isinstance(v, str) and re.fullmatch(r"source-[0-9a-f]{32}\.pdf", v):
                v = "<file>"
            elif k == "revision" and isinstance(v, str) and HEX.match(v):
                v = "<revision>"
            elif k == "key" and volatile:
                v = "<key>"
            else:
                v = norm(v, volatile)
            out[k] = v
        return out
    return [norm(v, volatile) for v in value] if isinstance(value, list) else value


def view(slug):
    v = server.project_view(slug)
    return {k: v[k] for k in ("slug", "offset", "anchors", "source", "draft")}


def compute():
    out = []
    with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as tmp, patch.object(store, "ROOT", Path(tmp)):
        store._cache.clear()
        p = store.create({"uri": "fixture", "text": ops["text"], "meta": {}})
        slug = p["slug"]
        store.file_path(slug, ops["source"]["file"]).write_bytes(b"%PDF-fixture")
        p["source"] = ops["source"]
        store.save_project(slug, p)
        revisions = []
        try:
            for step in ops["steps"]:
                volatile = step.get("volatile", False)
                try:
                    if step["op"] == "view":
                        got = view(slug)
                    elif step["op"] == "stage":
                        r = server.set_pdf(Request(data=b"%PDF-x", headers={"X-Page-Count": str(step["count"]), "X-Filename": urllib.parse.quote(step["title"])}), slug)
                        revisions.append(r["draft"]["revision"])
                        got = {"draft": r["draft"], "offset": r["offset"], "anchors": r["anchors"], "source": r["source"]}
                    elif step["op"] == "mapping":
                        body = dict(step["body"])
                        if "source" in body:
                            body["source"] = {"$draft": -1, "$previous": -2}.get(body["source"], body["source"])
                            if isinstance(body["source"], int):
                                body["source"] = revisions[body["source"]] if len(revisions) >= -body["source"] else ""
                        r = server.set_mapping(Request(body), slug)
                        got = {k: r[k] for k in ("slug", "offset", "anchors", "source", "draft")}
                    elif step["op"] == "image":
                        query = {"index": [str(step["index"])]}
                        if step.get("draft"):
                            query["draft"] = [revisions[-1]]
                        got = server.preview_image(Request(query=query), slug)
                    else:
                        got = server.image_for(store.load(slug), step["i"])
                    assert not step.get("expect_error"), step
                except server.ApiError as e:
                    assert step.get("expect_error"), (step, str(e))
                    got = {"error": int(e.status), "message": str(e)}
                out.append(norm(got, volatile))
        finally:
            server.DRAFTS.clear()
            store._cache.clear()
    return out


class SourceParityTests(unittest.TestCase):
    def test_matches_shared_expected_json(self):
        got = compute()
        path = FIXTURES / "expected.json"
        if os.environ.get("UPDATE_FIXTURES"):
            path.write_text(json.dumps(got, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        self.assertEqual(got, json.loads(path.read_text(encoding="utf-8")))


if __name__ == "__main__":
    unittest.main()
