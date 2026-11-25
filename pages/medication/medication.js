const { cloud } = require('../../utils/cloud')
const { plansAccess, dosesAccess } = require('../../utils/data-access')
const { matchAllergies } = require('../../utils/allergy')

const FREQ_LABEL = { daily: '每天', alternate_day: '隔天' }
const PLAN_STATUS_LABEL = { active: '进行中', finished: '已结束', cancelled: '已取消' }
const DOSE_STATUS_LABEL = { pending: '待确认', taken: '已服药', missed: '漏服' }

function conflictLabelOf(kind) {
  if (kind === 'forbidden') return '禁用'
  if (kind === 'caution') return '慎用'
  return ''
}

function pad2(n) {
  return String(n).padStart(2, '0')
}

function formatHM(iso) {
  const d = new Date(iso)
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes())
}

function dayRange(now) {
  const d = now || new Date()
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const end = new Date(start.getTime() + 86400000)
  return { start: start.toISOString(), end: end.toISOString() }
}

Page({
  data: {
    largeText: false,
    authState: 'checking', // checking | signed-out | no-household | ready
    loginLoading: false,
    loginError: '',
    householdId: null,
    todayText: '',
    timeline: [],
    plans: [],
    loading: true,
    loadState: 'loading', // loading | ready | error
    loadError: '',
    allergyState: 'loading', // loading | ready | error
    allergyError: '',
    doseBusy: false,
    planBusy: false,
  },

  onShow() {
    this.setData({ largeText: getApp().globalData.largeText })
    this.restore()
  },

  async restore() {
    this.setData({ authState: 'checking', loadError: '' })
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

  retryLoad() {
    if (this.data.householdId) this.loadAll(this.data.householdId)
    else this.restore()
  },

  retryload() { this.retryLoad() },

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

  async loadHousehold() {
    const { data: session } = await cloud.auth.getSession()
    const uid = session && session.user && session.user.id
    if (!uid) {
      this.setData({ authState: 'signed-out' })
      return
    }
    const { data: mine, error: householdError } = await cloud.database
      .from('members')
      .select('household_id')
      .eq('owner_id', uid)
      .limit(1)
    if (householdError) {
      this.setData({
        authState: 'error',
        loadState: 'error',
        loadError: (householdError && householdError.message) || '家庭信息加载失败，请重试',
      })
      return
    }
    const row = mine && mine[0]
    if (!row) {
      this.setData({ authState: 'no-household', loading: false })
      return
    }
    this.setData({ authState: 'ready', householdId: row.household_id })
    await this.loadAll(row.household_id)
  },

  async loadAll(hid) {
    this.setData({ loading: true, loadState: 'loading', allergyState: 'loading', loadError: '', allergyError: '' })
    const now = new Date()
    const range = dayRange(now)
    this.setData({ todayText: now.getMonth() + 1 + '月' + now.getDate() + '日' })

    const memberRes = await cloud.database
      .from('members')
      .select('id, owner_id, nickname, role')
      .eq('household_id', hid)
    // 名称映射不过滤 is_deleted（契约 v2.0）：已删药品的历史计划与剂量仍需显示原名
    const itemRes = await cloud.database
      .from('items')
      .select('id, name, category')
      .eq('household_id', hid)
    if (memberRes.error || itemRes.error) {
      this.setData({ loading: false, loadState: 'error', loadError: '用药信息暂时无法加载，请重试' })
      return
    }
    const members = memberRes.data || []
    const items = itemRes.data || []
    const memberNameMap = {}
    members.forEach(function (m) {
      memberNameMap[m.id] = m.nickname || '成员'
    })
    const itemNameMap = {}
    items.forEach(function (i) {
      itemNameMap[i.id] = i.name
    })

    // 冲突标（P0-1 修复）：按计划服药人 member_id 的过敏档案判断，而非登录用户。
    // 一次查询全家过敏档案 + 全部药品关联，避免逐计划 N+1；
    // 任一查询失败 → conflictState='error'，所有条目显示「冲突未知」，不得显示为安全。
    const hitsByItemMember = {}
    let conflictState = 'ready'
    const alRes = await cloud.database
      .from('allergies')
      .select('member_id, allergen')
      .eq('household_id', hid)
    const linkRes = await cloud.database
      .from('drug_allergy_links')
      .select('item_id, allergen, kind')
      .eq('household_id', hid)
    if (alRes.error || linkRes.error) {
      conflictState = 'error'
      this.setData({ allergyState: 'error', allergyError: '过敏档案或药品关联加载失败，冲突状态未知，请重试' })
    } else {
      const allergensByMember = {}
      ;(alRes.data || []).forEach(function (a) {
        if (!allergensByMember[a.member_id]) allergensByMember[a.member_id] = []
        allergensByMember[a.member_id].push(a.allergen)
      })
      const links = linkRes.data || []
      members.forEach(function (m) {
        const allergens = allergensByMember[m.id]
        if (!allergens || !allergens.length) return
        links.forEach(function (l) {
          const hit = matchAllergies(allergens, [l])
          if (!hit.length) return
          const key = l.item_id + '|' + m.id
          const kind = hit[0].kind
          if (!hitsByItemMember[key] || kind === 'forbidden') hitsByItemMember[key] = kind
        })
      })
      this.setData({ allergyState: 'ready' })
    }

    // 按计划（item_id × member_id）取冲突：forbidden 优先；unknown 仅在档案加载失败时出现
    function conflictOf(p) {
      if (conflictState === 'error') {
        return { kind: 'unknown', label: '冲突未知', forbid: false, unknown: true }
      }
      const kind = hitsByItemMember[p.item_id + '|' + p.member_id]
      if (!kind) return { kind: '', label: '', forbid: false, unknown: false }
      const name = memberNameMap[p.member_id] || '该成员'
      return {
        kind: kind,
        label: name + ' ' + conflictLabelOf(kind),
        forbid: kind === 'forbidden',
        unknown: false,
      }
    }

    const doseRes = await cloud.database
      .from('medication_doses')
      .select('id, plan_id, scheduled_at, confirmed_at, status')
      .eq('household_id', hid)
      .gte('scheduled_at', range.start)
      .lt('scheduled_at', range.end)
      .order('scheduled_at', { ascending: true })

    const planRes = await cloud.database
      .from('medication_plans')
      .select('id, item_id, member_id, times, freq, start_date, end_date, miss_threshold_minutes, status')
      .eq('household_id', hid)
      .order('created_at', { ascending: false })

    if (doseRes.error || planRes.error) {
      this.setData({ loading: false, loadState: 'error', loadError: '用药安排暂时无法加载，请重试' })
      return
    }

    const planMap = {}
    ;(planRes.data || []).forEach(function (p) {
      planMap[p.id] = p
    })

    const timeline = (doseRes.data || []).map(function (d) {
      const p = planMap[d.plan_id] || {}
      const c = conflictOf(p)
      return {
        id: d.id,
        time: formatHM(d.scheduled_at),
        itemName: itemNameMap[p.item_id] || '未知药品',
        memberName: memberNameMap[p.member_id] || '',
        status: d.status,
        statusLabel: DOSE_STATUS_LABEL[d.status] || d.status,
        statusClass: d.status === 'taken' ? 'tag-green' : d.status === 'missed' ? 'tag-red' : 'tag-amber',
        canConfirm: d.status === 'pending' && !c.forbid,
        canCorrect: d.status === 'taken',
        conflictKind: c.kind,
        conflictLabel: c.label,
        conflictForbid: c.forbid,
        conflictUnknown: c.unknown,
      }
    })

    const plans = (planRes.data || []).map(function (p) {
      const c = conflictOf(p)
      return {
        id: p.id,
        itemName: itemNameMap[p.item_id] || '未知药品',
        memberName: memberNameMap[p.member_id] || '',
        timesText: (p.times || []).join(' / '),
        freqLabel: FREQ_LABEL[p.freq] || p.freq,
        courseText: p.start_date + ' ~ ' + p.end_date,
        statusLabel: PLAN_STATUS_LABEL[p.status] || p.status,
        status: p.status,
        canEdit: p.status === 'active',
        conflictKind: c.kind,
        conflictLabel: c.label,
        conflictForbid: c.forbid,
        conflictUnknown: c.unknown,
      }
    })

    this.setData({ loading: false, loadState: 'ready', timeline: timeline, plans: plans })
  },

  findDoseById(id) {
    const list = this.data.timeline || []
    for (let i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i]
    }
    return null
  },

  // 打卡：pending → taken（contract v1.7：confirmed_at=now）
  // P0-2：禁用药物（按服药人档案命中 forbidden）在客户端二次拦截，不依赖 UI 隐藏按钮
  async confirmDose(e) {
    const id = e.currentTarget.dataset.id
    if (!id || this.data.doseBusy) return
    const dose = this.findDoseById(id)
    if (dose && dose.conflictForbid) {
      const that = this
      wx.showModal({
        title: '无法确认已服',
        content: (dose.memberName || '该成员') + ' 的过敏档案命中「禁用」，请与医生确认后调整用药计划。',
        showCancel: false,
        confirmColor: '#A32D2D',
        success() {
          that.loadAll(that.data.householdId)
        },
      })
      return
    }
    this.setData({ doseBusy: true })
    // P0-2：优先走服务端原子 RPC（迁移 07 部署后生效，含服药人过敏禁用校验）；未部署回退普通更新
    const rpc = await cloud.database.rpc('transition_dose', {
      p_dose_id: id,
      p_target_status: 'taken',
    })
    let ok = false
    let errText = ''
    if (!rpc.error && rpc.data === 'ok') {
      ok = true
    } else if (rpc.error) {
      // RPC 未部署或调用失败 → 回退客户端直写（迁移前兼容）
      const res = await dosesAccess.update(id, {
        status: 'taken',
        confirmed_at: new Date().toISOString(),
      })
      ok = !res.error && !!res.data
      if (!ok) errText = (res.error && res.error.message) || ''
    } else {
      errText = {
        forbidden_allergy: '服药人过敏档案命中禁用，已拒绝打卡',
        invalid_transition: '该记录状态已变化，请刷新后重试',
        not_found: '记录不存在',
        forbidden_household: '无权操作该记录',
        not_signed_in: '登录状态已失效，请重新登录',
      }[rpc.data] || '操作失败'
    }
    this.setData({ doseBusy: false })
    if (!ok) {
      wx.showToast({ title: errText || '操作失败', icon: 'none' })
      return
    }
    wx.showToast({ title: '已打卡', icon: 'success' })
    this.loadAll(this.data.householdId)
  },

  // 误打卡更正：taken → missed。保留该条记录（不删除历史行）；优先原子 RPC，失败回退直写
  correctDose(e) {
    const id = e.currentTarget.dataset.id
    const that = this
    wx.showModal({
      title: '更正打卡',
      content: '将此条记录改为「漏服」。原记录保留，更正不可自动撤销，请确认是误打卡后再操作。',
      confirmColor: '#A32D2D',
      success(res) {
        if (!res.confirm) return
        that.applyCorrect(id)
      },
    })
  },

  async applyCorrect(id) {
    if (!id || this.data.doseBusy) return
    this.setData({ doseBusy: true })
    // taken→missed 走同一 RPC（迁移 07）；confirmed_at 由服务端置空，前端 SDK 不写 null（会丢弃）
    const rpc = await cloud.database.rpc('transition_dose', {
      p_dose_id: id,
      p_target_status: 'missed',
    })
    let ok = false
    let errText = ''
    if (!rpc.error && rpc.data === 'ok') {
      ok = true
    } else if (rpc.error) {
      const res = await dosesAccess.update(id, { status: 'missed' })
      ok = !res.error && !!res.data
      if (!ok) errText = (res.error && res.error.message) || ''
    } else {
      errText = {
        invalid_transition: '仅已打卡记录可更正',
        not_found: '记录不存在',
        forbidden_household: '无权操作该记录',
        not_signed_in: '登录状态已失效，请重新登录',
      }[rpc.data] || '更正失败'
    }
    this.setData({ doseBusy: false })
    if (!ok) {
      wx.showToast({ title: errText || '更正失败', icon: 'none' })
      return
    }
    wx.showToast({ title: '已更正为漏服', icon: 'none' })
    this.loadAll(this.data.householdId)
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

  goEditPlan(e) {
    const id = e.currentTarget.dataset.id
    const status = e.currentTarget.dataset.status
    if (!id) return
    if (status !== 'active') {
      wx.showToast({ title: '仅进行中的计划可编辑', icon: 'none' })
      return
    }
    wx.navigateTo({ url: '/pages/plan-form/plan-form?id=' + id })
  },

  cancelPlan(e) {
    const id = e.currentTarget.dataset.id
    const that = this
    wx.showModal({
      title: '取消用药计划',
      content: '取消后将删除未来未发生的提醒，历史记录保留',
      confirmColor: '#A32D2D',
      success(res) {
        if (!res.confirm) return
        that.doCancelPlan(id)
      },
    })
  },

  async doCancelPlan(id) {
    if (this.data.planBusy) return
    this.setData({ planBusy: true })
    // P0-3：优先原子 RPC（迁移 07）——状态翻转与删未来提醒同事务；未部署回退两步流程
    const rpc = await cloud.database.rpc('cancel_plan_atomic', { p_plan_id: id })
    if (!rpc.error && rpc.data === 'ok') {
      this.setData({ planBusy: false })
      wx.showToast({ title: '已取消', icon: 'success' })
      this.loadAll(this.data.householdId)
      return
    }
    if (!rpc.error && rpc.data !== 'ok') {
      this.setData({ planBusy: false })
      const msg = {
        not_found: '计划不存在',
        forbidden_household: '无权操作该计划',
        not_signed_in: '登录状态已失效，请重新登录',
      }[rpc.data] || '操作失败'
      wx.showToast({ title: msg, icon: 'none' })
      return
    }
    // RPC 未部署或调用失败 → 回退旧两步流程（幂等，可安全重试）
    const upd = await plansAccess.update(id, { status: 'cancelled' })
    if (upd.error || !upd.data) {
      this.setData({ planBusy: false })
      wx.showToast({ title: (upd.error && upd.error.message) || '操作失败', icon: 'none' })
      return
    }
    // 契约 v1.7 #5/#6：取消时删除未来未发生的 pending
    const cleaned = await this.removeFuturePending(id)
    this.setData({ planBusy: false })
    wx.showToast({ title: cleaned ? '已取消' : '计划已取消，未来提醒清理失败', icon: 'none' })
    this.loadAll(this.data.householdId)
  },

  async removeFuturePending(planId) {
    const nowMs = Date.now()
    const { data, error } = await cloud.database
      .from('medication_doses')
      .select('id, scheduled_at, status')
      .eq('plan_id', planId)
      .eq('status', 'pending')
    if (error) return false
    const future = (data || []).filter(function (d) {
      return new Date(d.scheduled_at).getTime() > nowMs
    })
    let cleaned = true
    for (let i = 0; i < future.length; i++) {
      const removed = await dosesAccess.remove(future[i].id)
      if (removed.error || !removed.data) cleaned = false
    }
    return cleaned
  },
})
