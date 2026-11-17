@anthropic-ai/sdk 1.4.0 (Apache-2.0 and MIT, see `1.4.0/LICENSE` and `1.4.0/LICENSE-MIT`)

The official Anthropic TypeScript SDK, pinned, as plain ES modules for the browser version's OCR (`local/ocr.js`, docs/static-design.md D-35). No build step: the page loads it lazily with `import()` relative to `document.baseURI` (same origin, so the CSP `script-src 'self'` is enough) the first time a page is read.

- Source: `npm pack @anthropic-ai/sdk@1.4.0` (published 2026-11-02), tarball sha256 `8aa74bea612214fc20512107ab47a25225d2dfc7bc759d275a127436ae1a62a0`, npm integrity `sha512-tyuibnhQL57kLOx5oomY4Ld7jOVOPNC5v3IiyRtR3l+Friv66tI4VbuZYF2NMel/T0WMuQMBFOMKDBUbUh8gPA==`. The package was only unpacked and read (no install scripts were run); its `.mjs` files are copied from the tarball.
- `1.4.0/_deps/opentelemetry-api/`: `@opentelemetry/api@1.10.0` (Apache-2.0, `dist/*.mjs`), the only runtime dependency the SDK imports unconditionally (`client.mjs` and the tracing helpers). npm integrity `sha512-lMkyes8iHrG+mk6WH7X70MdCLI2RS0FwNBY1PyQ8UemaijE2m5mv5A0Niy3HtbYTFrgkUEQjFMXmSAk2hQDuPQ==`.
- 294 modules (the closure of `index.mjs`), 297 files, 1.35 MB unpacked. `SHA256SUMS` lists the sha256 of every file in `1.4.0/`.

Browsers cannot resolve bare module specifiers (an import map would be inline script, which the CSP forbids), so `assemble.py` copies the closure and rewrites only these specifiers (each patched line is listed by the script when it runs):

| Original import | Replaced by |
|---|---|
| `@opentelemetry/api` | the relative path to `_deps/opentelemetry-api/index.mjs` |
| `./node.mjs` (`internal/`, `tools/agent-toolset/`) and `@anthropic-ai/sdk/tools/agent-toolset/node` | `node.browser.mjs`: what the package's own `browser` field substitutes in browser builds (its exports throw "needs Node.js" when used) |
| `standardwebhooks` (the Webhooks resource, server-side signature checks) | `_stubs/standardwebhooks.mjs`, a stub that throws if used |

It also removes the trailing `//# sourceMappingURL=` comments (the maps are not shipped). Nothing else is modified, except that two specifiers quoted inside JSDoc comments were rewritten the same way (`resources/beta/sessions/events.mjs` line 138 and `lib/tools/SessionToolRunner.mjs` line 169); they are comments, not imports. The `node:buffer` text in `internal/uploads.mjs` is inside an error message string, not an import.

To update or check:

```
npm pack @anthropic-ai/sdk@<version>              # unpack into its own empty folder
npm install --ignore-scripts @opentelemetry/api@1.10.0   # in another empty folder, for its dist/
python3 -I assemble.py <sdk package dir> <@opentelemetry/api package dir> 1.4.0   # the target folder is replaced
```

Then change `SDK_PATH` in `local/ocr.js`, rerun `node --test tests/ocr.test.js` (it loads this copy with a stubbed `fetch`) and `python -m tests.browser_static_smoke`, and update this file and `SHA256SUMS`. The API key is sent by the SDK as `Authorization: Bearer <key>` with `anthropic-dangerous-direct-browser-access: true` (set by `dangerouslyAllowBrowser`).
