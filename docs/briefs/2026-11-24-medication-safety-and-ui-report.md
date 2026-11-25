# 用药安全与卡片交互优化 · 综合交付报告

> 日期：2026-11-24  
> 执行：小二（WorkBuddy），接续 Codex 未完成任务  
> 基线：`main @ 11d4abd`（Codex 已提交并 push：低库存筛选、v3 素材入库、页面微调）  
> 本轮改动：**未 commit、未 push**，全部留在工作区供审阅  
> 约束遵守：未删除文件、未改 `.env`/密钥/CI、未执行生产 DB 写入、未 push、未动用户素材

---

## 1. 问题清单与处理结果（按 P0/P1/P2 排序）

### P0-1 过敏判断按登录用户而非服药人 —— 已修复

| 项 | 内容 |
|---|---|
| 证据 | `pages/medication/medication.js` 原 152-192 行：冲突只查登录用户（`owner_id === uid` → `myMemberId`）的过敏档案，结果 `hitsByItem[item_id]` 套到**所有计划**上；`pages/plan-form/plan-form.js` 原 `loadConflict(itemId)` 同样只按登录用户查，且 `onMemberChange` 不重算 |
| 用户影响 | 双向错误：① 登录用户过敏、服药人是家人 → 家人的计划错误显示"本人禁用"；② **登录用户不过敏、服药人过敏 → 家人的禁用冲突完全不显示**（最危险方向） |
| 证据等级 | 已验证缺陷（源码级，逻辑确定性） |
| 处理 | `medication.js`：全家过敏档案一次查询（`allergies.household_id`）+ 全部 `drug_allergy_links`，构建 `hitsByItemMember[item_id|member_id]`，按**计划服药人**取冲突；提示文案改为"成员名 禁用/慎用"（原"本人禁用"歧义消除）。`plan-form.js`：`loadConflict(itemId, memberId)` 按选中服药人查询；`onMemberChange` / `onMedicineChange` 切换后实时重算 |
| 档案未知处理 | 任一查询失败 → 所有条目显示 `冲突未知`（amber 标签 + 中性图标），**不显示为安全**；plan-form 显示"过敏档案暂时无法加载，冲突状态未知，请保存前先到过敏档案核对" |

### P0-2 禁用药物可直接确认已服 —— 已修复（客户端 + 服务端）

| 项 | 内容 |
|---|---|
| 证据 | 原 `confirmDose` 只写 status/confirmed_at，无冲突检查；WXML `canConfirm` 只看 `status === 'pending'`，`conflictKind === 'forbidden'` 时按钮照常出现 |
| 用户影响 | 服药人对药品禁用仍可一键打卡，形成"已服"假记录 |
| 证据等级 | 已验证缺陷（源码级） |
| 处理（客户端） | ① timeline 构造时 `canConfirm = pending && !forbid`，禁用时按钮替换为红字"禁用 · 不可打卡"；② `confirmDose` 内 `findDoseById` 二次拦截（防 UI 时序绕过），弹窗说明后拒绝；③ 新增**误打卡更正路径**：已打卡记录出现"更正"按钮 → 二次确认 → `taken→missed`，保留记录行不删除 |
| 处理（服务端） | 新增 `sql/07-medication-safety.sql` 的 `transition_dose(p_dose_id, p_target_status)`：SECURITY DEFINER + `my_household_ids()` 归属校验；`pending→taken` 在 SQL 内按 plan.member_id 的过敏档案校验 `drug_allergy_links`，命中 forbidden 返回 `forbidden_allergy`；合法迁移白名单仅两条（pending→taken、taken→missed），pending→missed 保留给 pg_cron |
| 更正审计说明 | doses 表无审计字段，更正操作保留原行、覆盖 status/confirmed_at，**未删任何历史数据**；如需逐条操作审计需新增表（涉及 DB 变更，按边界只标注不做） |

### P0-3 计划编辑/取消多步写入无事务 —— 已修复（原子 RPC + 前端回退）

