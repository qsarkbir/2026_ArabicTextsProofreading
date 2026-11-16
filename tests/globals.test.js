const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..', 'proofreader', 'static');
const js = dir => fs.readdirSync(path.join(root, dir)).filter(f => f.endsWith('.js')).sort().map(f => path.join(dir, f));
// index.html の読み込み順：core, compare, workflows, local/*, app
const files = [...['core.js', 'compare.js', 'workflows.js'], ...js('local'), 'app.js'];

test('every static script is accounted for', () => {
  assert.deepEqual([...js('.')].sort(), ['app.js', 'compare.js', 'core.js', 'workflows.js']);
});

test('top-level names do not collide across classic scripts', () => {
  const seen = new Map();
  const re = /^(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/gm;
  for (const f of files) {
    for (const [, name] of fs.readFileSync(path.join(root, f), 'utf8').matchAll(re)) {
      assert.ok(!seen.has(name), `${name} is declared in both ${seen.get(name)} and ${f}`);
      seen.set(name, f);
    }
  }
});

test('scripts load into one global scope without redeclaration errors', () => {
  const stub = () => new Proxy(function () {}, {get: (t, k) => (k === Symbol.toPrimitive ? () => '' : stub()), apply: () => stub(), construct: () => stub()});
  const ctx = vm.createContext({document: stub(), window: stub(), localStorage: stub(), navigator: stub(), location: stub(), console,
    setTimeout: () => 0, setInterval: () => 0, clearTimeout() {}, addEventListener() {}, fetch: stub(), TextDecoder, URL});
  for (const f of files) {
    try {
      vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), ctx, {filename: f});
    } catch (e) {
      // app.js は DOM を触るので実行時エラーは許す。再宣言（SyntaxError）だけを失敗にする
      assert.ok(!(e instanceof SyntaxError || e.name === 'SyntaxError'), `${f}: ${e.message}`);
    }
  }
  assert.equal(typeof vm.runInContext('OpenITI.split', ctx), 'function');
  assert.equal(typeof vm.runInContext('Work.applyUpdate', ctx), 'function');
});
