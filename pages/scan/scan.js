const { cloud } = require('../../utils/cloud')

Page({
  data: {
    largeText: false,
    status: 'checking',
    errorText: '',
    lastCode: '',
  },

  onLoad() {
    this.setData({ largeText: getApp().globalData.largeText })
    this.startScan()
  },

  onUnload() {
    this.invalidateScan()
  },

  invalidateScan() {
    clearTimeout(this.scanTimer)
    this.scanAttempt = (this.scanAttempt || 0) + 1
    return this.scanAttempt
  },

  async startScan() {
    const attempt = this.invalidateScan()
    this.setData({ status: 'checking', errorText: '', lastCode: '' })
    try {
      const { data: session, error } = await getApp().ensureSession()
      if (attempt !== this.scanAttempt) return
      if (error) throw error
      const uid = session && session.user && session.user.id
      if (!uid) {
        this.setData({ status: 'signed-out' })
        return
      }
      const { data: rows, error: memberError } = await cloud.database
        .from('members')
        .select('household_id')
        .eq('owner_id', uid)
        .is('left_at', null)
        .limit(1)
      if (attempt !== this.scanAttempt) return
      if (memberError) throw memberError
      if (!Array.isArray(rows) || (rows[0] && !rows[0].household_id)) throw new Error('家庭信息不完整')
      if (!rows.length) {
        this.setData({ status: 'no-household' })
        return
      }
      this.setData({ status: 'scanning' })
      this.scanTimer = setTimeout(() => {
        if (attempt === this.scanAttempt) this.setData({ status: 'waiting' })
      }, 10000)
      wx.scanCode({
        scanType: ['barCode'],
        success: (res) => {
          if (attempt !== this.scanAttempt) return
          clearTimeout(this.scanTimer)
          this.handleCode(res && res.result, rows[0].household_id, attempt)
        },
        fail: (err) => {
          if (attempt !== this.scanAttempt) return
          clearTimeout(this.scanTimer)
          this.handleScanFail(err)
        },
      })
    } catch (error) {
      if (attempt !== this.scanAttempt) return
      clearTimeout(this.scanTimer)
      this.setData({ status: 'error', errorText: '无法开始扫码，请检查网络后重试' })
    }
  },

  async handleCode(code, householdId, attempt) {
    const value = String(code || '').trim()
    if (!value) {
      this.setData({ status: 'error', errorText: '未识别到条码，请重扫或手动录入' })
      return
    }
    this.setData({ status: 'searching', lastCode: value })
    try {
      const { data, error } = await cloud.database
        .from('items')
        .select('id')
        .eq('household_id', householdId)
        .eq('barcode', value)
        .eq('is_deleted', false)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(1)
      if (attempt !== this.scanAttempt) return
      if (error || !Array.isArray(data)) throw error || new Error('条码查询响应不完整')
      const hit = data[0]
      this.redirect(hit ? '/pages/item/item?id=' + hit.id : this.formUrl(value))
    } catch (error) {
      if (attempt !== this.scanAttempt) return
      this.setData({ status: 'error', errorText: '无法查询条码，新增前请先在库存搜索此条码' })
    }
  },

  handleScanFail(err) {
    const message = (err && err.errMsg) || ''
    if (/cancel/i.test(message)) {
      this.goBack()
      return
    }
    this.setData({
      status: 'error',
      errorText: /auth|permission|denied/i.test(message)
        ? '相机权限不可用。可在微信设置中授权，或继续手动录入'
        : '扫码未完成，请重试或手动录入',
    })
  },

  formUrl(code) {
    return '/pages/item-form/item-form' + (code ? '?barcode=' + encodeURIComponent(code) : '')
  },

  goManual() {
    this.redirect(this.formUrl(this.data.lastCode))
  },

  redirect(url) {
    this.invalidateScan()
    wx.redirectTo({
      url,
      fail: () => this.setData({ status: 'error', errorText: '无法打开录入页面，请返回库存重试' }),
    })
  },

  goBack() {
    this.invalidateScan()
    wx.navigateBack({
      fail: () => wx.switchTab({ url: '/pages/inventory/inventory' }),
    })
  },
})
