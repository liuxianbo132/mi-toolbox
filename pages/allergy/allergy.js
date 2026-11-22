const { cloud } = require('../../utils/cloud')
const { allergiesAccess } = require('../../utils/data-access')

// 过敏档案（m2-brief #6）：本人可增删自己的过敏原；owner 可代管家庭成员（member_id 关联）
Page({
  data: {
    authState: 'checking', // checking | signed-out | no-household | forbidden | ready
    loginLoading: false,
    loginError: '',
    householdId: null,
    memberId: null,
    memberName: '',
    allergens: [],
    newAllergen: '',
    saving: false,
  },

  onLoad(options) {
    this.setData({
      memberId: options.member_id || null,
      memberName: decodeURIComponent(options.nickname || ''),
    })
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
      await this.loadContext()
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

  async loadContext() {
    const { data: session } = await cloud.auth.getSession()
    const uid = session && session.user && session.user.id
    if (!uid) {
      this.setData({ authState: 'signed-out' })
      return
    }
    const { data: mine } = await cloud.database
      .from('members')
      .select('id, household_id, role, nickname')
      .eq('owner_id', uid)
      .limit(1)
    const me = mine && mine[0]
    if (!me) {
      this.setData({ authState: 'no-household' })
      return
    }
    const isOwner = me.role === 'owner'
    const targetId = this.data.memberId ? String(this.data.memberId) : String(me.id)
    const isSelf = targetId === String(me.id)
    // 权限收敛：本人 + owner 代管（m2-brief #6）
    if (!isSelf && !isOwner) {
      this.setData({ authState: 'forbidden' })
      return
    }
    let memberName = this.data.memberName
    if (!memberName) memberName = isSelf ? me.nickname || '我' : '成员'
    this.setData({
      authState: 'ready',
      householdId: me.household_id,
      memberId: targetId,
      memberName: memberName,
    })
    await this.loadAllergens(targetId)
  },

  async loadAllergens(memberId) {
    const { data, error } = await cloud.database
      .from('allergies')
      .select('id, allergen, created_at')
      .eq('member_id', memberId)
      .order('created_at', { ascending: true })
    if (error) {
      wx.showToast({ title: error.message, icon: 'none' })
      return
    }
    this.setData({ allergens: data || [] })
  },

  onNewInput(e) {
    this.setData({ newAllergen: e.detail.value })
  },

  async addAllergen() {
    const v = (this.data.newAllergen || '').trim()
    if (!v) {
      wx.showToast({ title: '请输入过敏原', icon: 'none' })
      return
    }
    const dup = this.data.allergens.some(function (a) {
      return a.allergen === v
    })
    if (dup) {
      wx.showToast({ title: '该过敏原已登记', icon: 'none' })
      return
    }
    if (this.data.saving) return
    this.setData({ saving: true })
    const res = await allergiesAccess.create({
      member_id: this.data.memberId,
      household_id: this.data.householdId,
      allergen: v,
    })
    this.setData({ saving: false })
    if (res.error || !res.data) {
      wx.showToast({ title: (res.error && res.error.message) || '保存失败', icon: 'none' })
      return
    }
    this.setData({ newAllergen: '' })
    this.loadAllergens(this.data.memberId)
  },

  removeAllergen(e) {
    const id = e.currentTarget.dataset.id
    const allergen = e.currentTarget.dataset.allergen || ''
    const that = this
    wx.showModal({
      title: '删除过敏原',
      content: '确认删除「' + allergen + '」？',
      confirmColor: '#A32D2D',
      success(res) {
        if (res.confirm) that.doRemove(id)
      },
    })
  },

  async doRemove(id) {
    if (!id) return
    const res = await allergiesAccess.remove(id)
    if (res.error || !res.data) {
      wx.showToast({ title: (res.error && res.error.message) || '删除失败', icon: 'none' })
      return
    }
    wx.showToast({ title: '已删除', icon: 'success' })
    this.loadAllergens(this.data.memberId)
  },
})
