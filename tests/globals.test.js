const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..', 'proofreader', 'static');
const js = dir => fs.readdirSync(path.join(root, dir)).filter(f => f.endsWith('.js')).sort().map(f => path.join(dir, f));
// index.html の <script> の順に読み込む
const files = [...fs.readFileSync(path.join(root, 'index.html'), 'utf8').matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);

test('index.html loads every static script exactly once, with relative paths', () => {
  assert.deepEqual([...files].sort(), [...js('.'), ...js('local')].sort().map(f => f.replace(/\\/g, '/')));
  assert.ok(files.every(f => !f.startsWith('/')));
  assert.equal(files[0], 'mode.js');
  assert.ok(files.indexOf('backend.js') < files.indexOf('app.js'));
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
  assert.equal(typeof vm.runInContext('Bundle.parse', ctx), 'function');
  assert.equal(typeof vm.runInContext('TEI.export', ctx), 'function');
  assert.equal(typeof vm.runInContext('Draft.build', ctx), 'function');
  assert.equal(typeof vm.runInContext('LocalStore.savePage', ctx), 'function');
  assert.equal(typeof vm.runInContext('LocalStore.importBundle', ctx), 'function');
  assert.equal(typeof vm.runInContext('LocalRouter.handle', ctx), 'function');
  assert.equal(typeof vm.runInContext('LocalRouter.revokeUrls', ctx), 'function');
  assert.equal(vm.runInContext('PROOF_MODE', ctx), 'browser');
});
