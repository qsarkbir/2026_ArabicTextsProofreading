"""A conservative TEI P5 export of basic OpenITI structure and page notes."""
import re
import xml.etree.ElementTree as ET

NS = "http://www.tei-c.org/ns/1.0"
ET.register_namespace("", NS)


def export(project, parts, work):
    warnings = set()

    def child(parent, name, text=None, **attrs):
        el = ET.SubElement(parent, f"{{{NS}}}{name}", attrs)
        el.text = text
        return el

    def append(el, text):
        if len(el):
            el[-1].tail = (el[-1].tail or "") + text
        else:
            el.text = (el.text or "") + text

    root = ET.Element(f"{{{NS}}}TEI")
    header = child(root, "teiHeader")
    desc = child(header, "fileDesc")
    title = child(desc, "titleStmt")
    child(title, "title", project.get("title") or project["uri"])
    if project.get("author"):
        child(title, "author", project["author"])
    publication = child(desc, "publicationStmt")
    child(publication, "publisher", "未刊（校正作業用）")
    bib = project.get("bibliography", {})
    if bib.get("rights"):
        child(child(publication, "availability"), "p", bib["rights"])
    source = child(desc, "sourceDesc")
    child(source, "p", bib.get("edition") or "底本の書誌情報は未入力。")
    if project.get("raw_url"):
        child(child(source, "p"), "ref", "入力テキスト", target=project["raw_url"])
    if bib.get("source"):
        child(source, "p", bib["source"])
    encoding = child(header, "encodingDesc")
    child(child(encoding, "editorialDecl"), "p", "OpenITIの編集用折り返しは空白へ統合。ページ境界は原本のページ先頭。OCR誤読の修正は底本の校訂と区別し、sic/corrへ自動変換しない。")
    revisions = child(header, "revisionDesc")
    child(revisions, "change", "校正本文を書き出し。詳細な本文履歴はプロジェクトのwork.jsonに保持。")
    body = child(child(root, "text", **{"{http://www.w3.org/XML/1998/namespace}lang": "ar"}), "body")
    parent, paragraph = body, None
    stack = [(0, body)]
    last_volume = None

    def feed(text):
        nonlocal parent, paragraph, stack
        for line in text.splitlines():
            if not line.strip():
                continue
            heading = re.match(r"^### (\|+)\s*(.*)$", line)
            if line.startswith("### |EDITOR|"):
                parent = child(body, "div", type="editorial")
                stack, paragraph = [(0, body), (1, parent)], None
                continue
            if heading:
                level = len(heading[1])
                while len(stack) > 1 and stack[-1][0] >= level:
                    stack.pop()
                parent = child(stack[-1][1], "div")
                child(parent, "head", heading[2])
                stack.append((level, parent))
                paragraph = None
                continue
            if line.startswith("###") or re.search(r"\bms\d+|@\w+", line):
                warnings.add("未対応のOpenITIタグを文字列として保持しています。")
            if "%~%" in line:
                verse = child(child(parent, "lg"), "l")
                segments = re.sub(r"^#\s?", "", line).split("%~%")
                for n, segment in enumerate(segments):
                    if n:
                        child(verse, "caesura")
                    append(verse, segment)
                paragraph = None
                continue
            if line.startswith("# ") and not line.startswith("###"):
                paragraph = child(parent, "p")
                line = line[2:]
            elif line.startswith("~~"):
                line = line[2:]
            if paragraph is None:
                paragraph = child(parent, "p")
            if paragraph.text or len(paragraph):
                append(paragraph, " ")
            append(paragraph, line)

    for i, page in enumerate(parts["pages"]):
        if page.get("unassigned"):
            warnings.add("ページ未割当の末尾を含みます。")
            child(parent, "note", "ページ未割当の末尾", type="editorial")
        else:
            target = paragraph if paragraph is not None else parent
            if page["vol"] != last_volume:
                child(target, "milestone", unit="volume", n=str(page["vol"]))
                last_volume = page["vol"]
            attrs = {"n": str(page["page"]), "{http://www.w3.org/XML/1998/namespace}id": f"page-{i}"}
            src = project.get("source") or {}
            from ..store import image_index
            index = image_index(project, i)
            if src.get("type") == "ia" and 0 <= index < len(src.get("pages", [])):
                attrs["facs"] = f"https://archive.org/details/{src['id']}/page/n{index}/mode/1up"
            child(target, "pb", **attrs)
        feed(work["edits"].get(str(i), page["text"]))
        note = work["status"].get(str(i), {}).get("note")
        if note:
            attrs = {"type": "editorial"}
            if not page.get("unassigned"):
                attrs["corresp"] = f"#page-{i}"
            child(paragraph if paragraph is not None else parent, "note", note, **attrs)
    if parts["tail"].strip():
        feed(parts["tail"])
    if warnings:
        for warning in sorted(warnings):
            child(child(encoding, "projectDesc"), "p", warning)
    if not any(el.tag in {f"{{{NS}}}{name}" for name in ("p", "div", "lg")} for el in body):
        child(body, "p", "")
    for el in root.iter():
        for value in (el.text, el.tail, *el.attrib.values()):
            if value and re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff\ufffe\uffff]", value):
                raise ValueError("XMLに出力できない制御文字が本文または書誌に含まれています")
    return ET.tostring(root, encoding="utf-8", xml_declaration=True), sorted(warnings)
