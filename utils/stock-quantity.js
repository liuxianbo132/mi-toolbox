function addStockQuantity(stockMap, batch) {
  if (batch.item_id == null) return
  const id = String(batch.item_id)
  const aggregate = stockMap.get(id) || { quantity: 0, unit: '', unknown: false }
  const quantity = Number(batch.quantity)
  const unit = String(batch.unit || '').trim()
  if (batch.quantity == null || batch.quantity === '' || !Number.isFinite(quantity) || quantity < 0) {
    aggregate.unknown = true
  } else if (quantity > 0) {
    aggregate.unknown = aggregate.unknown || !unit || !!(aggregate.unit && aggregate.unit !== unit)
    aggregate.quantity += quantity
    aggregate.unit = aggregate.unit || unit
  }
  stockMap.set(id, aggregate)
}

function stockQuantity(stockMap, item) {
  const stock = stockMap.get(String(item.id))
  const itemUnit = String(item.unit || '').trim()
  if (!stock) return { quantity: 0, unit: itemUnit }
  const unknown = stock.unknown || !Number.isFinite(stock.quantity) || (itemUnit && stock.unit && itemUnit !== stock.unit)
  return { quantity: unknown ? null : stock.quantity, unit: itemUnit || stock.unit }
}

module.exports = { addStockQuantity, stockQuantity }
