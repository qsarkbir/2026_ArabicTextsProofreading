const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// IndexedDB の代わりにメモリで動く LocalStore。ルーターの URL・応答の形・エラーを確かめる
globalThis.Work = require('../proofreader/static/local/work.js');
globalThis.OpenITI = require('../proofreader/static/local/openiti.js');
globalThis.Bundle = require('../proofreader/static/local/bundle.js');
globalThis.TEI = require('../proofreader/static/local/tei.js');
globalThis.Draft = require('../proofreader/static/local/draft.js');
const memory = () => {
  const projects = new Map(), originals = new Map(), records = new Map(), texts = new Map(), settings = new Map(), files = new Map();
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
    updateProject: async (slug, mutate) => {
      const p = projects.get(slug), copy = structuredClone(p), out = mutate(copy) || {}; // 本物と同じく、失敗したら何も変えない
      projects.set(slug, copy);
      for (const name of out.remove || []) files.delete(`${slug}/${name}`);
      for (const {name, blob} of out.put || []) files.set(`${slug}/${name}`, blob);
      return copy;
    },
    getFile: async (slug, name) => files.get(`${slug}/${name}`),
    fileSizes: async () => { const out = {}; for (const [k, b] of files) out[k.split('/')[0]] = (out[k.split('/')[0]] || 0) + b.size; return out; },
    attachFile: async (slug, name, blob, {count, revision} = {}) => {
      const p = projects.get(slug);
      if (count !== undefined && count !== p.source.count) projects.set(slug, {...p, source: {...p.source, count, revision}});
      files.set(`${slug}/${name}`, blob);
    },
    files,
    createProject: async (f, extra = {}) => {
      const p = make(f.uri.replace(/[^A-Za-z0-9._-]+/g, '_') || 'text',
        {uri: f.uri, raw_url: '', title: 'T', author: 'A', created: 'now', candidates: [], source: null, offset: 0, anchors: [], ...extra.patch}, f.text);
      if (extra.file) files.set(`${p.slug}/${extra.file.name}`, extra.file.blob);
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
  for (const [m, u] of [['GET', '/api/ia/search?q=x'], ['POST', `/api/projects/${slug}/source/ia`],
    ['GET', `/api/projects/${slug}/scan/0`], ['POST', `/api/projects/${slug}/source/ia/pdf`], ['POST', `/api/projects/${slug}/pages/0/ocr`], ['GET', `/api/projects/${slug}/pages/0/readings`],
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
  assert.equal((await router.handle('GET', '/api/projects')).find(p => p.slug === slug).backup, null);  // recorded only once the download has started
  await exported.done();
  assert.ok((await router.handle('GET', '/api/projects')).find(p => p.slug === slug).backup);
  const view = await router.handle('POST', '/api/projects/import-bundle', bundle);
  assert.deepEqual([view.slug, view.edited, view.done, view.noted], ['a_b_2', [1], [1], [1]]);
  const again = await router.handle('GET', `/api/projects/a_b_2/export?fmt=text`);
  assert.equal(new TextDecoder('utf-8', {ignoreBOM: true}).decode(again.data), TEXT.replace('\r\ngamma\r\ndelta ', 'Gamma'));
  await assert.rejects(router.handle('POST', '/api/projects/import-bundle', {...bundle, format_version: 2}), e => e.status === 400 && /新しい版のアプリで作られたデータです/.test(e.message));
  await assert.rejects(router.handle('POST', '/api/projects/import-bundle', '{not json'), e => e.status === 400);
});

const pdfBlob = (text = '%PDF-fixture') => new Blob([text]);
const SOURCE_DIR = path.join(__dirname, 'fixtures', 'source');

test('PDF source routes replay the steps of tests/fixtures/source and match server.py', async () => {
  const ops = JSON.parse(fs.readFileSync(path.join(SOURCE_DIR, 'ops.json'), 'utf8')), expected = JSON.parse(fs.readFileSync(path.join(SOURCE_DIR, 'expected.json'), 'utf8'));
  globalThis.LocalStore = memory();
  delete require.cache[require.resolve('../proofreader/static/local/router.js')];
  const router = require('../proofreader/static/local/router.js');
  const {slug} = await router.handle('POST', '/api/projects/upload-text', new Blob([ops.text]), {'X-Filename': 'fixture'});
  await LocalStore.updateProject(slug, p => { p.source = ops.source; return {put: [{name: ops.source.file, blob: pdfBlob()}]}; });
  const norm = (v, volatile) => {
    if (Array.isArray(v)) return v.map(x => norm(x, volatile));
    if (!v || typeof v !== 'object') return v;
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === 'pdf' && x ? '<pdf>'
      : k === 'file' && /^source-[0-9a-f]{32}\.pdf$/.test(x) ? '<file>' : k === 'revision' && /^[0-9a-f]{32}$/.test(x) ? '<revision>'
      : k === 'key' && volatile ? '<key>' : norm(x, volatile)]));
  };
  const pick = r => Object.fromEntries(['slug', 'offset', 'anchors', 'source', 'draft'].map(k => [k, r[k]]));
  const revisions = [], got = [];
  for (const step of ops.steps) {
    try {
      let r;
      if (step.op === 'view') r = pick(await router.handle('GET', `/api/projects/${slug}`));
      else if (step.op === 'stage') {
        const v = await router.handle('POST', `/api/projects/${slug}/source/pdf`, pdfBlob('%PDF-x'), {'X-Page-Count': String(step.count), 'X-Filename': encodeURIComponent(step.title)});
        revisions.push(v.draft.revision);
        r = {draft: v.draft, offset: v.offset, anchors: v.anchors, source: v.source};
      } else if (step.op === 'mapping') {
        const body = {...step.body};
        if ('source' in body) { const k = {$draft: -1, $previous: -2}[body.source]; if (k !== undefined) body.source = revisions.at(k) ?? ''; }
        r = pick(await router.handle('POST', `/api/projects/${slug}/mapping`, body));
      } else if (step.op === 'image') r = await router.handle('GET', `/api/projects/${slug}/image?index=${step.index}${step.draft ? `&draft=${revisions.at(-1)}` : ''}`);
      else r = (await router.handle('GET', `/api/projects/${slug}/pages/${step.i}`)).image;
      assert.ok(!step.expect_error, JSON.stringify(step));
      got.push(norm(r, step.volatile));
    } catch (e) {
      assert.ok(step.expect_error && e.status, `${JSON.stringify(step)}: ${e.message}`);
      got.push({error: e.status, message: e.message});
    }
  }
  assert.deepEqual(got, expected);
  assert.equal([...LocalStore.files.keys()].filter(k => k.startsWith(slug + '/')).length, 1);  // 置き換えた資料の古い PDF は残さない
  router.revokeUrls();
});

