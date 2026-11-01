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

if (typeof module !== 'undefined') module.exports = {createSaver, insertWords};
