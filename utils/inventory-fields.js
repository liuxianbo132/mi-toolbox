function parseOptionalDaysOrCount(value, max) {
  const raw = String(value == null ? '' : value).trim()
  if (!raw) return 0
  if (!/^\d+$/.test(raw)) return null
  const number = Number(raw)
  return number <= max ? number : null
}

module.exports = { parseOptionalDaysOrCount }
