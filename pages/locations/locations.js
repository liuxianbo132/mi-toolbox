const { cloud } = require('../../utils/cloud')
const { locationsAccess } = require('../../utils/data-access')

// 存放位置管理（v2-brief Step2）：列表 + 新增 + 改名 + 删除
// 删除策略（契约 v1.8）：直接删除位置记录；相关批次保留悬空 location_id，界面显示为「未指定」
Page({
  data: {
    largeText: false,
    authState: 'checking', // checking | signed-out | no-household | error | ready
    loadError: '',
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
    this.setData({ authState: 'checking', loadError: '' })
    try {
      const { data: session, error } = await getApp().ensureSession()
      if (error) throw error
      const uid = session && session.user && session.user.id
      if (!uid) {
        this.setData({ authState: 'signed-out' })
        return
      }
      const { data: mine, error: memberError } = await cloud.database
        .from('members').select('household_id').eq('owner_id', uid).is('left_at', null).limit(1)
      if (memberError) throw memberError
      if (!Array.isArray(mine) || (mine[0] && !mine[0].household_id)) throw new Error('家庭信息不完整')
      if (!mine.length) {
        this.setData({ authState: 'no-household' })
        return
      }
      await this.loadLocations(mine[0].household_id)
    } catch (e) {
      this.setData({ authState: 'error', loadError: '位置信息暂时无法加载，请检查网络后重试' })
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
        .from('locations')
        .select('id, name')
        .eq('household_id', hid)
        .order('name', { ascending: true })
      if (error || !Array.isArray(data)) throw error || new Error('存放位置响应不完整')
      this.setData({ authState: 'ready', householdId: hid, locations: data })
    } catch (error) {
      this.setData({ authState: 'error', loadError: '位置信息暂时无法加载，请检查网络后重试' })
    }
  },

  onNewInput(e) {
    this.setData({ newName: e.detail.value })
  },

  async addLocation() {
    if (this.data.saving || this.data.renaming || this.data.authState !== 'ready') return
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
    this.setData({ saving: true })
    const res = await locationsAccess.create({
      household_id: this.data.householdId,
      name: name,
    })
    if (res.error || !res.data) {
      this.setData({ saving: false })
      wx.showToast({ title: (res.error && res.error.message) || '保存失败', icon: 'none' })
      return
    }
    this.setData({ newName: '' })
    await this.loadLocations(this.data.householdId)
    this.setData({ saving: false })
  },

  showLocationActions(e) {
    if (this.data.saving || this.data.renaming) return
    const location = this.data.locations.find((row) => String(row.id) === String(e.currentTarget.dataset.id))
    if (!location) return
    wx.showActionSheet({
      itemList: ['修改名称', '删除位置'],
      success: (result) => {
        if (result.tapIndex === 0) this.setData({ renamingId: location.id, renameValue: location.name })
        if (result.tapIndex === 1) this.removeLocation(location)
      },
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
    if (!id || this.data.saving || this.data.renaming) return
    if (!name) {
      wx.showToast({ title: '请输入位置名称', icon: 'none' })
      return
    }
    if (this.data.locations.some((row) => row.id !== id && row.name === name)) {
      wx.showToast({ title: '同名位置已存在', icon: 'none' })
      return
    }
    this.setData({ renaming: true })
    const res = await locationsAccess.update(id, { name: name })
    if (res.error || !res.data) {
      this.setData({ renaming: false })
      wx.showToast({ title: (res.error && res.error.message) || '保存失败', icon: 'none' })
      return
    }
    this.setData({ renamingId: null, renameValue: '' })
    wx.showToast({ title: '已改名', icon: 'success' })
    await this.loadLocations(this.data.householdId)
    this.setData({ renaming: false })
  },

  removeLocation({ id, name }) {
    wx.showModal({
      title: '删除位置',
      content: '删除「' + name + '」后，该位置下的批次将显示为「未指定」',
      confirmColor: '#A32D2D',
      success: (res) => {
        if (res.confirm) this.doRemoveLocation(id)
      },
    })
  },

  // 契约 v1.8 第二种形态：直接删位置，不做批次置空——
  // 批次 location_id 保留悬空 id，详情/库存按字典外兜底显示「未指定」。
  // （不采用「先置空批次再删」形态：SDK update 会丢弃 null 值导致空 payload，链路必断）
  async doRemoveLocation(id) {
    if (this.data.saving || this.data.renaming) return
    this.setData({ saving: true })
    wx.showLoading({ title: '删除中', mask: true })
    const del = await locationsAccess.remove(id)
    wx.hideLoading()
    if (del.error || !del.data) {
      this.setData({ saving: false })
      wx.showToast({ title: (del.error && del.error.message) || '删除失败', icon: 'none' })
      return
    }
    wx.showToast({ title: '已删除', icon: 'success' })
    await this.loadLocations(this.data.householdId)
    this.setData({ saving: false })
  },
})