test('pdf URLs are stable per file, replaced on re-attach and revoked on leaving', async () => {
  const {router, slug} = await fresh();
  const made = [], revoked = [];
  URL.createObjectURL = b => { const u = `blob:test/${made.length}`; made.push([u, b]); return u; };
  URL.revokeObjectURL = u => revoked.push(u);
  await LocalStore.updateProject(slug, p => { p.source = {type: 'pdf', file: 'source.pdf', revision: 'r', title: 't', count: 2}; return {put: [{name: 'source.pdf', blob: pdfBlob()}]}; });
  const first = (await router.handle('GET', `/api/projects/${slug}/pages/0`)).image;
  assert.equal((await router.handle('GET', `/api/projects/${slug}/pages/1`)).image.pdf, first.pdf);  // ページ移動で PDF を読み直さない
  assert.equal(made.length, 1);
  await router.handle('POST', `/api/projects/${slug}/source/pdf/attach`, pdfBlob('%PDF-again'), {'X-Page-Count': '2'});
  const second = (await router.handle('GET', `/api/projects/${slug}/pages/0`)).image;
  assert.notEqual(second.pdf, first.pdf);
  router.revokeUrls();
  assert.deepEqual(revoked.sort(), made.map(m => m[0]).sort());
  assert.equal(made.length, 2);
});

