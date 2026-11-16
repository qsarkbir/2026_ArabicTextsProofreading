// importers/draft.py の移植。PDF の選択範囲から、仮 ID の空の校正テキストを作る。
const Draft = (() => {
  // Python の int()：整数・小数（切り捨て）・数字だけの文字列（Arabic-Indic など Unicode の数字も可）を受け付け、それ以外は ValueError / TypeError
  const pyInt = v => {
    if (typeof v === 'boolean') return Number(v);
    if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
    if (typeof v !== 'string') throw new TypeError('int() の引数が正しくありません');
    const n = OpenITI.pyInt(v);
    if (!Number.isSafeInteger(n)) throw new RangeError('整数が大きすぎます');
    return n;
  };
  // Python の str()。JSON の値のうち文字列・null・真偽値・数値だけを扱う
  const pyStr = v => (v === null ? 'None' : typeof v === 'boolean' ? (v ? 'True' : 'False') : String(v));
  const get = (m, key, fallback) => (key in m ? m[key] : fallback);
  const hex = n => { const b = new Uint8Array(n); crypto.getRandomValues(b); return Array.from(b, x => x.toString(16).padStart(2, '0')).join(''); };

  // draft.build(metadata) → [fetched, details]。範囲・巻・ページ番号が不正なら RangeError
  const build = metadata => {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new TypeError('metadata がオブジェクトではありません');
    const count = pyInt(get(metadata, 'count', 0));
    const start = pyInt(get(metadata, 'start', 1));
    const end = pyInt(get(metadata, 'end', count));
    const first = pyInt(get(metadata, 'first_page', 1));
    const volume = pyInt(get(metadata, 'volume', 1));
    if (!(1 <= start && start <= end && end <= count && count <= 20000 && 0 <= first && first <= 99999 && 0 <= volume && volume <= 99))
      throw new RangeError('PDFの対象範囲・巻・印刷ページ番号を確認してください');
    const title = OpenITI.pyStrip(pyStr(get(metadata, 'title', '')));
    if (!title) throw new RangeError('書名を入力してください');
    let text = '######OpenITI#\n\n#META#Header#End#\n\n';
    for (let i = 0; i < end - start + 1; i++) text += `# \nPageV${String(volume).padStart(2, '0')}P${String(first + i).padStart(3, '0')}\n\n`;
    const bib = {};
    for (const key of ['edition', 'source', 'rights']) bib[key] = OpenITI.pyStrip(pyStr(get(metadata, key, '')));
    return [{uri: 'local-' + hex(6), text, meta: {}}, {
      title, author: OpenITI.pyStrip(pyStr(get(metadata, 'author', ''))), bibliography: bib, draft: true, offset: start - 1,
    }];
  };

  return {build, pyInt, pyStr};
})();

if (typeof module !== 'undefined') module.exports = Draft;
