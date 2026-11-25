const { cloud } = require('../../utils/cloud')
const { indexAllergyMatches } = require('../../utils/allergy')
const { toDateOnly } = require('../../utils/date')
const { itemIllustration } = require('../../utils/constants')

const FREQ_LABEL = { daily: '每天', alternate_day: '隔天' }
const PLAN_STATUS_LABEL = { active: '进行中', finished: '已结束', cancelled: '已取消' }
const DOSE_STATUS_LABEL = { pending: '待确认', taken: '已确认', missed: '标记漏服' }
const RPC_ERRORS = {
  forbidden_allergy: '服药人的档案匹配禁用关联，打卡未记录',
  invalid_transition: '记录状态已变化，请查看最新记录',
  schedule_changed: '计划已变化，请查看最新记录',
  not_found: '记录不存在或已移除',
  forbidden_household: '无权操作该记录',
  not_signed_in: '登录状态已失效，请重新登录',
}

function formatHM(iso) {
  const d = new Date(iso)
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}

Page({
  data: {
    largeText: false,
    authState: 'checking',
    loginLoading: false,
    loginError: '',
    householdId: null,
    todayText: '',
    timeline: [],
    activePlans: [],
    historyPlans: [],
    loadState: 'loading',
    loadError: '',
    allergyState: 'loading',
    doseBusyId: null,
    planBusy: false,
    showHistory: false,
    progress: { taken: 0, pending: 0, missed: 0, percent: 0 },
  },

  onShow() {
    this.setData({ largeText: getApp().globalData.largeText })
    this.restore()
  },

  async restore() {
    const requestId = this.loadId = (this.loadId || 0) + 1
    this.setData({ authState: 'checking', householdId: null, loadError: '' })
    try {
      const { data: session, error } = await getApp().ensureSession()
      if (requestId !== this.loadId) return
      if (error) throw error
      const uid = session && session.user && session.user.id
      if (!uid) {
        this.setData({ authState: 'signed-out' })
        return
      }
      const { data: mine, error: householdError } = await cloud.database
        .from('members')
        .select('household_id')
        .eq('owner_id', uid)
        .is('left_at', null)
        .limit(1)
      if (requestId !== this.loadId) return
      if (householdError) throw householdError
      const row = mine && mine[0]
      if (!row) {
        this.setData({ authState: 'no-household' })
        return
      }
      this.setData({ authState: 'ready', householdId: row.household_id })
      await this.loadAll(row.household_id)
    } catch (e) {
      if (requestId !== this.loadId) return
      this.setData({ authState: 'error', loadError: '家庭信息暂时无法加载，请重试' })
    }
  },

  retryload() {
    if (this.data.householdId) this.loadAll(this.data.householdId)
    else this.restore()
  },

  gohome() {
    wx.switchTab({ url: '/pages/home/home' })
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

  async loadAll(hid) {
    const requestId = this.loadId = (this.loadId || 0) + 1
    const now = new Date()
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString()
    this.setData({
      loadState: 'loading',
      loadError: '',
      allergyState: 'loading',
      todayText: now.getMonth() + 1 + '月' + now.getDate() + '日',
    })

    try {
      const [memberRes, itemRes, doseRes, planRes, allergyRes, linkRes] = await Promise.all([
        cloud.database.from('members').select('id, nickname, left_at').eq('household_id', hid),
        // 软删除药品仍用于历史记录的名称映射。
        cloud.database.from('items').select('id, name, is_deleted').eq('household_id', hid),
        cloud.database.from('medication_doses')
          .select('id, plan_id, scheduled_at, status')
          .eq('household_id', hid)
          .gte('scheduled_at', start)
          .lt('scheduled_at', end)
          .order('scheduled_at', { ascending: true }),
        cloud.database.from('medication_plans')
          .select('id, item_id, member_id, times, freq, start_date, end_date, status')
          .eq('household_id', hid)
          .order('created_at', { ascending: false }),
        cloud.database.from('allergies').select('member_id, allergen').eq('household_id', hid),
        cloud.database.from('drug_allergy_links').select('item_id, allergen, kind').eq('household_id', hid),
      ])
      if (requestId !== this.loadId) return
      if (memberRes.error || itemRes.error || doseRes.error || planRes.error) {
        this.setData({ loadState: 'error', loadError: '用药安排暂时无法加载，请重试' })
        return
      }

      const members = new Map((memberRes.data || []).map((m) => [String(m.id), m]))
      const items = new Map((itemRes.data || []).map((i) => [String(i.id), i]))
      const plans = planRes.data || []
      const planMap = new Map(plans.map((p) => [String(p.id), p]))
      const allergyState = allergyRes.error || linkRes.error ? 'error' : 'ready'
      const matches = indexAllergyMatches(allergyRes.data || [], linkRes.data || [])

      function describePlan(plan) {
        const p = plan || {}
        const item = items.get(String(p.item_id))
        const member = members.get(String(p.member_id))
        const kind = allergyState === 'ready' && item && member
          ? matches.get(p.item_id + '|' + p.member_id) || ''
          : 'unknown'
        return {
          itemName: item ? item.name : '未知药品',
          itemIllu: itemIllustration(item && item.name, 'medicine'),
          memberName: member ? member.nickname || '成员' : '未知成员',
          itemUnavailable: !!(item && item.is_deleted),
          memberArchived: !!(member && member.left_at),
          conflictKind: kind,
          conflictLabel: { forbidden: '档案匹配禁用关联', caution: '档案匹配慎用关联', unknown: '关联未核对' }[kind] || '',
        }
      }

      const progress = { taken: 0, pending: 0, missed: 0, percent: 0 }
      const timeline = (doseRes.data || []).map((d) => {
        const plan = planMap.get(String(d.plan_id))
        const info = describePlan(plan)
        if (d.status === 'taken') progress.taken++
        if (d.status === 'pending') progress.pending++
        if (d.status === 'missed') progress.missed++
        return {
          ...info,
          id: d.id,
          time: formatHM(d.scheduled_at),
          status: d.status,
          statusLabel: DOSE_STATUS_LABEL[d.status] || '状态未知',
          statusClass: d.status === 'taken' ? 'tag-green' : d.status === 'missed' ? 'tag-red' : 'dose-status',
          cannotConfirm: info.itemUnavailable ? '药品已移入回收站' : info.memberArchived ? '服药人已退出家庭' : '',
          canConfirm: d.status === 'pending' && !info.itemUnavailable && !info.memberArchived &&
            info.conflictKind !== 'forbidden' && info.conflictKind !== 'unknown',
          canCorrect: d.status === 'taken',
        }
      })
      if (timeline.length) progress.percent = Math.round(progress.taken * 100 / timeline.length)

      const activePlans = []
      const historyPlans = []
      const today = toDateOnly(now)
      plans.forEach((p) => {
        const info = describePlan(p)
        const expired = p.status === 'active' && p.end_date && p.end_date < today
        const view = {
          ...info,
          id: p.id,
          timesText: (p.times || []).join(' / '),
          freqLabel: FREQ_LABEL[p.freq] || '频次未知',
          courseText: p.start_date + ' 至 ' + (p.end_date || '未设结束日期'),
          statusLabel: expired ? '疗程已到期' : PLAN_STATUS_LABEL[p.status] || '状态未知',
          canManage: p.status === 'active',
        }
        if (view.canManage && !expired) activePlans.push(view)
        else historyPlans.push(view)
      })

      this.setData({ loadState: 'ready', allergyState, timeline, activePlans, historyPlans, progress })
    } catch (e) {
      if (requestId !== this.loadId) return
      this.setData({ loadState: 'error', loadError: '用药安排暂时无法加载，请重试' })
    }
  },

  confirmDose(e) {
    const id = e.currentTarget.dataset.id
    if (this.data.loadState !== 'ready' || this.data.doseBusyId !== null) return
    const dose = this.data.timeline.find((d) => d.id === id)
    if (!dose || !dose.canConfirm) return
    this.transitionDose(id, 'taken')
  },

  correctDose(e) {
    const id = e.currentTarget.dataset.id
    if (this.data.loadState !== 'ready' || this.data.doseBusyId !== null) return
    wx.showModal({
      title: '更正打卡',
      content: '此条记录将标记为漏服。确认这次打卡是误操作后再更正。',
      confirmText: '确认更正',
      confirmColor: '#A32D2D',
      success: (res) => {
        if (res.confirm) this.transitionDose(id, 'missed')
      },
    })
  },

  async transitionDose(id, targetStatus) {
    const householdId = this.data.householdId
    if (!householdId || this.data.loadState !== 'ready' || this.data.doseBusyId !== null) return
    const dose = this.data.timeline.find((d) => d.id === id)
    if (!dose || !(targetStatus === 'taken' ? dose.canConfirm : dose.canCorrect)) return

    this.setData({ doseBusyId: id })
    try {
      const { data, error } = await cloud.database.rpc('transition_dose', {
        p_dose_id: id,
        p_target_status: targetStatus,
      })
      if (error) throw error
      if (data === 'ok') {
        wx.showToast({ title: targetStatus === 'taken' ? '已确认服药' : '已标记漏服', icon: 'success' })
      } else {
        wx.showToast({ title: RPC_ERRORS[data] || '暂时无法更新打卡', icon: 'none' })
      }
    } catch (e) {
      wx.showToast({ title: '同步结果未确认，正在刷新记录', icon: 'none' })
    } finally {
      if (this.data.householdId === householdId) await this.loadAll(householdId)
      this.setData({ doseBusyId: null })
    }
  },

  goadherence() {
    wx.navigateTo({ url: '/pages/adherence/adherence' })
  },

  goallergy() {
    wx.navigateTo({ url: '/pages/allergy/allergy' })
  },

  goNewPlan() {
    wx.navigateTo({ url: '/pages/plan-form/plan-form' })
  },

  toggleHistory() {
    this.setData({ showHistory: !this.data.showHistory })
  },

  openPlanActions(e) {
    const id = e.currentTarget.dataset.id
    if (this.data.planBusy || this.data.loadState !== 'ready' || !this.canManagePlan(id)) return
    wx.showActionSheet({
      itemList: ['编辑计划', '取消计划'],
      success: (res) => {
        if (res.tapIndex === 0) wx.navigateTo({ url: '/pages/plan-form/plan-form?id=' + id })
        if (res.tapIndex === 1) this.cancelPlan(id)
      },
    })
  },

  canManagePlan(id) {
    return this.data.activePlans.concat(this.data.historyPlans).some((p) => p.id === id && p.canManage)
  },

  cancelPlan(id) {
    wx.showModal({
      title: '取消用药计划',
      content: '取消后将停止未来提醒，历史记录保留。',
      confirmText: '取消计划',
      cancelText: '返回',
      confirmColor: '#A32D2D',
      success: (res) => {
        if (res.confirm) this.doCancelPlan(id)
      },
    })
  },

  async doCancelPlan(id) {
    const householdId = this.data.householdId
    if (!householdId || this.data.planBusy || this.data.loadState !== 'ready' ||
        !this.canManagePlan(id)) return
    this.setData({ planBusy: true })
    try {
      const { data, error } = await cloud.database.rpc('cancel_plan_atomic', { p_plan_id: id })
      if (error) throw error
      if (data === 'ok') wx.showToast({ title: '计划已取消', icon: 'success' })
      else wx.showToast({ title: RPC_ERRORS[data] || '暂时无法取消计划', icon: 'none' })
    } catch (e) {
      wx.showToast({ title: '同步结果未确认，正在刷新计划', icon: 'none' })
    } finally {
      if (this.data.householdId === householdId) await this.loadAll(householdId)
      this.setData({ planBusy: false })
    }
  },
})
