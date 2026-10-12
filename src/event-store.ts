import type { Pool } from 'pg'
import type { EventRecord } from './schedule.js'

export async function replaceMonthEventsForVenue(db: Pool, venueName: string, month: string, scheduleUrl: string, events: EventRecord[]): Promise<void> {
  const monthBounds = getMonthBounds(month)
  const client = await db.connect()

  try {
    await client.query('BEGIN')
    await client.query(
      `
        DELETE FROM events
        WHERE (venue_name = $1 OR starts_with(source_url, $4))
          AND event_date >= $2
          AND event_date <= $3
      `,
      [venueName, monthBounds.start, monthBounds.end, new URL(scheduleUrl).origin + '/']
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

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return '不明なエラーが発生しました。'
}

