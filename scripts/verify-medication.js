const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { matchAllergies, indexAllergyMatches } = require('../utils/allergy')
const { toDateOnly } = require('../utils/date')
const { buildDoseTimes, courseDays } = require('../utils/plan-doses')

process.env.TZ = 'America/New_York'

const TIME = Date.parse('2026-03-08T14:00:00Z')
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [TIME])) }
  static now() { return TIME }
}

function fixturePage(name, respond, onRpc) {
  const calls = []
  const actions = []
  const cloud = {
    database: {
      from(table) {
        const call = { table, filters: {}, range: null }
        const query = {
          select() { return this },
          eq(key, value) { call.filters[key] = value; return this },
          is(key, value) { call.filters[key] = value; return this },
          in(key, value) { call.filters[key] = value; return this },
          gte(key, value) { call.filters[key + ':gte'] = value; return this },
          lt(key, value) { call.filters[key + ':lt'] = value; return this },
          order() { return this },
          limit() { return this },
          range(from, to) { call.range = [from, to]; return this },
          then(resolve, reject) {
            calls.push(call)
            return Promise.resolve().then(() => respond(call)).then(resolve, reject)
          },
        }
        return query
      },
      rpc(endpoint, args) {
        calls.push({ endpoint, args })
        return onRpc(endpoint, args)
      },
    },
  }
  const file = path.resolve(__dirname, '../pages', name, name + '.js')
  const localRequire = createRequire(file)
  let page
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    Date: FixedDate,
    require(id) {
      if (id === '../../utils/cloud') return { cloud }
      if (id === '../../utils/data-access') return { allergiesAccess: {} }
      if (id === '../../utils/request-id') return { makeRequestId: async () => '00000000-0000-4000-8000-000000000000' }
      return localRequire(id)
    },
    Page(value) { page = value },
    getApp() {
      return { globalData: {}, ensureSession: async () => ({ data: { user: { id: 'signed-in' } } }) }
    },
    wx: {
      getRandomValues({ success }) { success({ randomValues: new Uint8Array(16).buffer }) },
      navigateBack() { actions.push('back') },
      showToast({ title }) { actions.push(title) },
    },
  }, { filename: file })
  page.setData = (partial) => Object.assign(page.data, partial)
  return { page, calls, actions }
}

function result(data) { return { data, error: null } }
function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

async function testMedication() {
  let unavailable = false
  const responses = {
    members: [{ id: 7, nickname: '服药人 A' }, { id: 8, nickname: '服药人 B' }],
    items: [{ id: 23, name: '测试药品' }],
    medication_doses: [
      { id: 11, plan_id: 30, scheduled_at: '2026-03-08T12:00:00Z', status: 'pending' },
      { id: 12, plan_id: 31, scheduled_at: '2026-03-08T19:00:00Z', status: 'pending' },
      { id: 13, plan_id: 33, scheduled_at: '2026-03-08T20:00:00Z', status: 'taken' },
    ],
    medication_plans: [
      { id: 30, item_id: 23, member_id: 7, status: 'active', start_date: '2026-03-08' },
      { id: 31, item_id: 23, member_id: 8, status: 'active', start_date: '2026-03-08' },
      { id: 32, item_id: 23, member_id: 8, status: 'active', start_date: '2026-03-01', end_date: '2026-03-07' },
    ],
    allergies: [{ member_id: 7, allergen: ' 测试原 ' }],
    drug_allergy_links: [{ item_id: 23, allergen: '测试原', kind: 'forbidden' }],
  }
  const { page, calls } = fixturePage('medication', ({ table }) => {
    if (unavailable && table === 'allergies') return { error: 'offline' }
    return result(responses[table])
  }, async () => { throw new Error('request timed out') })
  page.setData({ householdId: 1 })
  await page.loadAll(1)
  const doseQuery = calls.find((c) => c.table === 'medication_doses')
  assert.equal(doseQuery.filters['scheduled_at:gte'], '2026-03-08T05:00:00.000Z')
  assert.equal(doseQuery.filters['scheduled_at:lt'], '2026-03-09T04:00:00.000Z')
  assert.equal(page.data.timeline[0].canConfirm, false)
  assert.equal(page.data.timeline[1].canConfirm, true)
  assert.equal(page.data.timeline[2].conflictKind, 'unknown')
  assert.equal(page.data.progress.taken, 1)
  assert.equal(page.data.activePlans.length, 2)
  assert.equal(page.data.historyPlans[0].statusLabel, '疗程已到期')
  await page.transitionDose(11, 'taken')
  await page.transitionDose(99, 'taken')
  assert.equal(calls.filter((c) => c.endpoint).length, 0)
  const attempt = page.transitionDose(12, 'taken')
  await page.transitionDose(12, 'taken')
  await attempt
  assert.equal(calls.filter((c) => c.endpoint).length, 1)
  assert.equal(calls.find((c) => c.endpoint).endpoint, 'transition_dose')
  assert.equal(page.data.doseBusyId, null)
  unavailable = true
  await page.loadAll(1)
  assert.equal(page.data.allergyState, 'error')
  assert.equal(page.data.timeline[1].canConfirm, false)
}

