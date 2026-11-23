const { cloud } = require('../../utils/cloud')
const { itemsAccess, batchesAccess, logRecord } = require('../../utils/data-access')
const { CATEGORIES } = require('../../utils/constants')
const { askExpirySubscribe } = require('../../utils/subscribe')
const { recognizeFromImage } = require('../../utils/vision')

Page({
  data: {
    largeText: false,
    authState: 'checking', // checking | signed-out | no-household | ready
    loginError: '',
    loginLoading: false,
    householdId: null,
    categoryOptions: CATEGORIES,
    categoryIndex: 0,
    name: '',
    unit: '',
    brand: '',
    spec: '',
    saving: false,
    // V2 Step2：可选存放位置
    locations: [],
    // V2 Step3：扫码未命中跳转时预填的条码
    barcode: '',
    // 视觉录入进行中
    recognizing: false,
  },

  onShow() {
    this.setData({ largeText: getApp().globalData.largeText })
  },

  onLoad(options) {
    if (options && options.barcode) {
      this.setData({ barcode: decodeURIComponent(options.barcode) })
    }
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
    const { data: mine, error } = await cloud.database
      .from('members')
      .select('household_id')
      .eq('owner_id', uid)
      .limit(1)
    if (error) {
      wx.showToast({ title: error.message, icon: 'none' })
      this.setData({ authState: 'no-household' })
      return
    }
    const row = mine && mine[0]
    if (!row) {
      this.setData({ authState: 'no-household' })
      return
    }
    this.setData({ householdId: row.household_id, authState: 'ready' })
    this.loadLocations(row.household_id)
  },

  // V2 Step2：位置字典（批次表单选择器用；无位置时选择器只有「未指定」）
  async loadLocations(hid) {
    const { data } = await cloud.database
      .from('locations')
      .select('id, name')
      .eq('household_id', hid)
      .order('created_at', { ascending: true })
    this.setData({ locations: data || [] })
  },

  onNameInput(e) {
    this.setData({ name: e.detail.value })
  },

  onUnitInput(e) {
    this.setData({ unit: e.detail.value })
  },

  onBrandInput(e) {
    this.setData({ brand: e.detail.value })
  },

  onSpecInput(e) {
    this.setData({ spec: e.detail.value })
  },

  onCategoryChange(e) {
    this.setData({ categoryIndex: Number(e.detail.value) || 0 })
  },

  // 视觉录入：拍照/相册 → 云服务视觉模型 → 回填名称/品类/批次（失败保留手动输入）
  async onRecognize() {
    if (this.data.recognizing) return
    this.setData({ recognizing: true })
    wx.showLoading({ title: '识别中…', mask: true })
    const res = await recognizeFromImage()
    wx.hideLoading()
    this.setData({ recognizing: false })
    if (res.error === '') return // 用户取消
    if (res.error) {
      wx.showToast({ title: res.error, icon: 'none' })
      return
    }
    const d = res.data || {}
    const patch = {}
    if (d.name) patch.name = String(d.name).slice(0, 40)
    if (d.category) {
      let idx = -1
      for (let i = 0; i < CATEGORIES.length; i++) {
        if (CATEGORIES[i].value === d.category) { idx = i; break }
      }
      if (idx >= 0) patch.categoryIndex = idx
    }
    this.setData(patch)
    const bf = this.selectComponent('#batchForm')
    if (bf && bf.applyRecognized) {
      bf.applyRecognized({ productionDate: d.productionDate, shelfLifeDays: d.shelfLifeDays })
    }
    const got = !!(d.name || d.category || d.shelfLifeDays || d.productionDate)
    wx.showToast({ title: got ? '已识别，请核对' : '未识别到信息，请手动填写', icon: 'none' })
  },

  // 保存：先建物品，再挂首批批次（契约：batches.item_id 关联 items）
  async onSaveTap() {
    const name = (this.data.name || '').trim()
    if (!name) {
      wx.showToast({ title: '请填写物品名称', icon: 'none' })
      return
    }
    if (!this.data.householdId) {
      wx.showToast({ title: '请先创建或加入家庭', icon: 'none' })
      return
    }
    const bf = this.selectComponent('#batchForm')
    const res = bf ? bf.getValues() : null
    if (!res || res.error) {
      wx.showToast({ title: (res && res.error) || '批次信息不完整', icon: 'none' })
      return
    }
    if (this.data.saving) return
    this.setData({ saving: true })

    const category = CATEGORIES[this.data.categoryIndex] || CATEGORIES[0]
    const created = await itemsAccess.create({
      household_id: this.data.householdId,
      name: name,
      category: category.value,
      unit: (this.data.unit || '').trim(),
      brand: (this.data.brand || '').trim(),
      spec: (this.data.spec || '').trim(),
      barcode: this.data.barcode || null,
    })
    if (created.error || !created.data) {
      this.setData({ saving: false })
      wx.showToast({ title: (created.error && created.error.message) || '保存失败', icon: 'none' })
      return
    }

    // v1.9：批次写入时快照家庭内昵称（未设置则省略该字段）
    const myNickname = getApp().globalData.myNickname || ''
    const batchRes = await batchesAccess.create({
      household_id: this.data.householdId,
      item_id: created.data.id,
      expiry_date: res.data.expiry_date,
      production_date: res.data.production_date,
      quantity: res.data.quantity,
      unit: res.data.unit,
      status: 'active',
      location_id: res.data.location_id,
      owner_name: myNickname || undefined,
    })
    this.setData({ saving: false })

    if (batchRes.error || !batchRes.data) {
      // 物品已建成、批次未挂上：明确告知补救路径，不静默吞掉
      wx.showToast({ title: '物品已保存，批次未保存，可在详情页补充', icon: 'none', duration: 2500 })
      this.backAfter(2500)
      return
    }

    // 任务5：录入成功后埋一次订阅授权（模板 id 未下发时静默跳过）
    askExpirySubscribe()
    // V2 Step4：入库流水（静默，失败不阻塞）
    logRecord({
      householdId: this.data.householdId,
      batchId: batchRes.data.id,
      action: 'create',
      quantity: res.data.quantity,
      note: name,
    })
    wx.showToast({ title: '已保存', icon: 'success' })
    this.backAfter(600)
  },

  backAfter(delay) {
    setTimeout(() => {
      const pages = getCurrentPages()
      if (pages.length > 1) {
        wx.navigateBack()
      } else {
        wx.switchTab({ url: '/pages/inventory/inventory' })
      }
    }, delay)
  },
})
