"""Local web server for proofreading OpenITI texts against page images.

usage: python -m proofreader [--port 8765] [--no-browser] [--keep-running]
"""
import argparse
import base64
import csv
import difflib
import io
import hashlib
import json
import mimetypes
import os
import re
import subprocess
import sys
import threading
import time
import urllib.parse
import webbrowser
import uuid
import zipfile
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from . import bundle, net, ocr, openiti, sources, store, providers
from .presence import Presence
from .exporters import tei
from .importers import draft

STATIC = Path(__file__).resolve().parent / "static"
# Windows registry entries can map these to text/plain, which browsers refuse for ES modules
for _ext in (".js", ".mjs"):
    mimetypes.add_type("text/javascript", _ext)
mimetypes.add_type("text/css", ".css")
ENV_FILE = Path(__file__).resolve().parent.parent / ".env"
ROUTES = []
PRESENCE = Presence()
CLIENT_ID = re.compile(r"^[A-Za-z0-9-]{1,64}$")
PDF_LIMIT = 500 * 1024 * 1024
PDF_JOBS, PDF_INFO, PDF_MISMATCH, PDF_LOCK = {}, {}, {}, threading.Lock()  # slug -> download job / (revision, ia_pdf info) / (revision, message)
DRAFTS = {}  # slug -> scan source chosen in setup, applied only when the mapping is confirmed


def route(method, pattern):
    def deco(fn):
        ROUTES.append((method, re.compile(f"^{pattern}$"), fn))
        return fn
    return deco


class ApiError(Exception):
    def __init__(self, message, status=HTTPStatus.BAD_REQUEST):
        super().__init__(message)
        self.status = status


def source_view(src):
    return src and {k: v for k, v in src.items() if k != "pages"} | {"count": len(src["pages"]) if src["type"] == "ia" else src.get("count", 0)}


def project_view(slug):
    p = store.load(slug)
    pages = store.parts(slug)["pages"]
    w = store.work(slug)
    return {
        **{k: p[k] for k in ("slug", "uri", "raw_url", "title", "author", "created", "candidates", "offset", "anchors")},
        "source": source_view(p["source"]),
        "pages": [{"vol": pg["vol"], "page": pg["page"], "unassigned": pg.get("unassigned", False)} for pg in pages],
        "edited": sorted(int(k) for k in w["edits"]),
        "done": sorted(int(k) for k, s in w["status"].items() if s.get("done")),
        "noted": sorted(int(k) for k, s in w["status"].items() if s.get("note")),
        "ocr": ocr.available(),
        "ocr_reason": ocr.reason(),
        "ocr_models": ocr.MODELS,
        "ocr_providers": providers.catalog(),
        "bibliography": p.get("bibliography", {}), "draft": p.get("draft", False),
    }


def page_index(slug, i):
    i = int(i)
    if not 0 <= i < len(store.parts(slug)["pages"]):
        raise ApiError("ページ番号が範囲外です", HTTPStatus.NOT_FOUND)
    return i


def draft_for(slug, revision):
    src = DRAFTS.get(slug)
    if not src or src["revision"] != revision:
        raise ApiError("選んだ資料の情報がありません。資料を選び直してください", HTTPStatus.CONFLICT)
    return src


def stage(slug, src):
    """Keep a newly chosen source aside so that choosing (or cancelling) changes nothing yet."""
    src["revision"] = uuid.uuid4().hex
    DRAFTS[slug] = src
    return project_view(slug) | {"draft": source_view(src)}


def image_for(p, i, index=None, draft=""):
    pages = store.parts(p["slug"])["pages"]
    if index is None and 0 <= i < len(pages) and pages[i].get("unassigned"):
        return None
    src = p["source"]
    if not src:
        return None
    idx = store.image_index(p, i) if index is None else index
    identity = f"{src['type']}:{src.get('revision', src.get('id', src.get('file', '')))}:{idx}"
    key = hashlib.sha256(identity.encode()).hexdigest()
    if src["type"] == "ia":
        if not 0 <= idx < len(src["pages"]):
            return {"index": idx, "missing": True, "count": len(src["pages"])}
        c = src["pages"][idx]
        v = urllib.parse.quote(str(src.get("revision") or src["id"]))
        out = {"index": idx, "key": key, "count": len(src["pages"]), "label": c["label"], "service": c["service"],
               "w": c.get("w"), "h": c.get("h"), "link": f"https://archive.org/details/{src['id']}/page/n{idx}/mode/1up"}
        if src.get("pdf_file") and not draft:
            try:  # a project restored from a backup has no PDF until it is attached again; use the online image meanwhile
                v += f"-{store.file_path(p['slug'], src['pdf_file']).stat().st_size}"
                return out | {"pdf": f"/api/projects/{p['slug']}/files/{src['pdf_file']}?v={v}"}
            except (OSError, KeyError):
                pass
        return out | {"url": f"/api/projects/{p['slug']}/scan/{idx}?w=1600&v={v}" + (f"&draft={draft}" if draft else "")}
    return {"index": idx, "key": key, "missing": not 0 <= idx < src.get("count", 0),
            "count": src.get("count", 0), "pdf": f"/api/projects/{p['slug']}/files/{src['file']}?v={src.get('revision', 'legacy')}"}


