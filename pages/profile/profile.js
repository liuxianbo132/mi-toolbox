const { cloud } = require('../../utils/cloud')

Page({
  data: {
    authState: 'checking',
    user: null,
    household: null,
    isOwner: false,
    members: [],
    memberBusy: false, // 退出/移除操作防连点
    loginError: '',
    loginLoading: false,
    largeText: false,
  },

  onShow() {
    this.setData({ largeText: getApp().globalData.largeText })
    this.restore()
  },

  onLargeTextChange(e) {
    const enabled = !!e.detail.value
    getApp().setLargeText(enabled)
    this.setData({ largeText: enabled })
  },

  async restore() {
    this.setData({ authState: 'checking' })
    const { data: session, error } = await getApp().ensureSession()
    if (error || !session) {
      this.setData({ authState: 'signed-out', user: null, household: null, members: [], isOwner: false })
      return
    }
    this.setData({ authState: 'signed-in', user: session.user || null })
    await this.loadHousehold()
  },

  async loadHousehold() {
    const { data: session } = await cloud.auth.getSession()
    const uid = session && session.user && session.user.id
    if (!uid) return
    const { data: mine, error } = await cloud.database
      .from('members')
      .select('id, household_id, role, households(id, name, invite_code)')
      .eq('owner_id', uid)
      .limit(1)
    if (error) {
      wx.showToast({ title: error.message, icon: 'none' })
      return
    }
    const row = mine && mine[0]
    if (row && row.households) {
      const isOwner = row.role === 'owner'
      this.setData({ household: row.households, isOwner: isOwner })
      await this.loadMembers(row.household_id, uid, isOwner)
    } else {
      this.setData({ household: null, isOwner: false, members: [] })
    }
  },

  // 成员列表：契约 v1.4——owner 成员 nickname 不落库，前端以 session 用户名兜底显示
  async loadMembers(hid, uid, isOwner) {
    const { data, error } = await cloud.database
      .from('members')
      .select('id, owner_id, role, nickname, joined_at')
      .eq('household_id', hid)
      .order('joined_at', { ascending: true })
    if (error) {
      wx.showToast({ title: error.message, icon: 'none' })
      return
    }
    const sessionName = (this.data.user && this.data.user.name) || ''
    const members = (data || []).map(function (m) {
      const isSelf = m.owner_id === uid
      let nameText = m.nickname
      if (!nameText && isSelf) nameText = sessionName
      if (!nameText) nameText = '微信用户'
      return {
        id: m.id,
        isSelf: isSelf,
        nameText: nameText,
        roleLabel: m.role === 'owner' ? '管理员' : '成员',
        joinedText: m.joined_at ? String(m.joined_at).slice(0, 10) : '',
        // owner 仅可移除 role='member' 的成员（契约 v1.2：目标须为 member）
        canRemove: isOwner && m.role === 'member',
        // owner 不显示退出入口（契约 v1.2：owner 不可退出/解散）
        canLeave: isSelf && m.role !== 'owner',
      }
    })
    this.setData({ members: members })
  },

  // V2 Step4：操作记录入口
  gorecords() {
    wx.navigateTo({ url: '/pages/records/records' })
  },

  // 过敏档案入口（m2-brief #6）：本人 + owner 代管
  goAllergy(e) {
    const id = e.currentTarget.dataset.id
    const name = e.currentTarget.dataset.name || ''
    if (!id) return
    wx.navigateTo({
      url: '/pages/allergy/allergy?member_id=' + id + '&nickname=' + encodeURIComponent(name),
    })
  },

  // ===== member 退出家庭（leave_household，契约 v1.4 返回值含 not_signed_in 兜底） =====

  onLeaveHousehold() {
    const that = this
    wx.showModal({
      title: '退出家庭',
      content: '退出后将无法查看该家庭的物品与批次记录',
      confirmColor: '#A32D2D',
      success(res) {
        if (!res.confirm) return
        that.doLeave()
      },
    })
  },

  async doLeave() {
    if (this.data.memberBusy) return
    this.setData({ memberBusy: true })
    wx.showLoading({ title: '处理中', mask: true })
    const res = await cloud.database.rpc('leave_household', {})
    wx.hideLoading()
    this.setData({ memberBusy: false })
    if (res.error) {
      wx.showToast({ title: (res.error && res.error.message) || '操作失败', icon: 'none' })
      return
    }
    if (res.data === 'owner_cannot_leave') {
      // owner 无此按钮，防御性兜底
      wx.showToast({ title: '管理员不可退出', icon: 'none' })
      return
    }
    if (res.data === 'not_signed_in') {
      wx.showToast({ title: '请先登录', icon: 'none' })
      return
    }
    if (res.data === 'not_found') {
      wx.showToast({ title: '未加入任何家庭', icon: 'none' })
    } else {
      wx.showToast({ title: '已退出', icon: 'success' })
    }
    await this.loadHousehold()
  },

  // ===== owner 移除成员（remove_member(p_member_id bigint)，契约 v1.4） =====

  onRemoveMember(e) {
    const id = e.currentTarget.dataset.id
    if (id === undefined || id === null || id === '') return
    const that = this
    wx.showModal({
      title: '移除成员',
      content: '该成员将失去本家庭数据的访问权限',
      confirmColor: '#A32D2D',
      success(res) {
        if (!res.confirm) return
        that.doRemove(id)
      },
    })
  },

  async doRemove(id) {
    if (this.data.memberBusy) return
    this.setData({ memberBusy: true })
    wx.showLoading({ title: '处理中', mask: true })
    // bigint id 原样透传（字符串形式），避免 JS Number 精度丢失
    const res = await cloud.database.rpc('remove_member', { p_member_id: id })
    wx.hideLoading()
    this.setData({ memberBusy: false })
    if (res.error) {
      wx.showToast({ title: (res.error && res.error.message) || '操作失败', icon: 'none' })
      return
    }
    if (res.data === 'forbidden') {
      wx.showToast({ title: '无权移除该成员', icon: 'none' })
      return
    }
    if (res.data === 'not_signed_in') {
      wx.showToast({ title: '请先登录', icon: 'none' })
      return
    }
    if (res.data === 'not_found') {
      wx.showToast({ title: '成员不存在', icon: 'none' })
    } else {
      wx.showToast({ title: '已移除', icon: 'success' })
    }
    await this.loadHousehold()
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

  copyInviteCode() {
    if (!this.data.household) return
    wx.setClipboardData({ data: this.data.household.invite_code })
  },

  async onSignOut() {
    await cloud.auth.signOut()
    getApp().resetSession()
    this.setData({ authState: 'signed-out', user: null, household: null, members: [], isOwner: false })
  },
})
