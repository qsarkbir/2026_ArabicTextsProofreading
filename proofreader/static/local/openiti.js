// openiti.py の移植。split/join は substring だけで動き、Python と同じ結果になる。
const HEADER_END = '#META#Header#End#';
const PAGE_RE = /PageV(\p{Nd}+)P(\p{Nd}+)/gu;
const URI_RE = /^(\p{Nd}{4})([A-Za-z]+)\.([A-Za-z0-9]+)\.([A-Za-z0-9_-]+-[a-z]{3}\p{Nd}+)(?:\.(?:mARkdown|completed|inProgress))?(?=\n?$)/u;
const RAW_BASE = 'https://raw.githubusercontent.com/OpenITI';
const PLACEHOLDERS = ['Fulān', 'Muʾallif', 'permalink', 'URIs from', 'YEAR-MON', 'src@', 'comma separated',
  'a free running comment', 'URI of a book'];
const BAD_URI = 'OpenITIのバージョンURI（例：1014IbnMaryamTilimsani.Bustan.Kraken22021817402301-ara1）として読めません';

// Python の str.strip() / \s と同じ空白（JS の \s とは ﻿・\x1c-\x1f・\x85 が違う）
const WS = '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const STRIP_RE = new RegExp(`^[${WS}]+|[${WS}]+$`, 'g');
const pyStrip = s => s.replace(STRIP_RE, '');
const stripChars = (s, c) => s.replace(new RegExp(`^${c}+|${c}+$`, 'g'), '');

// Python の int() は Unicode の十進数字も読む
const digitValue = ch => {
  let cp = ch.codePointAt(0);
  const at = c => /^\p{Nd}$/u.test(String.fromCodePoint(c));
  let start = cp;
  while (start > 0 && at(start - 1)) start--;
  return (cp - start) % 10;
};
const pyInt = v => {
  if (typeof v === 'number') return Math.trunc(v);
  const m = new RegExp(`^[${WS}]*([+-]?)(\\p{Nd}+)[${WS}]*$`, 'u').exec(String(v));
  if (!m) throw new Error(`invalid literal for int(): ${JSON.stringify(v)}`);
  let n = 0;
  for (const ch of m[2]) n = n * 10 + digitValue(ch);
  return m[1] === '-' ? -n : n;
};

const repoFor = deathYear => `${Math.ceil(pyInt(deathYear) / 25) * 25}`.padStart(4, '0') + 'AH';

const parseUrl = url => {
  let rest = url.replace(/[\t\r\n]/g, '');
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(rest);
  if (m) rest = rest.slice(m[0].length);
  let netloc = '';
  if (rest.startsWith('//')) {
    const e = rest.slice(2).search(/[/?#]/);
    netloc = e < 0 ? rest.slice(2) : rest.slice(2, 2 + e);
    rest = e < 0 ? '' : rest.slice(2 + e);
  }
  return {netloc, path: rest.split('#')[0].split('?')[0]};
};

// urllib.parse.unquote：不正な UTF-8 は U+FFFD にする
const unquote = s => s.replace(/(?:%[0-9A-Fa-f]{2})+/g, run =>
  new TextDecoder('utf-8', {ignoreBOM: true}).decode(Uint8Array.from(run.slice(1).split('%'), h => parseInt(h, 16))));

const lastSegment = s => s.slice(s.lastIndexOf('/') + 1);
const dirname = s => { const i = s.lastIndexOf('/'); return i < 0 ? s : s.slice(0, i); };

const resolve = ref => {
  ref = pyStrip(ref);
  if (ref.startsWith('http')) {
    const u = parseUrl(ref);
    if (u.netloc === 'github.com') {
      const parts = stripChars(u.path, '/').split('/');
      if (parts.length > 4 && (parts[2] === 'blob' || parts[2] === 'raw'))
        ref = `https://raw.githubusercontent.com/${parts[0]}/${parts[1]}/${parts.slice(3).join('/')}`;
    } else if (u.netloc !== 'raw.githubusercontent.com') {
      throw new Error('GitHub上のOpenITIファイルのURLを指定してください');
    }
    let uri = unquote(lastSegment(ref.replace(/\/+$/, '')));
    uri = uri.replace(/\.(mARkdown|completed|inProgress)(?=\n?$)/, '');
    return [ref, uri];
  }
  const m = URI_RE.exec(ref);
  if (!m) throw new Error(BAD_URI);
  const [, year, name, book] = m;
  const author = `${year}${name}`;
  const uri = ref.split('.mARkdown')[0].split('.completed')[0].split('.inProgress')[0];
  return [`${RAW_BASE}/${repoFor(year)}/master/data/${author}/${author}.${book}/${ref}`, uri];
};

const ymlUrls = (rawUrl, uri) => {
  const base = dirname(rawUrl);
  const m = URI_RE.exec(uri);
  if (!m) return {version: `${base}/${uri}.yml`};
  const author = `${m[1]}${m[2]}`;
  return {version: `${base}/${uri}.yml`, book: `${base}/${author}.${m[3]}.yml`, author: `${dirname(base)}/${author}.yml`};
};

// str.splitlines()
const splitLines = s => {
  const lines = s.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
};

const YML_LINE = new RegExp(`^\\p{Nd}+#([\\p{L}\\p{N}_#]+?)#*:[${WS}]?(.*)$`, 'u');

const parseYml = text => {
  const out = {};
  let key = null;
  for (const line of splitLines(text)) {
    const m = YML_LINE.exec(line);
    if (m) {
      key = m[1];
      out[key] = pyStrip(m[2]);
    } else if (key && (line.startsWith(' ') || line.startsWith('\t'))) {
      out[key] = pyStrip(out[key] + '\n' + pyStrip(line));
    }
  }
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v && !PLACEHOLDERS.some(p => v.includes(p))));
};

