const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
globalThis.Work = require('../proofreader/static/local/work.js');
globalThis.OpenITI = require('../proofreader/static/local/openiti.js');
const Bundle = require('../proofreader/static/local/bundle.js');

const dir = path.join(__dirname, 'fixtures', 'bundle');
const read = name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
const cases = read('cases.json'), expected = read('expected.json');

test('parse accepts and refuses the shared cases exactly like bundle.py', () => {
  assert.equal(cases.length, Object.keys(expected).length);
  for (const c of cases) {
    const want = expected[c.name];
    if (want.error) assert.throws(() => Bundle.parse(c.bundle), e => e.status === 400 && e.message === want.error, c.name);
    else assert.deepEqual(Bundle.parse(c.bundle), want, c.name);
  }
});

test('a stack overflow while checking a deeply nested backup is a 400, not a crash', () => {
  const data = JSON.parse(JSON.stringify(cases.find(c => c.name === 'minimal').bundle));
  let deep = [];
  for (let i = 0; i < 200000; i++) deep = [deep];
  data.project.meta = {deep};
  assert.throws(() => Bundle.parse(data), e => e.status === 400);
});

test('newer versions are refused with the documented message', () => {
  for (const name of ['format-version-newer', 'project-schema-newer', 'work-schema-newer'])
    assert.throws(() => Bundle.parse(cases.find(c => c.name === name).bundle), e => e.status === 400 && e.message.includes('新しい版のアプリで作られたデータです'), name);
});

const byPage = ocr => Object.fromEntries(Object.entries(ocr).map(([k, page]) => [k, Bundle.readingsOf(page)]));

test('a bundle exported by Python is read and written back without changing the original or the work', () => {
  const data = read('python-export.proofreader.json');
  const parsed = Bundle.parse(data);
  assert.equal(parsed.text, data.original);
  assert.ok(parsed.text.startsWith('﻿') && parsed.text.includes('\r\n'));
  assert.deepEqual(parsed.work, data.work);
  const records = Work.workToRecords(parsed.work);
  const again = Bundle.build({project: {...parsed.project, slug: 'x'}, original: parsed.text, records, ocr: byPage(parsed.ocr), now: new Date('2026-11-16T00:00:00Z')});
  assert.equal(again.exported, data.exported);
  assert.deepEqual(again.app, {mode: 'browser', version: Bundle.APP_VERSION});
  assert.equal(again.original, data.original);
  assert.deepEqual(again.work, data.work);
  assert.deepEqual(Bundle.parse(again), parsed);
});

test('the OCR readings of a Python export are read, written back identically, and make the file format_version 2', () => {
  const data = read('python-export.proofreader.json');
  assert.equal(data.format_version, 2);
  const parsed = Bundle.parse(data);
  assert.deepEqual(parsed.ocr, data.ocr);
  const store = byPage(parsed.ocr);
  assert.deepEqual(Object.keys(store), ['0', '1']);
  assert.equal(store[0].length, 2);  // current is one of the history readings: not stored twice
  const again = Bundle.build({project: {...parsed.project, slug: 'x'}, original: parsed.text, records: Work.workToRecords(parsed.work), ocr: store, now: new Date('2026-11-16T00:00:00Z')});
  assert.equal(again.format_version, 2);
  assert.deepEqual(again.ocr, data.ocr);
  assert.deepEqual(Bundle.parse(again), parsed);
});

test('a backup without readings is format_version 1 and has no ocr key; invalid stored readings are left out, not exported', () => {
  const none = Bundle.build({project: {uri: 'u'}, original: '# a PageV01P001\n', records: {}, ocr: {}});
  assert.equal(none.format_version, 1);
  assert.ok(!('ocr' in none));
  const good = {text: 'a', reading_id: 'r1', time: '2026-11-16T00:00:00Z', image_key: 'k', usage: {input: 1, output: 2}};
  const bad = [{text: 5, reading_id: 'r2'}, {text: 'x', reading_id: '../x'}, {text: 'x'}, {text: 'x', reading_id: 'R1', time: '2026-11-17T00:00:00Z'}];
  const out = Bundle.build({project: {uri: 'u'}, original: '# a PageV01P001\n', records: {}, ocr: {0: [good, ...bad], 1: [bad[0]]}});
  assert.equal(out.format_version, 2);
  assert.deepEqual(Object.keys(out.ocr), ['0']);
  assert.deepEqual(out.ocr[0].history, [good]);
  assert.deepEqual(Bundle.parse(out).ocr, out.ocr);
});

test('ocrPages picks the latest reading as current; readingsOf keeps a legacy current without an id', () => {
  const a = {text: 'a', reading_id: 'a', time: '2026-11-16T00:00:01Z'}, b = {text: 'b', reading_id: 'b', time: '2026-11-16T00:00:01Z'}, c = {text: 'c', reading_id: 'c', time: '2026-11-16T00:00:00Z'};
  const pages = Bundle.ocrPages({3: [b, c, a]});
  assert.deepEqual(pages[3].history.map(r => r.reading_id), ['c', 'a', 'b']);
  assert.equal(pages[3].current.reading_id, 'b');
  assert.deepEqual(Bundle.readingsOf({current: {text: 'old'}, history: [a]}).map(r => r.reading_id), ['a', 'legacy']);
  assert.deepEqual(Bundle.readingsOf({current: a, history: [a, c]}).map(r => r.reading_id), ['a', 'c']);
});

test('the original text round-trips byte for byte (BOM, CRLF, CR)', () => {
  for (const bom of ['', '﻿']) for (const nl of ['\n', '\r\n', '\r']) {
    const text = bom + ['#META#Header#End#', '# a PageV01P001', '# b PageV01P002', 'tail', ''].join(nl);
    const b = Bundle.build({project: {uri: 'u'}, original: text, records: {}});
    const parsed = Bundle.parse(JSON.parse(JSON.stringify(b)));
    assert.equal(parsed.text, text);
    assert.equal(OpenITI.join(OpenITI.split(parsed.text)), text);
  }
});