test('a restored PDF project without its file opens, asks for the PDF and accepts it again', async () => {
  const {router, slug} = await fresh();
  await LocalStore.updateProject(slug, p => { p.source = {type: 'pdf', file: 'kept.pdf', revision: 'r', title: 'Kept.pdf', count: 2}; });
  const image = (await router.handle('GET', `/api/projects/${slug}/pages/0`)).image;
  assert.deepEqual([image.pdf, image.no_file, image.missing, image.count], [null, true, false, 2]);
  assert.equal((await router.handle('GET', `/api/projects/${slug}/image?index=1`)).no_file, true);
  await status(router.handle('POST', `/api/projects/${slug}/source/pdf/attach`, new Blob(['nope']), {'X-Page-Count': '2'}), 400);
  await status(router.handle('POST', `/api/projects/${slug}/source/pdf/attach`, pdfBlob(), {}), 400);
  await router.handle('POST', `/api/projects/${slug}/source/pdf/attach`, pdfBlob(), {'X-Page-Count': '2'});
  assert.equal(typeof (await router.handle('GET', `/api/projects/${slug}/pages/0`)).image.pdf, 'string');
  assert.equal((await router.handle('GET', `/api/projects/${slug}`)).source.revision, 'r');  // 同じページ数なら資料は変わらない
  assert.deepEqual((await router.handle('GET', '/api/projects')).map(p => p.pdf_size), [pdfBlob().size]);
  router.revokeUrls();
});

test('IA sources replay tests/fixtures/source/ia-ops.json: metadata only (no url, service, w, h), same shapes and keys as server.py', async () => {
  const ops = JSON.parse(fs.readFileSync(path.join(SOURCE_DIR, 'ia-ops.json'), 'utf8')), expected = JSON.parse(fs.readFileSync(path.join(SOURCE_DIR, 'ia-expected.json'), 'utf8'));
  const pick = r => Object.fromEntries(['slug', 'offset', 'anchors', 'source', 'draft'].map(k => [k, r[k]]));
  const got = [];
  for (const source of ops.sources) {
    globalThis.LocalStore = memory();
    delete require.cache[require.resolve('../proofreader/static/local/router.js')];
    const router = require('../proofreader/static/local/router.js');
    const {slug} = await router.handle('POST', '/api/projects/upload-text', new Blob([ops.text]), {'X-Filename': 'fixture'});
    await LocalStore.updateProject(slug, p => { p.source = structuredClone(source); });
    const out = [];
    for (const step of ops.steps) {
      if (step.op === 'view') out.push(pick(await router.handle('GET', `/api/projects/${slug}`)));
      else if (step.op === 'mapping') out.push(pick(await router.handle('POST', `/api/projects/${slug}/mapping`, step.body)));
      else if (step.op === 'image') out.push(await router.handle('GET', `/api/projects/${slug}/image?index=${step.index}`));
      else out.push((await router.handle('GET', `/api/projects/${slug}/pages/${step.i}`)).image);
    }
    got.push(out);
  }
  assert.deepEqual(got, expected);
});

test('an IA project keeps its mapping when the screen shifts from the image metadata (offset 5, page 1 -> anchor [1, 7])', async () => {
  const {router, slug} = await fresh();
  await LocalStore.updateProject(slug, p => { p.source = {type: 'ia', id: 'book', revision: 'r', pages: Array.from({length: 20}, (_, i) => ({label: String(i), service: 's', w: 1, h: 1}))}; p.offset = 5; });
  const image = (await router.handle('GET', `/api/projects/${slug}/pages/1`)).image;
  assert.deepEqual([image.index, image.count, image.label, 'url' in image, 'pdf' in image], [6, 20, '6', false, false]);
  const shifted = await router.handle('POST', `/api/projects/${slug}/mapping`, {anchor: [1, image.index + 1]});  // app.js の shift()
  assert.deepEqual([shifted.offset, shifted.anchors], [5, [[1, 7]]]);
  assert.equal((await router.handle('GET', `/api/projects/${slug}/pages/1`)).image.index, 7);
});

