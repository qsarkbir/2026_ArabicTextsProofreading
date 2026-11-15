"""Local web server for proofreading OpenITI texts against page images.

usage: python -m proofreader [--port 8765] [--no-browser]
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
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from . import net, ocr, openiti, sources, store
from .presence import Presence

STATIC = Path(__file__).resolve().parent / "static"
ENV_FILE = Path(__file__).resolve().parent.parent / ".env"
ROUTES = []
PRESENCE = Presence()
CLIENT_ID = re.compile(r"^[A-Za-z0-9-]{1,64}$")
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
        "pages": [{"vol": pg["vol"], "page": pg["page"]} for pg in pages],
        "edited": sorted(int(k) for k in w["edits"]),
        "done": sorted(int(k) for k, s in w["status"].items() if s.get("done")),
        "noted": sorted(int(k) for k, s in w["status"].items() if s.get("note")),
        "ocr": ocr.available(),
        "ocr_reason": ocr.reason(),
        "ocr_models": ocr.MODELS,
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
        return {"index": idx, "key": key, "count": len(src["pages"]), "label": c["label"], "service": c["service"],
                "w": c["w"], "h": c["h"],
                "url": f"/api/projects/{p['slug']}/scan/{idx}?w=1600&v={urllib.parse.quote(str(src.get('revision') or src['id']))}"
                       + (f"&draft={draft}" if draft else ""),
                "link": f"https://archive.org/details/{src['id']}/page/n{idx}/mode/1up"}
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
    if not img or img.get("missing") or "service" not in img:
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
        found.append({"i": i, "marker": pg["marker"], "note": st.get("note", "")})
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
    return {"i": i, "vol": pg["vol"], "page": pg["page"], "marker": pg["marker"],
            "original": pg["text"], "text": w["edits"].get(str(i), pg["text"]),
            "done": bool(st.get("done")), "note": st.get("note", ""),
            "ocr": cached, "image": img}


@route("PUT", r"/api/projects/(?P<slug>[^/]+)/pages/(?P<i>\d+)")
def put_page(h, slug, i):
    i = page_index(slug, i)
    b = h.json()
    store.update_page(slug, i, text=b.get("text"), done=b.get("done"), note=b.get("note"))
    return project_view(slug) | {"page": i}


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
    if cached and cached.get("image_key") and not b.get("force") and cached["image_key"] == img.get("key"):
        return cached
    if p["source"]["type"] == "ia":
        data, mtype = scan_bytes(slug, p["source"], img, 2000)
    else:
        m = re.match(r"data:(image/(?:jpeg|png));base64,(.+)", b.get("image") or "", re.S)
        if not m:
            raise ApiError("PDFのページ画像が送られていません")
        mtype, data = m[1], base64.b64decode(m[2])
    try:
        res = ocr.transcribe(data, mtype, model=b.get("model") or ocr.MODEL)
    except ocr.OCRUnavailable as e:
        raise ApiError(str(e), HTTPStatus.SERVICE_UNAVAILABLE)
    res["image_index"] = img["index"]
    res["image_key"] = img["key"]
    if (image_for(store.load(slug), i) or {}).get("key") != img["key"]:
        raise ApiError("読み取り中に画像の対応が変更されました。もう一度読み取ってください", HTTPStatus.CONFLICT)
    store.ocr_put(slug, i, res)
    return res


# ---------- export ----------

@route("GET", r"/api/projects/(?P<slug>[^/]+)/export")
def export(h, slug):
    fmt = h.query.get("fmt", ["text"])[0]
    p = store.load(slug)
    parts = store.parts(slug)
    w = store.work(slug)
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
        return self.rfile.read(n) if n else b""

    def json(self):
        raw = self.body()
        try:
            return json.loads(raw) if raw else {}
        except ValueError:
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
        self._send(200, path.read_bytes(), ctype)
        return None

    def send_download(self, data, filename, ctype):
        q = urllib.parse.quote(filename)
        self._send(200, data, ctype, {"Content-Disposition": f"attachment; filename*=UTF-8''{q}"})
        return None

    def dispatch(self, method):
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
        rel = "index.html" if path in ("/", "") else path.lstrip("/")
        target = (STATIC / rel).resolve()
        if STATIC not in target.parents and target != STATIC / "index.html" or not target.is_file():
            target = STATIC / "index.html"  # client-side routes
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
