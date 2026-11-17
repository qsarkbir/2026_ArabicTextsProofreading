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
globalThis.Sources = require('../proofreader/static/local/sources.js');
globalThis.OCR = require('../proofreader/static/local/ocr.js');
const memory = () => {
  const projects = new Map(), originals = new Map(), records = new Map(), texts = new Map(), settings = new Map(), files = new Map(), ocr = new Map();
  const make = (base, p, text) => {
    let slug = base, n = 2;
    while (projects.has(slug)) slug = `${base}_${n++}`;
    projects.set(slug, {...p, slug}); originals.set(slug, OpenITI.split(text)); texts.set(slug, text);
    return projects.get(slug);
  };
  return {
    backupTimes: async () => Object.fromEntries([...settings].map(([k, v]) => [k.slice(7), v])),
    setSetting: async (k, v) => { settings.set(k, v); },
    getSetting: async k => settings.get(k),
    deleteSetting: async k => { settings.delete(k); },
    settings,
    ocr,
    ocrList: async (slug, i) => structuredClone(ocr.get(`${slug}\0${i}`) || []),
    ocrPut: async (slug, i, r) => {
      if (!projects.has(slug)) throw new Work.ApiError('見つかりません', 404);
      ocr.set(`${slug}\0${i}`, [...(ocr.get(`${slug}\0${i}`) || []), structuredClone(r)]);
      return r;
    },
    bundleSource: async slug => ({project: projects.get(slug), original: texts.get(slug), records: Object.fromEntries([...records].filter(([k]) => k.startsWith(slug + '\0')).map(([, r]) => [r.i, r])),
      ocr: Object.fromEntries([...ocr].filter(([k]) => k.startsWith(slug + '\0')).map(([k, v]) => [k.split('\0')[1], structuredClone(v)]))}),
    importBundle: async ({project, text, work, ocr: readings = {}}) => {
      const p = make(project.uri.replace(/[^A-Za-z0-9._-]+/g, '_') || 'text', project, text);
      for (const [k, r] of Object.entries(Work.workToRecords(work))) records.set(`${p.slug}\0${k}`, {...r, slug: p.slug, i: Number(k)});
      for (const [k, page] of Object.entries(readings)) ocr.set(`${p.slug}\0${k}`, Bundle.readingsOf(page));
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
    deleteProject: async slug => {
      if (!projects.has(slug)) throw new Work.ApiError('見つかりません', 404);
      projects.delete(slug); originals.delete(slug); texts.delete(slug); settings.delete(`backup:${slug}`);
      for (const k of [...records.keys()]) if (k.startsWith(slug + '\0')) records.delete(k);
      for (const k of [...files.keys()]) if (k.startsWith(slug + '/')) files.delete(k);
      for (const k of [...ocr.keys()]) if (k.startsWith(slug + '\0')) ocr.delete(k);
    },
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
  for (const [m, u] of [['GET', `/api/projects/${slug}/scan/0`], ['POST', `/api/projects/${slug}/source/ia/pdf`], 
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
  await assert.rejects(router.handle('POST', '/api/projects/import-bundle', {...bundle, format_version: 3}), e => e.status === 400 && /新しい版のアプリで作られたデータです/.test(e.message));
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

test('IA sources replay tests/fixtures/source/ia-ops.json: same shapes and keys as server.py (url is a placeholder: the direct IIIF image URL here)', async () => {
  const ops = JSON.parse(fs.readFileSync(path.join(SOURCE_DIR, 'ia-ops.json'), 'utf8')), expected = JSON.parse(fs.readFileSync(path.join(SOURCE_DIR, 'ia-expected.json'), 'utf8'));
  const pick = r => Object.fromEntries(['slug', 'offset', 'anchors', 'source', 'draft'].map(k => [k, r[k]]));
  const got = [];
  const placeholder = image => {
    if (!image || image.url === undefined) return image;
    assert.equal(image.url, `${image.service}/full/1600,/0/default.jpg`);
    return {...image, url: '<url>'};
  };
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
      else if (step.op === 'image') out.push(placeholder(await router.handle('GET', `/api/projects/${slug}/image?index=${step.index}`)));
      else out.push(placeholder((await router.handle('GET', `/api/projects/${slug}/pages/${step.i}`)).image));
    }
    got.push(out);
  }
  assert.deepEqual(got, expected);
});

test('an IA project keeps its mapping when the screen shifts from the image metadata (offset 5, page 1 -> anchor [1, 7])', async () => {
  const {router, slug} = await fresh();
  await LocalStore.updateProject(slug, p => { p.source = {type: 'ia', id: 'book', revision: 'r', pages: Array.from({length: 20}, (_, i) => ({label: String(i), service: `https://iiif.archive.org/image/iiif/3/b%2F${i}`, w: 1, h: 1}))}; p.offset = 5; });
  const image = (await router.handle('GET', `/api/projects/${slug}/pages/1`)).image;
  assert.deepEqual([image.index, image.count, image.label, image.url, 'pdf' in image], [6, 20, '6', 'https://iiif.archive.org/image/iiif/3/b%2F6/full/1600,/0/default.jpg', false]);
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

// ---------- Internet Archive（段階2）：fetch を差し替えて、server.py と同じ形で動くことを確かめる ----------
const IA_INPUTS = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'ia', 'inputs.json'), 'utf8'));
const iaWorld = (handler, run) => async () => {
  const calls = [], saved = [globalThis.fetch, Sources.retry.delay];
  globalThis.fetch = async url => {
    calls.push(url);
    const [status, body] = await handler(url, calls);
    return {ok: status < 400, status, statusText: 'x', json: async () => body};
  };
  Sources.retry.delay = 0;
  try { await run(calls); } finally { [globalThis.fetch, Sources.retry.delay] = saved; }
};
const manifestOf = id => IA_INPUTS.manifests.find(m => m.id === id).manifest;
const metadataOf = id => IA_INPUTS.metadata.find(m => m.id === id).metadata;
const iaPdfBlob = () => new Blob(['%PDF-1.4 fixture']);

test('ia/search validates the query and returns the sources.py shape', iaWorld(async () => [200, IA_INPUTS.searches[0].response], async calls => {
  const {router} = await fresh();
  await status(router.handle('GET', '/api/ia/search?q=%20'), 400);
  const out = await router.handle('GET', '/api/ia/search?q=x');
  assert.deepEqual(out[0], {id: 'synthetic-book', title: 'Synthetic', creator: 'A; B', date: '1900', imagecount: 120, thumb: 'https://archive.org/services/img/synthetic-book'});
  assert.deepEqual([out[1].title, out[1].imagecount, out[2].creator], ['T1; T2', null, '']);
  assert.match(calls[0], /^https:\/\/archive\.org\/advancedsearch\.php\?q=%28x%29\+AND\+mediatype%3Atexts&rows=20&output=json/);
}));

test('ia/search reports a network failure in Japanese', iaWorld(async () => { throw new TypeError('Failed to fetch'); }, async () => {
  const {router} = await fresh();
  await assert.rejects(router.handle('GET', '/api/ia/search?q=x'), e => e.status === 400 && e.message.startsWith('Internet Archive を検索できませんでした: Internet Archive に接続できませんでした'));
}));

test('source/ia stages a source from the manifest, retrying 504s, and mapping confirms it like server.py', iaWorld(async (url, calls) => (calls.length < 3 ? [504, {}] : [200, manifestOf('synthetic-book')]), async calls => {
  const {router, slug} = await fresh();
  await status(router.handle('POST', `/api/projects/${slug}/source/ia`, {id: 'bad id!'}), 400);
  await status(router.handle('POST', `/api/projects/${slug}/source/ia`, {}), 400);
  const staged = await router.handle('POST', `/api/projects/${slug}/source/ia`, {id: ' https://archive.org/details/synthetic-book/page/n3 '});
  assert.equal(calls.length, 3);
  assert.equal(calls[0], 'https://iiif.archive.org/iiif/synthetic-book/manifest.json');
  assert.deepEqual([staged.draft.type, staged.draft.id, staged.draft.title, staged.draft.count, 'pages' in staged.draft, /^[0-9a-f]{32}$/.test(staged.draft.revision)], ['ia', 'synthetic-book', 'Synthetic Book', 3, false, true]);
  assert.equal(staged.source, null);  // 確定するまで何も変わらない
  const img = await router.handle('GET', `/api/projects/${slug}/image?index=1&draft=${staged.draft.revision}`);
  assert.deepEqual([img.index, img.count, img.label, img.w, img.h, img.url, 'pdf' in img], [1, 3, '1', 1000, 1500, undefined, false]);
  assert.equal(img.service, 'https://iiif.example.invalid/image/iiif/3/synthetic%2F1');  // iiif.archive.org ではないので url は付かない（D-31）
  assert.equal(img.unavailable, Sources.FOREIGN_SERVICE);
  await status(router.handle('GET', `/api/projects/${slug}/image?index=1&draft=nope`), 409);
  assert.deepEqual((await router.handle('GET', `/api/projects/${slug}/image?index=9&draft=${staged.draft.revision}`)), {index: 9, missing: true, count: 3});
  const done = await router.handle('POST', `/api/projects/${slug}/mapping`, {source: staged.draft.revision, offset: 1, clear_anchors: true});
  assert.deepEqual([done.source.type, done.source.count, done.source.revision === staged.draft.revision, done.offset, 'pages' in done.source], ['ia', 3, true, 1, false]);
  const pg = (await router.handle('GET', `/api/projects/${slug}/pages/0`)).image;
  assert.deepEqual([pg.index, pg.label, pg.url, pg.unavailable], [1, '1', undefined, Sources.FOREIGN_SERVICE]);
  assert.equal((await LocalStore.getProject(slug)).source.pages.length, 3);
}));

test('source/ia fails in Japanese when the manifest never loads, has no images, or has no usable canvases', iaWorld(async url => {
  if (url.includes('/down/')) throw new TypeError('Failed to fetch');
  if (url.includes('/gone/')) return [404, {}];
  return [200, manifestOf(url.includes('/empty/') ? 'empty' : 'missing-services')];
}, async calls => {
  const {router, slug} = await fresh();
  await assert.rejects(router.handle('POST', `/api/projects/${slug}/source/ia`, {id: 'down'}), e => e.status === 400 && e.message === `この資料のページ画像を取得できませんでした: ${Sources.UNAVAILABLE}`);
  assert.equal(calls.length, 3);
  await assert.rejects(router.handle('POST', `/api/projects/${slug}/source/ia`, {id: 'gone'}), e => /^この資料のページ画像を取得できませんでした: 404 x: /.test(e.message));
  await assert.rejects(router.handle('POST', `/api/projects/${slug}/source/ia`, {id: 'empty'}), e => e.message === 'この資料にはページ画像がありません');
  assert.equal((await router.handle('POST', `/api/projects/${slug}/source/ia`, {id: 'missing-services'})).draft.count, 2);  // service の無い canvas は数えない
  await status(router.handle('POST', '/api/projects/nope/source/ia', {id: 'missing-services'}), 404);
}));

const iaProject = async (router, slug, patch = {}) => {
  await LocalStore.updateProject(slug, p => { p.source = {type: 'ia', id: 'book', revision: 'rev1', title: 'B', pages: Array.from({length: 3}, (_, i) => ({label: String(i), service: `https://iiif.archive.org/image/iiif/3/x%2Fs${i}`, w: 1, h: 2})), ...patch}; });
};

test('only iiif.archive.org services get an image url; any other host is unavailable (browser-only restriction, D-31)', async () => {
  const {router, slug} = await fresh();
  const good = 'https://iiif.archive.org/image/iiif/3/b%2F0';
  const services = [good, 'https://evil.example/iiif/b%2F1', 'http://iiif.archive.org/x', 'https://iiif.archive.org.evil.example/x', 'data:image/png;base64,AAAA', '', null];
  await LocalStore.updateProject(slug, p => { p.source = {type: 'ia', id: 'book', revision: 'r', pages: services.map((service, i) => ({label: String(i), service, w: 1, h: 1}))}; });
  const at = async i => (await router.handle('GET', `/api/projects/${slug}/image?index=${i}`));
  assert.equal((await at(0)).url, `${good}/full/1600,/0/default.jpg`);
  assert.equal('unavailable' in await at(0), false);
  for (let i = 1; i < services.length; i++) {
    const im = await at(i);
    assert.deepEqual([im.url, im.pdf, im.unavailable, im.service, im.index, im.count], [undefined, undefined, Sources.FOREIGN_SERVICE, services[i], i, services.length]);
  }
  assert.match(Sources.FOREIGN_SERVICE, /ブラウザ版では表示できません/);
  assert.doesNotMatch(Sources.FOREIGN_SERVICE, /応答しません/);
  router.revokeUrls();
});

test('a backup restored with a foreign image service shows the message, and an attached PDF still wins', iaWorld(async () => [200, metadataOf('pdf-formats')], async () => {
  const {router, slug} = await fresh();
  await iaProject(router, slug, {pages: Array.from({length: 3}, (_, i) => ({label: String(i), service: `https://evil.example/s${i}`, w: 1, h: 2})), pdf_file: 'ia-rev1.pdf'});
  const im = (await router.handle('GET', `/api/projects/${slug}/pages/1`)).image;
  assert.deepEqual([im.url, im.pdf, im.unavailable], [undefined, undefined, Sources.FOREIGN_SERVICE]);
  await router.handle('POST', `/api/projects/${slug}/source/ia/pdf/attach`, iaPdfBlob(), {'X-Revision': 'rev1', 'X-Page-Count': '3'});
  const withPdf = (await router.handle('GET', `/api/projects/${slug}/pages/1`)).image;
  assert.deepEqual([typeof withPdf.pdf, 'unavailable' in withPdf, 'url' in withPdf], ['string', false, false]);
  router.revokeUrls();
}));

test('ia pdf status, attach and detach mirror server.py; the file is chosen by the user and stored with the source in one step', iaWorld(async () => [200, metadataOf('pdf-formats')], async calls => {
  const {router, slug} = await fresh();
  const base = `/api/projects/${slug}/source/ia/pdf`;
  await status(router.handle('GET', base), 400);  // IA の資料ではない
  await iaProject(router, slug);
  let st = await router.handle('GET', base);
  assert.deepEqual(st, {available: {name: 'd.pdf', size: 300, format: 'Image Container PDF'}, attached: null, job: null, pending: null, revision: 'rev1', v: 'rev1', mismatch: ''});
  await router.handle('GET', base);
  assert.equal(calls.length, 1);  // server.py と同じく revision ごとに1回だけ取得する
  await status(router.handle('POST', base, {}), 501);  // サーバー側のダウンロードは無い
  const attach = (body, headers) => router.handle('POST', `${base}/attach`, body, headers);
  const h = (pages, revision = 'rev1') => ({'X-Revision': revision, 'X-Page-Count': String(pages)});
  await assert.rejects(attach(iaPdfBlob(), h(3, 'old')), e => e.status === 409);
  await assert.rejects(attach(new Blob(['no']), h(3)), e => e.status === 400 && e.message === 'PDFファイルではありません');
  await assert.rejects(attach(iaPdfBlob(), h(2)), e => e.status === 400 && e.message === 'PDFのページ数（2）が資料の画像数（3）と一致しないため使えません');
  await assert.rejects(attach(iaPdfBlob(), h('x')), e => e.status === 400 && e.message === 'ページ数が正しくありません');
  const huge = iaPdfBlob(); Object.defineProperty(huge, 'size', {value: 500 * 1024 * 1024 + 1});
  await assert.rejects(attach(huge, h(3)), e => e.status === 413);
  assert.equal(LocalStore.files.size, 0);  // 失敗では何も保存しない
  assert.equal((await LocalStore.getProject(slug)).source.pdf_file, undefined);
  const done = await attach(iaPdfBlob(), h(3));
  assert.equal(done.source.pdf_file, 'ia-rev1.pdf');
  assert.deepEqual([...LocalStore.files.keys()], [`${slug}/ia-rev1.pdf`]);
  st = await router.handle('GET', base);
  assert.deepEqual([st.attached, st.pending, st.v], ['ia-rev1.pdf', null, `rev1-${iaPdfBlob().size}`]);
  const image = (await router.handle('GET', `/api/projects/${slug}/pages/1`)).image;
  assert.deepEqual([typeof image.pdf, 'url' in image, image.index, image.service], ['string', false, 1, 'https://iiif.archive.org/image/iiif/3/x%2Fs1']);
  const detached = await router.handle('POST', `${base}/detach`);
  assert.equal(detached.source.pdf_file, undefined);
  assert.equal(LocalStore.files.size, 0);
  const back = (await router.handle('GET', `/api/projects/${slug}/pages/1`)).image;
  assert.deepEqual([back.url, 'pdf' in back], ['https://iiif.archive.org/image/iiif/3/x%2Fs1/full/1600,/0/default.jpg', false]);
  assert.equal((await router.handle('GET', base)).attached, null);
  router.revokeUrls();
}));

test('an IA project restored from a backup (pdf_file without a Blob) shows the online image; switching sources removes the old PDF', iaWorld(async () => [200, manifestOf('synthetic-book')], async () => {
  const {router, slug} = await fresh();
  await iaProject(router, slug, {pdf_file: 'ia-rev1.pdf'});
  const im = (await router.handle('GET', `/api/projects/${slug}/pages/0`)).image;
  assert.deepEqual([im.url, 'pdf' in im, 'no_file' in im], ['https://iiif.archive.org/image/iiif/3/x%2Fs0/full/1600,/0/default.jpg', false, false]);
  await router.handle('POST', `/api/projects/${slug}/source/ia/pdf/attach`, iaPdfBlob(), {'X-Revision': 'rev1', 'X-Page-Count': '3'});
  assert.equal(LocalStore.files.size, 1);
  const staged = await router.handle('POST', `/api/projects/${slug}/source/ia`, {id: 'synthetic-book'});
  await router.handle('POST', `/api/projects/${slug}/mapping`, {source: staged.draft.revision});
  assert.equal(LocalStore.files.size, 0);
  assert.equal((await LocalStore.getProject(slug)).source.pdf_file, undefined);
  router.revokeUrls();
}));

test('DELETE removes the project, its work, files and staged source like server.py, and only that project', async () => {
  const {router, slug} = await fresh();
  const other = (await router.handle('POST', '/api/projects/upload-text', new Blob([TEXT]), {'X-Filename': 'other.mARkdown'})).slug;
  await router.handle('PUT', `/api/projects/${slug}/pages/0`, {text: 'edited', revision: 0});
  await router.handle('PUT', `/api/projects/${other}/pages/0`, {text: 'kept', revision: 0});
  const staged = await router.handle('POST', `/api/projects/${slug}/source/pdf`, pdfBlob(), {'X-Page-Count': '3', 'X-Filename': 'a.pdf'});
  await router.handle('POST', `/api/projects/${slug}/mapping`, {source: staged.draft.revision, offset: 0});
  await router.handle('POST', `/api/projects/${slug}/source/pdf`, pdfBlob('%PDF-two'), {'X-Page-Count': '3', 'X-Filename': 'b.pdf'});  // 未確定の資料
  await router.handle('GET', `/api/projects/${slug}/pages/0`);
  assert.ok(router.urlsOf(slug, true).length >= 1);
  assert.deepEqual(await router.handle('DELETE', `/api/projects/${slug}`), {deleted: slug});
  await status(router.handle('GET', `/api/projects/${slug}`), 404);
  await status(router.handle('DELETE', `/api/projects/${slug}`), 404);
  assert.deepEqual([...LocalStore.files.keys()].filter(k => k.startsWith(slug + '/')), []);
  assert.deepEqual(await LocalStore.pages(slug), {});
  assert.deepEqual(router.urlsOf(slug, true), []);
  assert.equal((await router.handle('GET', '/api/projects')).length, 1);
  assert.equal((await router.handle('GET', `/api/projects/${other}/pages/0`)).text, 'kept');
  await status(router.handle('DELETE', '/api/projects/..'), 404);
  await status(router.handle('DELETE', '/api/projects/a%2Fb'), 404);
  router.revokeUrls();
});

// ---------- OCR（段階3）：API の呼び出しは OCR.transcribe の差し替えで、画像の取得は fetch の差し替えで確かめる ----------
const KEY = 'sk-ant-api03-test-key-0123456789';
const ocrWorld = run => async () => {
  const saved = [globalThis.OCR, globalThis.fetch, Sources.retry.delay];
  const world = {calls: [], fetches: [], image: new Uint8Array([0xff, 0xd8, 1, 2, 3]), imageStatus: 200, next: null};
  globalThis.OCR = {...OCR, transcribe: async (data, mtype, model, apiKey) => {
    world.calls.push({data, mtype, model, apiKey});
    if (world.next) return world.next(model);
    model = model || OCR.MODEL;
    return {text: `reading ${world.calls.length}`, model, truncated: false, usage: {input: 1500, output: 300}, provider: 'anthropic', requested_model: model, prompt_version: OCR.PROMPT_VERSION};
  }};
  globalThis.fetch = async url => {
    world.fetches.push(url);
    const status = world.imageStatus;
    return {ok: status < 400, status, statusText: 'x', headers: {get: () => 'image/jpeg'}, arrayBuffer: async () => world.image.buffer.slice(0)};
  };
  Sources.retry.delay = 0;
  try { await run(world); } finally { [globalThis.OCR, globalThis.fetch, Sources.retry.delay] = saved; }
};
const setKey = (router, save = false) => router.handle('PUT', '/api/ai/keys/anthropic', {key: KEY, save});
const ocrUrl = (slug, i = 0) => `/api/projects/${slug}/pages/${i}/ocr`;

test('AI keys: kept in the tab by default, saved only on request, never returned, removed by DELETE (D-36)', async () => {
  const {router, slug} = await fresh();
  assert.deepEqual(await router.handle('GET', '/api/ai/keys'), {anthropic: {set: false, saved: false}});
  let p = await router.handle('GET', `/api/projects/${slug}`);
  assert.deepEqual([p.ocr, p.ocr_providers.anthropic.available, p.ocr_providers.openai.available], [false, false, false]);
  assert.match(p.ocr_providers.anthropic.reason, /AI の設定/);
  assert.deepEqual(p.ocr_providers.anthropic.models, OCR.MODELS);
  for (const key of ['', '   ', 'short', 'sk-ant-has space-inside', 'sk-ant-\u3042\u3044\u3046\u3048\u304a\u304b', 'x'.repeat(501), 5, null])
    await assert.rejects(router.handle('PUT', '/api/ai/keys/anthropic', {key, save: true}), e => e.status === 400, String(key));
  assert.equal(LocalStore.settings.size, 0);
  assert.deepEqual(await setKey(router), {anthropic: {set: true, saved: false}});
  assert.equal(LocalStore.settings.has('key:anthropic'), false);   // タブの中だけ
  p = await router.handle('GET', `/api/projects/${slug}`);
  assert.equal(p.ocr, true);
  assert.equal(JSON.stringify(p).includes(KEY), false);
  assert.equal(JSON.stringify(await router.handle('GET', '/api/ai/keys')).includes(KEY), false);
  assert.deepEqual(await setKey(router, true), {anthropic: {set: true, saved: true}});
  assert.equal(LocalStore.settings.get('key:anthropic'), KEY);
  assert.deepEqual(await setKey(router, false), {anthropic: {set: true, saved: false}});  // 「保存する」を外すと保存した分も消える
  assert.equal(LocalStore.settings.has('key:anthropic'), false);
  await setKey(router, true);
  assert.deepEqual(await router.handle('DELETE', '/api/ai/keys/anthropic'), {anthropic: {set: false, saved: false}});
  assert.equal(LocalStore.settings.size, 0);
  assert.equal((await router.handle('GET', `/api/projects/${slug}`)).ocr, false);
  // 保存したキーは、新しいタブ（新しいルーター）で読み込まれる。プロジェクトを削除してもキーは消えない
  await setKey(router, true);
  // 別のタブが保存したキーは、このタブで「このタブだけ」に設定し直すと IndexedDB からも消える（D-43 (4)）
  delete require.cache[require.resolve('../proofreader/static/local/router.js')];
  const tab3 = require('../proofreader/static/local/router.js');
  await tab3.handle('PUT', '/api/ai/keys/anthropic', {key: KEY + '3', save: false});   // tab3 はまだ保存の有無を確かめていない
  assert.equal(LocalStore.settings.has('key:anthropic'), false);
  await setKey(router, true);
  delete require.cache[require.resolve('../proofreader/static/local/router.js')];
  const tab2 = require('../proofreader/static/local/router.js');
  assert.deepEqual(await tab2.handle('GET', '/api/ai/keys'), {anthropic: {set: true, saved: true}});
  await tab2.handle('DELETE', `/api/projects/${slug}`);
  assert.equal(LocalStore.settings.get('key:anthropic'), KEY);
  delete require.cache[require.resolve('../proofreader/static/local/router.js')];
  assert.deepEqual(await require('../proofreader/static/local/router.js').handle('GET', '/api/ai/keys'), {anthropic: {set: true, saved: true}});
});

test('OCR on an IA page: fetches the IIIF image at 2000 px, saves the reading with its image key, reuses it like server.py run_ocr', ocrWorld(async world => {
  const {router, slug} = await fresh();
  await iaProject(router, slug);
  const url = ocrUrl(slug);
  await status(router.handle('POST', url, {}), 503);   // キーが無い
  assert.deepEqual([world.calls.length, world.fetches.length], [0, 0]);
  await setKey(router);
  const pg = await router.handle('GET', `/api/projects/${slug}/pages/0`);
  assert.equal(pg.ocr, null);
  const r1 = await router.handle('POST', url, {image_key: pg.image.key, model: 'claude-opus-5-5', provider: 'anthropic'});
  assert.deepEqual(world.fetches, ['https://iiif.archive.org/image/iiif/3/x%2Fs0/full/2000,/0/default.jpg']);
  assert.deepEqual([world.calls[0].mtype, world.calls[0].model, world.calls[0].apiKey, [...world.calls[0].data]], ['image/jpeg', 'claude-opus-5-5', KEY, [0xff, 0xd8, 1, 2, 3]]);
  assert.deepEqual([r1.text, r1.image_index, r1.image_key, r1.provider, r1.usage], ['reading 1', 0, pg.image.key, 'anthropic', {input: 1500, output: 300}]);
  assert.match(r1.reading_id, /^[0-9a-f]{32}$/);
  assert.match(r1.time, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.equal(JSON.stringify(r1).includes(KEY), false);
  assert.deepEqual((await router.handle('GET', `/api/projects/${slug}/pages/0`)).ocr, r1);
  // 同じ条件なら API を呼ばずに保存した読みを返す。force・別のモデル・別の提供元では呼び直す
  assert.deepEqual(await router.handle('POST', url, {image_key: pg.image.key, model: 'claude-opus-5-5'}), r1);
  assert.deepEqual(await router.handle('POST', url, {}), r1);
  assert.equal(world.calls.length, 1);
  const r2 = await router.handle('POST', url, {force: true, model: 'claude-opus-5-5'});
  assert.equal(r2.text, 'reading 2');
  const r3 = await router.handle('POST', url, {model: 'claude-sonnet-5-5'});
  assert.deepEqual([r3.text, r3.requested_model, world.calls.length], ['reading 3', 'claude-sonnet-5-5', 3]);
  assert.equal((await router.handle('GET', `/api/projects/${slug}/pages/0`)).ocr.reading_id, r3.reading_id);
  assert.deepEqual((await router.handle('GET', `/api/projects/${slug}/pages/0/readings`)).map(r => r.text).sort(), ['reading 1', 'reading 2', 'reading 3']);
  // 別のページ・別の画像には混ざらない
  assert.equal((await router.handle('GET', `/api/projects/${slug}/pages/1`)).ocr, null);
  assert.deepEqual(await router.handle('GET', `/api/projects/${slug}/pages/1/readings`), []);
}));

test('OCR refusals follow run_ocr: wrong image key 409, no image 400, OpenAI 501, API errors 503, nothing saved on failure', ocrWorld(async world => {
  const {router, slug} = await fresh();
  const url = ocrUrl(slug);
  await status(router.handle('POST', url, {}), 400);   // 資料が無い
  await iaProject(router, slug);
  await setKey(router);
  await assert.rejects(router.handle('POST', url, {image_key: 'stale'}), e => e.status === 409 && e.message === '画像の対応が変更されています。ページを開き直してください');
  await assert.rejects(router.handle('POST', url, {provider: 'openai', model: 'gpt-x'}), e => e.status === 501 && /OpenAI はブラウザ版ではまだ使えません/.test(e.message));
  await assert.rejects(router.handle('POST', ocrUrl(slug, 9), {}), e => e.status === 404);
  assert.equal(world.calls.length, 0);
  world.next = () => { throw new OCR.Unavailable('このページは読み取りを断られました'); };
  await assert.rejects(router.handle('POST', url, {}), e => e.status === 503 && e.message === 'このページは読み取りを断られました');
  world.next = () => { throw new TypeError('boom'); };
  await assert.rejects(router.handle('POST', url, {}), e => e instanceof TypeError);
  assert.deepEqual(await router.handle('GET', `/api/projects/${slug}/pages/0/readings`), []);
  assert.equal(LocalStore.ocr.size, 0);
  // 画像：5 MB を超える・取得できない・別のホスト
  world.next = null;
  world.image = new Uint8Array(5 * 1024 * 1024 + 1);
  await status(router.handle('POST', url, {}), 413);
  world.image = new Uint8Array(3932160 + 1);   // 生のバイト数は 5 MB 未満でも、base64 にすると 5 MB を超える
  await status(router.handle('POST', url, {}), 413);
  world.image = new Uint8Array(3932160);       // base64 でちょうど 5 MB は通る
  await router.handle('POST', url, {});
  assert.equal(world.calls.at(-1).data.length, 3932160);
  LocalStore.ocr.clear();
  world.image = new Uint8Array([1]);
  world.imageStatus = 404;
  await assert.rejects(router.handle('POST', url, {}), e => e.status === 502 && /ページ画像を取得できませんでした/.test(e.message));
  world.imageStatus = 504;
  world.fetches.length = 0;
  await assert.rejects(router.handle('POST', url, {}), e => e.status === 502 && e.message.includes(Sources.UNAVAILABLE));
  assert.equal(world.fetches.length, Sources.retry.tries);   // 5xx は再試行する
  await LocalStore.updateProject(slug, p => { p.source.pages[1].service = 'https://evil.example/x'; });
  world.fetches.length = 0;
  await assert.rejects(router.handle('POST', ocrUrl(slug, 1), {}), e => e.message === Sources.FOREIGN_SERVICE);
  assert.deepEqual(world.fetches, []);   // 別のホストへは要求しない
  assert.equal(LocalStore.ocr.size, 0);
}));

test('OCR: a mapping change while the API call is in flight saves nothing (409); the reading follows the image key afterwards (D-38)', ocrWorld(async world => {
  const {router, slug} = await fresh();
  await iaProject(router, slug);
  await setKey(router);
  const url = ocrUrl(slug);
  world.next = async model => {
    await router.handle('POST', `/api/projects/${slug}/mapping`, {anchor: [0, 1]});
    return {text: 'late', model, truncated: false, usage: {input: 1, output: 1}, provider: 'anthropic', requested_model: model, prompt_version: 'v'};
  };
  await assert.rejects(router.handle('POST', url, {}), e => e.status === 409 && /読み取り中に画像の対応が変更されました/.test(e.message));
  assert.equal(LocalStore.ocr.size, 0);
  world.next = null;
  const r = await router.handle('POST', url, {});   // いまの対応（画像 1）で読む
  assert.equal(r.image_index, 1);
  await router.handle('POST', `/api/projects/${slug}/mapping`, {anchor: [0, 2]});
  assert.equal((await router.handle('GET', `/api/projects/${slug}/pages/0`)).ocr, null);   // 別の画像の読みは出さない
  assert.deepEqual(await router.handle('GET', `/api/projects/${slug}/pages/0/readings`), []);
  await router.handle('POST', `/api/projects/${slug}/mapping`, {anchor: [0, 1]});
  assert.equal((await router.handle('GET', `/api/projects/${slug}/pages/0`)).ocr.reading_id, r.reading_id);   // 戻すと、その画像の読みが出る
}));

test('OCR on a PDF page: the page image comes from the screen as a data URL, like http mode', ocrWorld(async world => {
  const {router, slug} = await fresh();
  const staged = await router.handle('POST', `/api/projects/${slug}/source/pdf`, pdfBlob(), {'X-Page-Count': '3', 'X-Filename': 'a.pdf'});
  await router.handle('POST', `/api/projects/${slug}/mapping`, {source: staged.draft.revision, offset: 0});
  await setKey(router);
  const url = ocrUrl(slug);
  for (const image of [undefined, '', 'data:image/gif;base64,AAAA', 'data:image/jpeg;base64,', 'http://x/y.jpg'])
    await assert.rejects(router.handle('POST', url, {image}), e => e.status === 400 && /PDFのページ画像が送られていません/.test(e.message));
  await assert.rejects(router.handle('POST', url, {image: 'data:image/png;base64,@@@'}), e => e.status === 400);
  assert.equal(world.calls.length, 0);
  const r = await router.handle('POST', url, {image: 'data:image/png;base64,' + Buffer.from([1, 2, 3, 4]).toString('base64')});
  assert.deepEqual([world.calls[0].mtype, [...world.calls[0].data], world.fetches.length], ['image/png', [1, 2, 3, 4], 0]);
  assert.equal(r.image_index, 0);
  assert.equal((await router.handle('POST', url, {})).reading_id, r.reading_id);   // 保存した読みは画像なしでも返す
  // バックアップから戻して PDF が無い資料
  LocalStore.files.delete(`${slug}/${(await LocalStore.getProject(slug)).source.file}`);
  router.revokeUrls();
  await assert.rejects(router.handle('POST', ocrUrl(slug, 1), {image: 'data:image/png;base64,AAAA'}), e => e.status === 400 && /PDFが付いていません/.test(e.message));
  router.revokeUrls();
}));

test('legacy readings from a Python backup (no image key) show as legacy only on the IA image they were read from', ocrWorld(async () => {
  const {router, slug} = await fresh();
  await iaProject(router, slug);
  LocalStore.ocr.set(`${slug}\0` + 0, [{text: 'old', reading_id: 'legacy', image_index: 0}]);
  LocalStore.ocr.set(`${slug}\0` + 1, [{text: 'old1', reading_id: 'legacy', image_index: 5}]);
  const p0 = await router.handle('GET', `/api/projects/${slug}/pages/0`);
  assert.deepEqual([p0.ocr.text, p0.ocr.legacy], ['old', true]);
  assert.equal((await router.handle('GET', `/api/projects/${slug}/pages/1`)).ocr, null);
  assert.deepEqual(await router.handle('GET', `/api/projects/${slug}/pages/0/readings`), []);
}));

test('deleting a project removes its readings in the same step; a backup carries them and restores them (D-38, D-42)', ocrWorld(async () => {
  const {router, slug} = await fresh();
  const other = (await router.handle('POST', '/api/projects/upload-text', new Blob([TEXT]), {'X-Filename': 'other.mARkdown'})).slug;
  for (const s of [slug, other]) await iaProject(router, s);
  await setKey(router, true);
  const mine = await router.handle('POST', ocrUrl(slug), {}), kept = await router.handle('POST', ocrUrl(other), {});
  await router.handle('POST', ocrUrl(slug), {force: true});
  const exported = JSON.parse(new TextDecoder().decode((await router.handle('GET', `/api/projects/${slug}/export?fmt=bundle`)).data));
  assert.equal(exported.format_version, 2);
  assert.deepEqual(exported.ocr[0].history.map(r => r.text), ['reading 1', 'reading 3']);
  assert.equal(JSON.stringify(exported).includes(KEY), false);
  const plain = JSON.parse(new TextDecoder().decode((await router.handle('GET', `/api/projects/${slug}/export?fmt=bundle&ocr=0`)).data));
  assert.deepEqual([plain.format_version, 'ocr' in plain], [1, false]);
  const copy = (await router.handle('POST', '/api/projects/import-bundle', exported)).slug;
  const restored = await router.handle('GET', `/api/projects/${copy}/pages/0`);
  assert.equal(restored.ocr.text, 'reading 3');   // 資料の画像の key は同じ資料なので一致する
  assert.equal((await router.handle('GET', `/api/projects/${copy}/pages/0/readings`)).length, 2);
  await router.handle('DELETE', `/api/projects/${slug}`);
  assert.deepEqual([...LocalStore.ocr.keys()].filter(k => k.startsWith(slug + '\0')), []);
  assert.equal((await router.handle('GET', `/api/projects/${other}/pages/0`)).ocr.reading_id, kept.reading_id);
  assert.ok(mine.reading_id);
  assert.equal(LocalStore.settings.get('key:anthropic'), KEY);   // キーは消えない
}));
