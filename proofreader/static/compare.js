'use strict';

const ORTHO = {'أ': 'ا', 'إ': 'ا', 'آ': 'ا', 'ٱ': 'ا', 'ى': 'ي', 'ی': 'ي', 'ئ': 'ي', 'ة': 'ه', 'ؤ': 'و', 'ک': 'ك', 'ء': ''};
function normWord(w, options = {}) {
  let s = w.replace(/[ـ‌-‏]/g, '');
  if (!options.vowels) s = s.replace(/[ؐ-ًؚ-ٰٟۖ-ۭ]/g, '');
  if (options.ortho) s = s.replace(/./g, c => ORTHO[c] ?? c);
  if (options.punct) s = s.replace(/[^\p{L}\p{M}\p{N}\[\]?]/gu, '');
  return s;
}
// words of the page text with their offsets; OpenITI markup is skipped so only the text is compared
function textTokens(text, options = {}) {
  const out = [];
  for (const m of text.matchAll(/\S+/g)) {
    let w = m[0], start = m.index;
    if (/^(\|EDITOR\||%~%|\$+|@)$/.test(w)) continue;
    const pre = w.match(/^(?:~~|#+|\|+)+/); // markup stuck to either end of a word (~~word, ~~~~word, word~~) is not part of it
    if (pre) { w = w.slice(pre[0].length); start += pre[0].length; }
    const post = w.match(/(?:~~)+$/);
    if (post) w = w.slice(0, -post[0].length);
    if (!w || /^(ms\d+|PageV\d+P\d+|@\w+|\|+|#+|=+)$/.test(w)) continue;
    const n = normWord(w, options);
    if (!n) continue;
    out.push({w, n, start, end: start + w.length});
  }
  return out;
}
function ocrTokens(ocrText, options = {}) {
  let lines = ocrText.split('\n');
  const fi = lines.findIndex(l => l.trim() === '@FOOTNOTES');
  if (fi >= 0) lines = options.foot ? lines.slice(0, fi).concat(lines.slice(fi + 1)) : lines.slice(0, fi);
  lines = lines.flatMap(l => l.startsWith('@HEADER') ? (options.header ? [l.slice(7)] : []) : [l]);
  return lines.join('\n').split(/\s+/).filter(Boolean).map(w => ({w, n: normWord(w, options)})).filter(t => t.n);
}
// edit distance of two normalized words, 0 (same) .. 1 (nothing in common)
function wordDistance(x, y) {
  if (!x.length || !y.length) return 1;
  let prev = Array.from({length: y.length + 1}, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[y.length] / Math.max(x.length, y.length);
}
// A run where the readings have different numbers of words (e.g. an extra word, or a run across a line break) is aligned
// word by word: words spelled alike become their own one-word blocks, so a line break or markup between them
// is never part of a replacement. Words without a close partner stay grouped.
const ALIGN_GAP = 0.5, ALIGN_CLOSE = 0.5, ALIGN_MAX = 80;
function alignBlock(A, B, [a1, a2, b1, b2]) {
  const n = a2 - a1, m = b2 - b1;
  if (!n || !m || n > ALIGN_MAX || m > ALIGN_MAX) return [[a1, a2, b1, b2]];
  const W = m + 1, cost = new Float64Array((n + 1) * W), D = (i, j) => wordDistance(A[a1 + i].n, B[b1 + j].n);
  for (let i = n; i >= 0; i--) for (let j = m; j >= 0; j--) {
    if (i === n && j === m) continue;
    let c = Infinity;
    if (i < n && j < m) c = D(i, j) + cost[(i + 1) * W + j + 1];
    if (i < n) c = Math.min(c, ALIGN_GAP + cost[(i + 1) * W + j]);
    if (j < m) c = Math.min(c, ALIGN_GAP + cost[i * W + j + 1]);
    cost[i * W + j] = c;
  }
  const out = [];
  let i = 0, j = 0, cur = null;
  const flush = () => { if (cur) { out.push(cur); cur = null; } };
  while (i < n || j < m) {
    const d = i < n && j < m ? D(i, j) : Infinity;
    if (d < Infinity && Math.abs(cost[i * W + j] - (d + cost[(i + 1) * W + j + 1])) < 1e-9) {
      if (d <= ALIGN_CLOSE) { flush(); out.push([a1 + i, a1 + i + 1, b1 + j, b1 + j + 1]); }
      else { cur = cur || [a1 + i, a1 + i, b1 + j, b1 + j]; cur[1] = a1 + i + 1; cur[3] = b1 + j + 1; }
      i++; j++;
    } else if (i < n && Math.abs(cost[i * W + j] - (ALIGN_GAP + cost[(i + 1) * W + j])) < 1e-9) {
      cur = cur || [a1 + i, a1 + i, b1 + j, b1 + j]; cur[1] = a1 + i + 1; i++;
    } else {
      cur = cur || [a1 + i, a1 + i, b1 + j, b1 + j]; cur[3] = b1 + j + 1; j++;
    }
  }
  flush();
  return out;
}
// word-level LCS; returns blocks [a1, a2, b1, b2] where the two readings differ
function diffBlocks(A, B, options = {}) {
  const n = A.length, m = B.length, W = m + 1;
  const L = new Uint16Array((n + 1) * W);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    L[i * W + j] = A[i].n === B[j].n ? L[(i + 1) * W + j + 1] + 1 : Math.max(L[(i + 1) * W + j], L[i * W + j + 1]);
  const blocks = [];
  let i = 0, j = 0, cur = null;
  const flush = () => { if (cur) { blocks.push(cur); cur = null; } };
  while (i < n || j < m) {
    if (i < n && j < m && A[i].n === B[j].n) { flush(); i++; j++; continue; }
    cur = cur || [i, i, j, j];
    if (j < m && (i === n || L[i * W + j + 1] >= L[(i + 1) * W + j])) { j++; cur[3] = j; }
    else { i++; cur[1] = i; }
  }
  flush();
  // split runs of equal length into one-word pairs so each gets its own button; pair the words of other runs by spelling
  return blocks.flatMap(([a1, a2, b1, b2]) => a2 - a1 === b2 - b1 && a2 > a1
    ? Array.from({length: a2 - a1}, (_, k) => [a1 + k, a1 + k + 1, b1 + k, b1 + k + 1]) : alignBlock(A, B, [a1, a2, b1, b2]))
    // words run together or split apart (امابعد / اما بعد) only differ in spacing
    .filter(([a1, a2, b1, b2]) => !options.space || A.slice(a1, a2).map(t => t.n).join('') !== B.slice(b1, b2).map(t => t.n).join(''));
}

// Do not infer absence from an incomplete reading or replace structural boundaries.
function readingPatch(text, A, B, block, truncated = false) {
  const [a1, a2, b1, b2] = block;
  const alt = B.slice(b1, b2).map(t => t.w).join(' ');
  if (truncated && a2 > a1) return null;
  if (a1 === a2) {
    const at = a1 < A.length ? A[a1].start : text.length;
    return insertWords(text, at, alt);
  }
  const start = A[a1].start;
  let end = A[a2 - 1].end;
  const span = text.slice(start, end);
  if (/[\r\n]/.test(span) || /%~%|~~|#|\||\bms\d+|PageV\d+P\d+/.test(span)) return null;
  for (let i = a1; i + 1 < a2; i++) {
    if (/[^\t ]/.test(text.slice(A[i].end, A[i + 1].start))) return null;
  }
  let from = start;
  if (!alt) { if (text[end] === ' ') end++; else if (text[start - 1] === ' ') from--; }
  return text.slice(0, from) + alt + text.slice(end);
}

if (typeof module !== 'undefined') {
  var {insertWords} = require('./core.js');
  module.exports = {normWord, textTokens, ocrTokens, diffBlocks, readingPatch};
}
