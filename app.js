const { cloud } = require('./utils/cloud')

App({
  sessionPromise: null,

  ensureSession() {
    if (!this.sessionPromise) {
      this.sessionPromise = cloud.auth.getSession()
    }
    return this.sessionPromise
  },

  resetSession() {
    this.sessionPromise = null
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
