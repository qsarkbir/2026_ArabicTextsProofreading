// tei.js の出力を、tests/fixtures/tei の入力ごとに <dir>/<name>.xml へ書く（CI が tests.validate_tei でスキーマ検証する）。
// 使い方: node tests/tei_fixtures.js <dir>
const fs = require('node:fs');
const path = require('node:path');
const OpenITI = globalThis.OpenITI = require('../proofreader/static/local/openiti.js');
const TEI = globalThis.TEI = require('../proofreader/static/local/tei.js');

const inputs = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'tei', 'inputs.json'), 'utf8'));
const run = c => TEI.export(c.project, OpenITI.split(c.text), c.work);

if (require.main === module) {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: node tests/tei_fixtures.js <dir>'); process.exit(2); }
  fs.mkdirSync(dir, {recursive: true});
  let n = 0;
  for (const c of inputs) {
    try { fs.writeFileSync(path.join(dir, `${c.name}.xml`), run(c).data); n++; } catch { /* エラーになる入力は書かない */ }
  }
  console.log(`wrote ${n} TEI files to ${dir}`);
}

module.exports = {inputs, run};