async function testPlan() {
  const older = deferred()
  let sendCount = 0
  const { page, calls, actions } = fixturePage('plan-form', ({ table, filters }) => {
    if (table === 'allergies' && filters.member_id === 7) return older.promise
    if (table === 'allergies') return result([])
    return result([{ allergen: '测试原', kind: 'forbidden' }])
  }, async (_endpoint, args) => {
    sendCount++
    assert.match(args.p_request_id, /^[a-f0-9-]{14}4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
    if (sendCount === 1) throw new Error('request timed out')
    return result({ ok: true, plan_id: 34 })
  })
  page.setData({
    authState: 'ready',
    householdId: 1,
    members: [{ id: 7 }, { id: 8 }],
    medicines: [{ id: 23 }],
    memberIndex: 0,
    medicineIndex: 0,
    startDate: '2026-03-08',
    endDate: '2026-03-08',
    timeList: ['08:00'],
  })
  const slow = page.checkSelection()
  assert.equal(page.data.conflictState, 'loading')
  assert.match(page.validatePlan(), /请先核对/)
  page.setData({ memberIndex: 1 })
  await page.checkSelection()
  older.resolve(result([{ allergen: '测试原' }]))
  await slow
  assert.equal(page.data.hitsWorst, '')
  assert.equal(page.validatePlan(), '')
  assert.equal(calls.filter((c) => c.table === 'allergies').length, 2)
  page.setData({ hitsWorst: 'forbidden' })
  await page.onSave()
  assert.equal(sendCount, 0)
  page.setData({ hitsWorst: '', timeList: ['08:00', '08:00'] })
  assert.match(page.validatePlan(), /不能重复/)
  page.setData({ timeList: ['08:00'], endDate: '2026-09-04' })
  assert.match(page.validatePlan(), /180/)
  page.setData({ endDate: '2026-03-08' })
  page.setData({ timeList: ['02:30'] })
  await page.onSave()
  assert.equal(sendCount, 0)
  assert.match(page.data.saveError, /2026-03-08 02:30.*不存在/)
  page.setData({ timeList: ['08:00'] })

  const firstSave = page.onSave()
  await page.onSave()
  await firstSave
  assert.equal(sendCount, 1)
  assert.equal(page.data.saveUnconfirmed, true)
  await page.onSave()
  assert.equal(sendCount, 2)
  const [first, second] = calls.filter((c) => c.endpoint)
  assert.equal(first.endpoint, 'save_med_plan_atomic')
  assert.equal(first.args, second.args)
  assert.equal(first.args.p_fields.member_id, 8)
  assert.equal(first.args.p_rows[0].scheduled_at, '2026-03-08T12:00:00.000Z')
  assert.ok(actions.includes('back'))
}

async function testAllergyAccess() {
  const { page, calls } = fixturePage('allergy', ({ table, filters }) => {
    assert.equal(table, 'members')
    if (filters.owner_id) return result([{ id: 7, household_id: 1, role: 'member', nickname: '服药人 A' }])
    throw new Error('A standard member must not query someone else’s chart')
  })
  page.requestedMemberId = 8
  await page.restore()
  assert.equal(page.data.authState, 'forbidden')
  assert.equal(calls.length, 1)
}

function testLocalSchedule() {
  const startDate = '2026-11-01'
  const options = { startDate, endDate: startDate, now: new Date('2026-11-01T12:00:00Z') }
  assert.throws(() => buildDoseTimes({ ...options, times: ['01:30'] }), /2026-11-01 01:30.*出现两次/)
  assert.deepEqual(buildDoseTimes({ ...options, times: ['08:00', '02:30'] }), [
    '2026-11-01T07:30:00.000Z', '2026-11-01T13:00:00.000Z',
  ])
  assert.equal(courseDays('2026-03-07', '2026-03-09'), 2)
  assert.ok(Number.isNaN(courseDays('2026-02-30', '2026-03-01')))
  assert.deepEqual(buildDoseTimes({
    startDate: '2026-03-07', endDate: '2026-03-10', now: new FixedDate(), times: ['02:30'], freq: 'alternate_day',
  }), ['2026-03-09T06:30:00.000Z'])
}

async function testAdherence() {
  const today = toDateOnly(new FixedDate())
  const { page, calls } = fixturePage('adherence', ({ table, filters, range }) => {
    if (table === 'medication_plans') {
      assert.equal(filters.member_id, 7)
      return result([{ id: 30, item_id: 23 }])
    }
    if (table === 'items') return result([{ id: 23, name: '测试药品' }])
    assert.ok(filters.plan_id.includes(30))
    const count = range[0] === 0 ? 500 : 2
    return result(Array.from({ length: count }, (_, i) => ({
      id: range[0] + i + 1,
      plan_id: 30,
      scheduled_at: today + 'T16:00:00Z',
      status: range[0] === 0 ? 'taken' : 'missed',
    })))
  })
  await page.loadData(1, 7)
  assert.equal(calls.filter((c) => c.table === 'medication_doses').length, 2)
  assert.equal(page.data.taken, 500)
  assert.equal(page.data.missed, 2)
  assert.equal(page.data.missedList[0].name, '测试药品')
}

async function main() {
  assert.equal(matchAllergies(['测试原'], [{ allergen: 'constructor', kind: 'forbidden' }]).length, 0)
  const matches = indexAllergyMatches([{ member_id: 7, allergen: ' 测试原 ' }], [
    { item_id: 23, allergen: '测试原', kind: 'caution' },
    { item_id: 23, allergen: '测试原', kind: 'forbidden' },
  ])
  assert.equal(matches.get('23|7'), 'forbidden')
  assert.equal(matches.get('23|8'), undefined)
  await testMedication()
  await testPlan()
  testLocalSchedule()
  await testAllergyAccess()
  await testAdherence()
  console.log('PASS 6 / FAIL 0 (allergy matching, medication, plan save, local schedule, chart access, adherence)')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
