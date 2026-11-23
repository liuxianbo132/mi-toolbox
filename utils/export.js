// 家庭数据导出：只读查询 8 张表，产出完整 JSON 快照与 items CSV，并写入本机后转发给微信
// 注意：小程序无 Node fs / fetch，文件走 wx.getFileSystemManager()；模块只导出纯函数，不持有页面状态
const { cloud } = require('./cloud')

// 各表列清单对齐 sql/02-base-schema.sql、03-m2-schema.sql（只读导出，不写库，无需过 data-access 白名单）
const TABLES = [
  {
    key: 'items',
    table: 'items',
    max: 1000,
    columns: 'id,household_id,name,barcode,category,brand,spec,unit,shelf_life_days,pao_days,low_stock_threshold,remark,visibility,created_at',
  },
  {
    key: 'batches',
    table: 'batches',
    max: 3000,
    columns: 'id,household_id,item_id,production_date,expiry_date,quantity,unit,location_id,status,opened_at,price,source,owner_id,owner_name,created_at',
  },
  {
    key: 'locations',
    table: 'locations',
    max: 200,
    columns: 'id,household_id,name,kind,created_at',
  },
  {
    key: 'records',
    table: 'records',
    max: 1000,
    columns: 'id,household_id,batch_id,action,quantity,note,owner_id,owner_name,created_at',
  },
  {
    key: 'medication_plans',
    table: 'medication_plans',
    max: 200,
    columns: 'id,household_id,item_id,member_id,times,freq,start_date,end_date,miss_threshold_minutes,status,created_at',
  },
  {
    key: 'medication_doses',
    table: 'medication_doses',
    max: 1000,
    columns: 'id,household_id,plan_id,scheduled_at,confirmed_at,status,created_at',
  },
  {
    key: 'allergies',
    table: 'allergies',
    max: 200,
    columns: 'id,member_id,household_id,allergen,created_at',
  },
  {
    key: 'drug_allergy_links',
    table: 'drug_allergy_links',
    max: 200,
    columns: 'id,household_id,item_id,allergen,kind,created_at',
  },
]

const ITEM_CSV_COLUMNS = [
  'id',
  'name',
  'category',
  'unit',
  'brand',
  'spec',
  'barcode',
  'low_stock_threshold',
  'visibility',
  'created_at',
]

const PAGE_SIZE = 500

// 分页拉取单表：按 id 升序保证翻页稳定，短页即视为末页，硬上限兜底防止无限循环
async function fetchTable(def, hid) {
  const pageSize = Math.min(PAGE_SIZE, def.max)
  const rows = []
  for (let from = 0; from < def.max; from += pageSize) {
    const to = Math.min(from + pageSize - 1, def.max - 1)
    const res = await cloud.database
      .from(def.table)
      .select(def.columns)
      .eq('household_id', hid)
      .order('id', { ascending: true })
      .range(from, to)
    if (res && res.error) {
      throw new Error((res.error && res.error.message) || ('读取 ' + def.table + ' 失败'))
    }
    const page = (res && res.data) || []
    rows.push.apply(rows, page)
    if (page.length < to - from + 1) break
  }
  return rows
}

function cellText(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch (e) {
      return String(value)
    }
  }
  return String(value)
}

// CSV 转义：含逗号、双引号或换行时整字段双引号包裹，内部双引号双写
function csvCell(value) {
  const text = cellText(value)
  if (text.indexOf(',') >= 0 || text.indexOf('"') >= 0 || text.indexOf('\n') >= 0 || text.indexOf('\r') >= 0) {
    return '"' + text.replace(/"/g, '""') + '"'
  }
  return text
}

// items CSV：表头固定列序，行分隔 CRLF，整体前置 UTF-8 BOM 供 Excel 识别中文
function buildItemsCsv(items) {
  const lines = [ITEM_CSV_COLUMNS.join(',')]
  ;(items || []).forEach(function (row) {
    const cells = ITEM_CSV_COLUMNS.map(function (col) {
      return csvCell(row ? row[col] : '')
    })
    lines.push(cells.join(','))
  })
  return '\uFEFF' + lines.join('\r\n')
}

async function buildFamilyExport(hid) {
  if (hid === undefined || hid === null || hid === '') {
    throw new Error('缺少家庭 id')
  }
  const tables = {}
  const stats = {}
  for (let i = 0; i < TABLES.length; i++) {
    const def = TABLES[i]
    const rows = await fetchTable(def, hid)
    tables[def.key] = rows
    stats[def.key] = rows.length
  }
  const json = {
    app: 'mi-toolbox',
    schemaVersion: 'v1.8',
    exportedAt: new Date().toISOString(),
    householdId: hid,
    tables: tables,
  }
  return {
    json: json,
    itemsCsv: buildItemsCsv(tables.items),
    stats: stats,
  }
}

// 写入用户目录后转发到微信会话；所有失败统一以 { error } 返回，不抛出
function writeAndShare(fileName, content) {
  return new Promise(function (resolve) {
    try {
      const filePath = wx.env.USER_DATA_PATH + '/' + fileName
      const fs = wx.getFileSystemManager()
      fs.writeFile({
        filePath: filePath,
        data: content,
        encoding: 'utf8',
        success: function () {
          if (typeof wx.shareFileMessage !== 'function') {
            resolve({ error: '当前微信版本不支持转发文件' })
            return
          }
          wx.shareFileMessage({
            filePath: filePath,
            fileName: fileName,
            success: function () {
              resolve({ filePath: filePath })
            },
            fail: function (err) {
              resolve({ error: (err && (err.errMsg || err.errMessage)) || '转发失败' })
            },
          })
        },
        fail: function (err) {
          resolve({ error: (err && (err.errMsg || err.message)) || '写入文件失败' })
        },
      })
    } catch (e) {
      resolve({ error: (e && e.message) || '写入文件失败' })
    }
  })
}

module.exports = {
  buildFamilyExport,
  writeAndShare,
}
