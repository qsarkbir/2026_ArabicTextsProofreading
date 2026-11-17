const {test} = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const OCR = require('../proofreader/static/local/ocr.js');

// 同梱した公式 SDK（vendor/anthropic-sdk）を本物のまま読み、fetch だけを差し替える。有料の API は呼ばない
const SDK = () => import(pathToFileURL(path.join(__dirname, '..', 'proofreader', 'static', OCR.SDK_PATH)).href);
const KEY = 'sk-ant-api03-unit-test-key-9876543210';
const IMAGE = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 250, 251, 252]);
const message = (over = {}) => ({id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{type: 'text', text: ' سطر\nسطر \n'}],
  stop_reason: 'end_turn', stop_sequence: null, usage: {input_tokens: 1234, output_tokens: 56}, ...over});
const world = (respond = () => [200, message()]) => {
  const seen = [];
  const fetch = async (url, init) => {
    seen.push({url: String(url), method: init.method, headers: Object.fromEntries(new Headers(init.headers)), body: JSON.parse(init.body)});
    const [status, body, headers = {}] = respond(seen.length);
    return new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json', 'x-should-retry': 'false', ...headers}});
  };
  return {seen, opt: {sdk: null, fetch, maxRetries: 0}};
};
const run = async (w, model = 'claude-opus-5-5', key = KEY) => { w.opt.sdk = await SDK(); return OCR.transcribe(IMAGE, 'image/jpeg', model, key, w.opt); };
// SDK は「ブラウザらしい環境」でだけ dangerouslyAllowBrowser を求める。Node ではヘッダーだけ確かめる

test('the request mirrors ocr.transcribe: model, effort, fallbacks, base64 image and the shared prompt, sent straight to api.anthropic.com', async () => {
  const w = world();
  const r = await run(w);
  const [req] = w.seen;
  assert.equal(req.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(req.method, 'POST');
  assert.equal(req.headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(req.headers.authorization, `Bearer ${KEY}`);   // この版の SDK は apiKey を Authorization で送る
  assert.equal(req.headers['anthropic-beta'], OCR.BETA);
  assert.deepEqual(Object.keys(req.body).sort(), ['fallbacks', 'max_tokens', 'messages', 'model', 'output_config']);
  assert.deepEqual([req.body.model, req.body.max_tokens, req.body.fallbacks, req.body.output_config], ['claude-opus-5-5', 16000, 'default', {effort: 'medium'}]);
  const [user] = req.body.messages;
  assert.equal(user.role, 'user');
  assert.deepEqual(user.content[0], {type: 'image', source: {type: 'base64', media_type: 'image/jpeg', data: Buffer.from(IMAGE).toString('base64')}});
  assert.deepEqual(user.content[1], {type: 'text', text: OCR.PROMPT});
  assert.equal(JSON.stringify(req.body).includes(KEY), false);
  assert.deepEqual(r, {text: 'سطر\nسطر', model: 'claude-opus-5-5', truncated: false, usage: {input: 1234, output: 56},
    provider: 'anthropic', requested_model: 'claude-opus-5-5', prompt_version: OCR.PROMPT_VERSION});
});

test('Haiku is sent without the fallback beta, the default model is Opus, other models are refused before any request', async () => {
  const w = world();
  await run(w, 'claude-haiku-5-5');
  assert.deepEqual([w.seen[0].body.fallbacks, w.seen[0].headers['anthropic-beta']], [undefined, undefined]);
  const d = world();
  d.opt.sdk = await SDK();
  await OCR.transcribe(IMAGE, 'image/png', undefined, KEY, d.opt);
  assert.deepEqual([d.seen[0].body.model, d.seen[0].body.messages[0].content[0].source.media_type], [OCR.MODEL, 'image/png']);
  const n = world();
  await assert.rejects(run(n, 'gpt-x'), e => e instanceof OCR.Unavailable && /このモデルは使えません/.test(e.message));
  await assert.rejects(run(n, 'claude-opus-5-5', ''), e => e instanceof OCR.Unavailable && e.message === OCR.NO_KEY);
  assert.equal(n.seen.length, 0);
});

test('a refusal, a truncated reading and an empty reading are reported like the Python version', async () => {
  await assert.rejects(run(world(() => [200, message({stop_reason: 'refusal', content: []})])), e => e instanceof OCR.Unavailable && e.message === 'このページは読み取りを断られました');
  const cut = await run(world(() => [200, message({stop_reason: 'max_tokens'})]));
  assert.equal(cut.truncated, true);
  await assert.rejects(run(world(() => [200, message({content: [{type: 'text', text: '  \n'}]})])), e => e.message === '読み取り結果が空でした。本文は変更していません');
  const multi = await run(world(() => [200, message({content: [{type: 'text', text: 'a'}, {type: 'thinking', thinking: 'x', signature: 's'}, {type: 'text', text: 'b'}]})]));
  assert.equal(multi.text, 'ab');
});

test('API errors become the same Japanese messages as ocr.py, and the key never appears in them', async () => {
  const err = (status, message) => () => [status, {type: 'error', error: {type: 'x', message}}];
  const cases = [
    [401, 'invalid x-api-key', 'APIの認証に失敗しました。「AI の設定」でキーを確認してください'],
    [429, 'rate limited', 'APIの利用上限に達しました。少し待ってから再実行してください'],
    [400, `bad request for ${KEY}`, 'APIエラー（400）: bad request for …'],
    [500, 'overloaded', 'APIエラー（500）: overloaded'],
  ];
  for (const [status, text, want] of cases) {
    await assert.rejects(run(world(err(status, text))), e => e instanceof OCR.Unavailable && e.message === want && !e.message.includes(KEY), String(status));
  }
  const w = world(() => { throw new TypeError('Failed to fetch'); });
  w.opt.sdk = await SDK();
  await assert.rejects(OCR.transcribe(IMAGE, 'image/jpeg', 'claude-opus-5-5', KEY, w.opt), e => e instanceof OCR.Unavailable && e.message === 'APIに接続できません。ネットワークを確認してください');
});

test('the SDK is loaded lazily from the vendored copy relative to the page, and an unreachable copy gives a message, not a crash', async () => {
  assert.equal(OCR.SDK_PATH, 'vendor/anthropic-sdk/1.4.0/index.mjs');
  globalThis.document = {baseURI: 'http://localhost:1/nowhere/'};
  try {
    await assert.rejects(OCR.transcribe(IMAGE, 'image/jpeg', 'claude-opus-5-5', KEY), e => e instanceof OCR.Unavailable && /読み込めませんでした/.test(e.message));
  } finally { delete globalThis.document; }
});
