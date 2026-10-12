import assert from 'node:assert/strict'
import test from 'node:test'
import { replaceMonthEventsForVenue } from '../src/event-store.ts'

function database(failInsert = false) {
  const queries = []
  let released = false
  return {
    queries,
    get released() { return released },
    async connect() {
      return {
        async query(sql, values) {
          queries.push({ sql, values })
          if (failInsert && sql.includes('INSERT INTO')) throw new Error('insert failed')
        },
        release() { released = true }
      }
    }
  }
}

const scheduleUrl = 'https://www.ajinomotostadium.com/schedule/2026/10/'
const event = {
  venueName: 'AGFフィールド', eventDate: '2026-10-11', title: '大会',
  startTime: null, endTime: null,
  sourceUrl: 'https://www.ajinomotostadium.com/schedule/2026/event.php',
  fetchedAt: '2026-10-11T00:00:00.000Z'
}

test('再取得は取得元URLと月で全会場のキャッシュを置換する', async () => {
  const db = database()
  await replaceMonthEventsForVenue(db, '味の素スタジアム', '2026-10', scheduleUrl, [event])
  const deletion = db.queries.find(q => q.sql.includes('DELETE FROM'))
  assert.match(deletion.sql, /venue_name = \$1 OR starts_with\(source_url, \$4\)/)
  assert.match(deletion.sql, /event_date >= \$2\s+AND event_date <= \$3/)
  assert.deepEqual(deletion.values, [
    '味の素スタジアム', '2026-10-01', '2026-10-31', 'https://www.ajinomotostadium.com/'
  ])
  assert.equal(db.queries.find(q => q.sql.includes('INSERT INTO')).values[0], 'AGFフィールド')
  assert.equal(db.queries.at(-1).sql, 'COMMIT')
  assert.equal(db.released, true)
})

test('予定がなくなった場合も当月のキャッシュを削除する', async () => {
  const db = database()
  await replaceMonthEventsForVenue(db, '味の素スタジアム', '2026-10', scheduleUrl, [])
  assert.equal(db.queries.length, 3)
  assert.match(db.queries[1].sql, /DELETE FROM events/)
  assert.equal(db.queries.at(-1).sql, 'COMMIT')
})

test('保存失敗時はロールバックして既存キャッシュを保持する', async () => {
  const db = database(true)
  await assert.rejects(
    replaceMonthEventsForVenue(db, '味の素スタジアム', '2026-10', scheduleUrl, [event]),
    /データ更新に失敗/
  )
  assert.equal(db.queries.at(-1).sql, 'ROLLBACK')
  assert.equal(db.released, true)
})
