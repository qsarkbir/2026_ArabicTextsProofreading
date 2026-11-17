'use strict';

function bibliographyFields(p = {}) {
  const values = {...(p.bibliography || {}), title:p.title || '', author:p.author || ''};
  return [['title','書名'], ['author','著者'], ['edition','底本（版・出版者・出版年）'], ['source','画像・本文の出典'], ['rights','利用・公開条件']]
    .map(([key, label]) => `<label>${label}<input name="${key}" value="${esc(values[key] || '')}" ${key === 'title' ? 'required' : ''}></label>`).join('');
}

async function newDraftView(life) {
  const api = life.api;
  document.title = 'PDFから新規作成 - 校正';
  view.innerHTML = `<div class="wrap"><div class="card"><h2>PDFからテキストを作成</h2>
    <p>本文のページを選び、空の校正テキストを作成します。AI読み取りは作成後に1ページずつ実行できます。</p>
    <form id="newdraft" class="formgrid">${bibliographyFields()}
    <label>PDF（500 MB以下）<input id="draftpdf" type="file" accept="application/pdf" required></label>
    <p id="pdfcount" role="status">PDFを選択してください。</p>
    <label>最初の本文画像（PDFの通し番号）<input name="start" type="number" value="1" min="1" required></label>
    <label>最後の本文画像（PDFの通し番号）<input name="end" type="number" value="1" min="1" required></label>
    <label>巻番号<input name="volume" type="number" value="1" min="0" max="99" required></label>
    <label>最初の印刷ページ番号<input name="first_page" type="number" value="1" min="0" max="99999" required></label>
    <p class="help">指定した範囲に連番を付けます。表紙・空白・欠頁・飛び番がある場合は範囲を選び直してください。OpenITIの登録用URIは自動発行しません。</p>
    <div class="row"><button type="submit" class="primary" id="createdraft" disabled>校正を始める</button><a href="#/">キャンセル</a></div>
    <p id="draftmsg" role="status"></p></form></div></div>`;
  const form = $('#newdraft');
  let count = 0, selected = null, version = 0;
  $('#draftpdf').onchange = async e => {
    const token = ++version, file = e.target.files[0];
    count = 0; selected = null; $('#createdraft').disabled = true;
    if (!file) return;
    if (file.size > 500 * 1024 * 1024) { $('#pdfcount').textContent = '500 MB以下のPDFを選択してください'; return; }
    $('#pdfcount').textContent = 'ページ数を確認中…';
    const url = URL.createObjectURL(file);
    let doc;
    try {
      doc = await loadPdf(url);
      if (!life.alive || token !== version) return;
      count = doc.numPages; selected = file;
      form.elements.end.value = count;
      $('#pdfcount').textContent = `${count}ページ。表紙などを除いた本文範囲を指定してください。`;
      $('#createdraft').disabled = false;
    } catch (error) { if (life.alive && token === version) $('#pdfcount').textContent = error.message; }
    finally { await releasePdf(url); URL.revokeObjectURL(url); }
  };
  form.onsubmit = async e => {
    e.preventDefault();
    if (!selected || !count) return;
    const metadata = {...Object.fromEntries(new FormData(form)), count, filename:selected.name};
    const headers = {'X-Metadata':encodeURIComponent(JSON.stringify(metadata))};
    if (headers['X-Metadata'].length > 12000) { $('#draftmsg').textContent = '書誌情報が長すぎます。短くまとめてください。'; return; }
    form.querySelectorAll('input,button').forEach(el => el.disabled = true);
    $('#draftmsg').textContent = '作成しています…';
    try {
      const p = await api('POST', '/api/projects/new-pdf', selected, headers);
      location.hash = `#/p/${p.slug}/0`;
    } catch (error) {
      if (life.alive) { $('#draftmsg').textContent = error.message; form.querySelectorAll('input,button').forEach(el => el.disabled = false); }
    }
  };
}

function workflowDialog(life, title, content) {
  const dialog = document.createElement('dialog');
  dialog.innerHTML = `<h2>${esc(title)}</h2>${content}<button type="button" class="close-dialog">閉じる</button>`;
  view.appendChild(dialog);
  dialog.querySelector('.close-dialog').onclick = () => dialog.close();
  dialog.addEventListener('close', () => dialog.remove(), {once:true});
  life.cleanup.push(() => dialog.remove());
  dialog.showModal();
  return dialog;
}

