const { cloud } = require('../../utils/cloud')
const { toDateOnly, daysUntil, urgencyLevel, effectiveExpiry } = require('../../utils/date')
const { askExpirySubscribe } = require('../../utils/subscribe')
const { itemIllustration } = require('../../utils/constants')
const { addStockQuantity, stockQuantity } = require('../../utils/stock-quantity')

const BOARD_SUB_ASKED_KEY = 'mi_board_sub_asked_v1'
const URGENT_PREVIEW_SIZE = 4
const URGENT_PAGE_SIZE = 20
const PAGE_SIZE = 500
const MAX_BATCHES = 3000
const MAX_ITEMS = 1000
const MAX_DOSES = 500

function hhmm(iso) {
  const d = new Date(iso)
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}

function stockThreshold(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

Page({
  data: {
    largeText: false,
    authState: 'checking',
    household: null,
    householdLoading: true,
    householdError: '',
    householdErrorTitle: '',
    loginError: '',
    loginLoading: false,
    createName: '',
    joinCode: '',
    familyBusy: false,
    urgentState: 'loading',
    urgentLimited: false,
    urgentRows: [],
    allUrgent: false,
    hasMoreUrgent: false,
    urgentPage: 0,
    urgentPageCount: 0,
    stats: { expired: 0, danger: 0, warn: 0, safe: 0 },
    undatedCount: 0,
    missedToday: 0,
    takenToday: 0,
    pendingToday: 0,
    todayDoseTotal: 0,
    nextDose: null,
    medicationSummaryState: 'loading',
    medicationLimited: false,
    streakDays: 0,
    restockCount: 0,
    restockState: 'loading',
  },

  onShow() {
    this.setData({ largeText: getApp().globalData.largeText })
    this.restore()
  },

  async restore() {
    const request = (this.restoreRequest || 0) + 1
    this.restoreRequest = request
    this.boardContext = null
    this.urgentRisks = []
    this.setData({ authState: 'checking', household: null, householdLoading: true, householdError: '' })
    let session
    try {
      const result = await getApp().ensureSession()
      if (result.error) throw result.error
      session = result.data
    } catch (error) {
      if (request === this.restoreRequest) {
        this.setData({
          authState: 'error',
          householdLoading: false,
          householdErrorTitle: '暂时无法验证登录状态',
          householdError: '请检查网络连接后重试',
        })
      }
      return
    }
    if (request !== this.restoreRequest) return
    const userId = session && session.user && session.user.id
    if (!userId) {
      this.setData({ authState: 'signed-out', householdLoading: false, createName: '', joinCode: '' })
      return
    }
    this.setData({ authState: 'signed-in' })
    try {
      const { data: mine, error } = await cloud.database
        .from('members')
        .select('id, household_id, households(id, name)')
        .eq('owner_id', userId)
        .limit(1)
      if (error) throw error
      if (request !== this.restoreRequest) return
      const row = mine && mine[0]
      if (!row) {
        this.setData({ householdLoading: false })
        return
      }
      if (!row.households) throw new Error('家庭记录不可用')
      const context = { householdId: row.household_id, memberId: row.id }
      this.boardContext = context
      this.setData({
        household: { id: row.household_id, name: row.households.name },
        householdLoading: false,
        urgentState: 'loading',
        urgentLimited: false,
        urgentRows: [],
        allUrgent: false,
        hasMoreUrgent: false,
        urgentPage: 0,
        urgentPageCount: 0,
        medicationSummaryState: 'loading',
        streakDays: 0,
        restockCount: 0,
        restockState: 'loading',
      })
      this.loadStock(context)
      this.loadTodayDoses(context)
      this.loadStreak(context)
      this.askBoardSubscribeOnce()
    } catch (error) {
      if (request === this.restoreRequest) {
        this.setData({
          householdLoading: false,
          householdErrorTitle: '家庭信息暂时无法加载',
          householdError: '请检查网络连接后重试',
        })
      }
    }
  },

  retryhousehold() { this.restore() },
  retryurgent() {
    if (this.boardContext && this.data.urgentState !== 'loading') this.loadStock(this.boardContext)
  },
  retrymedication() {
    if (this.boardContext && this.data.medicationSummaryState !== 'loading') this.loadTodayDoses(this.boardContext)
  },

  async onwechatlogin() {
    if (this.data.loginLoading) return
    this.setData({ loginLoading: true, loginError: '' })
    try {
      const res = await getApp().loginWithWechat()
      if (res.error || !res.data) throw res.error || new Error('登录失败')
      await this.restore()
    } catch (error) {
      this.setData({ loginError: error.message || '登录失败，请重试' })
    } finally {
      this.setData({ loginLoading: false })
    }
  },

  askBoardSubscribeOnce() {
    try {
      if (wx.getStorageSync(BOARD_SUB_ASKED_KEY)) return
      if (askExpirySubscribe()) wx.setStorageSync(BOARD_SUB_ASKED_KEY, '1')
    } catch (_) {
      // 订阅提示和本地存储故障不影响已载入的家庭。
    }
  },

  async loadStock(context) {
    this.setData({ urgentState: 'loading', restockCount: 0, restockState: 'loading' })
    const hid = context.householdId
    const itemQuery = this.loadStockItems(hid).catch(() => null)
    try {
      const stats = { expired: 0, danger: 0, warn: 0, safe: 0 }
      const risks = []
      const quantities = new Map()
      let undatedCount = 0
      let urgentLimited = false
      for (let from = 0; from <= MAX_BATCHES; from += PAGE_SIZE) {
        const to = Math.min(from + PAGE_SIZE - 1, MAX_BATCHES)
        const { data, error } = await cloud.database
          .from('batches')
          .select('id, item_id, expiry_date, opened_at, quantity, unit, items(name, category, pao_days, is_deleted)')
          .eq('household_id', hid)
          .eq('status', 'active')
          .eq('is_deleted', false)
          .order('id', { ascending: true })
          .range(from, to)
        if (this.boardContext !== context) return
        if (error) throw error
        const rows = data || []
        urgentLimited = from + rows.length > MAX_BATCHES
        for (const batch of urgentLimited ? rows.slice(0, MAX_BATCHES - from) : rows) {
          const item = batch.items
          addStockQuantity(quantities, batch)
          if (!item || item.is_deleted) continue
          const expiry = effectiveExpiry(batch.expiry_date, batch.opened_at, item.pao_days)
          if (!expiry) {
            undatedCount++
            continue
          }
          const days = daysUntil(expiry)
          const thresholds = item.category === 'medicine' ? { danger: 7, warn: 90 } : { danger: 3, warn: 7 }
          const level = urgencyLevel(days, thresholds)
          if (level === 'ok') {
            stats.safe++
            continue
          }
          stats[level]++
          risks.push({ batch, item, days, level })
        }
        if (urgentLimited || rows.length < to - from + 1) break
      }
      const priority = { expired: 0, danger: 1, warn: 2 }
      risks.sort((a, b) => priority[a.level] - priority[b.level] || a.days - b.days)
      this.urgentRisks = risks
      this.setData({
        stats,
        undatedCount,
        urgentLimited,
        urgentState: 'ready',
        allUrgent: false,
        hasMoreUrgent: risks.length > URGENT_PREVIEW_SIZE,
        urgentPage: 0,
        urgentPageCount: Math.ceil(risks.length / URGENT_PAGE_SIZE),
        urgentRows: this.mapUrgentRows(risks.slice(0, URGENT_PREVIEW_SIZE)),
      })
      const items = await itemQuery
      if (this.boardContext !== context) return
      if (!items) {
        this.setData({ restockState: 'error' })
      } else if (urgentLimited || items.length > MAX_ITEMS) {
        this.setData({ restockState: 'limited' })
      } else {
        let restockCount = 0
        let restockState = 'ready'
        for (const item of items) {
          const stock = stockQuantity(quantities, item)
          if (stock.quantity === null) restockState = 'partial'
          else if (stock.quantity <= stockThreshold(item.low_stock_threshold)) restockCount++
        }
        this.setData({ restockCount, restockState })
      }
    } catch (error) {
      if (this.boardContext === context) this.setData({ urgentState: 'error', restockState: 'error' })
    }
  },

  async loadStockItems(hid) {
    const items = []
    for (let from = 0; from <= MAX_ITEMS; from += PAGE_SIZE) {
      const to = Math.min(from + PAGE_SIZE - 1, MAX_ITEMS)
      const { data, error } = await cloud.database
        .from('items')
        .select('id, unit, low_stock_threshold')
        .eq('household_id', hid)
        .eq('is_deleted', false)
        .order('id', { ascending: true })
        .range(from, to)
      if (error) throw error
      const rows = data || []
      items.push(...rows)
      if (rows.length < to - from + 1) break
    }
    return items
  },

  mapUrgentRows(risks) {
    return risks.map(({ batch, item, days, level }) => ({
      id: batch.id,
      itemId: batch.item_id,
      name: item.name,
      illustration: itemIllustration(item.name, item.category),
      qtyText: batch.quantity == null ? '' : String(batch.quantity) + (batch.unit ? ' ' + batch.unit : ''),
      daysLabel: days < 0 ? '已过期 ' + Math.abs(days) + ' 天' : days === 0 ? '今天到期' : days + ' 天后到期',
      tagText: level === 'expired' ? '需处理' : level === 'danger' ? '优先处理' : '临期',
      tagClass: level === 'expired' ? 'tag-red' : 'tag-amber',
    }))
  },

  toggleurgent() {
    const risks = this.urgentRisks
    if (!risks || this.data.urgentState !== 'ready') return
    const allUrgent = !this.data.allUrgent
    this.setData({
      allUrgent,
      urgentPage: allUrgent ? 1 : 0,
      urgentRows: this.mapUrgentRows(risks.slice(0, allUrgent ? URGENT_PAGE_SIZE : URGENT_PREVIEW_SIZE)),
    })
  },

  urgentpagination(e) {
    if (!this.data.allUrgent) return
    const page = this.data.urgentPage + Number(e.currentTarget.dataset.step)
    if (page < 1 || page > this.data.urgentPageCount) return
    const from = (page - 1) * URGENT_PAGE_SIZE
    this.setData({
      urgentPage: page,
      urgentRows: this.mapUrgentRows(this.urgentRisks.slice(from, from + URGENT_PAGE_SIZE)),
    })
  },

  async loadTodayDoses(context) {
    this.setData({ medicationSummaryState: 'loading' })
    try {
      const now = new Date()
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
      const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
      const { data, error } = await cloud.database
        .from('medication_doses')
        .select('plan_id, scheduled_at, status')
        .eq('household_id', context.householdId)
        .gte('scheduled_at', start.toISOString())
        .lt('scheduled_at', end.toISOString())
        .order('scheduled_at', { ascending: true })
        .limit(MAX_DOSES + 1)
      if (this.boardContext !== context) return
      if (error) throw error
      const rows = data || []
      const doses = rows.slice(0, MAX_DOSES)
      const pending = doses.filter((d) => d.status === 'pending')
      const next = pending[0]
      this.setData({
        todayDoseTotal: doses.length,
        takenToday: doses.filter((d) => d.status === 'taken').length,
        missedToday: doses.filter((d) => d.status === 'missed').length,
        pendingToday: pending.length,
        nextDose: next ? { time: hhmm(next.scheduled_at) } : null,
        medicationLimited: rows.length > MAX_DOSES,
        medicationSummaryState: 'ready',
      })
      if (!next) return
      try {
        const plan = await cloud.database
          .from('medication_plans')
          .select('items(name)')
          .eq('household_id', context.householdId)
          .eq('id', next.plan_id)
          .limit(1)
        if (this.boardContext !== context || plan.error) return
        const item = plan.data && plan.data[0] && plan.data[0].items
        if (item && item.name) this.setData({ 'nextDose.name': item.name })
      } catch (error) {
        // 药名查询失败时仍显示已读取的任务数量与时间。
      }
    } catch (error) {
      if (this.boardContext === context) this.setData({ medicationSummaryState: 'error' })
    }
  },

  async loadStreak(context) {
    try {
      const hid = context.householdId
      const planRes = await cloud.database.from('medication_plans').select('id')
        .eq('household_id', hid).eq('member_id', context.memberId).limit(MAX_DOSES + 1)
      if (this.boardContext !== context || planRes.error) return
      const plans = planRes.data || []
      if (!plans.length || plans.length > MAX_DOSES) return
      const planIds = new Set(plans.map((plan) => String(plan.id)))
      const today = new Date()
      const since = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 30)
      const end = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1)
      const doseRes = await cloud.database
        .from('medication_doses')
        .select('plan_id, scheduled_at, status')
        .eq('household_id', hid)
        .gte('scheduled_at', since.toISOString())
        .lt('scheduled_at', end.toISOString())
        .order('scheduled_at', { ascending: false })
        .limit(1001)
      if (this.boardContext !== context || doseRes.error) return
      const doses = doseRes.data || []
      if (doses.length >= 1000) return
      const byDay = {}
      for (const dose of doses) {
        if (!planIds.has(String(dose.plan_id))) continue
        const key = toDateOnly(new Date(dose.scheduled_at))
        if (!byDay[key]) byDay[key] = []
        byDay[key].push(dose)
      }
      const nowMs = today.getTime()
      let streakDays = 0
      const cursor = new Date(today.getFullYear(), today.getMonth(), today.getDate())
      while (cursor >= since) {
        const rows = byDay[toDateOnly(cursor)]
        if (rows && rows.length) {
          if (rows.every((dose) => dose.status === 'taken')) streakDays++
          else if (rows.some((dose) => dose.status !== 'taken' && !(dose.status === 'pending' && new Date(dose.scheduled_at).getTime() >= nowMs))) break
        }
        cursor.setDate(cursor.getDate() - 1)
      }
      this.setData({ streakDays })
    } catch (error) {
      // 连续打卡数据读取失败时不展示成就。
    }
  },

  gomedication() { wx.switchTab({ url: '/pages/medication/medication' }) },
  goinventory() { wx.switchTab({ url: '/pages/inventory/inventory' }) },
  goprofile() { wx.switchTab({ url: '/pages/profile/profile' }) },
  goscan() { wx.navigateTo({ url: '/pages/scan/scan' }) },
  goadd() { wx.navigateTo({ url: '/pages/item-form/item-form' }) },

  gorestockinventory() {
    const household = this.data.household
    if (!household) return
    getApp().globalData.pendingInventoryLowStockFilter = { householdId: String(household.id) }
    this.goinventory()
  },

  godetail(e) {
    const id = e.currentTarget.dataset.id
    if (id) wx.navigateTo({ url: '/pages/item/item?id=' + encodeURIComponent(id) })
  },

  oncreatenameinput(e) { this.setData({ createName: e.detail.value }) },
  onjoincodeinput(e) { this.setData({ joinCode: e.detail.value }) },

  createhousehold() {
    const name = this.data.createName.trim()
    if (!name) {
      wx.showToast({ title: '请填写家庭名称', icon: 'none' })
      return
    }
    return this.saveHousehold('create_household', { p_name: name })
  },

  joinhousehold() {
    const code = this.data.joinCode.trim()
    if (!code) {
      wx.showToast({ title: '请填写邀请码', icon: 'none' })
      return
    }
    return this.saveHousehold('join_household', { p_code: code })
  },

  async saveHousehold(action, args) {
    if (this.data.familyBusy) return
    this.setData({ familyBusy: true })
    try {
      const { data, error } = await cloud.database.rpc(action, args)
      if (error) throw error
      if (data === 'not_found' || data === 'not_signed_in') {
        wx.showToast({ title: data === 'not_found' ? '邀请码不存在' : '请先登录', icon: 'none' })
        return
      }
      if (data === 'invalid_name' || data === 'invite_unavailable') {
        wx.showToast({ title: data === 'invalid_name' ? '请填写 1–40 个字符的家庭名称' : '邀请码暂时无法生成，请重试', icon: 'none' })
        return
      }
      if (data === 'already_joined') wx.showToast({ title: '已加入家庭', icon: 'none' })
      await this.restore()
    } catch (error) {
      wx.showToast({ title: error.message || '操作未完成，请重试', icon: 'none' })
    } finally {
      this.setData({ familyBusy: false })
    }
  },
})
