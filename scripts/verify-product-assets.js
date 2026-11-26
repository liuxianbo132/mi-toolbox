const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { itemIllustration, categoryIllustration, ITEM_ILLUSTRATIONS } = require('../utils/constants')

const products = new Map([
  ['纯牛奶', 'milk-carton'], ['原味酸牛奶', 'yogurt-cup'], ['鲜鸡蛋 10 枚', 'eggs'], ['全麦吐司', 'bread-sliced'],
  ['儿童口服液', 'medicine-bottle'], ['柔软面巾纸', 'tissue-box'], ['五常香米', 'rice'], ['龙须面', 'noodles'],
  ['葵花籽油', 'cooking-oil'], ['猫咪湿粮罐头', 'cat-wet-food'], ['猫用肉泥条', 'cat-treat'], ['豆腐猫砂', 'cat-litter'],
])

for (const [name, file] of products) assert.match(itemIllustration(name, 'other'), new RegExp(`/${file}\\.png$`))
assert.match(itemIllustration('儿童颗粒剂', 'medicine'), /\/tablet\.png$/)
assert.match(itemIllustration('纸盒纯牛奶', 'food'), /\/milk-carton\.png$/)
assert.equal(itemIllustration('午餐肉罐头', 'food'), categoryIllustration('food'))
assert.equal(itemIllustration('宠物用品收纳箱', 'daily'), categoryIllustration('daily'))
assert.equal(itemIllustration('空白打印纸', 'daily'), categoryIllustration('daily'))
assert.equal(itemIllustration('不明物品', '__proto__'), categoryIllustration('other'))

const root = path.resolve(__dirname, '..')
for (const { path: illustration } of ITEM_ILLUSTRATIONS) assert.ok(fs.existsSync(path.join(root, illustration)), illustration)
for (const file of products.values()) {
  const data = fs.readFileSync(path.join(root, 'assets/illustrations/v3/products', `${file}.png`))
  assert.equal(data.readUInt32BE(16), 192)
  assert.equal(data.readUInt32BE(20), 192)
  if (data[25] === 3) assert.ok(data.includes('tRNS'), `${file} transparency`)
  else assert.equal(data[25], 6, `${file} alpha`)
  assert.ok(data.length <= 40000, `${file} size`)
}
console.log('PASS: 12 product assets, specific matches, aliases, category fallbacks and PNG payloads')
