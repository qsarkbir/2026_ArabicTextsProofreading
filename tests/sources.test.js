const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

globalThis.OpenITI = require('../proofreader/static/local/openiti.js');
globalThis.Draft = require('../proofreader/static/local/draft.js');
const Sources = require('../proofreader/static/local/sources.js');

const DIR = path.join(__dirname, 'fixtures', 'ia');
const inputs = JSON.parse(fs.readFileSync(path.join(DIR, 'inputs.json'), 'utf8')), expected = JSON.parse(fs.readFileSync(path.join(DIR, 'expected.json'), 'utf8'));
const describe = url => { const u = new URL(url); return {url: u.origin + u.pathname, query: [...u.searchParams]}; };
const feed = (data, calls) => async url => { calls.push(url); return data; };

test('manifests, PDF choice, image URLs and search results match what sources.py makes of the same synthetic responses', async () => {
  const got = {manifests: [], metadata: [], searches: []};
  for (const c of inputs.manifests) {
    const calls = [], result = await Sources.iaPages(c.id, feed(c.manifest, calls));
    got.manifests.push({id: c.id, requested: calls, result, images: [...result.pages.map(p => Sources.imageUrl(p.service)), ...result.pages.slice(0, 1).map(p => Sources.imageUrl(p.service, 800))]});
  }
  for (const c of inputs.metadata) { const calls = []; got.metadata.push({id: c.id, requested: calls, result: await Sources.iaPdf(c.id, feed(c.metadata, calls))}); }
  for (const c of inputs.searches) { const calls = []; got.searches.push({query: c.query, requested: [], result: await Sources.search(c.query, c.rows, feed(c.response, calls))}); got.searches.at(-1).requested = calls.map(describe); }
  assert.deepEqual(got, expected);
});

test('getJson retries network failures and 5xx, but not 4xx, and gives the D-27 message when it gives up', async () => {
  const waits = [], wait = async ms => { waits.push(ms); };
  const reply = (status, body) => ({ok: status < 400, status, statusText: 'x', json: async () => body});
  let n = 0;
  assert.deepEqual(await Sources.getJson('u', {tries: 3, delay: 7, wait, fetchImpl: async () => { if (++n === 1) throw new TypeError('Failed to fetch'); return n === 2 ? reply(504) : reply(200, {a: 1}); }}), {a: 1});
  assert.deepEqual([n, waits], [3, [7, 7]]);
  n = 0;
  await assert.rejects(Sources.getJson('u', {tries: 3, wait, unavailable: Sources.UNAVAILABLE, fetchImpl: async () => { n++; throw new TypeError('Failed to fetch'); }}), e => e.message === Sources.UNAVAILABLE);
  assert.equal(n, 3);
  n = 0;
  await assert.rejects(Sources.getJson('u', {tries: 3, wait, fetchImpl: async () => { n++; return reply(404); }}), e => e.status === 404 && /^404 x: u$/.test(e.message));
  assert.equal(n, 1);
  assert.equal((await Sources.getJson('u', {fetchImpl: async () => { n++; throw new TypeError('x'); }}).catch(e => e)).message, Sources.OFFLINE);
});
