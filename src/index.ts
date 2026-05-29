import 'dotenv/config'
import { serve } from '@hono/node-server'
import { load } from 'cheerio'
import { Hono } from 'hono'
import { Pool, type QueryResultRow } from 'pg'

type EventRecord = {
  venueName: string
  eventDate: string
  title: string
  startTime: string | null
  endTime: string | null
  sourceUrl: string
  fetchedAt: string
}

type TodayEventsResponse = {
  date: string
  hasEvents: boolean
  events: Array<{
    venueName: string
    title: string
    startTime: string | null
    endTime: string | null
    sourceUrl: string
  }>
  warnings: string[]
}

type RefreshResponse = {
  month: string
  updatedCount: number
  warnings: string[]
}

type ScrapeResult = {
  venueName: string
  events: EventRecord[]
}

type VenueConfig = {
  venueName: string
  scheduleUrl: (month: string) => string
}

type EventRow = QueryResultRow & {
  venue_name: string
  event_date: string
  title: string
  start_time: string | null
  end_time: string | null
  source_url: string
  fetched_at: string | Date
}

const JAPAN_TIME_ZONE = 'Asia/Tokyo'
const DEFAULT_PORT = 3000
const DATABASE_URL = process.env.DATABASE_URL

const venueConfigs: VenueConfig[] = [
  {
    venueName: '味の素スタジアム',
    scheduleUrl: (month) => `https://www.ajinomotostadium.com/schedule/${month.replace('-', '/')}/`
  },
  {
    venueName: '京王アリーナ TOKYO',
    scheduleUrl: (month) => `https://keio-arena.tokyo/schedule/${month.replace('-', '/')}/`
  }
]

const app = new Hono()

let pool: Pool | null = null
let schemaReady: Promise<void> | null = null

app.get('/', (c) => {
  return c.html(renderPage())
})

app.get('/api/events/today', async (c) => {
  try {
    const todayData = await getTodayEvents()
    return c.json(todayData)
  } catch (error) {
    return c.json({
      error: getErrorMessage(error)
    }, 500)
  }
})

app.post('/api/events/refresh', async (c) => {
  try {
    const result = await refreshCurrentMonthEvents()
    return c.json(result)
  } catch (error) {
    return c.json({
      error: getErrorMessage(error)
    }, 500)
  }
})

const port = Number(process.env.PORT ?? DEFAULT_PORT)

serve({
  fetch: app.fetch,
  port
}, (info) => {
  console.log(`Server is running on http://localhost:${info.port}`)
})

async function getTodayEvents(): Promise<TodayEventsResponse> {
  const db = getPool()
  await ensureSchema(db)

  const today = getTodayDateInJapan()
  const month = today.slice(0, 7)
  const warnings = await ensureCurrentMonthCache(db, month)

  const rows = await db.query<EventRow>(
    `
      SELECT venue_name, event_date, title, start_time, end_time, source_url, fetched_at
      FROM events
      WHERE event_date = $1
      ORDER BY venue_name ASC, start_time ASC NULLS LAST, title ASC
    `,
    [today]
  )

  return {
    date: today,
    hasEvents: rows.rows.length > 0,
    events: rows.rows.map(mapRowToResponseEvent),
    warnings
  }
}

async function refreshCurrentMonthEvents(): Promise<RefreshResponse> {
  const db = getPool()
  await ensureSchema(db)

  const month = getCurrentMonthInJapan()
  const result = await refreshMonthEvents(db, month)

  return {
    month,
    updatedCount: result.updatedCount,
    warnings: result.warnings
  }
}

async function ensureCurrentMonthCache(db: Pool, month: string): Promise<string[]> {
  const monthBounds = getMonthBounds(month)

  const existing = await db.query<{ count: string }>(
    `
      SELECT COUNT(*)::text AS count
      FROM events
      WHERE event_date >= $1 AND event_date <= $2
    `,
    [monthBounds.start, monthBounds.end]
  )

  if (Number(existing.rows[0]?.count ?? '0') > 0) {
    return []
  }

  const refreshed = await refreshMonthEvents(db, month)

  if (refreshed.updatedCount === 0 && refreshed.warnings.length === venueConfigs.length) {
    throw new Error('当月データの取得に失敗しました。しばらくしてから再度お試しください。')
  }

  return refreshed.warnings
}

