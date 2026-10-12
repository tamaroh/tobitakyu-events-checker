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

## 技術要件
- Backend: Hono
- Frontend: React + TypeScript
- DB: PostgreSQL
- 環境変数でDB接続文字列を受け取る

必要な環境変数:
- `DATABASE_URL`
- `PORT`（未指定時は 3000 を使用）

## ローカル起動手順
### 前提
- Node.js がインストールされていること
- PostgreSQL が利用できること

### 1. 依存関係をインストールする

```bash
npm install
```

### 2. PostgreSQL を起動する
Homebrew を使う場合:

```bash
brew install postgresql@17
brew services start postgresql@17
```

### 3. 開発用データベースを作成する

```bash
createdb tobitakyu_events_checker
```

### 4. 環境変数を設定する

```bash
cp .env.example .env
```

Homebrew で PostgreSQL を起動した場合は、macOS のユーザー名を使って `DATABASE_URL` を設定する。

例:

```env
DATABASE_URL=postgresql://your-user-name@localhost:5432/tobitakyu_events_checker
PORT=3000
```

### 5. 開発サーバーを起動する

```bash
npm run dev
```

ブラウザで `http://localhost:3000` にアクセスする。

### 6. 動作確認
- 初回アクセス時に当月データが自動取得される
- `GET /api/events/today` で当日イベントを確認できる
- `POST /api/events/refresh` で当月データを再取得できる

API を直接確認する例:

```bash
curl http://localhost:3000/api/events/today
curl -X POST http://localhost:3000/api/events/refresh
```

## 完了条件
- ローカルで起動できる
- build が通る
- DB保存と再利用が確認できる
- 当日イベントの有無が画面表示される
- 当月データ未取得時に自動スクレイピングが実行される
- `POST /api/events/refresh` で当月データを更新できる
- 一部スクレイピング失敗時の警告表示が確認できる
