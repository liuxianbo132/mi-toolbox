const { cloud } = require('../../utils/cloud')
const { CATEGORIES, categoryLabel, categoryIllustration, itemIllustration } = require('../../utils/constants')
const { daysUntil, effectiveExpiry, urgencyLevel } = require('../../utils/date')
const { addStockQuantity, stockQuantity } = require('../../utils/stock-quantity')

// 低库存口径：active 批次 quantity 之和 ≤ 阈值即库存不足；
// 阈值缺省（未设置）回落 0 —— 即「用光才提醒」，避免"只剩 1 件"把正常家庭物品全标成不足
const DEFAULT_LOW_STOCK_THRESHOLD = 0

function lowStockThreshold(value) {
  const n = Number(value)
  return value == null || !isFinite(n) ? DEFAULT_LOW_STOCK_THRESHOLD : n
}

async function loadPages(buildQuery, maxRows, pageSize) {
  const rows = []
  for (let from = 0; from <= maxRows; from += pageSize) {
    const end = Math.min(from + pageSize - 1, maxRows)
    const { data, error } = await buildQuery().range(from, end)
    if (error) throw error
    if (!Array.isArray(data)) throw new Error('库存响应不完整，请重试')
    rows.push.apply(rows, data)
    if (data.length < end - from + 1) break
  }
  return { rows: rows.slice(0, maxRows), limited: rows.length > maxRows }
}

