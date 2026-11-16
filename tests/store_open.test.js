const {test} = require('node:test');
const assert = require('node:assert/strict');
globalThis.Work = require('../proofreader/static/local/work.js');
globalThis.OpenITI = require('../proofreader/static/local/openiti.js');

test('a connection that opens after onblocked has rejected is closed, and the next open starts afresh', async () => {
  const requests = [];
  globalThis.indexedDB = {open: () => { const req = {}; requests.push(req); return req; }};
  const LocalStore = require('../proofreader/static/local/store.js');
  const first = LocalStore.getProject('x');
  first.catch(() => {});
  requests[0].onblocked();
  await assert.rejects(first, e => /ほかのタブ/.test(e.message));
  let closed = 0;
  requests[0].result = {close: () => { closed++; }};
  requests[0].onsuccess();
  assert.equal(closed, 1);
  LocalStore.getProject('x').catch(() => {});
  assert.equal(requests.length, 2);  // not served by the orphaned connection
});

test('callbacks of an older connection do not reset a newer open', async () => {
  delete require.cache[require.resolve('../proofreader/static/local/store.js')];
  const requests = [];
  globalThis.indexedDB = {open: () => { const req = {}; requests.push(req); return req; }};
  const LocalStore = require('../proofreader/static/local/store.js');
  const db1 = {close() {}};
  const first = LocalStore.getProject('x').catch(() => {});
  requests[0].result = db1;
  requests[0].onsuccess();
  await new Promise(r => setImmediate(r));
  db1.onclose();                                   // the browser closed it: the next call reopens
  LocalStore.getProject('x').catch(() => {});
  assert.equal(requests.length, 2);
  db1.onversionchange();                           // a late callback of the old connection
  requests[0].onblocked();                         // and of the old request
  LocalStore.getProject('x').catch(() => {});
  assert.equal(requests.length, 2);                // still the second open, not a third
});

// ---- run()：コミット時のエラー（トランザクションの onerror / onabort）----
const quota = () => Object.assign(new Error('quota'), {name: 'QuotaExceededError'});
// 偽の IndexedDB：get は project を返し、トランザクションは fn の後に script した結果（complete / error / abort）で終わる
const fakeIdb = outcome => {
  const calls = {put: [], abort: 0};
  delete require.cache[require.resolve('../proofreader/static/local/store.js')];
  globalThis.indexedDB = {open: () => {
    const req = {};
    setImmediate(() => {
      req.result = {transaction: () => {
        const tx = {error: null, abort() { calls.abort++; }};
        tx.objectStore = name => ({
          get: () => { const r = {}; setImmediate(() => { r.result = {slug: 's', source: {type: 'pdf', file: 'a.pdf', count: 1}}; r.onsuccess(); setImmediate(() => outcome(tx)); }); return r; },
          put: v => { calls.put.push([name, v]); },
        });
        return tx;
      }, close() {}};
      req.onsuccess();
    });
    return req;
  }};
  return {LocalStore: require('../proofreader/static/local/store.js'), calls};
};

test('a request error that surfaces only at commit (tx.onerror, error on the event target) rejects as 507 when it is a quota error', async () => {
  const {LocalStore, calls} = fakeIdb(tx => tx.onerror({target: {error: quota()}}));
  await assert.rejects(LocalStore.attachFile('s', 'a.pdf', new Blob(['%PDF']), {count: 2, revision: 'r'}), e => e.status === 507 && /保存容量が足りません/.test(e.message));
  assert.deepEqual(calls.put.map(c => c[0]), ['projects', 'files']);  // 書こうとしたが、コミットされなかった
});

test('an aborted transaction (tx.onabort with tx.error) rejects with that error; one without any error gets a generic message', async () => {
  let {LocalStore} = fakeIdb(tx => { tx.error = quota(); tx.onabort({target: tx}); });
  await assert.rejects(LocalStore.attachFile('s', 'a.pdf', new Blob(['%PDF'])), e => e.status === 507);
  ({LocalStore} = fakeIdb(tx => { tx.error = Object.assign(new Error('disk'), {name: 'UnknownError'}); tx.onabort({target: tx}); }));
  await assert.rejects(LocalStore.attachFile('s', 'a.pdf', new Blob(['%PDF'])), e => e.message === 'disk');
  ({LocalStore} = fakeIdb(tx => tx.onabort({})));
  await assert.rejects(LocalStore.attachFile('s', 'a.pdf', new Blob(['%PDF'])), e => e.message === '保存が中断されました');
  ({LocalStore} = fakeIdb(tx => tx.onerror({})));
  await assert.rejects(LocalStore.attachFile('s', 'a.pdf', new Blob(['%PDF'])), e => e.message === '保存に失敗しました');
});

test('a commit that completes resolves, and a synchronous quota error in fn aborts the transaction', async () => {
  let {LocalStore, calls} = fakeIdb(tx => tx.oncomplete());
  await LocalStore.attachFile('s', 'a.pdf', new Blob(['%PDF']));
  assert.equal(calls.put.length, 1);  // 同じ count なら project は書かない
  ({LocalStore, calls} = fakeIdb(() => {}));
  await assert.rejects(LocalStore.updateProject('s', () => { throw quota(); }), e => e.status === 507);
  assert.equal(calls.abort, 1);
});
