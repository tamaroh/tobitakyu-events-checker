import { parseScheduleEvents, type EventRecord } from './schedule.js'
import { replaceMonthEventsForVenue } from './event-store.js'
import { Hono } from 'hono'
import { Pool, type QueryResultRow } from 'pg'
import { createPool, type Bindings } from './database.js'

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

export function createApp(poolFactory: (env: Bindings) => Pool = createPool) {
  const app = new Hono<{ Bindings: Bindings, Variables: { db: Pool } }>()

  // Workers must not share open DB connections between requests.
  app.use('/api/events/*', async (c, next) => {
    let db: Pool | undefined
    try {
      db = poolFactory(c.env)
      c.set('db', db)
      await next()
    } catch (error) {
      return c.json({ error: getErrorMessage(error) }, 500)
    } finally {
      if (db) await db.end()
    }
  })

  app.get('/api/events/today', async (c) => {
    try {
      const todayData = await getTodayEvents(c.get('db'))
      return c.json(todayData)
    } catch (error) {
      return c.json({
        error: getErrorMessage(error)
      }, 500)
    }
  })

  app.post('/api/events/refresh', async (c) => {
    try {
      const result = await refreshCurrentMonthEvents(c.get('db'))
      return c.json(result)
    } catch (error) {
      return c.json({
        error: getErrorMessage(error)
      }, 500)
    }
  })

  return app
}

export default createApp()

async function getTodayEvents(db: Pool): Promise<TodayEventsResponse> {
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

async function refreshCurrentMonthEvents(db: Pool): Promise<RefreshResponse> {
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
      await replaceMonthEventsForVenue(db, venueConfig.venueName, month, venueConfig.scheduleUrl(month), events)
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
  return parseScheduleEvents(html, month, url, venueConfig.venueName)
}

async function ensureSchema(db: Pool): Promise<void> {
  await db.query(`
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
  `)
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

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return '不明なエラーが発生しました。'
}