Page({
  data: {
    authState: 'checking',
    largeText: false,
    household: null,
    loadError: '',
    loading: false,
    loginError: '',
    loginLoading: false,
    totalCount: 0,
    resultCount: 0,
    // V2 Step1：按品类分组（空组不显示）
    groups: [],
    searchText: '',
    categoryIndex: 0,
    categoryOptions: [{ value: 'all', label: '全部品类' }].concat(CATEGORIES.map(function (c) { return { value: c.value, label: c.label } })),
    locationIndex: 0,
    locationOptions: [{ id: 'all', name: '全部位置' }],
    sortIndex: 0,
    sortOptions: ['最近添加', '最早到期', '名称'],
    stockFilter: 'all',
    filtersOpen: false,
    filterSummary: '',
    itemsLimited: false,
    batchDataLimited: false,
    quantitiesUnknown: false,
  },

  onShow() {
    this.setData({ largeText: getApp().globalData.largeText })
    this.restore()
  },

  onUnload() {
    this.loadRequest = (this.loadRequest || 0) + 1
  },

  async restore() {
    const request = (this.loadRequest || 0) + 1
    this.loadRequest = request
    this.setData({ authState: 'checking', loadError: '' })
    const app = getApp()
    try {
      const { data: session, error } = await app.ensureSession()
      if (request !== this.loadRequest) return
      if (error) throw error
      const sessionVersion = app.sessionVersion
      const uid = session && session.user && session.user.id
      if (!uid) {
        app.globalData.pendingInventoryLowStockFilter = null
        this.clearInventoryData()
        this.sessionUserId = null
        this.setData({ authState: 'signed-out', household: null })
        return
      }
      this.setData({ authState: 'household-loading' })
      const { data: mine, error: memberError } = await cloud.database
        .from('members')
        .select('household_id')
        .eq('owner_id', uid)
        .is('left_at', null)
        .limit(1)
      if (request !== this.loadRequest) return
      if (sessionVersion !== app.sessionVersion) return this.restore()
      if (memberError) throw memberError
      if (!Array.isArray(mine) || (mine[0] && !mine[0].household_id)) throw new Error('家庭信息不完整，请重试')
      const hid = mine[0] && mine[0].household_id
      if (!hid) {
        app.globalData.pendingInventoryLowStockFilter = null
        this.clearInventoryData()
        this.setData({ authState: 'no-household', household: null })
        return
      }
      const previous = this.data.household
      const sameContext = previous && String(previous.id) === String(hid) && this.sessionUserId === uid
      const intent = app.globalData.pendingInventoryLowStockFilter
      const pendingLow = intent && String(intent.householdId) === String(hid)
      if (intent) app.globalData.pendingInventoryLowStockFilter = null
      this.sessionUserId = uid
      this.clearInventoryData(pendingLow || !sameContext, pendingLow ? 'low' : 'all')
      this.setData({ authState: 'ready', household: { id: hid }, loading: true })
      await this.loadItems(hid, request, sessionVersion)
    } catch (error) {
      if (request !== this.loadRequest) return
      this.clearInventoryData(false)
      const schemaUnavailable = error && (error.code === '42703' || /\bleft_at\b/.test(error.message || ''))
      this.setData({
        authState: 'error',
        loadError: schemaUnavailable ? '库存服务版本尚未同步，请稍后重试' : '暂时无法读取家庭库存，请检查网络后重试',
      })
    }
  },

  clearInventoryData(resetFilters, preferredStockFilter) {
    this.allItems = []
    const next = {
      totalCount: 0, resultCount: 0, groups: [],
      itemsLimited: false, batchDataLimited: false, quantitiesUnknown: false,
      loading: false,
    }
    if (resetFilters !== false) {
      next.locationOptions = [{ id: 'all', name: '全部位置' }]
      next.searchText = ''
      next.categoryIndex = 0
      next.locationIndex = 0
      next.sortIndex = 0
      next.stockFilter = preferredStockFilter === 'low' ? 'low' : 'all'
      next.filtersOpen = false
      next.filterSummary = ''
    }
    this.setData(next)
  },

  async loadItems(hid, request, sessionVersion) {
    const [items, batches, locRes] = await Promise.all([
      loadPages(() => cloud.database.from('items')
        .select('id, name, category, unit, brand, spec, barcode, created_at, low_stock_threshold, pao_days')
        .eq('household_id', hid).eq('is_deleted', false)
        .order('created_at', { ascending: false }).order('id', { ascending: false }), 1000, 100),
      loadPages(() => cloud.database.from('batches')
        .select('id, item_id, location_id, expiry_date, opened_at, quantity, unit')
        .eq('household_id', hid).eq('status', 'active').eq('is_deleted', false)
        .order('expiry_date', { ascending: true }).order('id', { ascending: true }), 3000, 500),
      cloud.database.from('locations').select('id, name').eq('household_id', hid).order('name', { ascending: true }),
    ])
    if (request !== this.loadRequest) return
    if (sessionVersion !== getApp().sessionVersion) return this.restore()
    if (locRes.error) throw locRes.error
    if (!Array.isArray(locRes.data)) throw new Error('存放位置信息不完整，请重试')
    const locMap = Object.create(null)
    locRes.data.forEach(function (l) { locMap[l.id] = l.name })
    const itemMap = Object.create(null)
    items.rows.forEach(function (row) { itemMap[row.id] = row })
    const itemLocSet = {}
    const earliestExpiry = {}
    const totals = new Map()
    batches.rows.forEach(function (b) {
      const item = itemMap[b.item_id]
      if (!item) return
      if (!itemLocSet[b.item_id]) itemLocSet[b.item_id] = {}
      if (locMap[b.location_id]) itemLocSet[b.item_id][b.location_id] = true
      const expiry = effectiveExpiry(b.expiry_date, b.opened_at, item.pao_days)
      if (expiry && (!earliestExpiry[b.item_id] || expiry < earliestExpiry[b.item_id])) earliestExpiry[b.item_id] = expiry
      addStockQuantity(totals, b)
    })
    this.allItems = items.rows.map(function (row) {
      const set = itemLocSet[row.id] || {}
      const ids = Object.keys(set)
      let locText = '未指定'
      let locKnown = false
      if (ids.length === 1) {
        const name = locMap[ids[0]]
        if (name) {
          locText = name
          locKnown = true
        }
      } else if (ids.length > 1) {
        locText = '多位置'
        locKnown = true
      }
      const { quantity: itemQty, unit } = stockQuantity(totals, row)
      const expiry = earliestExpiry[row.id] || ''
      const days = daysUntil(expiry)
      const level = urgencyLevel(days, row.category === 'medicine' ? { danger: 7, warn: 90 } : { danger: 3, warn: 7 })
      return Object.assign({}, row, {
        categoryLabel: categoryLabel(row.category),
        locText: locText,
        locKnown: locKnown,
        locationIds: ids.map(String),
        earliestExpiry: expiry,
        expiryLabel: days < 0 ? '已过期' : days === 0 ? '今天到期' : level === 'danger' || level === 'warn' ? '临期' : '',
        expiryClass: level === 'expired' || level === 'danger' ? 'expiry-risk' : 'expiry-soon',
        totalQty: itemQty,
        lowStock: !batches.limited && itemQty !== null && itemQty <= lowStockThreshold(row.low_stock_threshold),
        illu: itemIllustration(row.name, row.category),
        stockText: batches.limited || itemQty === null ? '数量待核对' : itemQty === 0 ? '已用完' : String(itemQty) + (unit ? ' ' + unit : ''),
      })
    })
    const locationOptions = [{ id: 'all', name: '全部位置' }].concat(locRes.data.map(function (l) { return { id: String(l.id), name: l.name } }))
    const oldLocation = this.data.locationOptions[this.data.locationIndex]
    const oldLocationId = oldLocation && oldLocation.id
    const matchedLocationIndex = oldLocationId ? locationOptions.findIndex(function (location) { return location.id === oldLocationId }) : -1
    this.applyFilters({
      totalCount: this.allItems.length,
      locationOptions: locationOptions,
      locationIndex: matchedLocationIndex >= 0 ? matchedLocationIndex : 0,
      itemsLimited: items.limited,
      batchDataLimited: batches.limited,
      quantitiesUnknown: this.allItems.some((item) => item.totalQty === null),
      loading: false,
    })
  },

  applyFilters(patch) {
    const filters = Object.assign({}, this.data, patch)
    const term = String(filters.searchText || '').trim().toLocaleLowerCase()
    // 防御：选项/index 不同步时（如位置列表收缩后）回落到第一项，避免越界崩溃
    const catOpt = filters.categoryOptions[filters.categoryIndex] || filters.categoryOptions[0]
    const locOpt = filters.locationOptions[filters.locationIndex] || filters.locationOptions[0]
    const category = catOpt ? catOpt.value : 'all'
    const locationId = locOpt ? locOpt.id : 'all'
    const sortIndex = filters.sortIndex
    const stockFilter = filters.stockFilter
    const items = (this.allItems || []).filter(function (item) {
      const matchesTerm = !term || [item.name, item.brand, item.spec, item.barcode].some(function (value) {
        return String(value || '').toLocaleLowerCase().indexOf(term) >= 0
      })
      const matchesCategory = category === 'all' || item.category === category || (category === 'other' && !CATEGORIES.some(function (c) { return c.value === item.category }))
      const matchesLocation = locationId === 'all' || (item.locationIds || []).indexOf(locationId) >= 0
      const matchesStock = stockFilter !== 'low' || item.lowStock
      return matchesTerm && matchesCategory && matchesLocation && matchesStock
    }).sort(function (a, b) {
      if (sortIndex === 1) return (a.earliestExpiry || '9999-12-31').localeCompare(b.earliestExpiry || '9999-12-31')
      if (sortIndex === 2) return String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN')
      return String(b.created_at || '').localeCompare(String(a.created_at || ''))
    })
    // 按品类分组，组头带计数，空组不显示
    const known = { food: true, medicine: true, daily: true, other: true }
    const groups = []
    CATEGORIES.forEach(function (c) {
      const list = items.filter(function (i) {
        return i.category === c.value || (c.value === 'other' && !known[i.category])
      })
      if (list.length > 0) {
        groups.push({ key: c.value, label: c.label, illu: categoryIllustration(c.value), count: list.length, items: list })
      }
    })
    const selected = []
    if (category !== 'all') selected.push(catOpt.label)
    if (locationId !== 'all') selected.push(locOpt.name)
    if (sortIndex !== 0) selected.push(filters.sortOptions[sortIndex])
    this.setData(Object.assign({}, patch, { resultCount: items.length, groups: groups, filterSummary: selected.join(' · ') }))
  },

  onSearchInput(e) {
    this.setData({ searchText: e.detail.value }, () => this.applyFilters())
  },

  onCategoryChange(e) {
    this.setData({ categoryIndex: Number(e.detail.value) }, () => this.applyFilters())
  },

  onLocationChange(e) {
    this.setData({ locationIndex: Number(e.detail.value) }, () => this.applyFilters())
  },

  onSortChange(e) {
    this.setData({ sortIndex: Number(e.detail.value) }, () => this.applyFilters())
  },

  onstockfiltertap(e) {
    const stockFilter = e.currentTarget.dataset.filter === 'low' ? 'low' : 'all'
    this.setData({ stockFilter: stockFilter }, () => this.applyFilters())
  },

  clearInventoryFilters() {
    this.setData({ searchText: '', categoryIndex: 0, locationIndex: 0, sortIndex: 0, stockFilter: 'all' }, () => this.applyFilters())
  },

  toggleFilters() { this.setData({ filtersOpen: !this.data.filtersOpen }) },

  clearinventoryfilters() { this.clearInventoryFilters() },

  retryInventoryLoad() {
    this.restore()
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

  goHome() {
    wx.switchTab({ url: '/pages/home/home' })
  },

  gohome() { this.goHome() },
  retryinventoryload() { this.retryInventoryLoad() },

  goCreate() {
    wx.navigateTo({ url: '/pages/item-form/item-form' })
  },

  gocreate() { this.goCreate() },

  // V2 Step3：扫码录入入口
  gobarcode() {
    wx.navigateTo({ url: '/pages/scan/scan' })
  },

  // V2 Step2：存放位置管理入口
  golocations() {
    wx.navigateTo({ url: '/pages/locations/locations' })
  },

  goDetail(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: '/pages/item/item?id=' + id })
  },
})
