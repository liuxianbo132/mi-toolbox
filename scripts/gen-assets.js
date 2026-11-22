// 生成 assets 资源：18 个线性图标（24x24，stroke 1.8）+ 5 张品类插画（96x96，轻拟物）
// 运行：node scripts/gen-assets.js
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const ICON_DIR = path.join(ROOT, 'assets', 'icons')
const ILL_DIR = path.join(ROOT, 'assets', 'illustrations')

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }) }

// ---------- 线性图标（Apple SF Symbols 气质：圆头圆角、1.8 描边、几何克制） ----------
const BLUE = '#007AFF'
const GRAY = '#8E8E93'

function icon(body, color) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="${color || BLUE}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>\n`
}

const icons = {
  home: '<path d="M3.5 10.4 12 3.5l8.5 6.9V19a1.6 1.6 0 0 1-1.6 1.6h-4.4v-5.8H9.5v5.8H5.1A1.6 1.6 0 0 1 3.5 19v-8.6z"/>',
  box: '<path d="M12 3.2 20 7.6v8.8L12 20.8 4 16.4V7.6l8-4.4z"/><path d="M4 7.6 12 12l8-4.4M12 12v8.8"/>',
  pill: '<rect x="4.6" y="9.2" width="14.8" height="6.6" rx="3.3" transform="rotate(-42 12 12.5)"/><path d="M9.4 8.6l6.9 6.9"/>',
  user: '<circle cx="12" cy="7.8" r="3.6"/><path d="M5 20.2c0-3.6 3.1-6.2 7-6.2s7 2.6 7 6.2"/>',
  scan: '<path d="M4 8.2V5.4A1.4 1.4 0 0 1 5.4 4h2.8M15.8 4h2.8A1.4 1.4 0 0 1 20 5.4v2.8M20 15.8v2.8a1.4 1.4 0 0 1-1.4 1.4h-2.8M8.2 20H5.4A1.4 1.4 0 0 1 4 18.6v-2.8"/><path d="M4.5 12h15"/>',
  plusCircle: '<circle cx="12" cy="12" r="8.4"/><path d="M12 8.4v7.2M8.4 12h7.2"/>',
  calendar: '<rect x="4" y="5.6" width="16" height="14.8" rx="3"/><path d="M4 10.2h16M8.2 3.6v3.6M15.8 3.6v3.6"/><circle cx="9" cy="14.6" r=".9" fill="currentColor" stroke="none"/><circle cx="12" cy="14.6" r=".9" fill="currentColor" stroke="none"/><circle cx="15" cy="14.6" r=".9" fill="currentColor" stroke="none"/>',
  location: '<path d="M12 21s6.6-5.9 6.6-10.6a6.6 6.6 0 1 0-13.2 0C5.4 15.1 12 21 12 21z"/><circle cx="12" cy="10.2" r="2.4"/>',
  bell: '<path d="M6.2 16.2v-4.7a5.8 5.8 0 1 1 11.6 0v4.7l1.6 2.3H4.6l1.6-2.3z"/><path d="M10 20.6a2.1 2.1 0 0 0 4 0"/>',
  checkCircle: '<circle cx="12" cy="12" r="8.4"/><path d="M8.2 12.3l2.6 2.6 5-5.4"/>',
  alertCircle: '<circle cx="12" cy="12" r="8.4"/><path d="M12 7.8v5.1M12 16.1v.2"/>',
  clock: '<circle cx="12" cy="12" r="8.4"/><path d="M12 7.4V12l3.1 2"/>',
  camera: '<rect x="3.4" y="7.2" width="17.2" height="12" rx="3.2"/><path d="M8.8 7.2l1.3-2.3h3.8l1.3 2.3"/><circle cx="12" cy="13" r="3.1"/>',
  close: '<path d="M6.2 6.2l11.6 11.6M17.8 6.2L6.2 17.8"/>',
  chevron: '<path d="M9.4 5.4 16 12l-6.6 6.6"/>',
  edit: '<path d="M4.4 19.6l4.4-1 9.9-9.9a2.05 2.05 0 0 0-2.9-2.9L5.9 15.7l-1.5 3.9z"/>',
  shield: '<path d="M12 3.4l7 3v5.3c0 4.4-2.9 7.6-7 9.3-4.1-1.7-7-4.9-7-9.3V6.4l7-3z"/><path d="M9 12.2l2.2 2.2 4-4.3"/>',
  tray: '<path d="M4 13.4h4.2l1.6 2.6h4.4l1.6-2.6H20"/><path d="M4 13.4 6.3 6.4h11.4L20 13.4v3.9a1.6 1.6 0 0 1-1.6 1.6H5.6A1.6 1.6 0 0 1 4 17.3v-3.9z"/>',
}

