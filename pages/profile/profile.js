const { cloud } = require('../../utils/cloud')
const { buildFamilyExport, writeAndShare } = require('../../utils/export')

// 文件名用本地时间 YYYYMMDD，避免跨天备份重名
function pad2(n) {
  return n < 10 ? '0' + n : String(n)
}

function dateStamp(date) {
  const d = date || new Date()
  return String(d.getFullYear()) + pad2(d.getMonth() + 1) + pad2(d.getDate())
}

Page({
  data: {
    authState: 'checking',
    user: null,
    household: null,
    householdError: '',
    membersError: '',
    isOwner: false,
    members: [],
    signOutBusy: false,
    memberBusy: false, // 退出/移除操作防连点
    loginError: '',
    loginLoading: false,
    largeText: false,
    exportBusy: false, // 导出/分享防连点
    lastExportPath: '', // 上次导出文件路径，供取消分享后重发
    lastExportName: '',
    // V3：家庭内昵称编辑
    nicknameInput: '',
    nicknameBusy: false,
  },

  onShow() {
    this.setData({
      largeText: getApp().globalData.largeText,
      nicknameInput: getApp().globalData.myNickname || '',
    })
    this.restore()
  },

  // V3：昵称输入
  onnicknameinput(e) {
    this.setData({ nicknameInput: e.detail.value })
  },

  // V3：保存昵称到本人 members 行（RLS 允许本人 UPDATE 自己那一行）
  async savenickname() {
    if (this.data.nicknameBusy) return
    const nickname = (this.data.nicknameInput || '').trim()
    if (!nickname) {
      wx.showToast({ title: '请输入昵称', icon: 'none' })
      return
    }
    let selfId = null
    for (let i = 0; i < this.data.members.length; i++) {
      if (this.data.members[i].isSelf) {
        selfId = this.data.members[i].id
        break
      }
    }
    if (selfId == null) {
      wx.showToast({ title: '未找到本人成员信息', icon: 'none' })
      return
    }
    this.setData({ nicknameBusy: true })
    const { data, error } = await cloud.database
      .from('members')
      .update({ nickname: nickname })
      .eq('id', selfId)
      .select('id, nickname')
    this.setData({ nicknameBusy: false })
    if (error || !data || !data.length) {
      wx.showToast({ title: (error && error.message) || '保存失败', icon: 'none' })
      return
    }
    getApp().globalData.myNickname = nickname
    this.setData({ nicknameInput: nickname })
    wx.showToast({ title: '已保存', icon: 'success' })
    await this.loadHousehold()
  },

  onLargeTextChange(e) {
    const enabled = !!e.detail.value
    getApp().setLargeText(enabled)
    this.setData({ largeText: enabled })
  },

  // WXML 事件名统一小写，避免编译层将驼峰名小写化后找不到方法
  onlargetextchange(e) { this.onLargeTextChange(e) },

  async restore() {
    this.setData({ authState: 'checking', householdError: '', membersError: '' })
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
      this.setData({
        household: null,
        members: [],
        householdError: (error && error.message) || '家庭信息加载失败，请重试',
      })
      return
    }
    const row = mine && mine[0]
    if (row && row.households) {
      const isOwner = row.role === 'owner'
      this.setData({ household: row.households, isOwner: isOwner })
      await this.loadMembers(row.household_id, uid, isOwner)
    } else {
      this.setData({ household: null, householdError: '', membersError: '', isOwner: false, members: [] })
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
      this.setData({ members: [], membersError: (error && error.message) || '家庭成员加载失败，请重试' })
      return
    }
    this.setData({ membersError: '' })
    const sessionName = (this.data.user && this.data.user.name) || ''
    let selfNickname = ''
    ;(data || []).forEach(function (m) {
      if (m.owner_id === uid && m.nickname) selfNickname = m.nickname
    })
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
    this.setData({
      members: members,
      nicknameInput: getApp().globalData.myNickname || selfNickname || '',
    })
  },

  // ===== 数据备份：导出 JSON 快照 / items CSV，写给微信会话 =====

  onexportjson() {
    return this.doExport('json')
  },

  onexportcsv() {
    return this.doExport('csv')
  },

  async doExport(kind) {
    if (this.data.exportBusy) return
    this.setData({ exportBusy: true })
    wx.showLoading({ title: '导出中…', mask: true })
    try {
      const hid = await this.resolveHouseholdId()
      if (!hid) {
        wx.hideLoading()
        wx.showToast({ title: '请先创建或加入家庭', icon: 'none' })
        return
      }
      const result = await buildFamilyExport(hid)
      const stamp = dateStamp(new Date())
      const isJson = kind === 'json'
      const fileName = isJson ? '小咪工具箱备份-' + stamp + '.json' : '小咪工具箱-items-' + stamp + '.csv'
      const content = isJson ? JSON.stringify(result.json, null, 2) : result.itemsCsv
      const res = await writeAndShare(fileName, content)
      wx.hideLoading()
      // 记录落盘路径：取消分享或客户端不支持分享时仍可重发
      if (res && res.path) {
        this.setData({ lastExportPath: res.path, lastExportName: fileName })
      }
      this.handleShareOutcome(res)
    } catch (e) {
      wx.hideLoading()
      wx.showToast({ title: (e && e.message) || '导出失败', icon: 'none' })
    } finally {
      this.setData({ exportBusy: false })
    }
  },

  // 分享结果三分支：成功 / 用户取消 / 真正的失败
  handleShareOutcome(res) {
    if (res && res.ok) {
      wx.showToast({ title: '已发送', icon: 'none' })
      return
    }
    if (res && res.canceled) {
      wx.showModal({
        title: '已取消分享',
        content: '文件已保存在本地，可点「重新分享上次文件」再发一次',
        showCancel: false,
        confirmText: '知道了',
      })
      return
    }
    if (res && res.saved) {
      wx.showToast({ title: '文件已保存到本地，可点下方重新分享', icon: 'none' })
      return
    }
    wx.showToast({ title: (res && res.error) || '导出失败', icon: 'none' })
  },

  // 重新分享上次导出的文件，不再重复生成数据
  resharelast() {
    if (this.data.exportBusy) return
    const filePath = this.data.lastExportPath
    if (!filePath) {
      wx.showToast({ title: '暂无可分享的文件', icon: 'none' })
      return
    }
    if (typeof wx.shareFileMessage !== 'function') {
      wx.showToast({ title: '当前微信版本不支持分享文件', icon: 'none' })
      return
    }
    this.setData({ exportBusy: true })
    wx.showLoading({ title: '分享中…', mask: true })
    try {
      wx.shareFileMessage({
        filePath: filePath,
        fileName: this.data.lastExportName,
        success: () => {
          wx.hideLoading()
          this.setData({ exportBusy: false })
          wx.showToast({ title: '已发送', icon: 'none' })
        },
        fail: (err) => {
          wx.hideLoading()
          this.setData({ exportBusy: false })
          const msg = (err && (err.errMsg || err.errMessage)) || ''
          if (msg.toLowerCase().indexOf('cancel') >= 0) {
            this.handleShareOutcome({ canceled: true })
            return
          }
          console.warn('shareFileMessage fail:', msg)
          wx.showToast({ title: '分享失败，请稍后重试', icon: 'none' })
        },
      })
    } catch (e) {
      wx.hideLoading()
      this.setData({ exportBusy: false })
      console.warn('shareFileMessage exception:', (e && e.message) || '')
      wx.showToast({ title: '分享失败，请稍后重试', icon: 'none' })
    }
  },

  // session → members 取本人 household_id，与 loadHousehold 的查法保持一致
  async resolveHouseholdId() {
    const { data: session } = await cloud.auth.getSession()
    const uid = session && session.user && session.user.id
    if (!uid) return null
    const { data: mine, error } = await cloud.database
      .from('members')
      .select('household_id')
      .eq('owner_id', uid)
      .limit(1)
    if (error) throw new Error(error.message || '读取家庭信息失败')
    const row = mine && mine[0]
    return row ? row.household_id : null
  },

  // V2 Step4：操作记录入口
  gorecords() {
    wx.navigateTo({ url: '/pages/records/records' })
  },

  // 回收站入口（契约 v2.0 软删除）
  gotrash() {
    wx.navigateTo({ url: '/pages/trash/trash' })
  },

  goallergy(e) { this.goAllergy(e) },

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

  retryProfile() {
    this.restore()
  },

  retryprofile() { this.retryProfile() },

  retryMembers() {
    this.loadHousehold()
  },

  retrymembers() { this.retryMembers() },

  goHome() {
    wx.switchTab({ url: '/pages/home/home' })
  },

  gohome() { this.goHome() },

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
    wx.setClipboardData({
      data: this.data.household.invite_code,
      success: () => wx.showToast({ title: '邀请码已复制', icon: 'none' }),
    })
  },

  onsignout() { this.onSignOut() },

  async onSignOut() {
    if (this.data.signOutBusy) return
    this.setData({ signOutBusy: true })
    try {
      const res = await cloud.auth.signOut()
      if (res && res.error) throw res.error
      getApp().resetSession()
      this.setData({ authState: 'signed-out', user: null, household: null, members: [], isOwner: false })
    } catch (e) {
      wx.showToast({ title: (e && e.message) || '退出失败，请重试', icon: 'none' })
    } finally {
      this.setData({ signOutBusy: false })
    }
  },
})
