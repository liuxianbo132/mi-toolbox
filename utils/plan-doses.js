// 用药计划 doses 生成（契约 v1.7 #5/#6/#9）
// daily：每天 × 每个时间点；alternate_day：start_date + 2n 天 × 每个时间点
// start_date 早于今天：从今天起生成，不补历史；end_date 含当天；疗程 ≤180 天由表单校验
const { toDateOnly } = require('./date')

const MAX_COURSE_DAYS = 180
const DAY_MS = 86400000

function parseDateOnly(str) {
  const date = new Date(str + 'T00:00:00.000Z')
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === str ? date.getTime() : NaN
}

// 疗程天数（日历日差）：end - start；输入非法返回 NaN
function courseDays(startDate, endDate) {
  const s = parseDateOnly(startDate)
  const e = parseDateOnly(endDate)
  return (e - s) / DAY_MS
}

function invalidLocalTime(day, time, repeated) {
  const reason = repeated ? '在当前设备时区会出现两次' : '在当前设备时区不存在'
  const error = new Error(day.toISOString().slice(0, 10) + ' ' + time + reason + '。请核对原定时间。')
  error.code = 'INVALID_LOCAL_DOSE_TIME'
  return error
}

// 生成 scheduled_at 列表（ISO 串，timestamptz 直写）；返回已排序数组
// options: { startDate:'YYYY-MM-DD', endDate, times:['08:00','20:00'], freq:'daily'|'alternate_day', now?:Date }
function buildDoseTimes(options) {
  const startDate = options.startDate
  const endDate = options.endDate
  const times = (options.times || []).filter((t) => typeof t === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(t)).sort()
  const freq = options.freq === 'alternate_day' ? 'alternate_day' : 'daily'
  const now = options.now instanceof Date ? options.now : new Date()

  const start = parseDateOnly(startDate)
  const end = parseDateOnly(endDate)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return []
  if (!times.length) return []

  // 不补历史：起点取 start 与今天较晚者（契约 v1.7 #5/#6）
  const today = parseDateOnly(toDateOnly(now))
  const from = Math.max(start, today)

  const result = []
  for (let cursor = from; cursor <= end; cursor += DAY_MS) {
    // alternate_day：与 start_date 的日历日差为偶数的日子服药（契约 v1.7 #9）
    if (freq === 'alternate_day' && (cursor - start) / DAY_MS % 2 !== 0) continue
    const day = new Date(cursor)
    const year = day.getUTCFullYear()
    const month = day.getUTCMonth()
    const date = day.getUTCDate()
    const nextOffset = new Date(year, month, date + 1).getTimezoneOffset()
    times.forEach(function (t) {
      const [h, m] = t.split(':').map(Number)
      const at = new Date(year, month, date, h, m)
      if (at.getDate() !== date || at.getHours() !== h || at.getMinutes() !== m) {
        throw invalidLocalTime(day, t, false)
      }
      // A fold can make the same local hour appear at two UTC instants.
      const offsetIncrease = nextOffset - at.getTimezoneOffset()
      if (offsetIncrease > 0) {
        const later = new Date(at.getTime() + offsetIncrease * 60000)
        if (later.getDate() === date && later.getHours() === h && later.getMinutes() === m) {
          throw invalidLocalTime(day, t, true)
        }
      }
      result.push(at.toISOString())
    })
  }
  return result
}

module.exports = { MAX_COURSE_DAYS, courseDays, buildDoseTimes }
