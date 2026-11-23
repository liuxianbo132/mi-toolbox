const { cloud } = require('../../utils/cloud')
const { itemsAccess, batchesAccess } = require('../../utils/data-access')
const { categoryLabel } = require('../../utils/constants')

// 回收站（契约 v2.0 软删除）：物品组整体恢复 / 批次单条恢复；彻底删除走物理 DELETE
function pad2(n) {
  return n < 10 ? '0' + n : String(n)
}

// deleted_at 为 timestamptz，展示为本地 'M-D HH:mm'
function formatDeleted(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return (d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())
}

function todayKey() {
  const d = new Date()
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
}

// 到期日展示为 'M-D'，早于今天即视为已过期（tag-red）
function expiryRow(expiry) {
  const s = expiry ? String(expiry).slice(0, 10) : ''
  if (!s) return { expiryText: '无到期日', expired: false }
  const parts = s.split('-')
  const text = parts.length === 3 ? Number(parts[1]) + '-' + parts[2] : s
  return { expiryText: text, expired: s < todayKey() }
}

Page({
  data: {
    largeText: false,
    authState: 'checking', // checking | signed-out | no-household | ready
    householdId: null,
    itemRows: [],
    batchRows: [],
    busy: false, // 恢复/彻底删除防连点
  },

  onShow() {
    this.setData({ largeText: getApp().globalData.largeText })
    this.restore()
  },

  async restore() {
    this.setData({ authState: 'checking' })
    try {
      const { data: session, error } = await getApp().ensureSession()
      if (error || !session) {
        this.setData({ authState: 'signed-out', householdId: null, itemRows: [], batchRows: [] })
        return
      }
      await this.loadHousehold()
    } catch (e) {
      this.setData({ authState: 'signed-out' })
    }
  },

  // session → members 取本人 household_id（与 profile.js 查法一致）
  async loadHousehold() {
    const { data: session } = await cloud.auth.getSession()
    const uid = session && session.user && session.user.id
    if (!uid) {
      this.setData({ authState: 'signed-out' })
      return
    }
    const { data: mine } = await cloud.database
      .from('members')
      .select('household_id')
      .eq('owner_id', uid)
      .limit(1)
    const row = mine && mine[0]
    if (!row) {
      this.setData({ authState: 'no-household', householdId: null, itemRows: [], batchRows: [] })
      return
    }
    this.setData({ authState: 'ready', householdId: row.household_id })
    await this.loadTrash(row.household_id)
  },

  async loadTrash(hid) {
    if (!hid) return
    const itemRes = await cloud.database
      .from('items')
      .select('id, name, category, deleted_at')
      .eq('household_id', hid)
      .eq('is_deleted', true)
      .order('deleted_at', { ascending: false })
      .limit(200)
    if (itemRes.error) {
      wx.showToast({ title: itemRes.error.message, icon: 'none' })
      return
    }
    const batchRes = await cloud.database
      .from('batches')
      .select('id, item_id, expiry_date, quantity, unit, deleted_at')
      .eq('household_id', hid)
      .eq('is_deleted', true)
      .order('deleted_at', { ascending: false })
      .limit(500)
    if (batchRes.error) {
      wx.showToast({ title: batchRes.error.message, icon: 'none' })
      return
    }
    // 名称映射不过滤 is_deleted：给批次行显示所属物品名（含已删物品）
    const nameRes = await cloud.database
      .from('items')
      .select('id, name')
      .eq('household_id', hid)
      .limit(500)
    const deletedItems = itemRes.data || []
    const deletedIds = {}
    const itemRows = deletedItems.map(function (it) {
      const key = String(it.id)
      deletedIds[key] = true
      return {
        id: it.id,
        name: it.name || '未命名物品',
        categoryText: categoryLabel(it.category),
        deletedText: formatDeleted(it.deleted_at),
      }
    })
    const nameMap = {}
    ;(nameRes.data || []).forEach(function (it) {
      nameMap[String(it.id)] = it.name || '未命名物品'
    })
    // 所属物品也被软删的批次不单列：用户从物品组整体恢复，避免恢复出孤儿批次
    const batchRows = []
    ;(batchRes.data || []).forEach(function (b) {
      const key = String(b.item_id)
      if (!nameMap[key] || deletedIds[key]) return
      const exp = expiryRow(b.expiry_date)
      batchRows.push({
        id: b.id,
        itemName: nameMap[key],
        expiryText: exp.expiryText,
        expired: exp.expired,
        deletedText: formatDeleted(b.deleted_at),
      })
    })
    this.setData({ itemRows: itemRows, batchRows: batchRows })
  },

  canAct(id) {
    if (this.data.busy) return false
    return id !== undefined && id !== null && id !== ''
  },

  // 恢复物品：只写 is_deleted=false（deleted_at 不参与判断，SDK 会丢弃 null）
  // 成功后级联恢复该物品下全部软删批次，单条失败不中断，最后按失败条数提示
  async onrestoreitem(e) {
    const id = e.currentTarget.dataset.id
    if (!this.canAct(id)) return
    this.setData({ busy: true })
    wx.showLoading({ title: '恢复中', mask: true })
    let title = '已恢复'
    let icon = 'success'
    try {
      const res = await itemsAccess.update(id, { is_deleted: false })
      if (res.error || !res.data) {
        title = (res.error && res.error.message) || '恢复失败'
        icon = 'none'
      } else {
        const hid = this.data.householdId
        const { data: rows } = await cloud.database
          .from('batches')
          .select('id')
          .eq('household_id', hid)
          .eq('item_id', id)
          .eq('is_deleted', true)
          .limit(500)
        const list = rows || []
        let failed = 0
        for (let i = 0; i < list.length; i++) {
          const r = await batchesAccess.update(list[i].id, { is_deleted: false })
          if (r.error || !r.data) failed++
        }
        if (failed > 0) {
          title = '已恢复物品，' + failed + ' 条批次未成功'
          icon = 'none'
        }
      }
    } catch (err) {
      title = '恢复失败'
      icon = 'none'
    }
    wx.hideLoading()
    wx.showToast({ title: title, icon: icon })
    this.setData({ busy: false })
    await this.loadTrash(this.data.householdId)
  },

  async onrestorebatch(e) {
    const id = e.currentTarget.dataset.id
    if (!this.canAct(id)) return
    this.setData({ busy: true })
    wx.showLoading({ title: '恢复中', mask: true })
    let title = '已恢复'
    let icon = 'success'
    try {
      const res = await batchesAccess.update(id, { is_deleted: false })
      if (res.error || !res.data) {
        title = (res.error && res.error.message) || '恢复失败'
        icon = 'none'
      }
    } catch (err) {
      title = '恢复失败'
      icon = 'none'
    }
    wx.hideLoading()
    wx.showToast({ title: title, icon: icon })
    this.setData({ busy: false })
    await this.loadTrash(this.data.householdId)
  },

  // 彻底删除物品：二次确认 → 物理删除该物品的全部批次（含已软删）→ 再删物品
  onpurgeitem(e) {
    const id = e.currentTarget.dataset.id
    if (!this.canAct(id)) return
    const that = this
    wx.showModal({
      title: '彻底删除',
      content: '将永久删除该物品及其全部批次，彻底删除后不可恢复',
      confirmColor: '#A32D2D',
      success(res) {
        if (!res.confirm) return
        that.purgeItem(id)
      },
    })
  },

  async purgeItem(id) {
    if (this.data.busy) return
    this.setData({ busy: true })
    wx.showLoading({ title: '删除中', mask: true })
    let title = '已彻底删除'
    let icon = 'success'
    try {
      const { data: rows } = await cloud.database
        .from('batches')
        .select('id')
        .eq('household_id', this.data.householdId)
        .eq('item_id', id)
        .limit(1000)
      const list = rows || []
      let failed = 0
      for (let i = 0; i < list.length; i++) {
        const r = await batchesAccess.remove(list[i].id)
        if (r.error || !r.data) failed++
      }
      const res = await itemsAccess.remove(id)
      if (res.error || !res.data) {
        title = (res.error && res.error.message) || '删除失败'
        icon = 'none'
      } else if (failed > 0) {
        title = '物品已删除，' + failed + ' 条批次未删除'
        icon = 'none'
      }
    } catch (err) {
      title = '删除失败'
      icon = 'none'
    }
    wx.hideLoading()
    wx.showToast({ title: title, icon: icon })
    this.setData({ busy: false })
    await this.loadTrash(this.data.householdId)
  },

  onpurgebatch(e) {
    const id = e.currentTarget.dataset.id
    if (!this.canAct(id)) return
    const that = this
    wx.showModal({
      title: '彻底删除',
      content: '彻底删除后不可恢复',
      confirmColor: '#A32D2D',
      success(res) {
        if (!res.confirm) return
        that.purgeBatch(id)
      },
    })
  },

  async purgeBatch(id) {
    if (this.data.busy) return
    this.setData({ busy: true })
    wx.showLoading({ title: '删除中', mask: true })
    let title = '已彻底删除'
    let icon = 'success'
    try {
      const res = await batchesAccess.remove(id)
      if (res.error || !res.data) {
        title = (res.error && res.error.message) || '删除失败'
        icon = 'none'
      }
    } catch (err) {
      title = '删除失败'
      icon = 'none'
    }
    wx.hideLoading()
    wx.showToast({ title: title, icon: icon })
    this.setData({ busy: false })
    await this.loadTrash(this.data.householdId)
  },
})
