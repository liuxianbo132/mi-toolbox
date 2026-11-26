import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { createMiniProgramWorkBuddyCloud } from '@tencent-ai/workbuddy-cloud-sdk/miniprogram'

const [exe, driver, portValue, database] = process.argv.slice(2)
assert.match(database, /^mi_v3_[0-9a-f]{32}$/)
const port = Number(portValue)
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535)
const require = createRequire(import.meta.url)
const { Client } = require(resolve(driver))
const admin = new Client({ host: '127.0.0.1', port, database, user: 'mi_v3_test' })
await admin.connect()
try {
  await admin.query(`CREATE ROLE mi_v3_rest LOGIN;
    GRANT anon, authenticated TO mi_v3_rest;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS text LANGUAGE sql STABLE AS $$
      SELECT NULLIF(current_setting('request.jwt.claims', true), '')::jsonb->>'sub'
    $$;`)
} finally {
  await admin.end()
}

const socket = createServer()
socket.listen(0, '127.0.0.1')
await once(socket, 'listening')
const apiPort = socket.address().port
await new Promise((done) => socket.close(done))
const endpoint = `http://127.0.0.1:${apiPort}`
const secret = randomBytes(36).toString('hex')
const rest = spawn(resolve(exe), [], {
  windowsHide: true,
  env: {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('PGRST_'))),
    PGRST_DB_URI: `postgresql://mi_v3_rest@127.0.0.1:${port}/${database}`,
    PGRST_DB_SCHEMAS: 'public', PGRST_DB_ANON_ROLE: 'anon', PGRST_JWT_SECRET: secret,
    PGRST_SERVER_HOST: '127.0.0.1', PGRST_SERVER_PORT: String(apiPort),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let serverError
rest.on('error', (error) => { serverError = error })
const closed = new Promise((done) => rest.once('close', done))
let logs = ''
const append = (chunk) => { logs = (logs + chunk).slice(-4000) }
rest.stdout.on('data', append)
rest.stderr.on('data', append)

function issueToken(actor) {
  const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url')
  const claims = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: actor, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}`
  return `${claims}.${createHmac('sha256', secret).update(claims).digest('base64url')}`
}

function client(actor, dropResponses = new Set()) {
  const storage = new Map()
  const wx = {
    getStorageSync: (key) => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: (key) => storage.delete(key),
    request(options) {
      const abort = new AbortController()
      const url = new URL(options.url)
      assert.equal(url.origin, endpoint)
      if (url.pathname === '/.cloud/auth/v1/login-wechat') {
        queueMicrotask(() => options.success({ statusCode: 200, header: {}, data: {
          access_token: issueToken(actor), refresh_token: 'fixture-refresh', expires_in: 3600, sub: actor,
        } }))
      } else {
        const prefix = '/.cloud/database/rest'
        assert.ok(url.pathname.startsWith(prefix + '/'))
        url.pathname = url.pathname.slice(prefix.length)
        fetch(url, { method: options.method, headers: options.header, body: options.data, redirect: 'error',
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]) })
          .then(async (response) => {
            const body = await response.text()
            if (response.ok && dropResponses.delete(url.pathname)) {
              options.fail({ errMsg: 'fixture: response lost after database commit' })
              return
            }
            options.success({ statusCode: response.status, header: Object.fromEntries(response.headers), data: body })
          })
          .catch((error) => options.fail({ errMsg: error.message }))
      }
      return { abort: () => abort.abort() }
    },
  }
  return createMiniProgramWorkBuddyCloud({ endpoint, publishableKey: 'wbpk_local_fixture', wx })
}

async function data(result) {
  const { data: value, error } = await result
  assert.ok(!error, JSON.stringify(error))
  return value
}

function loadMiniProgram(relativePath, overrides) {
  const filename = fileURLToPath(new URL(relativePath, import.meta.url))
  const localRequire = createRequire(filename)
  const module = { exports: {} }
  let definition
  const register = (value) => { definition = value }
  runInNewContext(readFileSync(filename, 'utf8'), {
    module, Page: register, Component: register, ...overrides,
    require(id) {
      return Object.hasOwn(overrides.dependencies || {}, id) ? overrides.dependencies[id] : localRequire(id)
    },
  }, { filename })
  if (!definition) return module.exports
  return Object.assign(definition, { setData(fields) { Object.assign(this.data, fields) } })
}

try {
  let ready = false
  for (let attempt = 0; attempt < 100 && !ready; attempt++) {
    if (serverError || rest.exitCode !== null) throw serverError || new Error(`PostgREST startup exit ${rest.exitCode}`)
    try { ready = (await fetch(endpoint, { signal: AbortSignal.timeout(500) })).ok } catch {}
    if (!ready) await delay(100)
  }
  assert.ok(ready, 'PostgREST did not expose its schema')

  const dropResponses = new Set()
  const member = client('member-a', dropResponses)
  const owner = client('owner-a')
  const other = client('owner-b')
  for (const [cloud, actor] of [[member, 'member-a'], [owner, 'owner-a'], [other, 'owner-b']]) {
    await data(cloud.auth.signInWithWechat('synthetic-code', 'synthetic-app'))
    assert.equal((await data(cloud.auth.getSession())).user.id, actor)
  }
  const own = await data(member.database.from('members').select('id,household_id,households(id)').eq('owner_id', 'member-a').is('left_at', null))
  assert.deepEqual(own, [{ id: 2, household_id: 1, households: { id: 1 } }])

  const { toDateOnly } = require('../utils/date')
  const tomorrow = toDateOnly(new Date(Date.now() + 86400000))
  const rpc = (cloud, name, args) => data(cloud.database.rpc(name, args))
  let activeClient = member
  const pageCloud = { get database() { return activeClient.database } }
  const app = { globalData: {}, sessionVersion: 1, ensureSession: () => activeClient.auth.getSession() }
  const actions = []
  const wx = {
    getRandomValues({ length, success }) { success({ randomValues: Uint8Array.from(randomBytes(length)).buffer }) },
    showToast({ title }) { actions.push(title) },
    navigateBack() { actions.push('back') },
  }
  const formEnv = {
    wx, getApp: () => app, setTimeout: () => 0,
    dependencies: {
      '../../utils/cloud': { cloud: pageCloud },
      '../../utils/request-id': loadMiniProgram('../utils/request-id.js', { wx }),
      '../../utils/vision': {},
    },
  }
  const stockForm = loadMiniProgram('../pages/item-form/item-form.js', formEnv)
  const batch = loadMiniProgram('../components/batch-form/batch-form.js', {})
  batch.setData({ expiryDate: tomorrow, quantity: '2', unit: '盒' })
  stockForm.selectComponent = () => ({ getValues: () => batch.methods.getValues.call(batch) })
  await stockForm.restore()
  assert.equal(stockForm.data.authState, 'ready')
  const stockName = 'HTTP synthetic 调味料'
  stockForm.setData({ name: stockName, unit: '盒', lowStockThreshold: '1' })
  dropResponses.add('/rpc/create_stock_atomic')
  await stockForm.onSaveTap()
  assert.equal(stockForm.data.saveUnknown, true)
  const stockRequestId = stockForm.pendingSave.p_request_id
  const stockRows = () => data(member.database.from('items').select('id').eq('name', stockName))
  const [stock] = await stockRows()
  assert.ok(stock)
  await stockForm.onSaveTap()
  assert.equal(stockForm.pendingSave, null)
  assert.equal(stockForm.data.saveComplete, true)
  assert.deepEqual(await stockRows(), [stock])
  assert.match(stockRequestId, /^[0-9a-f-]{36}$/)
  assert.equal((await data(member.database.from('batches').select('id').eq('item_id', stock.id))).length, 1)
  assert.deepEqual(await data(other.database.from('items').select('id').eq('id', stock.id)), [])
  assert.equal(await rpc(member, 'set_stock_deleted', { p_item_id: stock.id, p_batch_id: null, p_deleted: true }), 'ok')
  assert.equal(await rpc(member, 'set_stock_deleted', { p_item_id: stock.id, p_batch_id: null, p_deleted: false }), 'ok')

  const planForm = loadMiniProgram('../pages/plan-form/plan-form.js', formEnv)
  await planForm.restore()
  assert.equal(planForm.data.authState, 'ready')
  const populate = (time) => planForm.setData({
    memberIndex: planForm.data.members.findIndex(({ id }) => id === 2),
    medicineIndex: planForm.data.medicines.findIndex(({ id }) => id === 1),
    startDate: tomorrow, endDate: tomorrow, timeList: [time],
  })
  const readPlans = async (time) => (await data(member.database.from('medication_plans').select('id,times').eq('member_id', 2)))
    .filter((row) => row.times.includes(time))
  populate('16:20')
  await planForm.checkSelection()
  assert.equal(planForm.data.conflictState, 'ready')
  dropResponses.add('/rpc/save_med_plan_atomic')
  await planForm.onSave()
  assert.equal(planForm.data.saveUnconfirmed, true)
  const [plan] = await readPlans('16:20')
  assert.ok(plan)
  await planForm.onSave()
  assert.deepEqual(await readPlans('16:20'), [plan])
  assert.ok(actions.includes('计划已保存'))
  const [dose] = await data(member.database.from('medication_doses').select('id,status').eq('plan_id', plan.id))
  assert.equal(dose.status, 'pending')
  assert.equal(await rpc(member, 'transition_dose', { p_dose_id: dose.id, p_target_status: 'taken' }), 'ok')
  assert.equal(await rpc(member, 'cancel_plan_atomic', { p_plan_id: plan.id }), 'ok')
  assert.deepEqual(await data(member.database.from('medication_doses').select('id,status').eq('id', dose.id)),
    [{ id: dose.id, status: 'taken' }])
  populate('17:40')
  dropResponses.add('/rpc/save_med_plan_atomic')
  await planForm.onSave()
  assert.equal(planForm.data.saveUnconfirmed, true)
  activeClient = owner
  app.sessionVersion += 1
  await planForm.onSave()
  assert.equal(planForm.data.authState, 'unavailable')
  assert.match(planForm.data.loadError, /原账号/)
  assert.equal((await readPlans('17:40')).length, 1)
  assert.equal(await rpc(member, 'leave_household', {}), 'ok')
  assert.deepEqual(await data(member.database.from('items').select('id').eq('id', stock.id)), [])
  assert.equal(await rpc(member, 'join_household', { p_code: 'TEST-A' }), 'ok')
  assert.deepEqual(await data(member.database.from('items').select('id').eq('id', stock.id)), [{ id: stock.id }])
  console.log('PASS: actual stock and medication form handlers through HTTP, committed-response-loss recovery and session fencing')
} catch (error) {
  if (logs) console.error(logs)
  throw error
} finally {
  if (rest.exitCode === null) rest.kill()
  await closed
}
