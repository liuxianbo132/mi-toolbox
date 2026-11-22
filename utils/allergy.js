// 过敏冲突匹配（m2-brief #8）：当前用户 allergies.allergen ∩ 药品 drug_allergy_links.allergen
// 返回 [{ allergen, kind, kindLabel }]；同一过敏原命中多条时 forbidden 优先
const KIND_LABEL = { forbidden: '禁用', caution: '慎用' }

function matchAllergies(myAllergens, links) {
  const mine = {}
  ;(myAllergens || []).forEach(function (a) {
    const k = String(a || '').trim()
    if (k) mine[k] = true
  })
  const hitMap = {}
  ;(links || []).forEach(function (l) {
    const allergen = String((l && l.allergen) || '').trim()
    if (!allergen || !mine[allergen]) return
    const kind = l.kind === 'forbidden' ? 'forbidden' : 'caution'
    if (!hitMap[allergen] || kind === 'forbidden') hitMap[allergen] = kind
  })
  return Object.keys(hitMap).map(function (allergen) {
    return { allergen: allergen, kind: hitMap[allergen], kindLabel: KIND_LABEL[hitMap[allergen]] }
  })
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

module.exports = { matchAllergies, hasForbidden, hitsText, KIND_LABEL }