async function refreshMonthEvents(db: Pool, month: string): Promise<{ updatedCount: number, warnings: string[] }> {
  const results = await Promise.allSettled(
    venueConfigs.map(async (venueConfig) => {
      const events = await scrapeVenueEvents(venueConfig, month)
      await replaceMonthEventsForVenue(db, venueConfig.venueName, month, events)
      return {
        venueName: venueConfig.venueName,
        count: events.length
      }
    })
  )

  let updatedCount = 0
  const warnings: string[] = []

  for (const result of results) {
    if (result.status === 'fulfilled') {
      updatedCount += result.value.count
      continue
    }

    warnings.push(getErrorMessage(result.reason))
  }

  return {
    updatedCount,
    warnings
  }
}

async function scrapeVenueEvents(venueConfig: VenueConfig, month: string): Promise<EventRecord[]> {
  const url = venueConfig.scheduleUrl(month)
  const response = await fetch(url)

  if (!response.ok) {
    throw new Error(`${venueConfig.venueName} のスケジュール取得に失敗しました。`)
  }

  const html = await response.text()
  const $ = load(html)
  const fetchedAt = new Date().toISOString()
  const events: EventRecord[] = []

  $('.scheduleBox').each((_, element) => {
    const box = $(element)
    const rawDate = compactWhitespace(box.find('.columnBlock01 p').text())
    const title = compactWhitespace(box.find('.columnBlock03 h3').text())
    const detailText = compactWhitespace(box.find('.columnBlock03 p').first().text())
    const iconTexts = box.find('.columnBlock03 ul.icon li').map((__, item) => compactWhitespace($(item).text())).get()
    const href = box.find('.columnBlock03 .linkWaku a').attr('href')
    const eventDate = parseEventDate(month, rawDate)

    if (!title || !href || !eventDate) {
      return
    }

    const timeRange = extractTimeRange(detailText)
    const venueName = detectVenueName(iconTexts, venueConfig.venueName)

    events.push({
      venueName,
      eventDate,
      title,
      startTime: timeRange.startTime,
      endTime: timeRange.endTime,
      sourceUrl: new URL(href, url).toString(),
      fetchedAt
    })
  })

  return deduplicateEvents(events)
}

async function replaceMonthEventsForVenue(db: Pool, venueName: string, month: string, events: EventRecord[]): Promise<void> {
  const monthBounds = getMonthBounds(month)
  const client = await db.connect()

  try {
    await client.query('BEGIN')
    await client.query(
      `
        DELETE FROM events
        WHERE venue_name = $1
          AND event_date >= $2
          AND event_date <= $3
      `,
      [venueName, monthBounds.start, monthBounds.end]
    )

    for (const event of events) {
      await client.query(
        `
          INSERT INTO events (venue_name, event_date, title, start_time, end_time, source_url, fetched_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (venue_name, event_date, title)
          DO UPDATE SET
            start_time = EXCLUDED.start_time,
            end_time = EXCLUDED.end_time,
            source_url = EXCLUDED.source_url,
            fetched_at = EXCLUDED.fetched_at
        `,
        [
          event.venueName,
          event.eventDate,
          event.title,
          event.startTime,
          event.endTime,
          event.sourceUrl,
          event.fetchedAt
        ]
      )
    }

    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw new Error(`${venueName} のデータ更新に失敗しました。${getErrorMessage(error)}`)
  } finally {
    client.release()
  }
}

function getPool(): Pool {
  if (!DATABASE_URL) {
    throw new Error('DATABASE_URL が設定されていません。')
  }

  if (!pool) {
    pool = new Pool({
      connectionString: DATABASE_URL
    })
  }

  return pool
}

