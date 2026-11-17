// bundle.py の移植。プロジェクトのバックアップ（<slug>.proofreader.json）を作る・検証する純粋な関数。
const Bundle = (() => {
  const FORMAT = 'openiti-proofreader-project';
  const FORMAT_VERSION = 2; // このアプリが読み書きできる最新。OCR の読み取り結果が無いバックアップは BASE_VERSION で書く
  const BASE_VERSION = 1;
  const SCHEMA_VERSION = 2; // project.json と work.json の版
  const APP_VERSION = '0.1.0';
  const NEWER = '新しい版のアプリで作られたデータです。アプリを更新してから読み込んでください';
  const NOT_BUNDLE = 'このファイルは校正プロジェクトのバックアップではありません';
  const INDEX = /^(0|[1-9][0-9]*)$/;
  const RESERVED_NAME = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i; // Windows の装置名はファイル名にできない
  const READING_ID = /^[A-Za-z0-9_-]{1,64}$/; // ローカル版では ocr/history/<i>/ のファイル名にもなる
  const READING_TIME = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;
  const BAD_OCR = 'バックアップのOCRが正しくありません';
  const BAD_READING = 'バックアップのOCRの読み取り結果が正しくありません';
  const err = message => new Work.ApiError(message, 400);
  const isInt = v => Number.isSafeInteger(v); // bundle.py と同じ。1.0 も整数として読む（Python 側は整数に直す）
  const isDict = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const isStr = v => typeof v === 'string';
  const isFlag = v => v == null || typeof v === 'boolean';
  const has = (o, k) => Object.hasOwn(o, k);
  const status = e => ({...(e.done ? {done: true} : {}), ...(e.note ? {note: e.note} : {})});

  // ocr: {ページ番号: [読み取り結果…]}（LocalStore の ocr ストアの中身）。OCR があれば format_version 2
  const build = ({project, original, records, ocr, mode = 'browser', now = new Date()}) => {
    const pages = ocrOut(ocrPages(ocr || {}));
    return {
      format: FORMAT, format_version: Object.keys(pages).length ? FORMAT_VERSION : BASE_VERSION,
      exported: now.toISOString().slice(0, 19) + 'Z',
      app: {mode, version: APP_VERSION},
      project, original, work: Work.recordsToWork(records),
      ...(Object.keys(pages).length ? {ocr: pages} : {}),
    };
  };

  const version = (obj, what) => {
    const v = obj.schema_version;
    if (v === undefined || v === null) return;
    if (!isInt(v) || v < 1) throw err(`${what}の版番号が正しくありません`);
    if (v > SCHEMA_VERSION) throw err(NEWER);
  };

  const isPage = c => isDict(c) && isStr(c.service) && (isStr(c.label) || isInt(c.label)) && ['w', 'h'].every(k => c[k] == null || isInt(c[k]));
  const isSource = v => {
    if (v === null) return true;
    if (!isDict(v) || !['ia', 'pdf'].includes(v.type) || !['revision', 'pdf_file', 'title'].every(k => !has(v, k) || isStr(v[k]))) return false;
    if (v.type === 'ia') return isStr(v.id) && Array.isArray(v.pages) && v.pages.every(isPage);
    return isStr(v.file) && isInt(v.count);
  };

  const PROJECT_FIELDS = [ // key, default, check
    ['raw_url', () => '', isStr], ['title', () => '', isStr], ['author', () => '', isStr],
    ['meta', () => ({}), isDict], ['candidates', () => [], v => Array.isArray(v) && v.every(isStr)], ['offset', () => 0, isInt],
    ['anchors', () => [], v => Array.isArray(v) && v.every(a => Array.isArray(a) && a.length === 2 && a.every(isInt))],
    ['source', () => null, isSource],
    ['bibliography', null, v => isDict(v) && Object.values(v).every(isStr)],
  ];

  const cleanProject = project => {
    if (!isStr(project.uri) || !project.uri) throw err('プロジェクトのURIがありません');
    if (has(project, 'created') && !isStr(project.created)) throw err('プロジェクト情報の「created」が正しくありません');
    const out = {...project};
    delete out.slug;
    for (const [key, def, ok] of PROJECT_FIELDS) {
      if (has(out, key) && !ok(out[key])) throw err(`プロジェクト情報の「${key}」が正しくありません`);
      if (!has(out, key) && def) out[key] = def();
    }
    out.schema_version = SCHEMA_VERSION;
    return out;
  };

  const nonNegInt = v => isInt(v) && v >= 0;
  // bundle.py の _reading：読み取り結果の既知の項目だけを、型を確かめて取り出す。履歴の読みには reading_id が要る
  const cleanReading = (r, history = false) => {
    if (!isDict(r) || !isStr(r.text)) throw err(BAD_READING);
    const out = {text: r.text};
    for (const k of ['model', 'provider', 'requested_model', 'prompt_version', 'image_key']) {
      if (!has(r, k)) continue;
      if (!isStr(r[k])) throw err(BAD_READING);
      out[k] = r[k];
    }
    if (has(r, 'truncated')) {
      if (typeof r.truncated !== 'boolean') throw err(BAD_READING);
      out.truncated = r.truncated;
    }
    if (has(r, 'usage')) {
      const u = r.usage;
      if (!(isDict(u) && nonNegInt(u.input) && nonNegInt(u.output))) throw err(BAD_READING);
      out.usage = {input: u.input, output: u.output};
    }
    if (has(r, 'image_index')) {
      if (!isInt(r.image_index)) throw err(BAD_READING);
      out.image_index = r.image_index;
    }
    if (has(r, 'reading_id')) {
      if (!(isStr(r.reading_id) && READING_ID.test(r.reading_id) && !RESERVED_NAME.test(r.reading_id))) throw err(BAD_READING);
      out.reading_id = r.reading_id;
    } else if (history) throw err(BAD_READING);
    if (has(r, 'time')) {
      if (!(isStr(r.time) && READING_TIME.test(r.time))) throw err(BAD_READING);
      out.time = r.time;
    }
    return out;
  };

  const cleanOcrPage = entry => {
    if (!isDict(entry) || (has(entry, 'history') && !Array.isArray(entry.history)) || (entry.current != null && !isDict(entry.current))) throw err(BAD_OCR);
    const history = (entry.history || []).map(r => cleanReading(r, true));
    const ids = history.map(r => r.reading_id.toLowerCase()); // ファイル名：大文字小文字を区別しないファイルシステムでは同じになる
    if (new Set(ids).size !== ids.length) throw err('バックアップのOCRに、同じ読み取りの識別子（reading_id）が重複しています');
    const current = entry.current != null ? cleanReading(entry.current) : null;
    return {...(current ? {current} : {}), history};
  };

  // 検証して {ページ番号: {current?, history}}。読み取り結果の無いページは捨てる
  const cleanOcr = (ocr, n) => {
    if (!isDict(ocr)) throw err(BAD_OCR);
    const out = {};
    for (const [k, entry] of Object.entries(ocr)) {
      if (!INDEX.test(k) || Number(k) >= n) throw err(`バックアップのOCRのページ番号が範囲外です：${k}`);
      const page = cleanOcrPage(entry);
      if (page.current || page.history.length) out[k] = page;
    }
    return out;
  };

  // 書き出し用：検証を通らない読み（このアプリは作らない）は外し、バックアップが読めなくならないようにする
  const ocrOut = ocr => {
    const out = {};
    for (const [k, entry] of Object.entries(ocr)) {
      const history = [], seen = new Set();
      for (const r of entry.history || []) {
        let c;
        try { c = cleanReading(r, true); } catch { continue; }
        if (!seen.has(c.reading_id.toLowerCase())) { seen.add(c.reading_id.toLowerCase()); history.push(c); }
      }
      let current = null;
      try { current = entry.current ? cleanReading(entry.current) : null; } catch { /* 外す */ }
      if (current || history.length) out[k] = {...(current ? {current} : {}), history};
    }
    return out;
  };

  const byTime = (a, b) => ((a.time || '') < (b.time || '') ? -1 : (a.time || '') > (b.time || '') ? 1 : a.reading_id < b.reading_id ? -1 : a.reading_id > b.reading_id ? 1 : 0);
  // LocalStore の ocr ストア（ページごとの読みの配列）から書き出し用のページ表へ。current は最新（時刻・reading_id の順）の1件、history は全部（古い順）
  const ocrPages = byPage => {
    const out = {};
    for (const [k, list] of Object.entries(byPage)) {
      const history = [...list].sort(byTime);
      if (history.length) out[k] = {current: history[history.length - 1], history};
    }
    return out;
  };

  // 読み込み側：ocr（parse の結果）のページを、ストアに書く読みの一覧にする。current が履歴に無ければ足す（識別子が無い旧形式は、履歴と重ならない legacy・legacy_2…）
  const readingsOf = page => {
    const list = [...page.history], ids = new Set(list.map(r => r.reading_id.toLowerCase()));
    const c = page.current;
    if (c && !(c.reading_id !== undefined && ids.has(c.reading_id.toLowerCase()))) {
      let id = c.reading_id, n = 1;
      if (id === undefined) for (id = 'legacy'; ids.has(id); id = `legacy_${++n}`);
      list.push({...c, reading_id: id});
    }
    return list;
  };

  const table = (work, name, n) => {
    const t = has(work, name) ? work[name] : {};
    if (!isDict(t)) throw err(`作業データの「${name}」が正しくありません`);
    for (const k of Object.keys(t)) if (!INDEX.test(k) || Number(k) >= n) throw err(`作業データのページ番号が範囲外です：${k}`);
    return t;
  };

  const cleanWork = (work, pages) => {
    const n = pages.length, out = {edits: {}, status: {}, history: {}, revisions: {}, schema_version: SCHEMA_VERSION};
    for (const [k, v] of Object.entries(table(work, 'edits', n))) {
      if (!isStr(v)) throw err('作業データの修正本文が文字列ではありません');
      if (v !== pages[Number(k)].text) out.edits[k] = v;
    }
    for (const [k, v] of Object.entries(table(work, 'status', n))) {
      if (!isDict(v) || !(v.note == null || isStr(v.note)) || !isFlag(v.done)) throw err('作業データの注記が正しくありません');
      const s = status(v);
      if (Object.keys(s).length) out.status[k] = s;
    }
    for (const [k, v] of Object.entries(table(work, 'history', n))) {
      if (!Array.isArray(v)) throw err('作業データの履歴が正しくありません');
      const entries = v.map(e => {
        if (!(isDict(e) && isStr(e.text) && isInt(e.revision) && e.revision >= 0 && isStr(e.time) && (e.note == null || isStr(e.note)) && isFlag(e.done)))
          throw err('作業データの履歴が正しくありません');
        return {text: e.text, ...status(e), revision: e.revision, time: e.time};
      });
      if (entries.length) out.history[k] = entries.slice(-Work.HISTORY_LIMIT);
    }
    for (const [k, v] of Object.entries(table(work, 'revisions', n))) {
      if (!isInt(v) || v < 0) throw err('作業データのrevisionが正しくありません');
      if (v) out.revisions[k] = v;
    }
    return out;
  };

  const loneSurrogate = v => typeof v === 'string' ? /[\ud800-\udfff]/u.test(v)
    : Array.isArray(v) ? v.some(loneSurrogate) : isDict(v) ? Object.entries(v).some(([k, x]) => loneSurrogate(k) || loneSurrogate(x)) : false;

  // 検証して {project, text, work, ocr} を返す。拒否するときは status 400 のエラー（メッセージは利用者向け）
  const parse = data => {
    try { return parseData(data); }
    catch (e) { if (e instanceof RangeError) throw err('バックアップの入れ子が深すぎて読めません'); throw e; } // スタックの上限
  };

  const parseData = data => {
    if (!isDict(data) || data.format !== FORMAT) throw err(NOT_BUNDLE);
    const v = data.format_version;
    if (!isInt(v) || v < 1) throw err('バックアップの形式の版番号が正しくありません');
    if (v > FORMAT_VERSION) throw err(NEWER);
    const {project, work, original: text} = data;
    if (!isDict(project) || !isDict(work)) throw err('バックアップにプロジェクトまたは作業データがありません');
    version(project, 'プロジェクト');
    version(work, '作業データ');
    if (!isStr(text)) throw err('バックアップの原文が文字列ではありません');
    const parts = OpenITI.split(text);
    if (!parts.pages.length) throw err('ページ区切り（PageV..P..）がないテキストは校正できません');
    if (OpenITI.join(parts) !== text) throw err('バックアップの原文を分割して再結合すると一致しません。ファイルが壊れています');
    const out = {project: cleanProject(project), text, work: cleanWork(work, parts.pages), ocr: has(data, 'ocr') ? cleanOcr(data.ocr, parts.pages.length) : {}};
    if (loneSurrogate(out)) throw err('バックアップに不正な文字（対になっていないサロゲート）が含まれています');
    return out;
  };

  return {FORMAT, FORMAT_VERSION, BASE_VERSION, SCHEMA_VERSION, APP_VERSION, build, parse, ocrPages, readingsOf};
})();

if (typeof module !== 'undefined') module.exports = Bundle;
