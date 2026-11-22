# 修复单 · 前端窗口（2026-11-21，M1-02 FAIL）

## 缺陷

录入页保存物品后，首批批次未落库（`batches` 表为空）。前端 toast 走「物品已保存，批次未保存」兜底路径。

## 根因（已验证）

`utils/data-access.js` 的 `ITEM_FIELDS` / `BATCH_FIELDS` 白名单不含 `id`：
- `itemsAccess.create()` 内部 `.insert(row).select(白名单)` → 返回行无 `id`
- `pages/item-form/item-form.js` 用 `created.data.id` 作为批次的 `item_id` → `undefined`
- 白名单过滤后 payload 无 `item_id` 字段 → `batches.item_id NOT NULL` 违约 → 插入失败

## 修复（两行）

`utils/data-access.js`：
- `ITEM_FIELDS` 增加 `'id'`（放数组首位便于阅读）
- `BATCH_FIELDS` 增加 `'id'`

说明：`pickFields` 写路径会跳过 `undefined` 字段，payload 不带 id 时不会把 id 写进 insert（数据库自增不受影响）；读路径 bring 回 id，`create` 返回值即含 id。

## 回归验证

1. 录入页录 `[TEST]钙片2`：生产日期 2026-11-10 + 保质期 30 天 → 到期日应显示 **2026-12-09**，保存后 toast 应为「已保存」（不得出现"批次未保存"提示）
2. DB 核对（测试窗口/总控执行）：`batches` 应新增 1 行，`item_id` = 新物品 id，`production_date='2026-11-10'`，`expiry_date='2026-12-09'`
3. 详情页对该物品「新增批次」仍正常（该路径原本可用，防回归）

## 关联影响

修复前 M1-03/M1-04/M1-07 均无批次数据可测，属阻塞项；修完由用户重录 M1-02 数据后续跑。