async function ensureSchema(db: Pool): Promise<void> {
  if (!schemaReady) {
    schemaReady = db.query(`
      CREATE TABLE IF NOT EXISTS events (
        id BIGSERIAL PRIMARY KEY,
        venue_name TEXT NOT NULL,
        event_date DATE NOT NULL,
        title TEXT NOT NULL,
        start_time TIME NULL,
        end_time TIME NULL,
        source_url TEXT NOT NULL,
        fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE UNIQUE INDEX IF NOT EXISTS events_unique_idx
        ON events (venue_name, event_date, title);
    `).then(() => undefined)
  }

  await schemaReady
}

function detectVenueName(iconTexts: string[], fallbackVenueName: string): string {
  return iconTexts.find((text) => /スタジアム|アリーナ|フィールド|練習場/.test(text)) ?? fallbackVenueName
}

function extractTimeRange(detailText: string): { startTime: string | null, endTime: string | null } {
  const normalized = detailText.replace(/[：]/g, ':')
  const explicitStart = normalized.match(/(?:開始時間|開始|開演|試合開始)[^0-9]*([0-9]{1,2}:[0-9]{2})/)
  const explicitEnd = normalized.match(/(?:終了時間|終了|終演)[^0-9]*([0-9]{1,2}:[0-9]{2})/)

  const startTime = explicitStart?.[1] ? normalizeTime(explicitStart[1]) : null
  const endTime = explicitEnd?.[1] ? normalizeTime(explicitEnd[1]) : null

  return {
    startTime,
    endTime
  }
}

function parseEventDate(month: string, rawDate: string): string | null {
  const matched = rawDate.match(/([0-9]{2})\.([0-9]{2})/)

  if (!matched) {
    return null
  }

  const [, monthText, dayText] = matched
  const yearText = month.slice(0, 4)
  return `${yearText}-${monthText}-${dayText}`
}

function deduplicateEvents(events: EventRecord[]): EventRecord[] {
  const uniqueEvents = new Map<string, EventRecord>()

  for (const event of events) {
    const key = `${event.venueName}::${event.eventDate}::${event.title}`
    uniqueEvents.set(key, event)
  }

  return Array.from(uniqueEvents.values())
}

function mapRowToResponseEvent(row: EventRow): TodayEventsResponse['events'][number] {
  return {
    venueName: row.venue_name,
    title: row.title,
    startTime: row.start_time,
    endTime: row.end_time,
    sourceUrl: row.source_url
  }
}

function getMonthBounds(month: string): { start: string, end: string } {
  const [yearText, monthText] = month.split('-')
  const year = Number(yearText)
  const monthIndex = Number(monthText)
  const endDate = new Date(Date.UTC(year, monthIndex, 0))
  const endDay = String(endDate.getUTCDate()).padStart(2, '0')

  return {
    start: `${month}-01`,
    end: `${month}-${endDay}`
  }
}

function getCurrentMonthInJapan(): string {
  return formatInJapan(new Date(), {
    year: 'numeric',
    month: '2-digit'
  })
}

function getTodayDateInJapan(): string {
  return formatInJapan(new Date(), {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  })
}

function formatInJapan(date: Date, options: Intl.DateTimeFormatOptions): string {
  const formatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone: JAPAN_TIME_ZONE,
    ...options
  })

  return formatter.format(date)
}

function normalizeTime(value: string): string {
  const [hours, minutes] = value.split(':')
  return `${hours.padStart(2, '0')}:${minutes}`
}

function compactWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return '不明なエラーが発生しました。'
}