# ---------- presence ----------

def client_id(h):
    c = h.json()
    c = c.get("client") if isinstance(c, dict) else c
    if not isinstance(c, str) or not CLIENT_ID.match(c):
        raise ApiError("client が正しくありません")
    return c


@route("POST", r"/api/heartbeat")
def heartbeat(h):
    PRESENCE.beat(client_id(h), time.monotonic())
    return {}


@route("POST", r"/api/bye")
def bye(h):
    PRESENCE.bye(client_id(h), time.monotonic())
    return {}


@route("POST", r"/api/shutdown")
def shutdown(h):
    srv = h.server
    h.after_response = lambda: threading.Thread(target=srv.shutdown, daemon=True).start()
    return {}


# ---------- projects ----------

@route("GET", r"/api/projects")
def list_projects(h):
    return store.list_projects()


@route("POST", r"/api/projects")
def create_project(h):
    body = h.json()
    ref = (body.get("ref") or "").strip()
    if not ref:
        raise ApiError("OpenITIのURIかURLを入力してください")
    try:
        fetched = openiti.fetch(ref)
    except ValueError as e:
        raise ApiError(str(e))
    except net.FetchError as e:
        raise ApiError(f"テキストを取得できませんでした: {e}")
    if not openiti.split(fetched["text"])["pages"]:
        raise ApiError("ページ区切り（PageV..P..）がないテキストは校正できません")
    p = store.create(fetched)
    return project_view(p["slug"])


@route("POST", r"/api/projects/import-bundle")
def import_bundle(h):
    try:
        project, text, work = bundle.parse(h.json())
    except bundle.BundleError as e:
        raise ApiError(str(e))
    return project_view(store.create_from_bundle(project, text, work)["slug"])


@route("POST", r"/api/projects/upload-text")
def create_from_file(h):
    name = urllib.parse.unquote(h.headers.get("X-Filename", "text.txt"))
    text = h.body().decode("utf-8")
    if not openiti.split(text)["pages"]:
        raise ApiError("ページ区切り（PageV..P..）がないテキストは校正できません")
    uri = re.sub(r"\.(txt|mARkdown|completed|inProgress)$", "", name)
    p = store.create({"uri": uri, "raw_url": "", "text": text, "meta": {}})
    return project_view(p["slug"])


@route("GET", r"/api/projects/(?P<slug>[^/]+)")
def get_project(h, slug):
    return project_view(slug)


# ---------- scan source ----------

@route("POST", r"/api/projects/new-pdf")
def create_pdf_draft(h):
    data = h.body()
    if not data.startswith(b"%PDF") or len(data) > PDF_LIMIT:
        raise ApiError("500 MB以下のPDFを選択してください")
    try:
        metadata = json.loads(urllib.parse.unquote(h.headers.get("X-Metadata", "{}")))
        fetched, details = draft.build(metadata)
    except (ValueError, TypeError, AttributeError):
        raise ApiError("書名、PDFの対象範囲、巻と印刷ページ番号を確認してください")
    p = store.create(fetched)
    store.file_path(p["slug"], "source.pdf").write_bytes(data)
    p.update(details)
    p["source"] = {"type": "pdf", "file": "source.pdf", "revision": uuid.uuid4().hex,
                   "title": metadata.get("filename", "source.pdf"), "count": int(metadata["count"])}
    store.save_project(p["slug"], p)
    return project_view(p["slug"])


@route("PUT", r"/api/projects/(?P<slug>[^/]+)/bibliography")
def save_bibliography(h, slug):
    b = h.json()
    if any(not isinstance(b.get(k, ""), str) for k in ("title", "author", "edition", "source", "rights")):
        raise ApiError("書誌情報は文字列で指定してください")
    p = store.load(slug)
    p.update({k: b.get(k, "").strip() for k in ("title", "author")})
    p["bibliography"] = {k: b.get(k, "").strip() for k in ("edition", "source", "rights")}
    store.save_project(slug, p)
    return project_view(slug)

