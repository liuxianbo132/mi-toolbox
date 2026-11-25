import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

// Run with the installed PGlite package path. The database is in memory and uses synthetic actors only.
const require = createRequire(import.meta.url)
const native = process.argv[2] === '--native'
let db
let openPeer
let fixtureDatabase
if (native) {
  const { Client, types } = require(resolve(process.argv[3]))
  const port = Number(process.argv[4])
  assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535)
  types.setTypeParser(20, Number) // Fixture IDs are small.
  const config = { host: '127.0.0.1', port, user: 'mi_v3_test', database: 'postgres', connectionTimeoutMillis: 3000 }
  const database = `mi_v3_${randomUUID().replaceAll('-', '')}`
  fixtureDatabase = database
  const admin = new Client(config)
  await admin.connect()
  try {
    await admin.query(`CREATE DATABASE ${database}`)
  } finally {
    await admin.end()
  }
  openPeer = async () => {
    const client = new Client({ ...config, database, statement_timeout: 10000 })
    await client.connect()
    const query = (sql, params) => client.query(sql, params?.map((p) => p && typeof p === 'object' ? JSON.stringify(p) : p))
    return { exec: (sql) => query(sql), query, close: () => client.end() }
  }
  db = await openPeer()
} else {
  const { PGlite } = require(process.argv[2] ? resolve(process.argv[2]) : '@electric-sql/pglite')
  db = new PGlite()
}
const execute = (sql, params) => db.query(sql, params)
const one = async (sql, params) => (await execute(sql, params)).rows[0].value
const actor = async (id, connection = db) => {
  await connection.exec('RESET ROLE')
  await connection.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [id])
  await connection.exec('SET ROLE authenticated')
}

