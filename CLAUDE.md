# CLAUDE.md

OpenITI のアラビア語テキストを、刊本のページ画像（Internet Archive の IIIF または手元の PDF）と並べて校正するローカル Web アプリ。利用者向けの説明は [README.md](README.md) にある。

## 実行

```bash
python -m proofreader            # http://127.0.0.1:8765/ を開く
python -m proofreader --no-browser --port 8770
python -m proofreader --keep-running   # タブを閉じても終了しない
```

- Python 3.10 以上。標準ライブラリだけで動く。`anthropic` パッケージ（`requirements.txt`）は Claude OCR を使うときだけ必要で、無ければ OCR が無効になるだけ。`anthropic` は `.venv` にだけ入っているので、OCR を使うときはシステムの `python` ではなく `.venv\Scripts\python -m proofreader` で起動する。
- 既定では、画面（タブ）がすべて閉じて30秒後（heartbeat の途絶は3分後）にサーバーが自動終了する（`presence.py` と `server.watch`）。`.claude/launch.json` などで常駐させたいときは `--keep-running`。
- API キーはリポジトリのルートの `.env`（git 管理外）に `ANTHROPIC_API_KEY=...` と書く。`server.load_env` が起動時に読み込み、シェルの環境変数より優先する。`main()` の中で読むので、import 時に評価される `PROOF_DATA` は `.env` では変えられない。`.env` の中身は表示・コミットしない。
- プレビュー用の設定は `.claude/launch.json`（`proofreader-app`、ポート 8770、`.venv` の Python で起動、`--keep-running` 付き）。
- ビルド工程・リンターは無い。回帰テストは `python -m unittest discover -s tests -v` と `node --test tests/*.test.js`。構文確認は `node --check proofreader/static/app.js`（`workflows.js`・`compare.js`・`local/openiti.js`・`local/work.js` も同様）。`tests/fixtures/openiti/` の合成データと expected.json は Python（`tests/test_parity.py`）と JS（`tests/openiti.test.js`）の共通の基準で、`openiti.py` を意図して変えたら `UPDATE_FIXTURES=1 python -m unittest tests.test_parity` で作り直し、`local/openiti.js` も合わせる。GitHub Actions（`.github/workflows/tests.yml`）が Windows/Ubuntu × Python 3.10/3.13 で同じテストを、別ジョブでブラウザ検証と TEI スキーマ検証を実行する。ブラウザ検証は `python -m tests.preview_server` で合成データ専用のサーバーを起動できる（8772番、IA形式の `ui-fixture` と PDF の `pdf-fixture`、最初の保存を意図的に失敗させる）。
- 作業データは `projects/`（`PROOF_DATA` で変更可、git 管理外）。動作確認には既存のプロジェクトを使ってよいが、`original.txt` は書き換えないこと。

## 構成

```
proofreader/
  server.py    http.server ベースの API とスタティック配信。@route(method, regex) でルート登録
  store.py     projects/<slug>/ の読み書き（project.json, original.txt, work.json, ocr/, files/）
  openiti.py   OpenITI の URI 解決・取得、yml メタデータ、ページ分割（split）と再結合（join）
  sources.py   Internet Archive の IIIF マニフェスト・検索・ページ画像（`fetch_scan`）・PDF の URL（`ia_pdf`）
  net.py       外部への HTTP。接続先は ALLOWED のホストに限定
  presence.py  ブラウザのタブの接続状況（自動終了の判定）
  ocr.py       Claude によるページ画像の読み取り（MODEL = "claude-opus-5-5"）と共通の OCR プロンプト
  providers/   AI 提供元の切り替え（Anthropic は ocr.py、OpenAI は Responses API）
  importers/   draft.py：PDF の選択範囲から仮 ID の空の本文を作る
  exporters/   tei.py：基本 TEI P5 出力
  static/      フロントエンド（index.html, app.js, app.css, core.js, compare.js, workflows.js, vendor/pdfjs/）。フレームワーク・ビルド無しの素の JS
```

- フロントは `location.hash` によるルーティング（`#/`、`#/new`、`#/p/<slug>/setup`、`#/p/<slug>/<ページ番号>`）。各画面は `homeView` / `newDraftView` / `setupView` / `proofView` が `view.innerHTML` にテンプレート文字列を流し込んで組み立てる。
- 表示設定は `prefs`（localStorage の `proof-prefs`）に保存する。新しい設定項目は `prefs` の既定値 `def` に足す。
- PDF.js 6.5.438はstatic/vendor/に本体とworkerを同梱。isEvalSupportedはfalse。版を揃えて更新しApache-2.0のLICENSEを保持する。
- 記号の挿入は `core.js` の `insertMarkup`（Node テストから読む）。`app.js` の「記号：」ボタンから呼ぶ。
- IA の PDF 保存は `sources.ia_pdf` → `net.download` で `files/ia-<revision>.pdf` に取得する。進行状況は `server.PDF_JOBS`、ルートは `/api/projects/<slug>/source/ia/pdf`（`/attach`・`/detach` を含む）。保存したファイル名は資料の `pdf_file` に記録し、`image_for` は `pdf_file` があれば `pdf` を返す（キーは従来どおり）。
- `send_file` は `Range` に対応する（大きな PDF を部分ずつ読む）。

