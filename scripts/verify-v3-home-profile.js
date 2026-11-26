const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const { compileFunction } = require('node:vm')
const { toDateOnly } = require('../utils/date')

function load(file, cloud, wx = {}, session = { data: null, error: null }) {
  const absolute = path.resolve(__dirname, '..', file)
  const resolve = createRequire(absolute)
  const module = { exports: {} }
  let page
  const execute = compileFunction(fs.readFileSync(absolute, 'utf8'), ['require', 'module', 'Page', 'wx', 'getApp'])
  execute(
    (request) => {
      if (request.endsWith('/cloud')) return { cloud }
      if (request.endsWith('/export')) return load('utils/export.js', cloud, wx, session)
      return resolve(request)
    },
    module,
    (definition) => { page = definition },
    wx,
    () => ({ globalData: {}, ensureSession: async () => session }),
  )
  if (!page) return module.exports
  page.setData = function (values, callback) {
    for (const [key, value] of Object.entries(values)) {
      const [parent, child] = key.split('.')
      if (child) this.data[parent][child] = value
      else this.data[key] = value
    }
    if (callback) callback()
  }
  return page
}

function database(read, rpc) {
  const calls = []
  return {
    calls,
    rpc,
    from(table) {
      const call = { table, filters: [], fields: '' }
      calls.push(call)
      return {
        select(fields) { call.fields = fields; return this },
        eq(...args) { call.filters.push(args); return this },
        is(...args) { call.filters.push(args); return this },
        order() { return this },
        gte() { return this },
        lt() { return this },
        limit(count) { call.limit = count; return this },
        range(from, to) { call.range = [from, to]; return this },
        then(resolve, reject) { return Promise.resolve().then(() => read(call)).then(resolve, reject) },
      }
    },
  }
}

function check(name, fn) {
  return Promise.resolve().then(fn).then(() => console.log('PASS ' + name))
}

