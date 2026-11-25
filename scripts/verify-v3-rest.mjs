import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
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

function client(actor) {
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
          .then(async (response) => options.success({
            statusCode: response.status, header: Object.fromEntries(response.headers), data: await response.text(),
          }))
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

try {
  let ready = false
  for (let attempt = 0; attempt < 100 && !ready; attempt++) {
    if (serverError || rest.exitCode !== null) throw serverError || new Error(`PostgREST startup exit ${rest.exitCode}`)
    try { ready = (await fetch(endpoint, { signal: AbortSignal.timeout(500) })).ok } catch {}
    if (!ready) await delay(100)
  }
  assert.ok(ready, 'PostgREST did not expose its schema')

  const member = client('member-a')
  const other = client('owner-b')
  for (const [cloud, actor] of [[member, 'member-a'], [other, 'owner-b']]) {
    await data(cloud.auth.signInWithWechat('synthetic-code', 'synthetic-app'))
    assert.equal((await data(cloud.auth.getSession())).user.id, actor)
  }
  const own = await data(member.database.from('members').select('id,household_id,households(id)').eq('owner_id', 'member-a').is('left_at', null))
  assert.deepEqual(own, [{ id: 2, household_id: 1, households: { id: 1 } }])

  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10)
  const rpc = (cloud, name, args) => data(cloud.database.rpc(name, args))
  const intake = {
    p_request_id: randomUUID(), p_item: { household_id: 1, name: 'HTTP synthetic stock', category: 'food', unit: '盒' },
    p_first_batch: { expiry_date: tomorrow, production_date: null, quantity: 2, unit: '盒', location_id: null },
  }
  const stock = await rpc(member, 'create_stock_atomic', intake)
  assert.equal(stock.ok, true)
  assert.deepEqual(await rpc(member, 'create_stock_atomic', intake), stock)
  assert.deepEqual(await data(other.database.from('items').select('id').eq('id', stock.item_id)), [])
  assert.equal(await rpc(member, 'set_stock_deleted', { p_item_id: stock.item_id, p_batch_id: null, p_deleted: true }), 'ok')
  assert.equal(await rpc(member, 'set_stock_deleted', { p_item_id: stock.item_id, p_batch_id: null, p_deleted: false }), 'ok')

  const planArgs = {
    p_plan_id: null, p_request_id: randomUUID(), p_expected_updated_at: null,
    p_fields: { item_id: 1, member_id: 2, times: ['08:00'], freq: 'daily', start_date: tomorrow,
      end_date: tomorrow, miss_threshold_minutes: 30 },
    p_rows: [{ scheduled_at: `${tomorrow}T08:00:00.000Z` }],
  }
  const plan = await rpc(member, 'save_med_plan_atomic', planArgs)
  assert.equal(plan.ok, true)
  assert.deepEqual(await rpc(member, 'save_med_plan_atomic', planArgs), plan)
  const [dose] = await data(member.database.from('medication_doses').select('id,status').eq('plan_id', plan.plan_id))
  assert.equal(dose.status, 'pending')
  assert.equal(await rpc(member, 'transition_dose', { p_dose_id: dose.id, p_target_status: 'taken' }), 'ok')
  assert.equal(await rpc(member, 'cancel_plan_atomic', { p_plan_id: plan.plan_id }), 'ok')
  assert.deepEqual(await data(member.database.from('medication_doses').select('id,status').eq('id', dose.id)),
    [{ id: dose.id, status: 'taken' }])
  assert.equal(await rpc(member, 'leave_household', {}), 'ok')
  assert.deepEqual(await data(member.database.from('items').select('id').eq('id', stock.item_id)), [])
  assert.equal(await rpc(member, 'join_household', { p_code: 'TEST-A' }), 'ok')
  assert.deepEqual(await data(member.database.from('items').select('id').eq('id', stock.item_id)), [{ id: stock.item_id }])
  console.log('PASS: Mini Program SDK over HTTP, PostgREST role and RLS, nullable RPC arguments, retry and scalar results')
} catch (error) {
  if (logs) console.error(logs)
  throw error
} finally {
  if (rest.exitCode === null) rest.kill()
  await closed
}
