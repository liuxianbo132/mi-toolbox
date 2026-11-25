const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { parseOptionalDaysOrCount } = require('../utils/inventory-fields')
const { createTableAccess } = require('../utils/workbuddy-data-access')
const { addStockQuantity, stockQuantity } = require('../utils/stock-quantity')
const { makeRequestId } = require('../utils/request-id')

function loadPage(name, app, responses, mocks = {}) {
  let definition
  const file = path.join(__dirname, '..', 'pages', name, name + '.js')
  const requests = []
  const cloud = { database: {
    from(table) {
      const entry = { table, filters: [] }
      const read = () => {
        requests.push(entry)
        return Promise.resolve(responses[table](entry))
      }
      const builder = {
        select() { return builder },
        eq(field, value) { entry.filters.push([field, value]); return builder },
        is(field, value) { entry.filters.push([field, value]); return builder },
        update(value) { entry.update = value; return builder },
        order() { return builder },
        range() { return read() },
        limit() { return read() },
        then(resolve, reject) { return read().then(resolve, reject) },
      }
      return builder
    },
    rpc: mocks.rpc,
  } }
  const nativeRequire = createRequire(file)
  const sandbox = {
    Page: (page) => { definition = page },
    getApp: () => app,
    wx: mocks.wx || {},
    setTimeout: mocks.setTimeout || setTimeout,
    clearTimeout: mocks.clearTimeout || clearTimeout,
    require: (module) => {
      if (module === '../../utils/cloud') return { cloud }
      if (Object.hasOwn(mocks, module)) return typeof mocks[module] === 'function' ? mocks[module](cloud) : mocks[module]
      return nativeRequire(module)
    },
  }
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file })
  const history = []
  const page = Object.assign(definition, {
    setData(values, complete) {
      Object.assign(this.data, values)
      history.push(this.data.authState || this.data.status)
      if (complete) complete()
    },
  })
  return { page, requests, history }
}

function success(data) { return { data, error: null } }
function flush() { return new Promise((resolve) => setImmediate(resolve)) }