async function main() {
  await check('首页风险排序、缺少日期、混合单位与补货共用批次查询', async () => {
    const today = new Date()
    const date = (offset) => toDateOnly(new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset))
    const item = (name, category = 'food') => ({ name, category, is_deleted: false })
    const batches = [
      { id: 1, item_id: 1, items: item('过期食品'), quantity: 2, unit: '包', expiry_date: date(-1) },
      { id: 2, item_id: 2, items: item('临期食品'), quantity: 2, unit: '包', expiry_date: date(4) },
      { id: 3, item_id: 3, items: item('临期药品', 'medicine'), quantity: 1, unit: '盒', expiry_date: date(6) },
      { id: 4, item_id: 4, items: item('无日期物品'), quantity: 1, unit: '包', expiry_date: null },
      { id: 5, item_id: 5, items: item('未临期物品'), quantity: 3, unit: '盒', expiry_date: date(40) },
    ]
    const items = [
      { id: 1, unit: '包', low_stock_threshold: 2 },
      { id: 2, unit: '盒', low_stock_threshold: 2 },
      { id: 6, low_stock_threshold: 0 },
    ]
    const db = database((call) => ({ data: call.table === 'batches' ? batches : items }))
    const page = load('pages/home/home.js', { database: db })
    page.boardContext = { householdId: 10 }
    await page.loadStock(page.boardContext)
    assert.deepEqual(page.data.stats, { expired: 1, danger: 1, warn: 1, safe: 1 })
    assert.deepEqual(page.data.urgentRows.map((row) => row.id), [1, 3, 2])
    assert.equal(page.data.undatedCount, 1)
    assert.equal(page.data.restockCount, 2)
    assert.equal(page.data.restockState, 'partial')
    assert.deepEqual(db.calls.map((call) => call.table), ['items', 'batches'])
  })

  await check('首页同批任务统计漏服、已记录与下次待记录', async () => {
    const scheduled = new Date().toISOString()
    const db = database((call) => ({ data: call.table === 'medication_doses'
      ? [
        { plan_id: 3, scheduled_at: scheduled, status: 'taken' },
        { plan_id: 5, scheduled_at: scheduled, status: 'missed' },
        { plan_id: 9, scheduled_at: scheduled, status: 'pending' },
      ]
      : [{ items: { name: '测试物品' } }] }))
    const page = load('pages/home/home.js', { database: db })
    page.boardContext = { householdId: 10 }
    await page.loadTodayDoses(page.boardContext)
    assert.deepEqual([page.data.todayDoseTotal, page.data.takenToday, page.data.missedToday, page.data.pendingToday], [3, 1, 1, 1])
    assert.equal(page.data.nextDose.name, '测试物品')
    assert.deepEqual(db.calls.map((call) => call.table), ['medication_doses', 'medication_plans'])
    assert.ok(db.calls[1].filters.some(([column, value]) => column === 'id' && value === 9))
  })

  await check('四个页面遇到会话错误时保留重试状态', async () => {
    for (const name of ['home', 'profile', 'records', 'trash']) {
      const page = load('pages/' + name + '/' + name + '.js', {}, {}, { data: null, error: { message: '网络错误' } })
      await page.restore()
      assert.equal(page.data.authState, 'error')
    }
  })

  await check('CSV 只读取物品且保留条码字符，超限不产出不完整导出', async () => {
    const db = database(() => ({ data: [{ id: 1, barcode: '0012', name: '谷物, 小袋' }] }))
    const utils = load('utils/export.js', { database: db })
    const result = await utils.buildFamilyExport(10, 'csv')
    assert.deepEqual(db.calls.map((call) => call.table), ['items'])
    assert.deepEqual(db.calls[0].filters, [['household_id', 10]])
    assert.match(result.itemsCsv, /"谷物, 小袋"/)
    assert.match(result.itemsCsv, /,0012,/)

    const capped = database(({ range: [from, to] }) => ({
      data: Array.from({ length: to - from + 1 }, (_, i) => ({ id: from + i + 1 })),
    }))
    await assert.rejects(load('utils/export.js', { database: capped }).buildFamilyExport(10, 'csv'), /导出上限/)
  })

  await check('数据导出检查身份和对应家庭成员资格', async () => {
    const session = { data: { user: { id: 'u1' } }, error: null }
    const db = database((call) => ({ data: call.filters.some(([column, value]) => column === 'id' && value === 2) ? [{ id: 2 }] : [] }))
    const page = load('pages/profile/profile.js', { database: db }, {}, session)
    page.profileContext = { userId: 'u2', householdId: 10, memberId: 2 }
    assert.equal(await page.verifyExportContext(page.profileContext), false)
    assert.equal(db.calls.length, 0)
    page.profileContext = { userId: 'u1', householdId: 10, memberId: 2 }
    assert.equal(await page.verifyExportContext(page.profileContext), true)
    assert.deepEqual(db.calls[0].filters, [['owner_id', 'u1'], ['household_id', 10], ['id', 2]])
    assert.equal(page.exportMatches(page.profileContext, { userId: 'u1', householdId: 20 }), false)
  })

  await check('记录筛选后按日期分组保留原有排序', () => {
    const page = load('pages/records/records.js', {})
    page.rawRecords = [
      { id: 1, day: '2026-11-25', action: 'open' },
      { id: 2, day: '2026-11-25', action: 'create' },
      { id: 3, day: '2026-11-24', action: 'create' },
    ]
    page.onfilter({ currentTarget: { dataset: { key: 'create' } } })
    assert.deepEqual(page.data.recordGroups.map((group) => [group.day, ...group.rows.map((row) => row.id)]), [
      ['2026-11-25', 2], ['2026-11-24', 3],
    ])
  })

  await check('回收站恢复调用原子接口，取消确认不执行彻底删除', async () => {
    const writes = []
    const db = database(() => ({ data: [] }), async (rpc, args) => {
      writes.push([rpc, args])
      return { data: 'ok' }
    })
    const page = load('pages/trash/trash.js', { database: db }, {
      showLoading() {}, hideLoading() {}, showToast() {},
      showModal({ success }) { success({ confirm: false }) },
    })
    page.setData({ contentState: 'ready', householdId: 10 })
    const event = { currentTarget: { dataset: { id: '42' } } }
    page.onpurgeitem(event)
    assert.equal(writes.length, 0)
    await page.onrestoreitem(event)
    assert.deepEqual(writes, [['set_stock_deleted', { p_item_id: '42', p_batch_id: null, p_deleted: false }]])
  })
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
