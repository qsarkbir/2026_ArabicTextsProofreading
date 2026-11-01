const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createSaver, insertWords} = require('../proofreader/static/core.js');

test('failed edits survive and newer fields win on retry', async () => {
  let fail = true;
  const sent = [];
  const saver = createSaver(async body => { sent.push(body); if (fail) throw Error('offline'); }, () => {});
  saver.save({text: 'first', note: 'keep'});
  await assert.rejects(saver.flush());
  assert.equal(saver.dirty(), true);
  saver.save({text: 'latest'});
  fail = false;
  await saver.flush();
  assert.deepEqual(sent[1], {text: 'latest', note: 'keep'});
  assert.equal(saver.dirty(), false);
});

test('navigation waits for in-flight and subsequently queued edits', async () => {
  const requests = [];
  const saver = createSaver(body => new Promise(resolve => requests.push({body, resolve})), () => {});
  saver.save({text: 'first'});
  const first = saver.flush();
  let finished = false;
  const navigation = saver.flush().then(() => { finished = true; });
  saver.save({text: 'second'});
  assert.equal(requests.length, 1);
  assert.equal(saver.dirty(), true);
  await Promise.resolve();
  assert.equal(finished, false);
  requests[0].resolve();
  await Promise.resolve();
  assert.equal(requests.length, 2);
  assert.equal(finished, false);
  requests[1].resolve();
  await Promise.all([first, navigation]);
  assert.equal(saver.dirty(), false);
  assert.deepEqual(requests.map(r => r.body.text), ['first', 'second']);
});

test('all waiting callers see save failure', async () => {
  let reject;
  const saver = createSaver(() => new Promise((_, ng) => { reject = ng; }), () => {});
  saver.save({text: 'keep'});
  const first = saver.flush(), second = saver.flush();
  reject(Error('offline'));
  const results = await Promise.allSettled([first, second]);
  assert.deepEqual(results.map(r => r.status), ['rejected', 'rejected']);
  assert.equal(saver.dirty(), true);
});

test('OCR insertions preserve word boundaries at both ends', () => {
  assert.equal(insertWords('alpha', 5, 'beta'), 'alpha beta');
  assert.equal(insertWords('beta', 0, 'alpha'), 'alpha beta');
  assert.equal(insertWords('alpha\nbeta', 6, 'extra'), 'alpha\nextra beta');
  assert.equal(insertWords('', 0, 'alpha'), 'alpha');
});
