"""Per-text project folders: the original text, the setup, the proofreading work and cached OCR.

projects/<slug>/
  project.json   setup: OpenITI URI, scan source, page mapping
  original.txt   the text as downloaded (never modified)
  work.json      edits and per-page status / notes
  ocr/<i>.json   Claude readings, one per page
  files/         uploaded PDFs
"""
import json
import os
import re
import threading
import time
from pathlib import Path

from . import openiti

ROOT = Path(os.environ.get("PROOF_DATA", Path(__file__).resolve().parent.parent / "projects"))
_lock = threading.Lock()
_cache = {}


def _write_json(path, data):
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, path)


def _dir(slug):
    if not re.fullmatch(r"[A-Za-z0-9._-]+", slug or ""):
        raise KeyError(slug)
    d = ROOT / slug
    if not (d / "project.json").exists():
        raise KeyError(slug)
    return d


def create(fetched):
    ROOT.mkdir(parents=True, exist_ok=True)
    base = re.sub(r"[^A-Za-z0-9._-]+", "_", fetched["uri"])[:120] or "text"
    slug, n = base, 2
    while (ROOT / slug).exists():
        slug, n = f"{base}_{n}", n + 1
    d = ROOT / slug
    (d / "ocr").mkdir(parents=True)
    (d / "files").mkdir()
    (d / "original.txt").write_text(fetched["text"], encoding="utf-8", newline="")
    meta = fetched["meta"]
    project = {
        "slug": slug, "uri": fetched["uri"], "raw_url": fetched.get("raw_url", ""),
        "title": openiti.title_of(meta, fetched["text"], fetched["uri"]),
        "author": openiti.author_of(meta, fetched["text"], fetched["uri"]),
        "created": time.strftime("%Y-%m-%d %H:%M"), "meta": meta,
        "candidates": openiti.scan_links(meta), "source": None, "offset": 0, "anchors": [],
    }
    _write_json(d / "project.json", project)
    _write_json(d / "work.json", {"edits": {}, "status": {}})
    return project


def load(slug):
    d = _dir(slug)
    return json.loads((d / "project.json").read_text(encoding="utf-8"))


def save_project(slug, project):
    with _lock:
        _write_json(_dir(slug) / "project.json", project)


def parts(slug):
    """Split original text, cached per slug since it never changes."""
    if slug not in _cache:
        _cache[slug] = openiti.split((_dir(slug) / "original.txt").read_text(encoding="utf-8"))
    return _cache[slug]


def work(slug):
    return json.loads((_dir(slug) / "work.json").read_text(encoding="utf-8"))


def update_page(slug, i, text=None, done=None, note=None):
    with _lock:
        d = _dir(slug)
        w = json.loads((d / "work.json").read_text(encoding="utf-8"))
        key = str(i)
        if text is not None:
            if text == parts(slug)["pages"][i]["text"]:
                w["edits"].pop(key, None)
            else:
                w["edits"][key] = text
        st = w["status"].setdefault(key, {})
        if done is not None:
            st["done"] = bool(done)
        if note is not None:
            st["note"] = note
        if not st.get("done") and not st.get("note"):
            w["status"].pop(key, None)
        _write_json(d / "work.json", w)
        return w


def ocr_get(slug, i):
    p = _dir(slug) / "ocr" / f"{i}.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


def ocr_put(slug, i, result):
    with _lock:
        _write_json(_dir(slug) / "ocr" / f"{i}.json", result)


def file_path(slug, name):
    if not re.fullmatch(r"[A-Za-z0-9._-]+", name):
        raise KeyError(name)
    return _dir(slug) / "files" / name


def list_projects():
    out = []
    if not ROOT.exists():
        return out
    for d in sorted(ROOT.iterdir()):
        try:
            p = load(d.name)
            w = work(d.name)
        except (KeyError, OSError, ValueError):
            continue
        out.append({"slug": p["slug"], "uri": p["uri"], "title": p["title"], "author": p["author"],
                    "created": p["created"], "source": bool(p["source"]), "pages": len(parts(d.name)["pages"]),
                    "done": sum(1 for s in w["status"].values() if s.get("done")), "edited": len(w["edits"])})
    return out


def image_index(project, i):
    """Scan image for text page i: the nearest anchor at or before i, else the global offset."""
    best = None
    for a_page, a_img in project.get("anchors", []):
        if a_page <= i and (best is None or a_page > best[0]):
            best = (a_page, a_img)
    return best[1] + (i - best[0]) if best else project.get("offset", 0) + i
