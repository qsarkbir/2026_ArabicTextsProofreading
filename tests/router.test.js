const {test} = require('node:test');
const assert = require('node:assert/strict');

// IndexedDB の代わりにメモリで動く LocalStore。ルーターの URL・応答の形・エラーを確かめる
globalThis.Work = require('../proofreader/static/local/work.js');
globalThis.OpenITI = require('../proofreader/static/local/openiti.js');
globalThis.Bundle = require('../proofreader/static/local/bundle.js');
globalThis.TEI = require('../proofreader/static/local/tei.js');
const memory = () => {
  const projects = new Map(), originals = new Map(), records = new Map(), texts = new Map(), settings = new Map();
  const make = (base, p, text) => {
    let slug = base, n = 2;
    while (projects.has(slug)) slug = `${base}_${n++}`;
    projects.set(slug, {...p, slug}); originals.set(slug, OpenITI.split(text)); texts.set(slug, text);
    return projects.get(slug);
  };
  return {
    backupTimes: async () => Object.fromEntries([...settings].map(([k, v]) => [k.slice(7), v])),
    setSetting: async (k, v) => { settings.set(k, v); },
    bundleSource: async slug => ({project: projects.get(slug), original: texts.get(slug), records: Object.fromEntries([...records].filter(([k]) => k.startsWith(slug + '\0')).map(([, r]) => [r.i, r]))}),
    importBundle: async ({project, text, work}) => {
      const p = make(project.uri.replace(/[^A-Za-z0-9._-]+/g, '_') || 'text', project, text);
      for (const [k, r] of Object.entries(Work.workToRecords(work))) records.set(`${p.slug}\0${k}`, {...r, slug: p.slug, i: Number(k)});
      return p;
    },

    listProjects: async () => [...projects.values()],
    getProject: async slug => projects.get(slug),
    updateProject: async (slug, mutate) => { mutate(projects.get(slug)); return projects.get(slug); },
    createProject: async f => make(f.uri.replace(/[^A-Za-z0-9._-]+/g, '_') || 'text',
      {uri: f.uri, raw_url: '', title: 'T', author: 'A', created: 'now', candidates: [], source: null, offset: 0, anchors: []}, f.text),
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
  const tei = await dl('tei');
  assert.deepEqual([tei.filename, tei.type], ['a b.tei.xml', 'application/xml; charset=utf-8']);
  assert.match(new TextDecoder().decode(tei.data), /^<\?xml version='1.0' encoding='utf-8'\?>\n<TEI xmlns="http:\/\/www.tei-c.org\/ns\/1.0">.*<pb n="2" xml:id="page-1" \/>/s);
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
    ['POST', '/api/shutdown'], ['POST', '/api/heartbeat'], ['GET', `/api/projects/${slug}/export?fmt=package`], ['GET', `/api/projects/${slug}/export?fmt=diff`]])
    await assert.rejects(router.handle(m, u, {}), e => e.status === 501 && e.message === 'この機能はローカル版で利用できます');
});

test('searchTerms keeps the longest three distinct words', () => {
  const {searchTerms} = require('../proofreader/static/local/router.js');
  assert.equal(searchTerms('كتاب البستان في الأخبار', 'ابن مريم'), 'البستان الأخبار مريم');
  assert.equal(searchTerms('Ibn al Bustan Bustan', 'Maryam'), 'Bustan Maryam');
});

test('bundle export and import follow the server routes', async () => {
  const {router, slug} = await fresh();
  await router.handle('PUT', `/api/projects/${slug}/pages/1`, {text: 'Gamma', note: 'check', done: true, revision: 0});
  const exported = await router.handle('GET', `/api/projects/${slug}/export?fmt=bundle`);
  assert.deepEqual([exported.filename, exported.type], [`${slug}.proofreader.json`, 'application/json; charset=utf-8']);
  const bundle = JSON.parse(new TextDecoder('utf-8', {ignoreBOM: true}).decode(exported.data));
  assert.deepEqual([bundle.format, bundle.format_version, bundle.app.mode], ['openiti-proofreader-project', 1, 'browser']);
  assert.equal(bundle.original, TEXT);
  assert.deepEqual(bundle.work.status, {1: {done: true, note: 'check'}});
  assert.ok((await router.handle('GET', '/api/projects')).find(p => p.slug === slug).backup);
  const view = await router.handle('POST', '/api/projects/import-bundle', bundle);
  assert.deepEqual([view.slug, view.edited, view.done, view.noted], ['a_b_2', [1], [1], [1]]);
  const again = await router.handle('GET', `/api/projects/a_b_2/export?fmt=text`);
  assert.equal(new TextDecoder('utf-8', {ignoreBOM: true}).decode(again.data), TEXT.replace('\r\ngamma\r\ndelta ', 'Gamma'));
  await assert.rejects(router.handle('POST', '/api/projects/import-bundle', {...bundle, format_version: 2}), e => e.status === 400 && /新しい版のアプリで作られたデータです/.test(e.message));
  await assert.rejects(router.handle('POST', '/api/projects/import-bundle', '{not json'), e => e.status === 400);
});
