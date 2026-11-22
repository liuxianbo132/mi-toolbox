# M2b 执行证据 · 总控实查（2026-11-21 20:43）

> 环境：wbapp_r53cbHLLmYxU6r3LT4wbA6 ｜ 判定基准：data-contract v1.7 + test-plan v2.2 M2-01/02 + M2b 开封项

## M2-01 过敏档案（PASS）

- DB：`allergies` 1 行 —— allergen=海鲜, member_id=1(本人), created_at=2026-11-21T20:05:16
- UI：我的页 → 成员行「过敏」入口 → 过敏档案页增删（入口事件名修复见下）

## M2-02 药品过敏关联 + 冲突标红（PASS）

- DB：`drug_allergy_links` 1 行 —— item_id=11([TEST]钙片2), allergen=海鲜, kind=forbidden
- UI：药品详情「过敏关联（1）」正常渲染；「你的过敏档案命中：海鲜（禁用）」红色命中提示 + 条目「海鲜 禁用 命中」

## 标记开封（PASS）

- DB：batches id=11 `opened_at=2026-11-21T20:43:02.927+08:00`（此前为 null）
- UI：批次行显示「已开封」、开封按钮按 `isOpened` 隐藏；详情页分级按 effectiveExpiry 口径（钙片2 无 pao_days → 回退原到期日，符合契约 v1.5）

## 期间修复（2 个）

1. **profile 过敏入口无响应**：Console 报 `does not have a method "goallergy"`——WXML 驼峰绑定名被编译层小写化 + 热重载残留；约定 WXML 事件名全小写。
2. **开封报「没有可提交的字段」**：`BATCH_FIELDS` 白名单漏 `opened_at`（M1 漏 id 的同型复发）→ 已补；且 utils 改动需「清缓存→全部清除→重新编译」才生效（热重载不刷新工具层）。

## M2 关账

- M2a（M2-03/04/05）+ M2b（M2-01/02 + 开封）全部 PASS。功能面：用品保质期（M1）+ 用药管理（M2）完整。