## 守るべきこと

- **元テキストの忠実さ**：`openiti.split` / `join` は、編集していないページを1文字も変えずに再結合できなければならない。ページ区切り `PageV..P..` は、その直前のテキストがそのページに属する（区切りはページの末尾に来る）。改行・BOM・空白の扱いを変えるときは、未編集のまま書き出した結果が `original.txt` と一致することを確かめる。
- **書き込みは安全に**：JSON は `store._write_json`（一時ファイル＋`os.replace`）で書く。slug は `store._dir` で検証してからパスに使う。
- **外部接続**：新しい接続先が要るときは `net.ALLOWED` に足し、`net` 経由で取得する。リダイレクト先も ALLOWED で確かめ直す。IA のページ画像は `GET /api/projects/<slug>/scan/<idx>` から `sources.fetch_scan`（IIIF → BookReader の順）で取得し、`store.scan_path` のディスクキャッシュに保存する。サーバは 127.0.0.1 だけで待ち受ける。
- **OCR**：1ページずつ、校正者がボタンを押したとき（または設定 `autoOcr` が有効でページを開いたとき）だけ実行し、結果は `ocr/<i>.json` に保存して再利用する（過去の読みは `ocr/history/<i>/`）。API の利用料がかかるため、全ページを一括で読み取るような機能は勝手に足さない。OCR のプロンプトは「刊本の綴りをそのまま写す」方針なので、正規化や補完をさせる方向には変えない。
- **HTML への埋め込み**：利用者のデータやテキストをテンプレート文字列に入れるときは `esc()` を通す。

## コードの書き方

- 既存のコードに合わせる：Python は短い関数と docstring 1行程度、JS は `const`・アロー関数・`$()` ヘルパーを使った簡潔な書き方。コメントは少なめ。
- UI の文言・エラーメッセージ・トースト（`toast()`）は日本語。アラビア語の表示部分は `dir="rtl"` と `.ar` クラス（Noto Naskh Arabic）を使う。
- 比較（差分表示）用の正規化は `compare.js` の `ORTHO` / `normWord` にある。表示のための正規化であって、保存するテキストは正規化しない。

## リポジトリ

- `origin` は GitHub の qsarkbir/2026_ArabicTextsProofreading。`main` はルールセットで保護されており、直接 push・force push・削除はできない。
- 作業用ブランチで開発して push し、PR を作って `main` にマージする。マージ前に GitHub Actions のテストが成功していることを確かめる。
- 静的ブラウザ版の設計は `docs/static-design.md`。決定事項・段階の状態・保存形式の版を変えたら、その文書も同じ PR で更新する（決定事項は消さずに置き換え済みと書く）。
- `build-scripts/` と `bustan-proofreader.html` は git 管理外の実験的なもの（Bustan 1点を hOCR と突き合わせて単一 HTML にする試作）。本体のアプリとは独立している。
- ライセンスはコードが MIT。OpenITI のテキストは CC BY-NC-SA 4.0 なので、テキストやその一部をリポジトリに含めない。

## 拡張機能の確認事項

- providers/ はAnthropicとOpenAIの共通結果を返す。OpenAIはResponses API、OPENAI_API_KEYとOPENAI_OCR_MODEL。キーは出力しない。有料の実API検証は既定で行わない。
- importers/draft.py はPDFの選択範囲から仮IDの本文を作る。正式なOpenITI登録ではない。
- exporters/tei.py は基本TEI P5出力。ページ末尾マーカーを先頭のpbへ移し、未対応タグは残す。tests.validate_teiで公式スキーマ検証。
- 保存APIはページrevisionが必須。work.jsonのhistory/revisionsは旧データには無く、初回保存時に追加する。元のoriginal.txtは変えない。
- 保存履歴は store._record_history で記録する。HISTORY_WINDOW（5分）以内の自動保存は1件にまとめ、復元時は checkpoint で必ず1件残す。1ページ HISTORY_LIMIT（100件）まで。
- static/workflows.jsは新規作成・書誌・履歴、compare.jsは比較と構造保全。
- python -m tests.browser_smoke はPlaywrightで合成データのブラウザ検証。preview_serverのAIは模擬結果であり有料APIを呼ばない。
