'use strict';
// OpenITI proofreading UI: home (projects), setup (scan source + page mapping), proofreading.

const $ = (sel, root = document) => root.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const view = $('#view'), topbar = $('#topbar');
const browserMode = PROOF_MODE === 'browser';
document.documentElement.dataset.mode = PROOF_MODE;

let toastT;
function toast(msg, err) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, err ? 6000 : 2500);
}

// ---------- presence (lets the server exit once the last tab is closed) ----------
const clientId = window.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
let beatT, serverGone = false;
async function beat() {
  if (!beatT) return;
  try {
    const r = await fetch('/api/heartbeat', {method: 'POST', keepalive: true, body: JSON.stringify({client: clientId})});
    if (!r.ok) throw new Error(r.status);
    if (serverGone) { serverGone = false; $('#offline').hidden = true; }
  } catch (e) {
    if (!serverGone) { serverGone = true; $('#offline').hidden = false; }
  }
}
if (!browserMode) {
  beatT = setInterval(beat, 20000); beat();
  window.addEventListener('pageshow', beat);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') beat(); });
  document.addEventListener('resume', beat);
  window.addEventListener('pagehide', () => { try { navigator.sendBeacon('/api/bye', JSON.stringify({client: clientId})); } catch (e) {} });
}

const prefs = (() => {
  const def = {vowels: false, ortho: true, punct: true, space: true, header: false, foot: false, autoOcr: false, ocrProvider: 'anthropic', openaiModel: '', ocrModel: 'claude-opus-5-5', zoom: 100, fit: 'width', editorH: null};
  let v = def;
  try { v = Object.assign({}, def, JSON.parse(localStorage.getItem('proof-prefs') || '{}')); } catch (e) {}
  return new Proxy(v, {set(o, k, val) { o[k] = val; try { localStorage.setItem('proof-prefs', JSON.stringify(o)); } catch (e) {} return true; }});
})();

// ---------- pdf.js (only loaded for uploaded PDFs) ----------
let pdfLib, pdfLoading, pdfDocs = {}, pdfTasks = {};
async function loadPdf(url) {
  if (!pdfLib) {
    if (!pdfLoading) pdfLoading = import('./vendor/pdfjs/6.5.438/pdf.min.mjs')
      .then(lib => {
        lib.GlobalWorkerOptions.workerSrc = new URL('vendor/pdfjs/6.5.438/pdf.worker.min.mjs', document.baseURI).href;
        return lib;
      }).catch(error => { pdfLoading = null; throw new Error('PDF表示ライブラリを読み込めませんでした: ' + error.message); });
    pdfLib = await pdfLoading;
  }
  if (!pdfDocs[url]) {
    const task = pdfLib.getDocument({url, isEvalSupported: false});
    pdfTasks[url] = task;
    pdfDocs[url] = task.promise.catch(e => { releasePdf(url).catch(() => {}); throw e; });
  }
  return pdfDocs[url];
}
async function releasePdf(url) {
  const task = pdfTasks[url];
  delete pdfTasks[url]; delete pdfDocs[url];
  if (task) await task.destroy();
}
// ブラウザ版：ルーターが退役させた Blob URL（付け直し・確定・資料の差し替え・未確定の資料の破棄）の文書を破棄してから URL を失効させる
if (browserMode) LocalRouter.setReleaser(async urls => { for (const u of urls) { await releasePdf(u).catch(() => {}); URL.revokeObjectURL(u); } });
// PDF をこのブラウザに付け直すための選択欄（バックアップから戻した資料用）。対応（offset・anchors）は変えない
function reattachControl(box, {slug, source, api, life, done}) {
  box.innerHTML = `<p>この資料のPDF（${esc(source.title || source.file)}・${source.count}ページ）はこのブラウザにありません。バックアップにはPDFが含まれないため、元のPDFを選び直してください。ページの対応はそのまま使います。</p>
    <input type="file" id="reattach" aria-label="PDFを選び直す" accept="application/pdf"> <span id="reattachmsg" class="small" role="status"></span>`;
  $('#reattach').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    const msg = $('#reattachmsg'), input = e.target;
    msg.textContent = 'PDFを確認しています…'; input.disabled = true;
    const url = URL.createObjectURL(f);
    try {
      const pages = (await loadPdf(url)).numPages;
      if (!life.alive) return;
      if (pages !== source.count && !confirm(`選んだPDFは${pages}ページで、資料の記録（${source.count}ページ）と違います。別の版のPDFかもしれません。このまま使いますか？`)) { msg.textContent = ''; input.value = ''; input.disabled = false; return; }
      msg.textContent = '保存しています…';
      const p = await api('POST', `/api/projects/${slug}/source/pdf/attach`, f, {'X-Page-Count': String(pages)});
      await done(p);
    } catch (err) { if (life.alive) { toast(err.message, true); msg.textContent = ''; input.value = ''; input.disabled = false; } }
    finally { await releasePdf(url); URL.revokeObjectURL(url); }
  };
}
// IA のページ画像（<img>）の読み込み。ブラウザ版は IIIF が 504 などで失敗しやすいので、間を置いて数回読み直し、だめなら D-27 の案内を出す
// （ローカル版はサーバーが予備の経路まで試すので、失敗はそのまま表示する）
const SCAN_TRIES = 4;
function loadScan(el, url, {current, onload, onfail}) {
  let tries = 0;
  el.onload = () => { if (current()) onload(); };
  el.onerror = () => {
    if (!current()) return;
    if (!browserMode) { onfail(new Error('ネットワークと資料の公開状態を確認してください')); return; }
    if (++tries < SCAN_TRIES) setTimeout(() => { if (current()) el.src = url; }, Sources.retry.delay);
    else onfail(new Error(Sources.UNAVAILABLE));
  };
  el.src = url;
}
async function renderPdfPage(url, index, width) {
  const doc = await loadPdf(url);
  if (index < 0 || index >= doc.numPages) return null;
  const page = await doc.getPage(index + 1);
  const vp1 = page.getViewport({scale: 1});
  const vp = page.getViewport({scale: width / vp1.width});
  const c = document.createElement('canvas');
  c.width = Math.round(vp.width); c.height = Math.round(vp.height);
  await page.render({canvasContext: c.getContext('2d'), viewport: vp}).promise;
  return c;
}