async function editBibliography(life, p, changed) {
  const dialog = workflowDialog(life, '書誌情報', `<form class="formgrid">${bibliographyFields(p)}<button class="primary">保存</button><p role="status"></p></form>`);
  const form = dialog.querySelector('form');
  form.onsubmit = async e => {
    e.preventDefault();
    form.querySelector('button').disabled = true;
    try {
      const updated = await life.api('PUT', `/api/projects/${p.slug}/bibliography`, Object.fromEntries(new FormData(form)));
      changed(updated); dialog.close(); toast('書誌を保存しました');
    } catch (error) { if (life.alive) { form.querySelector('[role=status]').textContent = error.message; form.querySelector('button').disabled = false; } }
  };
}

async function showPageHistory(life, slug, idx, restore) {
  try {
    const entries = await life.api('GET', `/api/projects/${slug}/pages/${idx}/history`);
    const dialog = workflowDialog(life, '保存履歴', `<p>選んだ本文を入力欄へ戻します。現在の本文も次の保存で履歴に残ります。注記・確認状況は変更しません。</p>
      <select aria-label="保存履歴">${entries.map((r,i) => `<option value="${i}">${esc(r.time)} 版 ${r.revision}</option>`).reverse().join('')}</select>
      <pre class="ar history-preview"></pre><button class="restore-history" ${entries.length ? '' : 'disabled'}>この本文を復元</button><p role="status">${entries.length ? '' : '保存履歴はまだありません。'}</p>`);
    const select = dialog.querySelector('select'), preview = dialog.querySelector('pre');
    const show = () => { preview.textContent = entries[+select.value]?.text || ''; };
    select.onchange = show; show();
    dialog.querySelector('.restore-history').onclick = async () => {
      const button = dialog.querySelector('.restore-history'); button.disabled = true;
      try { await restore(entries[+select.value].text); dialog.close(); }
      catch (error) { if (life.alive) { dialog.querySelector('[role=status]').textContent = error.message; button.disabled = false; } }
    };
  } catch (error) { if (life.alive) toast(error.message, true); }
}

// ブラウザ版の「AI の設定」：Anthropic の API キーを入力する（D-36）。キーは入力したらすぐ欄から消し、画面にも出さない。
// 既定ではこのタブの中だけに置き、「このブラウザに保存する」を選んだときだけ IndexedDB に保存する。changed() は設定が変わったあとに呼ぶ。
async function aiSettings(life, changed) {
  const describe = s => {
    const a = s && s.anthropic;
    return !a || !a.set ? 'APIキーは設定されていません。' : a.saved ? 'APIキーは設定済みです（このブラウザに保存されています）。' : 'APIキーは設定済みです（このタブの中だけ。閉じるか再読み込みすると消えます）。';
  };
  const dialog = workflowDialog(life, 'AI の設定', `<p>AIによる読み取り（OCR）は、このブラウザから Anthropic の API に直接送ります。ページの画像が Anthropic に送られ、1ページ読み取るごとに利用料がかかります。</p>
    <form class="formgrid" id="aiform" autocomplete="off">
      <label>Anthropic の API キー <input type="password" id="aikey" autocomplete="off" spellcheck="false" data-1p-ignore placeholder="sk-ant-…"></label>
      <label><input type="checkbox" id="aisave"> このブラウザに保存する</label>
      <p class="help">保存しないとき、キーはこのタブの中だけに置かれ、タブを閉じるか再読み込みすると消えます。保存すると、このブラウザを使う他の人やブラウザの拡張機能がキーを読める可能性があります。共用のパソコンでは保存しないでください。キーはバックアップや書き出しに含まれません。</p>
      <p class="help">Console（platform.claude.com）でこのアプリ専用のキーを作り、そのワークスペースに利用上限（月ごとの支出の上限）を設定することをお勧めします。</p>
      <div class="row"><button type="submit" class="primary" id="aisubmit">キーを設定する</button><button type="button" id="aiclear">キーを消す</button></div>
      <p role="status" id="aistatus"></p></form>`);
  const status = dialog.querySelector('#aistatus'), input = dialog.querySelector('#aikey');
  const show = text => { if (life.alive) status.textContent = text; };
  const refresh = async () => show(describe(await life.api('GET', '/api/ai/keys')));
  refresh().catch(e => show(e.message));
  dialog.querySelector('#aiform').onsubmit = async e => {
    e.preventDefault();
    const key = input.value, save = dialog.querySelector('#aisave').checked;
    input.value = ''; // 入力したキーは欄に残さない
    try {
      show(describe(await life.api('PUT', '/api/ai/keys/anthropic', {key, save})));
      toast(save ? 'APIキーをこのブラウザに保存しました' : 'APIキーをこのタブに設定しました');
      if (changed) await changed();
    } catch (error) { show(error.message); }
  };
  dialog.querySelector('#aiclear').onclick = async () => {
    try { show(describe(await life.api('DELETE', '/api/ai/keys/anthropic'))); if (changed) await changed(); } catch (error) { show(error.message); }
  };
  input.focus();
}
