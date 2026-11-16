PDF.js 6.5.438 (Apache-2.0)

Pinned browser module and matching worker, distributed by Mozilla and mirrored by cdnjs.

- Release: https://github.com/mozilla/pdf.js/releases/tag/v6.5.438
- Module: https://cdnjs.cloudflare.com/ajax/libs/pdf.js/6.5.438/pdf.min.mjs
- Worker: https://cdnjs.cloudflare.com/ajax/libs/pdf.js/6.5.438/pdf.worker.min.mjs

Decoder and font data, copied unmodified from the `pdfjs-dist@6.5.438` npm package (`npm pack pdfjs-dist@6.5.438`, then `wasm/`, `iccs/`, `standard_fonts/`):

| Directory | Used for | Size |
|---|---|---|
| `6.5.438/wasm/` | `openjpeg.wasm` (JPEG 2000 / JPXDecode), `jbig2.wasm` (JBIG2), `qcms_bg.wasm` (ICC colour conversion) and their licences | 456 KB |
| `6.5.438/iccs/` | CMYK ICC profile | 24 KB |
| `6.5.438/standard_fonts/` | Foxit and Liberation fonts for non-embedded standard fonts | 820 KB |

Not bundled: `cmaps/` (1.7 MB, predefined CJK CMaps), `wasm/quickjs-eval.*` (PDF scripting; eval stays disabled) and `wasm/*_nowasm_fallback.js` (browsers without WebAssembly).

`app.js` (`pdfAssets()`) passes `wasmUrl`, `iccUrl` and `standardFontDataUrl` to `getDocument`, resolved against `document.baseURI` (each ends with `/`). Without `wasmUrl`, scanned PDFs whose pages are JPEG 2000 or JBIG2 images render as blank pages without any error.

Keep all files at the same version. Preserve the LICENSE files and the embedded notices when updating.
