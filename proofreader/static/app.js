'use strict';
// OpenITI proofreading UI: home (projects), setup (scan source + page mapping), proofreading.

const $ = (sel, root = document) => root.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const view = $('#view'), topbar = $('#topbar');

async function api(method, url, body, headers) {
  const opt = {method, headers: headers || {}};
  if (body instanceof Blob || body instanceof ArrayBuffer) opt.body = body;
  else if (body !== undefined) { opt.body = JSON.stringify(body); opt.headers['Content-Type'] = 'application/json'; }
  const r = await fetch(url, opt);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `${r.status} ${r.statusText}`);
  return data;
}

let toastT;
function toast(msg, err) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, err ? 6000 : 2500);
}

const prefs = (() => {
  const def = {ortho: true, punct: true, space: true, header: false, foot: false, autoOcr: false, ocrModel: 'claude-opus-5-5', zoom: 100, fit: 'width'};
  let v = def;
  try { v = Object.assign({}, def, JSON.parse(localStorage.getItem('proof-prefs') || '{}')); } catch (e) {}
  return new Proxy(v, {set(o, k, val) { o[k] = val; try { localStorage.setItem('proof-prefs', JSON.stringify(o)); } catch (e) {} return true; }});
})();

// ---------- pdf.js (only loaded for uploaded PDFs) ----------
let pdfLib, pdfDocs = {};
async function loadPdf(url) {
  if (!pdfLib) {
    await new Promise((ok, ng) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
      s.onload = ok; s.onerror = () => ng(new Error('pdf.js を読み込めませんでした'));
      document.head.appendChild(s);
    });
    pdfLib = window.pdfjsLib;
    pdfLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }
  if (!pdfDocs[url]) pdfDocs[url] = pdfLib.getDocument(url).promise;
  return pdfDocs[url];
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
let leave = null;  // cleanup of the current view
async function routeNow() {
  if (leave) { await leave(); leave = null; }
  const h = location.hash.replace(/^#\/?/, '').split('/');
  topbar.innerHTML = '';
  try {
    if (h[0] === 'p' && h[1] && h[2] === 'setup') await setupView(h[1]);
    else if (h[0] === 'p' && h[1]) await proofView(h[1], h[2] ? parseInt(h[2], 10) : null);
    else await homeView();
  } catch (e) {
    view.innerHTML = `<div class="wrap"><div class="card">読み込めませんでした：${esc(e.message)}　<a href="#/">ホームへ</a></div></div>`;
  }
}

// ---------- home ----------
async function homeView() {
  document.title = 'OpenITI 校正';
  const list = await api('GET', '/api/projects');
  view.innerHTML = `<div class="wrap">
    <div class="card">
      <h2>新しいテキストを読み込む</h2>
      <div class="row">
        <input type="text" id="ref" placeholder="OpenITIのバージョンURI、またはGitHubのURL（例：1014IbnMaryamTilimsani.Bustan.Kraken22021817402301-ara1）">
        <button class="primary" id="go">読み込む</button>
      </div>
      <div class="row" style="margin-top:8px"><span class="muted small">または手元のOpenITI形式ファイル：</span><input type="file" id="file" accept=".txt,.mARkdown,.completed,.inProgress,text/plain"></div>
    </div>
    <div class="card">
      <h2>校正中のテキスト</h2>
      ${list.length ? `<table><thead><tr><th>書名</th><th>URI</th><th>ページ</th><th>確認済み</th><th>修正</th><th></th></tr></thead><tbody>
        ${list.map(p => `<tr>
          <td><span class="ar">${esc(p.title || '—')}</span><div class="muted small ar">${esc(p.author)}</div></td>
          <td class="small">${esc(p.uri)}</td><td>${p.pages}</td>
          <td><span class="bar"><i style="width:${(100 * p.done / p.pages).toFixed(1)}%"></i></span> <span class="prog">${p.done}</span></td>
          <td class="prog">${p.edited}</td>
          <td><a href="#/p/${p.slug}${p.source ? '' : '/setup'}"><button>${p.source ? '開く' : '設定を続ける'}</button></a></td>
        </tr>`).join('')}</tbody></table>` : '<p class="muted">まだありません。</p>'}
    </div></div>`;
  const go = async () => {
    const ref = $('#ref').value.trim(); if (!ref) return;
    $('#go').disabled = true; $('#go').textContent = '取得中…';
    try { const p = await api('POST', '/api/projects', {ref}); location.hash = `#/p/${p.slug}/setup`; }
    catch (e) { toast(e.message, true); $('#go').disabled = false; $('#go').textContent = '読み込む'; }
  };
  $('#go').onclick = go;
  $('#ref').onkeydown = e => { if (e.key === 'Enter') go(); };
  $('#file').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try { const p = await api('POST', '/api/projects/upload-text', f, {'X-Filename': encodeURIComponent(f.name)}); location.hash = `#/p/${p.slug}/setup`; }
    catch (err) { toast(err.message, true); }
  };
}

