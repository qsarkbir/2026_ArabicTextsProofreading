# CLAUDE.md

OpenITI のアラビア語テキストを、刊本のページ画像（Internet Archive の IIIF または手元の PDF）と並べて校正するローカル Web アプリ。利用者向けの説明は [README.md](README.md) にある。

## 実行

```bash
python -m proofreader            # http://127.0.0.1:8765/ を開く
python -m proofreader --no-browser --port 8770
```

- Python 3.10 以上。標準ライブラリだけで動く。`anthropic` パッケージ（`requirements.txt`）は Claude OCR を使うときだけ必要で、無ければ OCR が無効になるだけ。`anthropic` は `.venv` にだけ入っているので、OCR を使うときはシステムの `python` ではなく `.venv\Scripts\python -m proofreader` で起動する。
- API キーはリポジトリのルートの `.env`（git 管理外）に `ANTHROPIC_API_KEY=...` と書く。`server.load_env` が起動時に読み込み、シェルの環境変数より優先する。`main()` の中で読むので、import 時に評価される `PROOF_DATA` は `.env` では変えられない。`.env` の中身は表示・コミットしない。
- プレビュー用の設定は `.claude/launch.json`（`proofreader-app`、ポート 8770、`.venv` の Python で起動）。
- ビルド工程・リンターは無い。回帰テストは `python -m unittest discover -s tests -v` と `node --test tests/core.test.js`。構文確認は `node --check proofreader/static/app.js`。ブラウザ検証は `python -m tests.preview_server` で合成データ専用のサーバーを起動できる（8772番、最初の保存を意図的に失敗させる）。
- 作業データは `projects/`（`PROOF_DATA` で変更可、git 管理外）。動作確認には既存のプロジェクトを使ってよいが、`original.txt` は書き換えないこと。

## 構成

```
proofreader/
  server.py    http.server ベースの API とスタティック配信。@route(method, regex) でルート登録
  store.py     projects/<slug>/ の読み書き（project.json, original.txt, work.json, ocr/, files/）
  openiti.py   OpenITI の URI 解決・取得、yml メタデータ、ページ分割（split）と再結合（join）
  sources.py   Internet Archive の IIIF マニフェスト・検索
  net.py       外部への HTTP。接続先は ALLOWED のホストに限定
  ocr.py       Claude によるページ画像の読み取り（MODEL = "claude-opus-5-5"）
  static/      フロントエンド（index.html, app.js, app.css）。フレームワーク・ビルド無しの素の JS
```

- フロントは `location.hash` によるルーティング（`#/`、`#/p/<slug>/setup`、`#/p/<slug>/<ページ番号>`）。各画面は `homeView` / `setupView` / `proofView` が `view.innerHTML` にテンプレート文字列を流し込んで組み立てる。
- 表示設定は `prefs`（localStorage の `proof-prefs`）に保存する。新しい設定項目は `prefs` の既定値 `def` に足す。
- pdf.js はアップロードされた PDF を開くときだけ cdnjs から読み込む。

## 守るべきこと

- **元テキストの忠実さ**：`openiti.split` / `join` は、編集していないページを1文字も変えずに再結合できなければならない。ページ区切り `PageV..P..` は、その直前のテキストがそのページに属する（区切りはページの末尾に来る）。改行・BOM・空白の扱いを変えるときは、未編集のまま書き出した結果が `original.txt` と一致することを確かめる。
- **書き込みは安全に**：JSON は `store._write_json`（一時ファイル＋`os.replace`）で書く。slug は `store._dir` で検証してからパスに使う。
- **外部接続**：新しい接続先が要るときは `net.ALLOWED` に足し、`net` 経由で取得する。サーバは 127.0.0.1 だけで待ち受ける。
- **OCR**：1ページずつ、校正者がボタンを押したとき（または設定 `autoOcr` が有効でページを開いたとき）だけ実行し、結果は `ocr/<i>.json` に保存して再利用する。API の利用料がかかるため、全ページを一括で読み取るような機能は勝手に足さない。OCR のプロンプトは「刊本の綴りをそのまま写す」方針なので、正規化や補完をさせる方向には変えない。
- **HTML への埋め込み**：利用者のデータやテキストをテンプレート文字列に入れるときは `esc()` を通す。

## コードの書き方

- 既存のコードに合わせる：Python は短い関数と docstring 1行程度、JS は `const`・アロー関数・`$()` ヘルパーを使った簡潔な書き方。コメントは少なめ。
- UI の文言・エラーメッセージ・トースト（`toast()`）は日本語。アラビア語の表示部分は `dir="rtl"` と `.ar` クラス（Noto Naskh Arabic）を使う。
- 比較（差分表示）用の正規化は `app.js` の `ORTHO` / `normWord` にある。表示のための正規化であって、保存するテキストは正規化しない。

## リポジトリ

- `main` ブランチで開発し、`origin`（GitHub: qsarkbir/2026_ArabicTextsProofreading）へ push する。
- `build-scripts/` と `bustan-proofreader.html` は git 管理外の実験的なもの（Bustan 1点を hOCR と突き合わせて単一 HTML にする試作）。本体のアプリとは独立している。
- ライセンスはコードが MIT。OpenITI のテキストは CC BY-NC-SA 4.0 なので、テキストやその一部をリポジトリに含めない。
