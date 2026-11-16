# 静的ブラウザ版の設計

| 項目 | 内容 |
|---|---|
| 文書の状態 | 提案（実装前） |
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

## 段階と状態

| 段階 | 内容 | 状態 |
|---|---|---|
| 1a | ホーム、OpenITI の URI からの作成、テキストのアップロード、校正（本文・完了・注記）、revision による競合検出、保存履歴と復元、検索、書き出し（OpenITI テキスト・TEI）、バックアップの書き出し・読み込み | 作業中（`local/openiti.js`・`local/work.js` と一致テストまで） |
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
| `exporters/tei.py` | `local/tei.js` | 1a |
| `importers/draft.py` | `local/draft.js` | 1b |
| 手元の PDF の保存（`files/`） | IndexedDB の `files` に Blob で保存 | 1b |
| `sources.py`（IA） | ブラウザから直接取得。CORS を返さない経路は使わない | 2 |
| `scan` のディスクキャッシュ | Cache API | 2 |
| IA の PDF 保存 | 利用者がダウンロードしたファイルを選ぶ方式を基本にする | 2 |
| `providers/`・`ocr.py` | ブラウザから直接呼ぶ。プロンプトは共通の定義を使う | 3 |
| `net.ALLOWED` | `<meta>` の CSP `connect-src` | 1a から順に追加 |
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
    tei.js          TEI P5 の書き出し
    bundle.js       プロジェクトの書き出し・読み込み
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

- 最初のプロジェクトを作るときに `navigator.storage.persist()` を要求する。
- ホームに使用量（`navigator.storage.estimate()`）と、プロジェクトごとの最後のバックアップ日時を表示する。
- ブラウザのデータは利用者の操作や容量不足で消えることがあると、ホームに明記する。

### プロジェクトの書き出し形式

1プロジェクトを1つの JSON ファイル（`<slug>.proofreader.json`）にする。ローカル版にも同じ書き出し・読み込みを用意する。

```json
{
  "format": "openiti-proofreader-project",
  "format_version": 1,
  "exported": "2026-11-16T00:00:00Z",
  "app": {"mode": "browser", "version": "…"},
  "project": { "…": "project.json と同じ" },
  "original": "原文（original.txt と同じ文字列）",
  "work": { "edits": {}, "status": {}, "history": {}, "revisions": {}, "schema_version": 2 }
}
```

- PDF などのファイルは含めない。資料の情報（ファイル名・ページ数など）は `project` に残し、読み込み後にファイルを選び直してもらう。
- OCR の結果を含めるかは[未決事項](#未決事項)とする。
- 読み込み時に `original` を split→join して元の文字列と一致することを確かめ、一致しなければ読み込まない。

## 形式と版の管理

版番号を持つものは次の4つ。どれも整数で、上げるときは1ずつ上げる。

| 対象 | 置き場所 | 現在 |
|---|---|---|
| プロジェクトの形式 | `project.json` の `schema_version` | 2 |
| 作業データの形式 | `work.json` の `schema_version` | 2 |
| IndexedDB の構造 | `indexedDB.open('proofreader', n)` の `n` | 1（実装時） |
| 書き出しファイルの形式 | `format_version` | 1（実装時） |

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
| TEI | `tei.js` の出力を `tests.validate_tei` で公式スキーマに通す。同じ入力で `exporters/tei.py` と同じ結果になることも確かめる |
| 書き出しファイル | ローカル版で書き出したものを静的版で読み込み、その逆も行う |

## 配信

- `index.html` などの参照は相対パスにする（GitHub Pages はリポジトリ名のサブパスで配信される）。
- GitHub Actions に、テストがすべて成功したときだけ `proofreader/static/` を Pages に配信するジョブを足す。
- CSP を `<meta http-equiv="Content-Security-Policy">` で指定する。`connect-src` は段階1では `'self' https://raw.githubusercontent.com` とし、段階ごとに必要な接続先だけを足す。足した接続先は対応表とこの節に書く。
- リポジトリが private の場合、Pages の利用には有料プランが必要で、配信されたサイトは公開される。

## 段階2以降の注意（概要）

- **Internet Archive**：エンドポイントごとに CORS を確かめ、結果をこの文書に表で残してから実装する。`<img>` での表示は CORS が無くてもできるが、OCR に画像を送るには必要になる。
- **IA の PDF**：数百 MB をブラウザに保存するのは容量と消去の面で不安定なため、利用者がダウンロードしたファイルを選ぶ方式を基本にする。
- **OCR**：API キーは利用者が画面で入力し、ブラウザ内にだけ置く。キーを書き出しファイルに含めない。1ページずつ、利用者の操作で実行するという原則は変えない。

## 未決事項

| 番号 | 論点 | 選択肢 |
|---|---|---|
| Q-1 | Arabic フォントの配信 | Google Fonts を CSP で許可する／Noto Naskh Arabic（OFL）を同梱する |
| Q-2 | 書き出しファイルに OCR の結果を含めるか | 含める（ファイルが大きくなる）／含めない／選べるようにする |
| Q-3 | `mode.js` の判定方法 | 静的ファイルとサーバーの応答で切り替える（本案）／URL のパラメータで切り替える |
| Q-4 | 長期的なローカル版の位置づけ | 今の Python 版を保つ／静的ファイルの配信と、CORS で取れない資料の取得だけを行う小さなサーバーにする |
| Q-5 | Chrome/Edge の File System Access API で手元のフォルダにも保存できるようにするか | 対応する（Firefox・Safari では使えない）／IndexedDB だけにする |

## 改訂履歴

| 日付 | 内容 |
|---|---|
| 2026-11-16 | 初版。段階1の設計と、版の管理の規則をまとめた |
| 2026-11-16 | 段階1a を作業中にした。`local/openiti.js`・`local/work.js` を名前空間で公開する形にし、保存操作の一致テストと意図的な違いを追記 |
