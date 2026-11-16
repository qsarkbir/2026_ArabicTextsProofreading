"""Project backup file (<slug>.proofreader.json): the project, the original text and the work in one JSON.

The format is shared with the browser version (static/local/bundle.js); docs/static-design.md describes it.
PDFs and OCR results are not included: a restored project has to have its PDF attached again.
"""
import copy
import json
import re
import time

from . import openiti, store

FORMAT = "openiti-proofreader-project"
FORMAT_VERSION = 1
SCHEMA_VERSION = 2  # of project.json and work.json
APP_VERSION = "0.1.0"
NEWER = "新しい版のアプリで作られたデータです。アプリを更新してから読み込んでください"
NOT_BUNDLE = "このファイルは校正プロジェクトのバックアップではありません"
INDEX = re.compile(r"0|[1-9][0-9]*")


class BundleError(ValueError):
    pass


SAFE = 2 ** 53 - 1  # what a JS number holds exactly


def _int(v):
    return isinstance(v, int) and not isinstance(v, bool) and abs(v) <= SAFE


def _integral(v):
    """JSON 1.0 is the integer 1 in JS: read integral floats the same way so that both versions accept and return the same data."""
    if isinstance(v, float) and v.is_integer() and abs(v) <= SAFE:
        return int(v)
    if isinstance(v, list):
        return [_integral(x) for x in v]
    if isinstance(v, dict):
        return {k: _integral(x) for k, x in v.items()}
    return v


def _flag(v):
    return v is None or isinstance(v, bool)


def _status(entry):
    return {**({"done": True} if entry.get("done") else {}), **({"note": entry["note"]} if entry.get("note") else {})}


def build(slug):
    """The backup of one project as a dict (the caller serializes it)."""
    w = store.work(slug)
    return {
        "format": FORMAT, "format_version": FORMAT_VERSION,
        "exported": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "app": {"mode": "http", "version": APP_VERSION},
        "project": store.load(slug), "original": store.original_text(slug),
        "work": {"edits": w["edits"], "status": {k: s for k, v in w["status"].items() if (s := _status(v))},
                 "history": w.get("history", {}), "revisions": w.get("revisions", {}), "schema_version": SCHEMA_VERSION},
    }


def _version(obj, what):
    v = obj.get("schema_version")
    if v is None:
        return
    if not _int(v) or v < 1:
        raise BundleError(f"{what}の版番号が正しくありません")
    if v > SCHEMA_VERSION:
        raise BundleError(NEWER)


def _str(v):
    return isinstance(v, str)


def _page(c):
    return (isinstance(c, dict) and _str(c.get("service")) and (_str(c.get("label")) or _int(c.get("label")))
            and all(c.get(k) is None or _int(c[k]) for k in ("w", "h")))


def _source(v):
    if v is None:
        return True
    if not isinstance(v, dict) or v.get("type") not in ("ia", "pdf") or not all(_str(v[k]) for k in ("revision", "pdf_file", "title") if k in v):
        return False
    if v["type"] == "ia":
        return _str(v.get("id")) and isinstance(v.get("pages"), list) and all(map(_page, v["pages"]))
    return _str(v.get("file")) and _int(v.get("count"))


PROJECT_FIELDS = (  # key, default, check
    ("raw_url", "", lambda v: isinstance(v, str)), ("title", "", lambda v: isinstance(v, str)),
    ("author", "", lambda v: isinstance(v, str)), ("meta", {}, lambda v: isinstance(v, dict)),
    ("candidates", [], lambda v: isinstance(v, list) and all(map(_str, v))), ("offset", 0, _int),
    ("anchors", [], lambda v: isinstance(v, list) and all(isinstance(a, list) and len(a) == 2 and all(map(_int, a)) for a in v)),
    ("source", None, _source),
    ("bibliography", {}, lambda v: isinstance(v, dict) and all(map(_str, v.values()))),
)


