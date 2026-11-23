// 品类常量：与数据契约 items.category 枚举（food/medicine/daily/other）一一对应，禁止页面自造映射
// UI 图标为线性 SVG（assets/icons），分类插画为轻拟物 SVG（assets/illustrations）；不使用 emoji
const CATEGORIES = [
  { value: 'food', label: '食品' },
  { value: 'medicine', label: '药品' },
  { value: 'daily', label: '日用品' },
  { value: 'other', label: '其他' },
]

// 品类插画（v2：ImageGen 3D 轻拟物 PNG，256px 调色板量化，5 张共 ~104KB）
// 旧的 assets/illustrations/*.svg 保留，可随时回退（改回 .svg 路径即可）
const ILLUSTRATIONS = {
  food: '/assets/illustrations/v2/food.png',
  medicine: '/assets/illustrations/v2/medicine.png',
  daily: '/assets/illustrations/v2/daily.png',
  other: '/assets/illustrations/v2/other.png',
}
const DEFAULT_ILLUSTRATION = '/assets/illustrations/v2/other.png'

function findCategory(value) {
  const hit = CATEGORIES.find(function (c) { return c.value === value })
  return hit || CATEGORIES[CATEGORIES.length - 1]
}

function categoryLabel(value) {
  return findCategory(value).label
}

function categoryIllustration(value) {
  return ILLUSTRATIONS[value] || DEFAULT_ILLUSTRATION
}

module.exports = {
  CATEGORIES,
  categoryLabel,
  categoryIllustration,
  ILLUSTRATIONS,
  DEFAULT_ILLUSTRATION,
}
