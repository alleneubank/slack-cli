const unixSeconds = /^\d+(?:\.\d+)?$/
const isoDateTime =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?(?:(Z)|([+-])(\d{2}):?(\d{2}))?$/i

/**
 * Converts a time-range value to the Unix seconds Slack expects. Unix seconds
 * pass through unchanged; an ISO 8601 date or date-time is read as UTC unless
 * it carries an offset. Returns undefined for anything else, including dates
 * that do not exist on the calendar.
 */
export function unixTimestamp(value: string): string | undefined {
  if (unixSeconds.test(value)) return value
  const match = isoDateTime.exec(value)
  if (match === null) return undefined
  const [year, month, day, hour = 0, minute = 0, second = 0] = match
    .slice(1, 7)
    .map((part) => (part === undefined ? undefined : Number(part)))
  const sign = match[8] === '-' ? -1 : 1
  const offsetHours = Number(match[9] ?? 0)
  const offsetMinutes = Number(match[10] ?? 0)
  const inRange =
    month! >= 1 &&
    month! <= 12 &&
    day! >= 1 &&
    day! <= daysInMonth(year!, month!) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHours <= 23 &&
    offsetMinutes <= 59
  if (!inRange) return undefined
  const utcMs = Date.UTC(year!, month! - 1, day!, hour, minute, second)
  const offsetMs = sign * (offsetHours * 60 + offsetMinutes) * 60_000
  return String((utcMs - offsetMs) / 1000)
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}