async function main() {
  const app = { globalData: {}, ensureSession: async () => success({ user: { id: 'user-1' } }) }
  let resolveMembers
  const members = new Promise((resolve) => { resolveMembers = resolve })
  const items = [{ id: 1, name: '测试牛奶', category: 'food', unit: '盒', low_stock_threshold: 2, pao_days: 3 }]
  const batches = [{ item_id: 1, quantity: '2', unit: '盒', expiry_date: '2030-03-01', opened_at: '2030-01-01T12:00:00', location_id: 9 }]
  app.globalData.pendingInventoryLowStockFilter = { householdId: '5' }
  const inventory = loadPage('inventory', app, {
    members: () => members,
    items: () => success(items),
    batches: () => success(batches),
    locations: () => success([{ id: 9, name: '冰箱' }]),
  })
  const load = inventory.page.restore()
  await flush()
  assert.equal(inventory.page.data.authState, 'household-loading')
  resolveMembers(success([{ household_id: 5 }]))
  await load
  assert.equal(inventory.history.includes('no-household'), false)
  assert.equal(inventory.requests.filter((request) => request.table === 'members').length, 1)
  assert.equal(inventory.page.data.stockFilter, 'low')
  assert.equal(inventory.page.data.resultCount, 1)
  assert.equal(inventory.page.data.groups[0].items[0].earliestExpiry, '2030-01-03')
  assert.equal(inventory.page.data.groups[0].items[0].locText, '冰箱')
  assert.equal(app.globalData.pendingInventoryLowStockFilter, null)
  batches.push({ item_id: 1, quantity: 1, unit: '袋', expiry_date: '2030-03-01' })
  await inventory.page.restore()
  assert.equal(inventory.page.data.quantitiesUnknown, true)
  assert.equal(inventory.page.data.resultCount, 0)
  inventory.page.clearInventoryFilters()
  assert.equal(inventory.page.data.groups[0].items[0].stockText, '数量待核对')

  const stock = new Map()
  addStockQuantity(stock, { item_id: 7, quantity: 1.5, unit: ' 盒 ' })
  addStockQuantity(stock, { item_id: '7', quantity: '2.5', unit: '盒' })
  assert.deepEqual(stockQuantity(stock, { id: 7 }), { quantity: 4, unit: '盒' })
  assert.equal(stockQuantity(stock, { id: 7, unit: '袋' }).quantity, null)
  assert.equal(stockQuantity(stock, { id: 8, unit: '袋' }).quantity, 0)
  addStockQuantity(stock, { item_id: 7, quantity: 1 })
  assert.equal(stockQuantity(stock, { id: 7 }).quantity, null)

  const failed = loadPage('inventory', app, { members: () => ({ data: null, error: Error('网络不可用') }) })
  await failed.page.restore()
  assert.equal(failed.page.data.authState, 'error')
  const upgrade = loadPage('inventory', app, { members: () => ({ data: null, error: { code: '42703', message: 'members.left_at' } }) })
  await upgrade.page.restore()
  assert.equal(upgrade.page.data.authState, 'error')
  assert.equal(upgrade.page.data.loadError, '库存服务版本尚未同步，请稍后重试')
  const missing = loadPage('inventory', app, { members: () => success([]) })
  await missing.page.restore()
  assert.equal(missing.page.data.authState, 'no-household')

  let resolveOld
  let membershipChecks = 0
  const oldRead = new Promise((resolve) => { resolveOld = resolve })
  const stale = loadPage('inventory', app, {
    members: () => ++membershipChecks === 1 ? oldRead : success([]),
  })
  const first = stale.page.restore()
  await flush()
  await stale.page.restore()
  resolveOld(success([{ household_id: 5 }]))
  await first
  assert.equal(stale.page.data.authState, 'no-household')
  assert.equal(stale.requests.length, 2)

  let scanResult
  let scanTimer
  let redirectUrl
  const scan = loadPage('scan', app, { members: () => success([{ household_id: 5 }]) }, {
    wx: {
      scanCode: (options) => { scanResult = options },
      redirectTo: ({ url }) => { redirectUrl = url },
    },
    setTimeout: (callback) => { scanTimer = callback },
    clearTimeout() {},
  })
  await scan.page.startScan()
  assert.equal(scan.page.data.status, 'scanning')
  scanTimer()
  assert.equal(scan.page.data.status, 'waiting')
  scan.page.goManual()
  scanResult.success({ result: 'late barcode' })
  assert.equal(redirectUrl, '/pages/item-form/item-form')
  assert.equal(scan.requests.length, 1)

  const transitions = []
  const detail = loadPage('item', app, { batches: () => success([{ id: 2, quantity: 3 }]) }, {
    wx: { showToast() {} },
    '../../utils/data-access': (cloud) => ({
      batchesAccess: createTableAccess(cloud, {
        table: 'batches', columns: ['id', 'item_id', 'household_id', 'quantity', 'status', 'opened_at', 'is_deleted'],
      }),
      logRecord: (record) => { transitions.push(record) },
    }),
  })
  detail.page.data.item = { id: 1, household_id: 5, name: '测试牛奶' }
  detail.page.loadAll = async () => {}
  await detail.page.doMarkOpened(2)
  assert.ok(detail.requests[0].filters.some(([field, value]) => field === 'opened_at' && value === null))
  assert.ok(detail.requests[0].filters.some(([field, value]) => field === 'status' && value === 'active'))
  assert.equal(transitions[0].quantity, 3)

  global.wx = { getRandomValues: ({ length, success }) => success({ randomValues: new ArrayBuffer(length) }) }
  const requestId = await makeRequestId()
  assert.equal(requestId, '00000000-0000-4000-8000-000000000000')
  global.wx = {}
  await assert.rejects(makeRequestId(), /Random source unavailable/)

  const saves = []
  let requestsCreated = 0
  let subscriptions = 0
  const form = loadPage('item-form', app, {}, {
    wx: { showToast() {} },
    rpc: async (name, payload) => {
      assert.equal(name, 'create_stock_atomic')
      saves.push(payload)
      if (saves.length === 1) throw Error('network timeout')
      return success({ ok: true, item_id: 4, batch_id: 6 })
    },
    '../../utils/vision': {},
    '../../utils/subscribe': { askExpirySubscribe() { subscriptions++ } },
    '../../utils/request-id': { makeRequestId: async () => { requestsCreated++; return requestId } },
  })
  form.page.data.householdId = 5
  form.page.data.authState = 'ready'
  form.page.data.name = '测试物品'
  form.page.selectComponent = () => ({ getValues: () => success({ quantity: 1, unit: '盒' }) })
  form.page.backAfter = () => {}
  await form.page.onSaveTap()
  assert.equal(form.page.data.saveUnknown, true)
  assert.equal(form.page.data.saveComplete, false)
  form.page.data.name = '意外修改'
  await form.page.onSaveTap()
  await form.page.onSaveTap()
  assert.equal(form.page.data.saveComplete, true)
  assert.equal(requestsCreated, 1)
  assert.equal(saves.length, 2)
  assert.equal(saves[0], saves[1])
  assert.equal(saves[1].p_item.name, '测试物品')
  assert.equal(saves[1].p_first_batch.quantity, 1)
  assert.equal(saves[1].p_first_batch.item_id, undefined)
  assert.equal(subscriptions, 1)
  assert.equal(form.requests.length, 0)

  const rejections = []
  const rejected = loadPage('item-form', app, {}, {
    rpc: async (_, payload) => { rejections.push(payload); return success({ ok: false, error: 'invalid_stock' }) },
    '../../utils/vision': {},
    '../../utils/subscribe': {},
    '../../utils/request-id': { makeRequestId: async () => 'request-' + ++requestsCreated },
  })
  rejected.page.data.householdId = 5
  rejected.page.data.authState = 'ready'
  rejected.page.data.name = '待修正物品'
  rejected.page.selectComponent = form.page.selectComponent
  await rejected.page.onSaveTap()
  assert.equal(rejected.page.data.saveUnknown, false)
  assert.match(rejected.page.data.saveError, /首个批次/)
  rejected.page.data.name = '已修正物品'
  await rejected.page.onSaveTap()
  assert.notEqual(rejections[0].p_request_id, rejections[1].p_request_id)
  assert.equal(rejections[1].p_item.name, '已修正物品')

  assert.equal(parseOptionalDaysOrCount('', 3650), 0)
  assert.equal(parseOptionalDaysOrCount('3650', 3650), 3650)
  assert.equal(parseOptionalDaysOrCount('3651', 3650), null)
  assert.equal(parseOptionalDaysOrCount('2.5', 3650), null)
  assert.equal(parseOptionalDaysOrCount('-1', 3650), null)
  console.log('库存回归通过：家庭加载、过期响应、待补货入口、开封日期、混合单位、扫码兜底、批次条件写入与原子录入重试')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
