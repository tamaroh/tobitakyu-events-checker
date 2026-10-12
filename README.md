# 飛田給イベントチェッカー
このアプリは、飛田給駅が混雑している時に、イベントが開催されているのかどうかを調べるアプリです。

## 目的
飛田給駅周辺施設の当日イベント有無をユーザーがすぐ確認できるWebアプリを作る。

## 想定ユーザー
- 飛田給駅周辺を利用する人
- 駅周辺の混雑理由をすぐ知りたい人

## 対象施設
- 味の素スタジアム
- 京王アリーナ

## コア要件
- 初回アクセス時、当月データがDBにない場合は各施設のスケジュールページをスクレイピングして保存する
- 再アクセス時はDBキャッシュを使う
- 当日のイベントが1件以上あれば一覧表示する
- 0件なら「今日はイベントはありません」と表示する
- トップページの表示に必要なデータは API 経由で取得する

## 判定ルール
- 日付判定は日本時間
- 開始時刻不明のイベントも当日イベントとして表示する
- 同日に複数イベントがある場合はすべて表示する
- 味の素スタジアムの一覧に掲載されたフィールド・広場などの予定も、各会場名で表示する
- 時刻不明のイベントは UI 上で「時間未定」と表示する

## キャッシュ更新ルール
- 月ごとにデータを管理する
- 当月データが1件も存在しない場合は、初回アクセス時にスクレイピングして保存する
- 月が変わった場合は、新しい月のデータを初回アクセス時に取得する
- `POST /api/events/refresh` を呼ぶと、当月データを再取得して既存データを更新する
- 再取得時は同一イベントの重複登録を防ぐ
- 再取得時は取得元の施設に属する全会場の当月データを置き換える

## スクレイピングルール
- 対象は各施設のスケジュール一覧ページとする
- 同日の2件目以降で日付欄が省略されている場合は、直前の日付を引き継ぐ
- 一覧ページから取得できる情報だけで不足する場合は、詳細ページの取得も許可する
- 取得対象は当月分のイベント情報のみとする
- スクレイピングに失敗した施設がある場合でも、取得できた施設分は保存して返す
- 片方の施設が失敗した場合は、レスポンスに警告情報を含める
- 両方の施設が失敗し、かつ利用可能なキャッシュもない場合はエラーとして扱う

## DB要件
events テーブルを作成する
- id: primary key
- venue_name: text
- event_date: date
- title: text
- start_time: time nullable
- end_time: time nullable
- source_url: text
- fetched_at: timestamp

重複条件:
- venue_name + event_date + title をユニーク扱いにする

補足:
- 時刻は日本時間前提で扱う
- 開始時刻と終了時刻が取得できない場合は null を保存する

## API
- GET /api/events/today
- POST /api/events/refresh

### GET /api/events/today
当日のイベント情報を返す。

レスポンス例:

```json
{
	"date": "2026-05-29",
	"hasEvents": true,
	"events": [
		{
			"venueName": "味の素スタジアム",
			"title": "Jリーグ ○○戦",
			"startTime": "19:00",
			"endTime": null,
			"sourceUrl": "https://example.com"
		}
	],
	"warnings": []
}
```

### POST /api/events/refresh
当月データを再取得し、更新結果を返す。

レスポンス例:

```json
{
	"month": "2026-05",
	"updatedCount": 12,
	"warnings": []
}
```

## UI
- / に当日のイベント有無を表示
- イベントありの場合は会場名、タイトル、時間を表示
- イベントなしの場合は固定メッセージを表示
- 取得失敗時はエラーメッセージを表示
- 部分的に取得失敗した場合は、表示可能なイベント一覧に加えて警告メッセージを表示する
- スマートフォン表示を考慮したシンプルなレイアウトにする

## 実行環境
- Backend: Hono / Cloudflare Workers（Node.js互換モード）
- Frontend: `public/index.html` / `public/style.css`（Workers Static Assets）
- DB: PostgreSQL（既存テーブルを継続利用）
- Workers入口: `src/index.ts`、Render / Node.js入口: `src/node.ts`

## Workersでローカル実行
Node.js 22以降とPostgreSQLを用意してください。

```bash
npm install
cp .dev.vars.example .dev.vars
```

`.dev.vars` の `DATABASE_URL` をローカルDBの接続文字列に変更し、起動します。

```bash
npm run dev
```

`http://localhost:8787` にアクセスしてください。接続情報はコミットしません。
Workersでは `PORT` や `dotenv` を使用せず、リクエストのbindingsから設定を読み取ります。

```bash
npm test
npm run build
npm run build:worker
```

`build:worker` はデプロイせずWorkers用のバンドルを検証します。

## Cloudflare Workersへのデプロイ

### PostgreSQLへ直接接続する場合
Cloudflareから接続できるDBの外部接続URLを使用してください。
Renderの内部ホスト名やローカルの `localhost` は本番Workersから接続できません。
既存DBを利用する場合、テーブルの移行は不要です。

```bash
npx wrangler login
npx wrangler secret put DATABASE_URL
npm run deploy
```

`secret put` の入力時に本番の接続文字列を指定します。
DB側で要求されるSSL設定もURLに含めてください。
ローカルの `.env` / `.dev.vars` の内容はデプロイ先には反映されません。

### Hyperdriveを利用する場合
Hyperdriveを既存のPostgreSQLに接続し、`wrangler.jsonc` に以下を追加します。
DBキャッシュはアプリ側で管理するため、Hyperdriveのクエリキャッシュは無効にしてください。

```bash
npx wrangler hyperdrive create tobitakyu-events --connection-string="<本番DBの外部接続URL>" --caching-disabled
```

```json
"hyperdrive": [{ "binding": "HYPERDRIVE", "id": "<作成されたID>" }]
```

`HYPERDRIVE` が設定されている場合は `DATABASE_URL` より優先して使用します。
ローカル開発時は `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` 環境変数に
ローカルDBの接続文字列を設定してください。

公式資料: [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)、
[PostgreSQL / Hyperdrive](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/)。

## Render / Node.jsで引き続き実行する場合
`.env.example` を `.env` にコピーし、`DATABASE_URL` を設定してください。
`PORT` は未指定の場合3000を使用します。

```bash
npm run dev:node
```

Renderのビルド・起動コマンドは引き続き `npm run build` / `npm start` を使用できます。

## APIの動作確認

```bash
curl http://localhost:8787/api/events/today
curl -X POST http://localhost:8787/api/events/refresh
```

Node.js版はポートを3000（または `PORT` の指定値）に変更してください。

## 完了条件
- ローカルで起動できる
- build が通る
- DB保存と再利用が確認できる
- 当日イベントの有無が画面表示される
- 当月データ未取得時に自動スクレイピングが実行される
- `POST /api/events/refresh` で当月データを更新できる
- 一部スクレイピング失敗時の警告表示が確認できる
