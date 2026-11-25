// 表访问实例：所有增删改统一走 createTableAccess（简报约定，不绕过守卫裸写）。
// 带过滤条件的读查询沿用 home.js 既有直连模式（createTableAccess.list 不支持 eq 过滤）。
const { createTableAccess } = require('./workbuddy-data-access')
const { cloud } = require('./cloud')

// 契约字段白名单：提交时只放行这些字段，UI 层多余字段不会带到服务端
// id 必须包含：create() 的 .insert().select(columns) 靠它把自增主键带回（否则 created.data.id 缺失）
// 写路径安全性：pickFields 跳过 undefined，payload 不带 id 时 id 不会进入 insert（自增不受影响）
// production_date：生产日期（calc 模式录入，direct 模式存 null）；需后端 batches 同步加列后生效
const ITEM_FIELDS = ['id', 'household_id', 'name', 'category', 'unit', 'brand', 'spec', 'barcode', 'pao_days', 'low_stock_threshold', 'is_deleted', 'deleted_at']
const BATCH_FIELDS = ['id', 'household_id', 'item_id', 'expiry_date', 'production_date', 'quantity', 'unit', 'status', 'opened_at', 'location_id', 'owner_name', 'is_deleted', 'deleted_at']

function pickFields(fields) {
  return function (payload) {
    const row = {}
    fields.forEach(function (f) {
      if (payload && payload[f] !== undefined) row[f] = payload[f]
    })
    return row
  }
}

const itemsAccess = createTableAccess(cloud, {
  table: 'items',
  columns: ITEM_FIELDS,
  toRow: pickFields(ITEM_FIELDS),
  orderBy: { column: 'created_at', ascending: false },
})

const batchesAccess = createTableAccess(cloud, {
  table: 'batches',
  columns: BATCH_FIELDS,
  toRow: pickFields(BATCH_FIELDS),
  orderBy: { column: 'expiry_date', ascending: true },
})

// ===== M2 表（契约 v1.7；白名单必须含 id——M1 教训见上） =====

const ALLERGY_FIELDS = ['id', 'member_id', 'household_id', 'allergen']
const DRUG_LINK_FIELDS = ['id', 'household_id', 'item_id', 'allergen', 'kind']
const PLAN_FIELDS = ['id', 'household_id', 'item_id', 'member_id', 'times', 'freq', 'start_date', 'end_date', 'miss_threshold_minutes', 'status']
const DOSE_FIELDS = ['id', 'household_id', 'plan_id', 'scheduled_at', 'confirmed_at', 'status']

// V2 Step2：存放位置（契约 v1.8——V2 只用 name，kind 保留表默认不接 UI）
const LOCATION_FIELDS = ['id', 'household_id', 'name']

const allergiesAccess = createTableAccess(cloud, {
  table: 'allergies',
  columns: ALLERGY_FIELDS,
  toRow: pickFields(ALLERGY_FIELDS),
})

const drugLinksAccess = createTableAccess(cloud, {
  table: 'drug_allergy_links',
  columns: DRUG_LINK_FIELDS,
  toRow: pickFields(DRUG_LINK_FIELDS),
})

const plansAccess = createTableAccess(cloud, {
  table: 'medication_plans',
  columns: PLAN_FIELDS,
  toRow: pickFields(PLAN_FIELDS),
  orderBy: { column: 'created_at', ascending: false },
})

const dosesAccess = createTableAccess(cloud, {
  table: 'medication_doses',
  columns: DOSE_FIELDS,
  toRow: pickFields(DOSE_FIELDS),
  orderBy: { column: 'scheduled_at', ascending: true },
})

const locationsAccess = createTableAccess(cloud, {
  table: 'locations',
  columns: LOCATION_FIELDS,
  toRow: pickFields(LOCATION_FIELDS),
  orderBy: { column: 'created_at', ascending: true },
})

// ===== V2 Step4：操作流水（契约 v1.8——action: create/open/use_up/discard） =====

const RECORD_FIELDS = ['id', 'household_id', 'batch_id', 'action', 'quantity', 'note', 'owner_id', 'owner_name']

const recordsAccess = createTableAccess(cloud, {
  table: 'records',
  columns: RECORD_FIELDS,
  toRow: pickFields(RECORD_FIELDS),
  orderBy: { column: 'created_at', ascending: false },
})

// 静默写流水：主操作成功后 fire-and-forget 调用；任何失败仅 console 警告，绝不抛出、不阻塞主操作
// owner_id/owner_name 取当前 session 快照；空字段直接不传（pickFields 只跳过 undefined，null 会撞 NOT NULL）
// v1.9：owner_name 优先取 payload.ownerName，其次 globalData.myNickname（members 昵称），最后回退 session 用户名
async function logRecord(entry) {
  try {
    const payload = {
      household_id: entry.householdId,
      action: entry.action,
    }
    if (entry.batchId != null) payload.batch_id = entry.batchId
    if (entry.quantity != null) payload.quantity = entry.quantity
    if (entry.note) payload.note = entry.note
    let ownerName = entry.ownerName ? String(entry.ownerName).trim() : ''
    if (!ownerName) {
      try {
        const app = getApp()
        if (app && app.globalData && app.globalData.myNickname) {
          ownerName = String(app.globalData.myNickname).trim()
        }
      } catch (e) {
        // getApp 未就绪（如 App 初始化前）时静默回退
      }
    }
    const { data: session } = await cloud.auth.getSession()
    const uid = session && session.user && session.user.id
    const uname = (session && session.user && session.user.name) || null
    if (!ownerName && uname) ownerName = uname
    if (uid) payload.owner_id = uid
    if (ownerName) payload.owner_name = ownerName
    const res = await recordsAccess.create(payload)
    if (res.error) console.warn('[records] write failed (silent):', res.error)
    return res
  } catch (e) {
    console.warn('[records] write exception (silent):', e)
    return { data: null, error: e }
  }
}

// 整疗程 doses 批量落库（契约 v1.7 #5：保存计划时一次性生成）。
// createTableAccess 只支持单行 insert，180 天 × 多时间点可达数百行，故单列批量入口；
// 仍经 DOSE_FIELDS 白名单过滤，返回结构对齐 createTableAccess（{ data, error }）
async function createDosesBulk(rows) {
  const list = (rows || []).map(pickFields(DOSE_FIELDS)).filter(function (r) {
    return Object.keys(r).length > 0
  })
  if (!list.length) return { data: [], error: null }
  try {
    const result = await cloud.database.from('medication_doses').insert(list)
    return { data: (result && result.data) || [], error: (result && result.error) || null }
  } catch (e) {
    return { data: null, error: { code: 'CLIENT_EXCEPTION', message: (e && e.message) || '批量写入失败' } }
  }
}

module.exports = {
  itemsAccess,
  batchesAccess,
  allergiesAccess,
  drugLinksAccess,
  plansAccess,
  dosesAccess,
  locationsAccess,
  recordsAccess,
  logRecord,
  createDosesBulk,
  ITEM_FIELDS,
  BATCH_FIELDS,
  ALLERGY_FIELDS,
  DRUG_LINK_FIELDS,
  PLAN_FIELDS,
  DOSE_FIELDS,
  LOCATION_FIELDS,
  RECORD_FIELDS,
}
