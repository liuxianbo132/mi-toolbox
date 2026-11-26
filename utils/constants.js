// 品类常量：与数据契约 items.category 枚举（food/medicine/daily/other）一一对应，禁止页面自造映射
// UI 图标为线性 SVG（assets/icons），分类插画为轻拟物 SVG（assets/illustrations）；不使用 emoji
const CATEGORIES = [
  { value: 'food', label: '食品' },
  { value: 'medicine', label: '药品' },
  { value: 'daily', label: '日用品' },
  { value: 'other', label: '其他' },
]

// 品类插画（v3：透明、扁平、无文字 PNG）。旧 v2 PNG 与 SVG 均保留，路径回退即可。
const ILLUSTRATIONS = {
  food: '/assets/illustrations/v3/categories/food.png',
  medicine: '/assets/illustrations/v3/categories/medicine.png',
  daily: '/assets/illustrations/v3/categories/daily.png',
  other: '/assets/illustrations/v3/categories/other.png',
}
const DEFAULT_ILLUSTRATION = '/assets/illustrations/v3/categories/other.png'

function findCategory(value) {
  const hit = CATEGORIES.find(function (c) { return c.value === value })
  return hit || CATEGORIES[CATEGORIES.length - 1]
}

function categoryLabel(value) {
  return findCategory(value).label
}

function categoryIllustration(value) {
  return Object.prototype.hasOwnProperty.call(ILLUSTRATIONS, value) ? ILLUSTRATIONS[value] : DEFAULT_ILLUSTRATION
}

// 物品级插画：按物品名关键词匹配（家庭高频品），未命中回落品类插画。
// 顺序有讲究：更具体的词在前（「酸奶」先于「牛奶」；「洗发水」必须排在「饮料」前）。
// 反例记录：曾用单字「水」作饮料关键词 → 「洗发水」被误判为饮料，故一律避免单字。
const ITEM_ILLUSTRATIONS = [
  { keys: ['猫罐头', '猫咪罐头', '猫用罐头', '猫主食罐', '猫零食罐', '猫湿粮', '猫咪湿粮', '主食猫罐'], path: '/assets/illustrations/v3/products/cat-wet-food.png' },
  { keys: ['猫条', '猫咪肉泥', '猫用肉泥', '猫咪舔舔条', '猫用舔食条'], path: '/assets/illustrations/v3/products/cat-treat.png' },
  { keys: ['猫砂', '猫咪用砂', '膨润土砂', '豆腐砂'], path: '/assets/illustrations/v3/products/cat-litter.png' },
  { keys: ['大米', '粳米', '籼米', '糙米', '稻米', '香米', '珍珠米', '五常米'], path: '/assets/illustrations/v3/products/rice.png' },
  { keys: ['面条', '挂面', '意面', '意大利面', '宽面', '龙须面', '乌冬面'], path: '/assets/illustrations/v3/products/noodles.png' },
  { keys: ['食用油', '花生油', '菜籽油', '大豆油', '橄榄油', '葵花籽油', '玉米油', '调和油', '芝麻油'], path: '/assets/illustrations/v3/products/cooking-oil.png' },
  { keys: ['酸奶', '酸牛奶', '发酵乳', '优格'], path: '/assets/illustrations/v3/products/yogurt-cup.png' },
  { keys: ['洗发', '沐浴', '洗衣', '洗洁', '洗手', '护肤', '乳液'], path: '/assets/illustrations/v3/products/shampoo.png' },
  { keys: ['纸巾', '抽纸', '卫生纸', '面巾纸'], path: '/assets/illustrations/v3/products/tissue-box.png' },
  { keys: ['牛奶', '鲜奶', '纯奶', '巴氏乳', '鲜牛乳'], path: '/assets/illustrations/v3/products/milk-carton.png' },
  { keys: ['鸡蛋', '鸭蛋', '咸蛋', '皮蛋'], path: '/assets/illustrations/v3/products/eggs.png' },
  { keys: ['面包', '吐司', '土司'], path: '/assets/illustrations/v3/products/bread-sliced.png' },
  { keys: ['苹果', '香蕉', '橙子', '水果', '梨', '葡萄', '桃子'], path: '/assets/illustrations/v3/products/fruit.png' },
  { keys: ['番茄', '西红柿', '黄瓜', '蔬菜', '生菜', '白菜', '土豆'], path: '/assets/illustrations/v3/products/veggie.png' },
  { keys: ['饼干', '零食', '巧克力', '薯片', '坚果', '核桃', '开心果', '糖'], path: '/assets/illustrations/v3/products/snack.png' },
  { keys: ['饮料', '果汁', '汁', '可乐', '汽水', '茶', '咖啡', '矿泉水', '纯净水', '苏打水', '气泡水', '雪碧', '芬达'], path: '/assets/illustrations/v3/products/drink.png' },
  { keys: ['药片', '维生素', '钙片', '布洛芬', '阿司匹林', '含片'], path: '/assets/illustrations/v3/products/tablet.png' },
  { keys: ['胶囊', '口服液', '药瓶', '滴剂'], path: '/assets/illustrations/v3/products/medicine-bottle.png' },
]

function itemIllustration(name, category) {
  const n = String(name || '').replace(/[\s·・]+/g, '')
  const exact = ITEM_ILLUSTRATIONS.find(({ keys }) => keys.includes(n))
  if (exact) return exact.path
  const named = ITEM_ILLUSTRATIONS.find(({ keys }) => keys.some((key) => n.includes(key)))
  if (named) return named.path
  if (category === 'medicine' && /片剂|颗粒剂|咀嚼片/.test(n)) return '/assets/illustrations/v3/products/tablet.png'
  return categoryIllustration(category)
}

module.exports = {
  CATEGORIES,
  categoryLabel,
  categoryIllustration,
  itemIllustration,
  ILLUSTRATIONS,
  ITEM_ILLUSTRATIONS,
  DEFAULT_ILLUSTRATION,
}
