const { cloud } = require('../../utils/cloud')
const { toDateOnly } = require('../../utils/date')

// 依从性报告（只读）：口径 = 本人（当前 session 用户在 members 中 owner_id 的行）
// 依从率 = taken ÷（taken + missed）；柱状图按自然日分组
const BAR_MAX = 200 // 柱子可用高度（chart-box 240rpx 内预留 label 空间）
const MAX_MISSED = 20
const PAGE_SIZE = 500
const FILTER_SIZE = 100

function pad2(n) {
  return String(n).padStart(2, '0')
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

function addDays(d, n) {
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  next.setDate(next.getDate() + n)
  return next
}

function fmtMD(d) {
  return d.getMonth() + 1 + '/' + d.getDate()
}

function fmtMMDD(d) {
  return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
}

function fmtHM(d) {
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes())
}

async function readRows(makeQuery) {
  const rows = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await makeQuery().order('id', { ascending: true }).range(from, from + PAGE_SIZE - 1)
    if (error) throw error
    const page = data || []
    rows.push(...page)
    if (page.length < PAGE_SIZE) return rows
  }
}

async function readFilteredRows(ids, makeQuery) {
  const rows = []
  for (let offset = 0; offset < ids.length; offset += FILTER_SIZE) {
    const chunk = ids.slice(offset, offset + FILTER_SIZE)
    const page = await readRows(() => makeQuery(chunk))
    rows.push(...page)
  }
  return rows
}

// 本周（周一 00:00 起）/ 本月（1 号 00:00 起）→ [start, end)
function rangeOf(kind, now) {
  const today = startOfDay(now)
  let start
  if (kind === 'month') {
    start = new Date(today.getFullYear(), today.getMonth(), 1)
  } else {
    const dow = today.getDay() // 0=周日
    const offset = dow === 0 ? 6 : dow - 1
    start = addDays(today, -offset)
  }
  return { start: start, end: addDays(today, 1) }
}

