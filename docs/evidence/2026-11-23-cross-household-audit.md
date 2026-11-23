# 跨家庭关联完整性审计（只读）· 2026-11-23

> 依据：`docs/briefs/v3-backend-risk-brief.md` P1「跨家庭关联完整性」｜ 方式：总控 `exec_sql` 只读 SELECT，未做任何修复/DDL
> 目的：为「是否可在生产加复合 FK 约束」提供数据前提

## 审计结果（2026-11-23 19:05）

| 关联关系 | 语义要求 | 错配行数 |
|---|---|---|
| `batches.item_id → items.id` | 必须同 household | **0** |
| `batches.location_id → locations.id` | 非空时必须同 household（允许悬空） | **0** |
| `allergies.member_id → members.id` | 必须同 household | **0** |
| `drug_allergy_links.item_id → items.id` | 必须同 household | **0** |
| `medication_plans.item_id → items.id` | 必须同 household | **0** |
| `medication_plans.member_id → members.id` | 必须同 household | **0** |
| `medication_doses.plan_id → medication_plans.id` | 必须同 household | **0** |
| `records.batch_id → batches.id` | 快照关联，允许悬空 | **0** |
| 同一 `owner_id` 归属多个家庭 | 契约：一人一家庭 | **无违规**（分组 HAVING > 1 无结果） |

## 结论

1. **当前数据干净**：8 组关系全部 0 错配，一人一家庭无违规 → 实施复合 FK 约束**无存量数据阻塞**
2. **仍需前置**：约束方案（哪些关系加复合唯一键 + 复合 FK、`records` 与悬空 location 的例外）、迁移脚本、回滚方案、非生产环境验证——属 V3 实施项，本次不执行
3. **审计可复跑**：本报告 SQL 均为只读，可在加约束前后重复执行作为回归基线

## 备注

- 本审计只证明「此刻数据干净」，不代表写入路径已安全：RLS 允许的写操作仍依赖调用方传对 `household_id`（见 v3-backend-risk-brief 的风险描述）
- 建议在实施 FK 前，对「新增写入后是否引入错配」再做一次同样审计