// ---------- routing ----------
window.addEventListener('hashchange', routeNow);
let leave = null, routeBusy = false, routeAgain = false, currentHash = location.hash, pdfOwner = null;
// ブラウザ版：PDF は IndexedDB の Blob を object URL で pdf.js に渡す。ほかのプロジェクトや一覧へ移るとき、読み込み済みの PDF と URL を解放する
// keep: いま使う URL。空なら（別のプロジェクトや一覧へ移るとき）すべて失効させる
async function dropBrowserPdfs(keep = []) {
  await Promise.all(Object.keys(pdfDocs).filter(url => !keep.includes(url)).map(url => releasePdf(url).catch(() => {})));
  if (!keep.length) LocalRouter.revokeUrls();
}
let activeView = null;
function lifecycle() {
  const life = {alive: true, cleanup: []};
  activeView = life;
  life.api = async (...args) => {
    const result = await api(...args);
    if (!life.alive) throw new Error('画面が切り替わりました');
    return result;
  };
  return life;
}
async function routeNow() {
  if (routeBusy) { routeAgain = true; return; }
  routeBusy = true;
  try {
  if (leave) {
    try { await leave(); }
    catch (e) { history.replaceState(null, '', currentHash || '#/'); toast('保存できないため移動を中止しました。再試行してください。', true); routeAgain = false; return; }
    leave = null;
  }
  if (activeView) { activeView.alive = false; activeView.cleanup.forEach(fn => fn()); }
  const life = lifecycle();
  currentHash = location.hash;
  const h = location.hash.replace(/^#\/?/, '').split('/');
  topbar.innerHTML = '';
  if (browserMode) {
    const owner = h[0] === 'p' && h[1] ? h[1] : null, inSetup = owner && h[2] === 'setup';
    LocalRouter.clearDrafts(inSetup ? owner : null); // 未確定の資料は、設定画面を離れたら捨てる
    if (owner !== pdfOwner) { pdfOwner = owner; await dropBrowserPdfs(); }
    else await dropBrowserPdfs(LocalRouter.urlsOf(owner, inSetup)); // 同じプロジェクトでは、いまの資料の文書以外を解放する
  }
  try {
    if (h[0] === 'p' && h[1] && h[2] === 'setup') await setupView(h[1], h[3] ? parseInt(h[3], 10) : null, life);
    else if (h[0] === 'p' && h[1]) await proofView(h[1], h[2] ? parseInt(h[2], 10) : null, life);
    else if (h[0] === 'new') await newDraftView(life);
    else await homeView(life);
  } catch (e) {
    view.innerHTML = `<div class="wrap"><div class="card">読み込めませんでした：${esc(e.message)}　<a href="#/">ホームへ</a></div></div>`;
  }
  } finally { routeBusy = false; if (routeAgain) { routeAgain = false; routeNow(); } }
}

// ---------- home ----------
const megabytes = n => `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`;
async function storageNote() {
  try {
    const {usage, quota} = await navigator.storage.estimate();
    const kept = navigator.storage.persisted ? await navigator.storage.persisted() : false;
    return `使用量：${megabytes(usage)}（上限の目安 ${megabytes(quota)}）。ブラウザによる自動削除の保護：${kept ? 'あり' : 'なし'}`;
  } catch (e) { return ''; }
}
const backupLabel = t => { const d = t ? new Date(t) : null; return d && !isNaN(d) ? d.toLocaleString('ja-JP') : '未バックアップ'; };

async function homeView(life) {
  const api = life.api;
  document.title = 'OpenITI 校正';
  const table = async () => {
    const list = await api('GET', '/api/projects');
    return list.length ? `<table><thead><tr><th>書名</th><th>URI</th><th>ページ</th><th>確認済み</th><th>修正</th>${browserMode ? '<th>最後のバックアップ</th>' : ''}<th></th></tr></thead><tbody>
        ${list.map(p => `<tr>
          <td><span class="ar">${esc(p.title || '—')}</span><div class="muted small ar">${esc(p.author)}</div>${browserMode && p.pdf_size ? `<div class="muted small">PDF ${megabytes(p.pdf_size)}</div>` : ''}</td>
          <td class="small">${esc(p.uri)}</td><td>${p.pages}</td>
          <td><span class="bar"><i style="width:${(100 * p.done / p.pages).toFixed(1)}%"></i></span> <span class="prog">${p.done}</span></td>
          <td class="prog">${p.edited}</td>
          ${browserMode ? `<td class="small">${esc(backupLabel(p.backup))}</td>` : ''}
          <td><a href="#/p/${esc(p.slug)}${p.source || browserMode ? '' : '/setup'}"><button>${p.source || browserMode ? '開く' : '設定を続ける'}</button></a>
            <a href="/api/projects/${esc(p.slug)}/export?fmt=bundle" data-bundle><button>バックアップを書き出す</button></a></td>
        </tr>`).join('')}</tbody></table>` : '<p class="muted">まだありません。</p>';
  };
  view.innerHTML = `<div class="wrap">
    <div class="card">
      <h2>新しいテキストを読み込む</h2><p><a href="#/new">OpenITIにないテキストをPDFから作成する</a></p>
      <div class="row">
        <input type="text" id="ref" aria-label="OpenITIのバージョンURIまたはGitHubのURL" placeholder="OpenITIのバージョンURI、またはGitHubのURL（例：1014IbnMaryamTilimsani.Bustan.Kraken22021817402301-ara1）">
        <button class="primary" id="go">読み込む</button>
      </div>
      <div class="row" style="margin-top:8px"><label class="muted small" for="file">または手元のOpenITI形式ファイル：</label><input type="file" id="file" accept=".txt,.mARkdown,.completed,.inProgress,text/plain"></div>
      <div class="row" style="margin-top:8px"><label class="muted small" for="bundle">バックアップから読み込む（.proofreader.json）：</label><input type="file" id="bundle" accept=".json,application/json"></div>
    </div>
    <div class="card">
      <h2>校正中のテキスト</h2>
      ${browserMode ? '<p class="muted small">このブラウザの中に保存されます。サイトのデータを消したり、容量が足りなくなったりすると失われることがあります。「バックアップを書き出す」で定期的にファイルへ保存してください。</p><p class="muted small" id="usage"></p>' : ''}
      <div id="plist">${await table()}</div>
    </div>
    <div class="row needs-server" style="margin-top:12px"><button id="quit">アプリを終了</button></div></div>`;
  const refresh = async () => { $('#plist').innerHTML = await table(); if (browserMode) $('#usage').textContent = await storageNote(); };
  if (browserMode) {
    storageNote().then(t => { if (life.alive) $('#usage').textContent = t; });
    if (typeof BroadcastChannel !== 'undefined') { // 別のタブでの保存・作成・バックアップを一覧に反映する
      const channel = new BroadcastChannel('proofreader');
      channel.onmessage = () => refresh().catch(() => {});
      life.cleanup.push(() => channel.close());
    }
  }
  $('#plist').addEventListener('click', async e => {
    const link = e.target.closest('a[data-bundle]');
    if (!link || !browserMode) return;
    e.preventDefault();
    try { await saveDownload(link.getAttribute('href')); await refresh(); } catch (err) { if (life.alive) toast(err.message, true); }
  });
  $('#bundle').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      let data;
      try { data = JSON.parse(await f.text()); } catch (err) { throw new Error('JSONとして読めません。バックアップのファイルを選んでください'); }
      const p = await api('POST', '/api/projects/import-bundle', data);
      toast('バックアップから読み込みました');
      location.hash = browserMode || p.source ? `#/p/${p.slug}/0` : `#/p/${p.slug}/setup`;
    } catch (err) { if (life.alive) { toast(err.message, true); e.target.value = ''; } }
  };
  $('#quit').onclick = async () => {
    if (!confirm('アプリを終了しますか？ 他のタブで開いている画面も使えなくなります。')) return;
    try { await api('POST', '/api/shutdown'); } catch (e) { if (life.alive) toast(e.message, true); return; }
    clearInterval(beatT); beatT = null; leave = null;
    view.innerHTML = '<div class="wrap"><div class="card">アプリを終了しました。このタブを閉じてください。</div></div>';
  };
  const go = async () => {
    const ref = $('#ref').value.trim(); if (!ref) return;
    $('#go').disabled = true; $('#go').textContent = '取得中…';
    try { const p = await api('POST', '/api/projects', {ref}); location.hash = browserMode ? `#/p/${p.slug}/0` : `#/p/${p.slug}/setup`; }
    catch (e) { if (life.alive) { toast(e.message, true); $('#go').disabled = false; $('#go').textContent = '読み込む'; } }
  };
  $('#go').onclick = go;
  $('#ref').onkeydown = e => { if (e.key === 'Enter') go(); };
  $('#file').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try { const p = await api('POST', '/api/projects/upload-text', f, {'X-Filename': encodeURIComponent(f.name)}); location.hash = browserMode ? `#/p/${p.slug}/0` : `#/p/${p.slug}/setup`; }
    catch (err) { if (life.alive) toast(err.message, true); }
  };
}