@route("GET", r"/api/ia/search")
def ia_search(h):
    q = h.query.get("q", [""])[0].strip()
    if not q:
        raise ApiError("検索語を入力してください")
    try:
        return sources.ia_search(q)
    except net.FetchError as e:
        raise ApiError(f"Internet Archive を検索できませんでした: {e}")


@route("GET", r"/api/projects/(?P<slug>[^/]+)/search-terms")
def search_terms(h, slug):
    p = store.load(slug)
    return {"q": sources.search_terms(p["title"], p["author"])}


@route("POST", r"/api/projects/(?P<slug>[^/]+)/source/ia")
def set_ia(h, slug):
    ident = (h.json().get("id") or "").strip()
    m = re.search(r"archive\.org/(?:details|download)/([A-Za-z0-9._-]+)", ident)
    ident = m[1] if m else ident
    if not re.fullmatch(r"[A-Za-z0-9._-]+", ident):
        raise ApiError("Internet Archive の識別子かURLを入力してください")
    try:
        src = sources.ia_pages(ident)
    except net.FetchError as e:
        raise ApiError(f"この資料のページ画像を取得できませんでした: {e}")
    if not src["pages"]:
        raise ApiError("この資料にはページ画像がありません")
    store.load(slug)
    return stage(slug, src)


def ia_source(slug):
    p = store.load(slug)
    src = p["source"]
    if not src or src["type"] != "ia":
        raise ApiError("Internet Archive の資料ではありません")
    return p, src, f"ia-{re.sub(r'[^A-Za-z0-9._-]', '_', str(src.get('revision') or src['id']))}.pdf"


def pdf_download(slug, revision, info, url, path):
    def progress(done, total):
        job = PDF_JOBS.get(slug)
        if job and job["revision"] == revision:
            job["bytes"], job["total"] = done, total or info["size"]
    try:
        net.download(url, path, PDF_LIMIT, progress)
        end = {"state": "done", "file": path.name}
    except net.FetchError as e:
        end = {"state": "error", "error": f"PDFをダウンロードできませんでした: {e}"}
    except Exception as e:
        end = {"state": "error", "error": f"PDFを保存できませんでした: {e}"}
    with PDF_LOCK:
        job = PDF_JOBS.get(slug)
        if job and job["revision"] == revision:
            job.update(end)
    PRESENCE.request_finished()


@route("GET", r"/api/projects/(?P<slug>[^/]+)/source/ia/pdf")
def ia_pdf_status(h, slug):
    p, src, name = ia_source(slug)
    rev = str(src.get("revision") or src["id"])
    with PDF_LOCK:
        cached = PDF_INFO.get(slug)
    if not cached or cached[0] != rev:
        try:
            cached = (rev, sources.ia_pdf(src["id"]))
        except net.FetchError as e:
            raise ApiError(f"PDFの情報を取得できませんでした: {e}", HTTPStatus.BAD_GATEWAY)
        with PDF_LOCK:
            PDF_INFO[slug] = cached
    with PDF_LOCK:
        job = PDF_JOBS.get(slug)
        job = dict(job) if job and job["revision"] == rev else None
        bad = PDF_MISMATCH.get(slug)
    path = store.file_path(slug, name)
    exists = path.is_file()
    if job and job["state"] == "done" and not exists:
        job = None
    pending = name if not src.get("pdf_file") and exists else None
    v = f"{rev}-{path.stat().st_size}" if exists else rev
    return {"available": cached[1], "attached": src.get("pdf_file") if exists else None, "job": job, "pending": pending, "revision": rev,
            "v": v, "mismatch": bad[1] if bad and bad[0] == rev else ""}


