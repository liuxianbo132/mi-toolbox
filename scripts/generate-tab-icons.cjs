const fs = require('node:fs')
const path = require('node:path')
const { PNG } = require('pngjs')

const outputDir = path.join(__dirname, '..', 'assets', 'icons', 'tabbar')
const sourceDir = path.join(__dirname, '..', 'assets', 'icons')
const size = 81
const scale = 4
const color = { selected: '#007AFF', normal: '#8E8E93' }

function rgba(hex) {
  return [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16)).concat(255)
}

function line(png, x1, y1, x2, y2, width, stroke) {
  const r = width / 2
  const minX = Math.max(0, Math.floor(Math.min(x1, x2) - r))
  const maxX = Math.min(png.width - 1, Math.ceil(Math.max(x1, x2) + r))
  const minY = Math.max(0, Math.floor(Math.min(y1, y2) - r))
  const maxY = Math.min(png.height - 1, Math.ceil(Math.max(y1, y2) + r))
  const dx = x2 - x1
  const dy = y2 - y1
  const length2 = dx * dx + dy * dy || 1
  const ink = rgba(stroke)
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
    const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / length2))
    const distance = Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy))
    if (distance <= r) {
      const offset = (png.width * y + x) * 4
      png.data.set(ink, offset)
    }
  }
}

function polyline(png, points, width, stroke, close = false) {
  for (let i = 1; i < points.length; i++) line(png, ...points[i - 1], ...points[i], width, stroke)
  if (close) line(png, ...points.at(-1), ...points[0], width, stroke)
}

function circle(png, cx, cy, radius, width, stroke, start = 0, end = Math.PI * 2) {
  const steps = Math.max(24, Math.ceil((end - start) * radius))
  const points = Array.from({ length: steps + 1 }, (_, i) => {
    const angle = start + ((end - start) * i) / steps
    return [cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius]
  })
  polyline(png, points, width, stroke)
}

function draw(name, stroke) {
  const png = new PNG({ width: size * scale, height: size * scale, colorType: 6 })
  const s = (n) => n * scale
  const w = s(3.5)
  if (name === 'home') {
    polyline(png, [[s(14), s(39)], [s(48), s(12)], [s(82), s(39)], [s(82), s(76)], [s(64), s(76)], [s(64), s(54)], [s(48), s(54)], [s(48), s(76)], [s(14), s(76)], [s(14), s(39)]], w, stroke)
  } else if (name === 'box') {
    polyline(png, [[s(48), s(12)], [s(82), s(30)], [s(82), s(67)], [s(48), s(85)], [s(14), s(67)], [s(14), s(30)], [s(48), s(12)]], w, stroke)
    polyline(png, [[s(14), s(30)], [s(48), s(49)], [s(82), s(30)]], w, stroke)
    line(png, s(48), s(49), s(48), s(85), w, stroke)
  } else if (name === 'pill') {
    const points = [[s(27), s(68)], [s(22), s(63)], [s(22), s(54)], [s(54), s(22)], [s(63), s(22)], [s(72), s(31)], [s(72), s(40)], [s(40), s(72)], [s(31), s(72)]]
    polyline(png, points, w, stroke, true)
    line(png, s(37), s(37), s(59), s(59), w, stroke)
  } else if (name === 'user') {
    circle(png, s(48), s(31), s(17), w, stroke)
    circle(png, s(48), s(78), s(34), w, stroke, Math.PI, Math.PI * 2)
  }
  const small = new PNG({ width: size, height: size, colorType: 6 })
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const out = (size * y + x) * 4
    let a = 0, r = 0, g = 0, b = 0
    for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) {
      const src = (png.width * (y * scale + sy) + x * scale + sx) * 4
      a += png.data[src + 3]
      r += png.data[src]; g += png.data[src + 1]; b += png.data[src + 2]
    }
    const samples = scale * scale
    small.data[out] = r / samples; small.data[out + 1] = g / samples; small.data[out + 2] = b / samples
    small.data[out + 3] = a / samples
  }
  return small
}

fs.mkdirSync(outputDir, { recursive: true })
for (const [name, svgName] of [['home', 'home.svg'], ['inventory', 'box.svg'], ['medication', 'pill.svg'], ['profile', 'user.svg']]) {
  for (const [state, tint] of [['normal', color.normal], ['selected', color.selected]]) {
    const target = path.join(outputDir, `${name}-${state}.png`)
    fs.writeFileSync(target, PNG.sync.write(draw(path.basename(svgName, '.svg'), tint)))
    console.log(`Generated ${path.relative(sourceDir, target)}`)
  }
}
