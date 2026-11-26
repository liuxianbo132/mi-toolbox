const { cloud } = require('../../utils/cloud')
const { toDateOnly } = require('../../utils/date')

// 操作记录查看页（v2-brief Step4）：时间倒序，操作人 + 动作 + 物品名 + 数量 + 时间，limit 100
const ACTION_LABEL = { create: '入库', open: '开封', use_up: '用完', discard: '报废' }
const ACTION_CLASS = { create: 'tag-green', open: 'rec-open', use_up: 'rec-ghost', discard: 'tag-red' }

function pad2(n) {
  return String(n).padStart(2, '0')
}

function formatTime(iso) {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return { day: '日期未知', time: '' }
  return { day: toDateOnly(d), time: pad2(d.getHours()) + ':' + pad2(d.getMinutes()) }
}

Page({
  data: {
    largeText: false,
    authState: 'checking',
    pageError: '',
    recordsState: 'loading',
    summaryState: 'loading',
    recordsLimited: false,
    loginLoading: false,
    loginError: '',
    recordGroups: [],
    filter: 'all',
    filters: [
      { key: 'all', label: '全部' },
      { key: 'create', label: '入库' },
      { key: 'open', label: '开封' },
      { key: 'use_up', label: '用完' },
      { key: 'discard', label: '报废' },
    ],
    // 本月概览（records 聚合：四类动作 + 消耗率 + 报废提示）
    summary: null,
  },

  onShow() {
    this.setData({ largeText: getApp().globalData.largeText })
    this.restore()
  },

  async restore() {
    const request = (this.loadRequest || 0) + 1
    this.loadRequest = request
    this.rawRecords = []
    this.setData({ authState: 'checking', pageError: '', recordsLimited: false, recordGroups: [], summary: null })
    try {
      const { data: session, error } = await getApp().ensureSession()
      if (this.loadRequest !== request) return
      if (error) throw error
      const uid = session && session.user && session.user.id
      if (!uid) {
        this.setData({ authState: 'signed-out' })
        return
      }
      const membership = await cloud.database.from('members').select('household_id').eq('owner_id', uid).limit(1)
      if (this.loadRequest !== request) return
      if (membership.error) throw membership.error
      const row = membership.data && membership.data[0]
      if (!row) {
        this.setData({ authState: 'no-household' })
        return
      }
      this.setData({ authState: 'ready', recordsState: 'loading', summaryState: 'loading' })
      await Promise.all([
        this.loadRecords(row.household_id, request).catch(() => {
          if (this.loadRequest === request) this.setData({ recordsState: 'error' })
        }),
        this.loadMonthlySummary(row.household_id, request).catch(() => {
          if (this.loadRequest === request) this.setData({ summaryState: 'error' })
        }),
      ])
    } catch (e) {
      if (this.loadRequest === request) this.setData({ authState: 'error', pageError: '请检查网络连接后重试' })
    }
  },

  retryrecords() { this.restore() },

  async onwechatlogin() {
    if (this.data.loginLoading) return
    this.setData({ loginLoading: true, loginError: '' })
    try {
      const { data, error } = await getApp().loginWithWechat()
      if (error || !data) throw error || new Error('登录失败')
      await this.restore()
    } catch (error) {
      this.setData({ loginError: error.message || '登录失败' })
    } finally {
      this.setData({ loginLoading: false })
    }
  },

  async loadRecords(hid, request) {
    const { data, error } = await cloud.database
      .from('records')
      .select('id, action, quantity, note, owner_name, created_at')
      .eq('household_id', hid)
      .order('created_at', { ascending: false })
      .limit(101)
    if (this.loadRequest !== request) return
    if (error) throw error
    const rows = data || []
    this.rawRecords = rows.slice(0, 100).map(function (r) {
      const when = formatTime(r.created_at)
      return {
        id: r.id,
        action: r.action,
        actionLabel: ACTION_LABEL[r.action] || r.action,
        actionClass: ACTION_CLASS[r.action] || 'rec-ghost',
        itemName: r.note || '—',
        qtyText: r.quantity != null ? String(r.quantity) : '',
        ownerName: r.owner_name || '成员',
        day: when.day,
        timeText: when.time,
      }
    })
    this.setData({ recordsState: 'ready', recordsLimited: rows.length > 100 }, () => this.applyFilter())
  },

  // 纯前端筛选：all 展示全部，其余按 action 精确匹配
  applyFilter() {
    const filter = this.data.filter
    const raw = this.rawRecords || []
    const records =
      filter === 'all'
        ? raw
        : raw.filter(function (r) {
            return r.action === filter
          })
    const groups = []
    for (const record of records) {
      let current = groups[groups.length - 1]
      if (!current || current.day !== record.day) {
        current = { day: record.day, rows: [] }
        groups.push(current)
      }
      current.rows.push(record)
    }
    this.setData({ recordGroups: groups })
  },

  onfilter(e) {
    const key = e.currentTarget.dataset.key
    if (!key || key === this.data.filter) return
    this.setData({ filter: key }, () => this.applyFilter())
  },

  // 本月概览：四类动作计数 + 消耗率（用完 ÷（用完+报废））+ 报废涉及物品数
  // 口径说明：消耗率越高说明越"用光而不是扔掉"；报废=浪费信号
  async loadMonthlySummary(hid, request) {
    const now = new Date()
    const start = new Date(now.getFullYear(), now.getMonth(), 1)
    const { data, error } = await cloud.database
      .from('records')
      .select('id, action, note, created_at')
      .eq('household_id', hid)
      .gte('created_at', start.toISOString())
      .order('created_at', { ascending: false })
      .limit(1001)
    if (this.loadRequest !== request) return
    if (error) throw error
    const allRows = data || []
    const rows = allRows.slice(0, 1000)
    if (!rows.length) {
      this.setData({ summary: null, summaryState: 'ready' })
      return
    }
    const counts = { create: 0, open: 0, use_up: 0, discard: 0 }
    const discardNotes = new Set()
    rows.forEach(function (r) {
      if (counts[r.action] != null) counts[r.action]++
      if (r.action === 'discard') discardNotes.add(r.note || '未命名')
    })
    const denom = counts.use_up + counts.discard
    const rate = denom > 0 ? Math.round((counts.use_up / denom) * 100) : null
    this.setData({
      summaryState: 'ready',
      summary: {
        total: rows.length,
        create: counts.create,
        open: counts.open,
        use_up: counts.use_up,
        discard: counts.discard,
        discardItems: discardNotes.size,
        consumeRate: rate === null ? 0 : rate,
        rateText: rate === null ? '—' : rate + '%',
        wasteText:
          counts.discard > 0
            ? '本月报废 ' + counts.discard + ' 次，涉及 ' + discardNotes.size + ' 种物品'
            : '本月没有报废记录',
        capped: allRows.length >= 1000,
      },
    })
  },
})
