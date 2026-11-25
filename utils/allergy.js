// 过敏关联匹配：指定服药人登记的文本与药品显式关联按去除首尾空格后的文本匹配。
// 返回 [{ allergen, kind, kindLabel }]；同一过敏原命中多条时 forbidden 优先
const KIND_LABEL = { forbidden: '禁用', caution: '慎用' }

function matchAllergies(myAllergens, links) {
  const mine = new Set((myAllergens || []).map(function (a) { return String(a || '').trim() }))
  const hitMap = new Map()
  ;(links || []).forEach(function (l) {
    const allergen = String((l && l.allergen) || '').trim()
    if (!allergen || !mine.has(allergen)) return
    const kind = l.kind === 'forbidden' ? 'forbidden' : 'caution'
    if (!hitMap.has(allergen) || kind === 'forbidden') hitMap.set(allergen, kind)
  })
  return Array.from(hitMap, function ([allergen, kind]) {
    return { allergen: allergen, kind: kind, kindLabel: KIND_LABEL[kind] }
  })
}

function indexAllergyMatches(allergies, links) {
  const membersByAllergen = new Map()
  allergies.forEach(function (a) {
    const allergen = String(a.allergen || '').trim()
    if (!allergen) return
    if (!membersByAllergen.has(allergen)) membersByAllergen.set(allergen, new Set())
    membersByAllergen.get(allergen).add(a.member_id)
  })

  const matches = new Map()
  links.forEach(function (l) {
    const members = membersByAllergen.get(String(l.allergen || '').trim())
    if (!members) return
    members.forEach(function (memberId) {
      const key = l.item_id + '|' + memberId
      if (!matches.has(key) || l.kind === 'forbidden') {
        matches.set(key, l.kind === 'forbidden' ? 'forbidden' : 'caution')
      }
    })
  })
  return matches
}

function hasForbidden(hits) {
  return (hits || []).some(function (h) {
    return h.kind === 'forbidden'
  })
}

// 命中摘要文案：'花生（禁用）、青霉素（慎用）'
function hitsText(hits) {
  return (hits || [])
    .map(function (h) {
      return h.allergen + '（' + h.kindLabel + '）'
    })
    .join('、')
}

module.exports = { matchAllergies, indexAllergyMatches, hasForbidden, hitsText, KIND_LABEL }
