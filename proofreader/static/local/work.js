// store.update_page と store._record_history に相当する純粋な関数。1ページ1件の record を受け取り、新しい record を返す。
// record: {text?, done, note, revision, history[]}（text は原文と違うときだけ、revision が無ければ 0）
const HISTORY_WINDOW = 300; // 秒。この間の自動保存は履歴1件にまとめる
const HISTORY_LIMIT = 100;
const TIME_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;

class Conflict extends Error {
  constructor(message) { super(message); this.name = 'Conflict'; this.status = 409; }
}

class ApiError extends Error {
  constructor(message, status) { super(message); this.name = 'ApiError'; this.status = status; }
}

const timeString = ms => new Date(ms).toISOString().slice(0, 19) + 'Z';

const statusOf = r => ({...(r.done ? {done: true} : {}), ...(r.note ? {note: r.note} : {})});

const recordHistory = (entries, previous, revision, checkpoint, nowMs, opts = {}) => {
  const window = opts.window ?? HISTORY_WINDOW, limit = opts.limit ?? HISTORY_LIMIT;
  if (entries.length && !checkpoint) {
    const t = entries[entries.length - 1].time;
    const last = typeof t === 'string' && TIME_RE.test(t) ? Date.parse(t) / 1000 : null;
    const age = nowMs / 1000 - last;
    if (last !== null && age >= 0 && age < window) return entries;
  }
  const out = [...entries, {...previous, revision, time: timeString(nowMs)}];
  return limit > 0 ? out.slice(-limit) : [];
};

const applyUpdate = (record, original, change, now = Date.now(), opts = {}) => {
  if (!Number.isInteger(change.revision)) throw new ApiError('画面を再読み込みしてください（保存元の版がありません）', 428);
  if (['text', 'note'].some(k => change[k] != null && typeof change[k] !== 'string'))
    throw new ApiError('本文と注記は文字列で指定してください', 400);
  record = record || {};
  const rev = record.revision || 0;
  if (change.revision !== rev)
    throw new Conflict('別のタブで更新されています。未保存の本文をコピーしてから、最新のページを開き直してください');
  const nowMs = now instanceof Date ? now.getTime() : now;
  const previous = {text: record.text ?? original, ...statusOf(record)};
  const next = {done: !!record.done, note: record.note || ''};
  let text = record.text;
  if (change.text != null) text = change.text === original ? undefined : change.text;
  const changedText = change.text != null && change.text !== previous.text;
  if (changedText && next.done && change.done == null) next.done = false;
  if (change.done != null) next.done = !!change.done;
  if (change.note != null) next.note = change.note;
  const current = {text: text ?? original, ...statusOf(next)};
  const same = current.text === previous.text && !!current.done === !!previous.done && (current.note || '') === (previous.note || '');
  const out = {done: next.done, note: next.note, revision: rev, history: record.history || []};
  if (text !== undefined) out.text = text;
  if (same) return out;
  out.history = recordHistory(out.history, previous, rev, change.checkpoint === true, nowMs, opts);
  out.revision = rev + 1;
  return out;
};

// record の表 {"0": record, ...} と work.json の形を行き来する
const recordsToWork = records => {
  const work = {edits: {}, status: {}, history: {}, revisions: {}, schema_version: 2};
  for (const [key, r] of Object.entries(records)) {
    if (r.text !== undefined) work.edits[key] = r.text;
    const st = statusOf(r);
    if (Object.keys(st).length) work.status[key] = st;
    if (r.history && r.history.length) work.history[key] = r.history.map(e => ({...e}));
    if (r.revision) work.revisions[key] = r.revision;
  }
  return work;
};

const workToRecords = work => {
  const keys = new Set(['edits', 'status', 'history', 'revisions'].flatMap(k => Object.keys(work[k] || {})));
  const records = {};
  for (const key of keys) {
    const st = (work.status || {})[key] || {};
    const r = {done: !!st.done, note: st.note || '', revision: (work.revisions || {})[key] || 0,
      history: ((work.history || {})[key] || []).map(e => ({...e}))};
    if (work.edits && Object.hasOwn(work.edits, key)) r.text = work.edits[key];
    records[key] = r;
  }
  return records;
};

if (typeof module !== 'undefined') module.exports = {HISTORY_WINDOW, HISTORY_LIMIT, Conflict, ApiError, applyUpdate, recordHistory,
  recordsToWork, workToRecords};
