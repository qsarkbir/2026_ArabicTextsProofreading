const {test} = require('node:test');
const assert = require('node:assert/strict');
const w = require('../proofreader/static/local/work.js');

const ORIGINAL = '# alpha beta\n';
const T0 = Date.UTC(2026, 10, 16, 0, 0, 0);
const save = (record, change, now = T0, opts) => w.applyUpdate(record, ORIGINAL, change, now, opts);

test('constants match store.py', () => {
  assert.equal(w.HISTORY_WINDOW, 300);
  assert.equal(w.HISTORY_LIMIT, 100);
});

test('stale revision is a 409 and the first edit is preserved', () => {
  const r = save(undefined, {text: 'ALPHA beta', revision: 0});
  assert.throws(() => save(r, {text: 'alpha BETA', revision: 0}), e => e instanceof w.Conflict && e.status === 409 && /別のタブ/.test(e.message));
  assert.equal(r.text, 'ALPHA beta');
});

test('missing or non-integer revision is a 428', () => {
  for (const revision of [undefined, null, '0', 1.5, true])
    assert.throws(() => save(undefined, {text: 'x', revision}), e => e.status === 428 && /保存元の版がありません/.test(e.message));
});

test('input is not mutated and first save adds revision and history', () => {
  const rec = Object.freeze({done: false, note: '', revision: 0, history: Object.freeze([])});
  const r = save(rec, {text: 'changed', revision: 0});
  assert.equal(r.revision, 1);
  assert.deepEqual(r.history.map(e => [e.text, e.revision]), [[ORIGINAL, 0]]);
  assert.match(r.history[0].time, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.equal(r.history[0].time, '2026-11-16T00:00:00Z');
});

test('autosaves share one history entry until the window or a checkpoint', () => {
  let r;
  ['one', 'two', 'three'].forEach((text, n) => { r = save(r, {text, revision: n}, T0 + n * 1000); });
  assert.deepEqual(r.history.map(e => e.text), [ORIGINAL]);
  r = save(r, {text: 'restored', revision: 3, checkpoint: true}, T0 + 4000);
  assert.deepEqual(r.history.map(e => e.text), [ORIGINAL, 'three']);
  r = save(r, {text: 'later', revision: 4}, T0 + 5000, {window: 0});
  assert.equal(r.history.at(-1).text, 'restored');
  assert.equal(r.revision, 5);
  r = save(r, {text: 'after window', revision: 5}, T0 + 5000 + w.HISTORY_WINDOW * 1000);
  assert.equal(r.history.at(-1).text, 'later');
});

test('history is capped per page', () => {
  let r;
  for (let n = 0; n < 6; n++) r = save(r, {text: `v${n}`, revision: n}, T0, {window: 0, limit: 3});
  assert.deepEqual(r.history.map(e => e.text), ['v2', 'v3', 'v4']);
});

test('changing text resets done unless done is given', () => {
  let r = save(undefined, {done: true, revision: 0});
  assert.equal(r.done, true);
  r = save(r, {text: 'edit', revision: 1});
  assert.equal(r.done, false);
  r = save(r, {done: true, revision: 2});
  r = save(r, {text: 'edit 2', done: true, revision: 3});
  assert.equal(r.done, true);
});

test('a record with no done and no note has only its text', () => {
  let r = save(undefined, {done: true, note: 'check', revision: 0});
  r = save(r, {done: false, note: '', revision: 1});
  assert.deepEqual(w.recordsToWork({0: r}).status, {});
  assert.equal(r.note, '');
});

test('text equal to the original removes the edit', () => {
  let r = save(undefined, {text: 'changed', revision: 0});
  assert.equal(r.text, 'changed');
  r = save(r, {text: ORIGINAL, revision: 1});
  assert.equal('text' in r, false);
  assert.deepEqual(w.recordsToWork({0: r}).edits, {});
});

test('a save that changes nothing keeps the revision and history', () => {
  const r = save(undefined, {text: 'x', revision: 0});
  const same = save(r, {text: 'x', revision: 1});
  assert.equal(same.revision, 1);
  assert.equal(same.history.length, 1);
});

test('a malformed history time does not merge entries', () => {
  let r = save(undefined, {text: 'a', revision: 0});
  r = {...r, history: [{...r.history[0], time: 'bad'}]};
  r = save(r, {text: 'b', revision: 1}, T0 + 1000);
  assert.equal(r.history.length, 2);
});

test('records and work.json convert both ways', () => {
  const work = {
    edits: {0: 'e0', 3: 'e3'},
    status: {0: {done: true}, 2: {note: 'n'}},
    history: {0: [{text: ORIGINAL, revision: 0, time: '2026-11-16T00:00:00Z'}]},
    revisions: {0: 2, 3: 1},
    schema_version: 2,
  };
  const records = w.workToRecords(work);
  assert.deepEqual(Object.keys(records).sort(), ['0', '2', '3']);
  assert.equal(records[2].revision, 0);
  assert.equal('text' in records[2], false);
  assert.deepEqual(w.recordsToWork(records), work);
  assert.deepEqual(w.workToRecords(w.recordsToWork(records)), records);
});

test('legacy work without revisions or history converts', () => {
  const records = w.workToRecords({edits: {1: 'x'}, status: {}});
  assert.deepEqual(records[1], {done: false, note: '', revision: 0, history: [], text: 'x'});
  assert.equal(w.recordsToWork(records).schema_version, 2);
});
