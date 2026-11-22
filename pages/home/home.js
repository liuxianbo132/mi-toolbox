const { cloud } = require('../../utils/cloud')
const { toDateOnly, daysUntil, urgencyLevel, effectiveExpiry } = require('../../utils/date')
const { askExpirySubscribe } = require('../../utils/subscribe')
const { categoryLabel } = require('../../utils/constants')

// 看板首屏订阅授权只打扰一次的本地标记
const BOARD_SUB_ASKED_KEY = 'mi_board_sub_asked_v1'

Page({
  data: {
    authState: 'checking',
    household: null,
    loginError: '',
    loginLoading: false,
    createName: '',
    joinCode: '',
    familyBusy: false,
    // V2 Step1：三分区（已过期 / 危险期 / 警告期）
    zones: [
      { key: 'expired', title: '已过期', items: [] },
      { key: 'danger', title: '危险期', items: [] },
      { key: 'warn', title: '警告期', items: [] },
    ],
    stats: { expired: 0, danger: 0, warn: 0 },
    missedToday: 0, // 今日漏服剂量数（M2a 提醒条）
  },

  onShow() {
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
      this.setData({ authState: 'signed-in' })
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
    if (!uid) return
    const { data: mine, error } = await cloud.database
      .from('members')
      .select('household_id, role, households(id, name, invite_code)')
      .eq('owner_id', uid)
      .limit(1)
    if (error) {
      wx.showToast({ title: error.message, icon: 'none' })
      return
    }
    const row = mine && mine[0]
    if (!row || !row.households) {
      this.setData({
        household: null,
        zones: [
          { key: 'expired', title: '已过期', items: [] },
          { key: 'danger', title: '危险期', items: [] },
          { key: 'warn', title: '警告期', items: [] },
        ],
        stats: { expired: 0, danger: 0, warn: 0 },
      })
      return
    }
    this.setData({
      household: { id: row.household_id, name: row.households.name, invite_code: row.households.invite_code },
    })
    this.askBoardSubscribeOnce()
    this.loadUrgent(row.household_id)
    this.loadDoseAlert(row.household_id)
  },

  // 任务5：看板首屏埋一次订阅授权（storage 防重复打扰；模板 id 未下发时静默跳过、不记标记）
  askBoardSubscribeOnce() {
    if (wx.getStorageSync(BOARD_SUB_ASKED_KEY)) return
    if (askExpirySubscribe()) {
      wx.setStorageSync(BOARD_SUB_ASKED_KEY, '1')
    }
  },

  // V2 Step1：看板三分区卡片列表（已过期 / 危险期 / 警告期）
  // 契约 v1.5 #13：有 opened_at 的批次按 min(到期日, 开封到期日) 分级与排序
  async loadUrgent(hid) {
    const { data, error } = await cloud.database
      .from('batches')
      .select('id, item_id, expiry_date, opened_at, quantity, unit, status, items(name, category, pao_days)')
      .eq('household_id', hid)
      .eq('status', 'active')
      .order('expiry_date', { ascending: true })
      .limit(50)
    if (error) {
      wx.showToast({ title: error.message, icon: 'none' })
      return
    }
    let expired = 0
    let danger = 0
    let warn = 0
    const zones = [
      { key: 'expired', title: '已过期', items: [] },
      { key: 'danger', title: '危险期', items: [] },
      { key: 'warn', title: '警告期', items: [] },
    ]
    ;(data || []).forEach((b) => {
      const baseDate = effectiveExpiry(b.expiry_date, b.opened_at, b.items && b.items.pao_days)
      const d = daysUntil(baseDate)
      const cat = b.items && b.items.category
      const t = cat === 'medicine' ? { danger: 7, warn: 90 } : { danger: 3, warn: 7 }
      const level = urgencyLevel(d, t)
      if (level === 'ok') return
      const entry = {
        id: b.id,
        item_id: b.item_id,
        name: (b.items && b.items.name) || '未知物品',
        catLabel: categoryLabel(cat),
        qtyText: (b.quantity != null ? b.quantity : '') + (b.unit ? ' ' + b.unit : ''),
        expiry: baseDate,
        days: d,
        daysBig: Math.abs(d) + ' 天',
        daysLabel: d < 0 ? '已超期' : d === 0 ? '今天到期' : '剩余',
      }
      if (level === 'expired') {
        expired++
        zones[0].items.push(entry)
      } else if (level === 'danger') {
        danger++
        zones[1].items.push(entry)
      } else {
        warn++
        zones[2].items.push(entry)
      }
    })
    // 契约 v1.5：分区内排序按实际到期日
    zones.forEach(function (z) {
      z.items.sort(function (a, b) {
        return a.expiry < b.expiry ? -1 : a.expiry > b.expiry ? 1 : 0
      })
    })
    this.setData({ zones: zones, stats: { expired: expired, danger: danger, warn: warn } })
  },

  // 任务4：看板条目点击进物品详情（条目是批次，跳其所属物品）
  // 今日漏服提醒（M2a）：cron 翻转的 missed 剂量数 → 顶部红条
  async loadDoseAlert(hid) {    const now = new Date()
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const end = new Date(start.getTime() + 86400000)
    const { data, error } = await cloud.database
      .from('medication_doses')
      .select('id, status, scheduled_at')
      .eq('household_id', hid)
      .eq('status', 'missed')
      .gte('scheduled_at', start.toISOString())
      .lt('scheduled_at', end.toISOString())
    if (error) return
    this.setData({ missedToday: (data || []).length })
  },

  goMedication() {
    wx.switchTab({ url: '/pages/medication/medication' })
  },

  goDetail(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: '/pages/item/item?id=' + id })
  },

  onCreateNameInput(e) {
    this.setData({ createName: e.detail.value })
  },

  onJoinCodeInput(e) {
    this.setData({ joinCode: e.detail.value })
  },

  // 创建家庭：契约 v1.2/v1.4 改调 create_household RPC——原子建 households+owner 成员，
  // invite_code 服务端生成；owner nickname 不落库，成员列表由前端以 session 用户名兜底显示；
  // 空家庭名 = 前端校验 + RPC RAISE EXCEPTION 双保险
  async createHousehold() {
    const name = (this.data.createName || '').trim()
    if (!name) {
      wx.showToast({ title: '请填写家庭名称', icon: 'none' })
      return
    }
    this.setData({ familyBusy: true })
    const res = await cloud.database.rpc('create_household', { p_name: name })
    this.setData({ familyBusy: false })
    if (res.error) {
      wx.showToast({ title: (res.error && res.error.message) || '创建失败', icon: 'none' })
      return
    }
    if (res.data === 'already_joined') {
      wx.showToast({ title: '已在家庭中，请先退出再加入', icon: 'none' })
      await this.loadHousehold()
      return
    }
    if (res.data === 'not_signed_in') {
      wx.showToast({ title: '请先登录', icon: 'none' })
      return
    }
    await this.loadHousehold()
  },

  async joinHousehold() {
    const code = (this.data.joinCode || '').trim()
    if (!code) {
      wx.showToast({ title: '请填写邀请码', icon: 'none' })
      return
    }
    this.setData({ familyBusy: true })
    const res = await cloud.database.rpc('join_household', { p_code: code })
    this.setData({ familyBusy: false })
    if (res.error) {
      wx.showToast({ title: res.error.message, icon: 'none' })
      return
    }
    if (res.data === 'not_found') {
      wx.showToast({ title: '邀请码不存在', icon: 'none' })
      return
    }
    if (res.data === 'already_joined') {
      // 一人一家庭（契约 v1.2）：调用者已有任一家庭时返回；文案指向退出路径
      wx.showToast({ title: '已在家庭中，请先退出再加入', icon: 'none' })
      await this.loadHousehold()
      return
    }
    if (res.data === 'not_signed_in') {
      wx.showToast({ title: '请先登录', icon: 'none' })
      return
    }
    await this.loadHousehold()
  },
})
