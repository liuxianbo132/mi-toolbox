const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

async function verify() {
  let app
  let listener
  let response
  let calls = 0
  let nicknameCalls = 0
  let resolveNickname
  const auth = {
    onAuthStateChange(fn) { listener = fn },
    getSession() { calls += 1; return response },
  }
  const membershipQuery = {
    select() { return this }, eq() { return this }, is() { return this },
    limit() {
      nicknameCalls += 1
      return new Promise((resolve) => { resolveNickname = resolve })
    },
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8'), {
    App(config) { app = config },
    wx: { getStorageSync() { return 'standard' } },
    require() { return { cloud: { auth, database: { from() { return membershipQuery } } } } },
  })
  app.onLaunch()
  const sessionA = { user: { id: 'synthetic-a' } }
  const sessionB = { user: { id: 'synthetic-b' } }
  listener('INITIAL_SESSION', sessionA)

  response = { data: null, error: null }
  const first = app.ensureSession()
  assert.equal(app.ensureSession(), first)
  assert.equal((await first).error.code, 'SESSION_UNAVAILABLE')
  assert.equal(calls, 1)

  response = { data: sessionA, error: null }
  assert.equal((await app.ensureSession()).data, sessionA)
  assert.equal(nicknameCalls, 1)
  assert.equal((await app.ensureSession()).data, sessionA)
  assert.equal(nicknameCalls, 1)

  const oldNickname = resolveNickname
  let resolveSession
  response = new Promise((resolve) => { resolveSession = resolve })
  const oldRequest = app.ensureSession()
  await Promise.resolve()
  listener('SIGNED_IN', sessionB)
  response = { data: sessionB, error: null }
  resolveSession({ data: sessionA, error: null })
  assert.equal((await oldRequest).data, sessionB)
  oldNickname({ data: [{ nickname: 'stale name' }], error: null })
  await new Promise(setImmediate)
  assert.equal(app.globalData.myNickname, '')
  resolveNickname({ data: [{ nickname: 'current name' }], error: null })
  await new Promise(setImmediate)
  assert.equal(app.globalData.myNickname, 'current name')

  listener('SIGNED_OUT', null)
  response = { data: null, error: null }
  const signedOut = await app.ensureSession()
  assert.equal(signedOut.data, null)
  assert.equal(signedOut.error, null)
  assert.equal(app.globalData.myNickname, '')
  console.log('PASS: session deduplication, transient refresh, retries, account switch and sign-out')
}

verify().catch((error) => { console.error(error); process.exitCode = 1 })
