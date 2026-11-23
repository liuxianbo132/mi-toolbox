// 一次性工具：把 ImageGen 生成的 1024px 插画压缩为小程序可用的 256px PNG（palette 量化）
// 运行：node scripts/compress-illustrations.js
const fs = require('fs')
const path = require('path')
const sharp = require('sharp')

const ROOT = path.resolve(__dirname, '..')
const SRC = path.join(ROOT, 'assets', 'illustrations', 'v2')
const ORIGINALS = path.join(ROOT, '.workbuddy', 'tmp', 'gen-originals')

// 原图（时间戳命名）→ 目标语义名
const MAP = [
  ['2026-11-23T07-55-48', 'food'], // 牛奶盒
  ['2026-11-23T07-56-00', 'medicine'], // 药瓶 + 胶囊
  ['2026-11-23T07-56-12', 'daily'], // 按压瓶
  ['2026-11-23T07-56-39', 'other'], // 收纳盒
  ['2026-11-23T07-56-58', 'empty'], // 空篮子（空态）
]

function findOriginal(stamp) {
  const files = fs.readdirSync(SRC).filter(function (f) { return f.indexOf(stamp) >= 0 && f.endsWith('.png') })
  return files.length ? path.join(SRC, files[0]) : ''
}

;(async function () {
  fs.mkdirSync(ORIGINALS, { recursive: true })
  for (const [stamp, name] of MAP) {
    const src = findOriginal(stamp)
    if (!src) {
      console.log('SKIP ' + name + ' (source not found)')
      continue
    }
    const out = path.join(SRC, name + '.png')
    await sharp(src)
      .resize(256, 256, { fit: 'cover' })
      .png({ compressionLevel: 9, palette: true, quality: 80 })
      .toFile(out)
    const size = fs.statSync(out).size
    console.log('OK ' + name + '.png  ' + Math.round(size / 1024) + ' KB')
    // 原图移入 .workbuddy/tmp（gitignore 覆盖），保留可追溯、不入库
    fs.renameSync(src, path.join(ORIGINALS, path.basename(src)))
  }
})()