test('source/pdf, attach and mapping validate like server.py', async () => {
  const {router, slug} = await fresh();
  const url = `/api/projects/${slug}/source/pdf`;
  await assert.rejects(router.handle('POST', url, new Blob(['not pdf']), {'X-Page-Count': '2'}), e => e.status === 400 && e.message === 'PDFファイルではありません');
  await assert.rejects(router.handle('POST', url, pdfBlob(), {'X-Page-Count': '0'}), e => e.status === 400 && e.message === 'PDFのページ数を確認できませんでした');
  await assert.rejects(router.handle('POST', url, pdfBlob(), {}), e => e.status === 400);
  await status(router.handle('POST', '/api/projects/nope/source/pdf', pdfBlob(), {'X-Page-Count': '1'}), 404);
  await status(router.handle('POST', `/api/projects/${slug}/mapping`, {offset: 'x'}), 400);
  await status(router.handle('POST', `/api/projects/${slug}/mapping`, {anchor: [1]}), 400);
  await status(router.handle('POST', `/api/projects/${slug}/mapping`, {source: 'none'}), 409);
  await status(router.handle('POST', `/api/projects/${slug}/source/pdf/attach`, pdfBlob(), {'X-Page-Count': '1'}), 400); // 資料がまだ無い
  const staged = await router.handle('POST', url, pdfBlob(), {'X-Page-Count': '3', 'X-Filename': 'a%20b.pdf'});
  assert.equal(staged.draft.title, 'a b.pdf');
  assert.equal((await router.handle('GET', `/api/projects/${slug}`)).source, null);  // 確定するまで何も変わらない
  assert.equal(LocalStore.files.size, 0);
  const done = await router.handle('POST', `/api/projects/${slug}/mapping`, {source: staged.draft.revision, offset: 1});
  assert.deepEqual([done.source.file, done.source.count, done.offset, done.anchors], [staged.draft.file, 3, 1, []]);
  assert.equal(LocalStore.files.size, 1);
  router.revokeUrls();
});

test('new-pdf creates a draft project like server.py and rejects bad input with the same messages', async () => {
  const {router} = await fresh();
  const meta = {title: 'Synthetic', count: 5, start: 2, end: 4, volume: 1, first_page: 7, filename: 'book.pdf'};
  const headers = m => ({'X-Metadata': encodeURIComponent(JSON.stringify(m))});
  const p = await router.handle('POST', '/api/projects/new-pdf', pdfBlob(), headers(meta));
  assert.match(p.uri, /^local-[0-9a-f]{12}$/);
  assert.deepEqual([p.title, p.draft, p.offset, p.pages.map(x => x.page), p.source.file, p.source.title, p.source.count], ['Synthetic', true, 1, [7, 8, 9], 'source.pdf', 'book.pdf', 5]);
  assert.match(p.source.revision, /^[0-9a-f]{32}$/);
  const text = new TextDecoder().decode((await router.handle('GET', `/api/projects/${p.slug}/export?fmt=text`)).data);
  assert.equal(text, '######OpenITI#\n\n#META#Header#End#\n\n# \nPageV01P007\n\n# \nPageV01P008\n\n# \nPageV01P009\n\n');
  assert.equal((await router.handle('GET', `/api/projects/${p.slug}/pages/0`)).image.index, 1);
  await assert.rejects(router.handle('POST', '/api/projects/new-pdf', new Blob(['x']), headers(meta)), e => e.status === 400 && e.message === '500 MB以下のPDFを選択してください');
  await assert.rejects(router.handle('POST', '/api/projects/new-pdf', pdfBlob(), headers({...meta, end: 9})), e => e.status === 400 && e.message === '書名、PDFの対象範囲、巻と印刷ページ番号を確認してください');
  await assert.rejects(router.handle('POST', '/api/projects/new-pdf', pdfBlob(), {'X-Metadata': '{bad'}), e => e.status === 400);
  assert.equal((await router.handle('GET', '/api/projects')).length, 2);
  router.revokeUrls();
});