def _project(project):
    uri = project.get("uri")
    if not isinstance(uri, str) or not uri:
        raise BundleError("プロジェクトのURIがありません")
    if "created" in project and not isinstance(project["created"], str):
        raise BundleError("プロジェクト情報の「created」が正しくありません")
    out = {k: v for k, v in project.items() if k != "slug"}
    for key, default, ok in PROJECT_FIELDS:
        if key in out and not ok(out[key]):
            raise BundleError(f"プロジェクト情報の「{key}」が正しくありません")
        if key not in out and key != "bibliography":
            out[key] = copy.deepcopy(default)
    out["schema_version"] = SCHEMA_VERSION
    return out


def _table(work, name, n):
    t = work.get(name, {})
    if not isinstance(t, dict):
        raise BundleError(f"作業データの「{name}」が正しくありません")
    for k in t:
        if not INDEX.fullmatch(k) or int(k) >= n:
            raise BundleError(f"作業データのページ番号が範囲外です：{k}")
    return t


def _work(work, pages):
    n = len(pages)
    edits, status, history, revisions = {}, {}, {}, {}
    for k, v in _table(work, "edits", n).items():
        if not isinstance(v, str):
            raise BundleError("作業データの修正本文が文字列ではありません")
        if v != pages[int(k)]["text"]:
            edits[k] = v
    for k, v in _table(work, "status", n).items():
        if not isinstance(v, dict) or not (v.get("note") is None or isinstance(v["note"], str)) or not _flag(v.get("done")):
            raise BundleError("作業データの注記が正しくありません")
        if s := _status(v):
            status[k] = s
    for k, v in _table(work, "history", n).items():
        if not isinstance(v, list):
            raise BundleError("作業データの履歴が正しくありません")
        entries = []
        for e in v:
            if not (isinstance(e, dict) and isinstance(e.get("text"), str) and _int(e.get("revision")) and e["revision"] >= 0
                    and isinstance(e.get("time"), str) and (e.get("note") is None or isinstance(e["note"], str)) and _flag(e.get("done"))):
                raise BundleError("作業データの履歴が正しくありません")
            entries.append({"text": e["text"], **_status(e), "revision": e["revision"], "time": e["time"]})
        if entries:
            history[k] = entries[-store.HISTORY_LIMIT:]
    for k, v in _table(work, "revisions", n).items():
        if not _int(v) or v < 0:
            raise BundleError("作業データのrevisionが正しくありません")
        if v:
            revisions[k] = v
    return {"edits": edits, "status": status, "history": history, "revisions": revisions, "schema_version": SCHEMA_VERSION}


def parse(data):
    """Validate a backup and return (project, original text, work); BundleError carries a message for the user."""
    try:
        return _parse(data)
    except RecursionError:
        raise BundleError("バックアップの入れ子が深すぎて読めません")


def _parse(data):
    if not isinstance(data, dict) or data.get("format") != FORMAT:
        raise BundleError(NOT_BUNDLE)
    version = _integral(data.get("format_version"))
    if not _int(version) or version < 1:
        raise BundleError("バックアップの形式の版番号が正しくありません")
    if version > FORMAT_VERSION:
        raise BundleError(NEWER)
    project, work, text = data.get("project"), data.get("work"), data.get("original")
    if not isinstance(project, dict) or not isinstance(work, dict):
        raise BundleError("バックアップにプロジェクトまたは作業データがありません")
    project, work = _integral(project), _integral(work)
    _version(project, "プロジェクト")
    _version(work, "作業データ")
    if not isinstance(text, str):
        raise BundleError("バックアップの原文が文字列ではありません")
    parts = openiti.split(text)
    if not parts["pages"]:
        raise BundleError("ページ区切り（PageV..P..）がないテキストは校正できません")
    if openiti.join(parts) != text:
        raise BundleError("バックアップの原文を分割して再結合すると一致しません。ファイルが壊れています")
    out = _project(project), text, _work(work, parts["pages"])
    try:
        json.dumps(out, ensure_ascii=False).encode("utf-8")
    except UnicodeEncodeError:
        raise BundleError("バックアップに不正な文字（対になっていないサロゲート）が含まれています")
    return out
