"""Small HTTP helpers limited to the services the app talks to."""
import http.client
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

ALLOWED = ("raw.githubusercontent.com", "archive.org", "iiif.archive.org")
UA = "ArabicTextsProofreading/0.1 (local proofreading tool)"


class FetchError(Exception):
    pass


def _check_host(url):
    host = urllib.parse.urlparse(url).hostname or ""
    if not any(host == h or host.endswith("." + h) for h in ALLOWED):
        raise FetchError(f"許可していない接続先です: {host}")


class _Redirects(urllib.request.HTTPRedirectHandler):
    """Follow redirects only to allowed hosts."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        _check_host(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_opener = urllib.request.build_opener(_Redirects)


def _open(url, timeout=60):
    _check_host(url)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        return _opener.open(req, timeout=timeout)
    except urllib.error.HTTPError as e:
        raise FetchError(f"{e.code} {e.reason}: {url}") from e
    except urllib.error.URLError as e:
        raise FetchError(f"接続できません: {url} ({e.reason})") from e


def _retry_wait(e):
    try:
        return min(max(float(e.headers.get("Retry-After", 5)), 0), 30)
    except (TypeError, ValueError, AttributeError):
        return 5


def download(url, path, limit, progress=None, timeout=60):
    """Stream url to path (temp file + os.replace), refusing more than limit bytes; one retry on 429/503."""
    _check_host(url)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        try:
            r = _opener.open(req, timeout=timeout)
        except urllib.error.HTTPError as e:
            if e.code not in (429, 503):
                raise
            e.close()
            time.sleep(_retry_wait(e))
            r = _opener.open(req, timeout=timeout)
    except urllib.error.HTTPError as e:
        raise FetchError(f"{e.code} {e.reason}: {url}") from e
    except urllib.error.URLError as e:
        raise FetchError(f"接続できません: {url} ({e.reason})") from e
    tmp = path.with_name(f"{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with r, tmp.open("wb") as f:
            total = int(r.headers.get("Content-Length") or 0) or None
            if total and total > limit:
                raise FetchError(f"ファイルが大きすぎます（上限 {limit // 1048576} MB）")
            done = 0
            while chunk := r.read(1 << 16):
                done += len(chunk)
                if done > limit:
                    raise FetchError(f"ファイルが大きすぎます（上限 {limit // 1048576} MB）")
                f.write(chunk)
                if progress:
                    progress(done, total)
        os.replace(tmp, path)
    except (OSError, http.client.HTTPException) as e:
        raise FetchError(f"ダウンロードに失敗しました: {e}") from e
    finally:
        tmp.unlink(missing_ok=True)


def get_bytes(url, timeout=60):
    with _open(url, timeout) as r:
        return r.read(), r.headers.get_content_type()


def get_text(url):
    data, _ = get_bytes(url)
    return data.decode("utf-8")


def get_json(url):
    return json.loads(get_text(url))
