const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
globalThis.OpenITI = require('../proofreader/static/local/openiti.js');
const Draft = require('../proofreader/static/local/draft.js');

const dir = path.join(__dirname, 'fixtures', 'draft');
const inputs = JSON.parse(fs.readFileSync(path.join(dir, 'inputs.json'), 'utf8'));
const expected = JSON.parse(fs.readFileSync(path.join(dir, 'expected.json'), 'utf8'));

test('draft.js matches the output of importers/draft.py for every shared fixture', () => {
  for (const c of inputs) {
    const want = expected[c.name];
    if (want.error) { assert.throws(() => Draft.build(c.metadata), c.name); continue; }
    const [fetched, details] = Draft.build(c.metadata);
    assert.match(fetched.uri, /^local-[0-9a-f]{12}$/, c.name);
    assert.deepEqual({fetched: {...fetched, uri: 'local-XXXXXXXXXXXX'}, details}, want, c.name);
  }
});

test('the placeholder URI differs between calls', () => {
  assert.notEqual(Draft.build({title: 'T', count: 1})[0].uri, Draft.build({title: 'T', count: 1})[0].uri);
});
