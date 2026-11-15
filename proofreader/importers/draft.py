"""Build a page-addressable empty transcription from selected PDF pages."""
import uuid


def build(metadata):
    count = int(metadata.get("count", 0))
    start = int(metadata.get("start", 1))
    end = int(metadata.get("end", count))
    first = int(metadata.get("first_page", 1))
    volume = int(metadata.get("volume", 1))
    if not (1 <= start <= end <= count <= 20000 and 0 <= first <= 99999 and 0 <= volume <= 99):
        raise ValueError("PDFの対象範囲・巻・印刷ページ番号を確認してください")
    title = str(metadata.get("title", "")).strip()
    if not title:
        raise ValueError("書名を入力してください")
    uri = "local-" + uuid.uuid4().hex[:12]
    text = "######OpenITI#\n\n#META#Header#End#\n\n"
    text += "".join(f"# \nPageV{volume:02d}P{first + i:03d}\n\n" for i in range(end - start + 1))
    return {"uri": uri, "text": text, "meta": {}}, {
        "title": title, "author": str(metadata.get("author", "")).strip(),
        "bibliography": {key: str(metadata.get(key, "")).strip() for key in ("edition", "source", "rights")},
        "draft": True, "offset": start - 1,
    }
