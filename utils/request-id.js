function makeRequestId() {
  return new Promise((resolve, reject) => {
    if (typeof wx.getRandomValues !== 'function') {
      reject(new Error('Random source unavailable'))
      return
    }
    wx.getRandomValues({
      length: 16,
      success(res) {
        const bytes = new Uint8Array(res.randomValues)
        if (bytes.length !== 16) {
          reject(new Error('Random source returned insufficient bytes'))
          return
        }
        bytes[6] = (bytes[6] & 0x0f) | 0x40
        bytes[8] = (bytes[8] & 0x3f) | 0x80
        const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
        resolve([hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-'))
      },
      fail: reject,
    })
  })
}

module.exports = { makeRequestId }