const withBlobUrls = () => {
  const made = [], revoked = [];
  URL.createObjectURL = b => { const u = `blob:test/${made.length}`; made.push([u, b]); return u; };
  URL.revokeObjectURL = u => revoked.push(u);
  return {made, revoked};
};
const settle = () => new Promise(r => setImmediate(r));

test('retired URLs go to the releaser: confirm, replace and re-attach leave no pdf.js document for a URL nobody uses', async () => {
  const {router, slug} = await fresh();
  const {made} = withBlobUrls();
  const released = [];
  router.setReleaser(async urls => { released.push(...urls); });
  const staged = async n => (await router.handle('POST', `/api/projects/${slug}/source/pdf`, pdfBlob(), {'X-Page-Count': String(n)})).draft;
  let d = await staged(3);
  const draftUrl = (await router.handle('GET', `/api/projects/${slug}/image?index=0&draft=${d.revision}`)).pdf;
  assert.deepEqual(router.urlsOf(slug, true), [draftUrl]);
  assert.deepEqual(router.urlsOf(slug, false), []);
  const second = await staged(3);  // 選び直し：前の未確定の URL を手放す
  await settle();
  assert.deepEqual(released, [draftUrl]);
  const draft2Url = (await router.handle('GET', `/api/projects/${slug}/image?index=0&draft=${second.revision}`)).pdf;
  await router.handle('POST', `/api/projects/${slug}/mapping`, {source: second.revision, offset: 0});  // 確定
  await settle();
  assert.deepEqual(released, [draftUrl, draft2Url]);
  const first = (await router.handle('GET', `/api/projects/${slug}/pages/0`)).image.pdf;
  assert.deepEqual(router.urlsOf(slug, false), [first]);
  // 資料の置き換え：古い PDF の URL も手放す
  d = await staged(4);
  const draft3Url = (await router.handle('GET', `/api/projects/${slug}/image?index=0&draft=${d.revision}`)).pdf;
  await router.handle('POST', `/api/projects/${slug}/mapping`, {source: d.revision});
  await settle();
  assert.deepEqual(released.slice(2).sort(), [draft3Url, first].sort());
  const second_file = (await router.handle('GET', `/api/projects/${slug}/pages/0`)).image.pdf;
  assert.deepEqual(router.urlsOf(slug, false), [second_file]);
  // 付け直し
  await router.handle('POST', `/api/projects/${slug}/source/pdf/attach`, pdfBlob(), {'X-Page-Count': '4'});
  await settle();
  assert.equal(released.at(-1), second_file);
  assert.deepEqual(router.urlsOf(slug, false), []);
  assert.equal(made.length, 5);
  router.revokeUrls();
});

test('clearDrafts drops the staged PDF of every project except the one in setup', async () => {
  const {router, slug} = await fresh();
  withBlobUrls();
  const released = [];
  router.setReleaser(async urls => { released.push(...urls); });
  const d = (await router.handle('POST', `/api/projects/${slug}/source/pdf`, pdfBlob(), {'X-Page-Count': '2'})).draft;
  const url = (await router.handle('GET', `/api/projects/${slug}/image?index=0&draft=${d.revision}`)).pdf;
  router.clearDrafts(slug);
  await settle();
  assert.deepEqual(released, []);  // 設定画面のまま
  router.clearDrafts(null);        // キャンセル・画面を離れる
  await settle();
  assert.deepEqual(released, [url]);
  assert.deepEqual(router.urlsOf(slug, true), []);
  await status(router.handle('POST', `/api/projects/${slug}/mapping`, {source: d.revision}), 409);
  await status(router.handle('GET', `/api/projects/${slug}/image?index=0&draft=${d.revision}`), 409);
  router.revokeUrls();
});

