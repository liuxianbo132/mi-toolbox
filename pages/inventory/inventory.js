const { cloud } = require('../../utils/cloud')
const { CATEGORIES, categoryLabel, categoryIllustration, itemIllustration } = require('../../utils/constants')

// 低库存口径：active 批次 quantity 之和 ≤ 阈值即库存不足；
// 阈值缺省（未设置）回落 0 —— 即「用光才提醒」，避免"只剩 1 件"把正常家庭物品全标成不足
const DEFAULT_LOW_STOCK_THRESHOLD = 0

function lowStockThreshold(value) {
  const n = Number(value)
  return value == null || !isFinite(n) ? DEFAULT_LOW_STOCK_THRESHOLD : n
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
    items: [],
    allItems: [],
    // V2 Step1：按品类分组（空组不显示）
    groups: [],
    searchText: '',
    categoryIndex: 0,
    categoryOptions: [{ value: 'all', label: '全部品类' }].concat(CATEGORIES.map(function (c) { return { value: c.value, label: c.label } })),
    locationIndex: 0,
    locationOptions: [{ id: 'all', name: '全部位置' }],
    sortIndex: 0,
    sortOptions: ['最近添加', '最早到期', '名称'],
    itemsLimited: false,
    batchDataLimited: false,
  },

  onShow() {
    this.setData({ largeText: getApp().globalData.largeText })
    this.restore()
  },

  async restore() {
    this.setData({ authState: 'checking', loadError: '' })
    const { data: session, error } = await getApp().ensureSession()
    if (error || !session) {
      this.clearInventoryData()
      this.setData({ authState: 'signed-out', household: null })
      return
    }
    this.setData({ authState: 'signed-in' })
    await this.loadHousehold()
  },

  async loadHousehold() {
    const { data: session, error: sessionError } = await cloud.auth.getSession()
    if (sessionError) {
      this.failInventoryLoad(sessionError)
      return
    }
    const uid = session && session.user && session.user.id
    if (!uid) {
      this.clearInventoryData()
      this.setData({ household: null })
      return
    }
    const { data: mine, error } = await cloud.database
      .from('members')
      .select('household_id')
      .eq('owner_id', uid)
      .limit(1)
    if (error) {
      this.failInventoryLoad(error)
      return
    }
    const row = mine && mine[0]
    if (!row) {
      this.clearInventoryData()
      this.setData({ household: null, loadError: '' })
      return
    }
    const previousHouseholdId = this.data.household && this.data.household.id
    const sameHousehold = String(previousHouseholdId || '') === String(row.household_id)
    this.clearInventoryData(!sameHousehold)
    this.setData({ household: { id: row.household_id }, loadError: '' })
    await this.loadItems(row.household_id)
  },

  clearInventoryData(resetFilters) {
    const next = {
      items: [], allItems: [], groups: [],
      itemsLimited: false, batchDataLimited: false,
      loading: false,
    }
    if (resetFilters !== false) {
      next.locationOptions = [{ id: 'all', name: '全部位置' }]
      next.searchText = ''
      next.categoryIndex = 0
      next.locationIndex = 0
      next.sortIndex = 0
    }
    this.setData(next)
  },

  failInventoryLoad(error) {
    this.clearInventoryData(false)
    this.setData({ loadError: (error && error.message) || '库存信息加载失败，请重试' })
  },

  async loadItems(hid) {
    this.setData({
      loadError: '',
      loading: true,
      items: [],
      groups: [],
    })
    const pageSize = 100
    const maxItems = 1000
    const data = []
    // 多取一条用于区分“刚好达到 1000”和“超过 1000”。
    for (let from = 0; from <= maxItems; from += pageSize) {
      const expected = Math.min(pageSize, maxItems - from + 1)
      const { data: page, error } = await cloud.database
        .from('items')
        .select('id, name, category, unit, brand, spec, barcode, created_at, low_stock_threshold')
        .eq('household_id', hid)
        .eq('is_deleted', false)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .range(from, Math.min(from + pageSize - 1, maxItems))
      if (error) {
        this.failInventoryLoad(error)
        return
      }
      data.push.apply(data, page || [])
      if (data.length > maxItems || !page || page.length < expected) break
    }
    const itemsLimited = data.length > maxItems
    if (itemsLimited) data.length = maxItems
    const items = data.map(function (row) {
      return Object.assign({}, row, { categoryLabel: categoryLabel(row.category) })
    })
    // V2 Step2：位置角标——物品 active 批次的位置聚合（契约 v1.8：多位置显「多位置」、无位置显「未指定」）
    const locRes = await cloud.database
      .from('locations')
      .select('id, name')
      .eq('household_id', hid)
    if (locRes.error) {
      this.failInventoryLoad(locRes.error)
      return
    }
    const locMap = {}
    ;(locRes.data || []).forEach(function (l) {
      locMap[l.id] = l.name
    })
    const batchPageSize = 500
    const maxBatches = 3000
    const activeBatches = []
    // 同样多取一条，准确判断是否超过 3000 条。
    for (let from = 0; from <= maxBatches; from += batchPageSize) {
      const expected = Math.min(batchPageSize, maxBatches - from + 1)
      const { data: page, error } = await cloud.database
        .from('batches')
        .select('id, item_id, location_id, expiry_date, status, quantity')
        .eq('household_id', hid)
        .eq('status', 'active')
        .eq('is_deleted', false)
        .order('expiry_date', { ascending: true })
        .order('id', { ascending: true })
        .range(from, Math.min(from + batchPageSize - 1, maxBatches))
      if (error) {
        this.failInventoryLoad(error)
        return
      }
      activeBatches.push.apply(activeBatches, page || [])
      if (activeBatches.length > maxBatches || !page || page.length < expected) break
    }
    const batchDataLimited = activeBatches.length > maxBatches
    if (batchDataLimited) activeBatches.length = maxBatches
    const itemLocSet = {}
    const earliestExpiry = {}
    const totalQty = {}
    activeBatches.forEach(function (b) {
      if (b.item_id == null) return
      if (!itemLocSet[b.item_id]) itemLocSet[b.item_id] = {}
      if (b.location_id != null) itemLocSet[b.item_id][b.location_id] = true
      if (b.expiry_date && (!earliestExpiry[b.item_id] || b.expiry_date < earliestExpiry[b.item_id])) earliestExpiry[b.item_id] = b.expiry_date
      // 低库存：active 批次数量累加，quantity 为空按 0 计
      const qty = b.quantity == null ? 0 : Number(b.quantity)
      totalQty[b.item_id] = (totalQty[b.item_id] || 0) + (isFinite(qty) ? qty : 0)
    })
    const decorated = items.map(function (row) {
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
      const itemQty = totalQty[row.id] || 0
      return Object.assign({}, row, {
        locText: locText,
        locKnown: locKnown,
        locationIds: ids.map(String),
        earliestExpiry: earliestExpiry[row.id] || '',
        totalQty: itemQty,
        lowStock: itemQty <= lowStockThreshold(row.low_stock_threshold),
        illu: itemIllustration(row.name, row.category),
        stockText: itemQty === 0 ? '已用完' : String(itemQty) + (row.unit ? ' ' + row.unit : ''),
      })
    })
    const locationOptions = [{ id: 'all', name: '全部位置' }].concat((locRes.data || []).map(function (l) { return { id: String(l.id), name: l.name } }))
    const oldLocation = this.data.locationOptions[this.data.locationIndex]
    const oldLocationId = oldLocation && oldLocation.id
    const matchedLocationIndex = oldLocationId ? locationOptions.findIndex(function (location) { return location.id === oldLocationId }) : -1
    this.setData({
      allItems: decorated,
      locationOptions: locationOptions,
      locationIndex: matchedLocationIndex >= 0 ? matchedLocationIndex : 0,
      itemsLimited: itemsLimited,
      batchDataLimited: batchDataLimited,
      loading: false,
    }, () => this.applyFilters())
  },

  applyFilters() {
    const term = String(this.data.searchText || '').trim().toLocaleLowerCase()
    // 防御：选项/index 不同步时（如位置列表收缩后）回落到第一项，避免越界崩溃
    const catOpt = this.data.categoryOptions[this.data.categoryIndex] || this.data.categoryOptions[0]
    const locOpt = this.data.locationOptions[this.data.locationIndex] || this.data.locationOptions[0]
    const category = catOpt ? catOpt.value : 'all'
    const locationId = locOpt ? locOpt.id : 'all'
    const sortIndex = this.data.sortIndex
    const items = this.data.allItems.filter(function (item) {
      const matchesTerm = !term || [item.name, item.brand, item.spec, item.barcode].some(function (value) {
        return String(value || '').toLocaleLowerCase().indexOf(term) >= 0
      })
      const matchesCategory = category === 'all' || item.category === category || (category === 'other' && !CATEGORIES.some(function (c) { return c.value === item.category }))
      const matchesLocation = locationId === 'all' || (item.locationIds || []).indexOf(locationId) >= 0
      return matchesTerm && matchesCategory && matchesLocation
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
    this.setData({ items: items, groups: groups })
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

  clearInventoryFilters() {
    this.setData({ searchText: '', categoryIndex: 0, locationIndex: 0, sortIndex: 0 }, () => this.applyFilters())
  },

  clearinventoryfilters() { this.clearInventoryFilters() },

  retryInventoryLoad() {
    this.setData({ loadError: '' })
    this.loadHousehold()
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