try {
  await db.exec(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
    END $$;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS text LANGUAGE sql STABLE AS $$
      SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')
    $$;
    GRANT USAGE ON SCHEMA auth TO anon, authenticated;
    SET check_function_bodies TO off;
  `)
  const migrations = ['08-medication-transactions', '09-household-stock-integrity', '10-membership-history', '11-stock-intake-transaction']
  for (const file of ['02-base-schema', '01-rpc-household', '03-m2-schema', '05-security-hardening', '06-soft-delete',
    '07-medication-safety', ...migrations]) {
    await db.exec(await readFile(new URL(`../sql/${file}.sql`, import.meta.url), 'utf8'))
  }
  await db.exec('SET check_function_bodies TO on')
  // The second run validates the migration bodies with every baseline dependency already installed.
  for (const file of migrations) {
    await db.exec(await readFile(new URL(`../sql/${file}.sql`, import.meta.url), 'utf8'))
  }
  await db.exec(`
    INSERT INTO public.households (owner_id, name, invite_code) VALUES
      ('owner-a', 'Fixture A', 'TEST-A'), ('owner-b', 'Fixture B', 'TEST-B');
    INSERT INTO public.members (household_id, owner_id, role) VALUES
      (1, 'owner-a', 'owner'), (1, 'member-a', 'member'), (2, 'owner-b', 'owner');
    INSERT INTO public.items (household_id, name, category) VALUES
      (1, 'Fixture medicine', 'medicine'), (1, 'Fixture stock', 'food'), (2, 'Other stock', 'food');
    INSERT INTO public.batches (household_id, item_id, expiry_date, owner_id) VALUES
      (1, 2, CURRENT_DATE + 30, 'owner-a'), (1, 2, CURRENT_DATE + 30, 'owner-a'),
      (1, 1, CURRENT_DATE + 30, 'owner-a');
  `)

  const future = new Date(Date.now() + 3 * 86400000)
  future.setUTCHours(8, 0, 0, 0)
  const later = new Date(future.getTime() + 3600000)
  const day = future.toISOString().slice(0, 10)
  const payload = { item_id: 1, member_id: 2, times: ['08:00', '09:00'], freq: 'daily', start_date: day,
    end_date: day, miss_threshold_minutes: 30 }
  const slots = [future, later].map((time) => ({ scheduled_at: time.toISOString() }))
  const requestId = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`
  const save = (number, fields, rows, planId = null, version = null) => one(
    'SELECT save_med_plan_atomic($1, $2, $3, $4, $5) AS value', [planId, requestId(number), fields, rows, version])

  await actor('member-a')
  assert.equal(await one('SELECT has_table_privilege(current_user, \'public.members\', \'DELETE\') AS value'), false)
  assert.equal(await one('SELECT has_table_privilege(current_user, \'public.medication_doses\', \'UPDATE\') AS value'), false)
  assert.equal(await one('SELECT count(*)::int AS value FROM items'), 2)
  assert.equal((await execute("UPDATE members SET nickname = 'Fixture' WHERE id = 2 RETURNING id")).rows.length, 1)

  await execute("INSERT INTO allergies (household_id, member_id, allergen) VALUES (1, 2, ' Fixture allergen ')")
  await execute("INSERT INTO drug_allergy_links (household_id, item_id, allergen, kind) VALUES (1, 1, 'Fixture allergen', 'forbidden')")
  assert.equal((await save(1, payload, slots)).error, 'forbidden_allergy')
  await execute('DELETE FROM allergies WHERE member_id = 2')
  const saved = await save(2, payload, slots)
  assert.equal(saved.ok, true)
  assert.deepEqual(await save(2, payload, slots), saved)
  assert.equal((await save(2, { ...payload, freq: 'alternate_day' }, slots)).error, 'request_conflict')
  assert.equal(await one('SELECT count(*)::int AS value FROM medication_plans'), 1)
  assert.equal(await one('SELECT count(*)::int AS value FROM medication_doses'), 2)
  assert.equal(await one('SELECT set_stock_deleted(p_item_id => 1, p_deleted => true) AS value'), 'referenced')
  await assert.rejects(execute("UPDATE items SET category = 'food' WHERE id = 1"), { code: '23514' })
  const takenId = await one('SELECT min(id) AS value FROM medication_doses')

  await execute("INSERT INTO allergies (household_id, member_id, allergen) VALUES (1, 2, 'Fixture allergen')")
  assert.equal(await one("SELECT transition_dose($1, 'taken') AS value", [takenId]), 'forbidden_allergy')
  await execute('DELETE FROM allergies WHERE member_id = 2')
  assert.equal(await one("SELECT transition_dose($1, 'taken') AS value", [takenId]), 'ok')
  const confirmed = await one('SELECT confirmed_at::text AS value FROM medication_doses WHERE id = $1', [takenId])
  assert.equal(await one("SELECT transition_dose($1, 'taken') AS value", [takenId]), 'ok')
  assert.equal(await one('SELECT confirmed_at::text AS value FROM medication_doses WHERE id = $1', [takenId]), confirmed)

  const version = await one('SELECT updated_at::text AS value FROM medication_plans')
  assert.equal((await save(3, payload, slots, saved.plan_id, version)).ok, true)
  assert.equal((await save(4, payload, slots, saved.plan_id, version)).error, 'schedule_changed')
  assert.equal(await one('SELECT cancel_plan_atomic($1) AS value', [saved.plan_id]), 'ok')
  assert.equal(await one('SELECT cancel_plan_atomic($1) AS value', [saved.plan_id]), 'ok')
  assert.equal(await one('SELECT count(*)::int AS value FROM medication_doses'), 1)
  assert.equal(await one("SELECT transition_dose($1, 'missed') AS value", [takenId]), 'ok')

  assert.equal(await one('SELECT set_stock_deleted(p_batch_id => 1, p_deleted => true) AS value'), 'ok')
  assert.equal(await one('SELECT set_stock_deleted(p_item_id => 2, p_deleted => true) AS value'), 'ok')
  assert.equal(await one('SELECT set_stock_deleted(p_batch_id => 2, p_deleted => false) AS value'), 'inactive_item')
  assert.equal(await one('SELECT set_stock_deleted(p_item_id => 2, p_deleted => false) AS value'), 'ok')
  assert.equal(await one('SELECT is_deleted AS value FROM batches WHERE id = 1'), true)
  assert.equal(await one('SELECT is_deleted AS value FROM batches WHERE id = 2'), false)
  assert.equal(await one('SELECT purge_stock_deleted(p_batch_id => 2) AS value'), 'not_in_trash')
  assert.equal(await one('SELECT set_stock_deleted(p_item_id => 1, p_deleted => true) AS value'), 'ok')
  assert.equal(await one('SELECT purge_stock_deleted(p_item_id => 1) AS value'), 'referenced')
  assert.equal(await one('SELECT count(*)::int AS value FROM batches WHERE item_id = 1'), 1)
  await assert.rejects(execute("INSERT INTO batches (household_id, item_id, expiry_date, quantity) VALUES (1, 2, CURRENT_DATE, -1)"), { code: '23514' })
  await execute("INSERT INTO batches (household_id, item_id, expiry_date, quantity) VALUES (1, 2, CURRENT_DATE, 2)")
  await execute("UPDATE batches SET opened_at = now(), status = 'used' WHERE id = 2")
  await assert.rejects(execute("UPDATE batches SET status = 'active' WHERE id = 2"), { code: '23514' })
  await assert.rejects(execute('UPDATE batches SET opened_at = NULL WHERE id = 2'), { code: '23514' })

  assert.equal(await one('SELECT set_stock_deleted(p_item_id => 1, p_deleted => false) AS value'), 'ok')
  const active = await save(5, payload, slots)
  assert.equal(active.ok, true)
  assert.equal(await one('SELECT remove_member(2) AS value'), 'forbidden')
  assert.equal(await one('SELECT leave_household() AS value'), 'ok')
  assert.equal(await one('SELECT count(*)::int AS value FROM items'), 0)
  assert.equal(await one('SELECT count(*)::int AS value FROM members'), 0)

  await actor('owner-a')
  assert.equal(await one("SELECT status AS value FROM medication_plans WHERE id = $1", [active.plan_id]), 'cancelled')
  assert.equal(await one('SELECT count(*)::int AS value FROM medication_doses WHERE plan_id = $1', [active.plan_id]), 0)
  assert.equal(await one('SELECT count(*)::int AS value FROM medication_doses WHERE plan_id = $1', [saved.plan_id]), 1)
  assert.equal((await save(6, payload, slots)).error, 'invalid_plan_target')
  assert.equal(await one('SELECT leave_household() AS value'), 'owner_cannot_leave')

  await actor('member-a')
  assert.equal(await one("SELECT join_household(' test-a ') AS value"), 'ok')
  assert.equal(await one("SELECT create_household('Fixture C') AS value"), 'already_joined')
  assert.equal(await one("SELECT id AS value FROM members WHERE owner_id = 'member-a'"), 2)

  const item = { household_id: 1, name: 'Fixture intake', category: 'food', unit: '盒', low_stock_threshold: 2, pao_days: 7 }
  const firstBatch = { expiry_date: day, production_date: null, quantity: 3, unit: '盒', location_id: null }
  const intake = (number, itemFields, batchFields) => one('SELECT create_stock_atomic($1, $2, $3) AS value',
    [requestId(number), itemFields, batchFields])
  assert.equal((await intake(10, item, { ...firstBatch, quantity: 0 })).error, 'invalid_stock')
  assert.equal((await intake(10, item, { ...firstBatch, location_id: 999 })).error, 'invalid_location')
  assert.equal(await one("SELECT count(*)::int AS value FROM items WHERE name = 'Fixture intake'"), 0)
  const intakeResult = await intake(10, item, firstBatch)
  assert.equal(intakeResult.ok, true)
  assert.deepEqual(await intake(10, item, firstBatch), intakeResult)
  assert.equal((await intake(10, item, { ...firstBatch, quantity: 4 })).error, 'request_conflict')
  assert.equal(await one('SELECT count(*)::int AS value FROM batches WHERE item_id = $1', [intakeResult.item_id]), 1)
  assert.equal(await one('SELECT count(*)::int AS value FROM records WHERE batch_id = $1 AND action = \'create\'', [intakeResult.batch_id]), 1)
  assert.equal(await one('SELECT has_column_privilege(current_user, \'public.items\', \'name\', \'INSERT\') AS value'), false)
  assert.equal(await one('SELECT set_stock_deleted(p_item_id => $1, p_deleted => true) AS value', [intakeResult.item_id]), 'ok')
  assert.equal(await one('SELECT purge_stock_deleted(p_item_id => $1) AS value', [intakeResult.item_id]), 'ok')

  await actor('owner-b')
  assert.equal(await one('SELECT count(*)::int AS value FROM items'), 1)
  assert.equal(await one('SELECT count(*)::int AS value FROM medication_doses'), 0)
  assert.equal(await one("SELECT transition_dose($1, 'taken') AS value", [takenId]), 'not_found')
  assert.equal(await one('SELECT set_stock_deleted(p_item_id => 2, p_deleted => true) AS value'), 'not_found')

  await db.exec('RESET ROLE')
  const cronSource = await readFile(new URL('../sql/04-cron-jobs.sql', import.meta.url), 'utf8')
  const cronSql = cronSource.split('$task$')[1]
  assert.ok(cronSql.startsWith('UPDATE public.medication_doses'))
  await db.exec('BEGIN')
  try {
    const offsets = [31, 30, 29]
    for (const minutes of offsets) {
      await execute(`INSERT INTO public.medication_doses (household_id, plan_id, scheduled_at, status)
        VALUES (1, $1, now() - $2::int * interval '1 minute', 'pending')`, [saved.plan_id, minutes])
    }
    await execute(cronSql)
    const { rows } = await execute(`SELECT status FROM medication_doses
      WHERE plan_id = $1 AND scheduled_at <= now() ORDER BY scheduled_at`, [saved.plan_id])
    assert.deepEqual(rows.map(({ status }) => status), ['missed', 'pending', 'pending'])
    console.log('PASS: checked-in overdue statement preserves the start-of-threshold boundary')
  } finally {
    await db.exec('ROLLBACK')
  }

  if (native) {
    const peer = await openPeer()
    async function competingQuery(sql, firstArgs, secondArgs, check) {
      const peerPid = (await peer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      await db.exec('BEGIN')
      let second
      let committed = false
      try {
        const initial = await one(sql, firstArgs)
        assert.equal(initial.ok, true)
        second = peer.query(sql, secondArgs).then((res) => res.rows[0].value, (error) => error)
        let blocked = false
        for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
          blocked = await one('SELECT pg_backend_pid() = ANY(pg_blocking_pids($1)) AS value', [peerPid])
          if (!blocked) await delay(25)
        }
        assert.ok(blocked, 'second backend must wait on the first transaction')
        await db.exec('COMMIT')
        committed = true
        check(initial, await second)
      } finally {
        if (!committed) await db.exec('ROLLBACK')
        await second
      }
    }
    try {
      await actor('member-a')
      await actor('member-a', peer)
      const concurrentItem = { ...item, name: 'Concurrent fixture intake' }
      const stockArgs = [requestId(20), concurrentItem, firstBatch]
      await competingQuery('SELECT create_stock_atomic($1, $2, $3) AS value', stockArgs, stockArgs, assert.deepEqual)
      assert.equal(await one("SELECT count(*)::int AS value FROM items WHERE name = 'Concurrent fixture intake'"), 1)

      const plan = await save(21, payload, slots)
      const revision = await one('SELECT updated_at::text AS value FROM medication_plans WHERE id = $1', [plan.plan_id])
      await competingQuery('SELECT save_med_plan_atomic($1, $2, $3, $4, $5) AS value',
        [plan.plan_id, requestId(22), payload, slots, revision],
        [plan.plan_id, requestId(23), payload, slots, revision],
        (_, result) => assert.equal(result.error, 'schedule_changed'))
      assert.equal(await one('SELECT count(*)::int AS value FROM medication_doses WHERE plan_id = $1', [plan.plan_id]), 2)
      console.log('PASS: two real backend connections, idempotent intake and competing schedule revision')
    } finally {
      await peer.close()
    }
  }

  console.log('PASS: migration rerun, household access/leave/rejoin, medication guards/retry/history, stock intake/retry/trash/transitions')
  if (fixtureDatabase) console.log(`FIXTURE_DATABASE=${fixtureDatabase}`)
} finally {
  await db.close()
}