// ---------- 品类插画（96x96，轻拟物：柔和渐变 + 分层高光，不用 filter 保证兼容） ----------
function ill(inner, bgA, bgB) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${bgA}"/><stop offset="1" stop-color="${bgB}"/></linearGradient>
</defs>
<rect x="2" y="2" width="92" height="92" rx="26" fill="url(#bg)"/>
${inner}
</svg>\n`
}

const illustrations = {
  // 牛奶盒（食品）
  food: ill(
    `<defs>
  <linearGradient id="milk" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#E8EAEF"/></linearGradient>
  <linearGradient id="cap" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5AC8FA"/><stop offset="1" stop-color="#007AFF"/></linearGradient>
</defs>
<ellipse cx="48" cy="78" rx="20" ry="5" fill="#1C1C1E" opacity="0.07"/>
<path d="M36 30 L48 22 L60 30 L60 70 Q60 76 54 76 L42 76 Q36 76 36 70 Z" fill="url(#milk)"/>
<path d="M36 30 L48 38 L48 76 L42 76 Q36 76 36 70 Z" fill="#000000" opacity="0.04"/>
<path d="M48 22 L60 30 L48 38 Z" fill="#D6D9DF"/>
<rect x="40" y="46" width="16" height="18" rx="4" fill="url(#cap)" opacity="0.92"/>
<rect x="43" y="52" width="10" height="2.4" rx="1.2" fill="#FFFFFF" opacity="0.9"/>
<rect x="43" y="57" width="7" height="2.4" rx="1.2" fill="#FFFFFF" opacity="0.65"/>`,
    '#F3F8FF', '#E4EEFC'
  ),
  // 药瓶 + 胶囊（药品）
  medicine: ill(
    `<defs>
  <linearGradient id="btl" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#E7EAF0"/></linearGradient>
  <linearGradient id="lid" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7FB8FF"/><stop offset="1" stop-color="#2F7EF7"/></linearGradient>
  <linearGradient id="capA" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FF8A7A"/><stop offset="1" stop-color="#FF5F4E"/></linearGradient>
</defs>
<ellipse cx="48" cy="80" rx="21" ry="5" fill="#1C1C1E" opacity="0.07"/>
<rect x="34" y="34" width="24" height="42" rx="9" fill="url(#btl)"/>
<rect x="34" y="34" width="9" height="42" rx="4.5" fill="#000000" opacity="0.03"/>
<rect x="35" y="24" width="22" height="12" rx="5" fill="url(#lid)"/>
<rect x="38" y="52" width="16" height="14" rx="4" fill="#EEF3FB"/>
<path d="M46 55.5v7M42.5 59h7" stroke="#2F7EF7" stroke-width="2.4" stroke-linecap="round"/>
<g transform="rotate(-28 68 66)"><rect x="58" y="62" width="22" height="9" rx="4.5" fill="url(#capA)"/><rect x="58" y="62" width="11" height="9" rx="4.5" fill="#FFFFFF" opacity="0.55"/></g>`,
    '#F5F9FF', '#E7F0FE'
  ),
  // 按压瓶（日用品）
  daily: ill(
    `<defs>
  <linearGradient id="pump" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8FD9C0"/><stop offset="1" stop-color="#33B98A"/></linearGradient>
  <linearGradient id="body" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#E6EBEA"/></linearGradient>
