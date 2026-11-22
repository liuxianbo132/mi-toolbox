// 品类常量：与数据契约 items.category 枚举（food/medicine/daily/other）一一对应，禁止页面自造映射
// icon/display 仅用于 UI 展示（emoji 与系统字体同源，iOS/Android 跨端一致，无需图标资源文件）
const CATEGORIES = [
  { value: 'food', label: '食品', icon: '🍎', display: '🍎 食品' },
  { value: 'medicine', label: '药品', icon: '💊', display: '💊 药品' },
  { value: 'daily', label: '日用品', icon: '🧴', display: '🧴 日用品' },
  { value: 'other', label: '其他', icon: '📦', display: '📦 其他' },
]

function findCategory(value) {
  const hit = CATEGORIES.find(function (c) { return c.value === value })
  return hit || CATEGORIES[CATEGORIES.length - 1]
}

function categoryLabel(value) {
  return findCategory(value).label
}

// 带图标展示文案：'🍎 食品'
function categoryDisplay(value) {
  return findCategory(value).display
}

function categoryIcon(value) {
  return findCategory(value).icon
}

module.exports = { CATEGORIES, categoryLabel, categoryDisplay, categoryIcon }
