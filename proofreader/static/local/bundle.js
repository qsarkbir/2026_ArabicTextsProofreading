// bundle.py の移植。プロジェクトのバックアップ（<slug>.proofreader.json）を作る・検証する純粋な関数。
const Bundle = (() => {
  const FORMAT = 'openiti-proofreader-project';
  const FORMAT_VERSION = 1;
  const SCHEMA_VERSION = 2; // project.json と work.json の版
  const APP_VERSION = '0.1.0';
  const NEWER = '新しい版のアプリで作られたデータです。アプリを更新してから読み込んでください';
  const NOT_BUNDLE = 'このファイルは校正プロジェクトのバックアップではありません';
  const INDEX = /^(0|[1-9][0-9]*)$/;
  const err = message => new Work.ApiError(message, 400);
  const isInt = v => Number.isSafeInteger(v); // bundle.py と同じ。1.0 も整数として読む（Python 側は整数に直す）
  const isDict = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const isStr = v => typeof v === 'string';
  const has = (o, k) => Object.hasOwn(o, k);
  const status = e => ({...(e.done ? {done: true} : {}), ...(e.note ? {note: e.note} : {})});

  const build = ({project, original, records, mode = 'browser', now = new Date()}) => ({
    format: FORMAT, format_version: FORMAT_VERSION,
    exported: now.toISOString().slice(0, 19) + 'Z',
    app: {mode, version: APP_VERSION},
    project, original, work: Work.recordsToWork(records),
  });

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
      if (!isDict(v) || !(v.note == null || isStr(v.note))) throw err('作業データの注記が正しくありません');
      const s = status(v);
      if (Object.keys(s).length) out.status[k] = s;
    }
    for (const [k, v] of Object.entries(table(work, 'history', n))) {
      if (!Array.isArray(v)) throw err('作業データの履歴が正しくありません');
      const entries = v.map(e => {
        if (!(isDict(e) && isStr(e.text) && isInt(e.revision) && e.revision >= 0 && isStr(e.time) && (e.note == null || isStr(e.note))))
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

  // 検証して {project, text, work} を返す。拒否するときは status 400 のエラー（メッセージは利用者向け）
  const parse = data => {
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
    const out = {project: cleanProject(project), text, work: cleanWork(work, parts.pages)};
    if (loneSurrogate(out)) throw err('バックアップに不正な文字（対になっていないサロゲート）が含まれています');
    return out;
  };

  return {FORMAT, FORMAT_VERSION, SCHEMA_VERSION, APP_VERSION, build, parse};
})();

if (typeof module !== 'undefined') module.exports = Bundle;
