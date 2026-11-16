const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {inputs, run} = require('./tei_fixtures.js');

const expected = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'tei', 'expected.json'), 'utf8'));

test('tei.js matches the output of exporters/tei.py for every shared fixture', () => {
  for (const c of inputs) {
    const want = expected[c.name];
    if (want.error) assert.throws(() => run(c), e => e.message === want.error, c.name);
    else {
      const got = run(c);
      assert.equal(new TextDecoder().decode(got.data), want.xml, c.name);
      assert.deepEqual(got.warnings, want.warnings, c.name);
    }
  }
});

test('the XML declaration and encoding match ElementTree', () => {
  const got = new TextDecoder('utf-8', {ignoreBOM: true}).decode(run(inputs[0]).data);
  assert.ok(got.startsWith(`<?xml version='1.0' encoding='utf-8'?>\n<TEI xmlns="http://www.tei-c.org/ns/1.0">`));
  assert.ok(!got.endsWith('\n'));
});
