# M1 执行证据链 · 总控实查（2026-11-21 19:29）

> 环境：wbapp_r53cbHLLmYxU6r3LT4wbA6 ｜ 家庭：四百五之家 id=1（邀请码 HBBWXC52）
> 方式：总控 exec_sql 终态核对 + node 纯函数断言（脚本证据见本文件 §断言）；用户真机操作
> 判定基准：data-contract v1.7 + test-plan v2.2（D 基准 2026-11-21）

## 逐条判定

| 用例 | 判定 | 证据 |
|---|---|---|
| M1-01 家庭创建/加入/互见 | **PASS** | 首轮 members 2 行同 household_id=1（owner id=1 于 11-20 22:20 建家；member id=2 于 11-21 18:40:32 加入）；UI 互见经用户目视 |
| M1-02 录入+换算 | **PASS（修复后）** | items id=11 `[TEST]钙片2`(medicine)；batches id=11：production_date=2026-11-10，**expiry_date=2026-12-09**（+N−1 口径精确命中）→ data-access 白名单补 id 的修复生效，批次成功随物品落库 |
| M1-03 临期分级边界 | **PASS** | 纯函数 8/8：药品 6/7 天 danger、8 天 warn；食品 2/3 天 danger、4 天 warn；今天到期 danger；已过期 expired。8 条数据在看板（[TEST]M103-*），色标经用户目视 |
| M1-04 报废/用完 | **PASS（补验）** | 报废链路：batches id=2(药品6天)、id=6(食品3天) status=**discarded**；用完链路（19:32 补验）：batches id=5(食品2天) status=**used** → 两条分支均生效，看板按 active 过滤符合契约 v1.5 |
| M1-05 visibility 默认值 | **PASS** | 全部 11 条 items visibility='household'（前端不传值，列 default 生效） |
| M1-06 成员关系变更 | **PASS** | 终态 members 仅 1 行（owner）——B 退出→重加→被移除链路终态正确；过程性断言（B 退出后不可见、owner 调用退出被拒）经用户口述确认 |
| M1-07 开封分级 | **PASS** | 纯函数：effectiveExpiry(2027-01-01, opened 2026-11-19, pao 3)=2026-11-21 → left=0 → danger；数据 `[TEST]M107-开封探针`（pao_days=3, opened_at=2026-11-19T08:00+08）在库，看板色标经用户目视 |
| M1-S1 重复加入分支 | **PASS（口述）** | DB 无痕迹；用户执行重加流程，提示「已在家庭中」；后端 RPC 逻辑 already_joined 已在 sql/01 审阅 |

## 纯函数断言输出（node 直跑 utils/date.js）

```
PASS medicine N=6  calc=2026-11-27 left=6  level=danger
PASS medicine N=7  calc=2026-11-28 left=7  level=danger
PASS medicine N=8  calc=2026-11-29 left=8  level=warn
PASS food     N=2  calc=2026-11-23 left=2  level=danger
PASS food     N=3  calc=2026-11-24 left=3  level=danger
PASS food     N=4  calc=2026-11-25 left=4  level=warn
PASS medicine N=0  calc=2026-11-21 left=0  level=danger
PASS food     N=-1 calc=2026-11-20 left=-1 level=expired
PASS 开封 effectiveExpiry=2026-11-21 left=0 level=danger
RESULT pass=9 fail=0
```

## 遗留项

- **无。M1 八条（M1-01~07 + S1）全绿，2026-11-21 19:32 关账。** M2 准入放行。

## 期间修复记录

- **M1-02 首轮 FAIL 根因**：utils/data-access.js 的 ITEM_FIELDS/BATCH_FIELDS 白名单不含 id → itemsAccess.create() 返回无 id → batches.item_id=undefined → NOT NULL 拒插。修复：两白名单加 'id'（docs/briefs/fix-item-id.md）。