| 项 | 内容 |
|---|---|
| 证据 | 原 `doCancelPlan`：update plan → 逐条删除未来 pending（两步）；原 `onSave` 编辑路径：update plan → removeFuturePending → createDosesBulk（三段） |
| 用户影响 | 中途失败产生"计划已取消但提醒残留"或"提醒删了新提醒没建"（重复/漏提醒） |
| 证据等级 | 已验证缺陷（源码级） |
| 处理 | `sql/07-medication-safety.sql` 新增两个幂等 RPC：`cancel_plan_atomic`（plan 置 cancelled 与删未来 pending 同事务）、`replace_future_doses(p_plan_id, p_rows jsonb)`（单事务删未来 pending + 重建，household_id/plan_id 以服务端 plan 行为准，不信任客户端） |
| 前端接入 | `doCancelPlan`、`confirmDose`、`applyCorrect`、`onSave`（编辑路径）均**优先调用 RPC，调用报错（迁移未部署）自动回退旧多步流程**——部署前行为不变，部署后获得原子性。已发生的 taken/missed 两条路径都不动 |
| 未完成部分 | RPC 属 DB 变更，按约束**未执行生产写入**；需用户审阅 `sql/07` 后在云服务控制台执行。回滚：文件头注释含三条 `DROP FUNCTION`（纯函数级，无表/数据变更） |

### P1 表单、误操作与可访问性

| 问题 | 证据等级 | 处理 |
|---|---|---|
| `#007AFF` 文字对比度 | 已核实（白底 3.68:1 < 4.5:1） | 小字文字 4 处换 `--color-primary-ink`（5.46:1 达标）：`batch-form.wxss` 的 `.bf-mode-active`/`.bf-calc`、`records.wxss` 的 `.rec-open`/`.rec-chip-active`、`item.wxss` 的 `.opened-tag`。`records.wxss` 的 `.sum-num.blue` 为 46rpx 大数字（WCAG large text ≥3:1 达标）保留 |
| 报废按钮层级 | 已核实 | `item.wxml` 批次卡"报废"从 `btn-ghost` 改 `btn-danger`（红浅底红字），与常用操作（开封/用完）拉开视觉层级；误触保护（确认弹窗）原已有（`item.js:568-581`），未重复添加 |
| 大字模式覆盖 | 已核实 | `app.wxss` 补 `.large-text .dose-forbid-text`；新组件未用 transform 缩放 |
| 读屏名称 | 源码级添加，**读屏播报未验证** | 打卡/更正/报废/开封按钮与冲突图标加 `aria-label`；标注：需真机读屏（iOS VoiceOver / 安卓 TalkBack）验证 |
| 键盘遮挡/窄屏/安全区 | 待验证 | 小程序 `input` 默认 `adjust-position`；本次未新增 fixed 底栏；标注待真机验证 |
| 拍照识别隐私说明 | 已核实（原已达标） | `item-form.wxml` 已有"照片会上传云端用于识别，请避免拍到人脸或个人信息"，手动录入路径保留，未重复修改 |
| 录入校验与补救 | 已核实（原已达标） | 名称必填、阈值 0-999 校验、批次失败提示"物品已保存，批次未保存，可在详情页补充"均已存在 |

### P2 功能卡片与页面层级

| 观察 | 处理 |
|---|---|
| 详情页批次卡 4 个操作（开封/用完/报废/点卡片编辑）密度偏高 | 报废 danger 化（见上）；开封/用完保留 ghost（高频轻操作）；"点卡片可编辑"提示保留 |
| 用药页打卡区 | 新增 `.dose-side` 纵向列（状态 + 按钮 + 禁用提示），替代原先标签与按钮并列的松散布局 |
| "我的"页数据卡（导出 + 回收站 + 操作记录） | 评估后**未拆分**：入口均已二级化，拆卡收益低、回归成本高（克制原则） |
| 各页 mascot 图重复（medication 两处用 `v3-ref/mascot/xiaomi-original-inventory-full.png`） | **未替换**：新猫咪动作/表情素材按指示跳过生成；替换需新素材到位后统一做页面映射。已在本报告 §4 标注 |

---

## 2. 猫咪素材与页面状态映射

本任务按用户指示**跳过了图片生成**，因此没有新增素材文件。当前映射现状与建议：

| 页面状态 | 当前素材 | 状态 |
|---|---|---|
| 用药页"还没有加入家庭" | `assets/illustrations/v3-ref/mascot/xiaomi-original-inventory-full.png` | 复用参考稿（120KB），与空态共用 |
| 用药页"今天没有用药安排" | 同上（同文件） | 重复使用，待"用药关怀"专用素材 |
| 首页/库存等空态 | `assets/illustrations/v3/scenes/empty-basket.png` 等 v3 正式素材 | 已入库 |

待生成素材（沿用第一阶段报告 §6 规格）：欢迎、搜索无结果、成功、提醒、库存空态、用药关怀、加载等待七态，对应 `xiaomi/expression-*` 与 `xiaomi/action-*` 命名。**注意事项保留**：`v3-ref/` 是参考稿目录（含 120KB 大图），正式页面引用参考稿属临时方案，新素材到位后应替换并保持 `v3/` 正式目录干净。

---

## 3. 实际使用的 Skills 与分工

