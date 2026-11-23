const { cloud } = require('../../utils/cloud')
const { plansAccess, dosesAccess, createDosesBulk } = require('../../utils/data-access')
const { buildDoseTimes, courseDays, MAX_COURSE_DAYS } = require('../../utils/plan-doses')
const { matchAllergies, hitsText } = require('../../utils/allergy')

// 阈值选项：10~120 步进 5（契约 v1.7 #10）
const THRESHOLD_OPTIONS = []
for (let v = 10; v <= 120; v += 5) THRESHOLD_OPTIONS.push(String(v))

function uniqTimes(list) {
  const seen = {}
  const out = []
  ;(list || []).forEach(function (t) {
    const v = String(t || '').trim()
    if (!v || seen[v]) return
    seen[v] = true
    out.push(v)
  })
  return out.sort()
}

Page({
  data: {
    largeText: false,
    authState: 'checking', // checking | signed-out | no-household | ready
    loginLoading: false,
    loginError: '',
    saving: false,
    planId: null,
    lockedItemId: null,
    lockedItemName: '',
    householdId: null,
    members: [],
    memberNames: [],
    memberIndex: 0,
    medicines: [],
    medicineNames: [],
    medicineIndex: 0,
    timeList: ['08:00'],
    freqIndex: 0,
    freqOptions: ['每天', '隔天'],
    startDate: '',
    endDate: '',
    thresholdOptions: THRESHOLD_OPTIONS,
    thresholdIndex: THRESHOLD_OPTIONS.indexOf('30'),
    // 过敏冲突提示（m2-brief #8，展示范围=当前用户档案）
    myHits: [],
    hitsSummary: '',
    hitsWorst: '',
  },

  onLoad(options) {
    this.setData({ largeText: getApp().globalData.largeText })
    this.setData({
      planId: options.id || null,
      lockedItemId: options.item_id || null,
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
    this.setData({ householdId: row.household_id, authState: 'ready' })
    await this.loadRefs(row.household_id)
  },

  async loadRefs(hid) {
    const memberRes = await cloud.database
      .from('members')
      .select('id, owner_id, nickname, role')
      .eq('household_id', hid)
    const itemRes = await cloud.database
      .from('items')
      .select('id, name')
      .eq('household_id', hid)
      .eq('category', 'medicine')

    const members = memberRes.data || []
    const medicines = itemRes.data || []
    const memberNames = members.map(function (m) {
      return m.nickname || '成员'
    })
    const medicineNames = medicines.map(function (i) {
      return i.name
    })

    let memberIndex = this.data.memberIndex
    let medicineIndex = this.data.medicineIndex
    let lockedItemName = ''
    if (this.data.lockedItemId) {
      for (let i = 0; i < medicines.length; i++) {
        if (String(medicines[i].id) === String(this.data.lockedItemId)) {
          medicineIndex = i
          lockedItemName = medicines[i].name
          break
        }
      }
    }

    this.setData({
      members: members,
      memberNames: memberNames,
      medicines: medicines,
      medicineNames: medicineNames,
      memberIndex: memberIndex,
      medicineIndex: medicineIndex,
      lockedItemName: lockedItemName,
    })

    if (this.data.planId) {
      await this.loadPlan()
    } else {
      // 新建默认疗程：今天 ~ 今天+6 天
      const now = new Date()
      const end = new Date(now.getTime() + 6 * 86400000)
      this.setData({ startDate: this.formatDate(now), endDate: this.formatDate(end) })
    }
    const current = this.data.medicines[this.data.medicineIndex]
    this.loadConflict(current && current.id)
  },

  // 当前用户过敏档案 ∩ 选中药品关联（m2-brief #8）
  async loadConflict(itemId) {
    if (!itemId) {
      this.setData({ myHits: [], hitsSummary: '', hitsWorst: '' })
      return
    }
    const linkRes = await cloud.database
      .from('drug_allergy_links')
      .select('id, allergen, kind')
      .eq('item_id', itemId)
    const links = linkRes.data || []
    let hits = []
    const { data: session } = await cloud.auth.getSession()
    const uid = session && session.user && session.user.id
    if (uid) {
      const memberRes = await cloud.database
        .from('members')
        .select('id')
        .eq('owner_id', uid)
        .limit(1)
      const myMemberId = memberRes.data && memberRes.data[0] && memberRes.data[0].id
      if (myMemberId) {
        const alRes = await cloud.database
          .from('allergies')
          .select('allergen')
          .eq('member_id', myMemberId)
        hits = matchAllergies(
          (alRes.data || []).map(function (a) {
            return a.allergen
          }),
          links
        )
      }
    }
    let hitsWorst = ''
    if (hits.length) {
      hitsWorst = 'caution'
      for (let i = 0; i < hits.length; i++) {
        if (hits[i].kind === 'forbidden') {
          hitsWorst = 'forbidden'
          break
        }
      }
    }
    this.setData({ myHits: hits, hitsSummary: hitsText(hits), hitsWorst: hitsWorst })
  },

  formatDate(d) {
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return d.getFullYear() + '-' + m + '-' + day
  },

  async loadPlan() {
    const { data, error } = await cloud.database
      .from('medication_plans')
      .select('id, item_id, member_id, times, freq, start_date, end_date, miss_threshold_minutes, status')
      .eq('id', this.data.planId)
      .limit(1)
    const p = data && data[0]
    if (error || !p) {
      wx.showToast({ title: '计划不存在或已删除', icon: 'none' })
      setTimeout(function () {
        wx.navigateBack()
      }, 1200)
      return
    }
    if (p.status !== 'active') {
      wx.showToast({ title: '仅进行中的计划可编辑', icon: 'none' })
      setTimeout(function () {
        wx.navigateBack()
      }, 1200)
      return
    }
    let memberIndex = 0
    for (let i = 0; i < this.data.members.length; i++) {
      if (String(this.data.members[i].id) === String(p.member_id)) {
        memberIndex = i
        break
      }
    }
    let medicineIndex = this.data.medicineIndex
    for (let i = 0; i < this.data.medicines.length; i++) {
      if (String(this.data.medicines[i].id) === String(p.item_id)) {
        medicineIndex = i
        break
      }
    }
    const thresholdText = String(p.miss_threshold_minutes || 30)
    let thresholdIndex = this.data.thresholdOptions.indexOf(thresholdText)
    if (thresholdIndex < 0) thresholdIndex = this.data.thresholdOptions.indexOf('30')
    this.setData({
      memberIndex: memberIndex,
      medicineIndex: medicineIndex,
      timeList: (p.times && p.times.length ? p.times : ['08:00']).slice(),
      freqIndex: p.freq === 'alternate_day' ? 1 : 0,
      startDate: p.start_date,
      endDate: p.end_date,
      thresholdIndex: thresholdIndex,
    })
  },

  onMemberChange(e) {
    this.setData({ memberIndex: Number(e.detail.value) || 0 })
  },

  onMedicineChange(e) {
    const idx = Number(e.detail.value) || 0
    this.setData({ medicineIndex: idx })
    const medicine = this.data.medicines[idx]
    this.loadConflict(medicine && medicine.id)
  },

  onFreqChange(e) {
    this.setData({ freqIndex: Number(e.detail.value) || 0 })
  },

  onStartChange(e) {
    this.setData({ startDate: e.detail.value })
  },

  onEndChange(e) {
    this.setData({ endDate: e.detail.value })
  },

  onThresholdChange(e) {
    this.setData({ thresholdIndex: Number(e.detail.value) || 0 })
  },

  onTimeChange(e) {
    const index = Number(e.currentTarget.dataset.index)
    const value = e.detail.value
    const list = this.data.timeList.slice()
    list[index] = value
    this.setData({ timeList: list })
  },

  addTime() {
    if (this.data.timeList.length >= 8) {
      wx.showToast({ title: '时间点最多 8 个', icon: 'none' })
      return
    }
    this.setData({ timeList: this.data.timeList.concat(['12:00']) })
  },

  removeTime(e) {
    const index = Number(e.currentTarget.dataset.index)
    const list = this.data.timeList.slice()
    list.splice(index, 1)
    this.setData({ timeList: list })
  },

  // 保存：新建 = create plan + 整疗程生成；编辑 = update + 删未来 pending 重建（契约 v1.7 #5/#6）
  async onSave() {
    const member = this.data.members[this.data.memberIndex]
    const medicine = this.data.medicines[this.data.medicineIndex]
    if (!medicine) {
      wx.showToast({ title: '请选择药品', icon: 'none' })
      return
    }
    if (!member) {
      wx.showToast({ title: '请选择服药人', icon: 'none' })
      return
    }
    const times = uniqTimes(this.data.timeList)
    if (!times.length) {
      wx.showToast({ title: '请添加服药时间点', icon: 'none' })
      return
    }
    if (!this.data.startDate || !this.data.endDate) {
      wx.showToast({ title: '请选择疗程起止日期', icon: 'none' })
      return
    }
    const days = courseDays(this.data.startDate, this.data.endDate)
    if (isNaN(days) || days < 0) {
      wx.showToast({ title: '结束日期不能早于开始日期', icon: 'none' })
      return
    }
    if (days > MAX_COURSE_DAYS) {
      wx.showToast({ title: '疗程不能超过 ' + MAX_COURSE_DAYS + ' 天', icon: 'none' })
      return
    }
    if (this.data.saving) return
    this.setData({ saving: true })

    const freq = this.data.freqIndex === 1 ? 'alternate_day' : 'daily'
    const payload = {
      household_id: this.data.householdId,
      item_id: medicine.id,
      member_id: member.id,
      times: times,
      freq: freq,
      start_date: this.data.startDate,
      end_date: this.data.endDate,
      miss_threshold_minutes: Number(this.data.thresholdOptions[this.data.thresholdIndex]),
      status: 'active',
    }

    let planId = this.data.planId
    if (planId) {
      const upd = await plansAccess.update(planId, payload)
      if (upd.error || !upd.data) {
        this.setData({ saving: false })
        wx.showToast({ title: (upd.error && upd.error.message) || '保存失败', icon: 'none' })
        return
      }
      // 变更前删除未来未发生的 pending（taken/missed 保留）
      await this.removeFuturePending(planId)
    } else {
      const created = await plansAccess.create(payload)
      if (created.error || !created.data) {
        this.setData({ saving: false })
        wx.showToast({ title: (created.error && created.error.message) || '保存失败', icon: 'none' })
        return
      }
      planId = created.data.id
    }

    const scheduled = buildDoseTimes({
      startDate: payload.start_date,
      endDate: payload.end_date,
      times: payload.times,
      freq: payload.freq,
    })
    const rows = scheduled.map(function (iso) {
      return {
        household_id: payload.household_id,
        plan_id: planId,
        scheduled_at: iso,
        status: 'pending',
      }
    })
    const bulk = await createDosesBulk(rows)
    this.setData({ saving: false })
    if (bulk.error) {
      wx.showToast({ title: '计划已保存，提醒生成失败，请重新保存一次', icon: 'none', duration: 2500 })
      setTimeout(function () {
        wx.navigateBack()
      }, 2500)
      return
    }
    wx.showToast({ title: '已保存', icon: 'success' })
    setTimeout(function () {
      wx.navigateBack()
    }, 600)
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
