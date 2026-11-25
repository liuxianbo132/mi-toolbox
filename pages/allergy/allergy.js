const { cloud } = require('../../utils/cloud')
const { allergiesAccess } = require('../../utils/data-access')

// 过敏档案（m2-brief #6）：本人可增删自己的过敏原；owner 可代管家庭成员（member_id 关联）
Page({
  data: {
    largeText: false,
    authState: 'checking',
    loadState: 'loading',
    loadError: '',
    loginLoading: false,
    loginError: '',
    householdId: null,
    memberId: null,
    memberName: '',
    allergens: [],
    newAllergen: '',
    saving: false,
  },

  onLoad(options = {}) {
    this.setData({ largeText: getApp().globalData.largeText })
    this.requestedMemberId = options.member_id || null
    this.restore()
  },

  async restore() {
    if (this.restoring) return
    this.restoring = true
    this.setData({ authState: 'checking' })
    try {
      const { data: session, error } = await getApp().ensureSession()
      if (error) throw error
      if (!session) {
        this.setData({ authState: 'signed-out' })
        return
      }
      await this.loadContext(session.user && session.user.id)
    } catch (e) {
      this.setData({ authState: 'error', loadError: '成员档案暂时无法加载，请重试。' })
    } finally {
      this.restoring = false
    }
  },

  async onWechatLogin() {
    if (this.data.loginLoading) return
    this.setData({ loginLoading: true, loginError: '' })
    const res = await getApp().loginWithWechat()
    this.setData({ loginLoading: false })
    if (res.error || !res.data) {
      this.setData({ loginError: (res.error && res.error.message) || '登录失败' })
      return
    }
    this.restore()
  },

  async loadContext(uid) {
    if (!uid) {
      this.setData({ authState: 'signed-out' })
      return
    }
    const { data: mine, error } = await cloud.database
      .from('members')
      .select('id, household_id, role, nickname')
      .eq('owner_id', uid)
      .is('left_at', null)
      .limit(1)
    if (error) throw error
    const me = mine && mine[0]
    if (!me) {
      this.setData({ authState: 'no-household' })
      return
    }
    const isOwner = me.role === 'owner'
    const isSelf = !this.requestedMemberId || String(this.requestedMemberId) === String(me.id)
    if (!isSelf && !isOwner) {
      this.setData({ authState: 'forbidden' })
      return
    }
    let target = me
    if (!isSelf) {
      const { data, error: targetError } = await cloud.database
        .from('members').select('id, nickname')
        .eq('household_id', me.household_id).eq('id', this.requestedMemberId).is('left_at', null).limit(1)
      if (targetError) throw targetError
      target = data && data[0]
      if (!target) {
        this.setData({ authState: 'forbidden' })
        return
      }
    }
    this.setData({
      authState: 'ready',
      householdId: me.household_id,
      memberId: target.id,
      memberName: target.nickname || (isSelf ? '我' : '成员'),
    })
    await this.loadAllergens()
  },

  async loadAllergens() {
    this.setData({ loadState: 'loading', loadError: '' })
    try {
      const { data, error } = await cloud.database
        .from('allergies').select('id, allergen')
        .eq('household_id', this.data.householdId)
        .eq('member_id', this.data.memberId)
        .order('created_at', { ascending: true })
      if (error) throw error
      this.setData({ allergens: data || [], loadState: 'ready' })
    } catch (e) {
      this.setData({ loadState: 'error', loadError: '过敏原记录暂时无法加载，请重试。' })
    }
  },

  onNewInput(e) {
    this.setData({ newAllergen: e.detail.value })
  },

  async addAllergen() {
    if (this.data.saving || this.data.loadState !== 'ready') return
    const v = (this.data.newAllergen || '').trim()
    if (!v) {
      wx.showToast({ title: '请输入过敏原', icon: 'none' })
      return
    }
    const dup = this.data.allergens.some(function (a) {
      return a.allergen.trim() === v
    })
    if (dup) {
      wx.showToast({ title: '该过敏原已登记', icon: 'none' })
      return
    }
    this.setData({ saving: true })
    try {
      const res = await allergiesAccess.create({
        member_id: this.data.memberId,
        household_id: this.data.householdId,
        allergen: v,
      })
      if (res.error || !res.data) throw res.error || new Error('Missing saved allergen')
      this.setData({ newAllergen: '' })
    } catch (e) {
      wx.showToast({ title: '保存结果暂未确认，正在刷新记录', icon: 'none' })
    } finally {
      await this.loadAllergens()
      this.setData({ saving: false })
    }
  },

  removeAllergen(e) {
    if (this.data.saving || this.data.loadState !== 'ready') return
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
    if (!id || this.data.saving || this.data.loadState !== 'ready' ||
        !this.data.allergens.some((a) => a.id === id)) return
    this.setData({ saving: true })
    try {
      const res = await allergiesAccess.remove(id)
      if (res.error || !res.data) throw res.error || new Error('Missing deleted allergen')
      wx.showToast({ title: '已移除', icon: 'success' })
    } catch (e) {
      wx.showToast({ title: '移除结果暂未确认，正在刷新记录', icon: 'none' })
    } finally {
      await this.loadAllergens()
      this.setData({ saving: false })
    }
  },
})