@route("POST", r"/api/projects/(?P<slug>[^/]+)/source/ia/pdf")
def ia_pdf_start(h, slug):
    p, src, name = ia_source(slug)
    rev = str(src.get("revision") or src["id"])
    with PDF_LOCK:
        job = PDF_JOBS.get(slug)
        if job and job["revision"] == rev and job["state"] == "running":
            return dict(job)
        bad = PDF_MISMATCH.get(slug)
    if bad and bad[0] == rev:
        raise ApiError(bad[1])
    try:
        info = sources.ia_pdf(src["id"])
    except net.FetchError as e:
        raise ApiError(f"PDFの情報を取得できませんでした: {e}", HTTPStatus.BAD_GATEWAY)
    if not info:
        raise ApiError("この資料にはPDFがありません")
    if info["size"] > PDF_LIMIT:
        raise ApiError(f"PDFが大きすぎます（{info['size'] // 1048576} MB、上限 {PDF_LIMIT // 1048576} MB）")
    path = store.file_path(slug, name)
    path.parent.mkdir(parents=True, exist_ok=True)
    url = f"https://archive.org/download/{urllib.parse.quote(src['id'])}/{urllib.parse.quote(info['name'])}"
    with PDF_LOCK:
        job = PDF_JOBS.get(slug)
        if job and job["revision"] == rev and job["state"] == "running":
            return dict(job)
        for stale in path.parent.glob(f"{name}.*.tmp"):
            stale.unlink(missing_ok=True)
        PDF_JOBS[slug] = job = {"revision": rev, "state": "running", "bytes": 0, "total": info["size"], "error": "", "file": ""}
        snapshot = dict(job)
    PRESENCE.request_started()
    try:
        threading.Thread(target=pdf_download, args=(slug, rev, info, url, path), daemon=False).start()
    except Exception:
        PRESENCE.request_finished()
        with PDF_LOCK:
            PDF_JOBS.pop(slug, None)
        raise
    return snapshot


@route("POST", r"/api/projects/(?P<slug>[^/]+)/source/ia/pdf/attach")
def ia_pdf_attach(h, slug):
    b = h.json()
    p, src, name = ia_source(slug)
    if str(b.get("revision")) != str(src.get("revision") or src["id"]):
        raise ApiError("資料が変更されています。画面を開き直してください", HTTPStatus.CONFLICT)
    path = store.file_path(slug, name)
    if not path.is_file():
        raise ApiError("保存したPDFがありません", HTTPStatus.NOT_FOUND)
    if src.get("pdf_file") == name:
        return project_view(slug)
    try:
        pages = int(b.get("pages") or 0)
    except (TypeError, ValueError):
        raise ApiError("ページ数が正しくありません")
    if pages != len(src["pages"]):
        path.unlink(missing_ok=True)
        msg = f"PDFのページ数（{pages}）が資料の画像数（{len(src['pages'])}）と一致しないため使えません"
        with PDF_LOCK:
            PDF_JOBS[slug] = {"revision": str(b["revision"]), "state": "error", "bytes": 0, "total": 0, "error": msg, "file": ""}
            PDF_MISMATCH[slug] = (str(b["revision"]), msg)
        raise ApiError(msg)
    src["pdf_file"] = name
    store.save_project(slug, p)
    return project_view(slug)


@route("POST", r"/api/projects/(?P<slug>[^/]+)/source/ia/pdf/detach")
def ia_pdf_detach(h, slug):
    p, src, name = ia_source(slug)
    src.pop("pdf_file", None)
    store.save_project(slug, p)
    return project_view(slug)


@route("POST", r"/api/projects/(?P<slug>[^/]+)/source/pdf")
def set_pdf(h, slug):
    data = h.body()
    if not data.startswith(b"%PDF"):
        raise ApiError("PDFファイルではありません")
    count = int(h.headers.get("X-Page-Count") or 0)
    if count < 1:
        raise ApiError("PDFのページ数を確認できませんでした")
    name = f"source-{uuid.uuid4().hex}.pdf"
    store.file_path(slug, name).write_bytes(data)
    return stage(slug, {"type": "pdf", "file": name,
                        "title": urllib.parse.unquote(h.headers.get("X-Filename", name)), "count": count})


@route("GET", r"/api/projects/(?P<slug>[^/]+)/files/(?P<name>[^/]+)")
def get_file(h, slug, name):
    path = store.file_path(slug, name)
    if not path.exists():
        raise ApiError("ファイルがありません", HTTPStatus.NOT_FOUND)
    return h.send_file(path)


@route("POST", r"/api/projects/(?P<slug>[^/]+)/mapping")
def set_mapping(h, slug):
    body = h.json()
    p = store.load(slug)
    if "source" in body:
        p["source"] = draft_for(slug, body["source"])
        p["offset"], p["anchors"] = 0, []
    if "offset" in body:
        p["offset"] = int(body["offset"])
    if body.get("clear_anchors"):
        p["anchors"] = []
    if "anchor" in body:
        a_page, a_img = int(body["anchor"][0]), int(body["anchor"][1])
        p["anchors"] = [a for a in p["anchors"] if a[0] != a_page] + [[a_page, a_img]]
        p["anchors"].sort()
    store.save_project(slug, p)
    if "source" in body:
        DRAFTS.pop(slug, None)
    return project_view(slug)


# ---------- pages ----------

@route("GET", r"/api/projects/(?P<slug>[^/]+)/image")
def preview_image(h, slug):
    p = store.load(slug)
    draft = h.query.get("draft", [""])[0]
    if draft:
        p["source"] = draft_for(slug, draft)
    return image_for(p, 0, int(h.query.get("index", ["0"])[0]), draft)


