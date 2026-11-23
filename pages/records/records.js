const { cloud } = require('../../utils/cloud')

// 操作记录查看页（v2-brief Step4）：时间倒序，操作人 + 动作 + 物品名 + 数量 + 时间，limit 100
const ACTION_LABEL = { create: '入库', open: '开封', use_up: '用完', discard: '报废' }
const ACTION_CLASS = { create: 'tag-green', open: 'rec-open', use_up: 'rec-ghost', discard: 'tag-red' }

function pad2(n) {
  return String(n).padStart(2, '0')
}

function formatTime(iso) {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return d.getMonth() + 1 + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())
}

Page({
  data: {
    largeText: false,
    authState: 'checking', // checking | signed-out | no-household | ready
    loginLoading: false,
    loginError: '',
    records: [],
    // 本月概览（records 聚合：四类动作 + 消耗率 + 报废提示）
    summary: null,
  },

  onShow() {
    this.setData({ largeText: getApp().globalData.largeText })
    this.restore()
  },

  async restore() {
    this.setData({ authState: 'checking' })
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

  async onWechatLogin() {
    this.setData({ loginLoading: true, loginError: '' })
    const res = await getApp().loginWithWechat()
    this.setData({ loginLoading: false })
    if (res.error || !res.data) {
      this.setData({ loginError: (res.error && res.error.message) || '登录失败' })
      return
    }
    this.restore()
  },

  async loadHousehold() {
    const { data: session } = await cloud.auth.getSession()
    const uid = session && session.user && session.user.id
    if (!uid) {
      this.setData({ authState: 'signed-out' })
      return
    }
    const { data: mine } = await cloud.database
      .from('members')
      .select('household_id')
      .eq('owner_id', uid)
      .limit(1)
    const row = mine && mine[0]
    if (!row) {
      this.setData({ authState: 'no-household' })
      return
    }
    this.setData({ authState: 'ready' })
    await this.loadRecords(row.household_id)
    this.loadMonthlySummary(row.household_id)
  },

  async loadRecords(hid) {
    const { data, error } = await cloud.database
      .from('records')
      .select('id, batch_id, action, quantity, note, owner_name, created_at')
      .eq('household_id', hid)
      .order('created_at', { ascending: false })
      .limit(100)
    if (error) {
      wx.showToast({ title: error.message, icon: 'none' })
      return
    }
    const records = (data || []).map(function (r) {
      return {
        id: r.id,
        actionLabel: ACTION_LABEL[r.action] || r.action,
        actionClass: ACTION_CLASS[r.action] || 'rec-ghost',
        itemName: r.note || '—',
        qtyText: r.quantity != null ? String(r.quantity) : '',
        ownerName: r.owner_name || '成员',
        timeText: formatTime(r.created_at),
      }
    })
    this.setData({ records: records })
  },

  // 本月概览：四类动作计数 + 消耗率（用完 ÷（用完+报废））+ 报废涉及物品数
  // 口径说明：消耗率越高说明越"用光而不是扔掉"；报废=浪费信号
  async loadMonthlySummary(hid) {
    const now = new Date()
    const start = new Date(now.getFullYear(), now.getMonth(), 1)
    const { data, error } = await cloud.database
      .from('records')
      .select('id, action, note, created_at')
      .eq('household_id', hid)
      .gte('created_at', start.toISOString())
      .order('created_at', { ascending: false })
      .limit(1000)
    if (error) return
    const rows = data || []
    if (!rows.length) {
      this.setData({ summary: null })
      return
    }
    const counts = { create: 0, open: 0, use_up: 0, discard: 0 }
    const discardNotes = {}
    rows.forEach(function (r) {
      if (counts[r.action] != null) counts[r.action]++
      if (r.action === 'discard') discardNotes[r.note || '未命名'] = true
    })
    const denom = counts.use_up + counts.discard
    const rate = denom > 0 ? Math.round((counts.use_up / denom) * 100) : null
    this.setData({
      summary: {
        total: rows.length,
        create: counts.create,
        open: counts.open,
        use_up: counts.use_up,
        discard: counts.discard,
        discardItems: Object.keys(discardNotes).length,
        consumeRate: rate === null ? 0 : rate,
        rateText: rate === null ? '—' : rate + '%',
        wasteText:
          counts.discard > 0
            ? '本月报废 ' + counts.discard + ' 次，涉及 ' + Object.keys(discardNotes).length + ' 种物品'
            : '本月没有报废记录',
        capped: rows.length >= 1000,
      },
    })
  },
})