test('re-attaching a PDF with another page count updates count and revision (so the image key changes); the same count changes nothing', async () => {
  const {router, slug} = await fresh();
  await LocalStore.updateProject(slug, p => { p.source = {type: 'pdf', file: 'kept.pdf', revision: 'old', title: 'Kept.pdf', count: 4}; p.offset = 1; p.anchors = [[0, 2]]; });
  const keyOf = async () => (await router.handle('GET', `/api/projects/${slug}/image?index=1`)).key;
  const before = await keyOf();
  const same = await router.handle('POST', `/api/projects/${slug}/source/pdf/attach`, pdfBlob(), {'X-Page-Count': '4'});
  assert.deepEqual([same.source.revision, same.source.count], ['old', 4]);
  assert.equal(await keyOf(), before);
  const other = await router.handle('POST', `/api/projects/${slug}/source/pdf/attach`, pdfBlob(), {'X-Page-Count': '3'});
  assert.equal(other.source.count, 3);
  assert.match(other.source.revision, /^[0-9a-f]{32}$/);
  assert.notEqual(other.source.revision, 'old');
  assert.notEqual(await keyOf(), before);
  assert.deepEqual([other.offset, other.anchors], [1, [[0, 2]]]);  // 対応は保たれる
  router.revokeUrls();
});

test('source/pdf, attach and new-pdf refuse more than 500 MB with the 413 message of server.py body()', async () => {
  const {router, slug} = await fresh();
  const huge = pdfBlob();
  Object.defineProperty(huge, 'size', {value: 500 * 1024 * 1024 + 1});
  const tooBig = e => e.status === 413 && e.message === '送信データが大きすぎます（上限500 MB）';
  await assert.rejects(router.handle('POST', `/api/projects/${slug}/source/pdf`, huge, {'X-Page-Count': '2'}), tooBig);
  await LocalStore.updateProject(slug, p => { p.source = {type: 'pdf', file: 'kept.pdf', revision: 'r', title: 'K', count: 2}; });
  await assert.rejects(router.handle('POST', `/api/projects/${slug}/source/pdf/attach`, huge, {'X-Page-Count': '2'}), tooBig);
  await assert.rejects(router.handle('POST', '/api/projects/new-pdf', huge, {'X-Metadata': encodeURIComponent(JSON.stringify({title: 'T', count: 1}))}), tooBig);
  assert.equal(LocalStore.files.size, 0);
  const exact = pdfBlob();
  Object.defineProperty(exact, 'size', {value: 500 * 1024 * 1024});
  await assert.doesNotReject(router.handle('POST', `/api/projects/${slug}/source/pdf`, exact, {'X-Page-Count': '2'}));  // ちょうど上限は通る
  router.revokeUrls();
});

test('a null revision hashes as the string None, like Python str(None); a missing one falls back to id', async () => {
  const {router, slug} = await fresh();
  const sha = async t => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t))), b => b.toString(16).padStart(2, '0')).join('');
  const pages = [{label: '1', service: 's', w: 1, h: 1}];
  await LocalStore.updateProject(slug, p => { p.source = {type: 'ia', id: 'book', revision: null, pages}; });
  assert.equal((await router.handle('GET', `/api/projects/${slug}/image?index=0`)).key, await sha('ia:None:0'));
  await LocalStore.updateProject(slug, p => { p.source = {type: 'ia', id: 'book', pages}; });
  assert.equal((await router.handle('GET', `/api/projects/${slug}/image?index=0`)).key, await sha('ia:book:0'));
});
