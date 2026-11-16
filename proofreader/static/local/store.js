// store.py の IndexedDB 版。DB 'proofreader' の読み書きと版の移行を担う（保存の判断は work.js）。
const LocalStore = (() => {
  const DB_NAME = 'proofreader';
  // 1版ずつの移行。onupgradeneeded が古い版から順に呼ぶ。消さずに足す（docs/static-design.md「形式と版の管理」）
  const MIGRATIONS = [
    db => { // 1: 初版
      db.createObjectStore('projects', {keyPath: 'slug'});
      db.createObjectStore('originals', {keyPath: 'slug'});
      db.createObjectStore('pages', {keyPath: ['slug', 'i']});
      db.createObjectStore('files', {keyPath: ['slug', 'name']});
      db.createObjectStore('settings', {keyPath: 'key'});
    },
  ];
  const DB_VERSION = MIGRATIONS.length;
  const NEWER = 'このブラウザのデータは、新しい版のアプリで作られています。アプリを更新してから開いてください（データは変更していません）';
  const apiError = (message, status = 500) => new Work.ApiError(message, status);
  const notFound = () => apiError('見つかりません', 404);

  let dbPromise = null;
  const BLOCKED = '保存領域の更新が、ほかのタブで開いている古い画面に止められています。ほかのタブを閉じてから再読み込みしてください';
  const open = () => {
    if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
      const fail = e => { dbPromise = null; reject(e && e.name === 'VersionError' ? apiError(NEWER) : apiError(`ブラウザの保存領域を開けませんでした: ${e && e.message || e}`)); };
      try {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = e => { for (let v = e.oldVersion; v < DB_VERSION; v++) MIGRATIONS[v](req.result, req.transaction); };
        req.onblocked = () => { dbPromise = null; reject(apiError(BLOCKED)); };
        req.onsuccess = () => {
          const db = req.result;
          db.onversionchange = () => { db.close(); dbPromise = null; };
          db.onclose = () => { dbPromise = null; }; // ブラウザが接続を閉じたら、次の操作で開き直す
          resolve(db);
        };
        req.onerror = () => fail(req.error);
      } catch (e) { fail(e); }
    });
    return dbPromise;
  };

  const request = r => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  const storageError = e => e && e.name === 'QuotaExceededError' ? apiError('ブラウザの保存容量が足りません。不要なプロジェクトを書き出してから消すか、空き容量を確保してください', 507) : e;

  // 1つのトランザクションで fn を実行する。fn の中では IndexedDB の request 以外を await しない
  const run = async (stores, mode, fn) => {
    const db = await open();
    let tx;
    try { tx = mode === 'readwrite' ? db.transaction(stores, mode, {durability: 'strict'}) : db.transaction(stores, mode); }
    catch (e) { if (e && e.name === 'TypeError') tx = db.transaction(stores, mode); else throw e; } // オプションを知らないブラウザ
    const done = new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('保存が中断されました'));
    });
    done.catch(() => {});
    let result;
    try { result = await fn(tx); }
    catch (e) { try { tx.abort(); } catch {} throw storageError(e); }
    try { await done; } catch (e) { throw storageError(e); }
    return result;
  };

  const cache = new Map(); // slug -> split result（原文は変わらない）
  const parts = async slug => {
    if (!cache.has(slug)) {
      const rec = await run(['originals'], 'readonly', tx => request(tx.objectStore('originals').get(slug)));
      if (!rec) throw notFound();
      cache.set(slug, OpenITI.split(rec.text));
    }
    return cache.get(slug);
  };

  const listProjects = () => run(['projects'], 'readonly', tx => request(tx.objectStore('projects').getAll()));
  const getProject = slug => run(['projects'], 'readonly', tx => request(tx.objectStore('projects').get(slug)));

  // 読み → mutate → 書きを1つのトランザクションで行う
  const updateProject = (slug, mutate) => run(['projects'], 'readwrite', async tx => {
    const s = tx.objectStore('projects'), p = await request(s.get(slug));
    if (!p) throw notFound();
    mutate(p);
    s.put(p);
    return p;
  });

  let channel;
  const notify = message => {
    try { if (!channel && typeof BroadcastChannel !== 'undefined') channel = new BroadcastChannel('proofreader'); if (channel) channel.postMessage(message); } catch {}
  };

  // Firefox では許可の確認が出て待たされるので、待たずに依頼だけする
  const requestPersist = () => { try { Promise.resolve(navigator.storage.persist()).catch(() => {}); } catch {} };

  const stamp = () => { const d = new Date(), z = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`; };

  const slugBase = uri => uri.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'text';
  const freeSlug = async (store, base) => {
    let slug = base, n = 2;
    while (slug === '.' || slug === '..' || (await request(store.getKey(slug))) !== undefined) slug = `${base}_${n++}`;
    return slug;
  };

  const createProject = async fetched => {
    const meta = fetched.meta || {};
    let project, first;
    await run(['projects', 'originals'], 'readwrite', async tx => {
      const s = tx.objectStore('projects');
      first = (await request(s.count())) === 0;
      const slug = await freeSlug(s, slugBase(fetched.uri));
      project = {
        slug, uri: fetched.uri, raw_url: fetched.raw_url || '',
        title: OpenITI.titleOf(meta, fetched.text, fetched.uri), author: OpenITI.authorOf(meta, fetched.text, fetched.uri),
        created: stamp(), meta, schema_version: 2,
        candidates: OpenITI.scanLinks(meta), source: null, offset: 0, anchors: [],
      };
      s.put(project);
      tx.objectStore('originals').put({slug, text: fetched.text});
    });
    cache.set(project.slug, OpenITI.split(fetched.text));
    if (first) requestPersist();
    notify({slug: project.slug, created: true});
    return project;
  };

  // Bundle.parse が検証した {project, text, work} を新しいプロジェクトとして1つのトランザクションで書く。元の slug は使わない
  const importBundle = async ({project, text, work}) => {
    const records = Work.workToRecords(work);
    let out, first;
    await run(['projects', 'originals', 'pages'], 'readwrite', async tx => {
      const s = tx.objectStore('projects');
      first = (await request(s.count())) === 0;
      const slug = await freeSlug(s, slugBase(project.uri));
      out = {...project, slug, created: project.created || stamp()};
      s.put(out);
      tx.objectStore('originals').put({slug, text});
      const pageStore = tx.objectStore('pages');
      for (const [k, r] of Object.entries(records)) pageStore.put({...r, slug, i: Number(k)});
    });
    cache.set(out.slug, OpenITI.split(text));
    if (first) requestPersist();
    notify({slug: out.slug, created: true});
    return out;
  };

  // バックアップの書き出し用：プロジェクト・原文・全ページの record を同じ時点で読む
  const bundleSource = slug => run(['projects', 'originals', 'pages'], 'readonly', async tx => {
    const project = await request(tx.objectStore('projects').get(slug)), original = await request(tx.objectStore('originals').get(slug));
    if (!project || !original) throw notFound();
    const records = {};
    for (const r of await request(tx.objectStore('pages').getAll(IDBKeyRange.bound([slug, -Infinity], [slug, Infinity])))) records[r.i] = r;
    return {project, original: original.text, records};
  });

  // 利用者ごとの設定（最後のバックアップの日時など）
  const getSetting = async key => ((await run(['settings'], 'readonly', tx => request(tx.objectStore('settings').get(key)))) || {}).value;
  const setSetting = async (key, value) => {
    await run(['settings'], 'readwrite', async tx => { tx.objectStore('settings').put({key, value}); });
    notify({key});
  };
  const backupTimes = async () => {
    const out = {};
    for (const r of await run(['settings'], 'readonly', tx => request(tx.objectStore('settings').getAll()))) if (r.key.startsWith('backup:')) out[r.key.slice(7)] = r.value;
    return out;
  };

  // {i: record}。record に無いページは未編集
  const pages = slug => run(['pages'], 'readonly', async tx => {
    const out = {};
    for (const r of await request(tx.objectStore('pages').getAll(IDBKeyRange.bound([slug, -Infinity], [slug, Infinity])))) out[r.i] = r;
    return out;
  });
  const page = (slug, i) => run(['pages'], 'readonly', tx => request(tx.objectStore('pages').get([slug, i])));

  // revision の照合と書き込みを同じトランザクションで行うので、別のタブとの競合を取りこぼさない
  const savePage = async (slug, i, change) => {
    const original = (await parts(slug)).pages[i].text;
    const next = await run(['pages'], 'readwrite', async tx => {
      const s = tx.objectStore('pages'), rec = await request(s.get([slug, i]));
      const out = Work.applyUpdate(rec, original, change);
      if (rec || out.revision) s.put({...out, slug, i});
      return out;
    });
    notify({slug, i, revision: next.revision});
    return next;
  };

  return {DB_NAME, DB_VERSION, MIGRATIONS, open, listProjects, getProject, updateProject, createProject, importBundle, bundleSource, getSetting, setSetting, backupTimes, parts, pages, page, savePage};
})();

if (typeof module !== 'undefined') module.exports = LocalStore;
