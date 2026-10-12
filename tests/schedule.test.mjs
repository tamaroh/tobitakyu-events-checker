import assert from 'node:assert/strict'
import test from 'node:test'
import { parseScheduleEvents } from '../src/schedule.ts'

const url = 'https://www.ajinomotostadium.com/schedule/2026/10/'
const box = (date, venue, title = '大会', href = '/schedule/2026/event.php') => `
  <div class="scheduleBox">
    <div class="columnBlock01">${date ? `<p>${date}</p>` : ''}</div>
    <div class="columnBlock03">
      <h3>${title}</h3>
      <ul class="icon"><li>${venue}</li><li>スポーツ</li></ul>
      <p>開始時間：9:00 終了時間：17:00</p>
      <div class="linkWaku"><a href="${href}">詳細</a></div>
    </div>
  </div>`

test('同日の全会場のイベントを保持し、次の日付に切り替える', () => {
  const html = box('10.11 日', 'AGFフィールド')
    + box('', 'アミノバイタルフィールド')
    + box('', '味の素スタジアム')
    + box('10.12 月', '「あじペン」広場')
    + box('', 'アジパンダ広場')
  const events = parseScheduleEvents(html, '2026-10', url, '味の素スタジアム')
  assert.deepEqual(events.map(e => [e.eventDate, e.venueName]), [
    ['2026-10-11', 'AGFフィールド'],
    ['2026-10-11', 'アミノバイタルフィールド'],
    ['2026-10-11', '味の素スタジアム'],
    ['2026-10-12', '「あじペン」広場'],
    ['2026-10-12', 'アジパンダ広場']
  ])
  assert.equal(events[0].startTime, '09:00')
  assert.equal(events[0].endTime, '17:00')
  assert.equal(events[0].sourceUrl, 'https://www.ajinomotostadium.com/schedule/2026/event.php')
})

test('イベント自体をスキップしても日付を後続の予定に引き継ぐ', () => {
  const html = box('', 'AGFフィールド', '日付なし')
    + box('10.11 日', 'AGFフィールド', '')
    + box('', 'アミノバイタルフィールド')
    + box('日付不明', '味の素スタジアム')
    + box('', 'AGFフィールド')
  const events = parseScheduleEvents(html, '2026-10', url, '味の素スタジアム')
  assert.equal(events.length, 1)
  assert.equal(events[0].eventDate, '2026-10-11')
})

test('同会場の重複を除き、会場不明時は取得元の名称を使う', () => {
  const html = box('10.11 日', 'スポーツ') + box('', 'スポーツ')
  const events = parseScheduleEvents(html, '2026-10', url, '京王アリーナ TOKYO')
  assert.equal(events.length, 1)
  assert.equal(events[0].venueName, '京王アリーナ TOKYO')
})