</defs>
<ellipse cx="48" cy="80" rx="19" ry="5" fill="#1C1C1E" opacity="0.07"/>
<rect x="38" y="40" width="20" height="36" rx="8" fill="url(#body)"/>
<rect x="38" y="40" width="7" height="36" rx="3.5" fill="#000000" opacity="0.03"/>
<rect x="40" y="30" width="16" height="12" rx="4" fill="url(#pump)"/>
<path d="M40 30h16v-4a3 3 0 0 0-3-3h-2v4" fill="none" stroke="#2A9E76" stroke-width="2.4" stroke-linecap="round"/>
<rect x="42" y="50" width="12" height="14" rx="4" fill="#EAF7F2"/>
<path d="M48 54c1.8 2 3 3.4 3 5a3 3 0 1 1-6 0c0-1.6 1.2-3 3-5z" fill="#33B98A" opacity="0.8"/>`,
    '#F4FBF8', '#E5F5EE'
  ),
  // 收纳盒（其他 / 默认）
  other: ill(
    `<defs>
  <linearGradient id="bx" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFE2B8"/><stop offset="1" stop-color="#F5B96B"/></linearGradient>
  <linearGradient id="lidTop" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFEFD6"/><stop offset="1" stop-color="#F9CE92"/></linearGradient>
</defs>
<ellipse cx="48" cy="79" rx="22" ry="5" fill="#1C1C1E" opacity="0.07"/>
<path d="M28 44 L48 36 L68 44 L68 68 Q68 74 62 74 L34 74 Q28 74 28 68 Z" fill="url(#bx)"/>
<path d="M28 44 L48 36 L48 74 L34 74 Q28 74 28 68 Z" fill="#000000" opacity="0.04"/>
<path d="M24 38 L48 29 L72 38 L48 47 Z" fill="url(#lidTop)"/>
<path d="M24 38 L48 47 L48 51 L24 42 Z" fill="#E0A456" opacity="0.5"/>
<rect x="42" y="52" width="12" height="3" rx="1.5" fill="#FFFFFF" opacity="0.75"/>`,
    '#FFFBF4', '#FDF0DF'
  ),
}

ensureDir(ICON_DIR)
ensureDir(ILL_DIR)

let count = 0
Object.keys(icons).forEach(function (k) {
  fs.writeFileSync(path.join(ICON_DIR, k + '.svg'), icon(icons[k], BLUE))
  count++
})
// tab 灰色版（未选中态）
;['home', 'box', 'pill', 'user'].forEach(function (k) {
  fs.writeFileSync(path.join(ICON_DIR, k + '-gray.svg'), icon(icons[k], GRAY))
  count++
})
// 语义彩色版（统计卡 / 快捷入口 / 状态徽标）
const COLORED = {
  'alertCircle-red': ['alertCircle', '#FF3B30'],
  'clock-amber': ['clock', '#FF9500'],
  'checkCircle-green': ['checkCircle', '#34C759'],
  'plusCircle-green': ['plusCircle', '#34C759'],
  'calendar-amber': ['calendar', '#FF9500'],
  'location-purple': ['location', '#AF52DE'],
  'bell-red': ['bell', '#FF3B30'],
  'tray-blue': ['tray', '#007AFF'],
}
Object.keys(COLORED).forEach(function (name) {
  const def = COLORED[name]
  fs.writeFileSync(path.join(ICON_DIR, name + '.svg'), icon(icons[def[0]], def[1]))
  count++
})
Object.keys(illustrations).forEach(function (k) {
  fs.writeFileSync(path.join(ILL_DIR, k + '.svg'), illustrations[k])
  count++
})
// 默认兜底插画 = other 的副本（分类无法识别时使用）
fs.copyFileSync(path.join(ILL_DIR, 'other.svg'), path.join(ILL_DIR, 'default.svg'))
count++

console.log('generated ' + count + ' files')
