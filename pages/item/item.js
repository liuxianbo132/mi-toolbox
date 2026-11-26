const { cloud } = require('../../utils/cloud')
const { itemsAccess, batchesAccess, drugLinksAccess, logRecord } = require('../../utils/data-access')
const { CATEGORIES, categoryLabel, categoryIllustration, itemIllustration } = require('../../utils/constants')
const { daysUntil, urgencyLevel, effectiveExpiry } = require('../../utils/date')
const { matchAllergies, hitsText, KIND_LABEL } = require('../../utils/allergy')
const { parseOptionalDaysOrCount } = require('../../utils/inventory-fields')

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
    stockDeleting: false,
    batchesLimited: false,
    categoryOptions: CATEGORIES.map(function (category) {
      return Object.assign({}, category, { illustration: categoryIllustration(category.value) })
    }),
    // 物品编辑
    editing: false,
    editSaving: false,
    editName: '',
    editCategoryIndex: 0,
    editUnit: '',
    editBrand: '',
    editSpec: '',
    editLowStockThreshold: '',
    editPaoDays: '',
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
    try {
      await this.loadItemDetails()
    } catch (error) {
      this.setData({ loading: false, loadState: 'error', loadError: '物品信息暂时无法加载，请重试' })
    }
  },

  async loadItemDetails() {
    const { data: itemRows, error } = await cloud.database
      .from('items')
      .select('id, household_id, name, category, unit, brand, spec, pao_days, low_stock_threshold')
      .eq('id', this.data.itemId)
      .eq('is_deleted', false)
      .limit(1)
    if (error || !Array.isArray(itemRows)) {
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
    this.itemSnapshot = row
    const [batchRes, locRes] = await Promise.all([
      cloud.database.from('batches')
        .select('id, item_id, expiry_date, opened_at, quantity, unit, status, location_id')
        .eq('household_id', row.household_id).eq('item_id', row.id).eq('is_deleted', false)
        .order('expiry_date', { ascending: true }).order('id', { ascending: true }).limit(201),
      cloud.database.from('locations').select('id, name').eq('household_id', row.household_id).order('name', { ascending: true }),
    ])
    const batchesFailed = !!(batchRes.error || locRes.error || !Array.isArray(batchRes.data) || !Array.isArray(locRes.data))
    const batchRows = Array.isArray(batchRes.data) ? batchRes.data : []
    const locations = Array.isArray(locRes.data) ? locRes.data : []
    const locMap = {}
    locations.forEach(function (l) {
      locMap[l.id] = l.name
    })
    const all = this.decorateBatches(batchRows.slice(0, 200), row.category, row.pao_days, locMap)
    const activeBatches = all.filter(function (b) { return b.status === 'active' })
    const historyBatches = all.filter(function (b) { return b.status !== 'active' })
    this.setData({
      loading: false,
      loadState: 'ready',
      batchState: batchesFailed ? 'error' : 'ready',
      batchError: batchesFailed ? '批次信息暂时无法加载，请重试' : '',
      batchesLimited: batchRows.length > 200,
      item: {
        id: row.id,
        household_id: row.household_id,
        name: row.name,
        category: row.category,
        categoryLabel: categoryLabel(row.category),
        itemIllu: itemIllustration(row.name, row.category),
        unit: row.unit || '',
        brand: row.brand || '',
        spec: row.spec || '',
        lowStockThreshold: row.low_stock_threshold == null ? '0' : String(row.low_stock_threshold),
        paoDays: row.pao_days > 0 ? String(row.pao_days) : '',
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
    const { data: session, error } = await getApp().ensureSession()
    const uid = session && session.user && session.user.id
    if (error || !uid) {
      this.setData({ allergyState: 'error', allergyError: '登录信息暂不可用，无法核对档案匹配' })
      return
    }
    if (uid) {
      const memberRes = await cloud.database
        .from('members')
        .select('id')
        .eq('household_id', hid)
        .eq('owner_id', uid)
        .is('left_at', null)
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
      content: this.data.item.paoDays
        ? '按物品设置的 ' + this.data.item.paoDays + ' 天计算开封到期日，库存采用较早的到期日。'
        : '将记录开封时间。当前物品未设置开封后有效期，仍按原批次到期日提醒。',
      success(res) {
        if (res.confirm) that.doMarkOpened(id)
      },
    })
  },

  async doMarkOpened(id) {
    await this.updateActiveBatch(id, 'open', { opened_at: new Date().toISOString() })
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
    this.itemEditSnapshot = this.itemSnapshot
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
      editLowStockThreshold: item.lowStockThreshold,
      editPaoDays: item.paoDays,
    })
  },

  cancelEdit() {
    this.setData({ editing: false })
  },

  onEditName(e) { this.setData({ editName: e.detail.value }) },
  onEditUnit(e) { this.setData({ editUnit: e.detail.value }) },
  onEditBrand(e) { this.setData({ editBrand: e.detail.value }) },
  onEditSpec(e) { this.setData({ editSpec: e.detail.value }) },
  onEditLowStockThreshold(e) { this.setData({ editLowStockThreshold: e.detail.value }) },
  onEditPaoDays(e) { this.setData({ editPaoDays: e.detail.value }) },
  onEditCategory(e) { this.setData({ editCategoryIndex: Number(e.detail.value) || 0 }) },

  async saveEdit() {
    if (this.data.stockDeleting) return
    const name = (this.data.editName || '').trim()
    if (!name) {
      wx.showToast({ title: '请填写物品名称', icon: 'none' })
      return
    }
    const lowStockThreshold = parseOptionalDaysOrCount(this.data.editLowStockThreshold, 999)
    if (lowStockThreshold == null) {
      wx.showToast({ title: '低库存提醒请填 0–999 的整数', icon: 'none' })
      return
    }
    const paoDays = parseOptionalDaysOrCount(this.data.editPaoDays, 3650)
    if (paoDays == null) {
      wx.showToast({ title: '开封后有效期请填 1–3650 天，留空关闭', icon: 'none' })
      return
    }
    if (this.data.editSaving) return
    const original = this.itemEditSnapshot
    if (!original) return
    this.setData({ editSaving: true })
    const category = CATEGORIES[this.data.editCategoryIndex] || CATEGORIES[0]
    const res = await itemsAccess.update(this.data.itemId, {
      name: name,
      category: category.value,
      unit: (this.data.editUnit || '').trim(),
      brand: (this.data.editBrand || '').trim(),
      spec: (this.data.editSpec || '').trim(),
      low_stock_threshold: lowStockThreshold,
      pao_days: paoDays,
    }, {
      household_id: original.household_id,
      is_deleted: false,
      name: original.name,
      category: original.category,
      unit: original.unit,
      brand: original.brand,
      spec: original.spec,
      low_stock_threshold: original.low_stock_threshold,
      pao_days: original.pao_days,
    })
    this.setData({ editSaving: false })
    if (res.error || !res.data) {
      if (res.error && res.error.code === '23514' && res.error.message === 'medication_item_in_use') {
        wx.showToast({ title: '请先取消该药品的用药计划', icon: 'none' })
        return
      }
      if (res.error && res.error.code === 'NOT_FOUND_OR_FORBIDDEN') {
        this.setData({ editing: false })
        wx.showToast({ title: '物品已有变化，正在刷新', icon: 'none' })
        this.loadAll()
        return
      }
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
    if (this.data.stockDeleting || this.data.batchState !== 'ready') return
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
    if (status !== 'used' && status !== 'discarded') return
    await this.updateActiveBatch(id, status === 'used' ? 'use_up' : 'discard', { status })
  },

  async updateActiveBatch(id, action, patch) {
    const item = this.data.item
    if (!id || !item || this.data.batchBusy || this.data.stockDeleting || this.data.editBatchSaving) return
    this.setData({ batchBusy: true })
    try {
      const expected = { item_id: item.id, household_id: item.household_id, is_deleted: false, status: 'active' }
      if (action === 'open') expected.opened_at = null
      const { data, error } = await batchesAccess.update(id, patch, expected)
      const updated = !error && data
      if (!updated) {
        wx.showToast({ title: '批次状态待确认，正在刷新', icon: 'none' })
      } else {
        wx.showToast({ title: action === 'open' ? '已标记开封' : '已更新', icon: 'success' })
        logRecord({ householdId: item.household_id, batchId: updated.id, action, quantity: updated.quantity, note: item.name })
      }
      await this.loadAll()
    } catch (error) {
      wx.showToast({ title: '批次状态待确认，正在刷新', icon: 'none' })
      await this.loadAll()
    } finally {
      this.setData({ batchBusy: false })
    }
  },

  // ===== 批次编辑 / 删除（点批次行出操作菜单） =====

  onBatchTap(e) {
    const id = e.currentTarget.dataset.id
    const batch = this.findBatchById(id)
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
    this.batchEditSnapshot = batch
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
    if (this.data.stockDeleting || this.data.batchBusy) return
    const id = this.data.editingBatchId
    const original = this.batchEditSnapshot
    const item = this.data.item
    if (!id || !original || !item) return
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
    }, {
      item_id: item.id,
      household_id: item.household_id,
      is_deleted: false,
      status: original.status,
      expiry_date: original.expiry_date,
      quantity: original.quantity,
      unit: original.unit,
    })
    this.setData({ editBatchSaving: false })
    if (res.error || !res.data) {
      if (res.error && res.error.code === 'NOT_FOUND_OR_FORBIDDEN') {
        this.setData({ editingBatchId: null })
        wx.showToast({ title: '批次已有变化，正在刷新', icon: 'none' })
        this.loadAll()
        return
      }
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
    await this.moveToTrash({ p_item_id: null, p_batch_id: id, p_deleted: true })
  },

  deleteItem() {
    if (this.data.stockDeleting) return
    wx.showModal({
      title: '移入回收站',
      content: '物品及其全部未删除批次将同时移入回收站，可从回收站恢复。',
      confirmColor: '#A32D2D',
      success: (res) => {
        if (res.confirm) this.moveToTrash({ p_item_id: this.data.itemId, p_batch_id: null, p_deleted: true })
      },
    })
  },

  async moveToTrash(args) {
    if (this.data.stockDeleting || this.data.batchBusy || this.data.addSaving || this.data.editBatchSaving || this.data.editSaving) return
    this.setData({ stockDeleting: true })
    try {
      const { data, error } = await cloud.database.rpc('set_stock_deleted', args)
      if (!error && data === 'referenced') {
        wx.showToast({ title: '请先取消该药品的用药计划', icon: 'none' })
        return
      }
      if (error || data !== 'ok') {
        wx.showToast({ title: '回收站状态待确认，正在刷新', icon: 'none' })
        await this.loadAll()
        return
      }
      wx.showToast({ title: '已移入回收站', icon: 'success' })
      if (args.p_item_id) {
        wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/inventory/inventory' }) })
      } else {
        await this.loadAll()
      }
    } catch (error) {
      wx.showToast({ title: '回收站状态待确认，正在刷新', icon: 'none' })
      await this.loadAll()
    } finally {
      this.setData({ stockDeleting: false })
    }
  },
})
