const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createSaver, insertWords, insertMarkup} = require('../proofreader/static/core.js');

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

test('insertMarkup puts line-start tags on every touched line', () => {
  assert.deepEqual(insertMarkup('abc', 2, 2, '# '), {text: '# abc', start: 4, end: 4});
  assert.deepEqual(insertMarkup('a\nb\nc', 0, 3, '~~'), {text: '~~a\n~~b\nc', start: 2, end: 7});
  assert.equal(insertMarkup('a\nb\nc', 0, 2, '~~').text, '~~a\nb\nc');
  assert.equal(insertMarkup('# a\nb', 0, 5, '# ').text, '# a\n# b');
  assert.equal(insertMarkup('# a', 1, 1, '# ').text, '# a');
  assert.deepEqual(insertMarkup('', 0, 0, '### | '), {text: '### | ', start: 6, end: 6});
});

test('insertMarkup puts the EDITOR tag on its own line', () => {
  assert.equal(insertMarkup('abc\ndef', 5, 5, '### |EDITOR|').text, 'abc\n### |EDITOR|\ndef');
  assert.equal(insertMarkup('abc\n\ndef', 4, 4, '### |EDITOR|').text, 'abc\n### |EDITOR|\ndef');
  assert.equal(insertMarkup('### |EDITOR|\nx', 3, 3, '### |EDITOR|').text, '### |EDITOR|\nx');
});

test('insertMarkup spaces the inline tag without doubling', () => {
  assert.deepEqual(insertMarkup('a b', 1, 1, '%~%'), {text: 'a %~% b', start: 5, end: 5});
  assert.equal(insertMarkup('a b', 0, 1, '%~%').text, 'a %~% b');
  assert.equal(insertMarkup('a b', 2, 2, '%~%').text, 'a %~% b');
  assert.equal(insertMarkup('ab', 2, 2, '%~%').text, 'ab %~%');
  assert.equal(insertMarkup('a\nb', 2, 2, '%~%').text, 'a\n%~% b');
  assert.deepEqual(insertMarkup('', 0, 0, '%~%'), {text: '%~%', start: 3, end: 3});
});

test('insertMarkup replaces an existing heading prefix', () => {
  assert.equal(insertMarkup('### | x', 0, 0, '### || ').text, '### || x');
  assert.equal(insertMarkup('### $ x', 5, 5, '### @ ').text, '### @ x');
  assert.equal(insertMarkup('### |EDITOR|', 0, 0, '### | ').text, '### | ');
  assert.deepEqual(insertMarkup('### | x', 3, 3, '### | '), {text: '### | x', start: 3, end: 3});
  assert.equal(insertMarkup('### | x', 0, 0, '### |EDITOR|').text, '### |EDITOR|\n### | x');
  assert.equal(insertMarkup('a\n### | b', 0, 9, '### || ').text, '### || a\n### || b');
});

test('insertMarkup handles a leading empty line', () => {
  assert.equal(insertMarkup(String.fromCharCode(10) + 'a', 0, 0, '# ').text, '# ' + String.fromCharCode(10) + 'a');
});
