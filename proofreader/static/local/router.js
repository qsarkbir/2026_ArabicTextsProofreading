// server.py のルートのうち、ブラウザ内で動くものを同じ URL・応答の形で受ける。知らない URL は 501。
const LocalRouter = (() => {
  const UNSUPPORTED = 'この機能はローカル版で利用できます';
  const NO_PAGES = 'ページ区切り（PageV..P..）がないテキストは校正できません';
  const err = (message, status = 400) => new Work.ApiError(message, status);
  const routes = [];
  const route = (method, pattern, fn) => routes.push([method, new RegExp(`^${pattern}$`), fn]);

  const handle = async (method, url, body, headers = {}) => {
    const [path, search = ''] = url.split('#')[0].split(/\?(.*)/s); // new URL() は ".." を畳み込んでしまう
    for (const [m, rx, fn] of routes) {
      const found = m === method ? rx.exec(path) : null;
      if (found) return fn({...found.groups, query: new URLSearchParams(search), body, headers});
    }
    throw err(UNSUPPORTED, 501);
  };

  const slugOf = slug => {
    if (slug === '.' || slug === '..' || !/^[A-Za-z0-9._-]+$/.test(slug)) throw err('見つかりません', 404);
    return slug;
  };
  const loadProject = async slug => {
    const p = await LocalStore.getProject(slugOf(slug));
    if (!p) throw err('見つかりません', 404);
    return p;
  };
  const pageIndex = async (slug, i) => {
    i = Number(i);
    if (!(i >= 0 && i < (await LocalStore.parts(slug)).pages.length)) throw err('ページ番号が範囲外です', 404);
    return i;
  };
  const keysOf = (records, pick) => Object.keys(records).map(Number).filter(k => pick(records[k])).sort((a, b) => a - b);
  const object = b => (b && typeof b === 'object' && !Array.isArray(b) ? b : {});

  const projectView = async slug => {
    const p = await loadProject(slug), parts = await LocalStore.parts(slug), records = await LocalStore.pages(slug);
    return {
      slug: p.slug, uri: p.uri, raw_url: p.raw_url, title: p.title, author: p.author, created: p.created,
      candidates: p.candidates, offset: p.offset, anchors: p.anchors, source: null,
      pages: parts.pages.map(pg => ({vol: pg.vol, page: pg.page, unassigned: !!pg.unassigned})),
      edited: keysOf(records, r => r.text !== undefined),
      done: keysOf(records, r => r.done),
      noted: keysOf(records, r => r.note),
      ocr: false, ocr_reason: UNSUPPORTED, ocr_models: {}, ocr_providers: {},
      bibliography: p.bibliography || {}, draft: !!p.draft,
    };
  };

  const createFrom = async fetched => {
    if (!OpenITI.split(fetched.text).pages.length) throw err(NO_PAGES);
    return projectView((await LocalStore.createProject(fetched)).slug);
  };

  // ---------- projects ----------
  route('GET', '/api/projects', async () => {
    const out = [], backups = await LocalStore.backupTimes();
    for (const p of (await LocalStore.listProjects()).sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))) {
      try {
        const parts = await LocalStore.parts(p.slug), records = await LocalStore.pages(p.slug);
        out.push({slug: p.slug, uri: p.uri, title: p.title, author: p.author, created: p.created, source: !!p.source,
          pages: parts.pages.length, done: keysOf(records, r => r.done).length, edited: keysOf(records, r => r.text !== undefined).length,
          backup: backups[p.slug] || null});
      } catch { /* 壊れたプロジェクトは一覧から外す（server.py と同じ） */ }
    }
    return out;
  });

  route('POST', '/api/projects', async ({body}) => {
    const ref = String(object(body).ref || '').trim();
    if (!ref) throw err('OpenITIのURIかURLを入力してください');
    try { OpenITI.resolve(ref); } catch (e) { throw err(e.message); }
    let fetched;
    try { fetched = await OpenITI.fetchText(ref); } catch (e) { throw err(`テキストを取得できませんでした: ${e.message}`); }
    return createFrom(fetched);
  });

  route('POST', '/api/projects/import-bundle', async ({body}) => {
    const data = typeof body === 'string' ? (() => { try { return JSON.parse(body); } catch { throw err('JSONとして読めません'); } })() : body;
    return projectView((await LocalStore.importBundle(Bundle.parse(data))).slug);
  });

  route('POST', '/api/projects/upload-text', async ({body, headers}) => {
    let name = headers['X-Filename'] || 'text.txt';
    try { name = decodeURIComponent(name); } catch { /* そのまま使う */ }
    let text;
    try {
      const buf = body instanceof Blob ? await body.arrayBuffer() : body;
      text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(buf);
    } catch { throw err('UTF-8のテキストファイルを選択してください'); }
    return createFrom({uri: name.replace(/\.(txt|mARkdown|completed|inProgress)$/, ''), raw_url: '', text, meta: {}});
  });

  route('GET', '/api/projects/(?<slug>[^/]+)', ({slug}) => projectView(slug));

  route('PUT', '/api/projects/(?<slug>[^/]+)/bibliography', async ({slug, body}) => {
    const b = object(body), keys = ['title', 'author', 'edition', 'source', 'rights'];
    const value = k => (k in b ? b[k] : '');
    if (keys.some(k => typeof value(k) !== 'string')) throw err('書誌情報は文字列で指定してください');
    await loadProject(slug);
    const t = k => OpenITI.pyStrip(value(k));
    await LocalStore.updateProject(slug, p => {
      p.title = t('title'); p.author = t('author');
      p.bibliography = {edition: t('edition'), source: t('source'), rights: t('rights')};
    });
    return projectView(slug);
  });

  const STOP = new Set(['في', 'من', 'على', 'ابن', 'بن', 'كتاب', 'Ibn', 'ibn', 'al', 'Kitab']);
  // sources.search_terms：題名と著者の長い語を3つまで
  const searchTerms = (title, author) => {
    const len = w => [...w].length;
    const words = `${title} ${author}`.split(/[\s،,:.\-]+/).filter(w => len(w) > 2 && !STOP.has(w));
    const seen = [];
    for (const w of words.sort((a, b) => len(b) - len(a))) if (!seen.includes(w)) seen.push(w);
    return seen.slice(0, 3).join(' ');
  };
  route('GET', '/api/projects/(?<slug>[^/]+)/search-terms', async ({slug}) => {
    const p = await loadProject(slug);
    return {q: searchTerms(p.title, p.author)};
  });

  // ---------- pages ----------
  route('GET', '/api/projects/(?<slug>[^/]+)/search', async ({slug, query}) => {
    await loadProject(slug);
    const q = OpenITI.pyStrip((query.get('q') || '').toLowerCase()), kind = query.get('filter') || 'all';
    const records = await LocalStore.pages(slug), found = [];
    (await LocalStore.parts(slug)).pages.forEach((pg, i) => {
      const r = records[i] || {};
      if (kind === 'todo' && r.done || kind === 'edited' && r.text === undefined || kind === 'noted' && !r.note) return;
      const note = r.note || '';
      if (q && !(r.text ?? pg.text).toLowerCase().includes(q) && !note.toLowerCase().includes(q)) return;
      found.push({i, marker: pg.marker || '未割当の末尾', note});
    });
    return found;
  });

  route('GET', '/api/projects/(?<slug>[^/]+)/pages/(?<i>\\d+)', async ({slug, i}) => {
    await loadProject(slug);
    i = await pageIndex(slug, i);
    const pg = (await LocalStore.parts(slug)).pages[i], r = (await LocalStore.page(slug, i)) || {};
    return {i, vol: pg.vol, page: pg.page, marker: pg.marker || '未割当の末尾', revision: r.revision || 0,
      unassigned: !!pg.unassigned, original: pg.text, text: r.text ?? pg.text, done: !!r.done, note: r.note || '',
      ocr: null, image: null};
  });

  route('PUT', '/api/projects/(?<slug>[^/]+)/pages/(?<i>\\d+)', async ({slug, i, body}) => {
    await loadProject(slug);
    i = await pageIndex(slug, i);
    const b = object(body);
    const saved = await LocalStore.savePage(slug, i, {text: b.text, done: b.done, note: b.note, revision: b.revision, checkpoint: b.checkpoint === true});
    return {...(await projectView(slug)), page: i, revision: saved.revision};
  });

  route('GET', '/api/projects/(?<slug>[^/]+)/pages/(?<i>\\d+)/history', async ({slug, i}) => {
    await loadProject(slug);
    i = await pageIndex(slug, i);
    return ((await LocalStore.page(slug, i)) || {}).history || [];
  });

  // ---------- export ----------
  const csvField = v => (/[",\r\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const notesCsv = (parts, records) => {
    const rows = [['index', 'marker', 'edited', 'done', 'note']];
    for (const k of Object.keys(records).map(Number).filter(k => records[k].text !== undefined || records[k].done || records[k].note).sort((a, b) => a - b)) {
      const r = records[k];
      rows.push([k, parts.pages[k].marker, r.text !== undefined ? 1 : 0, r.done ? 1 : 0, r.note || '']);
    }
    return '\ufeff' + rows.map(row => row.map(csvField).join(',') + '\r\n').join('');
  };

  route('GET', '/api/projects/(?<slug>[^/]+)/export', async ({slug, query}) => {
    const fmt = query.get('fmt') || 'text', p = await loadProject(slug);
    const parts = await LocalStore.parts(slug), records = await LocalStore.pages(slug);
    const file = (filename, type, text) => ({filename, type, data: new TextEncoder().encode(text)});
    if (fmt === 'text') {
      const edits = {};
      for (const [k, r] of Object.entries(records)) if (r.text !== undefined) edits[k] = r.text;
      return file(`${p.uri}.corrected`, 'text/plain; charset=utf-8', OpenITI.join(parts, edits));
    }
    if (fmt === 'notes') return file(`${p.uri}.notes.csv`, 'text/csv; charset=utf-8', notesCsv(parts, records));
    if (fmt === 'tei') {
      try { return {filename: `${p.uri}.tei.xml`, type: 'application/xml; charset=utf-8', data: TEI.export(p, parts, Work.recordsToWork(records)).data}; }
      catch (e) { throw err(e.message); }
    }
    if (fmt === 'bundle') {
      const src = await LocalStore.bundleSource(slug), now = new Date();
      const out = file(`${slug}.proofreader.json`, 'application/json; charset=utf-8', JSON.stringify(Bundle.build({...src, now}), null, 1));
      await LocalStore.setSetting(`backup:${slug}`, now.toISOString());
      return out;
    }
    if (['package', 'diff'].includes(fmt)) throw err(UNSUPPORTED, 501);
    throw err('不明な形式です');
  });

  return {UNSUPPORTED, handle, searchTerms, notesCsv, csvField};
})();

if (typeof module !== 'undefined') module.exports = LocalRouter;
