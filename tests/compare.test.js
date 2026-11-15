'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {textTokens, ocrTokens, diffBlocks, readingPatch, normWord} = require('../proofreader/static/compare.js');
const options = {ortho:true, punct:true, space:true};
function changes(text, reading, truncated = false) {
  const A = textTokens(text, options), B = ocrTokens(reading, options);
  return diffBlocks(A, B, options).map(block => readingPatch(text, A, B, block, truncated));
}
test('OCR replacement cannot delete verse or paragraph structure', () => {
  assert.deepEqual(changes('غلط %~% خطأ سليم', 'صحيح سليم'), [null]);
  assert.deepEqual(changes('# غلط\n~~ خطأ\n# سليم', 'صحيح سليم'), [null]);
  assert.deepEqual(changes('wrong ms300 error end', 'right end'), [null]);
  assert.deepEqual(changes('wrong @PER01 error end', 'right end'), [null]);
});
test('incomplete readings cannot replace or delete original words', () => {
  assert.deepEqual(changes('alpha beta gamma', 'alpha', true), [null]);
  assert.deepEqual(changes('alpha beta', 'alpha gamma', true), [null]);
});
test('ordinary replacement and insertion still work', () => {
  assert.deepEqual(changes('alpha wrong end', 'alpha right end'), ['alpha right end']);
  assert.deepEqual(changes('alpha end', 'alpha beta end'), ['alpha beta end']);
});
test('vowel comparison is optional and never normalizes the source', () => {
  assert.equal(normWord('عَلَم', {}), normWord('علم', {}));
  assert.notEqual(normWord('عَلَم', {vowels:true}), normWord('علم', {vowels:true}));
  assert.notEqual(normWord('عَلَم،', {...options, vowels:true}), normWord('علم', {...options, vowels:true}));
  assert.equal(normWord('عَلَم،', {...options, vowels:true}), normWord('عَلَم', {...options, vowels:true}));
  assert.equal(textTokens('# عَلَم', {vowels:true})[0].w, 'عَلَم');
});
