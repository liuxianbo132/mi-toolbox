const { cloud } = require('../../utils/cloud')
const { buildDoseTimes, courseDays, MAX_COURSE_DAYS } = require('../../utils/plan-doses')
const { matchAllergies, hitsText, hasForbidden } = require('../../utils/allergy')
const { toDateOnly } = require('../../utils/date')
const { makeRequestId } = require('../../utils/request-id')

const THRESHOLD_OPTIONS = Array.from({ length: 23 }, (_, index) => String(10 + index * 5))
const SAVE_ERRORS = {
  forbidden_allergy: '服药人档案匹配禁用关联，计划未保存',
  schedule_changed: '计划已变化，请返回并重新打开',
  not_found: '计划不存在，请返回刷新',
  invalid_transition: '计划状态已变化，请返回刷新',
  forbidden_household: '无权保存此计划',
  not_signed_in: '登录状态已失效，请重新登录',
  invalid_references: '药品或服药人已变更，请重新选择',
  invalid_plan_target: '药品或服药人已变更，请返回刷新',
  invalid_schedule: '提醒时间无效，请核对疗程和时间点',
  request_conflict: '保存请求已变化，请返回查看计划',
}

Page({
  data: {
    largeText: false,
    authState: 'checking',
    loadError: '',
    loginLoading: false,
    loginError: '',
    saving: false,
    saveUnconfirmed: false,
    saveError: '',
    planId: null,
    lockedItemId: null,
    householdId: null,
    members: [],
    memberNames: [],
    memberChoices: [],
    memberIndex: -1,
    medicines: [],
    medicineNames: [],
    medicineChoices: [],
    medicineIndex: -1,
    timeList: [''],
    freqIndex: 0,
    freqOptions: ['每天', '隔天'],
    startDate: '',
    endDate: '',
    thresholdOptions: THRESHOLD_OPTIONS,
    thresholdIndex: THRESHOLD_OPTIONS.indexOf('30'),
    conflictState: 'idle',
    hitsSummary: '',
    hitsWorst: '',
  },

  onLoad(options = {}) {
    this.setData({
      largeText: getApp().globalData.largeText,
      planId: options.id || null,
      lockedItemId: options.item_id || null,
    })
    this.restore()
  },

  async restore() {
    if (this.restoring) return
    this.restoring = true
    this.setData({ authState: 'checking', loadError: '' })
    try {
      const { data: session, error } = await getApp().ensureSession()
      if (error) throw error
      const uid = session && session.user && session.user.id
      if (!uid) {
        this.setData({ authState: 'signed-out' })
        return
      }
      const { data: mine, error: householdError } = await cloud.database
        .from('members').select('household_id').eq('owner_id', uid).is('left_at', null).limit(1)
      if (householdError) throw householdError
      const row = mine && mine[0]
      if (!row) {
        this.setData({ authState: 'no-household' })
        return
      }
      await this.loadRefs(row.household_id)
    } catch (e) {
      this.setData({ authState: 'error', loadError: '用药计划暂时无法加载，请重试。' })
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

  async loadRefs(hid) {
    const { planId, lockedItemId, memberIndex, medicineIndex } = this.data
    const [memberRes, itemRes, planRes] = await Promise.all([
      cloud.database.from('members').select('id, nickname').eq('household_id', hid).is('left_at', null),
      cloud.database.from('items')
        .select('id, name')
        .eq('household_id', hid)
        .eq('category', 'medicine')
        .eq('is_deleted', false),
      planId ? cloud.database.from('medication_plans')
        .select('id, item_id, member_id, times, freq, start_date, end_date, miss_threshold_minutes, status, updated_at')
        .eq('id', planId).eq('household_id', hid).limit(1) : null,
    ])
    if (memberRes.error || itemRes.error || (planRes && planRes.error)) throw new Error('Plan references unavailable')

    const members = memberRes.data || []
    const medicines = itemRes.data || []
    const memberNames = members.map((m) => m.nickname || '成员')
    const medicineNames = medicines.map((i) => i.name)
    const next = {
      householdId: hid,
      members,
      memberNames,
      memberChoices: ['选择成员', ...memberNames],
      memberIndex,
      medicines,
      medicineNames,
      medicineChoices: ['选择药品', ...medicineNames],
      medicineIndex,
      authState: 'ready',
    }

    if (planId) {
      const p = planRes.data && planRes.data[0]
      if (!p || p.status !== 'active') {
        this.setData({ authState: 'unavailable', loadError: '只能编辑进行中的计划。' })
        return
      }
      next.memberIndex = members.findIndex((m) => String(m.id) === String(p.member_id))
      next.medicineIndex = medicines.findIndex((i) => String(i.id) === String(p.item_id))
      if (next.memberIndex < 0 || next.medicineIndex < 0) {
        this.setData({ authState: 'unavailable', loadError: '原药品或服药人已不在可用列表中。' })
        return
      }
      this.planUpdatedAt = p.updated_at
      next.timeList = Array.isArray(p.times) ? p.times : []
      next.freqIndex = p.freq === 'alternate_day' ? 1 : 0
      next.startDate = p.start_date
      next.endDate = p.end_date || ''
      const thresholdIndex = THRESHOLD_OPTIONS.indexOf(String(p.miss_threshold_minutes))
      next.thresholdIndex = thresholdIndex < 0 ? THRESHOLD_OPTIONS.indexOf('30') : thresholdIndex
    } else {
      if (lockedItemId) {
        next.medicineIndex = medicines.findIndex((i) => String(i.id) === String(lockedItemId))
        if (next.medicineIndex < 0) {
          this.setData({ authState: 'unavailable', loadError: '该药品已不在可用库存中。' })
          return
        }
      }
      next.startDate = toDateOnly(new Date())
    }

    this.setData(next)
    await this.checkSelection()
  },

  async checkSelection() {
    const requestId = this.conflictRequestId = (this.conflictRequestId || 0) + 1
    const { medicines, medicineIndex, members, memberIndex, householdId } = this.data
    const medicine = medicines[medicineIndex]
    const member = members[memberIndex]
    this.setData({ conflictState: medicine && member ? 'loading' : 'idle', hitsSummary: '', hitsWorst: '' })
    if (!medicine || !member) return

    try {
      const [linkRes, allergyRes] = await Promise.all([
        cloud.database.from('drug_allergy_links').select('allergen, kind')
          .eq('household_id', householdId).eq('item_id', medicine.id),
        cloud.database.from('allergies').select('allergen')
          .eq('household_id', householdId).eq('member_id', member.id),
      ])
      if (requestId !== this.conflictRequestId) return
      if (linkRes.error || allergyRes.error) throw new Error('Allergy records unavailable')
      const hits = matchAllergies((allergyRes.data || []).map((a) => a.allergen), linkRes.data)
      const hitsWorst = hasForbidden(hits) ? 'forbidden' : hits.length ? 'caution' : ''
      this.setData({ conflictState: 'ready', hitsSummary: hitsText(hits), hitsWorst })
    } catch (e) {
      if (requestId !== this.conflictRequestId) return
      this.setData({ conflictState: 'error' })
    }
  },

  onMemberChange(e) {
    this.setData({ memberIndex: Number(e.detail.value) - 1, saveError: '' })
    this.checkSelection()
  },

  onMedicineChange(e) {
    this.setData({ medicineIndex: Number(e.detail.value) - 1, saveError: '' })
    this.checkSelection()
  },

  onFreqChange(e) {
    this.setData({ freqIndex: Number(e.detail.value) })
  },

  onStartChange(e) {
    this.setData({ startDate: e.detail.value })
  },

  onEndChange(e) {
    this.setData({ endDate: e.detail.value })
  },

  onThresholdChange(e) {
    this.setData({ thresholdIndex: Number(e.detail.value) })
  },

  onTimeChange(e) {
    const list = this.data.timeList.slice()
    list[Number(e.currentTarget.dataset.index)] = e.detail.value
    this.setData({ timeList: list })
  },

  addTime() {
    if (this.data.timeList.length >= 8) return
    this.setData({ timeList: this.data.timeList.concat(['']) })
  },

  removeTime(e) {
    const list = this.data.timeList.slice()
    list.splice(Number(e.currentTarget.dataset.index), 1)
    this.setData({ timeList: list })
  },

  validatePlan() {
    const d = this.data
    const member = d.members[d.memberIndex]
    const medicine = d.medicines[d.medicineIndex]
    if (!medicine) return '请选择药品'
    if (!member) return '请选择服药人'
    if (d.conflictState !== 'ready') return '请先核对已登记的过敏关联'
    if (d.hitsWorst === 'forbidden') return '档案匹配禁用关联，无法保存'
    if (!d.timeList.length || d.timeList.some((t) => !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(t))) {
      return '请选择每个服药时间点'
    }
    if (d.timeList.length > 48) return '时间点最多 48 个，请减少历史时间点'
    if (new Set(d.timeList).size !== d.timeList.length) return '服药时间点不能重复'
    if (!d.startDate || !d.endDate) return '请选择疗程起止日期'
    const days = courseDays(d.startDate, d.endDate)
    if (!Number.isFinite(days) || days < 0) return '结束日期不能早于开始日期'
    if (days >= MAX_COURSE_DAYS) return '疗程不能超过 ' + MAX_COURSE_DAYS + ' 天'
    return ''
  },

  async onSave() {
    if (this.data.authState !== 'ready' || this.data.saving) return
    if (!this.pendingSave) {
      const error = this.validatePlan()
      if (error) {
        this.setData({ saveError: error })
        return
      }
    }

    this.setData({ saving: true, saveError: '' })
    try {
      if (!this.pendingSave) {
        const d = this.data
        const freq = d.freqIndex === 1 ? 'alternate_day' : 'daily'
        const times = [...d.timeList].sort()
        // 以设备本地日历输入生成 UTC 时间戳，保留项目现有疗程时区口径。
        const scheduled = buildDoseTimes({ startDate: d.startDate, endDate: d.endDate, times, freq, now: new Date() })
        if (!d.planId && !scheduled.length) {
          this.setData({ saveError: '请将结束日期设为今天或之后，并核对频次。' })
          return
        }
        const fields = {
          item_id: d.medicines[d.medicineIndex].id,
          member_id: d.members[d.memberIndex].id,
          times,
          freq,
          start_date: d.startDate,
          end_date: d.endDate,
          miss_threshold_minutes: Number(THRESHOLD_OPTIONS[d.thresholdIndex]),
        }
        this.pendingSave = {
          p_plan_id: d.planId || null,
          p_request_id: await makeRequestId(),
          p_fields: fields,
          p_rows: scheduled.map((scheduledAt) => ({ scheduled_at: scheduledAt })),
          p_expected_updated_at: d.planId ? this.planUpdatedAt : null,
        }
      }

      const { data, error } = await cloud.database.rpc('save_med_plan_atomic', this.pendingSave)
      if (error || !data || typeof data.ok !== 'boolean') throw error || new Error('Unconfirmed save result')
      this.pendingSave = null
      if (!data.ok) {
        this.setData({ saveUnconfirmed: false, saveError: SAVE_ERRORS[data.error] || '计划未保存，请核对后重试。' })
        if (data.error === 'forbidden_allergy') this.checkSelection()
        return
      }

      this.setData({ saveUnconfirmed: false })
      wx.showToast({ title: '计划已保存', icon: 'success' })
      wx.navigateBack()
    } catch (e) {
      if (e && e.code === 'INVALID_LOCAL_DOSE_TIME') {
        this.setData({ saveError: e.message })
        return
      }
      const saveUnconfirmed = !!this.pendingSave
      this.setData({
        saveUnconfirmed,
        saveError: saveUnconfirmed
          ? '保存结果暂未确认。重试会核对并继续本次保存。'
          : '暂时无法保存，请重试。',
      })
    } finally {
      this.setData({ saving: false })
    }
  },
})
