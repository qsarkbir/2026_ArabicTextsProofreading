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

test('a bundle exported by Python is read and written back without changing the original or the work', () => {
  const data = read('python-export.proofreader.json');
  const parsed = Bundle.parse(data);
  assert.equal(parsed.text, data.original);
  assert.ok(parsed.text.startsWith('﻿') && parsed.text.includes('\r\n'));
  assert.deepEqual(parsed.work, data.work);
  const records = Work.workToRecords(parsed.work);
  const again = Bundle.build({project: {...parsed.project, slug: 'x'}, original: parsed.text, records, now: new Date('2026-11-16T00:00:00Z')});
  assert.equal(again.exported, data.exported);
  assert.deepEqual(again.app, {mode: 'browser', version: Bundle.APP_VERSION});
  assert.equal(again.original, data.original);
  assert.deepEqual(again.work, data.work);
  assert.deepEqual(Bundle.parse(again), parsed);
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
