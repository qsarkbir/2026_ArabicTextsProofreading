const {test} = require('node:test');
const assert = require('node:assert/strict');

// IndexedDB の代わりにメモリで動く LocalStore。ルーターの URL・応答の形・エラーを確かめる
globalThis.Work = require('../proofreader/static/local/work.js');
globalThis.OpenITI = require('../proofreader/static/local/openiti.js');
const memory = () => {
  const projects = new Map(), originals = new Map(), records = new Map();
  return {
    listProjects: async () => [...projects.values()],
    getProject: async slug => projects.get(slug),
    updateProject: async (slug, mutate) => { mutate(projects.get(slug)); return projects.get(slug); },
    createProject: async f => {
      let slug = f.uri.replace(/[^A-Za-z0-9._-]+/g, '_') || 'text', n = 2;
      const base = slug;
      while (projects.has(slug)) slug = `${base}_${n++}`;
      const p = {slug, uri: f.uri, raw_url: '', title: 'T', author: 'A', created: 'now', candidates: [], source: null, offset: 0, anchors: []};
      projects.set(slug, p); originals.set(slug, OpenITI.split(f.text));
      return p;
    },
    parts: async slug => { if (!originals.has(slug)) throw new Work.ApiError('見つかりません', 404); return originals.get(slug); },
    pages: async slug => Object.fromEntries([...records].filter(([k]) => k.startsWith(slug + '\0')).map(([, r]) => [r.i, r])),
    page: async (slug, i) => records.get(`${slug}\0${i}`),
    savePage: async (slug, i, change) => {
      const out = Work.applyUpdate(records.get(`${slug}\0${i}`), originals.get(slug).pages[i].text, change);
      records.set(`${slug}\0${i}`, {...out, slug, i});
      return out;
    },
  };
};

const TEXT = '#META#Header#End#\r\nalpha beta PageV01P001\r\ngamma\r\ndelta PageV01P002\r\n';
const fresh = async () => {
  globalThis.LocalStore = memory();
  delete require.cache[require.resolve('../proofreader/static/local/router.js')];
  const router = require('../proofreader/static/local/router.js');
  const upload = await router.handle('POST', '/api/projects/upload-text', new Blob([TEXT]), {'X-Filename': 'a%20b.mARkdown'});
  return {router, slug: upload.slug};
};
const status = async (promise, code) => assert.rejects(promise, e => e.status === code);

test('upload creates a project and mirrors server.py project_view', async () => {
  const {router, slug} = await fresh();
  assert.equal(slug, 'a_b');
  const p = await router.handle('GET', `/api/projects/${slug}`);
  assert.equal(p.uri, 'a b');
  assert.equal(p.source, null);
  assert.deepEqual(p.pages, [{vol: 1, page: 1, unassigned: false}, {vol: 1, page: 2, unassigned: false}]);
  assert.deepEqual([p.edited, p.done, p.noted], [[], [], []]);
  const list = await router.handle('GET', '/api/projects');
  assert.deepEqual(list.map(x => [x.slug, x.pages, x.done, x.edited, x.source]), [['a_b', 2, 0, 0, false]]);
});

test('page save follows revisions, conflicts and history', async () => {
  const {router, slug} = await fresh();
  const url = `/api/projects/${slug}/pages/0`;
  const pg = await router.handle('GET', url);
  assert.equal(pg.revision, 0);
  assert.equal(pg.original, '\r\nalpha beta ');
  await status(router.handle('PUT', url, {text: 'x'}), 428);
  await status(router.handle('PUT', url, {text: 1, revision: 0}), 400);
  const saved = await router.handle('PUT', url, {text: 'edited', note: 'n', revision: 0});
  assert.equal(saved.revision, 1);
  assert.deepEqual([saved.edited, saved.noted, saved.page], [[0], [0], 0]);
  await status(router.handle('PUT', url, {text: 'stale', revision: 0}), 409);
  await status(router.handle('GET', `/api/projects/${slug}/pages/9`), 404);
  assert.deepEqual((await router.handle('GET', `${url}/history`)).map(e => e.text), ['\r\nalpha beta ']);
  await router.handle('PUT', url, {text: pg.original, revision: 1, checkpoint: true});
  assert.equal((await router.handle('GET', `${url}/history`)).length, 2);
});

test('search, notes csv and text export', async () => {
  const {router, slug} = await fresh();
  await router.handle('PUT', `/api/projects/${slug}/pages/1`, {text: 'Gamma, "x"', note: 'check', done: true, revision: 0});
  const names = async q => (await router.handle('GET', `/api/projects/${slug}/search?${q}`)).map(r => r.i);
  assert.deepEqual(await names('q=ALPHA'), [0]);
  assert.deepEqual(await names('filter=todo'), [0]);
  assert.deepEqual(await names('filter=edited'), [1]);
  assert.deepEqual(await names('q=check&filter=noted'), [1]);
  const dl = async fmt => router.handle('GET', `/api/projects/${slug}/export?fmt=${fmt}`);
  const text = await dl('text');
  assert.equal(text.filename, 'a b.corrected');
  assert.equal(new TextDecoder('utf-8', {ignoreBOM: true}).decode(text.data), TEXT.replace('\r\ngamma\r\ndelta ', 'Gamma, "x"'));
  const csv = new TextDecoder('utf-8', {ignoreBOM: true}).decode((await dl('notes')).data);
  assert.equal(csv, '﻿index,marker,edited,done,note\r\n1,PageV01P002,1,1,check\r\n');
  await status(dl('tei'), 501);
  await status(dl('nope'), 400);
});

test('unfinished upload, bibliography and unsupported routes', async () => {
  const {router, slug} = await fresh();
  await status(router.handle('POST', '/api/projects/upload-text', new Blob(['no markers']), {}), 400);
  await status(router.handle('POST', '/api/projects/upload-text', new Blob([Uint8Array.of(0xff, 0xfe)]), {}), 400);
  await status(router.handle('PUT', `/api/projects/${slug}/bibliography`, {title: 1}), 400);
  const p = await router.handle('PUT', `/api/projects/${slug}/bibliography`, {title: ' ت ', author: 'a', edition: 'e'});
  assert.deepEqual([p.title, p.author, p.bibliography], ['ت', 'a', {edition: 'e', source: '', rights: ''}]);
  await status(router.handle('GET', '/api/projects/nope'), 404);
  await status(router.handle('GET', '/api/projects/..'), 404);
  for (const [m, u] of [['GET', '/api/ia/search?q=x'], ['POST', '/api/projects/new-pdf'], ['POST', `/api/projects/${slug}/source/ia`],
    ['POST', `/api/projects/${slug}/mapping`], ['POST', `/api/projects/${slug}/pages/0/ocr`], ['GET', `/api/projects/${slug}/pages/0/readings`],
    ['POST', '/api/shutdown'], ['POST', '/api/heartbeat']])
    await assert.rejects(router.handle(m, u, {}), e => e.status === 501 && e.message === 'この機能はローカル版で利用できます');
});

test('searchTerms keeps the longest three distinct words', () => {
  const {searchTerms} = require('../proofreader/static/local/router.js');
  assert.equal(searchTerms('كتاب البستان في الأخبار', 'ابن مريم'), 'البستان الأخبار مريم');
  assert.equal(searchTerms('Ibn al Bustan Bustan', 'Maryam'), 'Bustan Maryam');
});
