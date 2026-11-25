const { cloud } = require('../../utils/cloud')
const { buildFamilyExport, writeAndShare } = require('../../utils/export')

function dateStamp(date) {
  const part = (n) => String(n).padStart(2, '0')
  return String(date.getFullYear()) + part(date.getMonth() + 1) + part(date.getDate())
}

Page({
  data: {
    authState: 'checking',
    household: null,
    householdError: '',
    householdErrorTitle: '',
    displayName: '',
    isOwner: false,
    canLeave: false,
    members: [],
    membersExpanded: false,
    membersLoading: false,
    membersError: '',
    nicknameInput: '',
    nicknameDirty: false,
    nicknameBusy: false,
    signOutBusy: false,
    memberBusy: false,
    loginError: '',
    loginLoading: false,
    largeText: false,
    exportBusy: false,
    lastExportName: '',
  },

  onShow() {
    this.setData({ largeText: getApp().globalData.largeText })
    this.restore()
  },

  onlargetextchange(e) {
    const enabled = !!e.detail.value
    getApp().setLargeText(enabled)
    this.setData({ largeText: enabled })
  },

  async restore() {
    const request = (this.profileRequest || 0) + 1
    this.profileRequest = request
    this.profileContext = null
    this.setData({ authState: 'checking', householdError: '', household: null, members: [], lastExportName: '' })
    let user
    try {
      const result = await getApp().ensureSession()
      if (result.error) throw result.error
      user = result.data && result.data.user
    } catch (error) {
      if (request === this.profileRequest) {
        this.setData({
          authState: 'error',
          householdErrorTitle: '暂时无法验证登录状态',
          householdError: '请检查网络连接后重试',
        })
      }
      return
    }
    if (request !== this.profileRequest) return
    if (!user || !user.id) {
      this.lastExport = null
      this.setData({ authState: 'signed-out', isOwner: false, canLeave: false })
      return
    }
    try {
      const { data, error } = await cloud.database
        .from('members')
        .select('id, household_id, role, nickname, households(id, name, invite_code)')
        .eq('owner_id', user.id)
        .limit(1)
      if (request !== this.profileRequest) return
      if (error) throw error
      const row = data && data[0]
      if (row && !row.households) throw new Error('家庭记录不可用')
      const name = user.name || '微信用户'
      const context = row
        ? { userId: user.id, householdId: row.household_id, memberId: row.id, name, isOwner: row.role === 'owner' }
        : null
      this.profileContext = context
      if (!context || !this.exportMatches(context, this.lastExport)) this.lastExport = null
      this.setData({
        authState: 'signed-in',
        household: row ? row.households : null,
        isOwner: !!(context && context.isOwner),
        canLeave: !!(row && row.role === 'member'),
        displayName: (row && row.nickname) || name,
        nicknameInput: (row && row.nickname) || '',
        nicknameDirty: false,
        membersLoading: !!context,
        membersError: '',
        lastExportName: this.lastExport ? this.lastExport.name : '',
      })
      if (context) this.loadMembers(context)
    } catch (error) {
      if (request === this.profileRequest) {
        this.setData({
          authState: 'error',
          householdErrorTitle: '家庭信息暂时无法加载',
          householdError: '请检查网络连接后重试',
        })
      }
    }
  },

  retryprofile() { this.restore() },

  togglemembers() { this.setData({ membersExpanded: !this.data.membersExpanded }) },

  retrymembers() {
    if (this.profileContext && !this.data.membersLoading) this.loadMembers(this.profileContext)
  },

  async loadMembers(context) {
    this.setData({ membersLoading: true, membersError: '' })
    try {
      const { data, error } = await cloud.database
        .from('members')
        .select('id, owner_id, role, nickname, joined_at')
        .eq('household_id', context.householdId)
        .is('left_at', null)
        .order('joined_at', { ascending: true })
      if (this.profileContext !== context) return
      if (error) throw error
      const members = (data || []).map((member) => {
        const isSelf = String(member.id) === String(context.memberId)
        return {
          id: member.id,
          isSelf,
          nameText: member.nickname || (isSelf ? context.name : '微信用户'),
          roleLabel: member.role === 'owner' ? '管理员' : '成员',
          joinedText: member.joined_at ? String(member.joined_at).slice(0, 10) : '',
          canRemove: context.isOwner && !isSelf && member.role === 'member',
        }
      })
      this.setData({ members, membersLoading: false })
    } catch (error) {
      if (this.profileContext === context) this.setData({ members: [], membersError: '成员信息读取失败', membersLoading: false })
    }
  },

  onnicknameinput(e) {
    this.setData({ nicknameInput: e.detail.value, nicknameDirty: true })
  },

  async savenickname() {
    const context = this.profileContext
    if (!context || this.data.nicknameBusy) return
    const nickname = this.data.nicknameInput.trim()
    if (!nickname) {
      wx.showToast({ title: '请输入昵称', icon: 'none' })
      return
    }
    this.setData({ nicknameBusy: true })
    try {
      const { data, error } = await cloud.database
        .from('members')
        .update({ nickname })
        .eq('id', context.memberId)
        .eq('household_id', context.householdId)
        .select('id')
      if (error || !data || !data.length) throw error || new Error('保存失败')
      if (this.profileContext !== context) return
      getApp().globalData.myNickname = nickname
      this.setData({ nicknameInput: nickname, nicknameDirty: false, displayName: nickname })
      this.loadMembers(context)
      wx.showToast({ title: '已保存', icon: 'success' })
    } catch (error) {
      wx.showToast({ title: error.message || '保存失败', icon: 'none' })
    } finally {
      this.setData({ nicknameBusy: false })
    }
  },

  chooseexport() {
    const context = this.profileContext
    if (!context || this.data.exportBusy) return
    wx.showActionSheet({
      itemList: ['家庭数据备份 JSON', '物品表格 CSV'],
      success: (result) => {
        if (this.profileContext !== context) return
        if (result.tapIndex === 0) this.doExport(context, 'json')
        if (result.tapIndex === 1) this.doExport(context, 'csv')
      },
    })
  },

  exportMatches(context, file) {
    return !!file && file.userId === context.userId && String(file.householdId) === String(context.householdId)
  },

  async verifyExportContext(context) {
    if (!context) return false
    const session = await getApp().ensureSession()
    if (session.error) throw session.error
    if (this.profileContext !== context || !session.data || !session.data.user || session.data.user.id !== context.userId) return false
    const { data, error } = await cloud.database
      .from('members')
      .select('id')
      .eq('owner_id', context.userId)
      .eq('household_id', context.householdId)
      .eq('id', context.memberId)
      .limit(1)
    if (error) throw error
    return this.profileContext === context && !!(data && data.length)
  },

  async doExport(context, kind) {
    if (this.data.exportBusy || this.data.signOutBusy || this.data.memberBusy) return
    this.setData({ exportBusy: true })
    wx.showLoading({ title: '导出中…', mask: true })
    try {
      if (!(await this.verifyExportContext(context))) throw new Error('家庭成员资格已变化，请刷新')
      const result = await buildFamilyExport(context.householdId, kind)
      if (!(await this.verifyExportContext(context))) throw new Error('家庭成员资格已变化，请刷新')
      const now = new Date()
      const isJson = kind === 'json'
      const suffix = dateStamp(now) + '-' + now.getTime()
      const fileName = isJson ? '小咪工具箱备份-' + suffix + '.json' : '小咪工具箱物品-' + suffix + '.csv'
      const content = isJson ? JSON.stringify(result.json, null, 2) : result.itemsCsv
      wx.hideLoading()
      const share = await writeAndShare(fileName, content)
      if (share && share.path && this.profileContext === context) {
        this.lastExport = { userId: context.userId, householdId: context.householdId, name: fileName, path: share.path }
        this.setData({ lastExportName: fileName })
      }
      this.handleShareOutcome(share)
    } catch (error) {
      wx.hideLoading()
      wx.showToast({ title: error.message || '导出失败', icon: 'none' })
    } finally {
      this.setData({ exportBusy: false })
    }
  },

  handleShareOutcome(res) {
    if (res && res.ok) {
      wx.showToast({ title: '已发送', icon: 'none' })
      return
    }
    if (res && res.canceled) {
      wx.showToast({ title: '已保存文件，可重新分享', icon: 'none' })
      return
    }
    if (res && res.saved) {
      wx.showToast({ title: '已保存文件，分享未完成', icon: 'none' })
      return
    }
    wx.showToast({ title: (res && res.error) || '导出失败', icon: 'none' })
  },

  async resharelast() {
    const context = this.profileContext
    const file = this.lastExport
    if (this.data.exportBusy || this.data.signOutBusy || this.data.memberBusy || !context || !this.exportMatches(context, file)) return
    if (typeof wx.shareFileMessage !== 'function') {
      wx.showToast({ title: '当前微信版本不支持分享文件', icon: 'none' })
      return
    }
    this.setData({ exportBusy: true })
    try {
      if (!(await this.verifyExportContext(context))) throw new Error('家庭成员资格已变化，请刷新')
      await new Promise((resolve, reject) => {
        wx.shareFileMessage({ filePath: file.path, fileName: file.name, success: resolve, fail: reject })
      })
      wx.showToast({ title: '已发送', icon: 'none' })
    } catch (error) {
      const message = error.errMsg || error.message || ''
      if (message.toLowerCase().includes('cancel')) this.handleShareOutcome({ canceled: true })
      else wx.showToast({ title: error.message || '分享失败，请稍后重试', icon: 'none' })
    } finally {
      this.setData({ exportBusy: false })
    }
  },

  gorecords() { wx.navigateTo({ url: '/pages/records/records' }) },
  gotrash() { wx.navigateTo({ url: '/pages/trash/trash' }) },
  gohome() { wx.switchTab({ url: '/pages/home/home' }) },

  goallergy(e) {
    const { id, name } = e.currentTarget.dataset
    if (id) wx.navigateTo({ url: '/pages/allergy/allergy?member_id=' + encodeURIComponent(id) + '&nickname=' + encodeURIComponent(name || '') })
  },

  onmembermenu(e) {
    const context = this.profileContext
    const { id } = e.currentTarget.dataset
    if (!context || !context.isOwner || !id || this.data.memberBusy) return
    wx.showActionSheet({
      itemList: ['过敏档案', '移除成员'],
      success: (result) => {
        if (this.profileContext !== context) return
        if (result.tapIndex === 0) this.goallergy(e)
        if (result.tapIndex === 1) {
          wx.showModal({
            title: '移除成员',
            content: '该成员将失去本家庭数据的访问权限。',
            confirmColor: '#C4271E',
            success: (answer) => {
              if (answer.confirm && this.profileContext === context) this.changeMembership('remove_member', { p_member_id: id })
            },
          })
        }
      },
    })
  },

  onleavehousehold() {
    const context = this.profileContext
    if (!context || !this.data.canLeave || this.data.memberBusy || this.data.exportBusy) return
    wx.showModal({
      title: '退出家庭',
      content: '退出后，你将无法查看这个家庭的库存和用药记录。',
      confirmColor: '#C4271E',
      success: (res) => {
        if (res.confirm && this.profileContext === context) this.changeMembership('leave_household', {})
      },
    })
  },

  async changeMembership(action, args) {
    if (this.data.memberBusy || this.data.exportBusy || this.data.signOutBusy) return
    this.setData({ memberBusy: true })
    wx.showLoading({ title: '处理中…', mask: true })
    try {
      const { data, error } = await cloud.database.rpc(action, args)
      if (error) throw error
      const messages = {
        owner_cannot_leave: '管理员不可退出家庭',
        forbidden: '无权移除该成员',
        not_signed_in: '请先登录',
        not_found: action === 'leave_household' ? '未加入任何家庭' : '成员不存在',
      }
      if (messages[data]) {
        wx.showToast({ title: messages[data], icon: 'none' })
        if (data !== 'not_found') return
      } else if (data === 'ok') {
        wx.showToast({ title: action === 'leave_household' ? '已退出家庭' : '已移除成员', icon: 'success' })
      } else {
        throw new Error('操作结果待确认，请刷新')
      }
      if (action === 'leave_household') {
        this.lastExport = null
        getApp().resetSession()
      }
      await this.restore()
    } catch (error) {
      wx.showToast({ title: error.message || '操作失败，请重试', icon: 'none' })
    } finally {
      wx.hideLoading()
      this.setData({ memberBusy: false })
    }
  },

  async onwechatlogin() {
    if (this.data.loginLoading) return
    this.setData({ loginLoading: true, loginError: '' })
    try {
      const res = await getApp().loginWithWechat()
      if (res.error || !res.data) throw res.error || new Error('登录失败')
      await this.restore()
    } catch (error) {
      this.setData({ loginError: error.message || '登录失败，请重试' })
    } finally {
      this.setData({ loginLoading: false })
    }
  },

  copyinvitecode() {
    const code = this.data.household && this.data.household.invite_code
    if (code) wx.setClipboardData({ data: code })
  },

  onsignout() {
    if (this.data.signOutBusy || this.data.exportBusy || this.data.memberBusy) return
    wx.showModal({
      title: '退出登录',
      content: '下次查看家庭记录时，需要重新登录。',
      confirmColor: '#C4271E',
      success: (res) => { if (res.confirm) this.signOut() },
    })
  },

  async signOut() {
    if (this.data.signOutBusy || this.data.exportBusy || this.data.memberBusy) return
    this.setData({ signOutBusy: true })
    try {
      const res = await cloud.auth.signOut()
      if (res && res.error) throw res.error
      this.profileRequest = (this.profileRequest || 0) + 1
      this.profileContext = null
      this.lastExport = null
      getApp().resetSession()
      this.setData({
        authState: 'signed-out', household: null, isOwner: false, canLeave: false,
        members: [], membersExpanded: false, nicknameInput: '', lastExportName: '',
      })
    } catch (error) {
      wx.showToast({ title: error.message || '退出失败，请重试', icon: 'none' })
    } finally {
      this.setData({ signOutBusy: false })
    }
  },
})
