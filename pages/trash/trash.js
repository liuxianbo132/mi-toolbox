const { cloud } = require('../../utils/cloud')
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
  const text = '到期 ' + (parts.length === 3 ? Number(parts[1]) + '-' + parts[2] : s)
  return { expiryText: text, expired: s < todayKey() }
}

Page({
  data: {
    largeText: false,
    authState: 'checking',
    contentState: 'loading',
    contentLimited: false,
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
    const request = (this.loadRequest || 0) + 1
    this.loadRequest = request
    this.setData({ authState: 'checking', householdId: null, itemRows: [], batchRows: [] })
    try {
      const { data: session, error } = await getApp().ensureSession()
      if (request !== this.loadRequest) return
      if (error) throw error
      const uid = session && session.user && session.user.id
      if (!uid) {
        this.setData({ authState: 'signed-out' })
        return
      }
      const membership = await cloud.database.from('members').select('household_id').eq('owner_id', uid).limit(1)
      if (request !== this.loadRequest) return
      if (membership.error) throw membership.error
      const row = membership.data && membership.data[0]
      if (!row) {
        this.setData({ authState: 'no-household' })
        return
      }
      this.setData({ authState: 'ready', contentState: 'loading', householdId: row.household_id })
      await this.loadTrash(row.household_id)
    } catch (e) {
      if (request === this.loadRequest) this.setData({ authState: 'error' })
    }
  },

  retrytrash() { this.restore() },

  async loadTrash(hid) {
    if (!hid) return
    const request = this.loadRequest
    this.setData({ contentState: 'loading' })
    try {
      const [itemRes, batchRes] = await Promise.all([
        cloud.database.from('items').select('id, name, category, deleted_at')
          .eq('household_id', hid).eq('is_deleted', true)
          .order('deleted_at', { ascending: false }).limit(201),
        cloud.database.from('batches').select('id, expiry_date, deleted_at, items(name, is_deleted)')
          .eq('household_id', hid).eq('is_deleted', true)
          .order('deleted_at', { ascending: false }).limit(501),
      ])
      if (request !== this.loadRequest) return
      if (itemRes.error || batchRes.error) throw itemRes.error || batchRes.error
      const items = itemRes.data || []
      const batches = batchRes.data || []
      const itemRows = items.slice(0, 200).map((item) => ({
        id: item.id,
        name: item.name || '未命名物品',
        categoryText: categoryLabel(item.category),
        deletedText: formatDeleted(item.deleted_at),
      }))
      // 物品尚在回收站时，关联批次随物品恢复。
      const batchRows = batches.slice(0, 500)
        .filter((batch) => batch.items && !batch.items.is_deleted)
        .map((batch) => ({
          id: batch.id,
          itemName: batch.items.name || '未命名物品',
          ...expiryRow(batch.expiry_date),
          deletedText: formatDeleted(batch.deleted_at),
        }))
      this.setData({ itemRows, batchRows, contentState: 'ready', contentLimited: items.length > 200 || batches.length > 500 })
    } catch (error) {
      if (request === this.loadRequest) this.setData({ contentState: 'error' })
    }
  },

  canAct(id) {
    if (this.data.busy || this.data.contentState !== 'ready' || !this.data.householdId) return false
    return id !== undefined && id !== null && id !== ''
  },

  onrestoreitem(e) { return this.applyTrashAction(e.currentTarget.dataset.id, 'item', false) },
  onrestorebatch(e) { return this.applyTrashAction(e.currentTarget.dataset.id, 'batch', false) },
  onpurgeitem(e) { this.confirmPurge(e.currentTarget.dataset.id, 'item') },
  onpurgebatch(e) { this.confirmPurge(e.currentTarget.dataset.id, 'batch') },

  confirmPurge(id, type) {
    if (!this.canAct(id)) return
    const request = this.loadRequest
    wx.showModal({
      title: '彻底删除',
      content: type === 'item'
        ? '将永久删除这件物品及其全部批次。此操作无法撤销。'
        : '将永久删除这个批次。此操作无法撤销。',
      confirmText: '彻底删除',
      confirmColor: '#C4271E',
      success: (res) => {
        if (res.confirm && this.loadRequest === request) this.applyTrashAction(id, type, true)
      },
    })
  },

  async applyTrashAction(id, type, purge) {
    if (!this.canAct(id)) return
    const request = this.loadRequest
    const verb = purge ? '彻底删除' : '恢复'
    this.setData({ busy: true })
    wx.showLoading({ title: verb + '中…', mask: true })
    let title = '已' + verb
    let icon = 'success'
    try {
      const args = {
        p_item_id: type === 'item' ? id : null,
        p_batch_id: type === 'batch' ? id : null,
      }
      if (!purge) args.p_deleted = false
      const { data, error } = await cloud.database.rpc(purge ? 'purge_stock_deleted' : 'set_stock_deleted', args)
      if (error || data !== 'ok') {
        const messages = {
          inactive_item: '请先恢复所属物品',
          not_found: '记录已变化，请刷新',
          not_in_trash: '记录已恢复，请刷新',
          referenced: '物品有关联的用药数据，无法彻底删除',
        }
        throw new Error(messages[data] || verb + '失败，请重试')
      }
    } catch (error) {
      title = error.message || verb + '失败，请重试'
      icon = 'none'
    } finally {
      wx.hideLoading()
      this.setData({ busy: false })
    }
    if (this.loadRequest !== request) return
    wx.showToast({ title, icon })
    await this.loadTrash(this.data.householdId)
  },
})
