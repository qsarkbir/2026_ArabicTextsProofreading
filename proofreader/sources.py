"""Page images: Internet Archive items (via IIIF) or a PDF the proofreader uploads."""
import http.client
import re
import urllib.parse

from . import net


def ia_pages(identifier):
    """Canvases of an IA item from its IIIF manifest: label, size and image service per page."""
    m = net.get_json(f"https://iiif.archive.org/iiif/{urllib.parse.quote(identifier)}/manifest.json")
    pages = []
    for c in m.get("items", []):
        try:
            body = c["items"][0]["items"][0]["body"]
            service = body["service"][0]["id"]
        except (KeyError, IndexError):
            continue
        label = (c.get("label", {}).get("none") or [""])[0]
        pages.append({"label": label, "w": c.get("width"), "h": c.get("height"), "service": service})
    title = (m.get("label", {}).get("none") or m.get("label", {}).get("en") or [""])[0]
    return {"type": "ia", "id": identifier, "title": title, "pages": pages}


def ia_image_url(service, width=1600):
    return f"{service}/full/{width},/0/default.jpg"


def fetch_scan(src, idx, width=1600):
    """Page image bytes: IIIF first (short timeout), then the BookReader URL when IIIF stalls."""
    url = ia_image_url(src["pages"][idx]["service"], width)
    try:
        return net.get_bytes(url, timeout=10)
    except (net.FetchError, OSError, http.client.HTTPException) as e:
        first = e
    alt = f"https://archive.org/download/{urllib.parse.quote(src['id'])}/page/n{idx}_w{width}.jpg"
    try:
        return net.get_bytes(alt, timeout=60)
    except (net.FetchError, OSError, http.client.HTTPException) as e:
        raise net.FetchError(f"IIIF と BookReader のどちらでも取得できませんでした（{first}／{e}）") from e


PDF_FORMATS = ("Image Container PDF", "Text PDF", "Additional Text PDF")


def ia_pdf(identifier):
    """The item's best PDF from the metadata API: {name, size, format}, or None."""
    d = net.get_json(f"https://archive.org/metadata/{urllib.parse.quote(identifier)}")
    best = None
    for f in d.get("files", []):
        name = f.get("name") or ""
        if not name.lower().endswith(".pdf") or str(f.get("private", "")).lower() == "true":
            continue
        fmt = f.get("format") or ""
        try:
            size = int(f.get("size") or 0)
        except ValueError:
            size = 0
        rank = PDF_FORMATS.index(fmt) if fmt in PDF_FORMATS else len(PDF_FORMATS)
        if best is None or (rank, -size) < best[0]:
            best = ((rank, -size), {"name": name, "size": size, "format": fmt})
    return best and best[1]


def ia_search(query, rows=20):
    q = f"({query}) AND mediatype:texts"
    params = urllib.parse.urlencode(
        [("q", q), ("rows", rows), ("output", "json")]
        + [("fl[]", f) for f in ("identifier", "title", "creator", "date", "imagecount", "language")])
    d = net.get_json(f"https://archive.org/advancedsearch.php?{params}")
    out = []
    for doc in d.get("response", {}).get("docs", []):
        def s(v):
            return "; ".join(v) if isinstance(v, list) else (v or "")
        out.append({"id": doc["identifier"], "title": s(doc.get("title")), "creator": s(doc.get("creator")),
                    "date": s(doc.get("date")), "imagecount": doc.get("imagecount"),
                    "thumb": f"https://archive.org/services/img/{doc['identifier']}"})
    return out


STOP = {"في", "من", "على", "ابن", "بن", "كتاب", "Ibn", "ibn", "al", "Kitab"}


def search_terms(title, author):
    """A loose IA query: the longest few words of the title and author (IA search is word-based)."""
    words = [w for w in re.split(r"[\s،,:.\-]+", f"{title} {author}") if len(w) > 2 and w not in STOP]
    seen = []
    for w in sorted(words, key=len, reverse=True):
        if w not in seen:
            seen.append(w)
    return " ".join(seen[:3])