// text[:20000]（Python は code point 単位）
const firstCodePoints = (s, n) => {
  let i = 0;
  for (let c = 0; i < s.length && c < n; c++) i += s.codePointAt(i) > 0xffff ? 2 : 1;
  return s.slice(0, i);
};

const headerMeta = (text, field) => {
  const re = new RegExp(`(?<![^\\n])#META#[${WS}]*[\\p{Nd}.]*[${WS}]*${field}[${WS}]*::[${WS}]*([^\\n]+)(?![^\\n])`, 'u');
  const m = re.exec(firstCodePoints(text, 20000));
  const v = m ? pyStrip(m[1]) : '';
  return v && v !== 'NODATA' ? v : '';
};

const camelWords = s => s.replace(/(?<=[a-z])(?=[A-Z])/g, ' ');

const fetchText = async (ref, fetchImpl = (...a) => fetch(...a)) => {
  const get = async url => {
    const r = await fetchImpl(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${url}`);
    return r.text();
  };
  const [rawUrl, uri] = resolve(ref);
  const text = await get(rawUrl);
  const meta = {};
  for (const [kind, url] of Object.entries(ymlUrls(rawUrl, uri))) {
    try { meta[kind] = parseYml(await get(url)); } catch { meta[kind] = {}; }
  }
  return {uri, raw_url: rawUrl, text, meta};
};

const split = text => {
  const found = text.indexOf(HEADER_END);
  const cut = found >= 0 ? found + HEADER_END.length : 0;
  const header = text.substring(0, cut), body = text.substring(cut);
  const pages = [];
  let pos = 0;
  for (const m of body.matchAll(PAGE_RE)) {
    pages.push({vol: pyInt(m[1]), page: pyInt(m[2]), marker: m[0], text: body.substring(pos, m.index)});
    pos = m.index + m[0].length;
  }
  let tail = body.substring(pos);
  if (pages.length && pyStrip(tail)) {
    pages.push({vol: null, page: null, marker: '', text: tail, unassigned: true});
    tail = '';
  }
  return {header, pages, tail};
};

const join = (parts, edits) => {
  edits = edits || {};
  const out = [parts.header];
  parts.pages.forEach((pg, i) => {
    out.push(Object.hasOwn(edits, String(i)) ? edits[String(i)] : pg.text);
    out.push(pg.marker);
  });
  out.push(parts.tail);
  return out.join('');
};

const titleOf = (meta, text = '', uri = '') => {
  const book = meta.book || {};
  const m = URI_RE.exec(uri);
  return book['BOOK#TITLEA#AR'] || book['BOOK#TITLEB#AR'] || headerMeta(text, 'BookTITLE') || (m ? camelWords(m[3]) : '');
};

const authorOf = (meta, text = '', uri = '') => {
  const a = meta.author || {};
  const m = URI_RE.exec(uri);
  return a['AUTH#SHUHRA#AR'] || a['AUTH#ISM#AR'] || headerMeta(text, 'AuthorNAME') || (m ? camelWords(m[2]) : '');
};

const scanLinks = meta => {
  const found = [];
  for (const d of Object.values(meta))
    for (const v of Object.values(d))
      for (const m of v.matchAll(/archive\.org\/(?:details|download)\/([A-Za-z0-9._-]+)/g))
        if (!found.includes(m[1])) found.push(m[1]);
  return found;
};

if (typeof module !== 'undefined') module.exports = {HEADER_END, PAGE_RE, URI_RE, RAW_BASE, PLACEHOLDERS, repoFor, resolve, ymlUrls,
  parseYml, headerMeta, camelWords, fetchText, split, join, titleOf, authorOf, scanLinks, pyStrip, pyInt};
