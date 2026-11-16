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
