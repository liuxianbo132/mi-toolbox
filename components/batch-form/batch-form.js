// 批次表单组件：到期日两种录入模式（直接选日期 / 生产日期+保质期天数换算）+ 数量/单位。
// 被录入页（首批批次）与物品详情页（新增批次）共用；宿主通过 selectComponent().getValues() 取校验后的值。
const { calcExpiry } = require('../../utils/date')

Component({
  properties: {
    // 默认单位：跟随物品单位展示在占位符，输入为空时兜底使用
    defaultUnit: {
      type: String,
      value: '',
    },
    // V2 Step2：可选存放位置列表 [{ id, name }]，首项「未指定」由组件生成
    locations: {
      type: Array,
      value: [],
    },
  },

  data: {
    mode: 'direct', // direct=直接选到期日；calc=生产日期+保质期天数
    expiryDate: '',
    productionDate: '',
    shelfLifeDays: '',
    computedExpiry: '',
    quantity: '',
    unit: '',
    locationLabels: ['未指定'],
    locationIndex: 0,
  },

  observers: {
    locations(list) {
      const labels = ['未指定'].concat(
        (list || []).map(function (l) {
          return l.name
        })
      )
      this.setData({ locationLabels: labels })
    },
  },

  methods: {
    onModeChange(e) {
      this.setData({ mode: e.currentTarget.dataset.mode })
    },

    onExpiryChange(e) {
      this.setData({ expiryDate: e.detail.value })
    },

    onProductionChange(e) {
      this.setData({ productionDate: e.detail.value })
      this.refreshComputed()
    },

    onDaysInput(e) {
      this.setData({ shelfLifeDays: e.detail.value })
      this.refreshComputed()
    },

    onQuantityInput(e) {
      this.setData({ quantity: e.detail.value })
    },

    onUnitInput(e) {
      this.setData({ unit: e.detail.value })
    },

    onLocationChange(e) {
      this.setData({ locationIndex: Number(e.detail.value) || 0 })
    },

    refreshComputed() {
      const expiry = calcExpiry(this.data.productionDate, this.data.shelfLifeDays)
      this.setData({ computedExpiry: expiry || '' })
    },

    // 视觉录入回填：识别到生产日期 + 保质期天数时切到 calc 模式并联动算到期日
    applyRecognized(opts) {
      const productionDate = opts && opts.productionDate
      const days = opts && opts.shelfLifeDays
      if (!productionDate || !days) return
      this.setData({ mode: 'calc', productionDate: productionDate, shelfLifeDays: String(days) })
      this.refreshComputed()
    },

    // 供宿主页面在保存时取值：{ data: {expiry_date, production_date, quantity, unit} | null, error }
    // production_date：calc 模式为生产日期，direct 模式为 null（date 列不能存空串）
    getValues() {
      let expiry = ''
      let productionDate = null
      if (this.data.mode === 'calc') {
        if (!this.data.productionDate) return { data: null, error: '请选择生产日期' }
        const days = Number(this.data.shelfLifeDays)
        if (!this.data.shelfLifeDays || !isFinite(days) || days <= 0) {
          return { data: null, error: '请填写正确的保质期天数' }
        }
        expiry = calcExpiry(this.data.productionDate, days)
        if (!expiry) return { data: null, error: '到期日换算失败，请检查生产日期' }
        productionDate = this.data.productionDate
      } else {
        expiry = this.data.expiryDate
        if (!expiry) return { data: null, error: '请选择到期日' }
      }
      const qty = Number(this.data.quantity)
      if (!this.data.quantity || !isFinite(qty) || qty <= 0) {
        return { data: null, error: '请填写正确的数量' }
      }
      const unit = (this.data.unit || this.data.defaultUnit || '').trim()
      if (!unit) return { data: null, error: '请填写单位' }
      // V2 Step2：位置可空（index 0 = 未指定 → null）
      const locIndex = Number(this.data.locationIndex) || 0
      const loc = locIndex > 0 ? this.data.locations[locIndex - 1] : null
      return {
        data: {
          expiry_date: expiry,
          production_date: productionDate,
          quantity: qty,
          unit: unit,
          location_id: loc ? loc.id : null,
        },
        error: null,
      }
    },
  },
})
