# 静的ブラウザ版の設計

| 項目 | 内容 |
|---|---|
| 文書の状態 | 段階1a・1b は実装済み（[#5](https://github.com/qsarkbir/2026_ArabicTextsProofreading/pull/5)）。段階2・段階3 は実装済み（PR 未作成） |
| 対象 | 段階1（ブラウザ内での校正と、手元の PDF を資料にすること）、段階2（Internet Archive）、段階3（ブラウザ版の OCR。Anthropic のみ） |
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
| D-7 | 一部置き換え済み（資料が無いときの画像欄の扱いは D-32） | 静的版には資料（`source`）が無いので、校正画面は `source` が無くても開く。ローカル版専用の要素は `needs-server` クラスを付け、`<html data-mode="browser">` のとき CSS で隠す（DOM は残す） | 画面のコードを分岐させずに、ハンドラの参照先を保てる |
| D-8 | 採用 | ルーターは `new URL()` を使わず、URL を `?` で分けて照合する。書き出しは `{filename, type, data}` を返し、`backend.js` の `saveDownload` がダウンロードさせる | `new URL()` は `..` を畳み込み、サーバーと違う結果になる。ブラウザ内にはダウンロード用の URL が無い |
| D-9 | 採用 | 静的版の `pages` は `keyPath: ['slug','i']` で、record に `slug`・`i` を含める。変更が無く record も無いページは書かない。`originals` は `{slug, text}` で作成時だけ書き、split の結果はスラッグごとにメモリに持つ | 範囲取得（`IDBKeyRange`）で1プロジェクトのページをまとめて読める |
| D-10 | 採用 | バックアップ（`<slug>.proofreader.json`）は両方の版が同じ検証で読む。`format` と `format_version` を確かめ、`format_version`・`project.schema_version`・`work.schema_version` のどれかが新しければ「新しい版のアプリで作られたデータです」で拒否する。`original` は split→join で一致を確かめ、`slug` は信用せず `uri` から作り直して `_2` `_3` で重複を避ける（`store.create` と同じ）。読み込み時に、作業データを正規化する：原文と同じ修正本文は捨て、`done: false` と空の注記は持たず、履歴は1ページ100件までにする。範囲外のページ番号・型の違いは拒否する。検証は `proofreader/bundle.py` と `local/bundle.js` に同じ規則で置き、`tests/fixtures/bundle/cases.json` の事例を両方で突き合わせる | 片方でだけ通るファイルを作らない。壊れたファイルや悪意のあるファイルで、パスや保存先を決めさせない |
| D-11 | 一部置き換え済み（OCR の結果は → D-42） | バックアップに PDF と OCR の結果は入れない（Q-2 は「含めない」で当面決着）。資料の情報（`project.source`、`pdf_file`）はそのまま残す。ローカル版は `pdf_file` が指すファイルが無いとき、PDF ではなくオンラインの画像を使う。PDF は読み込み後に付け直す | ファイルが数百 MB になるのを避ける。読み込んだだけで画像が出なくなる状態を避ける |
| D-12 | 採用 | `local/tei.js` は `exporters/tei.py` の出力と**バイト単位で一致**させる（ElementTree の書き方に合わせる：宣言は `<?xml version='1.0' encoding='utf-8'?>`、空の要素は `<x />`、属性の `\n\r\t` は文字参照）。一致は `tests/fixtures/tei/` の合成入力と、Python の出力を正とする `expected.json` で、Python（`test_tei_parity.py`）と Node（`tei.test.js`）の両方から確かめる。CI のスキーマ検証は Python の出力に加え、`tei.js` が書いたファイルも検証する | どちらの版で書き出しても同じ TEI になる |
| D-13 | 採用 | Arabic フォントは当面 Google Fonts のまま使い、CSP の `style-src` に `https://fonts.googleapis.com`、`font-src` に `https://fonts.gstatic.com` を許可する（Q-1 の決着）。同梱への切り替えは、オフライン利用の要望が出たとき改めて決める | 追加の配布物とライセンス表示を増やさずに済む。外部接続はフォントの取得だけで、利用者のデータは送られない |
| D-14 | 採用 | CSP は `<meta>` で `default-src 'self'; script-src 'self'; connect-src 'self' blob: https://raw.githubusercontent.com https://archive.org https://iiif.archive.org https://api.anthropic.com; img-src 'self' blob: data: https://archive.org https://*.archive.org; style-src 'self' https://fonts.googleapis.com; style-src-attr 'unsafe-inline'; font-src 'self' https://fonts.gstatic.com; worker-src 'self' blob:; object-src 'none'; base-uri 'self'` とする。`style-src-attr 'unsafe-inline'` が要るのは、テンプレート文字列の `style="..."`（進捗バーの幅など）を使っているため。スクリプトとスタイルシートの `'unsafe-inline'` は許可しない。`connect-src blob:` は pdf.js が Blob の PDF を `fetch` で読むため、`img-src` の archive.org は IA のサムネイルとページ画像（`iiif.archive.org`、`*.archive.org` に含まれる）の `<img>` 用。段階2で `connect-src` に `https://archive.org`（検索・資料情報）と `https://iiif.archive.org`（マニフェスト）を足した（D-28）。ページ画像と PDF は `<img>`・pdf.js が読むだけなので、段階2ではこれ以上は足さなかった。**段階3で `connect-src` に `https://api.anthropic.com`（OCR の API、D-41）を足した**。IIIF の画像を OCR に送るための `fetch` は `https://iiif.archive.org` が既に許可されている。同梱した SDK は同じオリジンの `import()` で読むので `script-src` は変えない（D-43）。OpenAI を足すときは `https://api.openai.com` を足す | 同じ `index.html` をローカル版でも使うので、ローカル版の機能（IA のサムネイル、PDF 表示）を止めない範囲にする |
| D-15 | 採用 | GitHub Pages への配信は Actions の `deploy` ジョブで行う。テスト（`core`・`browser-and-tei`）が成功した `main` への push のときだけ動き、`proofreader/static/` をそのまま配信する。リポジトリの Settings → Pages → Source を「GitHub Actions」にしておく必要がある（README に書く） | ビルド工程が無いので、成果物はディレクトリそのもの。テストに通らないものは公開しない |
| D-16 | 採用 | ローカル版のサーバーは、存在する静的ファイルでも `/api/` でもない GET を `/` へ 302 で戻す。`index.html` を返さない | 相対パスにしたため `/x/` で開くと `/x/mode.js` が `index.html` を返して画面が空になった |
| D-17 | 採用 | IndexedDB の扱い：書き込みトランザクションは `durability: 'strict'`（知らないブラウザでは無視される）、`navigator.storage.persist()` は待たずに依頼する（Firefox は許可の確認が出る）、接続が閉じられたら（`onclose`・`versionchange`）次の操作で開き直し、他のタブに止められたら（`onblocked`）日本語で案内する。ホームの一覧は BroadcastChannel の通知（保存・作成・読み込み・バックアップの記録）で更新する | 保存の信頼性と、複数タブでの利用 |
| D-18 | 採用 | ローカル版のサーバーは、すべてのリクエストで `Host` が `127.0.0.1:<待ち受けポート>` か `localhost:<待ち受けポート>` であることを確かめ（DNS rebinding 対策）、GET 以外では `Origin` があれば同じ 2 つの `http://` のオリジンだけを許可する。違えば 403。待ち受けポートが 80 のときはポートの無い形（`127.0.0.1`・`localhost`）も許可する。GET 以外で `Sec-Fetch-Site` が `cross-site`・`same-site` の要求も 403。`Origin` が無い要求（curl など）は通す。`text/plain` の POST はプリフライトなしで他のサイトから送れるため、これが無いと外部のページが取り込み・作成・終了・有料の OCR を呼べた | サーバーは 127.0.0.1 だけで待ち受けるが、ブラウザ経由なら外部のページからも届く。静的版は外部へ API を持たないので対象外 |
| D-19 | 採用 | バックアップの `project.source` は両方の版で同じ形を要求する：`ia` は文字列の `id` と、`service`（文字列）・`label`（文字列か整数）・`w`/`h`（あれば整数か null）を持つオブジェクトの `pages`、`pdf` は文字列の `file` と整数の `count`、`revision`・`pdf_file`・`title` は、あれば文字列。`bibliography` の値と `candidates` の要素はすべて文字列。形が違えば読み込みで拒否する | 読み込めたあとの `image_for` や画面で例外になるデータを入れない |
| D-20 | 採用 | JSON の `1.0` は JS では整数、Python では float になる。バックアップの検証は、整数を求める所で「安全な整数（絶対値 2^53-1 以下）」だけを受け入れ、Python 側は整数に等しい float を読み込み時に整数へ直す（`bundle._integral`）。`1.5` や 2^53 を超える数は両方で拒否する。`status`・`history` の `done` は真偽値か null だけを受け入れる。変換と検証は `project` と `work` にだけ掛け、入れ子が深すぎてスタックが尽きたときは例外ではなく読み込みの拒否にする。リクエストの JSON も `NaN`・`Infinity` を拒否する（JS の `JSON.parse` と同じ）。共通の事例は `cases.json` の `integral-floats`・`offset-unsafe-*` | 同じファイルの受理・拒否と、読み込み後の値を両方の版で一致させる |
| D-21 | 採用 | プロジェクトの作成（`store.install`）は、slug のフォルダを `mkdir`（既存なら失敗）で確保してから書き込み、途中で失敗したら、そのフォルダだけを削除する（別のプロセスが同時に同じ slug を取っても、相手のプロジェクトを消さない。取られていたら次の `_2` `_3` を試す）。静的版のバックアップ日時（`backup:<slug>`）は、ルーターが返した `done()` を `saveDownload` がダウンロード開始後に呼んで記録する。`onblocked` で拒否した後に開けた IndexedDB の接続は閉じる | 失敗した作成で slug が使われたままにならない。書き出しに失敗したのに「バックアップ済み」と表示しない。使われない接続が他のタブの更新を止めない |
| D-22 | 採用 | 静的版で手元の PDF を資料にするときは、選んだ PDF をルーターのメモリ（`DRAFTS`、server.py と同じ名前）に置いておき、`POST /mapping` で確定するときに、IndexedDB の `files`（`[slug, name]` の Blob）への書き込みとプロジェクトの `source`・`offset`・`anchors` の更新を**1つの readwrite トランザクション**で行う（`LocalStore.updateProject` の mutate が `{put, remove}` を返す）。置き換えた資料の古い PDF は同じトランザクションで消す。PDF からの新規作成（`POST /new-pdf`）も、プロジェクト・原文・PDF（`source.pdf`）を `createProject` の1つのトランザクションで書く。容量不足（`QuotaExceededError`、同期の例外もコミット時のエラーも）は 507 と日本語の案内になり、トランザクションが中断されるので、プロジェクトも PDF も変わらない（確定前の選択はメモリに残るので、空きを作ってからやり直せる）。トランザクションの `onerror` はリクエストの `error` も見る。`source` の形は server.py が書くものと同じ（`type`・`file`・`title`・`count`・`revision`）。ページ数は画面が pdf.js で数えて `X-Page-Count` で渡す（server.py も同じ値を信用する） | サーバーは確定前にもファイルを書くが、ブラウザの容量は限られるので、確定するまで保存しない。保存の途中失敗でプロジェクトが半端な状態にならない |
| D-23 | 採用 | PDF の表示：`image` の `pdf` に、Blob の object URL を入れる（http 版は `/api/projects/<slug>/files/<name>?v=…`）。URL は `slug/name` ごとにルーターが1つだけ作って使い回し（ページ移動のたびに PDF を読み直さない）、付け直し・確定・資料の置き換え（古い PDF の URL）・未確定の資料の選び直しや破棄で手放す。手放した URL（`forget`）はルーターが `retired` に積み、各ルートの終了時に、画面が `LocalRouter.setReleaser` で登録した関数へ渡す（`app.js` は pdf.js の文書を `destroy` してから `URL.revokeObjectURL`）。pdf.js の文書は Blob 全体をメモリに持つので、URL を失効させるだけでは足りず、文書の破棄が要る。未確定の資料（`DRAFTS`）は、設定画面のキャンセル・「資料を選び直す」・設定画面以外への移動で `LocalRouter.clearDrafts` が捨てる（`clearDrafts(slug)` はその slug の分だけ残す）。画面（`routeNow`）は、ルートが変わるたびに、ほかのプロジェクトや一覧・新規作成へ移るなら読み込み済みの文書をすべて解放して `LocalRouter.revokeUrls()` で URL を失効させ、同じプロジェクトの中なら `LocalRouter.urlsOf` が返す「いまの資料の URL（設定画面では未確定の分も）」以外の文書を解放する。ブラウザ検証は `pdfDocs` の数を数える（確定後・置き換え後・選択とキャンセルを3回繰り返した後も 1、一覧へ戻ると 0）。`files/<name>` の GET と Range は持たない。CSP は変えない（`connect-src blob:`・`worker-src blob:`・`img-src blob:` は D-14 で許可済みで、pdf.js のワーカーは `'self'`） | pdf.js は Blob の URL を直接読める。URL を残すとメモリが解放されない |
| D-24 | 一部置き換え済み（IA の資料の扱い → D-28） | バックアップから戻した PDF の資料（`source.file` はあるが Blob が無い）：校正画面は開き、`image` は `{pdf: null, no_file: true, …}` を返す。画像の欄に「このブラウザにありません。元のPDFを選び直してください」とファイル選択を出し、選ばれた PDF のページ数が `source.count` と違えば `confirm` で確認してから、ブラウザ版だけの `POST /api/projects/<slug>/source/pdf/attach` で同じ名前の Blob として保存する（project は変えない）。設定画面（資料の対応付け）にも同じファイル選択を出し（対応は変えない。確認済みで別のページ数なら選び直したあとに対応の画面を描き直す）、選ばれた PDF のページ数が記録と違い、利用者が確認したときは、付け直しと同じトランザクションで `source.count` を直し `source.revision` を新しくする（`LocalStore.attachFile` の `{count, revision}`。画像の key は revision から作るので、別の PDF が同じ key にならない。`offset`・`anchors` は保つ）。【置き換え済み → D-28】IA の資料はブラウザ版では画像を取得せず、プロジェクトは開く。`image`（`image` ルートも `pages/<i>` の `image` も）は server.py の `image_for` と同じ `index`・`key`・`count`・`label`・`link`（範囲外は `index`・`missing`・`count`）だけを返し、`url`・`service`・`w`・`h` は無い。画面は画像の欄に「ブラウザ版では表示できません」と出し、画像が無いままずらして対応を壊さないよう、校正画面の ◀▶ と設定画面の対応の操作（−10・−1・+1・+10・画像の番号・確定）を無効にする（検索・書き出し・本文の編集は使える）。共通の事例は `tests/fixtures/source/ia-ops.json`（Python の出力を正とする `ia-expected.json`。`url` は置き換えて比べる）。設定画面の IA の検索欄は隠し、PDF のアップロードだけを出す（ここまで置き換え済み → D-28。PDF の付け直しの部分は有効） | 読み込んだだけでは画像が出ないことを隠さず、PDF を付け直せば元の状態に戻せる |
| D-25 | 採用 | `local/draft.js` は `importers/draft.py` の `build` の移植（`Draft.build(metadata)` が `[fetched, details]` を返し、不正なら例外）。数値は Python の `int()` に合わせる（整数・小数は切り捨て・ASCII 以外の Unicode の数字も可、`null`・配列・空文字・`1.5` の文字列は拒否）、文字列は `str().strip()`（`null` は `None` という文字列）。ルーターは例外をすべて server.py と同じ「書名、PDFの対象範囲、巻と印刷ページ番号を確認してください」にし、PDF の先頭が `%PDF` でないときは「500 MB以下のPDFを選択してください」。500 MB を超える本体は、`new-pdf`・`source/pdf`・`source/pdf/attach` のどれも server.py の `body()` と同じ 413「送信データが大きすぎます（上限500 MB）」（ちょうど 500 MB は通る）。`str(None)` に当たる値は `Draft.pyStr` で `None` にし、画像の key の元になる `revision` が `null` のときも `ia:None:<idx>` と、Python の `src.get('revision', …)` と同じに数える（キーが無いときだけ `id`、さらに `file` に落ちる）。共通の事例は `tests/fixtures/draft/`（Python の出力を正とする `expected.json`。URI はランダムなので形だけ確かめて置き換える）。資料の経路（`source/pdf`・`mapping`・`image`・ページの `image`）は `tests/fixtures/source/ops.json` の手順を Python（`test_source_parity.py`）と Node（`router.test.js`）で再生して、応答の形・キー（sha256）・エラーを突き合わせる | 同じ入力が両方の版で同じプロジェクトになる |
| D-26 | 採用 | 静的版と server.py の**成功時**の応答は上の事例で一致させるが、**エラー時**は完全には一致しない。違いは次のとおりで、メッセージの一致を保証しない：(1) 整数でない `X-Page-Count`・`offset`・`anchor` は、server.py では `int()` が例外を投げて 500、静的版は 400「整数で指定してください」。(2) `new-pdf` の `filename` が文字列でないとき、server.py は値をそのまま `title` にし、静的版は `source.pdf`。(3) 本体の大きさは server.py が Content-Length で先に 413 にし、静的版は Blob の `size` で同じ 413 にする（本体を読まない点は同じ）。(4) `source/pdf/attach` は静的版だけの経路。(5) OCR・`files/<name>`・`scan/<idx>`・`POST source/ia/pdf`（サーバー側のダウンロード）は 501 のまま（`source/ia`・`ia/search`・`source/ia/pdf` の GET・`attach`・`detach` は段階2で対応 → D-28・D-30）。検証メッセージを server.py と揃えるのは、事例に載せたものだけ。(6) IA の `image` の `unavailable`（別のホストの `service`）はブラウザ版だけ（D-31） | 成功時の一致を保ちつつ、エラーの文言まで一致するとは言わない |
| D-27 | 採用 | 段階2の範囲（[IA の CORS の確認結果](#ia-の-cors-の確認結果2026-11-16)による）：静的版は IA の**検索**（`advancedsearch.php`）、**資料情報**（`/metadata/<id>`）、**IIIF マニフェスト**、**IIIF のページ画像**をブラウザから直接取得する。BookReader の画像（`archive.org/download/<id>/page/…`）と PDF（`archive.org/download/<id>/<file>`）は 302 の転送に CORS の許可が無く取得できないので、IIIF が失敗したときの予備の経路は静的版には無く、PDF は利用者がダウンロードしたファイルを選ぶ（1b の付け直しと同じ経路）。IIIF は 504 を返すことが多く、エラー応答には CORS のヘッダーが付かないため、ブラウザでは CORS の拒否と区別できない（`Failed to fetch`）。数秒おきに数回再試行し、それでも失敗したら「IA の画像サーバーが応答しません。時間をおいて試すか、ローカル版を使ってください」と表示する。サムネイル（`/services/img/<id>`）は `<img>` での表示だけに使う | 取得できるものだけをブラウザ版に移し、取得できないものは利用者の操作（ダウンロードとファイル選択）か、ローカル版に任せる |
| D-28 | 採用 | 段階2の実装：`local/sources.js`（名前空間 `Sources`）が `sources.py` の `ia_pages`・`ia_pdf`・`ia_search`・`ia_image_url` と同じ結果を返す（取得は `Sources.getJson`、解釈は `parseManifest`・`pdfChoice`・`parseSearch` の純粋な関数）。ルーターは `GET /api/ia/search`、`POST /api/projects/<slug>/source/ia`（server.py の `stage` と同じに、確定（`mapping`）まで脇に置く。`DRAFTS` の `blob` は null）、`GET source/ia/pdf`（`available` は `pdfChoice`、`job`・`pending`・`mismatch` は常に空、`attached` は Blob があるときだけ）、`attach`・`detach` を持つ。`image`（`image` ルートもページの `image` も）は server.py の `image_for` と同じ項目（`service`・`w`・`h` を含む）に、ブラウザ版では `url` として IIIF のページ画像の URL（`ia_image_url(service, 1600)`）を直接入れる（サーバーの `/scan/<idx>` の代わり。`<img>` が読むだけで、バイト列は取得しない）。`pdf_file` があり Blob もあれば `pdf`（object URL、D-23）、Blob が無い（バックアップから戻した）ときはオンラインの `url`（D-11）。資料を切り替える `mapping` は、置き換える資料の PDF（`pdf_file`）の Blob も同じトランザクションで消す。D-24 の「IA の資料は画像を出さず、対応を動かせない」は置き換え：校正画面の ◀▶ と設定画面の対応の操作は IA でも使え、IA の検索欄・識別子欄の `needs-server` は外した。ブラウザ版の設定画面は、開いた時点で候補の識別子が Internet Archive に伝わること（候補のサムネイル `services/img/<id>`、IA の資料では PDF の情報のための `/metadata/<id>`）と、検索語は「検索」を押したときだけ送られることを明記する（開いただけでは検索しない。ローカル版は題名と著者から自動検索する）。マニフェストの canvas は、`service` の id が文字列でない・空のものを飛ばす（`sources.ia_pages` も同じに揃えた。以前は Python だけ `None` を残し、`None/full/…` という壊れた画像 URL になった）。検索結果の `imagecount` は整数のときだけ表示し、`esc()` も通す。共通の事例は `tests/fixtures/ia/`（合成した IA の応答。Python の出力を正とする `expected.json`）で、Python（`test_ia_parity.py`）と Node（`sources.test.js`）が突き合わせる。`ia-ops.json` の期待値は `service`・`w`・`h` を含み、`url` だけがプレースホルダー | 取得できる経路（D-27）だけで、校正画面と対応付けが IA でも使える |
| D-29 | 採用 | 失敗への対応：マニフェストの取得は、ネットワークの失敗と 5xx を `Sources.retry`（3回、3秒おき）で再試行し、だめなら D-27 の案内（`Sources.UNAVAILABLE`）を出す。404 などは再試行しない。検索・資料情報は1回だけ試す（失敗は `Internet Archive に接続できませんでした…`）。ページ画像（`<img>`）は `onerror` で `Sources.retry.delay` おき、最初と合わせて4回まで読み直し、だめなら同じ案内と「再試行」を出す（ローカル版は従来どおりサーバーの予備の経路の結果をそのまま表示する）。BookReader への予備の経路は、ブラウザ版には無い。次ページの先読みはしない（IA への余分な要求を増やさない）。**バイト列の取得と Cache API は段階3（OCR は画像のバイト列が要る）まで見送り**、`scan` のディスクキャッシュに当たるものは当面作らない（ブラウザの HTTP キャッシュに任せる）。テストは `Sources.retry.delay` を短くする | 504 が多い IIIF でも、利用者が手で再読み込みせずに済む。キャッシュの設計は、実際に画像を読む段階3で決める |
| D-30 | 採用 | IA の PDF：ブラウザは `archive.org/download/…` を取得できない（D-27）ので、`GET source/ia/pdf` は資料情報から選んだ PDF（`sources.ia_pdf` と同じ選び方：公開のものだけ、形式の優先順、同順位は大きいもの）の名前とサイズを返すだけで、画面は名前・サイズと `https://archive.org/download/<id>/<name>` へのリンク（`target="_blank" rel="noopener"`）、「ダウンロードしたPDFを選ぶ」ファイル選択を出す。サーバー側のダウンロード（`POST source/ia/pdf`）は 501 のままで、画面にも出さない。選ばれた PDF は、ブラウザ版だけの本体つきの `POST source/ia/pdf/attach`（Blob の本体と `X-Revision`・`X-Page-Count`。サーバーの同じ URL は保存済みのファイルを JSON で結び付ける）で、`%PDF`・500 MB（413）・ページ数が資料の画像数と同じか（違えば拒否し、何も保存しない。server.py は一致しないファイルを消す）・資料の revision を確かめてから、`files` への保存と `source.pdf_file`（`ia-<revision>.pdf`、server.py と同じ名前）を `updateProject` の1つのトランザクションで書く。`detach` は `pdf_file` と Blob を同じトランザクションで消す（server.py はファイルを残す）。PDF の資料の付け直し（D-24）と違い、ページ数が違う PDF を確認して使う道は無い（画像の数は IIIF の枚数で決まっているため） | ブラウザで可能な範囲で、ローカル版と同じ「PDF があれば PDF を表示する」状態にする。ブラウザの容量は限られるので、使わない PDF は残さない |
| D-31 | 採用 | ブラウザ版だけの制限：IA の資料の `image` に `url`（IIIF の画像）を付けるのは、`service` が `https://iiif.archive.org/` で始まるときだけ。それ以外のホスト（バックアップや外部の応答に別のホストが書かれていた場合）は `url` を付けず、`unavailable`（`Sources.FOREIGN_SERVICE`：「このページの画像の取得先が Internet Archive の画像サーバーではないため、ブラウザ版では表示できません。ローカル版を使ってください」）を返し、画面はこの文言だけを出す（再試行は無い。CSP の `img-src` が許す範囲とも合わせ、別のホストへ要求しない）。`pdf_file` の Blob があれば従来どおり `pdf` が優先される。server.py の `image_for` はこの絞り込みをせず（`service` を含む項目は同じ）、`unavailable` はブラウザ版だけの項目なので、成功時の一致（D-26）の対象は `iiif.archive.org` の資料。共通の事例（`tests/fixtures/source/ia-ops.json`）の `service` は `iiif.archive.org` にし、別のホストの扱いはルーターのテストだけで確かめる | 取り込んだ資料の `service` は信頼できないので、ブラウザが任意のホストへ画像を取りにいかない。再試行の後の「応答しません」という誤った案内も避ける |
| D-32 | 採用 | D-7 のうち「資料が無い画像欄を隠す」「作成後に校正画面へ直行する」を置き換える（段階2でブラウザ版にも資料が選べるようになったため）。ブラウザ版でも、OpenITI の URI・テキストのアップロード・資料の無いバックアップから作った直後は `#/p/<slug>/setup`（ローカル版と同じ）へ進む。資料の無いプロジェクトの校正画面は開く（復元したプロジェクトに資料が無いことがあり、編集は続けられる）が、画像欄は隠さず、「ページ画像の資料がまだ設定されていません。」と設定画面へのボタンを表示し、◀▶・拡大縮小・原本リンク・画像の情報は隠す。資料のあるバックアップは従来どおり先頭ページへ。ローカル版の動作は変えない | 資料の選び方が分からないまま本文だけの画面になる問題の解消 |
| D-33 | 採用 | PDF.js の補助データ（`vendor/pdfjs/6.5.438/` の `wasm/`・`iccs/`・`standard_fonts/`、合計約1.3 MB）を同梱し、`getDocument` に `wasmUrl`・`iccUrl`・`standardFontDataUrl` を `document.baseURI` で解決した絶対 URL（末尾 `/` 必須）で渡す（両方の版、Pages のサブパスでも動く）。背景：スキャン本の PDF は画像が JPEG 2000（JPXDecode）や JBIG2 のことが多く、PDF.js 6 はそのデコーダー（`openjpeg.wasm`・`jbig2.wasm`）と、ICC 色変換（`qcms_bg.wasm`・`iccs/`）を `wasmUrl` から取得する。無いと画像の読み取りに失敗した警告だけで描画が「成功」し、白紙の canvas になる（エラーは出ない）。同梱しないもの：`cmaps/`（1.7 MB。日本語・中国語・韓国語の定義済み CMap 用で、アラビア語の本には不要）、`quickjs-eval.*`（PDF 内のスクリプト用。`isEvalSupported: false` と同じ方針）、`*_nowasm_fallback.js`（WebAssembly の無い環境用。現在のブラウザには不要）。CSP：wasm は PDF.js の worker（同じオリジンの別スクリプト）の中で読み込まれ、`<meta>` の CSP は適用されず、Chromium で違反が出ないことをテストで確かめたので `'wasm-unsafe-eval'` は足さない。サーバーは `.wasm` を `application/wasm`、`.pfb`・`.icc` を `application/octet-stream` で返す。画像を含むページが全面同じ色で描画されたとき（全画素を調べるので、ページ番号だけのようなまばらな文字は白紙とみなさない）は、止めずに canvas を出したまま「画像が真っ白です。PDFの画像を読み取れていない可能性があります（白紙のページなら問題ありません）」と注意を出す（設定画面のプレビュー・校正画面。OCR は確認ダイアログを出し、了承すれば続ける。白紙の裏ページもあるため、エラーにはしない）。デコーダー無しの状態は `PDF_NO_ASSETS` を立てるテスト用の入口で作る。読み込み中は「読み込み中…」を表示する。検証は JPEG 2000 の合成 PDF（`tests/fixtures/pdf/page.jp2`、922 バイト）。まばらな文字・白紙・デコーダー無しの JPEG 2000 の各ページの扱いも両方のブラウザ検証で確かめる。JBIG2 は合成できなかったので未検証 | 実際の PDF で画像が白紙になる不具合の解消。必要なデータだけを同梱してリポジトリの増加を抑える |
| D-34 | 採用 | プロジェクトの削除（両方の版）。ホームの各行の「削除」で `<dialog>` を開き、プロジェクトと全作業データ（修正・メモ・確認済み・保存履歴・OCR 結果・保存した PDF・画像、ブラウザ版では最後のバックアップの日時）が完全に消え元に戻せないこと、先にバックアップを書き出すことをお勧めする旨を示し（ダイアログからバックアップを書き出せる）、「削除」と入力するまで「完全に削除する」を押せない。キャンセル・Esc では何も消さない。`DELETE /api/projects/<slug>`：ローカル版は `store.delete_project`（`_dir` で検証し、symlink と ROOT の外は拒否、フォルダーを先に `.deleting-*` へ改名してからすべて削除。分割結果のキャッシュ・`DRAFTS`・PDF の状態も消す）。応答は `{deleted: slug}`、無ければ 404。`do_DELETE` は他のメソッドと同じ `dispatch` を通り、Origin／Host の検証（D-18）が適用される。ブラウザ版は `LocalStore.deleteProject` が `projects`・`originals`・`pages`・`files`・`settings`（`backup:<slug>`）を1つの readwrite トランザクションで消し（途中で失敗したら何も消えない）、ルーターが未確定の資料・object URL・pdf.js の文書を手放し、BroadcastChannel で `{slug, deleted: true}` を通知する。ほかのタブは、一覧なら更新し、そのプロジェクトを開いていれば一覧へ戻って知らせる。削除ダイアログは画面を離れると消える。後始末と競合：ローカル版の削除先の `.deleting-*` は一覧・`_dir`・slug の作成から除外し、`rmtree` の失敗は成功として扱って記録だけ残し、起動時に残りを掃除する。削除が終わった後に戻ってきた遅い要求（IA 画像の取得・PDF 情報の取得）は、`store.ensure_dir` が既存のプロジェクトの中にだけフォルダーを作るので、削除済みのフォルダーを作り直さず 404 になる。動作中の PDF ダウンロードは、削除で job が消えると次の受信で止まる。Windows でファイルが開かれていて改名できないときは、何も変えずに 409「PDFのダウンロード中または表示中は削除できません…」。ブラウザ版の `savePage` は同じトランザクションでプロジェクトの存在を確かめ（無ければ 404）、`createProject`・`importBundle` は同じ slug に残ったページ・ファイルを念のため消す | 取り返しのつかない操作なので、確認とバックアップの案内を挟む。削除後にデータが残らないことを、両方の版のテストで確かめる |
| D-35 | 採用（段階3）。実装の詳細は D-43 で確定（SDK の同梱方法・認証ヘッダー・エラーの型。OpenAI は未実装のまま Q-8） | OCR の呼び出し：Anthropic は公式の TypeScript SDK（`@anthropic-ai/sdk`）を版を固定して `vendor/` に同梱し（PDF.js と同じく ESM、ビルドなし、sha256 を記録）、`new Anthropic({apiKey, dangerouslyAllowBrowser: true})` で呼ぶ（SDK がブラウザからの直接呼び出し用のヘッダー `anthropic-dangerous-direct-browser-access` を付ける）。要求の内容は `ocr.py` の `transcribe` と同じにする：`client.beta.messages.create`、`max_tokens: 16000`、`output_config: {effort: 'medium'}`、画像（base64）＋共通のプロンプト、Haiku 以外は `betas: ['server-side-fallback-2026-07-01']`・`fallbacks: 'default'`。`stop_reason` が `refusal` なら「このページは読み取りを断られました」、`max_tokens` なら `truncated`。エラーは型（認証・上限・接続など）ごとに `ocr.py` と同じ日本語にする。OpenAI は `providers/openai.py` と同じ Responses API の要求を `fetch` で送る（Python 版も SDK を使っていない）。OpenAI はブラウザからの呼び出し（CORS）を確かめてから足す（Q-8 の決定。それまでブラウザ版の提供元は Anthropic だけ） | 公式 SDK の型付きのエラー処理と再試行を使い、ローカル版と同じ読み取り結果になる要求を送る |
| D-36 | 採用（段階3） | API キーの扱い：ホームの「AI の設定」で利用者が入力する。既定は**このタブの中だけ**（メモリに置き、再読み込みで消える）。「このブラウザに保存する」を選んだときだけ IndexedDB の `settings`（`key:anthropic`・`key:openai`）に置く。保存するときは、同じブラウザを使える人・拡張機能・万一の XSS から読まれうること、利用料が発生することを示す。キーはバックアップ・`prefs`（localStorage）・ログ・エラー表示に含めない。「キーを消す」で消せる（プロジェクトの削除ではキーは消さない）。案内として、Console で専用のキーを作り、ワークスペースの利用上限を設定することを勧める | 静的サイトにはキーを隠すサーバーが無いので、置く場所と期間を利用者が選べるようにし、既定は最も残らない形にする |
| D-37 | 採用（段階3）。実装は D-43 で確定（5 MB の上限の扱い、PDF の画像形式） | 送る画像：IA は IIIF の画像を幅 2000 で `fetch`（CORS 可、D-27）し、`Sources.retry` で再試行する。取得先は `https://iiif.archive.org/` に限る（D-31）。PDF は今のローカル版と同じく、`renderPdfPage` で幅 2000 に描いた canvas を JPEG（品質 0.9）にする。白紙の注意（D-33）が出たページは確認してから送る。API の画像の上限（大きさ・辺の長さ）は実装時に公式文書で確かめ、超えるときは縮小する。画像のキャッシュ（Cache API）は作らない（読み取り結果を保存して再利用するので、同じ画像を何度も取りに行かない。D-29 の見送りを確定） | ローカル版と同じ条件の画像を送り、結果を比べられるようにする |
| D-38 | 採用（段階3）。実装は D-43 で確定（「現在の読み」の決め方、識別子） | 読み取り結果の保存：IndexedDB の版を 2 に上げ、`ocr` ストア（キー `[slug, i, reading_id]`、`[slug, i]` の索引）を作る（v1 からの移行は空のストアを作るだけ）。1件の形は `ocr/<i>.json` と同じ（`text`・`model`・`provider`・`requested_model`・`prompt_version`・`truncated`・`usage`・`image_index`・`image_key`・`reading_id`・`time`）。ページの「現在の読み」は、その画像の `image_key` に合う最新の1件。ルートは `POST pages/<i>/ocr`（`image_key` の照合・同じ条件ならキャッシュを返す・`force`）と `GET pages/<i>/readings` を `server.py` と同じ形で `local/router.js` に足す。読み取り中に対応が変わったら保存せず 409。プロジェクトの削除（D-34）は `ocr` の範囲も同じトランザクションで消す | ローカル版と同じ「再利用・過去の読み・画像との照合」をブラウザ版でも保つ |
| D-39 | 採用（段階3）。実装は D-43 で確定（確認の文言と回数、使用量の表示） | 費用と実行の原則：1ページずつ、利用者がボタンを押したとき（または設定 `autoOcr` を有効にしてページを開いたとき）だけ読む。全ページの一括読み取りは作らない。最初の読み取りの前に、モデル名と「1ページごとに利用料がかかる」ことを確認する。読み取り後は使ったトークン数（`usage`）を表示する。料金表は持たない（変わるため）。既定のモデルは `ocr.py` の `MODEL`、選べるモデルは `MODELS` と同じ | CLAUDE.md の OCR の原則をブラウザ版にもそのまま当てはめる |
| D-40 | 採用（段階3） | プロンプトとモデルの共有：`local/ocr.js`（名前空間 `OCR`）に `PROMPT`・`PROMPT_VERSION`・`MODEL`・`MODELS`・`NO_FALLBACK` を置き、Python のテストで `ocr.py`・`providers/__init__.py` の値と一致することを確かめる（`HISTORY_*` と同じ方式）。プロンプトを変えるときは両方を同じ PR で直す | 2つの版で読み取りの条件がずれない |
| D-41 | 採用（段階3） | CSP：`connect-src` に `https://api.anthropic.com` を足す（OpenAI を足すときに `https://api.openai.com`）。SDK は同梱するので `script-src` は変えない。テストは `page.route` で API への要求を差し替え、有料の API は呼ばない（要求のヘッダー・本文の形、キーがバックアップや localStorage に入らないこと、拒否・上限・認証エラーの表示、`image_key` の照合、IndexedDB v1 → v2 の移行を確かめる） | 必要な接続先だけを許し、テストで課金しない |
| D-42 | 採用（段階3）。形式の詳細は D-43 で確定（`ocr` の形、検証、書き出しの規則） | バックアップに OCR の読み取り結果を含める（Q-2 の決定。D-11 の「OCR を含めない」を置き換え。PDF は引き続き含めない）。`ocr` に、ページごとの現在の読みと過去の読み（`ocr/<i>.json` と `ocr/history/<i>/` と同じ形）を入れる。`ocr` を含むバックアップは `format_version` を 2 にし、含まないものは 1 のまま書く。古い版のアプリは 2 を「新しい版のデータ」として拒否するので、OCR が黙って落ちることはない。読み込みでは `image_key`・`reading_id`・`time` などの型を検証し、両方の版（`bundle.py`・`local/bundle.js`）で同じ事例（`tests/fixtures/bundle`）に通す。API キーは決して含めない | 文字だけで小さく、利用料を払って得た結果を、環境を移しても失わない |
| D-43 | 採用（段階3の実装） | 段階3の実装で確定したこと。(1) **SDK**：`@anthropic-ai/sdk` 1.4.0（公開から2週間以上。`fallbacks: 'default'`・`betas`・`output_config` を受け取ることを型定義と実際の要求で確かめた）を `vendor/anthropic-sdk/1.4.0/` に置く。SDK の `.mjs` は `@opentelemetry/api` などを裸の指定子で import するが、ブラウザは import map（インラインのスクリプト）なしでは解決できず CSP が許さないので、`index.mjs` から到達する 294 モジュール（約 1.3 MB）をそのままコピーし、import の指定子だけを書き換えた（`@opentelemetry/api` は同梱した `_deps/opentelemetry-api/`、Node 用の `node.mjs` はパッケージ自身の `browser` フィールドが指す `node.browser.mjs`、`standardwebhooks` は使わない部分なので何もしない代用品）。手順は `vendor/anthropic-sdk/assemble.py` と README、ファイルごとの sha256 は `SHA256SUMS`。最初の読み取りのときだけ `import()`（`document.baseURI` 基準）で読み込む。APIキーは SDK が `Authorization: Bearer` で送る。エラーは SDK の型（`AuthenticationError`・`RateLimitError`・`APIConnectionError`・`APIError`。JS の SDK に `APIStatusError` は無い）で `ocr.py` と同じ日本語にする（認証の文言だけ「AI の設定でキーを確認してください」）。(2) **画像**：IA は IIIF を幅 2000 で取得し（再試行は `Sources.getBytes`、取得先は `iiif.archive.org` のみ）、PDF は画面が canvas から作った JPEG（白紙の注意の確認つき）の data URL を送る（ローカル版と同じ）。API が受け取る画像は1枚 5 MB までなので、超える画像は縮小せず 413 の案内を返す（幅 2000 の JPEG では通常超えない。公式文書での上限の再確認は未実施）。(3) **保存**：`LocalStore.ocrPut` がプロジェクトの存在を同じトランザクションで確かめて書く。「現在の読み」は**その画像の `image_key` に合う最新（時刻、同時刻は識別子）の1件**。ローカル版は `ocr/<i>.json`（最後に書いた1件）が現在の読みなので、対応を別の画像へ動かして戻すと、ローカル版は出さず、ブラウザ版は前の読みを出す（意図的な違い）。識別情報のない旧形式の読み（Python のバックアップから戻したもの）は、IA の資料で画像番号が同じときだけ `legacy` として出す。ブラウザ版の識別子は時刻（ミリ秒）で始まる32桁の16進で、このタブでは必ず増える（同じ秒に2回読んでも順序が読んだ順になる）。(4) **キー**：ルーターに `GET/PUT/DELETE /api/ai/keys[/anthropic]`（ブラウザ版だけ。値は返さない）。入力は半角の印字可能文字 8〜500 字。メモリに置き、`save: true` のときだけ IndexedDB の `settings`（`key:anthropic`）にも書く。保存を外して設定し直すと保存した分も消す。保存したキーは新しいタブが最初に必要としたときに読み込む。タブ間でメモリのキーは共有しない（ほかのタブでのキーの変更は、再読み込みするまで反映されない）。(5) **画面**：ホームの「AI の設定」とOCR欄の「AI の設定」から同じダイアログ（`aiSettings`、パスワード欄・「このブラウザに保存する」・説明・「キーを消す」）を開く。キーは入力したらすぐ欄から消し、画面・エラー・トーストには出さない。タブごとの最初の読み取りの前に、モデル名と「1ページごとに利用料がかかります」を `confirm()` で確かめ（キャンセルしたら何もしない）、`autoOcr` も同じ確認を通り、キーが無ければ動かない。読み取り後は入力・出力のトークン数を表示する。「比較の設定」メニュー（`autoOcr` を含む）もブラウザ版に出す。(6) **バックアップ**：`ocr` は `{"<ページ番号>": {"current": 読み, "history": [読み…]}}`（`current` は省略可、`history` は古い順の全部）。読みは `ocr/<i>.json` と同じ形で、既知の項目（`text`・`model`・`provider`・`requested_model`・`prompt_version`・`truncated`・`usage`・`image_index`・`image_key`・`reading_id`・`time`）だけを型を確かめて取り込む（`reading_id` は `[A-Za-z0-9_-]{1,64}`、`time` は `YYYY-MM-DDTHH:MM:SSZ`、`history` の読みは `reading_id` が必須、同じページで大文字小文字を無視して重複したら拒否）。`format_version` は読みがあるとき 2、無いとき 1（`FORMAT_VERSION = 2`、`BASE_VERSION = 1`。1 に `ocr` があっても読む）。書き出しでは、このアプリが作らない形の読みは外す（バックアップが読めなくならないように）。`export?fmt=bundle&ocr=0` は OCR を含めない（画面には出さない）。ローカル版の読み込みは `store.install` の中で `ocr/<i>.json` と `ocr/history/<i>/<reading_id>.json` を書く（失敗したら既存の後始末でフォルダごと消える）。`bundle.parse` は `(project, text, work, ocr)` を返す。ブラウザ版は `ocr` ストアへ同じトランザクションで書く（current が履歴に無ければ足し、識別子が無い旧形式は履歴と重ならない `legacy`・`legacy_2`…。ローカル版は識別子の無い current を `ocr/<i>.json` だけに書き、次の読み取りで新しい名前の履歴へ移す）。(7) **追補（2026-11-17）**：識別子のある current が履歴に無いときは、ローカル版も `ocr/history/<i>/<reading_id>.json` に書く（次の `ocr_put` で失われず、読みの一覧に出る）。`reading_id` は Windows の装置名（CON・PRN・AUX・NUL・COM1〜9・LPT1〜9、大文字小文字を問わない）も拒否する（両方の版、`tests/fixtures/bundle`）。ブラウザ版が作る識別子は16進32桁なので該当しない。画像の 5 MB の上限は base64 にした大きさ（`ceil(n/3)*4`）で見る。「このタブだけ」でキーを設定するときは、保存済みのキーの有無を問わず IndexedDB の保存分も消す。キーを変えても、すでに開いている他のタブには再読み込みまで反映されない（AI の設定の画面にも書く） |

## 段階と状態

| 段階 | 内容 | 状態 |
|---|---|---|
| 1a | ホーム、OpenITI の URI からの作成、テキストのアップロード、校正（本文・完了・注記）、revision による競合検出、保存履歴と復元、検索、書き出し（OpenITI テキスト・注記 CSV・TEI）、バックアップの書き出し・読み込み、CSP、GitHub Pages への配信 | 完了（#5）。`local/{openiti,work,bundle,tei,store,router}.js`・`backend.js`・`mode.js` で、ブラウザだけで動く。ローカル版にもバックアップの書き出し・読み込みを追加 |
| 1b | 手元の PDF を資料にする、ページの対応付け、PDF の選択範囲からの仮本文（`importers/draft.py` の移植） | 完了（#5）。`local/draft.js`、`files` への PDF の保存（D-22）、画像の表示（D-23）、PDF の付け直し（D-24）、エラー時の違い（D-26） |
| 2 | Internet Archive 連携（検索、資料情報、IIIF マニフェスト、ページ画像。PDF は利用者がダウンロードして選ぶ） | 完了（#6）。`local/sources.js`、ルーターの IA 経路（D-28）、再試行と案内（D-29）、PDF のリンクと選択（D-30）、CSP の `connect-src`（D-14）。CORS の確認は D-27 |
| 3 | OCR（Anthropic をブラウザから直接呼ぶ。キーは利用者が入力。OpenAI は後で足す） | 完了（PR 未作成）。`local/ocr.js`、`vendor/anthropic-sdk/`、IndexedDB 2（`ocr` ストア）、AI の設定、バックアップの `ocr`（format_version 2）。D-35〜D-43 |

状態は「未着手 → 作業中 → 完了」で書き、完了したら対応する PR を併記する。

## 機能の対応表

ローカル版でサーバーが担っている仕事と、静的版での扱い。

| ローカル版 | 静的版 | 段階 |
|---|---|---|
| `store.py`（`projects/` への保存、revision、保存履歴） | `local/store.js`（IndexedDB）と `local/work.js`（純粋なロジック） | 1a |
| `openiti.py`（URI 解決、yml、split/join） | `local/openiti.js` | 1a |
| `exporters/tei.py` | `local/tei.js`（バイト単位で一致、D-12） | 1a |
| `bundle.py`（バックアップの書き出し・読み込み） | `local/bundle.js` と `LocalStore.importBundle` | 1a |
| `importers/draft.py` | `local/draft.js`（D-25） | 1b |
| 手元の PDF の保存（`files/`）、`files/<name>` の配信 | IndexedDB の `files` に Blob で保存（D-22）。表示は object URL（D-23）。バックアップに含めないので、戻したあとは付け直す（D-24） | 1b |
| ページの対応付け（`mapping`）・`image`・資料の設定画面 | `local/router.js`。PDF の資料（1b）と IA の資料（2。画像は IIIF の URL を `<img>` が直接読む、D-28） | 1b・2 |
| `sources.py`（IA の検索・マニフェスト・資料情報・画像 URL） | `local/sources.js`。ブラウザから直接取得し、CORS を返さない経路（BookReader・PDF）は使わない（D-27・D-28）。IIIF の失敗は再試行して案内する（D-29） | 2 |
| `scan` のディスクキャッシュ | 持たない。表示は `<img>` が直接読む。OCR 用のバイト列は幅 2000 で取得して API に送るだけで、キャッシュしない（読み取り結果を保存して再利用するので、同じ画像を取りに行かない。D-37・D-43） | 2 → 3 |
| IA の PDF 保存（`source/ia/pdf`） | 状態の取得・`attach`（利用者がダウンロードして選んだ Blob を保存）・`detach` は対応。サーバー側のダウンロードは 501 で画面にも出さない（D-30） | 2 |
| `providers/`・`ocr.py`（Anthropic） | `local/ocr.js`（プロンプト・モデル・版は Python と同じ値でテストが確かめる）と、公式 SDK の同梱版（`vendor/anthropic-sdk/`）でブラウザから直接呼ぶ。OpenAI は「ブラウザ版ではまだ使えません」と表示（Q-8） | 3 |
| `pages/<i>/ocr`・`pages/<i>/readings`・ページの `ocr` | `local/router.js` に同じ URL・応答の形で。保存は IndexedDB の `ocr`（D-38・D-43） | 3 |
| `.env` の `ANTHROPIC_API_KEY` | 「AI の設定」（ブラウザ版だけのルート `/api/ai/keys`）。既定はタブの中だけ、選んだときだけ IndexedDB（D-36） | 3 |
| `net.ALLOWED` | `<meta>` の CSP `connect-src`（D-14） | 1a で導入。段階2で `archive.org`・`iiif.archive.org`、段階3で `api.anthropic.com` を足した |
| `presence.py`・自動終了・終了ボタン | 使わない（画面から隠す） | 1a |
| `DELETE /api/projects/<slug>`（`store.delete_project`） | `LocalStore.deleteProject` と同じ URL のルート（D-34） | 2 以降 |
| `send_file` の Range 対応 | 使わない（pdf.js が Blob の URL を直接読む） | 1b |

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
    draft.js        PDF の選択範囲からの仮本文（importers/draft.py と同じ入出力）
    sources.js      IA の検索・マニフェスト・資料情報の解釈と取得（sources.py と同じ結果）。再試行と案内の文言
    ocr.js          OCR のプロンプト・モデル・版（Python と同じ値）と Anthropic の呼び出し（同梱 SDK を最初に使うときだけ import）
  vendor/anthropic-sdk/1.4.0/   公式 SDK の同梱版（D-43）。pdfjs/ は PDF.js
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
| `files` | `[slug, name]` | PDF の Blob（名前は `source.pdf` か `source-<uuid>.pdf`）。資料の確定・新規作成・付け直しのときだけ書く | 1b から |
| `ocr` | `[slug, i, reading_id]`（索引 `page` = `[slug, i]`） | 1件の読み取り結果（`ocr/<i>.json` と同じ形に `slug`・`i`）。現在の読みも過去の読みも同じストアに1件ずつ | 読み取りのたび。3 から（IndexedDB の版 2） |
| `settings` | `key` | 利用者ごとの設定：`backup:<slug>`（最後のバックアップの日時）、`key:anthropic`（API キー。利用者が保存を選んだときだけ。プロジェクトの削除では消さず、バックアップにも含めない） | 必要になったとき |

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
  "work": { "edits": {}, "status": {}, "history": {}, "revisions": {}, "schema_version": 2 },
  "ocr": { "0": { "current": { "text": "…", "reading_id": "…", "time": "…" }, "history": [ { "…": "…" } ] } }
}
```

- `exported` は UTC。`app.mode` は書き出した版（`http` か `browser`）、`app.version` は `bundle.py` と `bundle.js` の `APP_VERSION`（テストで一致を確かめる）。
- `work` は `work.json` の形。静的版は ページごとの record と相互に変換する（`Work.recordsToWork` / `workToRecords`）。
- PDF などのファイルは含めない（D-11）。資料の情報は `project` に残り、読み込み後にファイルを選び直してもらう（静的版は D-24 の手順）。**OCR の読み取り結果は `ocr` に含める（D-42・D-43。読みが1件でもあれば `format_version` は 2、無ければ `ocr` を書かず 1）**。API キーは決して含めない。
- 読み込みの規則は D-10。読み込んだプロジェクトは常に新しいプロジェクトとして作られ、既存のプロジェクトを上書きしない。
- 静的版は1つの `readwrite` トランザクション（`projects`・`originals`・`pages`・`ocr`）で書くので、途中で失敗したプロジェクトは残らない。ローカル版は `work.json` の次に `project.json` を書き、`project.json` が無いフォルダは一覧に出ない。

## 形式と版の管理

版番号を持つものは次の4つ。どれも整数で、上げるときは1ずつ上げる。

| 対象 | 置き場所 | 現在 |
|---|---|---|
| プロジェクトの形式 | `project.json` の `schema_version` | 2 |
| 作業データの形式 | `work.json` の `schema_version` | 2 |
| IndexedDB の構造 | `indexedDB.open('proofreader', n)` の `n` | 2（`ocr` ストアを追加。移行は空のストアを作るだけ） |
| 書き出しファイルの形式 | `format_version` | 2（`ocr` を含むとき。含まないバックアップは 1 で書く。両方の版が 1・2 を読み、3 以上は拒否） |

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
| 削除・スキャン PDF | `tests/test_delete.py`（保存先の安全性・Origin 拒否）、`router.test.js`、`browser_smoke.py` と `browser_static_smoke.py`（JPEG 2000 の合成 PDF が描画されること、削除の取り消し・確定・IndexedDB に残りが無いこと） |
| PDF の資料と仮本文 | `tests/fixtures/draft/`（`Draft.build`）と `tests/fixtures/source/`（`source/pdf`・`mapping`・`image` の手順）を、Python（`test_draft_parity.py`・`test_source_parity.py`）と Node（`draft.test.js`・`router.test.js`）が突き合わせる。`browser_static_smoke` が、合成 PDF のアップロード・対応付け・描画（canvas の画素）・再読み込み・バックアップを別のブラウザに戻して付け直し・PDF からの新規作成・容量不足（`IDBObjectStore.put` が `QuotaExceededError` を投げる）で何も変わらないことを確かめる。IA の資料は `ia-ops.json`（`url` だけを置き換える）、退役した URL の解放・`clearDrafts`・別のページ数での付け直し・500 MB の 413・`revision: null` の key は `router.test.js`、コミット時のエラー（`tx.onerror`・`tx.onabort`、偽の IndexedDB）は `store_open.test.js`。ブラウザ検証は pdf.js の文書の数（置き換え・キャンセル・移動のあと）、置き換えで古い Blob が実際の IndexedDB から消えること、設定画面での付け直しを確かめる |
| Internet Archive | `tests/fixtures/ia/inputs.json`（合成した IA の応答：IIIF v3 のマニフェストで service の無い canvas や label の変種を含むもの、PDF の選択の事例（非公開・形式・サイズ）、検索）の `expected.json` は Python の `sources.*` の出力（要求した URL は復号した問い合わせで比べる）。`test_ia_parity.py` と `sources.test.js` が突き合わせ、`sources.test.js` は再試行（5xx・ネットワークの失敗は再試行し 4xx はしない）も確かめる。`router.test.js` は検索・`source/ia`（504 の再試行、確定までの脇置き、`image` の `url`）・`ia/pdf` の状態・`attach`（検証・413・全か無か）・`detach`・バックアップから戻した資料のオンライン画像を、`fetch` を差し替えて確かめる。`browser_static_smoke` は `page.route` で archive.org と iiif.archive.org を合成データで置き換え（実際の接続は無く、PDF のリンクは開かない）、検索・選択・対応付け・画像（`naturalWidth`）・マニフェストと画像の 504 の再試行・止まったままの画像の案内・PDF のリンクと選択（ページ数違いの拒否、描画、再読み込み、`detach`）・バックアップから戻した IA の資料の画像と対応の操作・CSP 違反が無いことを確かめる |
| TEI | `tests/fixtures/tei/inputs.json`（合成入力）の `expected.json` は Python の出力。`tests/test_tei_parity.py` と `tests/tei.test.js` が、`exporters/tei.py` と `tei.js` の出力が一致することを確かめる。CI は `tests/tei_fixtures.js` で `tei.js` の出力をファイルに書き、`tests.validate_tei` で公式スキーマに通す（Python の出力も同じ） |
| OCR（ブラウザ版） | `tests/ocr.test.js`：同梱した SDK を本物のまま読み、`fetch` だけを差し替えて、要求の形（URL・`anthropic-dangerous-direct-browser-access`・`Authorization`・モデル・`output_config`・`fallbacks`・`betas`・base64 の画像・共通のプロンプト）、拒否・切れ・空・認証・上限・接続のエラーの日本語、キーがメッセージに入らないことを確かめる。`tests/test_parity.py` の `OcrParityTests` が `local/ocr.js` と `ocr.py`・`providers/` のプロンプト・モデル・版・要求のパラメーターの一致を確かめる（D-40）。`router.test.js` は、`OCR.transcribe` と画像の `fetch` を差し替えて、キー（既定はタブだけ・保存・削除）、IA と PDF の画像、キャッシュの再利用、`image_key` の 409、読み取り中の対応変更の 409、旧形式の読み、削除、バックアップの往復を確かめる。`store_open.test.js` は偽の IndexedDB で v1 → v2 の移行（ストアを足すだけ）と、新しすぎる版の拒否を確かめる。`browser_static_smoke` は `page.route` で `https://api.anthropic.com` を差し替え（有料の API は呼ばない）、手で作った v1 のデータベースの移行、キーの扱い（DOM・localStorage・IndexedDB）、確認の1回、要求のヘッダーと本文、使用量の表示、再読み込み後の再利用、拒否・401・429・空の読み、`autoOcr`、対応変更の 409、Python との往復、CSP 違反なしを確かめる |
| 書き出しファイル | `tests/fixtures/bundle/cases.json`（受理・拒否の事例と期待値。OCR の読みの型・識別子・時刻・重複・旧形式・形式 3 の事例を含む）を `test_bundle.py` と `bundle.test.js` が確かめる。`python-export.proofreader.json`（Python の出力。OCR の読みを含む）を `browser_static_smoke` が静的版に読み込んで書き戻し（`ocr` も同じ）、静的版が書き出したものを Python が読み込む（BOM・CRLF の往復も含む）。`browser_smoke` はローカル版の書き出し・読み込みを確かめる |

## 配信

- `index.html` などの参照は相対パスにする（GitHub Pages はリポジトリ名のサブパスで配信される）。
- GitHub Actions の `deploy` ジョブが、テストがすべて成功した `main` への push のときだけ `proofreader/static/` を Pages に配信する（D-15）。ジョブの権限は `pages: write`・`id-token: write` に、チェックアウト用の `contents: read` を足したもの。
- CSP を `<meta http-equiv="Content-Security-Policy">` で指定する（全文と理由は D-14）。段階ごとに必要な接続先だけを足し、足した接続先は対応表とこの節に書く（段階3：`https://api.anthropic.com`）。OCR の SDK（`vendor/anthropic-sdk/`、約 1.3 MB・294 モジュール）は最初の読み取りのときだけ読み込まれる。`browser_static_smoke` と `browser_smoke` は、CSP 違反が起きないことと、インラインのスクリプトが実際にブロックされることを確かめる。
- リポジトリが private の場合、Pages の利用には有料プランが必要で、配信されたサイトは公開される。

## 段階3以降の注意（概要）

- **Internet Archive**：エンドポイントごとの CORS の確認結果は下の表のとおり。範囲は D-27、実装は D-28〜D-30。`<img>` での表示は CORS が無くてもできるが、OCR に画像を送るには必要になる（段階3。IIIF の画像は CORS を許可するので、`fetch` でバイト列を取れる。段階3で実装した）。IA の仕様は変わりうるので、ブラウザ版で IA の取得が失敗するようになったときは、同じ手順で確かめ直して表に行を足す。
- **IA の PDF**：ブラウザからは取得できない（下の表）。利用者がダウンロードしたファイルを選ぶ。

### IA の CORS の確認結果（2026-11-16）

Chrome のシークレットウィンドウで `https://example.com/` を開き、開発者ツールのコンソールから `fetch(url, {mode: 'cors'})` で取得した結果。

| 対象 | URL | 結果 |
|---|---|---|
| 検索 | `https://archive.org/advancedsearch.php?…&output=json` | 取得できる（200） |
| 資料情報 | `https://archive.org/metadata/<id>` | 取得できる（200） |
| IIIF マニフェスト | `https://iiif.archive.org/iiif/<id>/manifest.json` | 成功時は取得できる（`ElBoustane`）。504 がよく返り、そのエラー応答には CORS のヘッダーが無いため `Failed to fetch` になる。画像の無い資料（`.7z` など）でも 504・500 になる |
| IIIF のページ画像 | `https://iiif.archive.org/image/iiif/3/<id>%2F…/full/1600,/0/default.jpg` | 取得できる（200、`ElBoustane` の1ページ目で約 420 KB） |
| BookReader の画像 | `https://archive.org/download/<id>/page/n0_w1600.jpg` | 取得できない（302 の応答に `Access-Control-Allow-Origin` が無い） |
| PDF（Range） | `https://archive.org/download/<id>/<file>.pdf` | 取得できない（同上） |
| サムネイル | `https://archive.org/services/img/<id>` | 取得できない（200 だが `Access-Control-Allow-Origin` が無い）。`<img>` での表示はできる |
- **OCR**：設計は D-35〜D-42、実装で確定したことは D-43。API キーは利用者が画面で入力し、ブラウザ内にだけ置く（既定はタブの中だけ）。キーを書き出しファイルに含めない。1ページずつ、利用者の操作で実行するという原則は変えない。**OpenAI（Q-8）はまだ無い**：ブラウザからの呼び出し（CORS）を確かめてから、`https://api.openai.com` を CSP に足し、同じ形で足す。

## 未決事項

| 番号 | 論点 | 選択肢 |
|---|---|---|
| Q-1 | Arabic フォントの配信 | 決定済み（→ D-13）：当面 Google Fonts。同梱は再検討 |
| Q-2 | 書き出しファイルに OCR の結果を含めるか | 決定済み（→ D-42）：既定で含める |
| Q-6 | API キーの既定の置き場所 | 決定済み（→ D-36）：このタブの中だけ。保存は利用者が選んだときだけ |
| Q-7 | 公式 SDK を同梱するか | 決定済み（→ D-35）：同梱する |
| Q-8 | OpenAI をブラウザ版で使うか | 決定済み：Anthropic を先に実装し、OpenAI は CORS を確かめてから足す |
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
| 2026-11-16 | 段階1b を完了（PR 未作成）にした。手元の PDF を資料にする（`files` への保存・object URL での表示・`mapping`・`image`）、バックアップから戻した資料への PDF の付け直し、`local/draft.js` と PDF からの新規作成を静的版に追加。D-22〜D-25 を追記し、機能の対応表とテストの節を更新。トランザクションの `onerror` でリクエストのエラー（容量不足）を拾うようにした |
| 2026-11-16 | 段階1b のレビュー指摘への対応：IA の資料の `image` を server.py と同じ metadata（url なし）にし、画像が無いままの対応の操作を無効にした（D-24）。退役した URL の pdf.js の文書を破棄し、未確定の資料を設定画面の終了で捨てる（D-23）。設定画面でも PDF を付け直せるようにし、確認済みの別のページ数では `count`・`revision` を更新（D-24）。`source/pdf`・`attach` の 500 MB の 413、`revision: null` の key（D-25）。エラー時の違いを D-26 に記録。`LocalStore.run` のコミット時エラーと、置き換えで古い Blob が消えることのテストを追加 |
| 2026-11-16 | 段階1a・1b を #5 でマージ。IA の CORS をブラウザで確かめ、結果の表と段階2の範囲（D-27）を追記 |
| 2026-11-16 | 段階2 を完了（PR 未作成）にした。`local/sources.js`、ルーターの IA 経路（検索・`source/ia`・画像の `url`・PDF の状態・`attach`・`detach`）、IIIF の再試行と案内、CSP の `connect-src` を追加。D-14 を更新、D-24 の IA の部分を置き換え済みにし（→ D-28）、D-26 の(5)を更新、D-28〜D-30 を追記。機能の対応表とテストの節を更新 |
| 2026-11-16 | 段階2 のレビュー指摘（軽微）への対応：検索結果の `imagecount` を整数のときだけ表示、`iiif.archive.org` 以外の `service` は画像を読まず案内を出す（D-31 を追加、D-26 に(6)）、service の id が文字列でない canvas は両方の版で飛ばす（D-28）、設定画面の注意書きを開いた時点の送信に合わせた（D-28）、IA の PDF の付け直しで容量不足のテストを追加 |
| 2026-11-16 | ブラウザ版で資料の無いプロジェクトの扱いを改めた：作成後は設定画面へ進み、校正画面の画像欄には資料の未設定を案内する（D-32、D-7 の一部を置き換え） |
| 2026-11-16 | PDF.js の補助データ（`wasm/`・`iccs/`・`standard_fonts/`）を同梱し、画像を読めなかったページは白紙でなくエラー表示にした（D-33）。プロジェクトの削除を両方の版に追加した（D-34）。テストの節に反映 |
| 2026-11-16 | D-33・D-34 のレビュー対応：白紙の判定を全画素にし、エラーでなく注意の表示にした。削除の失敗時に残る `.deleting-*`・削除と競合する要求・ダウンロードの中止・Windows での 409・ブラウザ版の保存の競合を直した |
| 2026-11-16 | 段階3（ブラウザ版の OCR）の設計を提案として追記した（D-35〜D-41）。Q-2 に案を書き、Q-6〜Q-8 を追加 |
| 2026-11-16 | 段階3の設計を確定した：キーは既定でタブの中だけ（Q-6）、公式 SDK を同梱（Q-7）、OpenAI は後で足す（Q-8）、バックアップに OCR の結果を含める（Q-2 → D-42、D-11 の一部を置き換え） |
| 2026-11-16 | 段階3（ブラウザ版の OCR）を完了（PR 未作成）にした。`local/ocr.js`・同梱した公式 SDK 1.4.0（`vendor/anthropic-sdk/`）・AI の設定（キーの扱い）・IndexedDB 2（`ocr` ストア）・ルーターの OCR 経路・バックアップの `ocr`（format_version 2）・CSP の `api.anthropic.com` を追加。D-14 を更新し、D-35・D-37〜D-39・D-42 の実装を D-43 に記録。機能の対応表・IndexedDB の表・形式と版の管理・テストの節を更新 |
| 2026-11-17 | 段階3のレビュー指摘（軽微）への対応（D-43 (7)）：バックアップの current を履歴にも書く（ローカル版）、キー設定時の保存分の削除、識別子の無い current の `legacy` が履歴と衝突しない採番、画像上限を base64 で判定、Windows の装置名の `reading_id` を拒否、同梱 SDK の README の訂正（JSDoc のコメント2か所も書き換えている・`@opentelemetry/api@1.10.0` を固定） |
