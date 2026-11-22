// 用药计划 doses 生成（契约 v1.7 #5/#6/#9）
// daily：每天 × 每个时间点；alternate_day：start_date + 2n 天 × 每个时间点
// start_date 早于今天：从今天起生成，不补历史；end_date 含当天；疗程 ≤180 天由表单校验
const MAX_COURSE_DAYS = 180

function parseDateOnly(str) {
  // 'YYYY-MM-DD' → 本地 Date（当天 00:00）
  const p = new Date(String(str).replace(/-/g, '/'))
  return p
}

// 疗程天数（日历日差）：end - start；输入非法返回 NaN
function courseDays(startDate, endDate) {
  const s = parseDateOnly(startDate)
  const e = parseDateOnly(endDate)
  if (isNaN(s.getTime()) || isNaN(e.getTime())) return NaN
  return Math.round((e.getTime() - s.getTime()) / 86400000)
}

// 生成 scheduled_at 列表（ISO 串，timestamptz 直写）；返回已排序数组
// options: { startDate:'YYYY-MM-DD', endDate, times:['08:00','20:00'], freq:'daily'|'alternate_day', now?:Date }
function buildDoseTimes(options) {
  const startDate = options.startDate
  const endDate = options.endDate
  const times = options.times || []
  const freq = options.freq === 'alternate_day' ? 'alternate_day' : 'daily'
  const now = options.now instanceof Date ? options.now : new Date()

  const start = parseDateOnly(startDate)
  const end = parseDateOnly(endDate)
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || end < start) return []
  if (!times.length) return []

  // 不补历史：起点取 start 与今天较晚者（契约 v1.7 #5/#6）
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const from = start > today ? start : today

  const result = []
  const cursor = new Date(from.getTime())
  while (cursor <= end) {
    // alternate_day：与 start_date 的日历日差为偶数的日子服药（契约 v1.7 #9）
    const diffDays = Math.round((cursor.getTime() - start.getTime()) / 86400000)
    if (freq === 'daily' || diffDays % 2 === 0) {
      times.forEach(function (t) {
        const hm = String(t).split(':')
        const h = Number(hm[0])
        const m = Number(hm[1])
        if (!isFinite(h) || !isFinite(m)) return
        const at = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate(), h, m, 0)
        result.push(at.toISOString())
      })
    }
    cursor.setDate(cursor.getDate() + 1)
  }
  // ISO UTC 串同格式，字典序即时间序
  result.sort()
  return result
}

module.exports = { MAX_COURSE_DAYS, courseDays, buildDoseTimes }
