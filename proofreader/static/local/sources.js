// sources.py（Internet Archive）の移植。IIIF マニフェスト・資料情報（PDF の選択）・検索の解釈は Python と同じ結果にする。
// 取得はブラウザから直接行い（CORS を許可する経路だけ。docs/static-design.md の D-27）、取得関数は差し替えられる。
const Sources = (() => {
  const UNAVAILABLE = 'IA の画像サーバーが応答しません。時間をおいて試すか、ローカル版を使ってください';
  const retry = {tries: 3, delay: 3000}; // マニフェストの取得：ネットワークの失敗と 5xx（IIIF は 504 をよく返す）を数秒おきに数回やり直す
  const PDF_FORMATS = ['Image Container PDF', 'Text PDF', 'Additional Text PDF'];

  class FetchError extends Error {
    constructor(message, status) { super(message); this.name = 'FetchError'; this.status = status; }
  }
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  const OFFLINE = 'Internet Archive に接続できませんでした。時間をおいて試すか、ローカル版を使ってください';
  // JSON の取得。tries 回まで、ネットワークの失敗と 5xx のときだけやり直す。CORS で拒否された 504 は TypeError（Failed to fetch）になる
  const getJson = async (url, {tries = 1, delay = retry.delay, unavailable = OFFLINE, fetchImpl = (...a) => fetch(...a), wait = sleep} = {}) => {
    let last;
    for (let n = 1; n <= tries; n++) {
      if (n > 1) await wait(delay);
      let r;
      try { r = await fetchImpl(url); } catch { last = new FetchError(unavailable); continue; }
      if (r.ok) {
        try { return await r.json(); } catch { throw new FetchError(`応答を読み取れませんでした: ${url}`); }
      }
      if (r.status >= 500) { last = new FetchError(unavailable, r.status); continue; }
      throw new FetchError(`${r.status} ${r.statusText || ''}: ${url}`, r.status);
    }
    throw last;
  };

  // 画像など、バイト列の取得（OCR に送る IIIF の画像）。getJson と同じ再試行の規則で、{bytes: Uint8Array, type} を返す
  const getBytes = async (url, {tries = retry.tries, delay = retry.delay, unavailable = UNAVAILABLE, fetchImpl = (...a) => fetch(...a), wait = sleep} = {}) => {
    let last;
    for (let n = 1; n <= tries; n++) {
      if (n > 1) await wait(delay);
      let r;
      try { r = await fetchImpl(url); } catch { last = new FetchError(unavailable); continue; }
      if (r.ok) {
        try { return {bytes: new Uint8Array(await r.arrayBuffer()), type: (r.headers && r.headers.get('content-type')) || ''}; }
        catch { last = new FetchError(unavailable); continue; }
      }
      if (r.status >= 500) { last = new FetchError(unavailable, r.status); continue; }
      throw new FetchError(`${r.status} ${r.statusText || ''}: ${url}`, r.status);
    }
    throw last;
  };

  // Python の `a or b or [""]` の [0]：空でないリストのうち最初のものの先頭
  const pick = (...lists) => { for (const l of lists) if (Array.isArray(l) && l.length) return l[0]; return ''; };
  const dig = (obj, path) => path.reduce((o, k) => (o !== null && o !== undefined ? o[k] : undefined), obj);
  const labelOf = l => (l && typeof l === 'object' ? l : {});

  // sources.ia_pages：マニフェストの各 canvas から label・w・h・service を取る。service の id が文字列でない・空の canvas は飛ばす
  const parseManifest = (identifier, m) => {
    const pages = [];
    for (const c of (m && Array.isArray(m.items) ? m.items : [])) {
      const service = dig(c, ['items', 0, 'items', 0, 'body', 'service', 0, 'id']);
      if (typeof service !== 'string' || !service) continue;
      pages.push({label: pick(labelOf(c.label).none), w: c.width ?? null, h: c.height ?? null, service});
    }
    const l = labelOf(m && m.label), title = pick(l.none, l.en);
    return {type: 'ia', id: identifier, title, pages};
  };
  const iaPages = async (identifier, get = getJson) =>
    parseManifest(identifier, await get(`https://iiif.archive.org/iiif/${encodeURIComponent(identifier)}/manifest.json`, {tries: retry.tries, unavailable: UNAVAILABLE}));

  // ブラウザ版は IIIF の画像を iiif.archive.org からだけ読む（CSP の img-src と合わせ、取り込んだ資料が別のホストを指しても要求しない）
  const IIIF_PREFIX = 'https://iiif.archive.org/';
  const FOREIGN_SERVICE = 'このページの画像の取得先が Internet Archive の画像サーバーではないため、ブラウザ版では表示できません。ローカル版を使ってください';
  const isIiifService = service => typeof service === 'string' && service.startsWith(IIIF_PREFIX);
  const imageUrl = (service, width = 1600) => `${service}/full/${width},/0/default.jpg`;

  // sources.ia_pdf：公開の PDF のうち、形式の優先順（Image Container PDF → Text PDF → …）、同順位ではサイズの大きいもの
  const pdfChoice = d => {
    let best = null;
    for (const f of (d && Array.isArray(d.files) ? d.files : [])) {
      const name = f.name || '';
      if (!name.toLowerCase().endsWith('.pdf') || ('private' in f && String(f.private).toLowerCase() === 'true')) continue;
      const fmt = f.format || '';
      let size = 0;
      try { size = f.size ? Draft.pyInt(f.size) : 0; } catch { size = 0; }
      const rank = PDF_FORMATS.includes(fmt) ? PDF_FORMATS.indexOf(fmt) : PDF_FORMATS.length;
      if (best === null || rank < best.rank || (rank === best.rank && -size < -best.info.size)) best = {rank, info: {name, size, format: fmt}};
    }
    return best && best.info;
  };
  const iaPdf = async (identifier, get = getJson) => pdfChoice(await get(`https://archive.org/metadata/${encodeURIComponent(identifier)}`));
  const pdfUrl = (identifier, name) => `https://archive.org/download/${encodeURIComponent(identifier)}/${encodeURIComponent(name)}`;

  const FIELDS = ['identifier', 'title', 'creator', 'date', 'imagecount', 'language'];
  const searchUrl = (query, rows = 20) => {
    const params = new URLSearchParams([['q', `(${query}) AND mediatype:texts`], ['rows', String(rows)], ['output', 'json'], ...FIELDS.map(f => ['fl[]', f])]);
    return `https://archive.org/advancedsearch.php?${params}`;
  };
  const joined = v => (Array.isArray(v) ? v.join('; ') : (v || ''));
  const parseSearch = d => ((d && d.response && Array.isArray(d.response.docs)) ? d.response.docs : []).map(doc => ({
    id: doc.identifier, title: joined(doc.title), creator: joined(doc.creator), date: joined(doc.date),
    imagecount: doc.imagecount ?? null, thumb: `https://archive.org/services/img/${doc.identifier}`}));
  const search = async (query, rows = 20, get = getJson) => parseSearch(await get(searchUrl(query, rows)));

  return {UNAVAILABLE, OFFLINE, retry, PDF_FORMATS, FetchError, getJson, getBytes, parseManifest, iaPages, imageUrl, isIiifService, FOREIGN_SERVICE, pdfChoice, iaPdf, pdfUrl, searchUrl, parseSearch, search};
})();

if (typeof module !== 'undefined') module.exports = Sources;
