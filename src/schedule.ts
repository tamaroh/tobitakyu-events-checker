import { load } from 'cheerio/slim'

export type EventRecord = {
  venueName: string
  eventDate: string
  title: string
  startTime: string | null
  endTime: string | null
  sourceUrl: string
  fetchedAt: string
}

export function parseScheduleEvents(html: string, month: string, url: string, fallbackVenueName: string): EventRecord[] {
  const $ = load(html)
  const fetchedAt = new Date().toISOString()
  const events: EventRecord[] = []

  let currentDate: string | null = null

  $('.scheduleBox').each((_, element) => {
    const box = $(element)
    const rawDate = compactWhitespace(box.find('.columnBlock01 p').text())
    const title = compactWhitespace(box.find('.columnBlock03 h3').text())
    const detailText = compactWhitespace(box.find('.columnBlock03 p').first().text())
    const iconTexts = box.find('.columnBlock03 ul.icon li').map((__, item) => compactWhitespace($(item).text())).get()
    const href = box.find('.columnBlock03 .linkWaku a').attr('href')
    if (rawDate) {
      currentDate = parseEventDate(month, rawDate)
    }
    const eventDate = currentDate

    if (!title || !href || !eventDate) {
      return
    }

    const timeRange = extractTimeRange(detailText)
    const venueName = detectVenueName(iconTexts, fallbackVenueName)

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

function detectVenueName(iconTexts: string[], fallbackVenueName: string): string {
  return iconTexts.find((text) => /スタジアム|アリーナ|フィールド|練習場|広場/.test(text)) ?? fallbackVenueName
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

function normalizeTime(value: string): string {
  const [hours, minutes] = value.split(':')
  return `${hours.padStart(2, '0')}:${minutes}`
}

function compactWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

