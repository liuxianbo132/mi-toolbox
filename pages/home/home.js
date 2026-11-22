const { cloud } = require('../../utils/cloud')
const { toDateOnly, daysUntil, urgencyLevel, effectiveExpiry } = require('../../utils/date')
const { askExpirySubscribe } = require('../../utils/subscribe')
const { categoryLabel, categoryIllustration } = require('../../utils/constants')

// 看板首屏订阅授权只打扰一次的本地标记
const BOARD_SUB_ASKED_KEY = 'mi_board_sub_asked_v1'

function emptyZones() {
  return [
    { key: 'expired', title: '已过期', items: [] },
    { key: 'danger', title: '危险期', items: [] },
    { key: 'warn', title: '警告期', items: [] },
  ]
}

function greetingText() {
  const h = new Date().getHours()
  if (h < 6) return '夜深了'
  if (h < 11) return '早上好'
  if (h < 14) return '中午好'
  if (h < 18) return '下午好'
  return '晚上好'
}

function hhmm(iso) {
  const d = new Date(iso)
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}

const DOSE_TAG = {
  pending: { text: '待服', cls: 'tag-amber' },
  taken: { text: '已服', cls: 'tag-green' },
  missed: { text: '漏服', cls: 'tag-red' },
}

Page({
  data: {
    authState: 'checking',
    household: null,
    loginError: '',
    loginLoading: false,
    createName: '',
    joinCode: '',
    familyBusy: false,
    greeting: greetingText(),
    // 三分区（已过期 / 危险期 / 警告期）
    zones: emptyZones(),
    stats: { expired: 0, danger: 0, warn: 0, safe: 0 },
    missedToday: 0, // 今日漏服剂量数（M2a 提醒条）
    todayDoses: [],
    todayDoseTotal: 0,
    streakDays: 0,
  },

  onShow() {
    this.setData({ greeting: greetingText() })
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
        zones: emptyZones(),
        stats: { expired: 0, danger: 0, warn: 0, safe: 0 },
        todayDoses: [],
        streakDays: 0,
      })
      return
    }
    this.setData({
      household: { id: row.household_id, name: row.households.name, invite_code: row.households.invite_code },
    })
    const hid = row.household_id
    this.askBoardSubscribeOnce()
    this.loadUrgent(hid)
    this.loadDoseAlert(hid)
    this.loadTodayDoses(hid)
    this.loadStreak(hid)
  },

  // 任务5：看板首屏埋一次订阅授权（storage 防重复打扰；模板 id 未下发时静默跳过、不记标记）
  askBoardSubscribeOnce() {
    if (wx.getStorageSync(BOARD_SUB_ASKED_KEY)) return
    if (askExpirySubscribe()) {
      wx.setStorageSync(BOARD_SUB_ASKED_KEY, '1')
    }
  },

  // 看板三分区卡片列表（已过期 / 危险期 / 警告期）+ 安全批次计数
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
    let safe = 0
    const zones = emptyZones()
    ;(data || []).forEach((b) => {
      const baseDate = effectiveExpiry(b.expiry_date, b.opened_at, b.items && b.items.pao_days)
      const d = daysUntil(baseDate)
      const cat = b.items && b.items.category
      const t = cat === 'medicine' ? { danger: 7, warn: 90 } : { danger: 3, warn: 7 }
      const level = urgencyLevel(d, t)
      if (level === 'ok') {
        safe++
        return
      }
      const entry = {
        id: b.id,
        item_id: b.item_id,
        name: (b.items && b.items.name) || '未知物品',
        catLabel: categoryLabel(cat),
        illu: categoryIllustration(cat),
        qtyText: (b.quantity != null ? b.quantity : '') + (b.unit ? ' ' + b.unit : ''),
        expiry: baseDate,
        days: d,
        daysBig: Math.abs(d) + ' 天',
        daysLabel: d < 0 ? '已超期' + Math.abs(d) + ' 天' : d === 0 ? '今天到期' : d + ' 天后到期',
        tagText: level === 'expired' ? '需处理' : level === 'danger' ? '尽快用' : '留意',
        tagClass: level === 'warn' ? 'tag-amber' : 'tag-red',
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
    this.setData({ zones: zones, stats: { expired: expired, danger: danger, warn: warn, safe: safe } })
  },

  // 今日用药摘要（最多 4 条；顺序按 scheduled_at）
  async loadTodayDoses(hid) {
    const now = new Date()
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const end = new Date(start.getTime() + 86400000)
    const doseRes = await cloud.database
      .from('medication_doses')
      .select('id, plan_id, scheduled_at, status')
      .eq('household_id', hid)
      .gte('scheduled_at', start.toISOString())
      .lt('scheduled_at', end.toISOString())
      .order('scheduled_at', { ascending: true })
      .limit(20)
    const doses = doseRes.data || []
    if (!doses.length) {
      this.setData({ todayDoses: [], todayDoseTotal: 0 })
      return
    }
    const planRes = await cloud.database
      .from('medication_plans')
      .select('id, item_id, member_id')
      .eq('household_id', hid)
      .limit(100)
    const itemRes = await cloud.database.from('items').select('id, name').eq('household_id', hid).limit(200)
    const memRes = await cloud.database.from('members').select('id, nickname').eq('household_id', hid)
    const planMap = {}
    ;(planRes.data || []).forEach(function (p) { planMap[p.id] = p })
    const itemMap = {}
    ;(itemRes.data || []).forEach(function (i) { itemMap[i.id] = i.name })
    const memMap = {}
    ;(memRes.data || []).forEach(function (m) { memMap[m.id] = m.nickname || '成员' })
    const list = doses.map(function (d) {
      const p = planMap[d.plan_id] || {}
      const tag = DOSE_TAG[d.status] || DOSE_TAG.pending
      return {
        id: d.id,
        time: hhmm(d.scheduled_at),
        name: itemMap[p.item_id] || '未知药品',
        memberName: memMap[p.member_id] || '',
        tagText: tag.text,
        tagClass: tag.cls,
      }
    })
    this.setData({ todayDoses: list.slice(0, 4), todayDoseTotal: list.length })
  },

  // 今日漏服提醒（M2a）：cron 翻转的 missed 剂量数 → 顶部红条
  async loadDoseAlert(hid) {
    const now = new Date()
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

  // 连续打卡（口径：本人全勤连续——当天本人所有应完成剂量全部 taken 才计一天；
  // 有 missed 或已过点未打卡则中断；无任务日跳过不计；今天未到点的 pending 不算中断）
  async loadStreak(hid) {
    const { data: session } = await cloud.auth.getSession()
    const uid = session && session.user && session.user.id
    if (!uid) return
    const memRes = await cloud.database.from('members').select('id, owner_id').eq('household_id', hid)
    const me = (memRes.data || []).filter(function (m) { return m.owner_id === uid })[0]
    if (!me) {
      this.setData({ streakDays: 0 })
      return
    }
    const planRes = await cloud.database.from('medication_plans').select('id, member_id').eq('household_id', hid)
    const myIds = (planRes.data || [])
      .filter(function (p) { return String(p.member_id) === String(me.id) })
      .map(function (p) { return p.id })
    if (!myIds.length) {
      this.setData({ streakDays: 0 })
      return
    }
    const since = new Date(Date.now() - 31 * 86400000).toISOString()
    const doseRes = await cloud.database
      .from('medication_doses')
      .select('id, plan_id, scheduled_at, status')
      .eq('household_id', hid)
      .gte('scheduled_at', since)
      .order('scheduled_at', { ascending: true })
      .limit(1000)
    const mine = (doseRes.data || []).filter(function (d) { return myIds.indexOf(d.plan_id) >= 0 })
    const byDay = {}
    mine.forEach(function (d) {
      const key = toDateOnly(new Date(d.scheduled_at))
      if (!byDay[key]) byDay[key] = []
      byDay[key].push(d)
    })
    const nowMs = Date.now()
    let streak = 0
    const cursor = new Date()
    cursor.setHours(0, 0, 0, 0)
    for (let i = 0; i < 35; i++) {
      const key = toDateOnly(cursor)
      const arr = byDay[key]
      if (arr && arr.length) {
        const allTaken = arr.every(function (d) { return d.status === 'taken' })
        const hasMissed = arr.some(function (d) { return d.status === 'missed' })
        const overduePending = arr.some(function (d) {
          return d.status === 'pending' && new Date(d.scheduled_at).getTime() < nowMs
        })
        if (allTaken) {
          streak++
        } else if (hasMissed || overduePending) {
          break
        }
        // 其余情况（仅今天未到点的 pending）：跳过当天继续回看
      }
      cursor.setDate(cursor.getDate() - 1)
    }
    this.setData({ streakDays: streak })
  },

  goMedication() {
    wx.switchTab({ url: '/pages/medication/medication' })
  },

  goInventory() {
    wx.switchTab({ url: '/pages/inventory/inventory' })
  },

  goProfile() {
    wx.switchTab({ url: '/pages/profile/profile' })
  },

  goScan() {
    wx.navigateTo({ url: '/pages/scan/scan' })
  },

  goAdd() {
    wx.navigateTo({ url: '/pages/item-form/item-form' })
  },

  goPlan() {
    wx.navigateTo({ url: '/pages/plan-form/plan-form' })
  },

  goLocations() {
    wx.navigateTo({ url: '/pages/locations/locations' })
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
