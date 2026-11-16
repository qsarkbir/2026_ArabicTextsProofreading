// api() の実体。'http' はローカル版のサーバーへ fetch、'browser' はブラウザ内の LocalRouter に渡す。
async function api(method, url, body, headers) {
  if (PROOF_MODE === 'browser') {
    try { return await LocalRouter.handle(method, url, body, headers || {}); }
    catch (e) { const error = new Error(e && e.message || String(e)); error.status = e && e.status; throw error; }
  }
  const opt = {method, headers: headers || {}};
  if (body instanceof Blob || body instanceof ArrayBuffer) opt.body = body;
  else if (body !== undefined) { opt.body = JSON.stringify(body); opt.headers['Content-Type'] = 'application/json'; }
  const r = await fetch(url, opt);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `${r.status} ${r.statusText}`);
  return data;
}

// ブラウザ版の書き出し：ルーターが返したファイルをダウンロードさせる
async function saveDownload(url) {
  const file = await api('GET', url);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([file.data], {type: file.type}));
  a.download = file.filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