// ---------- setup: scan source and page mapping ----------
async function setupView(slug) {
  let p = await api('GET', `/api/projects/${slug}`);
  document.title = `設定 - ${p.uri}`;
  topbar.innerHTML = `<span class="ar">${esc(p.title)}</span><span class="muted small">${esc(p.uri)}</span>`;

  const renderSource = async () => {
    const terms = (await api('GET', `/api/projects/${slug}/search-terms`)).q;
    view.innerHTML = `<div class="wrap">
      <div class="steps"><span>1. テキスト ✓</span>›<span class="on">2. ページ画像</span>›<span>3. ページの対応</span></div>
      <div class="card">
        <h2>ページ画像を選ぶ</h2>
        ${p.candidates.length ? `<h3>メタデータに書かれた Internet Archive の資料</h3>
          <div id="cands" class="results"></div>` : '<p class="muted small">メタデータに Internet Archive へのリンクはありませんでした。</p>'}
        <h3>Internet Archive を検索</h3>
        <div class="row"><input type="search" id="q" value="${esc(terms)}"><button id="search">検索</button></div>
        <div id="results" class="results"></div>
        <h3>識別子・URLを直接指定</h3>
        <div class="row"><input type="text" id="iaid" placeholder="例：ElBoustane または https://archive.org/details/ElBoustane"><button id="useid">使う</button></div>
        <h3>手元のPDFをアップロード</h3>
        <div class="row"><input type="file" id="pdf" accept="application/pdf"><span id="pdfmsg" class="muted small"></span></div>
      </div></div>`;
    const card = r => `<div class="res"><img loading="lazy" src="${esc(r.thumb)}" alt="">
      <div class="t"><b>${esc(r.title)}</b><span class="muted small">${esc(r.creator)} ${esc(r.date)}${r.imagecount ? ` ・${r.imagecount}枚` : ''}</span>
      <div class="row" style="margin-top:4px"><button data-id="${esc(r.id)}" class="primary use">使う</button><a class="small" target="_blank" rel="noopener" href="https://archive.org/details/${esc(r.id)}">IAで見る</a></div></div></div>`;
    if (p.candidates.length) $('#cands').innerHTML = p.candidates.map(id => card({id, title: id, thumb: `https://archive.org/services/img/${id}`, creator: '', date: ''})).join('');
    const use = async id => {
      toast('ページ一覧を取得しています…');
      try { p = await api('POST', `/api/projects/${slug}/source/ia`, {id}); renderMatch(); }
      catch (e) { toast(e.message, true); }
    };
    view.addEventListener('click', e => { const b = e.target.closest('button.use'); if (b) use(b.dataset.id); });
    const search = async () => {
      $('#results').innerHTML = '<span class="muted">検索中…</span>';
      try {
        const rs = await api('GET', `/api/ia/search?q=${encodeURIComponent($('#q').value)}`);
        $('#results').innerHTML = rs.length ? rs.map(card).join('') : '<span class="muted">見つかりませんでした。語を減らすか、ラテン文字の書名・著者名でも試してください。</span>';
      } catch (e) { $('#results').innerHTML = `<span class="muted">${esc(e.message)}</span>`; }
    };
    $('#search').onclick = search;
    $('#q').onkeydown = e => { if (e.key === 'Enter') search(); };
    $('#useid').onclick = () => use($('#iaid').value);
    $('#pdf').onchange = async e => {
      const f = e.target.files[0]; if (!f) return;
      $('#pdfmsg').textContent = 'ページ数を確認しています…';
      try {
        const url = URL.createObjectURL(f);
        const doc = await loadPdf(url);
        $('#pdfmsg').textContent = `${doc.numPages}ページ。アップロード中…`;
        p = await api('POST', `/api/projects/${slug}/source/pdf`, f, {'X-Filename': encodeURIComponent(f.name), 'X-Page-Count': String(doc.numPages)});
        renderMatch();
      } catch (err) { $('#pdfmsg').textContent = ''; toast(err.message, true); }
    };
    if (!p.candidates.length && terms) search();
  };

  const renderMatch = async () => {
    // pick the first page with a reasonable amount of text as the reference
    let ref = 0;
    for (let i = 0; i < Math.min(p.pages.length, 40); i++) {
      const pg = await api('GET', `/api/projects/${slug}/pages/${i}`);
      if (pg.original.replace(/[\s~#|=]/g, '').length > 200) { ref = i; break; }
    }
    let pg = await api('GET', `/api/projects/${slug}/pages/${ref}`);
    let img = pg.image ? pg.image.index : ref;
    const total = p.source.count;
    view.innerHTML = `<div class="wrap">
      <div class="steps"><span>1. テキスト ✓</span>›<span>2. ページ画像 ✓</span>›<span class="on">3. ページの対応</span></div>
      <div class="card">
        <h2>ページの対応を合わせる</h2>
        <p class="help">左のテキスト（${esc(pg.marker)}）と同じページが右に出るまで、画像の番号を動かしてください。ここで決めた対応が全ページに適用されます。途中でずれた場合は、校正画面でそのページ以降だけ直せます。</p>
        <div class="row">
          <span>資料：<b>${esc(p.source.title || p.source.id || '')}</b>（${total}枚）</span>
          <button id="chg">資料を選び直す</button>
          <span style="flex:1"></span>
          <button id="m10">−10</button><button id="m1">−1</button>
          <span>画像 <input type="number" id="imgn" min="1" max="${total}" style="width:80px"> / ${total}</span>
          <button id="p1">+1</button><button id="p10">+10</button>
          <button class="primary" id="ok">この対応で校正を始める</button>
        </div>
        <div class="match"><div class="pane"><pre class="ar">${esc(pg.original.trim())}</pre></div><div class="pane" id="mimg"></div></div>
      </div></div>`;
    const show = async () => {
      img = Math.max(0, Math.min(total - 1, img));
      $('#imgn').value = img + 1;
      const box = $('#mimg');
      if (p.source.type === 'ia') {
        await api('POST', `/api/projects/${slug}/mapping`, {offset: img - ref, clear_anchors: true});
        const q = await api('GET', `/api/projects/${slug}/pages/${ref}`);
        box.innerHTML = q.image && !q.image.missing ? `<img src="${esc(q.image.url)}" alt="">` : '<div class="imgmsg">画像がありません</div>';
      } else {
        box.innerHTML = '<div class="imgmsg">描画中…</div>';
        const c = await renderPdfPage(p.source.pdf || `/api/projects/${slug}/files/${p.source.file}`, img, 900);
        box.innerHTML = ''; if (c) box.appendChild(c); else box.innerHTML = '<div class="imgmsg">画像がありません</div>';
      }
    };
    for (const [id, d] of [['m10', -10], ['m1', -1], ['p1', 1], ['p10', 10]]) $('#' + id).onclick = () => { img += d; show(); };
    $('#imgn').onchange = e => { img = (parseInt(e.target.value, 10) || 1) - 1; show(); };
    $('#chg').onclick = () => renderSource();
    $('#ok').onclick = async () => {
      await api('POST', `/api/projects/${slug}/mapping`, {offset: img - ref, clear_anchors: true});
      location.hash = `#/p/${slug}/${ref}`;
    };
    show();
  };

  if (p.source) await renderMatch(); else await renderSource();
}

// ---------- text comparison ----------
const ORTHO = {'أ': 'ا', 'إ': 'ا', 'آ': 'ا', 'ٱ': 'ا', 'ى': 'ي', 'ی': 'ي', 'ئ': 'ي', 'ة': 'ه', 'ؤ': 'و', 'ک': 'ك', 'ء': ''};
function normWord(w) {
  let s = w.replace(/[ؐ-ًؚ-ٰٟۖ-ۭـ‌-‏]/g, '');
  if (prefs.ortho) s = s.replace(/./g, c => ORTHO[c] ?? c);
  if (prefs.punct) s = s.replace(/[^\p{L}\p{N}\[\]?]/gu, '');
  return s;
}
// words of the page text with their offsets; OpenITI markup is skipped so only the text is compared
function textTokens(text) {
  const out = [];
  for (const m of text.matchAll(/\S+/g)) {
    let w = m[0], start = m.index;
    const pre = w.match(/^(~~|#+\s*|\|+)/);
    if (pre) { w = w.slice(pre[0].length); start += pre[0].length; }
    if (!w || /^(ms\d+|PageV\d+P\d+|@\w+|\|+|#+|=+)$/.test(w)) continue;
    const n = normWord(w);
    if (!n) continue;
    out.push({w, n, start, end: start + w.length});
  }
  return out;
}
function ocrTokens(ocrText) {
  let lines = ocrText.split('\n');
  const fi = lines.findIndex(l => l.trim() === '@FOOTNOTES');
  if (fi >= 0) lines = prefs.foot ? lines.slice(0, fi).concat(lines.slice(fi + 1)) : lines.slice(0, fi);
  lines = lines.flatMap(l => l.startsWith('@HEADER') ? (prefs.header ? [l.slice(7)] : []) : [l]);
  return lines.join('\n').split(/\s+/).filter(Boolean).map(w => ({w, n: normWord(w)})).filter(t => t.n);
}
// word-level LCS; returns blocks [a1, a2, b1, b2] where the two readings differ
function diffBlocks(A, B) {
  const n = A.length, m = B.length, W = m + 1;
  const L = new Uint16Array((n + 1) * W);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    L[i * W + j] = A[i].n === B[j].n ? L[(i + 1) * W + j + 1] + 1 : Math.max(L[(i + 1) * W + j], L[i * W + j + 1]);
  const blocks = [];
  let i = 0, j = 0, cur = null;
  const flush = () => { if (cur) { blocks.push(cur); cur = null; } };
  while (i < n || j < m) {
    if (i < n && j < m && A[i].n === B[j].n) { flush(); i++; j++; continue; }
    cur = cur || [i, i, j, j];
    if (j < m && (i === n || L[i * W + j + 1] >= L[(i + 1) * W + j])) { j++; cur[3] = j; }
    else { i++; cur[1] = i; }
  }
  flush();
  // split runs of equal length into one-word pairs so each gets its own button
  return blocks.flatMap(([a1, a2, b1, b2]) => a2 - a1 === b2 - b1 && a2 > a1
    ? Array.from({length: a2 - a1}, (_, k) => [a1 + k, a1 + k + 1, b1 + k, b1 + k + 1]) : [[a1, a2, b1, b2]])
    // words run together or split apart (امابعد / اما بعد) only differ in spacing
    .filter(([a1, a2, b1, b2]) => !prefs.space || A.slice(a1, a2).map(t => t.n).join('') !== B.slice(b1, b2).map(t => t.n).join(''));
}

// ---------- proofreading ----------
async function proofView(slug, idx) {
  let p = await api('GET', `/api/projects/${slug}`);
  if (!p.source) { location.hash = `#/p/${slug}/setup`; return; }
  const N = p.pages.length;
  let lastKey = `proof-last-${slug}`;
  if (idx == null || isNaN(idx)) { try { idx = parseInt(localStorage.getItem(lastKey), 10) || 0; } catch (e) { idx = 0; } }
  idx = Math.max(0, Math.min(N - 1, idx));
  try { localStorage.setItem(lastKey, idx); } catch (e) {}
  const label = i => `V${String(p.pages[i].vol).padStart(2, '0')}P${String(p.pages[i].page).padStart(3, '0')}`;
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
      <div class="menu"><button id="optb">比較の設定</button><div class="pop" id="opt" hidden>
        <label><input type="checkbox" data-k="ortho"> ハムザ・ター・マルブータ・ヤーの違いを無視</label>
        <label><input type="checkbox" data-k="punct"> 句読点・記号の違いを無視</label>
        <label><input type="checkbox" data-k="space"> 語の続け書き・分かち書きの違いを無視</label>
        <label><input type="checkbox" data-k="header"> 柱・ページ番号も比較する</label>
        <label><input type="checkbox" data-k="foot"> 脚注も比較する</label>
        <label><input type="checkbox" data-k="autoOcr"> ページを開いたら自動で読み取る</label>
      </div></div>
      <div class="menu"><button id="expb">書き出し</button><div class="pop" id="exp" hidden>
        <a href="/api/projects/${slug}/export?fmt=text"><button style="width:100%">校正済みテキスト（OpenITI形式）</button></a>
        <a href="/api/projects/${slug}/export?fmt=diff"><button style="width:100%">元テキストとの差分（.diff）</button></a>
        <a href="/api/projects/${slug}/export?fmt=notes"><button style="width:100%">注記・確認状況（CSV）</button></a>
        <a href="#/p/${slug}/setup"><button style="width:100%">資料・ページ対応の設定</button></a>
      </div></div>
    </div>`;

  view.innerHTML = `<div class="proof">
    <section class="imgpane">
      <div class="toolbar">
        <button id="zo">−</button><span id="zv" class="small" title="クリックで100%に戻す" style="cursor:pointer"></span><button id="zi">+</button>
        <select id="zf" title="画像の合わせ方（切り替えると100%に戻ります）"><option value="width">幅に合わせる</option><option value="height">高さに合わせる</option></select>
        <span style="flex:1"></span>
        <span class="small" id="imginfo"></span>
        <button id="shl" title="画像を1枚戻す">◀</button><button id="shr" title="画像を1枚進める">▶</button>
        <a id="ialink" class="small" target="_blank" rel="noopener">原本</a>
      </div>
      <div class="imgview" id="imgview"><div class="imgmsg">読み込み中…</div></div>
    </section>
    <section class="textpane">
      <textarea class="editor ar" id="ed" dir="rtl" spellcheck="false"></textarea>
      <div class="status">
        <label><input type="checkbox" id="done"> 確認済み</label>
        <input type="text" class="note" id="note" placeholder="注記（例：ブーバーヤ版 p.152 では … と読む）">
        <button id="revert" hidden>元に戻す</button>
        <span class="saved" id="saved"></span>
      </div>
      <div class="ocrpane">
        <div class="ocrhead">
          <button id="ocrb" class="primary">Claudeで読み取る</button>
          <select id="ocrm" title="読み取りに使うモデル">${Object.entries(p.ocr_models || {}).map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join('')}</select>
          <span id="ocrmsg" class="small muted"></span>
        </div>
        <div id="diff"></div>
        <details id="rawd" hidden><summary>読み取り結果の全文</summary><div class="ocrraw ar" id="raw"></div></details>
        <div class="help"><kbd>Ctrl</kbd>+<kbd>Enter</kbd> 確認済みにして次の未確認ページへ ／ <kbd>Alt</kbd>+<kbd>PageUp</kbd><kbd>PageDown</kbd> ページ移動 ／ 黄色の語をクリックすると入力欄のその語を選択、点線の枠をクリックするとClaudeの読みに置き換えます。</div>
      </div>
    </section></div>`;

  const ed = $('#ed');
  let pg = await api('GET', `/api/projects/${slug}/pages/${idx}`);
  ed.value = pg.text;
  $('#done').checked = pg.done;
  $('#note').value = pg.note;

  // progress
  const progress = () => {
    $('#prog').innerHTML = `確認済み ${p.done.length}/${N} <span class="bar"><i style="width:${(100 * p.done.length / N).toFixed(1)}%"></i></span> 修正 ${p.edited.length}`;
    $('#revert').hidden = ed.value === pg.original;
  };
  progress();

  // saving
  let saveT = null, pending = null;
  const save = async patch => {
    pending = Object.assign(pending || {}, patch);
    clearTimeout(saveT);
    $('#saved').textContent = '…';
    return new Promise(ok => { saveT = setTimeout(async () => { await flush(); ok(); }, 500); });
  };
  const flush = async () => {
    clearTimeout(saveT);
    if (!pending) return;
    const body = pending; pending = null;
    try {
      p = await api('PUT', `/api/projects/${slug}/pages/${idx}`, body);
      $('#saved').textContent = '保存済み'; progress();
    } catch (e) { $('#saved').textContent = '保存失敗'; toast(e.message, true); }
  };
  leave = flush;
  window.onbeforeunload = () => { if (pending) { flush(); return '保存中です'; } };

  ed.addEventListener('input', () => { save({text: ed.value}); progress(); scheduleDiff(); });
  $('#note').addEventListener('input', e => save({note: e.target.value}));
  $('#done').onchange = e => save({done: e.target.checked});
  $('#revert').onclick = () => { ed.value = pg.original; save({text: ed.value}); progress(); renderDiff(); };

  // navigation
  const go = async i => { await flush(); location.hash = `#/p/${slug}/${Math.max(0, Math.min(N - 1, i))}`; };
  $('#prev').onclick = () => go(idx - 1);
  $('#next').onclick = () => go(idx + 1);
  $('#psel').onchange = e => {
    const v = e.target.value.trim().toUpperCase();
    let i = p.pages.findIndex((_, k) => label(k) === v);
    if (i < 0 && /^\d+$/.test(v)) i = parseInt(v, 10) - 1;
    if (i < 0) { const m = v.match(/P0*(\d+)$/); if (m) i = p.pages.findIndex(x => x.page === +m[1]); }
    if (i >= 0) go(i); else toast('そのページはありません', true);
  };
  const nextTodo = () => {
    const done = new Set(p.done);
    for (let k = 1; k <= N; k++) { const i = (idx + k) % N; if (!done.has(i)) return go(i); }
    toast('すべてのページが確認済みです');
  };
  $('#todo').onclick = nextTodo;
  const onKey = async e => {
    if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); $('#done').checked = true; await save({done: true}); nextTodo(); }
    else if (e.altKey && e.key === 'PageDown') { e.preventDefault(); go(idx + 1); }
    else if (e.altKey && e.key === 'PageUp') { e.preventDefault(); go(idx - 1); }
  };
  document.addEventListener('keydown', onKey);
  const prevLeave = leave;
  leave = async () => { document.removeEventListener('keydown', onKey); await prevLeave(); };

  // menus
  for (const [b, m] of [['optb', 'opt'], ['expb', 'exp']]) $('#' + b).onclick = e => { e.stopPropagation(); $('#' + m).hidden = !$('#' + m).hidden; };
  document.addEventListener('click', e => { if (!e.target.closest('.menu')) for (const m of ['opt', 'exp']) { const el = $('#' + m); if (el) el.hidden = true; } });
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
  new ResizeObserver(() => { if (prefs.fit === 'height') applyZoom(); }).observe(imgview);
  const showImage = async () => {
    const im = pg.image;
    $('#imginfo').textContent = im ? `画像 ${im.index + 1}/${im.count}${im.label && im.label !== String(im.index) ? `（${im.label}）` : ''}` : '';
    $('#ialink').hidden = !(im && im.link); if (im && im.link) $('#ialink').href = im.link;
    if (!im || im.missing) { imgview.innerHTML = '<div class="imgmsg">このページに対応する画像がありません。◀▶で合わせてください。</div>'; return; }
    if (im.url) { imgview.innerHTML = `<img src="${esc(im.url)}" alt="原本のページ画像">`; }
    else {
      imgview.innerHTML = '<div class="imgmsg">描画中…</div>';
      pdfCanvas = await renderPdfPage(im.pdf, im.index, 1600);
      imgview.innerHTML = ''; if (pdfCanvas) imgview.appendChild(pdfCanvas); else imgview.innerHTML = '<div class="imgmsg">画像がありません</div>';
    }
    applyZoom();
  };
  $('#zo').onclick = () => { prefs.zoom = Math.max(30, prefs.zoom - 15); applyZoom(); };
  $('#zi').onclick = () => { prefs.zoom = Math.min(400, prefs.zoom + 15); applyZoom(); };
  $('#zf').onchange = e => { prefs.fit = e.target.value; prefs.zoom = 100; applyZoom(); };
  $('#zv').onclick = () => { prefs.zoom = 100; applyZoom(); };
  const shift = async d => {
    const cur = pg.image ? pg.image.index : idx;
    p = await api('POST', `/api/projects/${slug}/mapping`, {anchor: [idx, cur + d]});
    pg = await api('GET', `/api/projects/${slug}/pages/${idx}`);
    toast('このページ以降の画像の対応をずらしました');
    showImage(); renderDiff();
  };
  $('#shl').onclick = () => shift(-1);
  $('#shr').onclick = () => shift(1);
  showImage();

  // OCR + diff
  let ocr = pg.ocr && pg.image && pg.ocr.image_index === pg.image.index ? pg.ocr : null;
  let diffT;
  const scheduleDiff = () => { clearTimeout(diffT); diffT = setTimeout(renderDiff, 400); };
  function renderDiff() {
    const box = $('#diff');
    $('#rawd').hidden = !ocr;
    if (!ocr) { box.innerHTML = ''; $('#ocrb').textContent = 'Claudeで読み取る'; return; }
    $('#ocrb').textContent = '読み直す';
    $('#raw').textContent = ocr.text;
    const A = textTokens(ed.value), B = ocrTokens(ocr.text);
    const blocks = diffBlocks(A, B);
    $('#ocrmsg').innerHTML = (blocks.length ? `<span class="badge b-warn">食い違い ${blocks.length} か所</span>` : '<span class="badge b-ok">食い違いなし</span>')
      + (ocr.truncated ? ' <span class="badge b-bad">読み取りが途中で切れています</span>' : '')
      + (ocr.model ? ` ${esc(ocr.model)} の読み` : '');
    if (!blocks.length) { box.innerHTML = ''; return; }
    const text = ed.value;
    let html = '', pos = 0;
    blocks.forEach(([a1, a2, b1, b2], bi) => {
      const alt = B.slice(b1, b2).map(t => t.w).join(' ');
      if (a1 === a2) {
        const at = a1 < A.length ? A[a1].start : text.length;
        html += esc(text.slice(pos, at)) + `<button class="chip ins ar" data-b="${bi}" title="Claudeの読みにある語を挿入">${esc(alt)}</button>`;
        pos = at;
      } else {
        const s = A[a1].start, e = A[a2 - 1].end;
        html += esc(text.slice(pos, s)) + `<span class="sp" data-s="${s}" data-e="${e}">${esc(text.slice(s, e))}</span>`
          + (alt ? `<button class="chip ar" data-b="${bi}" title="Claudeの読みに置き換える">${esc(alt)}</button>`
                 : `<button class="chip del" data-b="${bi}" title="Claudeの読みにはない語を削除">削除</button>`);
        pos = e;
      }
    });
    html += esc(text.slice(pos));
    box.innerHTML = `<div class="diff ar">${html}</div>`;
    box.querySelectorAll('.sp').forEach(sp => sp.onclick = () => { ed.focus(); ed.setSelectionRange(+sp.dataset.s, +sp.dataset.e); });
    box.querySelectorAll('.chip').forEach(btn => btn.onclick = () => {
      const [a1, a2, b1, b2] = blocks[+btn.dataset.b];
      const alt = B.slice(b1, b2).map(t => t.w).join(' ');
      let v = ed.value;
      if (a1 === a2) { const at = a1 < A.length ? A[a1].start : v.length; v = v.slice(0, at) + alt + (a1 < A.length ? ' ' : '') + v.slice(at); }
      else { let s = A[a1].start, e = A[a2 - 1].end; if (!alt && v[e] === ' ') e++; v = v.slice(0, s) + alt + v.slice(e); }
      ed.value = v; save({text: v}); progress(); renderDiff();
    });
  }
  const runOcr = async force => {
    if (!p.ocr) { toast('Claude OCR は使えません（anthropic パッケージが入っていません）', true); return; }
    $('#ocrb').disabled = true; $('#ocrmsg').textContent = '読み取り中…（数十秒かかります）';
    try {
      const body = {force, model: $('#ocrm').value};
      if (pg.image && pg.image.pdf) {
        const c = await renderPdfPage(pg.image.pdf, pg.image.index, 2000);
        body.image = c.toDataURL('image/jpeg', 0.9);
      }
      ocr = await api('POST', `/api/projects/${slug}/pages/${idx}/ocr`, body);
      renderDiff();
    } catch (e) { $('#ocrmsg').textContent = ''; toast(e.message, true); }
    finally { $('#ocrb').disabled = false; }
  };
  $('#ocrb').onclick = () => runOcr(!!ocr);
  const ocrm = $('#ocrm');
  ocrm.value = prefs.ocrModel;
  if (!ocrm.value) ocrm.selectedIndex = 0;
  ocrm.onchange = () => { prefs.ocrModel = ocrm.value; };
  if (!p.ocr) { $('#ocrb').disabled = true; $('#ocrmsg').textContent = 'Claude OCR を使うには anthropic パッケージとAPIキーが必要です（README参照）'; }
  renderDiff();
  if (!ocr && p.ocr && prefs.autoOcr && pg.image && !pg.image.missing) runOcr(false);
  ed.focus({preventScroll: true});
}

routeNow();