// ---------- setup: scan source and page mapping ----------
async function setupView(slug, from, life) {
  const api = life.api;
  let p = await api('GET', `/api/projects/${slug}`);
  document.title = `設定 - ${p.uri}`;
  topbar.innerHTML = `<span class="ar">${esc(p.title)}</span><span class="muted small">${esc(p.uri)}</span>`;
  if (!(from >= 0 && from < p.pages.length)) from = null;
  // cancelling leaves the project as it was: back to the page we came from, or home before setup is finished
  const cancel = () => { if (browserMode) LocalRouter.clearDrafts(null); location.hash = p.source ? `#/p/${slug}${from == null ? '' : '/' + from}` : '#/'; };

  const renderSource = async () => {
    const terms = (await api('GET', `/api/projects/${slug}/search-terms`)).q;
    view.innerHTML = `<div class="wrap">
      <div class="steps"><span>1. テキスト ✓</span>›<span class="on">2. ページ画像</span>›<span>3. ページの対応</span></div>
      <div class="card">
        <div class="row"><h2>ページ画像を選ぶ</h2><span style="flex:1"></span><button id="cancel">キャンセル</button></div>
        ${p.source ? '<p class="help">資料を選んでも、次の画面で対応を確定するまで現在の資料・対応は変わりません。</p>' : ''}
        ${browserMode ? '<p class="muted small">検索とページ画像は、このブラウザから Internet Archive へ直接つなぎます。この画面を開くと、候補の識別子が Internet Archive に伝わります（サムネイルとPDFの情報）。検索語は「検索」を押したときだけ送られます。</p>' : ''}
        ${p.candidates.length ? `<h3>メタデータに書かれた Internet Archive の資料</h3>
          <div id="cands" class="results"></div>` : '<p class="muted small">メタデータに Internet Archive へのリンクはありませんでした。</p>'}
        <h3>Internet Archive を検索</h3>
        <div class="row"><input type="search" id="q" aria-label="Internet Archiveの検索語" value="${esc(terms)}"><button id="search">検索</button></div>
        <div id="results" class="results"></div>
        <h3>識別子・URLを直接指定</h3>
        <div class="row"><input type="text" id="iaid" aria-label="Internet Archiveの識別子またはURL" placeholder="例：ElBoustane または https://archive.org/details/ElBoustane"><button id="useid">使う</button></div>
        <h3>手元のPDFをアップロード</h3>
        ${browserMode ? '<p class="muted small">PDFはこのブラウザの中に保存されます（容量に注意してください）。バックアップには含まれないので、別の環境では選び直します。</p>' : ''}
        <div class="row"><input type="file" id="pdf" aria-label="ページ画像のPDF" accept="application/pdf"><span id="pdfmsg" class="muted small" role="status"></span></div>
      </div></div>`;
    const card = r => `<div class="res"><img loading="lazy" src="${esc(r.thumb)}" alt="">
      <div class="t"><b>${esc(r.title)}</b><span class="muted small">${esc(r.creator)} ${esc(r.date)}${Number.isInteger(r.imagecount) && r.imagecount > 0 ? ` ・${esc(String(r.imagecount))}枚` : ''}</span>
      <div class="row" style="margin-top:4px"><button data-id="${esc(r.id)}" class="primary use">使う</button><a class="small" target="_blank" rel="noopener" href="https://archive.org/details/${esc(r.id)}">IAで見る</a></div></div></div>`;
    if (p.candidates.length) $('#cands').innerHTML = p.candidates.map(id => card({id, title: id, thumb: `https://archive.org/services/img/${id}`, creator: '', date: ''})).join('');
    let sourceBusy = false;
    const sourceRoot = $('.wrap', view);
    const lock = on => sourceRoot.querySelectorAll('button:not(#cancel),input').forEach(el => el.disabled = on);
    $('#cancel').onclick = cancel;
    const use = async id => {
      if (sourceBusy) return;
      sourceBusy = true; lock(true);
      toast('ページ一覧を取得しています…');
      try { const r = await api('POST', `/api/projects/${slug}/source/ia`, {id}); await renderMatch(r.draft); }
      catch (e) { if (life.alive) toast(e.message, true); }
      finally { sourceBusy = false; lock(false); }
    };
    sourceRoot.addEventListener('click', e => { const b = e.target.closest('button.use'); if (b) use(b.dataset.id); });
    let sourceSearch = 0;
    const search = async () => {
      const version = ++sourceSearch, results = $('#results', sourceRoot);
      results.innerHTML = '<span class="muted">検索中…</span>';
      try {
        const rs = await api('GET', `/api/ia/search?q=${encodeURIComponent($('#q').value)}`);
        if (version !== sourceSearch || !sourceRoot.isConnected) return;
        results.innerHTML = rs.length ? rs.map(card).join('') : '<span class="muted">見つかりませんでした。語を減らすか、ラテン文字の書名・著者名でも試してください。</span>';
      } catch (e) { if (life.alive && version === sourceSearch) results.innerHTML = `<span class="muted">${esc(e.message)}</span>`; }
    };
    $('#search').onclick = search;
    $('#q').onkeydown = e => { if (e.key === 'Enter') search(); };
    $('#useid').onclick = () => use($('#iaid').value);
    $('#pdf').onchange = async e => {
      const f = e.target.files[0]; if (!f) return;
      if (sourceBusy) return;
      sourceBusy = true; lock(true);
      $('#pdfmsg').textContent = 'ページ数を確認しています…';
      let doc, url;
      try {
        url = URL.createObjectURL(f);
        doc = await loadPdf(url);
        if (!life.alive) return;
        $('#pdfmsg').textContent = `${doc.numPages}ページ。アップロード中…`;
        const r = await api('POST', `/api/projects/${slug}/source/pdf`, f, {'X-Filename': encodeURIComponent(f.name), 'X-Page-Count': String(doc.numPages)});
        await renderMatch(r.draft);
      } catch (err) { if (life.alive && $('#pdfmsg')) { $('#pdfmsg').textContent = ''; toast(err.message, true); } }
      finally { if (url) { await releasePdf(url); URL.revokeObjectURL(url); } sourceBusy = false; lock(false); }
    };
    if (!p.candidates.length && terms && !browserMode) search();
  };

  // draft: a newly chosen source that the server keeps aside until this mapping is confirmed
  const renderMatch = async draft => {
    const src = draft || p.source, draftQ = draft ? `&draft=${draft.revision}` : '';
    let ref = from;
    if (ref == null) {
      // pick the first page with a reasonable amount of text as the reference
      ref = 0;
      for (let i = 0; i < Math.min(p.pages.length, 40); i++) {
        const pg = await api('GET', `/api/projects/${slug}/pages/${i}`);
        if (pg.original.replace(/[\s~#|=]/g, '').length > 200) { ref = i; break; }
      }
    }
    const pg = await api('GET', `/api/projects/${slug}/pages/${ref}`);
    let img = !draft && pg.image ? pg.image.index : ref;
    const initialImg = img;
    const total = src.count;
    view.innerHTML = `<div class="wrap">
      <div class="steps"><span>1. テキスト ✓</span>›<span>2. ページ画像 ✓</span>›<span class="on">3. ページの対応</span></div>
      <div class="card">
        <h2>ページの対応を合わせる</h2>
        <p class="help">左のテキスト（${esc(pg.marker)}）と同じページが右に出るまで、画像の番号を動かしてください。変更は確定時に保存します。${draft
          ? '確定すると資料を切り替え、これまでの画像の対応と途中ページの補正を解除します。'
          : '対応を変更して確定すると、途中ページの補正を解除して全ページに適用します。'}「キャンセル」では何も変更しません。</p>
        <div class="row">
          <span>資料：<b>${esc(src.title || src.id || '')}</b>（${total}枚）${draft ? ' <span class="badge b-warn">未確定</span>' : ''}</span>
          <button id="chg">資料を選び直す</button>
          <span style="flex:1"></span>
          <button id="m10">−10</button><button id="m1">−1</button>
          <span>画像 <input type="number" id="imgn" aria-label="画像の番号" min="1" max="${total}" style="width:80px"> / ${total}</span>
          <button id="p1">+1</button><button id="p10">+10</button>
          <button id="cancel">キャンセル</button>
          <button class="primary" id="ok">${draft ? 'この資料と対応で確定する' : 'この対応で校正を続ける'}</button>
        </div>
        ${!draft && src.type === 'ia' ? '<div class="row small" id="pdfrow" role="status"></div>' : ''}
        <div class="match"><div class="pane"><pre class="ar">${esc(pg.original.trim())}</pre></div><div class="pane" id="mimg"></div></div>
      </div></div>`;
    let previewVersion = 0;
    const show = async () => {
      const version = ++previewVersion;
      img = Math.max(0, Math.min(total - 1, img));
      $('#imgn').value = img + 1;
      const box = $('#mimg');
      const current = () => life.alive && version === previewVersion && box.isConnected;
      const failed = e => {
        if (!current()) return;
        box.innerHTML = `<div class="imgmsg">画像を表示できません：${esc(e.message)} <button id="mretry">再試行</button></div>`;
        $('#mretry').onclick = show;
      };
      box.innerHTML = '<div class="imgmsg">読み込み中…</div>';
      try {
        const image = await api('GET', `/api/projects/${slug}/image?index=${img}${draftQ}`);
        if (!current()) return;
        if (!image || image.missing) { box.innerHTML = '<div class="imgmsg">画像がありません</div>'; return; }
        if (image.no_file) {
          const holder = document.createElement('div'); holder.className = 'imgmsg'; box.replaceChildren(holder);
          reattachControl(holder, {slug, source: p.source, api, life, done: async updated => { p = updated; toast('PDFを保存しました'); await renderMatch(); }});
          return;
        }
        if (image.unavailable) { box.innerHTML = `<div class="imgmsg">${esc(image.unavailable)}</div>`; return; }
        if (image.url) {
          const el = new Image();
          el.alt = '原本のページ画像';
          loadScan(el, image.url, {current, onload: () => box.replaceChildren(el), onfail: failed});
        } else {
          const c = await renderPdfPage(image.pdf, img, 900);
          if (!current()) return;
          if (c) box.replaceChildren(c); else box.innerHTML = '<div class="imgmsg">画像がありません</div>';
        }
      } catch (e) { failed(e); }
    };
    for (const [id, d] of [['m10', -10], ['m1', -1], ['p1', 1], ['p10', 10]]) $('#' + id).onclick = () => { img += d; show(); };
    $('#imgn').onchange = e => { img = (parseInt(e.target.value, 10) || 1) - 1; show(); };
    $('#chg').onclick = () => { if (browserMode) LocalRouter.clearDrafts(null); renderSource().catch(e => { if (life.alive) toast(e.message, true); }); };
    $('#cancel').onclick = cancel;
    $('#ok').onclick = async () => {
      $('#ok').disabled = true;
      try {
        if (draft) await api('POST', `/api/projects/${slug}/mapping`, {source: draft.revision, offset: img - ref, clear_anchors: true});
        else if (img !== initialImg) await api('POST', `/api/projects/${slug}/mapping`, {offset: img - ref, clear_anchors: true});
        location.hash = `#/p/${slug}/${ref}`;
      } catch (e) { if (life.alive) { toast(e.message, true); $('#ok').disabled = false; } }
    };
    show();

    const row = $('#pdfrow');
    if (row && browserMode) {
      // ブラウザ版：IA の PDF はブラウザから取得できないので、利用者がダウンロードして選ぶ。選んだ PDF は Blob として保存し、画像の代わりに使う
      const base = `/api/projects/${slug}/source/ia/pdf`, mb = n => (n / 1048576).toFixed(1);
      const live = () => life.alive && row.isConnected;
      const put = html => { if (live()) row.innerHTML = `<span class="muted">PDF（任意）：</span>${html}`; };
      const refresh = async () => {
        put('<span>PDFの情報を確認しています…</span>');
        let st;
        try { st = await api('GET', base); }
        catch (e) { put(`<span>${esc(e.message)}</span> <button id="pdfgo">再試行</button>`); if (live()) $('#pdfgo').onclick = refresh; return; }
        if (!live()) return;
        if (st.attached) {
          put(`<span>保存済み（${esc(st.attached)}）</span> <button id="pdfoff">オンラインの画像に戻す</button>`);
          $('#pdfoff').onclick = async () => {
            try { p = await api('POST', `${base}/detach`); toast('オンラインの画像に戻しました'); show(); await refresh(); } catch (e) { if (live()) toast(e.message, true); }
          };
          return;
        }
        if (!st.available) { put('<span>この資料にはPDFがありません</span>'); return; }
        const a = st.available, href = `https://archive.org/download/${encodeURIComponent(src.id)}/${encodeURIComponent(a.name)}`;
        put(`<span>${esc(a.name)}（${mb(a.size)} MB）</span> <a target="_blank" rel="noopener" href="${esc(href)}">Internet Archive でPDFをダウンロード</a>
          <span class="muted">ブラウザからは直接保存できません。ダウンロードしたPDFを選ぶと、このブラウザに保存して画像の代わりに使います。</span>
          <input type="file" id="pdfpick" aria-label="ダウンロードしたPDFを選ぶ" accept="application/pdf"> <span id="pdfpickmsg" role="status"></span>`);
        $('#pdfpick').onchange = async e => {
          const f = e.target.files[0]; if (!f) return;
          const input = e.target, msg = $('#pdfpickmsg'), url = URL.createObjectURL(f);
          input.disabled = true; msg.textContent = 'PDFを確認しています…';
          try {
            const pages = (await loadPdf(url)).numPages;
            if (!live()) return;
            msg.textContent = '保存しています…';
            p = await api('POST', `${base}/attach`, f, {'X-Revision': st.revision, 'X-Page-Count': String(pages)});
            toast('PDFをこのブラウザに保存しました'); show();
          } catch (err) { if (live()) { toast(err.message, true); msg.textContent = ''; input.value = ''; input.disabled = false; } return; }
          finally { await releasePdf(url); URL.revokeObjectURL(url); }
          if (live()) refresh();
        };
      };
      refresh();
    }
    if (row && !browserMode) {
      const base = `/api/projects/${slug}/source/ia/pdf`, mb = n => (n / 1048576).toFixed(1);
      let timer, failure = '', verifying = false, sawRunning = false;
      life.cleanup.push(() => clearTimeout(timer));
      const live = () => life.alive && row.isConnected;
      const put = html => { if (live()) row.innerHTML = `<span class="muted">作業フォルダーのPDF：</span>${html}`; };
      const run = fn => async () => { try { await fn(); } catch (e) { if (live()) { failure = e.message; put(''); refresh(); } } };
      const verify = async (st, file) => {
        verifying = true; put('<span>PDFを確認しています…</span>');
        const url = `/api/projects/${slug}/files/${encodeURIComponent(file)}?v=${encodeURIComponent(st.v)}`;
        try {
          const doc = await loadPdf(url), pages = doc.numPages;
          await releasePdf(url);
          p = await api('POST', `${base}/attach`, {revision: st.revision, pages});
          if (live()) { toast('PDFを作業フォルダーに結び付けました'); show(); }
        } catch (e) { await releasePdf(url); if (live()) toast(e.message, true); }
        finally { verifying = false; }
        if (live()) refresh();
      };
      const refresh = async () => {
        clearTimeout(timer);
        if (verifying || !live()) return;
        if (failure) { put(`<span>${esc(failure)}</span> <button id="pdfgo">再試行</button>`); $('#pdfgo').onclick = start; return; }
        let st;
        try { st = await api('GET', base); }
        catch (e) { if (live()) { failure = e.message; refresh(); } return; }
        if (!live()) return;
        const job = st.job;
        if (st.attached) {
          put(`<span>保存済み（${esc(st.attached)}）</span> <button id="pdfoff">オンラインの画像に戻す</button>`);
          $('#pdfoff').onclick = run(async () => { p = await api('POST', `${base}/detach`); toast('オンラインの画像に戻しました'); show(); await refresh(); });
        } else if (job && job.state === 'running') {
          sawRunning = true;
          put(`<span>ダウンロード中… ${mb(job.bytes)} / ${job.total ? mb(job.total) : '?'} MB</span>`);
          timer = setTimeout(refresh, 1500);
        } else if (job && job.state === 'error' && !st.mismatch) {
          failure = job.error || 'ダウンロードに失敗しました'; refresh();
        } else if (st.mismatch) put(`<span>${esc(st.mismatch)}</span>`);
        else if (st.pending) {
          if (sawRunning) { sawRunning = false; verify(st, st.pending); return; }
          put(`<span>保存したPDFがあります</span> <button id="pdfver">確認して結び付ける</button>`);
          $('#pdfver').onclick = () => verify(st, st.pending);
        } else if (!st.available) put('<span>この資料にはPDFがありません</span>');
        else {
          put(`<button id="pdfgo">PDFを作業フォルダーに保存（${mb(st.available.size)} MB）</button>`);
          $('#pdfgo').onclick = start;
        }
      };
      const start = run(async () => {
        failure = '';
        const b = $('#pdfgo'); if (b) b.disabled = true;
        await api('POST', base);
        sawRunning = true;
        await refresh();
      });
      refresh();
    }
  };

  if (p.source) await renderMatch(); else await renderSource();
}

// ---------- text comparison ----------
// ---------- proofreading ----------
async function proofView(slug, idx, life) {
  const api = life.api;
  let p = await api('GET', `/api/projects/${slug}`);
  if (!p.source && !browserMode) { location.hash = `#/p/${slug}/setup`; return; }
  const providerInfo = () => p.ocr_providers?.[$('#ocrprovider').value] || {available: p.ocr, reason:p.ocr_reason};
  const canOcr = () => providerInfo().available && !!$('#ocrm').value.trim();
  const N = p.pages.length;
  let lastKey = `proof-last-${slug}`;
  if (idx == null || isNaN(idx)) { try { idx = parseInt(localStorage.getItem(lastKey), 10) || 0; } catch (e) { idx = 0; } }
  idx = Math.max(0, Math.min(N - 1, idx));
  try { localStorage.setItem(lastKey, idx); } catch (e) {}
  const label = i => p.pages[i].unassigned ? '未割当の末尾' : `V${String(p.pages[i].vol).padStart(2, '0')}P${String(p.pages[i].page).padStart(3, '0')}`;
  document.title = `${label(idx)} - ${p.uri}`;

  topbar.innerHTML = `
    <span class="ar" title="${esc(p.uri)}">${esc(p.title || p.uri)}</span>
    <div class="grp">
      <button id="prev" title="前のページ（Alt+PageUp）">← 前</button>
      <input class="pagesel" id="psel" list="plist" value="${label(idx)}" title="ページ（V01P063 の形式、または通し番号）">
      <datalist id="plist">${p.pages.map((_, i) => `<option value="${label(i)}">`).join('')}</datalist>
      <span class="muted small">${idx + 1}/${N}</span>
      <button id="next" title="次のページ（Alt+PageDown）">次 →</button>
      <button id="todo" class="primary" title="まだ確認していない次のページへ">次の未確認</button>
    </div>
    <span class="prog" id="prog"></span>
    <div class="grp" style="margin-left:auto">
      <a href="#/p/${slug}/setup/${idx}">資料・ページ対応</a>
      <button id="findb">ページを探す</button><button id="bibliob">書誌</button>
      <div class="menu needs-server"><button id="optb">比較の設定</button><div class="pop" id="opt" hidden>
        <label><input type="checkbox" data-k="ortho"> ハムザ・ター・マルブータ・ヤーの違いを無視</label>
        <label><input type="checkbox" data-k="punct"> 句読点・記号の違いを無視</label>
        <label><input type="checkbox" data-k="space"> 語の続け書き・分かち書きの違いを無視</label>
        <label><input type="checkbox" data-k="vowels"> 母音記号も厳密に比較する</label>
        <label><input type="checkbox" data-k="header"> 柱・ページ番号も比較する</label>
        <label><input type="checkbox" data-k="foot"> 脚注も比較する</label>
        <label><input type="checkbox" data-k="autoOcr"> ページを開いたら自動で読み取る</label>
      </div></div>
      <div class="menu"><button id="expb">書き出し</button><div class="pop" id="exp" hidden>
        <a href="/api/projects/${slug}/export?fmt=text"><button style="width:100%">校正済みテキスト（OpenITI形式）</button></a>
        <a class="needs-server" href="/api/projects/${slug}/export?fmt=diff"><button style="width:100%">元テキストとの差分（.diff）</button></a>
        <a href="/api/projects/${slug}/export?fmt=tei"><button style="width:100%">TEI XML（基本構造）</button></a>
        <a class="needs-server" href="/api/projects/${slug}/export?fmt=package"><button style="width:100%">本文・書誌パッケージ（ZIP）</button></a>
        <a href="/api/projects/${slug}/export?fmt=notes"><button style="width:100%">注記・確認状況（CSV）</button></a>
        <a href="/api/projects/${slug}/export?fmt=bundle"><button style="width:100%">バックアップを書き出す（.proofreader.json）</button></a>
      </div></div>
    </div>`;

  view.innerHTML = `<dialog id="finder" aria-labelledby="findtitle"><h2 id="findtitle">ページを探す</h2>
    <form id="findform"><label>本文・注記 <input type="search" id="findq"></label>
    <label>対象 <select id="findfilter"><option value="all">すべて</option><option value="todo">未確認</option><option value="edited">修正あり</option><option value="noted">注記あり</option></select></label>
    <button type="submit">検索</button><button type="button" id="findclose">閉じる</button></form>
    <div id="findresults" aria-live="polite"></div></dialog><div class="proof">
    <section class="imgpane${browserMode && !p.source ? ' needs-server' : ''}">
      <div class="toolbar">
        <button id="zo" aria-label="画像を縮小">−</button><button id="zv" class="small" title="100%に戻す"></button><button id="zi" aria-label="画像を拡大">+</button>
        <select id="zf" title="画像の合わせ方（切り替えると100%に戻ります）"><option value="width">幅に合わせる</option><option value="height">高さに合わせる</option></select>
        <span style="flex:1"></span>
        <span class="small" id="imginfo"></span>
        <span class="small">このページ以降：</span><button id="shl" title="このページ以降の画像を1枚戻す">◀</button><button id="shr" title="このページ以降の画像を1枚進める">▶</button>
        <a id="ialink" class="small" target="_blank" rel="noopener">原本</a>
      </div>
      <div class="imgview" id="imgview"><div class="imgmsg">読み込み中…</div></div>
    </section>
    <section class="textpane">
      <div class="marks" id="marks"><span class="small">記号：</span><button type="button" class="mk" data-tag="# " title="段落・韻文の行の始まり：#"><span dir="ltr">#</span></button><button type="button" class="mk" data-tag="~~" title="行の続き：~~"><span dir="ltr">~~</span></button><button type="button" class="mk" data-tag="### | " title="章の見出し：### |"><span dir="ltr">### |</span></button><button type="button" class="mk" data-tag="### || " title="節の見出し：### ||"><span dir="ltr">### ||</span></button><button type="button" class="mk" data-tag="### ||| " title="小節の見出し：### |||"><span dir="ltr">### |||</span></button><button type="button" class="mk" data-tag="### |EDITOR|" title="編集者による部分（単独の行）：### |EDITOR|"><span dir="ltr">### |EDITOR|</span></button><button type="button" class="mk" data-tag="### $ " title="伝記・辞書の項目：### $"><span dir="ltr">### $</span></button><button type="button" class="mk" data-tag="### @ " title="出来事：### @"><span dir="ltr">### @</span></button><button type="button" class="mk" data-tag="%~%" title="韻文の半句の区切り（カーソル位置）：%~%"><span dir="ltr">%~%</span></button></div>
      <textarea class="editor ar" id="ed" aria-label="校正テキスト" dir="rtl" spellcheck="false" disabled></textarea>
      <div class="status">
        <label><input type="checkbox" id="done"> 確認済み</label>
        <input type="text" class="note" id="note" aria-label="ページの注記" placeholder="注記（例：ブーバーヤ版 p.152 では … と読む）">
        <button id="undo" disabled>取り消す</button><button id="redo" disabled>やり直す</button>
        <button id="historyb">保存履歴</button><button id="revert" hidden>原文に戻す</button>
        <span class="saved" id="saved" role="status" aria-live="polite">保存済み</span><button id="retry" hidden>保存を再試行</button>
      </div>
      <div class="ocrpane needs-server">
        <div class="ocrhead">
          <button id="ocrb" class="primary">AIで読み取る</button>
          <select id="ocrprovider" aria-label="AI提供元">${Object.entries(p.ocr_providers || {}).map(([k,v]) => `<option value="${esc(k)}">${esc(v.label)}</option>`).join('')}</select>
          <input id="ocrm" list="ocrmodels" aria-label="読み取りモデル" placeholder="画像対応モデルID"><datalist id="ocrmodels"></datalist>
          <label class="small">保存した読み <select id="readings" aria-label="保存した読み取り結果"><option value="">現在の読み</option></select></label>
          <span id="ocrmsg" class="small muted"></span>
        </div>
        <div id="diff"></div>
        <details id="rawd" hidden><summary>読み取り結果の全文</summary><div class="ocrraw ar" id="raw"></div></details>
        <div class="help"><kbd>Ctrl</kbd>+<kbd>Enter</kbd> 確認済みにして次の未確認ページへ ／ <kbd>Alt</kbd>+<kbd>PageUp</kbd><kbd>PageDown</kbd> ページ移動 ／ 黄色の語をクリックすると入力欄のその語を選択、点線の枠をクリックするとAIの読みに置き換えます。</div>
      </div>
    </section></div>`;

  const ed = $('#ed');
  let pg = await api('GET', `/api/projects/${slug}/pages/${idx}`);
  ed.value = pg.text;
  ed.disabled = false;
  if (pg.unassigned) toast('最後のページ記号の後に本文が残っています。未割当部分として確認してください', true);
  const narrow = matchMedia('(max-width:900px)');
  if (prefs.editorH && !narrow.matches) ed.style.height = Math.max(120, Math.min(prefs.editorH, ed.parentElement.clientHeight * 0.8)) + 'px';
  let edDown = null;
  ed.addEventListener('pointerdown', () => { edDown = ed.offsetHeight; });
  const edUp = () => {
    const h = ed.offsetHeight;
    if (edDown !== null && h !== edDown && h && !narrow.matches) prefs.editorH = h;
    edDown = null;
  };
  window.addEventListener('pointerup', edUp);
  life.cleanup.push(() => window.removeEventListener('pointerup', edUp));
  const originalDisplay = pg.original.replace(/\r\n?/g, '\n');
  $('#done').checked = pg.done;
  $('#note').value = pg.note;

  // progress
  const progress = () => {
    $('#prog').innerHTML = `確認済み ${p.done.length}/${N} <span class="bar"><i style="width:${(100 * p.done.length / N).toFixed(1)}%"></i></span> 修正 ${p.edited.length}`;
    $('#revert').hidden = ed.value === originalDisplay;
  };
  progress();

  // saving
  const saver = createSaver(async body => {
    p = await api('PUT', `/api/projects/${slug}/pages/${idx}`, {...body, revision: pg.revision});
    pg.revision = p.revision;
    $('#done').checked = p.done.includes(idx);
    progress();
  }, (state, error) => {
    if (!life.alive) return;
    $('#saved').textContent = {dirty: '未保存', saving: '保存中…', saved: '保存済み', error: '保存失敗：変更は未保存です'}[state];
    $('#retry').hidden = state !== 'error';
    if (error) toast(error.message, true);
  });
  const save = saver.save, flush = saver.flush;
  leave = flush;
  const unload = e => { if (saver.dirty()) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', unload);
  life.cleanup.push(() => window.removeEventListener('beforeunload', unload));
  $('#retry').onclick = () => flush().catch(() => {});

  const history = [ed.value];
  let historyAt = 0;
  const historyButtons = () => { $('#undo').disabled = historyAt === 0; $('#redo').disabled = historyAt === history.length - 1; };
  const textChanged = (record = true) => {
    if (record && history[historyAt] !== ed.value) {
      history.splice(historyAt + 1); history.push(ed.value);
      if (history.length > 100) history.shift();
      historyAt = history.length - 1;
    }
    historyButtons();
    save({text: ed.value === originalDisplay ? pg.original : ed.value});
    progress(); scheduleDiff();
  };
  const undo = delta => {
    const at = historyAt + delta;
    if (at < 0 || at >= history.length) return;
    historyAt = at; ed.value = history[at]; textChanged(false); renderDiff(); ed.focus();
  };
  $('#undo').onclick = () => undo(-1); $('#redo').onclick = () => undo(1);

  ed.addEventListener('input', () => textChanged());
  for (const b of document.querySelectorAll('#marks .mk')) {
    b.onmousedown = e => e.preventDefault();
    b.onclick = () => {
      if (ed.disabled) return;
      const r = insertMarkup(ed.value, ed.selectionStart, ed.selectionEnd, b.dataset.tag);
      ed.value = r.text; ed.setSelectionRange(r.start, r.end); ed.focus(); textChanged();
    };
  }
  $('#note').addEventListener('input', e => save({note: e.target.value}));
  $('#done').onchange = e => save({done: e.target.checked});
  $('#revert').onclick = () => { ed.value = originalDisplay; textChanged(); renderDiff(); };

  // navigation
  const go = async i => { try { await flush(); if (life.alive) location.hash = `#/p/${slug}/${Math.max(0, Math.min(N - 1, i))}`; } catch (e) {} };
  $('#prev').disabled = idx === 0; $('#next').disabled = idx === N - 1;
  for (const link of document.querySelectorAll('#exp a')) link.onclick = async e => {
    e.preventDefault();
    try { await flush(); } catch (e) { return; }
    if (!life.alive) return;
    if (!browserMode) { location.assign(link.href); return; }
    try { await saveDownload(link.getAttribute('href')); } catch (e) { toast(e.message, true); }
  };
  const finder = $('#finder');
  let searchVersion = 0;
  const findPages = async e => {
    if (e) e.preventDefault();
    const version = ++searchVersion, box = $('#findresults');
    const q = $('#findq').value, filter = $('#findfilter').value;
    box.textContent = '検索中…';
    try {
      await flush();
      const results = await api('GET', `/api/projects/${slug}/search?q=${encodeURIComponent(q)}&filter=${filter}`);
      if (!life.alive || version !== searchVersion) return;
      box.innerHTML = `<p>${results.length}ページ</p>` + results.map(r => `<button type="button" data-i="${r.i}">${esc(r.marker)}${r.note ? ' — ' + esc(r.note) : ''}</button>`).join('');
    } catch (e) { if (life.alive) box.textContent = e.message; }
  };
  $('#findb').onclick = () => { finder.showModal(); findPages(); };
  $('#findform').onsubmit = findPages;
  $('#findclose').onclick = () => finder.close();
  $('#findresults').onclick = e => { const b = e.target.closest('[data-i]'); if (b) { finder.close(); go(+b.dataset.i); } };
  $('#prev').onclick = () => go(idx - 1);
  $('#next').onclick = () => go(idx + 1);
  $('#psel').onchange = e => {
    const v = e.target.value.trim().toUpperCase();
    let i = p.pages.findIndex((_, k) => label(k) === v);
    if (i < 0 && /^\d+$/.test(v)) i = parseInt(v, 10) - 1;
    if (i < 0) { const m = v.match(/P0*(\d+)$/); if (m) i = p.pages.findIndex(x => x.page === +m[1]); }
    if (i >= 0 && i < N) go(i); else toast('そのページはありません', true);
  };
  const nextTodo = async () => {
    try { await flush(); } catch (e) { return; }
    if (!life.alive) return;
    const done = new Set(p.done);
    for (let k = 1; k <= N; k++) { const i = (idx + k) % N; if (!done.has(i)) return go(i); }
    toast('すべてのページが確認済みです');
  };
  $('#todo').onclick = nextTodo;
  const onKey = async e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && e.target === ed && !e.isComposing) { e.preventDefault(); undo(e.shiftKey ? 1 : -1); }
    else if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); $('#done').checked = true; save({done: true}); nextTodo(); }
    else if (e.altKey && e.key === 'PageDown') { e.preventDefault(); go(idx + 1); }
    else if (e.altKey && e.key === 'PageUp') { e.preventDefault(); go(idx - 1); }
  };
  document.addEventListener('keydown', onKey);
  life.cleanup.push(() => document.removeEventListener('keydown', onKey));

  // menus
  for (const [b, m] of [['optb', 'opt'], ['expb', 'exp']]) $('#' + b).onclick = e => { e.stopPropagation(); $('#' + m).hidden = !$('#' + m).hidden; };
  const closeMenus = e => { if (!e.target.closest('.menu')) for (const m of ['opt', 'exp']) { const el = $('#' + m); if (el) el.hidden = true; } };
  document.addEventListener('click', closeMenus);
  life.cleanup.push(() => document.removeEventListener('click', closeMenus));
  for (const cb of document.querySelectorAll('#opt input')) {
    cb.checked = !!prefs[cb.dataset.k];
    cb.onchange = () => { prefs[cb.dataset.k] = cb.checked; renderDiff(); };
  }

  // image
  const imgview = $('#imgview');
  let pdfCanvas = null;
  const applyZoom = () => {
    $('#zv').textContent = prefs.zoom + '%';
    $('#zf').value = prefs.fit;
    const el = imgview.firstElementChild;
    if (!el || !(el.tagName === 'IMG' || el.tagName === 'CANVAS')) return;
    if (prefs.fit === 'height') { el.style.width = 'auto'; el.style.height = Math.round(imgview.clientHeight * prefs.zoom / 100) + 'px'; }
    else { el.style.height = 'auto'; el.style.width = prefs.zoom + '%'; }
  };
  const observer = new ResizeObserver(() => { if (life.alive && prefs.fit === 'height') applyZoom(); });
  observer.observe(imgview);
  life.cleanup.push(() => observer.disconnect());
  let imageVersion = 0;
  // バックアップから戻した資料には PDF が無いので、選び直してもらう（ページ数が記録と違えば確認する）
  const reattachPrompt = im => {
    const box = document.createElement('div'); box.className = 'imgmsg'; imgview.replaceChildren(box);
    reattachControl(box, {slug, source: p.source, api, life, done: async updated => {
      p = updated;
      pg = {...pg, image: await api('GET', `/api/projects/${slug}/image?index=${im.index}`)};
      toast('PDFを保存しました');
      showImage();
    }});
  };
  const showImage = async () => {
    const version = ++imageVersion;
    const im = pg.image;
    const failed = error => {
      if (!life.alive || version !== imageVersion) return;
      imgview.innerHTML = `<div class="imgmsg">画像を表示できません：${esc(error.message)} <button id="imgretry">再試行</button></div>`;
      $('#imgretry').onclick = showImage;
    };
    $('#imginfo').textContent = im ? `画像 ${im.index + 1}/${im.count}${im.label && im.label !== String(im.index) ? `（${im.label}）` : ''}` : '';
    $('#ialink').hidden = !(im && im.link); if (im && im.link) $('#ialink').href = im.link;
    if (im && im.no_file) { reattachPrompt(im); return; }
    if (!im || im.missing) { imgview.innerHTML = '<div class="imgmsg">このページに対応する画像がありません。未割当の末尾の場合は、本文を確認してページ区切りを原本に照らして整理してください。</div>'; return; }
    if (im.unavailable) { imgview.innerHTML = `<div class="imgmsg">${esc(im.unavailable)}</div>`; return; }
    if (im.url) {
      imgview.innerHTML = '<div class="imgmsg">読み込み中…（数秒〜数十秒かかることがあります）</div>';
      const el = new Image();
      el.alt = '原本のページ画像';
      loadScan(el, im.url, {current: () => life.alive && version === imageVersion, onfail: failed, onload: () => {
        imgview.innerHTML = ''; imgview.appendChild(el); applyZoom();
        // warm the server's cache for the next image; it costs no API fee（ブラウザ版は IA に余分な要求を送らない）
        if (!browserMode && im.index + 1 < im.count) new Image().src = im.url.replace(/\/scan\/\d+/, `/scan/${im.index + 1}`);
      }});
      return;
    }
    else {
      imgview.innerHTML = '<div class="imgmsg">描画中…</div>';
      try { pdfCanvas = await renderPdfPage(im.pdf, im.index, 1600); }
      catch (e) { failed(e); return; }
      if (!life.alive || version !== imageVersion) return;
      imgview.innerHTML = ''; if (pdfCanvas) imgview.appendChild(pdfCanvas); else imgview.innerHTML = '<div class="imgmsg">画像がありません</div>';
    }
    applyZoom();
  };
  $('#zo').onclick = () => { prefs.zoom = Math.max(30, prefs.zoom - 15); applyZoom(); };
  $('#zi').onclick = () => { prefs.zoom = Math.min(400, prefs.zoom + 15); applyZoom(); };
  $('#zf').onchange = e => { prefs.fit = e.target.value; prefs.zoom = 100; applyZoom(); };
  $('#zv').onclick = () => { prefs.zoom = 100; applyZoom(); };
  let shifting = false, ocrBusy = false;
  const shift = async d => {
    if (shifting || ocrBusy) return;
    if (pg.unassigned) { toast('末尾の本文にはページ番号がありません', true); return; }
    const cur = pg.image ? pg.image.index : idx;
    if (cur + d < 0 || cur + d >= p.source.count) { toast('資料の画像範囲外です', true); return; }
    shifting = true; $('#ocrb').disabled = true;
    try {
      p = await api('POST', `/api/projects/${slug}/mapping`, {anchor: [idx, cur + d]});
      const mapped = await api('GET', `/api/projects/${slug}/pages/${idx}`);
      pg = {...pg, image: mapped.image, ocr: mapped.ocr};
      ocr = latestReading = pg.ocr;
      if (!browserMode) await refreshReadings();
      toast('このページ以降の画像の対応をずらしました');
      showImage(); renderDiff();
    } catch (e) { if (life.alive) toast(e.message, true); }
    finally { shifting = false; if (life.alive) $('#ocrb').disabled = !canOcr(); }
  };
  $('#shl').onclick = () => shift(-1);
  $('#shr').onclick = () => shift(1);
  showImage();

  // OCR + diff
  let ocr = pg.ocr, latestReading = pg.ocr;
  let diffT;
  life.cleanup.push(() => clearTimeout(diffT));
  const scheduleDiff = () => {
    clearTimeout(diffT);
    $('#diff').querySelectorAll('button').forEach(b => b.disabled = true);
    diffT = setTimeout(renderDiff, 400);
  };
  function renderDiff() {
    if (!life.alive) return;
    const box = $('#diff');
    $('#rawd').hidden = !ocr;
    if (!ocr) {
      box.innerHTML = ''; $('#ocrb').textContent = 'AIで読み取る';
      if (!ocrBusy) $('#ocrmsg').textContent = canOcr() ? '' : ocrWhy();
      return;
    }
    $('#ocrb').textContent = '読み直す';
    $('#raw').textContent = ocr.text;
    const A = textTokens(ed.value, prefs), B = ocrTokens(ocr.text, prefs);
    const blocks = diffBlocks(A, B, prefs);
    $('#ocrmsg').innerHTML = (blocks.length ? `<span class="badge b-warn">食い違い ${blocks.length} か所</span>` : '<span class="badge b-ok">食い違いなし</span>')
      + (ocr.legacy ? ' <span class="badge b-warn" title="資料・画像の識別情報がない旧形式のキャッシュです。読み取り時の資料と同じかは確かめられません。「読み直す」で新しく読み取れます。">旧形式の読み取り（この画像を読んだものか未確認）</span>' : '')
      + (ocr.truncated ? ' <span class="badge b-bad">読み取りが途中で切れています</span>' : '')
      + (ocr.model ? ` ${esc(ocr.model)} の読み` : '');
    if (!blocks.length) { box.innerHTML = ''; return; }
    const text = ed.value;
    let html = '', pos = 0;
    blocks.forEach(([a1, a2, b1, b2], bi) => {
      const alt = B.slice(b1, b2).map(t => t.w).join(' ');
      if (a1 === a2) {
        const at = a1 < A.length ? A[a1].start : text.length;
        html += esc(text.slice(pos, at)) + `<button class="chip ins ar" data-b="${bi}" title="AIの読みにある語を挿入">${esc(alt)}</button>`;
        pos = at;
      } else {
        const s = A[a1].start, e = A[a2 - 1].end;
        html += esc(text.slice(pos, s)) + `<button type="button" class="sp" data-s="${s}" data-e="${e}" title="入力欄の該当箇所を選択">${esc(text.slice(s, e))}</button>`
          + (alt ? `<button class="chip ar" data-b="${bi}" title="AIの読みに置き換える">${esc(alt)}</button>`
                 : `<button class="chip del" data-b="${bi}" title="AIの読みにはない語を削除">削除</button>`);
        pos = e;
      }
    });
    html += esc(text.slice(pos));
    box.innerHTML = `<div class="diff ar">${html}</div>`;
    box.querySelectorAll('.sp').forEach(sp => sp.onclick = () => { if (ed.value !== text) { renderDiff(); return; } ed.focus(); ed.setSelectionRange(+sp.dataset.s, +sp.dataset.e); });
    box.querySelectorAll('.chip').forEach(btn => {
      btn.disabled = readingPatch(text, A, B, blocks[+btn.dataset.b], ocr.truncated) === null;
      if (btn.disabled) btn.title = '構造をまたぐ変更・不完全な読取のため手動確認が必要です';
      btn.onclick = () => {
        if (ed.value !== text) { renderDiff(); return; }
        const v = readingPatch(ed.value, A, B, blocks[+btn.dataset.b], ocr.truncated);
        if (v === null) { toast('構造記号をまたぐ変更や不完全な読取は、原本を見て手動で修正してください', true); return; }
        ed.value = v; textChanged(); renderDiff();
      };
    });
  }
  const ocrWhy = () => !providerInfo().available ? providerInfo().reason || 'AIの設定を確認してください' : '読み取りに使う画像対応モデルIDを入力してください';
  const runOcr = async force => {
    if (ocrBusy || shifting) return;
    if (!canOcr()) { toast(ocrWhy(), true); return; }
    ocrBusy = true;
    const imageKey = pg.image && pg.image.key;
    $('#shl').disabled = $('#shr').disabled = true;
    $('#ocrb').disabled = true; $('#ocrmsg').textContent = '読み取り中…（数十秒かかります）';
    try {
      const body = {force, provider: $('#ocrprovider').value, model: $('#ocrm').value.trim(), image_key: imageKey};
      if (pg.image && pg.image.pdf) {
        const c = await renderPdfPage(pg.image.pdf, pg.image.index, 2000);
        if (!life.alive) return;
        if (!c) throw new Error('このページに対応する画像がありません');
        body.image = c.toDataURL('image/jpeg', 0.9);
      }
      const result = await api('POST', `/api/projects/${slug}/pages/${idx}/ocr`, body);
      if (!life.alive || pg.image.key !== imageKey) return;
      ocr = latestReading = result;
      await refreshReadings();
      renderDiff();
    } catch (e) { if (life.alive) { $('#ocrmsg').textContent = ''; toast(e.message, true); } }
    finally { ocrBusy = false; if (life.alive) { $('#ocrb').disabled = !canOcr(); $('#shl').disabled = $('#shr').disabled = false; } }
  };
  $('#ocrb').onclick = () => runOcr(!!ocr);
  const ocrm = $('#ocrm'), providerSelect = $('#ocrprovider');
  providerSelect.value = prefs.ocrProvider;
  if (!providerSelect.value) providerSelect.selectedIndex = 0;
  const configureProvider = () => {
    const info = providerInfo();
    prefs.ocrProvider = providerSelect.value;
    $('#ocrmodels').innerHTML = Object.entries(info.models || {}).map(([key, label]) => `<option value="${esc(key)}">${esc(label)}</option>`).join('');
    ocrm.value = (providerSelect.value === 'openai' ? prefs.openaiModel : prefs.ocrModel) || info.default || '';
    $('#ocrb').disabled = !canOcr();
    $('#ocrmsg').textContent = canOcr() ? '' : ocrWhy();
  };
  providerSelect.onchange = configureProvider;
  ocrm.oninput = () => {
    prefs[providerSelect.value === 'openai' ? 'openaiModel' : 'ocrModel'] = ocrm.value;
    $('#ocrb').disabled = !canOcr();
  };
  configureProvider();
  let readings = [];
  const refreshReadings = async () => {
    readings = await api('GET', `/api/projects/${slug}/pages/${idx}/readings`);
    $('#readings').innerHTML = '<option value="">現在の読み</option>' + readings.map((r, i) => `<option value="${i}">${esc(r.time || '')} ${esc(r.provider || 'anthropic')} ${esc(r.model || '')}</option>`).join('');
  };
  $('#readings').onchange = e => { ocr = e.target.value === '' ? latestReading : readings[+e.target.value]; renderDiff(); };
  if (!browserMode) refreshReadings().catch(e => { if (life.alive) toast(e.message, true); });
  $('#historyb').onclick = () => showPageHistory(life, slug, idx, async text => { await flush(); ed.value = text; textChanged(); save({checkpoint: true}); renderDiff(); await flush(); });
  $('#bibliob').onclick = () => editBibliography(life, p, updated => { p = updated; });
  renderDiff();
  if (!ocr && canOcr() && prefs.autoOcr && pg.image && !pg.image.missing) runOcr(false);
  ed.focus({preventScroll: true});
}

routeNow();
