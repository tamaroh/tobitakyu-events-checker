import assert from 'node:assert/strict'
import test from 'node:test'
import { createApp } from '../src/index.ts'
import { createPool } from '../src/database.ts'

test('Workers bindingsから接続設定を読み取り、Hyperdriveを優先する', async () => {
  assert.throws(() => createPool({}), /設定されていません/)
  const db = createPool({ DATABASE_URL: 'postgres://direct/db', HYPERDRIVE: { connectionString: 'postgres://hyperdrive/db' } })
  assert.equal(db.options.connectionString, 'postgres://hyperdrive/db')
  await db.end()
})

test('各リクエストで別の接続を使い、当日イベントを返して終了する', async () => {
  const pools = []
  const app = createApp(env => {
    assert.equal(env.DATABASE_URL, 'postgres://test/db')
    const db = {
      closed: false,
      async query(sql) {
        if (sql.includes('COUNT(*)')) return { rows: [{ count: '1' }] }
        if (sql.includes('SELECT venue_name')) return { rows: [
          { venue_name: 'AGFフィールド', title: '大会', start_time: null, end_time: null, source_url: 'https://example.com/' }
        ] }
        return { rows: [] }
      },
      async end() { this.closed = true }
    }
    pools.push(db)
    return db
  })
  for (let i = 0; i < 2; i++) {
    const response = await app.request('/api/events/today', {}, { DATABASE_URL: 'postgres://test/db' })
    assert.equal(response.status, 200)
    const data = await response.json()
    assert.equal(data.hasEvents, true)
    assert.equal(data.events[0].venueName, 'AGFフィールド')
  }
  assert.equal(pools.length, 2)
  assert.ok(pools.every(db => db.closed))
})

test('DB取得失敗でも接続を終了し、次のリクエストで再試行する', async () => {
  let attempts = 0
  let closed = 0
  const app = createApp(() => ({
    async query(sql) {
      if (sql.includes('CREATE TABLE') && attempts++ === 0) throw new Error('DB unavailable')
      if (sql.includes('COUNT(*)')) return { rows: [{ count: '1' }] }
      return { rows: [] }
    },
    async end() { closed++ }
  }))
  assert.equal((await app.request('/api/events/today')).status, 500)
  assert.equal((await app.request('/api/events/today')).status, 200)
  assert.equal(closed, 2)
})

test('DB設定がなくてもAPIはJSONのエラーを返す', async () => {
  const response = await createApp().request('/api/events/today', {}, {})
  assert.equal(response.status, 500)
  assert.match((await response.json()).error, /設定されていません/)
})
