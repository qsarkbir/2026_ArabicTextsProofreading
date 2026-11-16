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
      if (found) {
        try { return await fn({...found.groups, query: new URLSearchParams(search), body, headers}); }
        finally { flushRetired(); }
      }
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

  // ---------- 資料（PDF）：server.py の source_view / image_for / DRAFTS に相当 ----------
  const PDF_LIMIT = 500 * 1024 * 1024;
  const DRAFTS = new Map(); // slug -> {src, blob}。確定（mapping）するまで保存しない
  const header = (headers, name) => { const k = Object.keys(headers).find(h => h.toLowerCase() === name.toLowerCase()); return k === undefined ? undefined : headers[k]; };
  const unquote = v => { try { return decodeURIComponent(v); } catch { return v; } };
  const int = v => { try { return Draft.pyInt(v); } catch { throw err('整数で指定してください'); } };
  const uuidHex = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join(''));
  const isPdf = async blob => blob instanceof Blob && new TextDecoder('latin1').decode(await blob.slice(0, 4).arrayBuffer()) === '%PDF';
  const sha256 = async text => {
    if (!(globalThis.crypto && crypto.subtle)) return text; // 安全でない接続では識別子のまま（等しいかどうかにしか使わない）
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), b => b.toString(16).padStart(2, '0')).join('');
  };
  const imageIndex = (project, i) => { // store.image_index
    let best = null;
    for (const [aPage, aImg] of project.anchors || []) if (aPage <= i && (best === null || aPage > best[0])) best = [aPage, aImg];
    return best ? best[1] + (i - best[0]) : (project.offset || 0) + i;
  };
  const tooLarge = blob => { if (blob instanceof Blob && blob.size > PDF_LIMIT) throw err('送信データが大きすぎます（上限500 MB）', 413); }; // server.py の body()
  const sourceView = src => src && {...Object.fromEntries(Object.entries(src).filter(([k]) => k !== 'pages')), count: src.type === 'ia' ? src.pages.length : src.count ?? 0};

  // PDF の Blob を pdf.js に渡すための object URL。画面を離れるとき revokeUrls で解放する
  const urls = new Map(), retired = [];
  let releaser = null; // 画面が登録する。退役した URL の pdf.js の文書を破棄してから URL を失効させる（Blob 全体がメモリに残るため）
  const objectUrl = (key, blob) => { let u = urls.get(key); if (!u) urls.set(key, u = URL.createObjectURL(blob)); return u; };
  const forget = key => { const u = urls.get(key); if (u) { retired.push(u); urls.delete(key); } };
  const flushRetired = () => {
    if (!releaser || !retired.length) return;
    const list = retired.splice(0), fn = releaser;
    Promise.resolve().then(() => fn(list)).catch(() => {});
  };
  const revokeUrls = () => { for (const u of [...urls.values(), ...retired.splice(0)]) URL.revokeObjectURL(u); urls.clear(); };
  const setReleaser = fn => { releaser = fn; };
  // 確定していない資料（DRAFTS）を捨てる。keep の slug のものだけ残す
  const clearDrafts = keep => {
    for (const [slug, d] of [...DRAFTS]) if (slug !== keep) { DRAFTS.delete(slug); forget(`draft:${slug}:${d.src.revision}`); }
    flushRetired();
  };
  // いま使っている URL（slug の確定済みの PDF と、setup 中なら未確定の PDF）
  const urlsOf = (slug, withDraft) => [...urls].filter(([k]) => slug && (k.startsWith(`${slug}/`) || (withDraft && k.startsWith(`draft:${slug}:`)))).map(([, u]) => u);
  const fileUrl = async (slug, name) => {
    const key = `${slug}/${name}`;
    if (urls.has(key)) return urls.get(key);
    const blob = await LocalStore.getFile(slug, name);
    return blob ? objectUrl(key, blob) : null;
  };

  // image_for：IA の資料は画像を取得せず、server.image_for と同じ index・key・count・label・link だけを返す（url・service・w・h は無い）。
  // PDF の Blob が無い（バックアップから戻した）ときは pdf: null, no_file: true
  const pyStr = v => Draft.pyStr(v);
  const identity = src => {
    const has = k => Object.prototype.hasOwnProperty.call(src, k); // Python の dict.get(k, default) と同じく、null でも「ある」とみなす
    return has('revision') ? pyStr(src.revision) : has('id') ? pyStr(src.id) : has('file') ? pyStr(src.file) : '';
  };
  const imageFor = async (p, i, index = null, draft = null) => {
    const pages = (await LocalStore.parts(p.slug)).pages;
    if (index === null && i >= 0 && i < pages.length && pages[i].unassigned) return null;
    const src = draft ? draft.src : p.source;
    if (!src || (src.type !== 'pdf' && src.type !== 'ia')) return null;
    const idx = index === null ? imageIndex(p, i) : index;
    const key = await sha256(`${src.type}:${identity(src)}:${idx}`);
    if (src.type === 'ia') {
      const n = (src.pages || []).length;
      if (!(idx >= 0 && idx < n)) return {index: idx, missing: true, count: n};
      return {index: idx, key, count: n, label: src.pages[idx].label, link: `https://archive.org/details/${src.id}/page/n${idx}/mode/1up`};
    }
    const count = src.count ?? 0;
    const out = {index: idx, key, missing: !(idx >= 0 && idx < count), count};
    if (draft) return {...out, pdf: objectUrl(`draft:${p.slug}:${src.revision}`, draft.blob)};
    const url = await fileUrl(p.slug, src.file);
    return url ? {...out, pdf: url} : {...out, pdf: null, no_file: true};
  };

  const projectView = async slug => {
    const p = await loadProject(slug), parts = await LocalStore.parts(slug), records = await LocalStore.pages(slug);
    return {
      slug: p.slug, uri: p.uri, raw_url: p.raw_url, title: p.title, author: p.author, created: p.created,
      candidates: p.candidates, offset: p.offset, anchors: p.anchors, source: sourceView(p.source),
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
    const out = [], backups = await LocalStore.backupTimes(), sizes = await LocalStore.fileSizes();
    for (const p of (await LocalStore.listProjects()).sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))) {
      try {
        const parts = await LocalStore.parts(p.slug), records = await LocalStore.pages(p.slug);
        out.push({slug: p.slug, uri: p.uri, title: p.title, author: p.author, created: p.created, source: !!p.source,
          pages: parts.pages.length, done: keysOf(records, r => r.done).length, edited: keysOf(records, r => r.text !== undefined).length,
          backup: backups[p.slug] || null, pdf_size: sizes[p.slug] || 0});
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

  // ---------- PDF の資料（server.py の create_pdf_draft / set_pdf / set_mapping / preview_image） ----------
  route('POST', '/api/projects/new-pdf', async ({body, headers}) => {
    tooLarge(body);
    if (!(await isPdf(body))) throw err('500 MB以下のPDFを選択してください');
    let metadata, fetched, details, count;
    try {
      metadata = JSON.parse(unquote(header(headers, 'X-Metadata') ?? '{}'));
      [fetched, details] = Draft.build(metadata);
      count = Draft.pyInt(metadata.count);
    } catch { throw err('書名、PDFの対象範囲、巻と印刷ページ番号を確認してください'); }
    const source = {type: 'pdf', file: 'source.pdf', revision: uuidHex(), title: typeof metadata.filename === 'string' ? metadata.filename : 'source.pdf', count};
    const p = await LocalStore.createProject(fetched, {patch: {...details, source}, file: {name: source.file, blob: body.slice(0, body.size, 'application/pdf')}});
    return projectView(p.slug);
  });

  route('POST', '/api/projects/(?<slug>[^/]+)/source/pdf', async ({slug, body, headers}) => {
    tooLarge(body);
    if (!(await isPdf(body))) throw err('PDFファイルではありません');
    const count = int(header(headers, 'X-Page-Count') || 0);
    if (count < 1) throw err('PDFのページ数を確認できませんでした');
    await loadProject(slug);
    const name = `source-${uuidHex()}.pdf`, src = {type: 'pdf', file: name, title: unquote(header(headers, 'X-Filename') ?? name), count, revision: uuidHex()};
    const old = DRAFTS.get(slug);
    if (old) forget(`draft:${slug}:${old.src.revision}`);
    DRAFTS.set(slug, {src, blob: body.slice(0, body.size, 'application/pdf')});
    return {...(await projectView(slug)), draft: sourceView(src)};
  });

  // ブラウザ版だけの経路：バックアップから戻した PDF の資料に、同じ名前で PDF を付け直す（ローカル版は files/ のファイルをそのまま使う）
  route('POST', '/api/projects/(?<slug>[^/]+)/source/pdf/attach', async ({slug, body, headers}) => {
    tooLarge(body);
    const p = await loadProject(slug);
    if (!p.source || p.source.type !== 'pdf') throw err('PDFの資料ではありません');
    if (!(await isPdf(body))) throw err('PDFファイルではありません');
    const count = int(header(headers, 'X-Page-Count') || 0);
    if (count < 1) throw err('PDFのページ数を確認できませんでした');
    // 画面で確認済みの別のページ数なら、同じトランザクションで count と revision（画像の key）も更新する
    await LocalStore.attachFile(slug, p.source.file, body.slice(0, body.size, 'application/pdf'), {count, revision: uuidHex()});
    forget(`${slug}/${p.source.file}`);
    return projectView(slug);
  });

  const draftFor = (slug, revision) => {
    const d = DRAFTS.get(slug);
    if (!d || d.src.revision !== revision) throw err('選んだ資料の情報がありません。資料を選び直してください', 409);
    return d;
  };

  route('POST', '/api/projects/(?<slug>[^/]+)/mapping', async ({slug, body}) => {
    const b = object(body);
    await loadProject(slug);
    const staged = 'source' in b ? draftFor(slug, b.source) : null;
    const offset = 'offset' in b ? int(b.offset) : null;
    let anchor = null;
    if ('anchor' in b) {
      if (!Array.isArray(b.anchor) || b.anchor.length < 2) throw err('anchor は [ページ, 画像] で指定してください');
      anchor = [int(b.anchor[0]), int(b.anchor[1])];
    }
    // 資料の切り替えは、PDF の保存とプロジェクトの更新を1つのトランザクションで行う（容量不足なら何も変わらない）
    let oldFile = null;
    await LocalStore.updateProject(slug, p => {
      const files = {};
      oldFile = null;
      if (staged) {
        if (p.source && p.source.type === 'pdf' && p.source.file !== staged.src.file) { files.remove = [p.source.file]; oldFile = p.source.file; }
        p.source = {...staged.src}; p.offset = 0; p.anchors = [];
        files.put = [{name: staged.src.file, blob: staged.blob}];
      }
      if (offset !== null) p.offset = offset;
      if (b.clear_anchors) p.anchors = [];
      if (anchor) p.anchors = p.anchors.filter(a => a[0] !== anchor[0]).concat([anchor]).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
      return files;
    });
    if (staged) { DRAFTS.delete(slug); forget(`draft:${slug}:${staged.src.revision}`); forget(`${slug}/${staged.src.file}`); if (oldFile) forget(`${slug}/${oldFile}`); }
    return projectView(slug);
  });

  route('GET', '/api/projects/(?<slug>[^/]+)/image', async ({slug, query}) => {
    const p = await loadProject(slug), draftRevision = query.get('draft') || '';
    const draft = draftRevision ? draftFor(slug, draftRevision) : null;
    const src = draft ? draft.src : p.source;
    return imageFor(p, 0, int(query.get('index') ?? '0'), draft);
  });

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
    const p = await loadProject(slug);
    i = await pageIndex(slug, i);
    const pg = (await LocalStore.parts(slug)).pages[i], r = (await LocalStore.page(slug, i)) || {};
    return {i, vol: pg.vol, page: pg.page, marker: pg.marker || '未割当の末尾', revision: r.revision || 0,
      unassigned: !!pg.unassigned, original: pg.text, text: r.text ?? pg.text, done: !!r.done, note: r.note || '',
      ocr: null, image: await imageFor(p, i)};
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
      // バックアップ日時は、ダウンロードを始めた後に saveDownload が done() で記録する
      return {...file(`${slug}.proofreader.json`, 'application/json; charset=utf-8', JSON.stringify(Bundle.build({...src, now}), null, 1)),
              done: () => LocalStore.setSetting(`backup:${slug}`, now.toISOString())};
    }
    if (['package', 'diff'].includes(fmt)) throw err(UNSUPPORTED, 501);
    throw err('不明な形式です');
  });

  return {UNSUPPORTED, handle, revokeUrls, setReleaser, clearDrafts, urlsOf, searchTerms, notesCsv, csvField};
})();

if (typeof module !== 'undefined') module.exports = LocalRouter;