Page({
  data: {
    largeText: false,
    authState: 'checking', // checking | signed-out | no-household | ready
    loginLoading: false,
    loginError: '',
    memberName: '',
    loading: true,
    loadError: '',
    range: 'week', // week | month
    hasRate: false,
    rateText: '—',
    taken: 0,
    missed: 0,
    pending: 0,
    chart: [],
    missedList: [],
    chartScroll: false,
  },

  onShow() {
    this.setData({ largeText: getApp().globalData.largeText })
    this.restore()
  },

  async restore() {
    if (this.restoring) return
    this.restoring = true
    this.statsRequestId = (this.statsRequestId || 0) + 1
    this.setData({ authState: 'checking', loadError: '' })
    try {
      const { data: session, error } = await getApp().ensureSession()
      if (error) throw error
      if (!session) {
        this.setData({ authState: 'signed-out' })
        return
      }
      await this.loadHousehold(session.user && session.user.id)
    } catch (e) {
      this.householdId = null
      this.memberId = null
      this.setData({ authState: 'error', loading: false, loadError: '家庭信息暂时无法加载，请重试。' })
    } finally {
      this.restoring = false
    }
  },

  async onwechatlogin() {
    if (this.data.loginLoading) return
    this.setData({ loginLoading: true, loginError: '' })
    const res = await getApp().loginWithWechat()
    this.setData({ loginLoading: false })
    if (res.error || !res.data) {
      this.setData({ loginError: (res.error && res.error.message) || '登录失败' })
      return
    }
    this.restore()
  },

  // 本人成员档案：members 中 owner_id = 当前 uid 的行
  async loadHousehold(uid) {
    if (!uid) {
      this.setData({ authState: 'signed-out' })
      return
    }
    const { data: mine, error } = await cloud.database
      .from('members')
      .select('id, household_id, nickname')
      .eq('owner_id', uid)
      .is('left_at', null)
      .limit(1)
    if (error) throw error
    const row = mine && mine[0]
    if (!row) {
      this.setData({ authState: 'no-household', loading: false })
      return
    }
    this.householdId = row.household_id
    this.memberId = row.id
    this.setData({ authState: 'ready', memberName: row.nickname || '本人' })
    await this.loadData(this.householdId, this.memberId)
  },

  async loadData(hid, memberId) {
    const requestId = this.statsRequestId = (this.statsRequestId || 0) + 1
    this.setData({ loading: true, loadError: '' })
    try {
      const now = new Date()
      const week = rangeOf('week', now)
      const month = rangeOf('month', now)
      const since = new Date(Math.min(week.start, month.start)).toISOString()
      const until = month.end.toISOString()
      const plans = await readRows(() => cloud.database.from('medication_plans')
        .select('id, item_id').eq('household_id', hid).eq('member_id', memberId))

      const planIds = plans.map((p) => p.id)
      const itemIds = Array.from(new Set(plans.map((p) => p.item_id)))
      const [doses, items] = await Promise.all([
        readFilteredRows(planIds, (ids) => cloud.database.from('medication_doses')
          .select('id, plan_id, scheduled_at, status').eq('household_id', hid).in('plan_id', ids)
          .gte('scheduled_at', since).lt('scheduled_at', until)),
        // 软删除药品仍用于历史记录的名称映射。
        readFilteredRows(itemIds, (ids) => cloud.database.from('items')
          .select('id, name').eq('household_id', hid).in('id', ids)),
      ])
      if (requestId !== this.statsRequestId) return
      const itemName = new Map(items.map((i) => [String(i.id), i.name]))
      const planItemName = new Map(plans.map((p) => [String(p.id), itemName.get(String(p.item_id))]))
      this.raw = { doses, planItemName }
      this.compute()
      this.setData({ loading: false })
    } catch (e) {
      if (requestId !== this.statsRequestId) return
      this.raw = null
      this.setData({ loading: false, loadError: '依从性报告暂时无法加载，请重试。' })
    }
  },

  switchrange(e) {
    const r = e.currentTarget.dataset.range
    if (!r || r === this.data.range) return
    this.setData({ range: r })
    this.compute()
  },

  retryload() {
    if (!this.householdId || !this.memberId) {
      this.restore()
      return
    }
    this.loadData(this.householdId, this.memberId)
  },

  // 按当前范围聚合：计数、逐日柱、漏服明细
  compute() {
    const raw = this.raw
    if (!raw) return
    const range = rangeOf(this.data.range, new Date())
    const startMs = range.start.getTime()
    const endMs = range.end.getTime()

    let taken = 0
    let missed = 0
    let pending = 0
    const byDay = {}
    const missedRows = []

    raw.doses.forEach(function (d) {
      const time = new Date(d.scheduled_at)
      const ms = time.getTime()
      if (!(ms >= startMs && ms < endMs)) return
      const key = toDateOnly(time)
      if (!byDay[key]) byDay[key] = { taken: 0, missed: 0 }
      if (d.status === 'taken') {
        taken++
        byDay[key].taken++
      } else if (d.status === 'missed') {
        missed++
        byDay[key].missed++
        missedRows.push({
          id: d.id,
          ms: ms,
          dateText: fmtMMDD(time),
          timeText: fmtHM(time),
          name: raw.planItemName.get(String(d.plan_id)) || '未知药品',
        })
      } else if (d.status === 'pending') {
        pending++
      }
    })

    const denom = taken + missed
    const rate = denom > 0 ? Math.round((taken / denom) * 100) : null

    const chart = []
    for (let cursor = range.start; cursor.getTime() < endMs; cursor = addDays(cursor, 1)) {
      const key = toDateOnly(cursor)
      const cell = byDay[key] || { taken: 0, missed: 0 }
      const dayDenom = cell.taken + cell.missed
      const dayRate = dayDenom > 0 ? Math.round((cell.taken / dayDenom) * 100) : null
      chart.push({
        key: key,
        label: fmtMD(cursor),
        summary: dayDenom > 0 ? dayRate + '%' : '无数据',
        barH: dayDenom > 0 ? Math.max(6, Math.round((dayRate / 100) * BAR_MAX)) : 0,
      })
    }

    missedRows.sort(function (a, b) {
      return b.ms - a.ms
    })
    const missedList = missedRows.slice(0, MAX_MISSED).map(function (r) {
      return { id: r.id, dateText: r.dateText, timeText: r.timeText, name: r.name }
    })

    this.setData({
      taken: taken,
      missed: missed,
      pending: pending,
      hasRate: rate !== null,
      rateText: rate === null ? '—' : String(rate),
      chart: chart,
      chartScroll: chart.length > 7 || this.data.largeText,
      missedList: missedList,
    })
  },
})
