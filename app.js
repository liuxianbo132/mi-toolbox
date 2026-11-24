const { cloud } = require('./utils/cloud')

App({
  sessionPromise: null,
  globalData: {
    largeText: wx.getStorageSync('mi_large_text_v1') === 'large',
    myNickname: '',
  },

  setLargeText(enabled) {
    this.globalData.largeText = !!enabled
    wx.setStorageSync('mi_large_text_v1', enabled ? 'large' : 'standard')
  },

  ensureSession() {
    if (!this.sessionPromise) {
      this.sessionPromise = cloud.auth.getSession().then((res) => {
        // 昵称仅用于写入快照，加载失败不影响会话本身，故不 await
        if (res && res.data) this.loadMyNickname()
        return res
      })
    }
    return this.sessionPromise
  },

  // V3：读取本人在 members 中的家庭内昵称，写入 globalData 供 records/batches 快照使用；失败静默
  async loadMyNickname() {
    try {
      const { data: session } = await cloud.auth.getSession()
      const uid = session && session.user && session.user.id
      if (!uid) return
      const { data, error } = await cloud.database
        .from('members')
        .select('nickname')
        .eq('owner_id', uid)
        .limit(1)
      if (error) return
      const row = data && data[0]
      this.globalData.myNickname = (row && row.nickname) || ''
    } catch (e) {
      console.warn('[nickname] load failed (silent):', e)
    }
  },

  resetSession() {
    this.sessionPromise = null
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
