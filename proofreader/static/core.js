'use strict';

// Keep failed edits and serialize requests, including callers waiting to navigate.
function createSaver(send, changed, delay = 500) {
  let pending = null, running = null, timer;
  const dirty = () => !!pending || !!running;
  const flush = async () => {
    clearTimeout(timer);
    if (running) { await running; return flush(); }
    if (!pending) return;
    running = (async () => {
      while (pending) {
        const body = pending;
        pending = null;
        changed('saving');
        try { await send(body); }
        catch (error) {
          pending = {...body, ...pending};
          changed('error', error);
          throw error;
        }
      }
      changed('saved');
    })();
    try { await running; } finally { running = null; }
  };
  return {
    dirty, flush,
    save(patch) {
      pending = {...pending, ...patch};
      changed('dirty');
      clearTimeout(timer);
      timer = setTimeout(() => flush().catch(() => {}), delay);
    },
  };
}

function insertWords(text, at, words) {
  const left = text.slice(0, at), right = text.slice(at);
  return left + (left && !/\s$/.test(left) ? ' ' : '') + words
    + (right && !/^\s/.test(right) ? ' ' : '') + right;
}

// OpenITI mARkdown insertion: inline tags go at the selection end, line-start tags at the start of each touched line
function insertMarkup(text, start, end, tag) {
  if (tag === '%~%') {
    const left = text.slice(0, end), right = text.slice(end);
    const pre = !left || /[ \t\n]$/.test(left) ? '' : ' ';
    const post = !right || /^[ \t\n]/.test(right) ? '' : ' ';
    const ins = pre + tag + post;
    const at = end + ins.length;
    return {text: left + ins + right, start: at, end: at};
  }
  const lineAt = p => p ? text.lastIndexOf('\n', p - 1) + 1 : 0;
  const first = lineAt(start);
  let last = lineAt(end);
  if (end > start && last > first && text[end - 1] === '\n') last = lineAt(end - 1);
  const ins = [];
  const standalone = tag.endsWith('|EDITOR|');
  for (let p = first; p <= last;) {
    let nl = text.indexOf('\n', p);
    if (nl < 0) nl = text.length;
    const line = text.slice(p, nl);
    const head = !standalone && tag.startsWith('### ') && line.match(/^### (?:\|EDITOR\||\|+|\$+|@)\s?/);
    if (!line.startsWith(tag)) ins.push(head ? [p, tag, head[0].length] : [p, standalone && line.trim() ? tag + '\n' : tag, 0]);
    if (standalone) break;
    p = nl + 1;
  }
  const shift = q => q + ins.reduce((n, [p, s, d]) => p > q ? n : q >= p + d ? n + s.length - d : n + p + s.length - q, 0);
  let out = '', prev = 0;
  for (const [p, s, d] of ins) { out += text.slice(prev, p) + s; prev = p + d; }
  return {text: out + text.slice(prev), start: shift(start), end: shift(end)};
}

if (typeof module !== 'undefined') module.exports = {createSaver, insertWords, insertMarkup};
