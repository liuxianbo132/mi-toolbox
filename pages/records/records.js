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
})