_scan_locks, _scan_locks_guard = {}, threading.Lock()


def _sniff(data):
    return "image/png" if data[1:4] == b"PNG" else "image/jpeg"


def scan_bytes(slug, src, img, width):
    """Page image from the disk cache, fetched (and cached) on first use."""
    path = store.scan_path(slug, f"{img['key']}-{width}.jpg")
    with _scan_locks_guard:
        lock = _scan_locks.setdefault(path, threading.Lock())
    with lock:
        try:
            data = path.read_bytes()
            return data, _sniff(data)
        except OSError:
            pass
        try:
            data, mtype = sources.fetch_scan(src, img["index"], width)
        except net.FetchError as e:
            raise ApiError(f"ページ画像を取得できませんでした: {e}", HTTPStatus.BAD_GATEWAY)
        if not (mtype or "").startswith("image/"):
            raise ApiError("ページ画像として読めない応答でした", HTTPStatus.BAD_GATEWAY)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f"{path.name}.{uuid.uuid4().hex}.tmp")
        try:
            tmp.write_bytes(data)
            os.replace(tmp, path)
        except OSError:
            pass
        finally:
            tmp.unlink(missing_ok=True)
        return data, mtype


@route("GET", r"/api/projects/(?P<slug>[^/]+)/scan/(?P<idx>\d+)")
def scan(h, slug, idx):
    p = store.load(slug)
    draft = h.query.get("draft", [""])[0]
    if draft:
        p["source"] = draft_for(slug, draft)
    img = image_for(p, 0, int(idx))
    if not img or img.get("missing") or "url" not in img:
        raise ApiError("このページに対応する画像がありません", HTTPStatus.NOT_FOUND)
    try:
        width = 2000 if int(h.query.get("w", ["1600"])[0]) > 1600 else 1600
    except ValueError:
        raise ApiError("幅の指定が正しくありません")
    data, mtype = scan_bytes(slug, p["source"], img, width)
    h._send(200, data, mtype, cache="private, max-age=86400")


@route("GET", r"/api/projects/(?P<slug>[^/]+)/search")
def search_pages(h, slug):
    query = h.query.get("q", [""])[0].casefold().strip()
    kind = h.query.get("filter", ["all"])[0]
    w = store.work(slug)
    found = []
    for i, pg in enumerate(store.parts(slug)["pages"]):
        key = str(i)
        st = w["status"].get(key, {})
        if kind == "todo" and st.get("done") or kind == "edited" and key not in w["edits"] or kind == "noted" and not st.get("note"):
            continue
        text = w["edits"].get(key, pg["text"])
        if query and query not in text.casefold() and query not in st.get("note", "").casefold():
            continue
        found.append({"i": i, "marker": pg["marker"] or "未割当の末尾", "note": st.get("note", "")})
    return found

@route("GET", r"/api/projects/(?P<slug>[^/]+)/pages/(?P<i>\d+)")
def get_page(h, slug, i):
    i = page_index(slug, i)
    p = store.load(slug)
    pg = store.parts(slug)["pages"][i]
    w = store.work(slug)
    st = w["status"].get(str(i), {})
    img = image_for(p, i)
    cached = store.ocr_get(slug, i)
    if cached and (not img or img.get("missing")):
        cached = None
    elif cached and not cached.get("image_key"):
        legacy = p["source"]["type"] == "ia" and cached.get("image_index") == img.get("index")
        cached = {**cached, "legacy": True} if legacy else None
    elif cached and cached["image_key"] != img.get("key"):
        cached = None
    return {"i": i, "vol": pg["vol"], "page": pg["page"], "marker": pg["marker"] or "未割当の末尾",
            "revision": w.get("revisions", {}).get(str(i), 0), "unassigned": pg.get("unassigned", False),
            "original": pg["text"], "text": w["edits"].get(str(i), pg["text"]),
            "done": bool(st.get("done")), "note": st.get("note", ""),
            "ocr": cached, "image": img}


@route("PUT", r"/api/projects/(?P<slug>[^/]+)/pages/(?P<i>\d+)")
def put_page(h, slug, i):
    i = page_index(slug, i)
    b = h.json()
    if type(b.get("revision")) is not int:
        raise ApiError("画面を再読み込みしてください（保存元の版がありません）", HTTPStatus.PRECONDITION_REQUIRED)
    if any(k in b and not isinstance(b[k], str) for k in ("text", "note")):
        raise ApiError("本文と注記は文字列で指定してください")
    try:
        w = store.update_page(slug, i, text=b.get("text"), done=b.get("done"), note=b.get("note"), revision=b["revision"],
                              checkpoint=b.get("checkpoint") is True)
    except store.Conflict as e:
        raise ApiError(str(e), HTTPStatus.CONFLICT)
    return project_view(slug) | {"page": i, "revision": w.get("revisions", {}).get(str(i), 0)}


