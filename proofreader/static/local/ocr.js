// ocr.py と providers/ の移植（Anthropic のみ）。プロンプト・モデル・版は Python と同じ値（tests/test_parity.py が一致を確かめる）。
// 呼び出しは同梱した公式 SDK（vendor/anthropic-sdk/、D-35）を最初に使うときだけ動的に読み込む。キーはここでは保持しない（router.js が渡す）。
const OCR = (() => {
  const MODEL = 'claude-opus-5-5';
  const MODELS = {
    'claude-opus-5-5': 'Opus 5.5',
    'claude-sonnet-5-5': 'Sonnet 5.5（料金 約1/2）',
    'claude-haiku-5-5': 'Haiku 5.5（料金 約1/40）',
  };
  const NO_FALLBACK = ['claude-haiku-5-5'];
  const PROMPT_VERSION = 'printed-arabic-3';
  const BETA = 'server-side-fallback-2026-07-01';
  const SDK_PATH = 'vendor/anthropic-sdk/1.4.0/index.mjs';
  const PROMPT = `This is a scanned page of a printed Arabic book. Transcribe it exactly as printed.

- Keep the printed spelling, even where it looks wrong. Do not correct, normalise, modernise or complete words, and do not add hamzas, vowel signs or punctuation that are not on the page.
- Keep the printed line breaks: one printed line per output line.
- If there is a running header or page number, put it on the first line, starting with "@HEADER ".
- In the main text, leave out marks the editor added: footnote reference numbers such as (1), (٢) or superscript digits, and manuscript folio markers such as [2/أ], [٢ب] or /3أ/ together with any sign attached to them (e.g. "+"). Do not leave an extra space where they were.
- If there are footnotes, write a line "@FOOTNOTES" before them and transcribe them in order. In the footnotes, keep each footnote's own number at its start exactly as printed, e.g. "(1)", so that it can be matched to its place in the main text.
- Write [?] for any word you cannot read; never guess a word from context, especially personal names.
- Output only the transcription, with no comments.`;

  class Unavailable extends Error { constructor(message) { super(message); this.name = 'OCRUnavailable'; } }

  const NO_KEY = 'APIキーがありません。「AI の設定」でキーを入力してください';
  let sdkPromise = null;
  // import() は document.baseURI からの相対（pdf.js と同じく、Pages のサブパスでも動く）。
  // 最初の読み込みが一時的に失敗することがあるので、少し待って2回まで読み直す（D-44）。ブラウザは失敗した URL をページを開いている間
  // 覚えているので、読み直しは入口のファイルに ?retry=n を付ける（入口の失敗はこれで直る。中の部品の失敗は再読み込みが要る）。
  // API はまだ呼んでいないので料金はかからない
  const SDK_RETRIES = [500, 1500];
  let sdkTries = 0;
  const loadSdk = () => {
    if (!sdkPromise) {
      const base = new URL(SDK_PATH, document.baseURI).href;
      const attempt = n => import(sdkTries++ ? `${base}?retry=${sdkTries - 1}` : base).catch(e => {
        if (n >= SDK_RETRIES.length) throw e;
        console.warn(`AI の呼び出しに使う部品の読み込みを再試行します（${n + 1}回目）`, e);
        return new Promise(r => setTimeout(r, SDK_RETRIES[n])).then(() => attempt(n + 1));
      });
      sdkPromise = attempt(0).catch(e => {
        console.error('AI の呼び出しに使う部品を読み込めませんでした', e);
        sdkPromise = null;
        throw new Unavailable('AI の呼び出しに使う部品を読み込めませんでした。もう一度「AIで読み取る」を押すか、ページを再読み込みしてください（料金はかかっていません）');
      });
    }
    return sdkPromise;
  };

  const base64 = bytes => {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };

  // キーをメッセージに含めない（SDK のエラーには入らないが、念のため取り除く）
  const scrub = (text, key) => (key ? String(text).split(key).join('…') : String(text));

  // ocr.transcribe：{text, model, truncated, usage}。エラーは型ごとに ocr.py と同じ日本語の Unavailable にする（認証だけブラウザ向けの案内）
  const call = async (image, mediaType, model, apiKey, {sdk, fetch, maxRetries} = {}) => {
    if (!Object.hasOwn(MODELS, model)) throw new Unavailable(`このモデルは使えません: ${model}`);
    if (!apiKey) throw new Unavailable(NO_KEY);
    const {Anthropic, AuthenticationError, RateLimitError, APIConnectionError, APIError} = sdk || await loadSdk();
    const client = new Anthropic({apiKey, dangerouslyAllowBrowser: true, ...(fetch ? {fetch} : {}), ...(maxRetries !== undefined ? {maxRetries} : {})}); // fetch・maxRetries はテスト用
    let response;
    try {
      response = await client.beta.messages.create({
        model, max_tokens: 16000,
        ...(NO_FALLBACK.includes(model) ? {} : {betas: [BETA], fallbacks: 'default'}),
        output_config: {effort: 'medium'},
        messages: [{role: 'user', content: [
          {type: 'image', source: {type: 'base64', media_type: mediaType, data: base64(image)}},
          {type: 'text', text: PROMPT},
        ]}],
      });
    } catch (e) {
      if (e instanceof AuthenticationError) throw new Unavailable('APIの認証に失敗しました。「AI の設定」でキーを確認してください');
      if (e instanceof RateLimitError) throw new Unavailable('APIの利用上限に達しました。少し待ってから再実行してください');
      if (e instanceof APIConnectionError) throw new Unavailable('APIに接続できません。ネットワークを確認してください');
      if (e instanceof APIError) throw new Unavailable(`APIエラー（${e.status}）: ${scrub((e.error && e.error.error && e.error.error.message) || (e.error && e.error.message) || e.message, apiKey)}`);
      throw new Unavailable(`読み取りに失敗しました: ${scrub(e && e.message || e, apiKey)}`);
    }
    if (response.stop_reason === 'refusal') throw new Unavailable('このページは読み取りを断られました');
    const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
    return {text, model: response.model, truncated: response.stop_reason === 'max_tokens',
      usage: {input: response.usage.input_tokens, output: response.usage.output_tokens}};
  };

  // providers.transcribe（anthropic）：提供元・要求したモデル・プロンプトの版を足し、空の読みは拒否する
  const transcribe = async (image, mediaType, model, apiKey, opt) => {
    model = model || MODEL;
    const result = await call(image, mediaType, model, apiKey, opt);
    if (!result.text.trim()) throw new Unavailable('読み取り結果が空でした。本文は変更していません');
    return {...result, provider: 'anthropic', requested_model: model, prompt_version: PROMPT_VERSION};
  };

  return {MODEL, MODELS, NO_FALLBACK, PROMPT, PROMPT_VERSION, BETA, SDK_PATH, NO_KEY, Unavailable, transcribe};
})();

if (typeof module !== 'undefined') module.exports = OCR;
