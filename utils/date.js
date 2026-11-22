// 日期与临期工具：到期日换算、剩余天数、临期分级

function toDateOnly(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

// 生产日期 + 保质期天数 → 到期日（国内包装只印生产日期与保质期；生产当天计第 1 天）
function calcExpiry(productionDateStr, shelfLifeDays) {
  if (!productionDateStr || !shelfLifeDays) return ''
  const p = new Date(productionDateStr.replace(/-/g, '/'))
  if (isNaN(p.getTime())) return ''
  p.setDate(p.getDate() + Number(shelfLifeDays) - 1)
  return toDateOnly(p)
}

// 距到期日还有几天（负数 = 已过期）
function daysUntil(dateStr) {
  if (!dateStr) return 9999
  const target = new Date(dateStr.replace(/-/g, '/'))
  if (isNaN(target.getTime())) return 9999
  const now = new Date()
  const a = new Date(target.getFullYear(), target.getMonth(), target.getDate())
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  return Math.round((a - b) / 86400000)
}

// 开封后有效期到期日（开封当天计第 1 天，与保质期换算口径一致）
function calcOpenedExpiry(openedAt, paoDays) {
  if (!openedAt || !paoDays) return ''
  const o = openedAt instanceof Date ? openedAt : new Date(String(openedAt).replace(/-/g, '/'))
  if (isNaN(o.getTime())) return ''
  o.setDate(o.getDate() + Number(paoDays) - 1)
  return toDateOnly(o)
}

// 批次实际到期日（契约 v1.5 #13）：有开封记录且配置开封有效期时，取 min(到期日, 开封到期日)；
// 任一前置不满足（无 opened_at / pao_days 空 / 日期非法）时回退原到期日，行为不变
function effectiveExpiry(expiryDate, openedAt, paoDays) {
  if (!openedAt || !paoDays) return expiryDate
  const opened = new Date(openedAt)
  if (isNaN(opened.getTime())) return expiryDate
  // opened_at 是 timestamptz：先取本地日期部分（YYYY-MM-DD）再换算，规避 iOS 对混合格式的解析差异
  const openedExpiry = calcOpenedExpiry(toDateOnly(opened), paoDays)
  if (!openedExpiry) return expiryDate
  if (!expiryDate) return openedExpiry
  return openedExpiry < expiryDate ? openedExpiry : expiryDate
}

// 临期分级：level = expired(0) | danger(1) | warn(2) | ok(3)
function urgencyLevel(daysLeft, thresholds) {
  const t = thresholds || { danger: 3, warn: 30 }
  if (daysLeft < 0) return 'expired'
  if (daysLeft <= t.danger) return 'danger'
  if (daysLeft <= t.warn) return 'warn'
  return 'ok'
}

module.exports = { toDateOnly, calcExpiry, daysUntil, calcOpenedExpiry, urgencyLevel, effectiveExpiry }