function renderPage(): string {
  return `<!DOCTYPE html>
<html lang="ja">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>飛田給イベントチェッカー</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f7f3ea;
        --panel: rgba(255, 252, 246, 0.96);
        --ink: #1d2a33;
        --muted: #5a6870;
        --accent: #c8553d;
        --accent-soft: #f4d6cf;
        --line: rgba(29, 42, 51, 0.12);
        --warn: #8a5a00;
        --warn-bg: #fff0c7;
        --error: #8b1e2d;
        --error-bg: #fde3e7;
        --success-bg: #e9f3ea;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        font-family: "Hiragino Sans", "Yu Gothic", sans-serif;
        color: var(--ink);
        background:
          radial-gradient(circle at top left, rgba(200, 85, 61, 0.18), transparent 30%),
          linear-gradient(180deg, #fbf8f1 0%, var(--bg) 100%);
      }

      main {
        width: min(960px, calc(100% - 32px));
        margin: 0 auto;
        padding: 32px 0 48px;
      }

      .hero,
      .panel {
        border: 1px solid var(--line);
        border-radius: 24px;
        background: var(--panel);
        box-shadow: 0 18px 40px rgba(29, 42, 51, 0.08);
      }

      .hero {
        padding: 28px;
      }

      .eyebrow {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 6px 12px;
        border-radius: 999px;
        background: var(--accent-soft);
        color: var(--accent);
        font-size: 14px;
        font-weight: 700;
      }

      h1 {
        margin: 18px 0 10px;
        font-size: clamp(30px, 6vw, 48px);
        line-height: 1.08;
      }

      .hero p {
        margin: 0;
        max-width: 56ch;
        line-height: 1.7;
        color: var(--muted);
      }

      .toolbar {
        display: flex;
        flex-wrap: wrap;
        justify-content: space-between;
        gap: 12px;
        align-items: center;
        margin: 24px 0 20px;
      }

      .button {
        appearance: none;
        border: none;
        border-radius: 999px;
        background: var(--ink);
        color: white;
        padding: 12px 18px;
        font: inherit;
        font-weight: 700;
        cursor: pointer;
      }

      .button:disabled {
        opacity: 0.6;
        cursor: progress;
      }

      .status {
        color: var(--muted);
        font-size: 14px;
      }

      .panel {
        padding: 22px;
      }

      .summary {
        display: grid;
        gap: 12px;
      }

      .summary-date {
        font-size: 14px;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: var(--muted);
      }

      .summary-title {
        font-size: clamp(24px, 5vw, 36px);
        font-weight: 800;
        line-height: 1.15;
      }

      .summary-copy {
        color: var(--muted);
        line-height: 1.7;
      }

      .message {
        margin-top: 16px;
        padding: 14px 16px;
        border-radius: 16px;
        line-height: 1.6;
      }

      .message.warning {
        background: var(--warn-bg);
        color: var(--warn);
      }

      .message.error {
        background: var(--error-bg);
        color: var(--error);
      }

      .cards {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
        gap: 16px;
        margin-top: 20px;
      }

      .card {
        border: 1px solid var(--line);
        border-radius: 20px;
        padding: 18px;
        background: white;
      }

      .card-venue {
        color: var(--accent);
        font-size: 13px;
        font-weight: 800;
        letter-spacing: 0.04em;
      }

      .card-title {
        margin: 8px 0 12px;
        font-size: 20px;
        font-weight: 800;
        line-height: 1.35;
      }

      .card-time {
        display: inline-flex;
        padding: 6px 10px;
        border-radius: 999px;
        background: var(--success-bg);
        font-size: 14px;
        font-weight: 700;
      }

      .card-link {
        display: inline-block;
        margin-top: 14px;
        color: var(--ink);
        font-weight: 700;
      }

      .empty {
        margin-top: 18px;
        padding: 18px;
        border-radius: 18px;
        background: #fff;
        border: 1px dashed var(--line);
        color: var(--muted);
      }

      @media (max-width: 640px) {
        main {
          width: min(100% - 20px, 960px);
          padding-top: 20px;
        }

        .hero,
        .panel {
          border-radius: 20px;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <section class="hero">
        <div class="eyebrow">Tobitakyu Events Checker</div>
        <h1>飛田給の混雑理由を、今日ぶんだけ素早く確認する。</h1>
        <p>
          味の素スタジアムと京王アリーナ TOKYO の当日イベントを自動で集約し、
          イベントの有無と概要を一覧で表示します。
        </p>
      </section>

      <div class="toolbar">
        <div class="status" id="status">データを確認しています...</div>
        <button class="button" id="refreshButton" type="button">当月データを再取得</button>
      </div>

      <section class="panel" id="app">
        <div class="summary">
          <div class="summary-date">Loading</div>
          <div class="summary-title">読み込み中です</div>
          <div class="summary-copy">当日のイベント情報を取得しています。</div>
        </div>
      </section>
    </main>

    <script>
      const appRoot = document.getElementById('app')
      const statusNode = document.getElementById('status')
      const refreshButton = document.getElementById('refreshButton')

      function escapeHtml(value) {
        return value
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;')
          .replaceAll("'", '&#39;')
      }

      function formatTime(startTime, endTime) {
        if (!startTime && !endTime) {
          return '時間未定'
        }

        if (startTime && endTime) {
          return startTime + ' - ' + endTime
        }

        return startTime || endTime || '時間未定'
      }

      function renderWarnings(warnings) {
        if (!warnings.length) {
          return ''
        }

        return warnings.map((warning) => '<div class="message warning">' + escapeHtml(warning) + '</div>').join('')
      }

      function renderEvents(data) {
        const cards = data.events.map((event) => {
          return [
            '<article class="card">',
            '<div class="card-venue">' + escapeHtml(event.venueName) + '</div>',
            '<div class="card-title">' + escapeHtml(event.title) + '</div>',
            '<div class="card-time">' + escapeHtml(formatTime(event.startTime, event.endTime)) + '</div>',
            '<div><a class="card-link" href="' + escapeHtml(event.sourceUrl) + '" target="_blank" rel="noreferrer">詳細を見る</a></div>',
            '</article>'
          ].join('')
        }).join('')

        const summaryTitle = data.hasEvents
          ? '今日はイベントがあります'
          : '今日はイベントはありません'

        const summaryCopy = data.hasEvents
          ? '当日開催のイベントを会場ごとに表示しています。'
          : '対象施設では本日開催のイベントは見つかりませんでした。'

        appRoot.innerHTML = [
          '<div class="summary">',
          '<div class="summary-date">' + escapeHtml(data.date) + '</div>',
          '<div class="summary-title">' + escapeHtml(summaryTitle) + '</div>',
          '<div class="summary-copy">' + escapeHtml(summaryCopy) + '</div>',
          '</div>',
          renderWarnings(data.warnings),
          data.hasEvents ? '<div class="cards">' + cards + '</div>' : '<div class="empty">今日はイベントはありません</div>'
        ].join('')
      }

      function renderError(message) {
        appRoot.innerHTML = [
          '<div class="summary">',
          '<div class="summary-date">Error</div>',
          '<div class="summary-title">取得に失敗しました</div>',
          '<div class="summary-copy">時間を置いて再度お試しください。</div>',
          '</div>',
          '<div class="message error">' + escapeHtml(message) + '</div>'
        ].join('')
      }

      async function loadTodayEvents() {
        statusNode.textContent = '当日のイベント情報を取得しています...'

        try {
          const response = await fetch('/api/events/today')
          const data = await response.json()

          if (!response.ok) {
            throw new Error(data.error || '当日のイベント取得に失敗しました。')
          }

          renderEvents(data)
          statusNode.textContent = data.warnings.length
            ? '一部の会場で最新データ取得に失敗しました。キャッシュ済みデータを含めて表示しています。'
            : '当日のイベント情報を表示しています。'
        } catch (error) {
          statusNode.textContent = 'イベント情報の取得に失敗しました。'
          renderError(error instanceof Error ? error.message : '不明なエラーが発生しました。')
        }
      }

      refreshButton.addEventListener('click', async () => {
        refreshButton.disabled = true
        statusNode.textContent = '当月データを再取得しています...'

        try {
          const response = await fetch('/api/events/refresh', { method: 'POST' })
          const data = await response.json()

          if (!response.ok) {
            throw new Error(data.error || '再取得に失敗しました。')
          }

          statusNode.textContent = data.warnings.length
            ? '再取得は完了しましたが、一部の会場で警告があります。'
            : '当月データを更新しました。'

          await loadTodayEvents()
        } catch (error) {
          statusNode.textContent = '再取得に失敗しました。'
          renderError(error instanceof Error ? error.message : '不明なエラーが発生しました。')
        } finally {
          refreshButton.disabled = false
        }
      })

      loadTodayEvents()
    </script>
  </body>
</html>`
}
