const { cloud } = require('../../utils/cloud')
const { CATEGORIES, categoryIllustration } = require('../../utils/constants')
const { askExpirySubscribe } = require('../../utils/subscribe')
const { recognizeFromImage } = require('../../utils/vision')
const { parseOptionalDaysOrCount } = require('../../utils/inventory-fields')
const { makeRequestId } = require('../../utils/request-id')

const SAVE_ERRORS = {
  invalid_stock: '请核对物品资料和首个批次的数量、单位、日期。',
  invalid_location: '存放位置已有变化，请重新选定后保存。',
  invalid_household: '家庭已变化，请返回库存重新录入。',
  not_signed_in: '请登录后重新录入。',
}

Page({
  data: {
    largeText: false,
    authState: 'checking', // checking | signed-out | no-household | error | ready
    loadError: '',
    loginError: '',
    loginLoading: false,
    householdId: null,
    categoryOptions: CATEGORIES.map(function (category) {
      return Object.assign({}, category, { illustration: categoryIllustration(category.value) })
    }),
    categoryIndex: 0,
    name: '',
    unit: '',
    brand: '',
    spec: '',
    lowStockThreshold: '',
    paoDays: '',
    saving: false,
    saveComplete: false,
    saveError: '',
    saveUnknown: false,
    saveConflict: false,
    // V2 Step2：可选存放位置
    locations: [],
    locationsError: false,
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
      let barcode = options.barcode
      try { barcode = decodeURIComponent(barcode) } catch (e) { /* 条码本身可以含 %. */ }
      this.setData({ barcode })
    }
    this.restore()
  },

  onUnload() {
    this.unloaded = true
    clearTimeout(this.backTimer)
  },

  async restore() {
    this.setData({ authState: 'checking', loadError: '' })
    try {
      const app = getApp()
      const { data: session, error } = await app.ensureSession()
      if (error) throw error
      const uid = session && session.user && session.user.id
      if (!uid) {
        this.setData({ authState: 'signed-out' })
        return
      }
      const sessionVersion = app.sessionVersion
      const { data: mine, error: memberError } = await cloud.database
        .from('members').select('household_id').eq('owner_id', uid).is('left_at', null).limit(1)
      if (memberError) throw memberError
      if (sessionVersion !== app.sessionVersion) return this.restore()
      if (!Array.isArray(mine) || (mine[0] && !mine[0].household_id)) throw new Error('家庭信息不完整')
      if (!mine.length) {
        this.setData({ authState: 'no-household' })
        return
      }
      const householdId = mine[0].household_id
      this.loadedSessionVersion = sessionVersion
      this.setData({ householdId, authState: 'ready' })
      await this.loadLocations(householdId)
    } catch (e) {
      this.setData({ authState: 'error', loadError: '家庭信息暂时无法加载，请检查网络后重试' })
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

  async loadLocations(hid) {
    try {
      const { data, error } = await cloud.database
        .from('locations').select('id, name').eq('household_id', hid).order('name', { ascending: true })
      if (error || !Array.isArray(data)) throw error || new Error('存放位置响应不完整')
      this.setData({ locations: data, locationsError: false })
    } catch (error) {
      this.setData({ locationsError: true })
    }
  },

  retryLocations() { return this.loadLocations(this.data.householdId) },

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

  onLowStockThresholdInput(e) {
    this.setData({ lowStockThreshold: e.detail.value })
  },

  onPaoDaysInput(e) { this.setData({ paoDays: e.detail.value }) },

  onBarcodeInput(e) { this.setData({ barcode: e.detail.value }) },

  onCategoryChange(e) {
    this.setData({ categoryIndex: Number(e.detail.value) || 0 })
  },

  // 视觉录入：拍照/相册 → 云服务视觉模型 → 回填名称/品类/批次（失败保留手动输入）
  async onRecognize() {
    if (this.data.recognizing || this.data.saving || this.data.saveUnknown || this.data.saveComplete) return
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

  readSavePayload() {
    const name = (this.data.name || '').trim()
    if (!name) return { error: '请填写物品名称' }
    if (!this.data.householdId) return { error: '请先创建或加入家庭' }
    const lowStockThreshold = parseOptionalDaysOrCount(this.data.lowStockThreshold, 999)
    if (lowStockThreshold == null) return { error: '低库存提醒请填 0–999 的整数' }
    const paoDays = parseOptionalDaysOrCount(this.data.paoDays, 3650)
    if (paoDays == null) return { error: '开封后有效期请填 1–3650 天，留空关闭' }
    const bf = this.selectComponent('#batchForm')
    const res = bf ? bf.getValues() : null
    if (!res || res.error || !res.data) return { error: (res && res.error) || '批次信息不完整' }
    const category = CATEGORIES[this.data.categoryIndex] || CATEGORIES[0]
    return {
      p_item: {
        household_id: this.data.householdId,
        name,
        category: category.value,
        unit: (this.data.unit || '').trim(),
        brand: (this.data.brand || '').trim(),
        spec: (this.data.spec || '').trim(),
        barcode: this.data.barcode.trim() || null,
        low_stock_threshold: lowStockThreshold,
        pao_days: paoDays,
      },
      p_first_batch: { ...res.data, status: 'active' },
    }
  },

  async onSaveTap() {
    if (this.data.authState !== 'ready' || this.data.saving || this.data.recognizing || this.data.saveComplete || this.data.saveConflict) return
    const app = getApp()
    if (this.loadedSessionVersion !== app.sessionVersion) {
      if (this.pendingSave) {
        this.setData({ saveConflict: true, saveError: '登录状态已变化，请先前往库存核对这次录入。' })
      } else {
        await this.restore()
      }
      return
    }
    const payload = this.pendingSave || this.readSavePayload()
    if (payload.error) {
      this.setData({ saveError: payload.error })
      return
    }
    this.setData({ saving: true, saveError: '' })
    try {
      if (!this.pendingSave) {
        const requestId = await makeRequestId()
        if (this.unloaded) return
        if (this.loadedSessionVersion !== app.sessionVersion) {
          this.setData({ saveError: '登录状态已变化，请重新加载后录入。' })
          return
        }
        this.pendingSave = { ...payload, p_request_id: requestId }
      }
      const { error, data } = await cloud.database.rpc('create_stock_atomic', this.pendingSave)
      if (this.unloaded) return
      if (error || !data || typeof data.ok !== 'boolean' || (data.ok && (!data.item_id || !data.batch_id))) {
        throw error || new Error('Unconfirmed stock save')
      }
      this.pendingSave = null
      if (!data.ok) {
        if (data.error === 'request_conflict') {
          this.setData({ saveUnknown: true, saveConflict: true, saveError: '本次内容与已有保存记录不同，请先前往库存核对。' })
          return
        }
        this.setData({ saveUnknown: false, saveError: SAVE_ERRORS[data.error] || '物品和批次未保存，请核对后重试。' })
        if (data.error === 'invalid_location') this.retryLocations()
        return
      }

      this.setData({ saveUnknown: false, saveComplete: true })
      askExpirySubscribe()
      wx.showToast({ title: '已保存', icon: 'success' })
      this.backAfter(600)
    } catch (error) {
      if (this.unloaded) return
      const saveUnknown = !!this.pendingSave
      this.setData({ saveUnknown, saveError: saveUnknown
        ? '本次保存结果暂未确认。重试会核对同一次录入。'
        : '暂时无法保存，请重试。' })
    } finally {
      if (!this.unloaded) this.setData({ saving: false })
    }
  },

  checkSaveResult() {
    wx.switchTab({ url: '/pages/inventory/inventory' })
  },

  backAfter(delay) {
    this.backTimer = setTimeout(() => {
      const pages = getCurrentPages()
      if (pages.length > 1) {
        wx.navigateBack()
      } else {
        wx.switchTab({ url: '/pages/inventory/inventory' })
      }
    }, delay)
  },
})
