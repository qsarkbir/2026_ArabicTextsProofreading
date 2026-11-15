"""Small HTTP helpers limited to the services the app talks to."""
import json
import urllib.error
import urllib.parse
import urllib.request

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


def get_bytes(url, timeout=60):
    with _open(url, timeout) as r:
        return r.read(), r.headers.get_content_type()


def get_text(url):
    data, _ = get_bytes(url)
    return data.decode("utf-8")


def get_json(url):
    return json.loads(get_text(url))