@route("GET", r"/api/projects/(?P<slug>[^/]+)/pages/(?P<i>\d+)/history")
def page_history(h, slug, i):
    i = page_index(slug, i)
    return store.work(slug).get("history", {}).get(str(i), [])


@route("GET", r"/api/projects/(?P<slug>[^/]+)/pages/(?P<i>\d+)/readings")
def reading_history(h, slug, i):
    i = page_index(slug, i)
    image = image_for(store.load(slug), i)
    return store.ocr_history(slug, i, image.get("key")) if image and not image.get("missing") else []


@route("POST", r"/api/projects/(?P<slug>[^/]+)/pages/(?P<i>\d+)/ocr")
def run_ocr(h, slug, i):
    i = page_index(slug, i)
    b = h.json()
    cached = store.ocr_get(slug, i)
    p = store.load(slug)
    img = image_for(p, i)
    if not img or img.get("missing"):
        raise ApiError("このページに対応する画像がありません")
    if b.get("image_key") and b["image_key"] != (img or {}).get("key"):
        raise ApiError("画像の対応が変更されています。ページを開き直してください", HTTPStatus.CONFLICT)
    if (cached and cached.get("image_key") and not b.get("force") and cached["image_key"] == img.get("key")
            and (not b.get("provider") or cached.get("provider", "anthropic") == b["provider"])
            and (not b.get("model") or cached.get("requested_model", cached.get("model")) == b["model"])):
        return cached
    if "pdf" not in img:
        data, mtype = scan_bytes(slug, p["source"], img, 2000)
    else:
        m = re.match(r"data:(image/(?:jpeg|png));base64,(.+)", b.get("image") or "", re.S)
        if not m:
            raise ApiError("PDFのページ画像が送られていません")
        mtype, data = m[1], base64.b64decode(m[2])
    try:
        res = providers.transcribe(data, mtype, provider=b.get("provider") or "anthropic", model=b.get("model"))
    except ocr.OCRUnavailable as e:
        raise ApiError(str(e), HTTPStatus.SERVICE_UNAVAILABLE)
    res["image_index"] = img["index"]
    res["image_key"] = img["key"]
    if (image_for(store.load(slug), i) or {}).get("key") != img["key"]:
        raise ApiError("読み取り中に画像の対応が変更されました。もう一度読み取ってください", HTTPStatus.CONFLICT)
    return store.ocr_put(slug, i, res)


# ---------- export ----------

@route("GET", r"/api/projects/(?P<slug>[^/]+)/export")
def export(h, slug):
    fmt = h.query.get("fmt", ["text"])[0]
    p = store.load(slug)
    parts = store.parts(slug)
    w = store.work(slug)
    if fmt == "bundle":
        data = json.dumps(bundle.build(slug), ensure_ascii=False, indent=1).encode("utf-8")
        return h.send_download(data, f"{slug}.proofreader.json", "application/json; charset=utf-8")
    if fmt == "tei":
        try:
            data, warnings = tei.export(p, parts, w)
        except ValueError as e:
            raise ApiError(str(e))
        return h.send_download(data, f"{p['uri']}.tei.xml", "application/xml; charset=utf-8")
    if fmt == "package":
        buf = io.BytesIO()
        bib = p.get("bibliography", {})
        fields = {"00#VERS#URI######": p["uri"], "80#VERS#BASED####": bib.get("edition", ""),
                  "80#VERS#LINKS####": bib.get("source", ""), "90#VERS#COMMENT##": "ローカル作業用。OpenITI提出用URIと書誌を確認してください。"}
        yml = "\n".join(f"{k}: {json.dumps(v, ensure_ascii=False)}" for k, v in fields.items()) + "\n"
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr(f"{slug}.mARkdown", openiti.join(parts, w["edits"]))
            z.writestr(f"{slug}.yml", yml)
            z.writestr("bibliography.json", json.dumps({"title": p["title"], "author": p["author"], **bib}, ensure_ascii=False, indent=2))
            z.writestr("README.txt", "ローカル作業用パッケージです。OpenITIへ登録済みではありません。\n提出前にURI・著者/作品の既存レコード・版のYAML・権利条件・未確認ページを確認してください。\n")
        return h.send_download(buf.getvalue(), f"{slug}.draft.zip", "application/zip")
    if fmt == "text":
        return h.send_download(openiti.join(parts, w["edits"]).encode("utf-8"), f"{p['uri']}.corrected", "text/plain; charset=utf-8")
    if fmt == "diff":
        a = openiti.join(parts).splitlines(keepends=True)
        b = openiti.join(parts, w["edits"]).splitlines(keepends=True)
        diff = "".join(difflib.unified_diff(a, b, f"a/{p['uri']}", f"b/{p['uri']}"))
        return h.send_download(diff.encode("utf-8"), f"{p['uri']}.diff", "text/x-diff; charset=utf-8")
    if fmt == "notes":
        buf = io.StringIO()
        wr = csv.writer(buf)
        wr.writerow(["index", "marker", "edited", "done", "note"])
        for k in sorted({*w["edits"], *w["status"]}, key=int):
            st = w["status"].get(k, {})
            wr.writerow([k, parts["pages"][int(k)]["marker"], int(k in w["edits"]), int(bool(st.get("done"))), st.get("note", "")])
        return h.send_download(("﻿" + buf.getvalue()).encode("utf-8"), f"{p['uri']}.notes.csv", "text/csv; charset=utf-8")
    raise ApiError("不明な形式です")


