# 静的ブラウザ版の設計

| 項目 | 内容 |
|---|---|
| 文書の状態 | 段階1a は実装済み（PR 未作成）。段階1b 以降は設計のみ |
| 対象 | 段階1（ブラウザ内での校正）。段階2以降は概要のみ |
| 最終更新 | 2026-11-16 |
| 関連 | [README.md](../README.md)、[CLAUDE.md](../CLAUDE.md) |

この文書は、Python サーバー無しで GitHub Pages などから配信できる「静的ブラウザ版」の設計をまとめる。実装が進むたびに更新する前提で、次の約束で書く。

- 決定事項には番号（`D-1` など）を振る。変更するときは消さずに「置き換え済み（→ D-n）」と書き、新しい番号で追記する。
- 段階ごとの状態は[段階と状態](#段階と状態)の表だけを更新する。本文は設計の説明に留める。
- 保存形式は必ず版番号を持ち、変えるときは[形式と版の管理](#形式と版の管理)の規則に従う。
- コードの位置は行番号ではなく、ファイル名と関数名で示す。
- 未決の論点は[未決事項](#未決事項)に置き、決まったら決定事項へ移す。
- 変更の要点は末尾の[改訂履歴](#改訂履歴)に1行で残す。

## 目的と前提

- 校正作業をインストール無しで始められるようにする。ローカル版（`python -m proofreader`）は今後も残す。
- 画面は1つのコードを両方の版で使い、データの保存先と外部への接続だけを差し替える。
- CLAUDE.md の「守るべきこと」（元テキストの忠実さ、`original.txt` を変えないこと、OCR を一括で実行しないこと、利用者のデータを `esc()` に通すこと）は、静的版にもそのまま当てはまる。
- OpenITI のテキストはリポジトリにも配信物にも含めず、実行時に取得する。

## 決定事項

| 番号 | 状態 | 内容 | 理由 |
|---|---|---|---|
| D-1 | 採用 | ローカル版と静的版は同じリポジトリで管理する | split/join の一致テスト、TEI 検証、ブラウザ検証を同じ CI で回せる。修正が片方だけに入ることを防ぐ |
| D-2 | 採用 | 画面のコード（`app.js`・`workflows.js`・`compare.js`・`core.js`・`app.css`・pdf.js）は両方の版で共有する | 2つの UI を保守するとずれる |
| D-3 | 採用 | 差し替え口は `api(method, url, body)` とする。静的版ではブラウザ内のルーターが同じ URL を受け取る | `app.js` の呼び出し箇所をほぼ変えずに済み、ブラウザ検証を両方の版で流せる |
| D-4 | 採用 | 保存先は IndexedDB。ページの状態は1ページ1件で保存する | revision の確認と書き込みを1つのトランザクションで行え、タブ間の競合をロック無しで判定できる |
| D-5 | 採用 | ビルド工程は持ち込まない。スクリプトは `<script>` で読み込み、Node のテストからも読める形（`core.js` と同じ `module.exports` の分岐）にする | 今の開発方法と揃える |
| D-6 | 採用 | ローカル版と静的版の間は、共通のバックアップ形式（[プロジェクトの書き出し形式](#プロジェクトの書き出し形式)）でプロジェクトを移せるようにする | どちらの版で始めても作業を引き継げる |
| D-7 | 採用 | 静的版には資料（`source`）が無いので、校正画面は `source` が無くても開く。ローカル版専用の要素は `needs-server` クラスを付け、`<html data-mode="browser">` のとき CSS で隠す（DOM は残す） | 画面のコードを分岐させずに、ハンドラの参照先を保てる |
| D-8 | 採用 | ルーターは `new URL()` を使わず、URL を `?` で分けて照合する。書き出しは `{filename, type, data}` を返し、`backend.js` の `saveDownload` がダウンロードさせる | `new URL()` は `..` を畳み込み、サーバーと違う結果になる。ブラウザ内にはダウンロード用の URL が無い |
| D-9 | 採用 | 静的版の `pages` は `keyPath: ['slug','i']` で、record に `slug`・`i` を含める。変更が無く record も無いページは書かない。`originals` は `{slug, text}` で作成時だけ書き、split の結果はスラッグごとにメモリに持つ | 範囲取得（`IDBKeyRange`）で1プロジェクトのページをまとめて読める |
| D-10 | 採用 | バックアップ（`<slug>.proofreader.json`）は両方の版が同じ検証で読む。`format` と `format_version` を確かめ、`format_version`・`project.schema_version`・`work.schema_version` のどれかが新しければ「新しい版のアプリで作られたデータです」で拒否する。`original` は split→join で一致を確かめ、`slug` は信用せず `uri` から作り直して `_2` `_3` で重複を避ける（`store.create` と同じ）。読み込み時に、作業データを正規化する：原文と同じ修正本文は捨て、`done: false` と空の注記は持たず、履歴は1ページ100件までにする。範囲外のページ番号・型の違いは拒否する。検証は `proofreader/bundle.py` と `local/bundle.js` に同じ規則で置き、`tests/fixtures/bundle/cases.json` の事例を両方で突き合わせる | 片方でだけ通るファイルを作らない。壊れたファイルや悪意のあるファイルで、パスや保存先を決めさせない |
| D-11 | 採用 | バックアップに PDF と OCR の結果は入れない（Q-2 は「含めない」で当面決着）。資料の情報（`project.source`、`pdf_file`）はそのまま残す。ローカル版は `pdf_file` が指すファイルが無いとき、PDF ではなくオンラインの画像を使う。PDF は読み込み後に付け直す | ファイルが数百 MB になるのを避ける。読み込んだだけで画像が出なくなる状態を避ける |
| D-12 | 採用 | `local/tei.js` は `exporters/tei.py` の出力と**バイト単位で一致**させる（ElementTree の書き方に合わせる：宣言は `<?xml version='1.0' encoding='utf-8'?>`、空の要素は `<x />`、属性の `\n\r\t` は文字参照）。一致は `tests/fixtures/tei/` の合成入力と、Python の出力を正とする `expected.json` で、Python（`test_tei_parity.py`）と Node（`tei.test.js`）の両方から確かめる。CI のスキーマ検証は Python の出力に加え、`tei.js` が書いたファイルも検証する | どちらの版で書き出しても同じ TEI になる |
| D-13 | 採用 | Arabic フォントは当面 Google Fonts のまま使い、CSP の `style-src` に `https://fonts.googleapis.com`、`font-src` に `https://fonts.gstatic.com` を許可する（Q-1 の決着）。同梱への切り替えは、オフライン利用の要望が出たとき改めて決める | 追加の配布物とライセンス表示を増やさずに済む。外部接続はフォントの取得だけで、利用者のデータは送られない |
| D-14 | 採用 | CSP は `<meta>` で `default-src 'self'; script-src 'self'; connect-src 'self' blob: https://raw.githubusercontent.com; img-src 'self' blob: data: https://archive.org https://*.archive.org; style-src 'self' https://fonts.googleapis.com; style-src-attr 'unsafe-inline'; font-src 'self' https://fonts.gstatic.com; worker-src 'self' blob:; object-src 'none'; base-uri 'self'` とする。`style-src-attr 'unsafe-inline'` が要るのは、テンプレート文字列の `style="..."`（進捗バーの幅など）を使っているため。スクリプトとスタイルシートの `'unsafe-inline'` は許可しない。`connect-src blob:` は pdf.js が Blob の PDF を `fetch` で読むため、`img-src` の archive.org はローカル版の資料検索のサムネイル用 | 同じ `index.html` をローカル版でも使うので、ローカル版の機能（IA のサムネイル、PDF 表示）を止めない範囲にする。段階2で IA に直接接続するときは `connect-src` に足す |
| D-15 | 採用 | GitHub Pages への配信は Actions の `deploy` ジョブで行う。テスト（`core`・`browser-and-tei`）が成功した `main` への push のときだけ動き、`proofreader/static/` をそのまま配信する。リポジトリの Settings → Pages → Source を「GitHub Actions」にしておく必要がある（README に書く） | ビルド工程が無いので、成果物はディレクトリそのもの。テストに通らないものは公開しない |
| D-16 | 採用 | ローカル版のサーバーは、存在する静的ファイルでも `/api/` でもない GET を `/` へ 302 で戻す。`index.html` を返さない | 相対パスにしたため `/x/` で開くと `/x/mode.js` が `index.html` を返して画面が空になった |
| D-17 | 採用 | IndexedDB の扱い：書き込みトランザクションは `durability: 'strict'`（知らないブラウザでは無視される）、`navigator.storage.persist()` は待たずに依頼する（Firefox は許可の確認が出る）、接続が閉じられたら（`onclose`・`versionchange`）次の操作で開き直し、他のタブに止められたら（`onblocked`）日本語で案内する。ホームの一覧は BroadcastChannel の通知（保存・作成・読み込み・バックアップの記録）で更新する | 保存の信頼性と、複数タブでの利用 |
| D-18 | 採用 | ローカル版のサーバーは、すべてのリクエストで `Host` が `127.0.0.1:<待ち受けポート>` か `localhost:<待ち受けポート>` であることを確かめ（DNS rebinding 対策）、GET 以外では `Origin` があれば同じ 2 つの `http://` のオリジンだけを許可する。違えば 403。待ち受けポートが 80 のときはポートの無い形（`127.0.0.1`・`localhost`）も許可する。GET 以外で `Sec-Fetch-Site` が `cross-site`・`same-site` の要求も 403。`Origin` が無い要求（curl など）は通す。`text/plain` の POST はプリフライトなしで他のサイトから送れるため、これが無いと外部のページが取り込み・作成・終了・有料の OCR を呼べた | サーバーは 127.0.0.1 だけで待ち受けるが、ブラウザ経由なら外部のページからも届く。静的版は外部へ API を持たないので対象外 |
| D-19 | 採用 | バックアップの `project.source` は両方の版で同じ形を要求する：`ia` は文字列の `id` と、`service`（文字列）・`label`（文字列か整数）・`w`/`h`（あれば整数か null）を持つオブジェクトの `pages`、`pdf` は文字列の `file` と整数の `count`、`revision`・`pdf_file`・`title` は、あれば文字列。`bibliography` の値と `candidates` の要素はすべて文字列。形が違えば読み込みで拒否する | 読み込めたあとの `image_for` や画面で例外になるデータを入れない |
| D-20 | 採用 | JSON の `1.0` は JS では整数、Python では float になる。バックアップの検証は、整数を求める所で「安全な整数（絶対値 2^53-1 以下）」だけを受け入れ、Python 側は整数に等しい float を読み込み時に整数へ直す（`bundle._integral`）。`1.5` や 2^53 を超える数は両方で拒否する。`status`・`history` の `done` は真偽値か null だけを受け入れる。変換と検証は `project` と `work` にだけ掛け、入れ子が深すぎてスタックが尽きたときは例外ではなく読み込みの拒否にする。リクエストの JSON も `NaN`・`Infinity` を拒否する（JS の `JSON.parse` と同じ）。共通の事例は `cases.json` の `integral-floats`・`offset-unsafe-*` | 同じファイルの受理・拒否と、読み込み後の値を両方の版で一致させる |
| D-21 | 採用 | プロジェクトの作成（`store.install`）は、slug のフォルダを `mkdir`（既存なら失敗）で確保してから書き込み、途中で失敗したら、そのフォルダだけを削除する（別のプロセスが同時に同じ slug を取っても、相手のプロジェクトを消さない。取られていたら次の `_2` `_3` を試す）。静的版のバックアップ日時（`backup:<slug>`）は、ルーターが返した `done()` を `saveDownload` がダウンロード開始後に呼んで記録する。`onblocked` で拒否した後に開けた IndexedDB の接続は閉じる | 失敗した作成で slug が使われたままにならない。書き出しに失敗したのに「バックアップ済み」と表示しない。使われない接続が他のタブの更新を止めない |

## 段階と状態

| 段階 | 内容 | 状態 |
|---|---|---|
| 1a | ホーム、OpenITI の URI からの作成、テキストのアップロード、校正（本文・完了・注記）、revision による競合検出、保存履歴と復元、検索、書き出し（OpenITI テキスト・注記 CSV・TEI）、バックアップの書き出し・読み込み、CSP、GitHub Pages への配信 | 完了（PR 未作成）。`local/{openiti,work,bundle,tei,store,router}.js`・`backend.js`・`mode.js` で、ブラウザだけで動く。ローカル版にもバックアップの書き出し・読み込みを追加 |
| 1b | 手元の PDF を資料にする、ページの対応付け、PDF の選択範囲からの仮本文（`importers/draft.py` の移植） | 未着手 |
| 2 | Internet Archive 連携（マニフェスト、検索、ページ画像、PDF） | 未着手（CORS の確認が先） |
| 3 | OCR（Anthropic・OpenAI をブラウザから直接呼ぶ。キーは利用者が入力） | 未着手 |

状態は「未着手 → 作業中 → 完了」で書き、完了したら対応する PR を併記する。

## 機能の対応表

ローカル版でサーバーが担っている仕事と、静的版での扱い。

| ローカル版 | 静的版 | 段階 |
|---|---|---|
| `store.py`（`projects/` への保存、revision、保存履歴） | `local/store.js`（IndexedDB）と `local/work.js`（純粋なロジック） | 1a |
| `openiti.py`（URI 解決、yml、split/join） | `local/openiti.js` | 1a |
| `exporters/tei.py` | `local/tei.js`（バイト単位で一致、D-12） | 1a |
| `bundle.py`（バックアップの書き出し・読み込み） | `local/bundle.js` と `LocalStore.importBundle` | 1a |
| `importers/draft.py` | `local/draft.js` | 1b |
| 手元の PDF の保存（`files/`） | IndexedDB の `files` に Blob で保存 | 1b |
| `sources.py`（IA） | ブラウザから直接取得。CORS を返さない経路は使わない | 2 |
| `scan` のディスクキャッシュ | Cache API | 2 |
| IA の PDF 保存 | 利用者がダウンロードしたファイルを選ぶ方式を基本にする | 2 |
| `providers/`・`ocr.py` | ブラウザから直接呼ぶ。プロンプトは共通の定義を使う | 3 |
| `net.ALLOWED` | `<meta>` の CSP `connect-src`（D-14） | 1a で導入。段階ごとに接続先を足す |
| `presence.py`・自動終了・終了ボタン | 使わない（画面から隠す） | 1a |
| `send_file` の Range 対応 | 使わない（pdf.js が Blob を直接読む） | 1b |

静的版で未対応の機能は、画面から隠すか「ローカル版で利用できます」と表示する。どちらにするかは機能ごとに `mode.js` の値で切り替える。

## 構成

```
proofreader/static/
  mode.js           静的版は 'browser'。ローカル版のサーバーは同じパスに 'http' を返す
  backend.js        api() の実体。'http' なら fetch、'browser' なら local/router.js
  local/
    router.js       server.py のルートと同じ URL パターンを関数に対応づける
    openiti.js      split / join / resolve / parse_yml / title_of / author_of / scan_links
    work.js         update_page と _record_history に相当する純粋な関数（入出力なし）
    store.js        IndexedDB の読み書きと版の移行
    tei.js          TEI P5 の書き出し（exporters/tei.py と同じバイト列）
    bundle.js       バックアップの作成と検証（bundle.py と同じ規則。保存は store.js の importBundle）
    draft.js        （1b）PDF の選択範囲からの仮本文
```

- `local/*.js` は `<script>` で読み込む通常のスクリプトで、全体が1つのグローバルスコープを共有する。そのため各ファイルは名前空間の定数を1つだけ公開する（`OpenITI`、`Work` など）。Node からは `module.exports` でその同じオブジェクトを読む。名前の衝突は `tests/globals.test.js` で確かめる。
- ルーターが返す値とエラーは、サーバーの応答に合わせる。エラーは `status`（409・428 など）と日本語のメッセージを持ち、画面側は今と同じ扱いができるようにする。
- ルーターが知らない URL は「この機能はローカル版で利用できます」というエラーにする。
- ルートを追加・変更するときは、`server.py` と `local/router.js` の両方を直し、片方だけのルートは対応表に明記する。

## 保存の設計

### IndexedDB

DB 名は `proofreader`。DB の版は[形式と版の管理](#形式と版の管理)で管理する。

| store | キー | 中身 | 書き換え |
|---|---|---|---|
| `projects` | `slug` | `project.json` と同じ形 | 書誌・資料・対応付けの変更時 |
| `originals` | `slug` | `{slug, text}` | 作成時だけ。以後は書き換えない |
| `pages` | `[slug, i]` | `{text?, done, note, revision, history[]}`。`text` は原文と異なるときだけ持つ | 保存のたび |
| `files` | `[slug, name]` | PDF などの Blob | 1b から |
| `ocr` | `[slug, i]` | `ocr/<i>.json` と同じ形と過去の読み | 3 から |
| `settings` | `key` | 利用者ごとの設定 | 必要になったとき |

- **保存の手順**：1つの readwrite トランザクションの中で、`pages` を読む → revision を比べる → `work.js` で新しい状態を作る → 書く。revision が違えば 409 相当、revision が無ければ 428 相当のエラーにする。
- **保存履歴**：ローカル版と同じ規則にする。`HISTORY_WINDOW`（5分）以内の自動保存は1件にまとめ、復元時は checkpoint で必ず1件残し、1ページ `HISTORY_LIMIT`（100件）まで残す。値は `work.js` の定数とし、ローカル版と食い違わないようテストで確かめる。
- **タブ間の通知**：保存後に BroadcastChannel で `{slug, i, revision}` を送り、ほかのタブは一覧や状態の表示を更新する。競合の判定そのものはトランザクションに任せる。

- **ローカル版との意図的な違い**：`work.js` は完了・注記を意味で比べる（`done:false` や空の注記を足すだけの保存は変更なしとして revision を上げない）。Python 版は辞書として比べるので上げる。履歴に残る状態も、真の `done` と空でない `note` だけを持つ。ページ・巻の番号は JS では 2^53 を超えると精度を失う。
- **一致テスト**：`tests/fixtures/work/ops.json`（保存操作の列と固定の時刻）を Python の `store.update_page` と `work.js` で再生し、同じ `expected.json` と比べる。

### データを失わないために

- 最初のプロジェクトを作る（または読み込む）ときに `navigator.storage.persist()` を、待たずに要求する（D-17）。
- ホームに使用量（`navigator.storage.estimate()`）と自動削除からの保護の有無、プロジェクトごとの最後のバックアップ日時（`settings` の `backup:<slug>`、書き出したとき記録。無ければ「未バックアップ」）を表示する。
- ブラウザのデータは利用者の操作や容量不足で消えることがあると、ホームに明記する。

### プロジェクトの書き出し形式

1プロジェクトを1つの JSON ファイル（`<slug>.proofreader.json`）にする。ローカル版は `GET /api/projects/<slug>/export?fmt=bundle` と `POST /api/projects/import-bundle`、静的版は同じ URL を受けるルーターで書き出し・読み込みを行う。画面は両方の版で、プロジェクトの書き出しメニューの「バックアップを書き出す」と、ホームの「バックアップから読み込む」（ファイル選択）。

```json
{
  "format": "openiti-proofreader-project",
  "format_version": 1,
  "exported": "2026-11-16T00:00:00Z",
  "app": {"mode": "browser", "version": "0.1.0"},
  "project": { "…": "project.json と同じ" },
  "original": "原文（original.txt と同じ文字列）",
  "work": { "edits": {}, "status": {}, "history": {}, "revisions": {}, "schema_version": 2 }
}
```

- `exported` は UTC。`app.mode` は書き出した版（`http` か `browser`）、`app.version` は `bundle.py` と `bundle.js` の `APP_VERSION`（テストで一致を確かめる）。
- `work` は `work.json` の形。静的版は ページごとの record と相互に変換する（`Work.recordsToWork` / `workToRecords`）。
- PDF などのファイルと OCR の結果は含めない（D-11）。資料の情報は `project` に残り、読み込み後にファイルを選び直してもらう。
- 読み込みの規則は D-10。読み込んだプロジェクトは常に新しいプロジェクトとして作られ、既存のプロジェクトを上書きしない。
- 静的版は1つの `readwrite` トランザクション（`projects`・`originals`・`pages`）で書くので、途中で失敗したプロジェクトは残らない。ローカル版は `work.json` の次に `project.json` を書き、`project.json` が無いフォルダは一覧に出ない。

## 形式と版の管理

版番号を持つものは次の4つ。どれも整数で、上げるときは1ずつ上げる。

| 対象 | 置き場所 | 現在 |
|---|---|---|
| プロジェクトの形式 | `project.json` の `schema_version` | 2 |
| 作業データの形式 | `work.json` の `schema_version` | 2 |
| IndexedDB の構造 | `indexedDB.open('proofreader', n)` の `n` | 1 |
| 書き出しファイルの形式 | `format_version` | 1 |

規則：

1. **古い版は読めるようにする**。読み込み時（IndexedDB は `onupgradeneeded`）に新しい版へ移行し、移行は1版ずつの関数を順につなぐ（`migrate[1→2]`、`migrate[2→3]`…）。移行関数は消さない。
2. **新しすぎる版は書き換えない**。知らない版のデータを見つけたら、読み込みを止めて「新しい版のアプリで作られたデータです」と表示する。上書きはしない。
3. **原文は移行で変えない**。`originals` と書き出しファイルの `original` は、どの移行でも書き換えない。
4. **ローカル版と静的版で `schema_version` を揃える**。片方で上げるときは、同じ PR でもう片方の読み込みも対応させる。
5. 版を上げたときは、この表と[改訂履歴](#改訂履歴)、RELEASE_NOTES.md を更新する。移行のテストには、旧版の合成データを fixture として残す。

## テスト

| 対象 | 方法 |
|---|---|
| split/join の一致 | 合成データの fixture（OpenITI の本文は使わない）を Python と Node の両方で分割・再結合し、結果の JSON を突き合わせる。改行コードの混在、BOM、マーカーの無い末尾、未割り当ての末尾ページを含める。乱数で作った文字列での往復も確かめる |
| 保存ロジック | `work.js` を Node でテストする。`test_extensions.py` の履歴テスト（5分のまとめ、checkpoint、上限）と同じ内容を持つ |
| 移行 | 旧版の fixture を読み込み、最新版になることと原文が変わらないことを確かめる |
| IndexedDB を含む動作 | `tests/browser_smoke.py` をブラウザ版でも流す。2つのタブでの競合も確かめる |
| TEI | `tests/fixtures/tei/inputs.json`（合成入力）の `expected.json` は Python の出力。`tests/test_tei_parity.py` と `tests/tei.test.js` が、`exporters/tei.py` と `tei.js` の出力が一致することを確かめる。CI は `tests/tei_fixtures.js` で `tei.js` の出力をファイルに書き、`tests.validate_tei` で公式スキーマに通す（Python の出力も同じ） |
| 書き出しファイル | `tests/fixtures/bundle/cases.json`（受理・拒否の事例と期待値）を `test_bundle.py` と `bundle.test.js` が確かめる。`python-export.proofreader.json`（Python の出力）を `browser_static_smoke` が静的版に読み込んで書き戻し、静的版が書き出したものを Python が読み込む（BOM・CRLF の往復も含む）。`browser_smoke` はローカル版の書き出し・読み込みを確かめる |

## 配信

- `index.html` などの参照は相対パスにする（GitHub Pages はリポジトリ名のサブパスで配信される）。
- GitHub Actions の `deploy` ジョブが、テストがすべて成功した `main` への push のときだけ `proofreader/static/` を Pages に配信する（D-15）。ジョブの権限は `pages: write`・`id-token: write` に、チェックアウト用の `contents: read` を足したもの。
- CSP を `<meta http-equiv="Content-Security-Policy">` で指定する（全文と理由は D-14）。段階ごとに必要な接続先だけを足し、足した接続先は対応表とこの節に書く。`browser_static_smoke` と `browser_smoke` は、CSP 違反が起きないことと、インラインのスクリプトが実際にブロックされることを確かめる。
- リポジトリが private の場合、Pages の利用には有料プランが必要で、配信されたサイトは公開される。

## 段階2以降の注意（概要）

- **Internet Archive**：エンドポイントごとに CORS を確かめ、結果をこの文書に表で残してから実装する。`<img>` での表示は CORS が無くてもできるが、OCR に画像を送るには必要になる。
- **IA の PDF**：数百 MB をブラウザに保存するのは容量と消去の面で不安定なため、利用者がダウンロードしたファイルを選ぶ方式を基本にする。
- **OCR**：API キーは利用者が画面で入力し、ブラウザ内にだけ置く。キーを書き出しファイルに含めない。1ページずつ、利用者の操作で実行するという原則は変えない。

## 未決事項

| 番号 | 論点 | 選択肢 |
|---|---|---|
| Q-1 | Arabic フォントの配信 | 決定済み（→ D-13）：当面 Google Fonts。同梱は再検討 |
| Q-2 | 書き出しファイルに OCR の結果を含めるか | 当面は含めない（→ D-11）。段階3で OCR を移植するとき、選べるようにするかを決める |
| Q-3 | `mode.js` の判定方法 | 静的ファイルとサーバーの応答で切り替える（本案）／URL のパラメータで切り替える |
| Q-4 | 長期的なローカル版の位置づけ | 今の Python 版を保つ／静的ファイルの配信と、CORS で取れない資料の取得だけを行う小さなサーバーにする |
| Q-5 | Chrome/Edge の File System Access API で手元のフォルダにも保存できるようにするか | 対応する（Firefox・Safari では使えない）／IndexedDB だけにする |

## 改訂履歴

| 日付 | 内容 |
|---|---|
| 2026-11-16 | 初版。段階1の設計と、版の管理の規則をまとめた |
| 2026-11-16 | 段階1a を作業中にした。`local/openiti.js`・`local/work.js` を名前空間で公開する形にし、保存操作の一致テストと意図的な違いを追記 |
| 2026-11-16 | 段階1a: `mode.js`・`backend.js`・`local/store.js`・`local/router.js` を実装し、ブラウザ版の動作検証（`tests/browser_static_smoke.py`）を追加。D-7〜D-9 を追記 |
| 2026-11-16 | 段階1a を完了（PR 未作成）にした。TEI（`local/tei.js`、バイト一致）、バックアップの書き出し・読み込み（両方の版、`bundle.py` / `local/bundle.js`）、CSP、Pages への配信、ホームの使用量・バックアップ日時・タブ間更新を実装。ローカル版の未知パスを `/` へリダイレクト。IndexedDB の扱いを堅くした。D-10〜D-17 を追記し、Q-1 を決着、Q-2 を当面「含めない」にした |
| 2026-11-16 | レビュー指摘への対応：Origin/Host の検証（D-18）、`source` などの型の検証と整数の扱いの統一（D-19・D-20）、作成失敗時の後始末・バックアップ日時の記録位置・IndexedDB 接続の後始末（D-21）、Pages 配信ジョブの `concurrency`。`ia_pdf_status` の `attached` はファイルがあるときだけ |
| 2026-11-16 | 再レビューへの対応：`install` の競合で他のプロジェクトを消さない、深い入れ子・`NaN`・`done` の型の拒否、`LocalStore.open` の古いコールバック、ポート 80 の Host と `Sec-Fetch-Site`（D-18〜D-21 を更新） |
