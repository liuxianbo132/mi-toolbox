// 静态自检（零依赖）：JSON 可解析 / JS 语法 / 页面注册齐全 / tabBar 图标存在 / assets 静态引用存在
// 运行：node scripts/verify-static.js
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
let pass = 0
const fails = []

function rel(p) {
  return path.relative(ROOT, p).replace(/\\/g, '/')
}
function must(cond, msg) {
  if (cond) pass++
  else fails.push(msg)
}
function walk(dir, out) {
  out = out || []
  if (!fs.existsSync(dir)) return out
  fs.readdirSync(dir).forEach(function (name) {
    const full = path.join(dir, name)
    if (fs.statSync(full).isDirectory()) walk(full, out)
    else out.push(full)
  })
  return out
}

// 1. JSON 可解析
const jsonFiles = ['app.json', 'project.config.json', 'sitemap.json']
  .map(function (f) { return path.join(ROOT, f) })
  .concat(walk(path.join(ROOT, 'pages')).filter(function (f) { return f.endsWith('.json') }))
  .concat(walk(path.join(ROOT, 'components')).filter(function (f) { return f.endsWith('.json') }))
jsonFiles.forEach(function (f) {
  if (!fs.existsSync(f)) {
    fails.push('missing JSON: ' + rel(f))
    return
  }
  try {
    JSON.parse(fs.readFileSync(f, 'utf8'))
    pass++
  } catch (e) {
    fails.push('bad JSON: ' + rel(f) + ' -> ' + e.message)
  }
})

// 2. JS 语法（node --check）
const jsFiles = [path.join(ROOT, 'app.js')]
  .concat(walk(path.join(ROOT, 'pages')).filter(function (f) { return f.endsWith('.js') }))
  .concat(walk(path.join(ROOT, 'utils')).filter(function (f) { return f.endsWith('.js') }))
  .concat(walk(path.join(ROOT, 'components')).filter(function (f) { return f.endsWith('.js') }))
jsFiles.forEach(function (f) {
  try {
    execSync('node --check "' + f + '"', { stdio: 'pipe' })
    pass++
  } catch (e) {
    fails.push('JS syntax: ' + rel(f))
  }
})

// 3. 页面注册与文件齐全
const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'))
;(appJson.pages || []).forEach(function (p) {
  ;['.js', '.wxml', '.json', '.wxss'].forEach(function (ext) {
    must(fs.existsSync(path.join(ROOT, p + ext)), 'page file missing: ' + p + ext)
  })
})

// 4. tabBar 图标存在
;((appJson.tabBar && appJson.tabBar.list) || []).forEach(function (t) {
  if (t.iconPath) must(fs.existsSync(path.join(ROOT, t.iconPath)), 'tab icon missing: ' + t.iconPath)
  if (t.selectedIconPath) must(fs.existsSync(path.join(ROOT, t.selectedIconPath)), 'tab icon missing: ' + t.selectedIconPath)
})

// 5. 静态 assets 引用（排除模板动态路径 {{...}}）
const srcFiles = walk(path.join(ROOT, 'pages'))
  .concat(walk(path.join(ROOT, 'components')))
  .concat([path.join(ROOT, 'app.json'), path.join(ROOT, 'app.wxss')])
  .filter(function (f) { return /\.(wxml|wxss|js|json)$/.test(f) })
const refs = new Set()
srcFiles.forEach(function (f) {
  const text = fs.readFileSync(f, 'utf8')
  const re = /["'](\/assets\/[^"'{}]+?\.(?:svg|png|jpg|jpeg))["']/g
  let m
  while ((m = re.exec(text))) refs.add(m[1])
})
refs.forEach(function (ref) {
  must(fs.existsSync(path.join(ROOT, ref.slice(1))), 'asset missing: ' + ref)
})

console.log('PASS ' + pass + ' / FAIL ' + fails.length)
fails.forEach(function (f) {
  console.log('  - ' + f)
})
process.exit(fails.length ? 1 : 0)