# ---------- HTTP plumbing ----------

class Handler(BaseHTTPRequestHandler):
    server_version = "Proofreader/0.1"
    after_response = None

    def log_message(self, fmt, *args):
        if "/api/" in self.path and not self.path.endswith(("/files/source.pdf",)):
            sys.stderr.write("%s %s\n" % (self.command, self.path))

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n < 0 or n > PDF_LIMIT:
            raise ApiError("送信データが大きすぎます（上限500 MB）", HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
        return self.rfile.read(n) if n else b""

    def json(self):
        raw = self.body()
        def reject(name):
            raise ValueError(name)
        try:
            return json.loads(raw, parse_constant=reject) if raw else {}
        except (ValueError, RecursionError):
            raise ApiError("JSONとして読めません")

    def _send(self, status, data, ctype, extra=None, cache="no-store"):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", cache)
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def send_file(self, path):
        ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript",):
            ctype += "; charset=utf-8"
        cache = "private, max-age=86400" if "v" in self.query else "no-store"
        size = path.stat().st_size
        start, end, status = 0, size - 1, 200
        rng = self.headers.get("Range")
        if rng:
            m = re.fullmatch(r"bytes=(\d*)-(\d*)", rng.strip())
            if m and (m[1] or m[2]) and not (m[1] and m[2] and int(m[1]) > int(m[2])):  # anything else is ignored (200)
                if m[1]:
                    start, end = int(m[1]), min(int(m[2] or size - 1), size - 1)
                else:
                    start = max(size - int(m[2]), 0)
                    if not int(m[2]):
                        start = size
                if start >= size:
                    self._send(416, b"", ctype, {"Content-Range": f"bytes */{size}"}, cache)
                    return None
                status = 206
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", cache)
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        with path.open("rb") as f:
            f.seek(start)
            left = end - start + 1
            try:
                while left > 0 and (chunk := f.read(min(1 << 20, left))):
                    self.wfile.write(chunk)
                    left -= len(chunk)
            except ConnectionError:
                self.close_connection = True
        return None

    def send_download(self, data, filename, ctype):
        q = urllib.parse.quote(filename)
        self._send(200, data, ctype, {"Content-Disposition": f"attachment; filename*=UTF-8''{q}"})
        return None

    def origin_ok(self, method):
        """Only pages served from this server may use it: Host must be local (DNS rebinding), and so must Origin when it is sent and the request changes something (CSRF)."""
        port = self.server.server_address[1]
        local = {f"127.0.0.1:{port}", f"localhost:{port}"}
        origin = self.headers.get("Origin")
        if port == 80:  # browsers leave the default port out of Host and Origin
            local |= {"127.0.0.1", "localhost"}
        if self.headers.get("Host") not in local:
            return False
        return method == "GET" or (origin is None or origin in {f"http://{h}" for h in local}) and self.headers.get("Sec-Fetch-Site") not in ("cross-site", "same-site")

    def dispatch(self, method):
        if not self.origin_ok(method):
            return self._send(403, json.dumps({"error": "このサーバーには、同じアドレスで開いたページからだけアクセスできます"}, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")
        u = urllib.parse.urlparse(self.path)
        self.query = urllib.parse.parse_qs(u.query)
        path = u.path
        if method == "GET" and not path.startswith("/api/"):
            return self.static(path)
        for m, rx, fn in ROUTES:
            mt = rx.match(path) if m == method else None
            if mt:
                PRESENCE.request_started()
                try:
                    res = fn(self, **mt.groupdict())
                    if res is not None:
                        self._send(200, json.dumps(res, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")
                except ApiError as e:
                    self._send(e.status, json.dumps({"error": str(e)}, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")
                except KeyError:
                    self._send(404, json.dumps({"error": "見つかりません"}, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")
                except Exception as e:  # keep the server alive and tell the page what broke
                    self._send(500, json.dumps({"error": f"{type(e).__name__}: {e}"}, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")
                    raise
                finally:
                    PRESENCE.request_finished()
                after, self.after_response = self.after_response, None
                if after:
                    after()
                return
        self._send(404, b'{"error":"not found"}', "application/json")

    def static(self, path):
        if path == "/mode.js":  # the static files say 'browser'; the server always says 'http'
            return self._send(200, b"const PROOF_MODE = 'http';\n", "text/javascript; charset=utf-8")
        rel = "index.html" if path in ("/", "") else path.lstrip("/")
        target = (STATIC / rel).resolve()
        if STATIC not in target.parents or not target.is_file():
            if rel != "index.html":  # relative asset paths under /x/ must not receive index.html
                return self._send(302, b"", "text/plain", {"Location": "/"})
            target = STATIC / "index.html"
        self.send_file(target)

    def do_GET(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")

    def do_PUT(self):
        self.dispatch("PUT")


def load_env(path=ENV_FILE):
    """KEY=VALUE lines from the repository's .env; they take precedence over the shell environment."""
    if not path.is_file():
        return []
    keys = []
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.removeprefix("export ").split("=", 1)
        k, v = k.strip(), v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
            v = v[1:-1]
        os.environ[k] = v
        keys.append(k)
    return keys


def venv_python(root, executable, env, has_anthropic):
    """The repository .venv's python to relaunch with when anthropic is missing here, else None."""
    if has_anthropic or env.get("PROOFREADER_NO_REEXEC"):
        return None
    for rel in (".venv/Scripts/python.exe", ".venv/bin/python"):
        py = Path(root) / rel
        if py.is_file():
            return py if Path(executable).resolve() != py.resolve() else None
    return None


def relaunch(py):
    """Run this app again under py, wait for it, and exit with its status."""
    print(f"  note: anthropic is missing here; restarting with {py.relative_to(ENV_FILE.parent)}", flush=True)
    child = subprocess.Popen([str(py), "-m", "proofreader", *sys.argv[1:]], cwd=ENV_FILE.parent,
                             env={**os.environ, "PROOFREADER_NO_REEXEC": "1"})
    while True:
        try:
            sys.exit(child.wait())
        except KeyboardInterrupt:
            continue


def watch(srv, presence=None, interval=5):
    """Shut the server down once no browser tab is left."""
    presence = presence or PRESENCE
    while True:
        time.sleep(interval)
        if presence.should_exit(time.monotonic()):
            print("  no browser window is open; shutting down", flush=True)
            srv.shutdown()
            return


def wait_idle(presence, timeout=120, sleep=time.sleep, interval=0.2):
    """Wait for in-flight requests to finish (up to timeout seconds); True if none remain."""
    waited = 0
    while presence.inflight and waited < timeout:
        if not waited:
            print("  waiting for running requests to finish", flush=True)
        sleep(interval)
        waited += interval
    return not presence.inflight


def main():
    py = venv_python(ENV_FILE.parent, sys.executable, os.environ, ocr.available())
    if py and not {"-h", "--help"} & set(sys.argv[1:]):
        relaunch(py)
    ap = argparse.ArgumentParser(description="OpenITI proofreading app")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--keep-running", action="store_true", help="do not exit when the browser tabs are closed")
    a = ap.parse_args()
    env_keys = load_env()
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), Handler)
    url = f"http://127.0.0.1:{a.port}/"
    print(f"Proofreader: {url}  (projects in {store.ROOT})")
    if env_keys:
        print(f"  loaded {ENV_FILE.name}: {', '.join(env_keys)}")
    if not ocr.available():
        print(f"  note: anthropic package not installed in this Python ({sys.executable}) - Claude OCR is disabled")
        if (ENV_FILE.parent / ".venv").is_dir():
            print(r"        start it with the virtual environment instead: .venv\Scripts\python -m proofreader")
    if not a.no_browser:
        webbrowser.open(url)
    if not a.keep_running:
        threading.Thread(target=watch, args=(srv,), daemon=True).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    wait_idle(PRESENCE)
    srv.server_close()


if __name__ == "__main__":
    main()
