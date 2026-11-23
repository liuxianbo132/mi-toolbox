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
  },

  onShow() {
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
      this.setData({ authState: 'no-household', loading: false })
      return
    }
    this.setData({ authState: 'ready', householdId: row.household_id })
    await this.loadAll(row.household_id)
  },

  async loadAll(hid) {
    this.setData({ loading: true })
    const now = new Date()
    const range = dayRange(now)
    this.setData({ todayText: now.getMonth() + 1 + '月' + now.getDate() + '日' })

    const memberRes = await cloud.database
      .from('members')
      .select('id, owner_id, nickname, role')
      .eq('household_id', hid)
    const itemRes = await cloud.database
      .from('items')
      .select('id, name, category')
      .eq('household_id', hid)
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

    // 冲突标（m2-brief #8，展示范围=当前用户档案）：本人 allergies ∩ 家庭全部药品关联
    const hitsByItem = {}
    const { data: session } = await cloud.auth.getSession()
    const uid = session && session.user && session.user.id
    let myMemberId = null
    members.forEach(function (m) {
      if (m.owner_id === uid) myMemberId = m.id
    })
    if (myMemberId) {
      const alRes = await cloud.database
        .from('allergies')
        .select('allergen')
        .eq('member_id', myMemberId)
      const myAllergens = (alRes.data || []).map(function (a) {
        return a.allergen
      })
      if (myAllergens.length) {
        const linkRes = await cloud.database
          .from('drug_allergy_links')
          .select('item_id, allergen, kind')
          .eq('household_id', hid)
        ;(linkRes.data || []).forEach(function (l) {
          const hit = matchAllergies(myAllergens, [l])
          if (hit.length) {
            const kind = hit[0].kind
            if (!hitsByItem[l.item_id] || kind === 'forbidden') hitsByItem[l.item_id] = kind
          }
        })
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

    const planMap = {}
    ;(planRes.data || []).forEach(function (p) {
      planMap[p.id] = p
    })

    const timeline = (doseRes.data || []).map(function (d) {
      const p = planMap[d.plan_id] || {}
      return {
        id: d.id,
        time: formatHM(d.scheduled_at),
        itemName: itemNameMap[p.item_id] || '未知药品',
        memberName: memberNameMap[p.member_id] || '',
        status: d.status,
        statusLabel: DOSE_STATUS_LABEL[d.status] || d.status,
        statusClass: d.status === 'taken' ? 'tag-green' : d.status === 'missed' ? 'tag-red' : 'tag-amber',
        canConfirm: d.status === 'pending',
        conflictKind: hitsByItem[p.item_id] || '',
        conflictLabel: conflictLabelOf(hitsByItem[p.item_id]),
      }
    })

    const plans = (planRes.data || []).map(function (p) {
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
        conflictKind: hitsByItem[p.item_id] || '',
        conflictLabel: conflictLabelOf(hitsByItem[p.item_id]),
      }
    })

    this.setData({ loading: false, timeline: timeline, plans: plans })
  },

  // 打卡：pending → taken（contract v1.7：confirmed_at=now）
  async confirmDose(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    const res = await dosesAccess.update(id, {
      status: 'taken',
      confirmed_at: new Date().toISOString(),
    })
    if (res.error || !res.data) {
      wx.showToast({ title: (res.error && res.error.message) || '操作失败', icon: 'none' })
      return
    }
    wx.showToast({ title: '已确认', icon: 'success' })
    this.loadAll(this.data.householdId)
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
    const upd = await plansAccess.update(id, { status: 'cancelled' })
    if (upd.error || !upd.data) {
      wx.showToast({ title: (upd.error && upd.error.message) || '操作失败', icon: 'none' })
      return
    }
    // 契约 v1.7 #5/#6：取消时删除未来未发生的 pending
    await this.removeFuturePending(id)
    wx.showToast({ title: '已取消', icon: 'success' })
    this.loadAll(this.data.householdId)
  },

  async removeFuturePending(planId) {
    const nowMs = Date.now()
    const { data, error } = await cloud.database
      .from('medication_doses')
      .select('id, scheduled_at, status')
      .eq('plan_id', planId)
      .eq('status', 'pending')
    if (error) return
    const future = (data || []).filter(function (d) {
      return new Date(d.scheduled_at).getTime() > nowMs
    })
    for (let i = 0; i < future.length; i++) {
      await dosesAccess.remove(future[i].id)
    }
  },
})
