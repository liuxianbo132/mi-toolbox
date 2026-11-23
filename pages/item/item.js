const { cloud } = require('../../utils/cloud')
const { itemsAccess, batchesAccess, drugLinksAccess, logRecord } = require('../../utils/data-access')
const { CATEGORIES, categoryLabel, categoryIllustration } = require('../../utils/constants')
const { daysUntil, urgencyLevel, effectiveExpiry } = require('../../utils/date')
const { matchAllergies, hitsText, KIND_LABEL } = require('../../utils/allergy')

// 契约：batches.status('active'|'used'|'discarded')
const BATCH_STATUS_LABEL = { active: '在库', used: '已用完', discarded: '已报废' }

Page({
  data: {
    largeText: false,
    loading: true,
    loadState: 'loading', // loading | ready | not-found | error
    loadError: '',
    itemId: null,
    item: null, // {id, household_id, name, category, categoryLabel, unit, brand, spec}
    activeBatches: [],
    historyBatches: [],
    batchState: 'idle', // idle | loading | ready | error
    batchError: '',
    batchBusy: false,
    categoryOptions: CATEGORIES,
    // 物品编辑
    editing: false,
    editSaving: false,
    editName: '',
    editCategoryIndex: 0,
    editUnit: '',
    editBrand: '',
    editSpec: '',
    // 新增批次
    addingBatch: false,
    addSaving: false,
    // 批次编辑
    editingBatchId: null,
    editingExpiry: '',
    editingQuantity: '',
    editingUnit: '',
    editBatchSaving: false,
    // 用药计划（M2a，仅药品）
    medPlans: [],
    medPlansState: 'idle', // idle | loading | ready | error
    // 过敏关联与冲突（M2b，仅药品）
    allergyState: 'idle', // idle | loading | ready | error
    allergyError: '',
    medLinks: [],
    myHits: [],
    hitsSummary: '',
    hitsWorst: '',
    linkAllergen: '',
    linkKindIndex: 0,
    linkKindOptions: [{ label: '禁用', value: 'forbidden' }, { label: '慎用', value: 'caution' }],
    linkSaving: false,
    // V2 Step1：历史批次折叠
    historyExpanded: false,
    // V2 Step2：位置字典（批次表单与位置名显示用）
    locations: [],
  },

  onLoad(options) {
    this.setData({ itemId: options.id || null })
  },

  onShow() {
    this.setData({ largeText: getApp().globalData.largeText })
    if (this.data.itemId) {
      this.loadAll()
    } else {
      this.setData({ loading: false, loadState: 'not-found', item: null })
    }
  },

  retryLoad() {
    if (this.data.itemId) this.loadAll()
  },

  retryload() { this.retryLoad() },

  async loadAll() {
    this.setData({ loading: true, loadState: 'loading', batchState: 'loading', loadError: '', batchError: '' })
    const { data: itemRows, error } = await cloud.database
      .from('items')
      .select('id, household_id, name, category, unit, brand, spec, pao_days')
      .eq('id', this.data.itemId)
      .eq('is_deleted', false)
      .limit(1)
    if (error) {
      this.setData({
        loading: false,
        loadState: 'error',
        loadError: (error && error.message) || '物品信息加载失败，请重试',
      })
      return
    }
    const row = itemRows && itemRows[0]
    if (!row) {
      // RLS 过滤或已删除：0 行即视为不可见
      this.setData({
        loading: false,
        loadState: 'not-found',
        item: null,
        activeBatches: [],
        historyBatches: [],
        batchState: 'idle',
      })
      return
    }
    const { data: batchRows, error: batchError } = await cloud.database
      .from('batches')
      .select('id, item_id, expiry_date, opened_at, quantity, unit, status, location_id')
      .eq('item_id', this.data.itemId)
      .eq('is_deleted', false)
      .order('expiry_date', { ascending: true })
      .limit(200)
    let batchesFailed = !!batchError
    // V2 Step2：位置字典（批次行显示位置名 + 新增批次选择器）
    const locRes = await cloud.database
      .from('locations')
      .select('id, name')
      .eq('household_id', row.household_id)
      .order('created_at', { ascending: true })
    if (locRes.error) batchesFailed = true
    const locations = locRes.data || []
    const locMap = {}
    locations.forEach(function (l) {
      locMap[l.id] = l.name
    })
    const all = this.decorateBatches(batchRows || [], row.category, row.pao_days, locMap)
    const activeBatches = all.filter(function (b) { return b.status === 'active' })
    const historyBatches = all.filter(function (b) { return b.status !== 'active' })
    this.setData({
      loading: false,
      loadState: 'ready',
      batchState: batchesFailed ? 'error' : 'ready',
      batchError: batchesFailed ? '批次信息暂时无法加载，请重试' : '',
      item: {
        id: row.id,
        household_id: row.household_id,
        name: row.name,
        category: row.category,
        categoryLabel: categoryLabel(row.category),
        categoryIllu: categoryIllustration(row.category),
        unit: row.unit || '',
        brand: row.brand || '',
        spec: row.spec || '',
      },
      activeBatches: activeBatches,
      historyBatches: historyBatches,
      locations: locations,
    })
    if (row.category === 'medicine') {
      this.loadMedPlans(row.id, row.household_id)
      this.loadAllergyInfo(row.id, row.household_id)
    } else {
      this.setData({ medPlans: [], medPlansState: 'idle', medLinks: [], myHits: [], hitsSummary: '', hitsWorst: '', allergyState: 'idle', allergyError: '' })
    }
  },

  // 过敏关联与冲突（m2-brief #7/#8）：links 列表 + 当前用户本人档案命中
  async loadAllergyInfo(itemId, hid) {
    this.setData({ allergyState: 'loading', allergyError: '' })
    const linkRes = await cloud.database
      .from('drug_allergy_links')
      .select('id, allergen, kind, created_at')
      .eq('item_id', itemId)
      .order('created_at', { ascending: true })
    if (linkRes.error) {
      this.setData({ allergyState: 'error', allergyError: '药品过敏关联加载失败，冲突判断暂不可用' })
      return
    }
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
      if (memberRes.error) {
        this.setData({ allergyState: 'error', allergyError: '成员信息加载失败，冲突判断暂不可用' })
        return
      }
      const myMemberId = memberRes.data && memberRes.data[0] && memberRes.data[0].id
      if (myMemberId) {
        const alRes = await cloud.database
          .from('allergies')
          .select('id, allergen')
          .eq('member_id', myMemberId)
        if (alRes.error) {
          this.setData({ allergyState: 'error', allergyError: '过敏档案加载失败，冲突判断暂不可用' })
          return
        }
        hits = matchAllergies(
          (alRes.data || []).map(function (a) {
            return a.allergen
          }),
          links
        )
      }
    }
    const hitMap = {}
    hits.forEach(function (h) {
      hitMap[h.allergen] = h.kind
    })
    const medLinks = links.map(function (l) {
      return {
        id: l.id,
        allergen: l.allergen,
        kind: l.kind,
        kindLabel: KIND_LABEL[l.kind] || l.kind,
        hit: !!hitMap[l.allergen],
      }
    })
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
    this.setData({
      allergyState: 'ready',
      medLinks: medLinks,
      myHits: hits,
      hitsSummary: hitsText(hits),
      hitsWorst: hitsWorst,
    })
  },

  onLinkAllergenInput(e) {
    this.setData({ linkAllergen: e.detail.value })
  },

  onLinkKindChange(e) {
    this.setData({ linkKindIndex: Number(e.detail.value) || 0 })
  },

  async addLink() {
    const item = this.data.item
    if (!item) return
    const allergen = (this.data.linkAllergen || '').trim()
    if (!allergen) {
      wx.showToast({ title: '请输入过敏原', icon: 'none' })
      return
    }
    const kindOpt = this.data.linkKindOptions[this.data.linkKindIndex] || this.data.linkKindOptions[0]
    const dup = this.data.medLinks.some(function (l) {
      return l.allergen === allergen && l.kind === kindOpt.value
    })
    if (dup) {
      wx.showToast({ title: '该关联已存在', icon: 'none' })
      return
    }
    if (this.data.linkSaving) return
    this.setData({ linkSaving: true })
    const res = await drugLinksAccess.create({
      household_id: item.household_id,
      item_id: item.id,
      allergen: allergen,
      kind: kindOpt.value,
    })
    this.setData({ linkSaving: false })
    if (res.error || !res.data) {
      wx.showToast({ title: (res.error && res.error.message) || '保存失败', icon: 'none' })
      return
    }
    this.setData({ linkAllergen: '' })
    this.loadAllergyInfo(item.id, item.household_id)
  },

  removeLink(e) {
    const id = e.currentTarget.dataset.id
    const allergen = e.currentTarget.dataset.allergen || ''
    const kindLabel = e.currentTarget.dataset.kind || ''
    const that = this
    wx.showModal({
      title: '删除过敏关联',
      content: '确认删除「' + allergen + '（' + kindLabel + '）」？',
      confirmColor: '#A32D2D',
      success(res) {
        if (res.confirm) that.doRemoveLink(id)
      },
    })
  },

  async doRemoveLink(id) {
    if (!id) return
    const res = await drugLinksAccess.remove(id)
    if (res.error || !res.data) {
      wx.showToast({ title: (res.error && res.error.message) || '删除失败', icon: 'none' })
      return
    }
    wx.showToast({ title: '已删除', icon: 'success' })
    const item = this.data.item
    if (item) this.loadAllergyInfo(item.id, item.household_id)
  },

  // 标记开封（m2-brief #9）：写 opened_at=now，分级按开封后有效期（M1 已生效）
  markOpened(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    const that = this
    wx.showModal({
      title: '标记开封',
      content: '标记后临期分级将按开封后有效期计算',
      success(res) {
        if (res.confirm) that.doMarkOpened(id)
      },
    })
  },

  async doMarkOpened(id) {
    if (this.data.batchBusy) return
    this.setData({ batchBusy: true })
    const res = await batchesAccess.update(id, { opened_at: new Date().toISOString() })
    this.setData({ batchBusy: false })
    if (res.error || !res.data) {
      wx.showToast({ title: (res.error && res.error.message) || '操作失败', icon: 'none' })
      return
    }
    wx.showToast({ title: '已标记开封', icon: 'success' })
    // V2 Step4：开封流水（静默，失败不阻塞）
    const item = this.data.item
    const batch = this.findBatchById(id)
    logRecord({
      householdId: item ? item.household_id : null,
      batchId: id,
      action: 'open',
      quantity: batch ? batch.quantity : null,
      note: item ? item.name : null,
    })
    this.loadAll()
  },

  // 批次的展示态查找（流水需要 quantity 快照；dataset id 为字符串，统一字符串比较）
  findBatchById(id) {
    const all = this.data.activeBatches.concat(this.data.historyBatches)
    for (let i = 0; i < all.length; i++) {
      if (String(all[i].id) === String(id)) return all[i]
    }
    return null
  },

  // 用药计划区块（M2a，仅药品）：该药计划列表 + 成员昵称拼装
  async loadMedPlans(itemId, hid) {
    this.setData({ medPlansState: 'loading' })
    const { data, error } = await cloud.database
      .from('medication_plans')
      .select('id, item_id, member_id, times, freq, start_date, end_date, status')
      .eq('item_id', itemId)
      .order('created_at', { ascending: false })
    if (error) {
      this.setData({ medPlansState: 'error' })
      return
    }
    const memberRes = await cloud.database
      .from('members')
      .select('id, nickname')
      .eq('household_id', hid)
    if (memberRes.error) {
      this.setData({ medPlansState: 'error' })
      return
    }
    const nameMap = {}
    ;(memberRes.data || []).forEach(function (m) {
      nameMap[m.id] = m.nickname || '成员'
    })
    const FREQ = { daily: '每天', alternate_day: '隔天' }
    const STATUS = { active: '进行中', finished: '已结束', cancelled: '已取消' }
    const medPlans = (data || []).map(function (p) {
      return {
        id: p.id,
        timesText: (p.times || []).join(' / '),
        freqLabel: FREQ[p.freq] || p.freq,
        memberName: nameMap[p.member_id] || '成员',
        courseText: p.start_date + ' ~ ' + p.end_date,
        status: p.status,
        statusLabel: STATUS[p.status] || p.status,
      }
    })
    this.setData({ medPlans: medPlans, medPlansState: 'ready' })
  },

  goNewPlan() {
    const item = this.data.item
    if (!item) return
    wx.navigateTo({ url: '/pages/plan-form/plan-form?item_id=' + item.id })
  },

  goPlanEdit(e) {
    const id = e.currentTarget.dataset.id
    const status = e.currentTarget.dataset.status
    if (!id) return
    if (status !== 'active') {
      wx.showToast({ title: '仅进行中的计划可编辑', icon: 'none' })
      return
    }
    wx.navigateTo({ url: '/pages/plan-form/plan-form?id=' + id })
  },

  // 附加展示字段：剩余天数、临期分级（契约阈值：药品 7/90，其他 3/7）
  // 契约 v1.5 #13：有 opened_at 的批次按 min(到期日, 开封到期日) 计分级，displayExpiry = 实际到期日
  // V2 Step2：locationName——未选或位置已删（字典外）均显示「未指定」
  decorateBatches(rows, category, paoDays, locMap) {
    const thresholds = category === 'medicine' ? { danger: 7, warn: 90 } : { danger: 3, warn: 7 }
    const decorated = rows.map(function (b) {
      const baseDate = effectiveExpiry(b.expiry_date, b.opened_at, paoDays)
      const d = daysUntil(baseDate)
      const level = urgencyLevel(d, thresholds)
      const locName = b.location_id != null ? (locMap && locMap[b.location_id]) || '未指定' : '未指定'
      return Object.assign({}, b, {
        displayExpiry: baseDate,
        isOpened: !!b.opened_at,
        locationName: locName,
        days: d,
        daysText: d < 0 ? '已过期' : d === 0 ? '今天到期' : '剩 ' + d + ' 天',
        tagClass: level === 'expired' || level === 'danger' ? 'tag-red' : level === 'warn' ? 'tag-amber' : 'tag-green',
        statusLabel: BATCH_STATUS_LABEL[b.status] || b.status,
        statusTagClass: b.status === 'used' ? 'tag-green' : 'tag-red',
      })
    })
    // 契约 v1.5：排序按实际到期日（'YYYY-MM-DD' 字符串序即时间序）
    decorated.sort(function (a, b) {
      return a.displayExpiry < b.displayExpiry ? -1 : a.displayExpiry > b.displayExpiry ? 1 : 0
    })
    return decorated
  },

  // V2 Step1：历史批次折叠（新增事件名全小写）
  togglehistory() {
    this.setData({ historyExpanded: !this.data.historyExpanded })
  },

  // ===== 物品编辑 =====

  startEdit() {
    const item = this.data.item
    let idx = 0
    for (let i = 0; i < CATEGORIES.length; i++) {
      if (CATEGORIES[i].value === item.category) {
        idx = i
        break
      }
    }
    this.setData({
      editing: true,
      editName: item.name,
      editCategoryIndex: idx,
      editUnit: item.unit,
      editBrand: item.brand,
      editSpec: item.spec,
    })
  },

  cancelEdit() {
    this.setData({ editing: false })
  },

  onEditName(e) { this.setData({ editName: e.detail.value }) },
  onEditUnit(e) { this.setData({ editUnit: e.detail.value }) },
  onEditBrand(e) { this.setData({ editBrand: e.detail.value }) },
  onEditSpec(e) { this.setData({ editSpec: e.detail.value }) },
  onEditCategory(e) { this.setData({ editCategoryIndex: Number(e.detail.value) || 0 }) },

  async saveEdit() {
    const name = (this.data.editName || '').trim()
    if (!name) {
      wx.showToast({ title: '请填写物品名称', icon: 'none' })
      return
    }
    if (this.data.editSaving) return
    this.setData({ editSaving: true })
    const category = CATEGORIES[this.data.editCategoryIndex] || CATEGORIES[0]
    const res = await itemsAccess.update(this.data.itemId, {
      name: name,
      category: category.value,
      unit: (this.data.editUnit || '').trim(),
      brand: (this.data.editBrand || '').trim(),
      spec: (this.data.editSpec || '').trim(),
    })
    this.setData({ editSaving: false })
    if (res.error || !res.data) {
      wx.showToast({ title: (res.error && res.error.message) || '保存失败', icon: 'none' })
      return
    }
    this.setData({ editing: false })
    wx.showToast({ title: '已保存', icon: 'success' })
    this.loadAll()
  },

  // ===== 新增批次 =====

  toggleAddBatch() {
    this.setData({ addingBatch: !this.data.addingBatch })
  },

  async saveNewBatch() {
    const item = this.data.item
    if (!item) return
    const bf = this.selectComponent('#addBatchForm')
    const res = bf ? bf.getValues() : null
    if (!res || res.error) {
      wx.showToast({ title: (res && res.error) || '批次信息不完整', icon: 'none' })
      return
    }
    if (this.data.addSaving) return
    this.setData({ addSaving: true })
    // v1.9：批次写入时快照家庭内昵称（未设置则省略该字段）
    const myNickname = getApp().globalData.myNickname || ''
    const created = await batchesAccess.create({
      household_id: item.household_id,
      item_id: item.id,
      expiry_date: res.data.expiry_date,
      production_date: res.data.production_date,
      quantity: res.data.quantity,
      unit: res.data.unit,
      status: 'active',
      location_id: res.data.location_id,
      owner_name: myNickname || undefined,
    })
    this.setData({ addSaving: false })
    if (created.error || !created.data) {
      wx.showToast({ title: (created.error && created.error.message) || '保存失败', icon: 'none' })
      return
    }
    this.setData({ addingBatch: false })
    wx.showToast({ title: '已添加', icon: 'success' })
    // V2 Step4：入库流水（静默，失败不阻塞）
    logRecord({
      householdId: item.household_id,
      batchId: created.data.id,
      action: 'create',
      quantity: res.data.quantity,
      note: item.name,
    })
    this.loadAll()
  },

  // ===== 批次状态：用完 / 报废 =====

  setBatchStatus(e) {
    const id = e.currentTarget.dataset.id
    const status = e.currentTarget.dataset.status
    const label = status === 'used' ? '已用完' : '已报废'
    const that = this
    wx.showModal({
      title: '确认该批次' + label + '？',
      content: '批次将移入历史记录',
      success(res) {
        if (!res.confirm) return
        that.applyBatchStatus(id, status)
      },
    })
  },

  async applyBatchStatus(id, status) {
    if (this.data.batchBusy) return
    this.setData({ batchBusy: true })
    const res = await batchesAccess.update(id, { status: status })
    this.setData({ batchBusy: false })
    if (res.error || !res.data) {
      wx.showToast({ title: (res.error && res.error.message) || '操作失败', icon: 'none' })
      return
    }
    wx.showToast({ title: '已更新', icon: 'success' })
    // V2 Step4：用完/报废流水（静默，失败不阻塞）
    const item = this.data.item
    const batch = this.findBatchById(id)
    logRecord({
      householdId: item ? item.household_id : null,
      batchId: id,
      action: status === 'used' ? 'use_up' : 'discard',
      quantity: batch ? batch.quantity : null,
      note: item ? item.name : null,
    })
    this.loadAll()
  },

  // ===== 批次编辑 / 删除（点批次行出操作菜单） =====

  onBatchTap(e) {
    const id = e.currentTarget.dataset.id
    const all = this.data.activeBatches.concat(this.data.historyBatches)
    let batch = null
    for (let i = 0; i < all.length; i++) {
      if (all[i].id === id) {
        batch = all[i]
        break
      }
    }
    if (!batch) return
    const that = this
    wx.showActionSheet({
      itemList: ['编辑批次', '移入回收站'],
      success(res) {
        if (res.tapIndex === 0) that.startBatchEdit(batch)
        else if (res.tapIndex === 1) that.confirmDeleteBatch(batch)
      },
    })
  },

  startBatchEdit(batch) {
    this.setData({
      editingBatchId: batch.id,
      editingExpiry: batch.expiry_date,
      editingQuantity: String(batch.quantity),
      editingUnit: batch.unit,
    })
  },

  cancelBatchEdit() {
    this.setData({ editingBatchId: null })
  },

  onEditBatchExpiry(e) { this.setData({ editingExpiry: e.detail.value }) },
  onEditBatchQuantity(e) { this.setData({ editingQuantity: e.detail.value }) },
  onEditBatchUnit(e) { this.setData({ editingUnit: e.detail.value }) },

  async saveBatchEdit() {
    const id = this.data.editingBatchId
    if (!id) return
    if (!this.data.editingExpiry) {
      wx.showToast({ title: '请选择到期日', icon: 'none' })
      return
    }
    const qty = Number(this.data.editingQuantity)
    if (!this.data.editingQuantity || !isFinite(qty) || qty <= 0) {
      wx.showToast({ title: '请填写正确的数量', icon: 'none' })
      return
    }
    const unit = (this.data.editingUnit || '').trim()
    if (!unit) {
      wx.showToast({ title: '请填写单位', icon: 'none' })
      return
    }
    if (this.data.editBatchSaving) return
    this.setData({ editBatchSaving: true })
    const res = await batchesAccess.update(id, {
      expiry_date: this.data.editingExpiry,
      quantity: qty,
      unit: unit,
    })
    this.setData({ editBatchSaving: false })
    if (res.error || !res.data) {
      wx.showToast({ title: (res.error && res.error.message) || '保存失败', icon: 'none' })
      return
    }
    this.setData({ editingBatchId: null })
    wx.showToast({ title: '已保存', icon: 'success' })
    this.loadAll()
  },

  confirmDeleteBatch(batch) {
    const that = this
    wx.showModal({
      title: '移入回收站',
      content: '该批次将移入回收站，可恢复',
      confirmColor: '#A32D2D',
      success(res) {
        if (!res.confirm) return
        that.deleteBatch(batch.id)
      },
    })
  },

  async deleteBatch(id) {
    if (this.data.batchBusy) return
    this.setData({ batchBusy: true })
    // 契约 v2.0：软删除——移入回收站，可恢复
    const res = await batchesAccess.update(id, { is_deleted: true, deleted_at: new Date().toISOString() })
    this.setData({ batchBusy: false })
    if (res.error || !res.data) {
      wx.showToast({ title: (res.error && res.error.message) || '删除失败', icon: 'none' })
      return
    }
    wx.showToast({ title: '已移入回收站', icon: 'success' })
    this.loadAll()
  },

  // ===== 删除物品（软删，契约 v2.0） =====
  // 批次与物品分开处理（客户端级联）：先软删批次，任何一条失败即中止，避免半成品

  deleteItem() {
    const that = this
    const count = this.data.activeBatches.length + this.data.historyBatches.length
    wx.showModal({
      title: '移入回收站',
      content: count > 0
        ? '将同时移入回收站：该物品的 ' + count + ' 条批次记录（可在「回收站」恢复）'
        : '可在「回收站」恢复',
      confirmColor: '#A32D2D',
      success(res) {
        if (!res.confirm) return
        that.removeItemCascade()
      },
    })
  },

  async removeItemCascade() {
    wx.showLoading({ title: '处理中', mask: true })
    const ids = this.data.activeBatches.concat(this.data.historyBatches).map(function (b) { return b.id })
    const now = new Date().toISOString()
    for (let i = 0; i < ids.length; i++) {
      const res = await batchesAccess.update(ids[i], { is_deleted: true, deleted_at: now })
      if (res.error || !res.data) {
        wx.hideLoading()
        wx.showToast({ title: '批次移入回收站失败，已中止', icon: 'none' })
        return
      }
    }
    const res = await itemsAccess.update(this.data.itemId, { is_deleted: true, deleted_at: now })
    wx.hideLoading()
    if (res.error || !res.data) {
      wx.showToast({ title: (res.error && res.error.message) || '删除失败', icon: 'none' })
      return
    }
    wx.showToast({ title: '已移入回收站', icon: 'success' })
    setTimeout(function () { wx.navigateBack() }, 600)
  },
})
