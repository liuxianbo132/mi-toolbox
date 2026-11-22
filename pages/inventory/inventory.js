const { cloud } = require('../../utils/cloud')
const { CATEGORIES, categoryLabel } = require('../../utils/constants')

Page({
  data: {
    authState: 'checking',
    household: null,
    loginError: '',
    loginLoading: false,
    items: [],
    // V2 Step1：按品类分组（空组不显示）
    groups: [],
  },

  onShow() {
    this.restore()
  },

  async restore() {
    this.setData({ authState: 'checking' })
    const { data: session, error } = await getApp().ensureSession()
    if (error || !session) {
      this.setData({ authState: 'signed-out' })
      return
    }
    this.setData({ authState: 'signed-in' })
    await this.loadHousehold()
  },

  async loadHousehold() {
    const { data: session } = await cloud.auth.getSession()
    const uid = session && session.user && session.user.id
    if (!uid) return
    const { data: mine } = await cloud.database
      .from('members')
      .select('household_id')
      .eq('owner_id', uid)
      .limit(1)
    const row = mine && mine[0]
    if (!row) {
      this.setData({ household: null, items: [], groups: [] })
      return
    }
    this.setData({ household: { id: row.household_id } })
    await this.loadItems(row.household_id)
  },

  async loadItems(hid) {
    const { data, error } = await cloud.database
      .from('items')
      .select('id, name, category, unit, brand, spec')
      .eq('household_id', hid)
      .order('created_at', { ascending: false })
      .limit(100)
    if (error) {
      wx.showToast({ title: error.message, icon: 'none' })
      return
    }
    const items = (data || []).map(function (row) {
      return Object.assign({}, row, { categoryLabel: categoryLabel(row.category) })
    })
    // V2 Step2：位置角标——物品 active 批次的位置聚合（契约 v1.8：多位置显「多位置」、无位置显「未指定」）
    const locRes = await cloud.database
      .from('locations')
      .select('id, name')
      .eq('household_id', hid)
    const locMap = {}
    ;(locRes.data || []).forEach(function (l) {
      locMap[l.id] = l.name
    })
    const batchRes = await cloud.database
      .from('batches')
      .select('id, item_id, location_id, status')
      .eq('household_id', hid)
      .eq('status', 'active')
      .limit(500)
    const itemLocSet = {}
    ;(batchRes.data || []).forEach(function (b) {
      if (b.item_id == null) return
      if (!itemLocSet[b.item_id]) itemLocSet[b.item_id] = {}
      if (b.location_id != null) itemLocSet[b.item_id][b.location_id] = true
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
      return Object.assign({}, row, { locText: locText, locKnown: locKnown })
    })
    // V2 Step1：按品类分组，组头带计数，空品类不显示组
    const known = { food: true, medicine: true, daily: true, other: true }
    const groups = []
    CATEGORIES.forEach(function (c) {
      const list = decorated.filter(function (i) {
        return i.category === c.value || (c.value === 'other' && !known[i.category])
      })
      if (list.length > 0) {
        groups.push({ key: c.value, label: c.display || c.label, count: list.length, items: list })
      }
    })
    this.setData({ items: decorated, groups: groups })
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

  goCreate() {
    wx.navigateTo({ url: '/pages/item-form/item-form' })
  },

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
