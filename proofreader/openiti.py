"""Load OpenITI texts and their metadata, split them into pages, and put them back together.

The split is lossless: header + every page segment + its page marker + the tail
reproduces the original file byte for byte, so an unedited export equals the source.
"""
import math
import re
import urllib.parse

from . import net

HEADER_END = "#META#Header#End#"
# OpenITI convention: a page marker closes the page whose text precedes it
PAGE_RE = re.compile(r"PageV(\d+)P(\d+)")
URI_RE = re.compile(r"^(\d{4})([A-Za-z]+)\.([A-Za-z0-9]+)\.([A-Za-z0-9_-]+-[a-z]{3}\d+)(?:\.(?:mARkdown|completed|inProgress))?$")
RAW_BASE = "https://raw.githubusercontent.com/OpenITI"


def repo_for(death_year):
    """OpenITI keeps authors in 25-year repositories: 1014 -> 1025AH."""
    return f"{math.ceil(int(death_year) / 25) * 25:04d}AH"


def resolve(ref):
    """Turn a version URI, a GitHub URL or a raw URL into the raw text URL plus its URI."""
    ref = ref.strip()
    if ref.startswith("http"):
        u = urllib.parse.urlparse(ref)
        if u.netloc == "github.com":
            # https://github.com/OpenITI/1025AH/blob/master/data/... -> raw
            parts = u.path.strip("/").split("/")
            if len(parts) > 4 and parts[2] in ("blob", "raw"):
                ref = f"https://raw.githubusercontent.com/{parts[0]}/{parts[1]}/{'/'.join(parts[3:])}"
        elif u.netloc != "raw.githubusercontent.com":
            raise ValueError("GitHub上のOpenITIファイルのURLを指定してください")
        uri = urllib.parse.unquote(ref.rstrip("/").rsplit("/", 1)[-1])
        return ref, uri
    m = URI_RE.match(ref)
    if not m:
        raise ValueError("OpenITIのバージョンURI（例：1014IbnMaryamTilimsani.Bustan.Kraken22021817402301-ara1）として読めません")
    year, name, book, _ = m.groups()
    author = f"{year}{name}"
    uri = ref.split(".mARkdown")[0].split(".completed")[0].split(".inProgress")[0]
    path = f"data/{author}/{author}.{book}/{ref}"
    return f"{RAW_BASE}/{repo_for(year)}/master/{path}", uri


def yml_urls(raw_url, uri):
    """Version, book and author yml files that sit next to the text."""
    base = raw_url.rsplit("/", 1)[0]
    m = URI_RE.match(uri)
    if not m:
        return {"version": f"{base}/{uri}.yml"}
    year, name, book, _ = m.groups()
    author = f"{year}{name}"
    return {
        "version": f"{base}/{uri}.yml",
        "book": f"{base}/{author}.{book}.yml",
        "author": f"{base.rsplit('/', 1)[0]}/{author}.yml",
    }


PLACEHOLDERS = ("Fulān", "Muʾallif", "permalink", "URIs from", "YEAR-MON", "src@", "comma separated",
                "a free running comment", "URI of a book")


def parse_yml(text):
    """OpenITI yml is 'NN#KIND#FIELD##LANG: value' with indented continuation lines.

    Fields still holding the template's placeholder text are dropped."""
    out, key = {}, None
    for line in text.splitlines():
        m = re.match(r"^\d+#([\w#]+?)#*:\s?(.*)$", line)
        if m:
            key = m[1]
            out[key] = m[2].strip()
        elif key and line.startswith((" ", "\t")):
            out[key] = (out[key] + "\n" + line.strip()).strip()
    return {k: v for k, v in out.items() if v and not any(p in v for p in PLACEHOLDERS)}


def header_meta(text, field):
    """Values like '#META# 020.BookTITLE :: ...' that Shamela-derived texts carry in the header."""
    m = re.search(rf"^#META#\s*[\d.]*\s*{field}\s*::\s*(.+)$", text[:20000], re.M)
    return m[1].strip() if m and m[1].strip() not in ("NODATA", "") else ""


def camel_words(s):
    return re.sub(r"(?<=[a-z])(?=[A-Z])", " ", s)


def fetch(ref):
    raw_url, uri = resolve(ref)
    text = net.get_text(raw_url)
    meta = {}
    for kind, url in yml_urls(raw_url, uri).items():
        try:
            meta[kind] = parse_yml(net.get_text(url))
        except net.FetchError:
            meta[kind] = {}
    return {"uri": uri, "raw_url": raw_url, "text": text, "meta": meta}


def split(text):
    """Split into header, page segments and tail. Each page keeps the exact marker text."""
    cut = text.find(HEADER_END)
    cut = cut + len(HEADER_END) if cut >= 0 else 0
    header, body = text[:cut], text[cut:]
    pages, pos = [], 0
    for m in PAGE_RE.finditer(body):
        pages.append({"vol": int(m[1]), "page": int(m[2]), "marker": m[0], "text": body[pos:m.start()]})
        pos = m.end()
    return {"header": header, "pages": pages, "tail": body[pos:]}


def join(parts, edits=None):
    edits = edits or {}
    out = [parts["header"]]
    for i, pg in enumerate(parts["pages"]):
        out.append(edits.get(str(i), pg["text"]))
        out.append(pg["marker"])
    out.append(parts["tail"])
    return "".join(out)


def title_of(meta, text="", uri=""):
    book = meta.get("book", {})
    m = URI_RE.match(uri)
    return (book.get("BOOK#TITLEA#AR") or book.get("BOOK#TITLEB#AR") or header_meta(text, "BookTITLE")
            or (camel_words(m[3]) if m else ""))


def author_of(meta, text="", uri=""):
    a = meta.get("author", {})
    m = URI_RE.match(uri)
    return (a.get("AUTH#SHUHRA#AR") or a.get("AUTH#ISM#AR") or header_meta(text, "AuthorNAME")
            or (camel_words(m[2]) if m else ""))


def scan_links(meta):
    """archive.org item ids mentioned anywhere in the yml files."""
    found = []
    for d in meta.values():
        for v in d.values():
            for m in re.finditer(r"archive\.org/(?:details|download)/([A-Za-z0-9._-]+)", v):
                if m[1] not in found:
                    found.append(m[1])
    return found
