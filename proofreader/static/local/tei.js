// exporters/tei.py の移植。基本 TEI P5 を、Python の ElementTree と同じバイト列で書き出す。
const TEI = (() => {
  const NS = 'http://www.tei-c.org/ns/1.0';
  const XML = 'http://www.w3.org/XML/1998/namespace';
  const {pyStrip, splitLines, WS} = OpenITI;
  const WORD = '[\\p{L}\\p{N}_]'; // Python の \w
  const HEADING = new RegExp(`^### (\\|+)[${WS}]*(.*)$`, 'u');
  const LEAD_HASH = new RegExp(`^#[${WS}]?`, 'u');
  const UNSUPPORTED = new RegExp(`(?<!${WORD})ms\\p{Nd}|@${WORD}`, 'u');
  const BAD_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]|[\ud800-\udfff]/u; // u フラグでは対になっていないサロゲートだけに一致する
  const BAD_XML = 'XMLに出力できない制御文字が本文または書誌に含まれています';

  const imageIndex = (project, i) => { // store.image_index
    let best = null;
    for (const [aPage, aImg] of project.anchors || []) if (aPage <= i && (best === null || aPage > best[0])) best = [aPage, aImg];
    return best ? best[1] + (i - best[0]) : (project.offset || 0) + i;
  };

  const cdata = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const attrib = s => cdata(s).replace(/"/g, '&quot;').replace(/\r/g, '&#13;').replace(/\n/g, '&#10;').replace(/\t/g, '&#09;');

  // ElementTree の tostring：子も本文も無い要素は <x />
  const serialize = (el, out) => {
    out.push('<', el.tag);
    for (const [k, v] of el.attrs) out.push(' ', k, '="', attrib(v), '"');
    if (el.text || el.children.length) {
      out.push('>');
      if (el.text) out.push(cdata(el.text));
      for (const c of el.children) serialize(c, out);
      out.push('</', el.tag, '>');
    } else out.push(' />');
    if (el.tail) out.push(cdata(el.tail));
  };

  const exportTei = (project, parts, work) => {
    const warnings = new Set();
    const child = (parent, tag, text = null, attrs = []) => {
      const el = {tag, attrs, text, tail: null, children: []};
      parent.children.push(el);
      return el;
    };
    const append = (el, text) => {
      if (el.children.length) { const last = el.children[el.children.length - 1]; last.tail = (last.tail || '') + text; }
      else el.text = (el.text || '') + text;
    };

    const root = {tag: 'TEI', attrs: [['xmlns', NS]], text: null, tail: null, children: []};
    const header = child(root, 'teiHeader');
    const desc = child(header, 'fileDesc');
    const title = child(desc, 'titleStmt');
    child(title, 'title', project.title || project.uri);
    if (project.author) child(title, 'author', project.author);
    const publication = child(desc, 'publicationStmt');
    child(publication, 'publisher', '未刊（校正作業用）');
    const bib = project.bibliography || {};
    if (bib.rights) child(child(publication, 'availability'), 'p', bib.rights);
    const source = child(desc, 'sourceDesc');
    child(source, 'p', bib.edition || '底本の書誌情報は未入力。');
    if (project.raw_url) child(child(source, 'p'), 'ref', '入力テキスト', [['target', project.raw_url]]);
    if (bib.source) child(source, 'p', bib.source);
    const encoding = child(header, 'encodingDesc');
    child(child(encoding, 'editorialDecl'), 'p', 'OpenITIの編集用折り返しは空白へ統合。ページ境界は原本のページ先頭。OCR誤読の修正は底本の校訂と区別し、sic/corrへ自動変換しない。');
    const revisions = child(header, 'revisionDesc');
    child(revisions, 'change', '校正本文を書き出し。詳細な本文履歴はプロジェクトのwork.jsonに保持。');
    const body = child(child(root, 'text', null, [['xml:lang', 'ar']]), 'body');
    let parent = body, paragraph = null, stack = [[0, body]], lastVolume = null;

    const feed = text => {
      for (const line0 of splitLines(text)) {
        let line = line0;
        if (!pyStrip(line)) continue;
        const heading = HEADING.exec(line);
        if (line.startsWith('### |EDITOR|')) {
          parent = child(body, 'div', null, [['type', 'editorial']]);
          stack = [[0, body], [1, parent]]; paragraph = null;
          continue;
        }
        if (heading) {
          const level = heading[1].length;
          while (stack.length > 1 && stack[stack.length - 1][0] >= level) stack.pop();
          parent = child(stack[stack.length - 1][1], 'div');
          child(parent, 'head', heading[2]);
          stack.push([level, parent]); paragraph = null;
          continue;
        }
        if (line.startsWith('###') || UNSUPPORTED.test(line)) warnings.add('未対応のOpenITIタグを文字列として保持しています。');
        if (line.includes('%~%')) {
          const verse = child(child(parent, 'lg'), 'l');
          line.replace(LEAD_HASH, '').split('%~%').forEach((segment, n) => {
            if (n) child(verse, 'caesura');
            append(verse, segment);
          });
          paragraph = null;
          continue;
        }
        if (line.startsWith('# ') && !line.startsWith('###')) { paragraph = child(parent, 'p'); line = line.slice(2); }
        else if (line.startsWith('~~')) line = line.slice(2);
        if (paragraph === null) paragraph = child(parent, 'p');
        if (paragraph.text || paragraph.children.length) append(paragraph, ' ');
        append(paragraph, line);
      }
    };

    parts.pages.forEach((page, i) => {
      if (page.unassigned) {
        warnings.add('ページ未割当の末尾を含みます。');
        child(parent, 'note', 'ページ未割当の末尾', [['type', 'editorial']]);
      } else {
        const target = paragraph !== null ? paragraph : parent;
        if (page.vol !== lastVolume) { child(target, 'milestone', null, [['unit', 'volume'], ['n', String(page.vol)]]); lastVolume = page.vol; }
        const attrs = [['n', String(page.page)], ['xml:id', `page-${i}`]];
        const src = project.source || {};
        const index = imageIndex(project, i);
        if (src.type === 'ia' && index >= 0 && index < (src.pages || []).length) attrs.push(['facs', `https://archive.org/details/${src.id}/page/n${index}/mode/1up`]);
        child(target, 'pb', null, attrs);
      }
      feed(Object.hasOwn(work.edits, String(i)) ? work.edits[String(i)] : page.text);
      const note = (work.status[String(i)] || {}).note;
      if (note) {
        const attrs = [['type', 'editorial']];
        if (!page.unassigned) attrs.push(['corresp', `#page-${i}`]);
        child(paragraph !== null ? paragraph : parent, 'note', note, attrs);
      }
    });
    if (pyStrip(parts.tail)) feed(parts.tail);
    for (const warning of [...warnings].sort()) child(child(encoding, 'projectDesc'), 'p', warning);
    if (!body.children.some(el => ['p', 'div', 'lg'].includes(el.tag))) child(body, 'p', '');
    const walk = el => {
      for (const v of [el.text, el.tail, ...el.attrs.map(a => a[1])]) if (v && BAD_CHARS.test(v)) throw new Error(BAD_XML);
      el.children.forEach(walk);
    };
    walk(root);
    const out = [];
    serialize(root, out);
    return {data: new TextEncoder().encode(`<?xml version='1.0' encoding='utf-8'?>\n${out.join('')}`), warnings: [...warnings].sort()};
  };

  return {NS, export: exportTei};
})();

if (typeof module !== 'undefined') module.exports = TEI;
