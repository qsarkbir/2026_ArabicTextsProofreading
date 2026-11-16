const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const o = require('../proofreader/static/local/openiti.js');

const dir = path.join(__dirname, 'fixtures', 'openiti');
const inputs = JSON.parse(fs.readFileSync(path.join(dir, 'inputs.json'), 'utf8'));
const expected = JSON.parse(fs.readFileSync(path.join(dir, 'expected.json'), 'utf8'));
const texts = {...inputs.texts, ...Object.fromEntries(inputs.fuzz.map((s, i) => [`fuzz${i}`, s]))};

test('split matches the shared expected JSON', () => {
  for (const [name, text] of Object.entries(texts)) assert.deepEqual(o.split(text), expected.split[name], name);
});

test('join with edits matches the shared expected JSON', () => {
  for (const [name, edits] of Object.entries(inputs.edits)) assert.equal(o.join(o.split(texts[name]), edits), expected.join_edits[name], name);
});

test('unedited join returns the source exactly', () => {
  for (const [name, text] of Object.entries(texts)) assert.equal(o.join(o.split(text)), text, name);
});

test('unassigned tail is judged with Python strip semantics', () => {
  assert.equal(o.split(texts.whitespace_tail).pages.length, 2);
  assert.equal(o.split(texts.tail_bom_space).pages.at(-1).unassigned, true);
});

test('parseYml, scanLinks, titleOf, authorOf match', () => {
  const meta = {};
  for (const [k, v] of Object.entries(inputs.yml)) meta[k] = o.parseYml(v);
  assert.deepEqual(meta, expected.yml);
  assert.deepEqual(o.scanLinks(meta), expected.scan_links);
  inputs.metas.forEach((m, i) => assert.deepEqual(
    {title: o.titleOf(m.meta, m.text, m.uri), author: o.authorOf(m.meta, m.text, m.uri)}, expected.metas[i], String(i)));
});

test('resolve, ymlUrls and repoFor match', () => {
  inputs.resolve.forEach((ref, i) => {
    let got;
    try {
      const [raw_url, uri] = o.resolve(ref);
      got = {raw_url, uri, yml_urls: o.ymlUrls(raw_url, uri)};
    } catch (e) { got = {error: e.message}; }
    assert.deepEqual(got, expected.resolve[i], JSON.stringify(ref));
  });
  for (const [y, repo] of Object.entries(expected.repo_for)) assert.equal(o.repoFor(Number(y)), repo);
});

test('random strings with injected markers round-trip', () => {
  let seed = 12345;
  const rnd = n => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
  const atoms = ['PageV01P001', 'PageV2P13', '#META#Header#End#', '\n', '\r\n', '\r', ' ', '﻿', '\u{1F600}', 'بِسْمِ', 'abc', 'Page', ' '];
  for (let n = 0; n < 500; n++) {
    const s = Array.from({length: rnd(40)}, () => atoms[rnd(atoms.length)]).join('');
    assert.equal(o.join(o.split(s)), s, JSON.stringify(s));
  }
});

test('fetchText reads text and tolerates missing yml', async () => {
  const ref = '0123SyntheticAuthor.SampleBook.Kraken1234-ara1';
  const seen = [];
  const fetchImpl = async url => {
    seen.push(url);
    const ok = url.endsWith('-ara1');
    return {ok, status: ok ? 200 : 404, text: async () => 'body'};
  };
  const r = await o.fetchText(ref, fetchImpl);
  assert.equal(r.text, 'body');
  assert.equal(r.uri, ref);
  assert.deepEqual(r.meta, {version: {}, book: {}, author: {}});
  assert.equal(seen.length, 4);
});
