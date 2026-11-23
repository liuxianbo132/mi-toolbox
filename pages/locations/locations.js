const { cloud } = require('../../utils/cloud')
const { locationsAccess, batchesAccess } = require('../../utils/data-access')

// 存放位置管理（v2-brief Step2）：列表 + 新增 + 改名 + 删除
// 删除策略（契约 v1.8）：直接删除位置记录；相关批次保留悬空 location_id，界面显示为「未指定」
Page({
  data: {
    largeText: false,
    authState: 'checking', // checking | signed-out | no-household | ready
    loginLoading: false,
    loginError: '',
    householdId: null,
    locations: [],
    newName: '',
    saving: false,
    // 页面内改名编辑态（避免依赖 showModal editable 的版本差异）
    renamingId: null,
    renameValue: '',
    renaming: false,
  },

  onLoad() {
    this.setData({ largeText: getApp().globalData.largeText })
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
    const { data: mine } = await cloud.database
      .from('members')
      .select('household_id')
      .eq('owner_id', uid)
      .limit(1)
    const row = mine && mine[0]
    if (!row) {
      this.setData({ authState: 'no-household' })
      return
    }
    this.setData({ authState: 'ready', householdId: row.household_id })
    await this.loadLocations(row.household_id)
  },

  async loadLocations(hid) {
    const { data, error } = await cloud.database
      .from('locations')
      .select('id, name, created_at')
      .eq('household_id', hid)
      .order('created_at', { ascending: true })
    if (error) {
      wx.showToast({ title: error.message, icon: 'none' })
      return
    }
    this.setData({ locations: data || [] })
  },

  onNewInput(e) {
    this.setData({ newName: e.detail.value })
  },

  async addLocation() {
    const name = (this.data.newName || '').trim()
    if (!name) {
      wx.showToast({ title: '请输入位置名称', icon: 'none' })
      return
    }
    const dup = this.data.locations.some(function (l) {
      return l.name === name
    })
    if (dup) {
      wx.showToast({ title: '同名位置已存在', icon: 'none' })
      return
    }
    if (this.data.saving) return
    this.setData({ saving: true })
    const res = await locationsAccess.create({
      household_id: this.data.householdId,
      name: name,
    })
    this.setData({ saving: false })
    if (res.error || !res.data) {
      wx.showToast({ title: (res.error && res.error.message) || '保存失败', icon: 'none' })
      return
    }
    this.setData({ newName: '' })
    this.loadLocations(this.data.householdId)
  },

  // 改名：页面内编辑态
  startRename(e) {
    this.setData({
      renamingId: e.currentTarget.dataset.id,
      renameValue: e.currentTarget.dataset.name || '',
    })
  },

  cancelRename() {
    this.setData({ renamingId: null, renameValue: '' })
  },

  onRenameInput(e) {
    this.setData({ renameValue: e.detail.value })
  },

  async saveRename() {
    const id = this.data.renamingId
    const name = (this.data.renameValue || '').trim()
    if (!id) return
    if (!name) {
      wx.showToast({ title: '请输入位置名称', icon: 'none' })
      return
    }
    if (this.data.renaming) return
    this.setData({ renaming: true })
    const res = await locationsAccess.update(id, { name: name })
    this.setData({ renaming: false })
    if (res.error || !res.data) {
      wx.showToast({ title: (res.error && res.error.message) || '保存失败', icon: 'none' })
      return
    }
    this.setData({ renamingId: null, renameValue: '' })
    wx.showToast({ title: '已改名', icon: 'success' })
    this.loadLocations(this.data.householdId)
  },

  removeLocation(e) {
    const id = e.currentTarget.dataset.id
    const name = e.currentTarget.dataset.name || ''
    if (!id) return
    const that = this
    wx.showModal({
      title: '删除位置',
      content: '删除「' + name + '」后，该位置下的批次将显示为「未指定」',
      confirmColor: '#A32D2D',
      success(res) {
        if (res.confirm) that.doRemoveLocation(id)
      },
    })
  },

  // 契约 v1.8 第二种形态：直接删位置，不做批次置空——
  // 批次 location_id 保留悬空 id，详情/库存按字典外兜底显示「未指定」。
  // （不采用「先置空批次再删」形态：SDK update 会丢弃 null 值导致空 payload，链路必断）
  async doRemoveLocation(id) {
    if (this.data.saving) return
    this.setData({ saving: true })
    wx.showLoading({ title: '删除中', mask: true })
    const del = await locationsAccess.remove(id)
    wx.hideLoading()
    this.setData({ saving: false })
    if (del.error || !del.data) {
      wx.showToast({ title: (del.error && del.error.message) || '删除失败', icon: 'none' })
      return
    }
    wx.showToast({ title: '已删除', icon: 'success' })
    this.loadLocations(this.data.householdId)
  },
})