| 项 | 说明 |
|---|---|
| Skills | **未调用** `apple-design` / `ponytail` / `ponytail-review` 工具（`D:\CodexData\CodexHome\skills` 与本会话可用列表均确认存在）。原因：改动遵循最小必要原则（全部改动有行号级缺陷证据支撑，无猜测性重构）；若需要独立复查，可对工作区 diff 跑 `ponytail-review` |
| 子代理 | 未分派。本轮改动集中在 medication/plan-form 两页与共享 SQL，文件冲突面小，串行完成一致性更高 |
| computer-use | 未使用。微信开发者工具的 setData 注入验证依赖 wechatide CLI automation 接口（本会话无此工具），GUI 控制无法完成逻辑验证，详见 §4 |

---

## 4. 验证结果与剩余风险

### 已完成验证（源码级）

| 验证 | 结果 |
|---|---|
| `node --check` medication.js / plan-form.js | 通过 |
| `node scripts/verify-static.js` | **PASS 127 / FAIL 0**（与基线 `11d4abd` 一致，已用只读 worktree 对比确认；128 是上一版 `5116c87` 的数字，检查项总数随文件/引用数动态变化） |
| `sql/07-medication-safety.sql` 结构自检 | 三个函数齐全、`$fn$` 配对平衡、幂等（CREATE OR REPLACE） |
| handler/变量绑定 | verify-static 内含 handler 与资源引用检查，FAIL 0 |

### 未覆盖验证（明确标注，不写成已通过）

| 项 | 状态 | 建议 |
|---|---|---|
| 模拟器渲染（冲突标签三态、禁用文案、更正按钮） | **未验证** | 用 wechatide CLI：`open_project_window` → 编译 → `setData` 注入 timeline（含 forbidden/unknown/taken 三种记录）→ 截图核对 |
| 真机读屏（aria-label 播报） | **未验证** | iOS VoiceOver / 安卓 TalkBack 实测 |
| RPC 行为（transition_dose 三分支、cancel/replace 原子性） | **未验证**（迁移未执行） | 在测试环境执行 `sql/07` 后，用真实登录态覆盖 `ok` / `forbidden_allergy` / `invalid_transition` |
| 真机回归（13 页全量） | **未验证** | 发布前按 `docs/test-plan.md` 流程走一遍 |

### 剩余风险

1. **RPC 回退的双写窗口**：迁移部署前后行为切换由运行时错误触发，理论上存在"RPC 部署了但网络抖动报错 → 回退直写"的窗口；两条路径均幂等，风险为低。
2. **更正审计粒度**：taken→missed 无独立审计表，仅保留记录行；如需操作留痕需 DB 变更（待立项）。
3. **allergies 全家查询量**：改为按 household 查全部过敏档案，家庭规模内（个位数成员）无性能影响；若未来家庭规模扩大可加索引（现状 `idx` 未建，量级不需要）。
4. **`docs/README`/`PROJECT-BRIEF` 契约版本口径**（v1.8 vs 实际 v2.0）仍是旧文案，本轮未动文档代码之外的口径。

---

## 5. 改动文件与 Git 变更摘要

**未 commit、未 push**，工作区状态：

```text
 M app.wxss                              (+3 大字模式补录)
 M components/batch-form/batch-form.wxss (对比度 2 处)
 M pages/item/item.wxml                  (报废按钮分级 + aria-label)
 M pages/item/item.wxss                  (对比度 1 处)
 M pages/medication/medication.js        (+226/-95 重构：按服药人冲突、打卡拦截、更正路径、RPC 回退)
 M pages/medication/medication.wxml      (冲突三态、禁用文案、更正按钮、aria-label)
 M pages/medication/medication.wxss      (dose-side 布局、禁用文字样式)
 M pages/plan-form/plan-form.js          (loadConflict 按成员、切换重算、原子 RPC 回退)
 M pages/plan-form/plan-form.wxml        (冲突横幅三态、成员名归属)
 M pages/records/records.wxss            (对比度 2 处)
?? sql/07-medication-safety.sql          (新增：3 个幂等 RPC + 回滚说明)
合计 10 文件修改 + 1 文件新增，+267 / -95
```

### 建议后续动作（需用户确认）

1. 审阅 `sql/07-medication-safety.sql`，确认后在云服务控制台执行（幂等可重跑）。
2. 执行后真机回归：服药人冲突提示、禁用打卡拦截、误打卡更正三条链路。
3. 猫咪七态素材生成到位后，替换 `v3-ref` 临时引用，完成页面映射。
4. 确认后 commit（建议 message：`fix(medication): per-member allergy conflict, dose transition guard and atomic plan RPC`）。
