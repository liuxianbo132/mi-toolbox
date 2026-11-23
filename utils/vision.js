// 拍照识别（视觉录入）：chooseMedia → base64 → 云服务 LLM 视觉模型 → 结构化字段
// 失败契约：任何异常返回 { error: '提示文案' }，表单保留手动输入，不阻断主流程
const { cloud } = require('./cloud')

// 原生多模态、视觉理解专长、成本最低档；如需更准可换 hy4std / deep-model
const VISION_MODEL = 'glm-5.3-flash'

const PROMPT = [
  '你是家庭物品识别助手。识别图片中的商品或物品，只输出一个 JSON 对象（不要 markdown 代码块、不要任何多余文字）：',
  '{"name":"物品名称（简短，品牌+品类即可，如 蒙牛纯牛奶）","category":"food|medicine|daily|other 四选一","shelfLifeDays":整数或null,"productionDate":"YYYY-MM-DD 或 null"}',
  'category 判断：食品饮料=food；药品/保健品=medicine；洗护清洁纸品等日用品=daily；无法归类=other。',
  'shelfLifeDays：包装印「保质期 X 天」填 X；印「X 个月」换算为 30×X；印「保质期至 YYYY-MM-DD」且能看到生产日期则换算天数；无法判断填 null。',
  'productionDate：包装上的生产日期；看不到就填 null。',
].join('\n')

function chooseImage() {
  return new Promise(function (resolve) {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['camera', 'album'],
      sizeType: ['compressed'],
      success: function (res) {
        const f = res && res.tempFiles && res.tempFiles[0]
        resolve(f ? f.tempFilePath : '')
      },
      fail: function () {
        resolve('') // 取消/无权限：按取消处理，不提示
      },
    })
  })
}

function readBase64(filePath) {
  return new Promise(function (resolve) {
    wx.getFileSystemManager().readFile({
      filePath: filePath,
      encoding: 'base64',
      success: function (res) {
        resolve(res.data || '')
      },
      fail: function () {
        resolve('')
      },
    })
  })
}

// 流式累积识别文本；手动迭代 AsyncIterable（不使用 for-await 语法糖，兼容小程序编译）
async function chatVision(base64) {
  const stream = cloud.llm.chat.completions.create({
    model: VISION_MODEL,
    stream: true,
    temperature: 0.1,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: PROMPT },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + base64 } },
        ],
      },
    ],
  })
  let text = ''
  const iter = typeof stream[Symbol.asyncIterator] === 'function' ? stream[Symbol.asyncIterator]() : stream
  let step = await iter.next()
  while (!step.done) {
    const chunk = step.value
    const choice = chunk && chunk.choices && chunk.choices[0]
    const delta = choice && choice.delta
    if (delta && delta.content) text += delta.content
    step = await iter.next()
  }
  return text
}

function extractJSON(text) {
  if (!text) return null
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch (e) {
    return null
  }
}

function isValidProductionDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parts = value.split('-').map(Number)
  const year = parts[0]
  const month = parts[1]
  const day = parts[2]
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return false
  const now = new Date()
  const today = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-')
  return year >= 1900 && value <= today
}

// 模型输出不可信：逐字段白名单/类型/范围校验，非法一律置 null（由用户手动填写）
function sanitize(data) {
  const out = { name: null, category: null, shelfLifeDays: null, productionDate: null }
  if (!data || typeof data !== 'object') return out
  if (typeof data.name === 'string') {
    const n = data.name.trim().slice(0, 40)
    if (n) out.name = n
  }
  const CATS = ['food', 'medicine', 'daily', 'other']
  if (typeof data.category === 'string' && CATS.indexOf(data.category) >= 0) out.category = data.category
  const rawDays = data.shelfLifeDays
  if (typeof rawDays === 'number' || (typeof rawDays === 'string' && /^\d+$/.test(rawDays.trim()))) {
    const days = Number(rawDays)
    if (isFinite(days) && Math.floor(days) === days && days >= 1 && days <= 3650) {
      out.shelfLifeDays = days
    }
  }
  if (typeof data.productionDate === 'string' && isValidProductionDate(data.productionDate)) {
    out.productionDate = data.productionDate
  }
  return out
}

// 流式请求不设超时会一直挂着 loading；30 秒兜底（底层请求无法真正取消，只保证 UI 可恢复）
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise(function (resolve, reject) {
      setTimeout(function () {
        reject(new Error('识别超时'))
      }, ms)
    }),
  ])
}

// 返回 { data: {name, category, shelfLifeDays, productionDate} } | { error: '文案' } | { error: '' }（用户取消）
async function recognizeFromImage() {
  try {
    const path = await chooseImage()
    if (!path) return { error: '' }
    const base64 = await readBase64(path)
    if (!base64) return { error: '图片读取失败，请手动填写' }
    if (base64.length > 8 * 1024 * 1024) return { error: '图片过大，请重新拍摄' }
    const text = await withTimeout(chatVision(base64), 30000)
    const obj = extractJSON(text)
    if (!obj) return { error: '识别结果无法解析，请手动填写' }
    return { data: sanitize(obj) }
  } catch (e) {
    console.warn('[vision] recognize failed:', e)
    if (e && e.message === '识别超时') return { error: '识别超时，请手动填写' }
    return { error: '识别失败，请手动填写' }
  }
}

module.exports = { recognizeFromImage, VISION_MODEL }
