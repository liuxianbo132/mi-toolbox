const { cloud } = require('./utils/cloud')

App({
  sessionPromise: null,
  sessionVersion: 0,
  storedUserId: '',
  nicknameUserId: '',
  globalData: {
    largeText: wx.getStorageSync('mi_large_text_v1') === 'large',
    myNickname: '',
  },

  onLaunch() {
    cloud.auth.onAuthStateChange((event, session) => {
      const uid = session && session.user && session.user.id
      this.storedUserId = uid || ''
      if (event === 'SIGNED_OUT' || event === 'SIGNED_IN') this.resetSession()
    })
    this.watchForUpdates()
  },

  watchForUpdates() {
    if (typeof wx.getUpdateManager !== 'function') return
    const updateManager = wx.getUpdateManager()
    updateManager.onUpdateReady(() => {
      wx.showModal({
        title: '小咪有新版本',
        content: '重启会关闭当前页面。请先保存正在填写的内容。',
        confirmText: '立即重启',
        cancelText: '稍后',
        success: ({ confirm }) => {
          if (confirm) updateManager.applyUpdate()
        },
      })
    })
    updateManager.onUpdateFailed(() => {
      wx.showToast({ title: '更新下载失败，请稍后重新打开小程序', icon: 'none' })
    })
  },

  setLargeText(enabled) {
    this.globalData.largeText = !!enabled
    wx.setStorageSync('mi_large_text_v1', enabled ? 'large' : 'standard')
  },

  ensureSession() {
    if (!this.sessionPromise) {
      const version = this.sessionVersion
      const request = Promise.resolve()
        .then(() => cloud.auth.getSession())
        .then((res) => {
          if (version !== this.sessionVersion) return this.ensureSession()
          if (res && res.error) return { data: null, error: res.error }
          const session = res && res.data
          const uid = session && session.user && session.user.id
          if (uid) {
            this.storedUserId = uid
            if (this.nicknameUserId !== uid) this.loadMyNickname(uid, version)
            return { data: session, error: null }
          }
          // The SDK returns null on transient refresh failure while keeping credentials.
          if (!res || session || this.storedUserId) {
            return { data: null, error: { code: 'SESSION_UNAVAILABLE', message: '暂时无法验证登录状态，请重试' } }
          }
          return { data: null, error: null }
        })
        .catch(() => ({ data: null, error: { code: 'SESSION_UNAVAILABLE', message: '暂时无法验证登录状态，请重试' } }))
        .finally(() => {
          if (this.sessionPromise === request) this.sessionPromise = null
        })
      this.sessionPromise = request
    }
    return this.sessionPromise
  },

  async loadMyNickname(uid, version) {
    this.nicknameUserId = uid
    try {
      const { data, error } = await cloud.database
        .from('members')
        .select('nickname')
        .eq('owner_id', uid)
        .is('left_at', null)
        .limit(1)
      if (version !== this.sessionVersion) return
      if (error) {
        this.nicknameUserId = ''
        return
      }
      const row = data && data[0]
      this.globalData.myNickname = (row && row.nickname) || ''
    } catch (_) {
      if (version === this.sessionVersion) this.nicknameUserId = ''
    }
  },

  resetSession() {
    this.sessionVersion += 1
    this.sessionPromise = null
    this.nicknameUserId = ''
    this.globalData.myNickname = ''
    this.globalData.pendingInventoryLowStockFilter = null
  },

  loginWithWechat() {
    return new Promise((resolve) => {
      wx.login({
        success: ({ code }) => {
          const appid = wx.getAccountInfoSync().miniProgram.appId
          cloud.auth
            .signInWithWechat(code, appid)
            .then((res) => {
              this.resetSession()
              resolve(res)
            })
            .catch(() => {
              resolve({ data: null, error: { message: '微信登录失败，请重试' } })
            })
        },
        fail: (err) => {
          console.error('[Auth] wx.login failed', JSON.stringify({ stage: 'wx.login', message: err.errMsg }))
          resolve({ data: null, error: { message: '微信登录失败，请重试' } })
        },
      })
    })
  },
})
