const { cloud } = require('../../utils/cloud')
const { toDateOnly } = require('../../utils/date')

// 依从性报告（只读）：口径 = 本人（当前 session 用户在 members 中 owner_id 的行）
// 依从率 = taken ÷（taken + missed）；柱状图按自然日分组
const BAR_MAX = 200 // 柱子可用高度（chart-box 240rpx 内预留 label 空间）
const LOOKBACK_DAYS = 30
const MAX_MISSED = 20

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

// 依从率分档：>=80 绿 / 40-79 橙 / <40 红
function tierOf(rate) {
  if (rate === null) return ''
  if (rate >= 80) return 'green'
  if (rate >= 40) return 'amber'
  return 'red'
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
    loading: true,
    loadError: '',
    range: 'week', // week | month
    hasRate: false,
    rateText: '—',
    rateClass: '',
    taken: 0,
    missed: 0,
    pending: 0,
    chart: [],
    missedList: [],
  },

  onShow() {
    this.setData({ largeText: getApp().globalData.largeText })
    this.restore()
  },

  async restore() {
    this.setData({ authState: 'checking', loadError: '' })
    try {
      const { data: session, error } = await getApp().ensureSession()
      if (error || !session) {
        this.setData({ authState: 'signed-out' })
        return
      }
      await this.loadHousehold()
    } catch (e) {
      this.setData({ authState: 'signed-out' })
    }
  },

  async onwechatlogin() {
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
  async loadHousehold() {
    const { data: session } = await cloud.auth.getSession()
    const uid = session && session.user && session.user.id
    if (!uid) {
      this.setData({ authState: 'signed-out' })
      return
    }
    const { data: mine } = await cloud.database
      .from('members')
      .select('id, household_id')
      .eq('owner_id', uid)
      .limit(1)
    const row = mine && mine[0]
    if (!row) {
      this.setData({ authState: 'no-household', loading: false })
      return
    }
    this.householdId = row.household_id
    this.memberId = row.id
    this.setData({ authState: 'ready' })
    await this.loadData(this.householdId, this.memberId)
  },

  // 近 30 天数据（覆盖本周与本月），后续切换范围只在前端重算
  async loadData(hid, memberId) {
    this.setData({ loading: true, loadError: '' })
    const today = startOfDay(new Date())
    const since = addDays(today, -LOOKBACK_DAYS)
    const until = addDays(today, 1)

    const [planRes, doseRes, itemRes] = await Promise.all([
      cloud.database
        .from('medication_plans')
        .select('id, item_id, member_id')
        .eq('household_id', hid)
        .limit(200),
      cloud.database
        .from('medication_doses')
        .select('id, plan_id, scheduled_at, confirmed_at, status')
        .eq('household_id', hid)
        .gte('scheduled_at', since.toISOString())
        .lt('scheduled_at', until.toISOString())
        .order('scheduled_at', { ascending: true })
        .limit(1000),
      cloud.database
        .from('items')
        .select('id, name')
        .eq('household_id', hid)
        .limit(500),
    ])

    const err = planRes.error || doseRes.error || itemRes.error
    if (err) {
      this.setData({ loading: false, loadError: err.message || '数据加载失败' })
      return
    }

    const itemName = {}
    ;(itemRes.data || []).forEach(function (i) {
      itemName[i.id] = i.name
    })

    const myPlanIds = {}
    const planItemName = {}
    ;(planRes.data || []).forEach(function (p) {
      if (String(p.member_id) !== String(memberId)) return
      myPlanIds[p.id] = true
      planItemName[p.id] = itemName[p.item_id] || '未知药品'
    })

    const myDoses = (doseRes.data || []).filter(function (d) {
      return myPlanIds[d.plan_id]
    })

    this.raw = { doses: myDoses, planItemName: planItemName }
    this.setData({ loading: false })
    this.compute()
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
          name: raw.planItemName[d.plan_id] || '未知药品',
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
        rate: dayRate === null ? 0 : dayRate,
        hasData: dayDenom > 0,
        taken: cell.taken,
        missed: cell.missed,
        barH: dayDenom > 0 ? Math.max(6, Math.round((dayRate / 100) * BAR_MAX)) : 4,
        barClass: dayDenom > 0 ? 'bar-' + tierOf(dayRate) : 'bar-empty',
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
      rateClass: rate === null ? '' : 'rate-' + tierOf(rate),
      chart: chart,
      missedList: missedList,
    })
  },
})
