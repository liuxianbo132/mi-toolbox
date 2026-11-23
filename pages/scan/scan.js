const { cloud } = require('../../utils/cloud')

// 扫码录入（v2-brief Step3）：进入即扫 → 同 household items.barcode 匹配
// 命中 → 物品详情（可快速加批次）；未命中 → 录入页预填 barcode；取消/失败返回上一页，无副作用
Page({
  data: {
    largeText: false,
    status: 'scanning', // scanning | error | no-household
    errorText: '',
    lastCode: '',
  },

  onLoad() {
    this.setData({ largeText: getApp().globalData.largeText })
    this.startScan()
  },

  async ensureContext() {
    const { data: session } = await cloud.auth.getSession()
    const uid = session && session.user && session.user.id
    if (!uid) return null
    const { data: mine } = await cloud.database
      .from('members')
      .select('household_id')
      .eq('owner_id', uid)
      .limit(1)
    const row = mine && mine[0]
    if (!row) return null
    return { uid: uid, householdId: row.household_id }
  },

  async startScan() {
    this.setData({ status: 'scanning', errorText: '' })
    const ctx = await this.ensureContext()
    if (!ctx) {
      this.setData({ status: 'no-household' })
      return
    }
    wx.scanCode({
      scanType: ['barCode'],
      success: (res) => {
        this.handleCode(res && res.result, ctx)
      },
      fail: (err) => {
        this.handleScanFail(err)
      },
    })
  },

  async handleCode(code, ctx) {
    const value = String(code || '').trim()
    if (!value) {
      this.setData({ status: 'error', errorText: '未识别到条码内容' })
      return
    }
    this.setData({ lastCode: value })
    // 契约 v1.8：同 household 内匹配，不加唯一约束，多命中取最近创建
    const { data, error } = await cloud.database
      .from('items')
      .select('id, name, barcode')
      .eq('household_id', ctx.householdId)
      .eq('barcode', value)
      .eq('is_deleted', false)
      .order('created_at', { ascending: false })
      .limit(1)
    if (error) {
      wx.showToast({ title: error.message, icon: 'none' })
      this.setData({ status: 'error', errorText: '查询失败，请返回重试' })
      return
    }
    const hit = data && data[0]
    if (hit) {
      // 命中：替换为物品详情（返回时回库存页），用户可快速加批次
      wx.redirectTo({ url: '/pages/item/item?id=' + hit.id })
      return
    }
    // 未命中：跳录入页并预填 barcode
    wx.redirectTo({ url: '/pages/item-form/item-form?barcode=' + encodeURIComponent(value) })
  },

  handleScanFail(err) {
    const msg = (err && err.errMsg) || ''
    if (msg.indexOf('cancel') >= 0) {
      // 取消：返回上一页，无副作用
      this.goBack()
      return
    }
    this.setData({
      status: 'error',
      errorText: '扫码未完成：' + (msg || '开发者工具模拟器不支持扫码，请用真机'),
    })
  },

  retry() {
    this.startScan()
  },

  goBack() {
    wx.navigateBack({
      fail: () => {
        wx.switchTab({ url: '/pages/inventory/inventory' })
      },
    })
  },
})
