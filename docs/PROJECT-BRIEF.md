# 小咪工具箱 · 项目交接手册（2026-11-22 终稿）

> 用途：任何新会话 / 新接手人读这一个文件即可接续。历史细节见 `docs/evidence/`、`docs/briefs/`、`.workbuddy/memory/` 日志。

## 1. 项目是什么

家庭物品**保质期 + 用药管理**微信小程序（界面名「小咪工具箱」，注册名「家庭保质期」）。家庭成员共享一份库存；临期红/橙/绿三分级提醒；药品支持过敏档案、冲突标红、用药计划、打卡、漏服红标；V2 增扫码录入、存放位置、操作流水、拍照识别。

## 2. 环境（关键 ID）

- 生产应用 `wbapp_r53cbHLLmYxU6r3LT4wbA6`（云服务 + 已绑定小程序）；appid `wxe283d0c4444ada92`
- 冻结存档 `wbapp_mCzPMhf3up1PsJr96aYq59`——**勿删勿改勿写**
- 前端凭证：`utils/cloud.js` publicConfig（publishableKey / OAuthClientId 均指向 r53cb）
- 开发管理已托管 WorkBuddy 第三方平台（微信后台不能提审）；发布只走 WorkBuddy 应用卡「分享 / Share」体验版

## 3. 数据模型（10 表 / 5 函数 / 1 cron）

- 基础 6：`households` `members` `items`（含 visibility / barcode / pao_days）`batches`（含 production_date / opened_at / location_id）`locations` `records`
- M2 四：`allergies` `drug_allergy_links` `medication_plans` `medication_doses`
- 函数 5：`my_household_ids`（RLS 依赖）+ `join_household` / `create_household` / `leave_household` / `remove_member`（SECURITY DEFINER，一人一家庭）
- pg_cron 每 5 分钟把 `pending` 且超阈值的 doses 翻 `missed`；无云函数/服务端推送（R3 裁决）
- SQL 留档：`sql/00` 扩展 / `01` RPC / `02` 基础 schema / `03` M2 / `04` cron，全部幂等

## 4. 功能面（全部已验收）

| 阶段 | 内容 |
|---|---|
| M1 | 录入（直接填到期日 / 生产日期+保质期天数换算 **+N−1**）、看板三分区（已过期/危险期/警告期）、库存品类分组、详情（编辑/批次增删改/开封/用完/报废）、家庭（邀请码/成员管理/一人一家庭） |
| M2 | 过敏档案（本人+owner 代管）、药品过敏关联、冲突标红（禁用红/慎用橙）、用药计划（daily/alternate_day、疗程≤180 天、阈值 10-120 默认 30）、doses 整疗程一次性生成、打卡、cron 漏服红标、看板「今日漏服」红条 |
| V2 | 三页结构重排（Apple 风格）、存放位置、扫码录入（命中/未命中/取消三分支）、操作流水（create/open/use_up/discard + 查看页） |
| 增强 | 拍照识别录入（`glm-5.3-flash` 视觉模型，字段白名单/范围校验 + 30s 超时 + 隐私提示）、分类 SVG 图标与插画（无 emoji）、按钮 flex 居中修复、**大字模式**（本机偏好，11 页覆盖）、**库存搜索/品类筛选/位置筛选/三排序/分页**、**tabBar PNG 图标**、首页猫主题背景 |

## 5. 六条铁律（全部是踩过的坑）

1. **白名单**：`utils/data-access.js` 的 `*_FIELDS` 必须含全部读写字段——漏 `id`、漏 `opened_at` 各崩一次（静默 INVALID_PAYLOAD）
2. **热重载不可信**：改 `utils/` 后必须「清缓存 → 全部清除 → 重新编译」
3. **事件名全小写**：WXML 驼峰绑定名会被编译层小写化（`goAllergy` → `goallergy` 找不到）
4. **SQL 必留档**：任何结构/函数/RLS 变更落 `sql/*.sql`（幂等可重跑）；基础 schema 曾因无留档被迫逆向导出
5. **契约唯一权威**：`docs/data-contract.md` 当前 **v1.8**；语义三色映射固定不可翻转（红=过期/危险、橙=临期注意、绿=安全/在库），测试断言依赖
6. **位置删除**：严禁「先置空批次再删」（SDK 丢弃 null → 空 payload 中止），一律直接删位置 + 批次悬空 id + 显示层兜底「未指定」

## 6. 文件地图

```
pages/   home(看板) inventory(库存) item(详情/批次/用药/过敏) item-form(录入+拍照识别)
         scan(扫码) profile(我的/成员) locations(位置) records(流水) medication(用药tab)
         plan-form(计划) allergy(过敏档案)
components/  login-panel、batch-form(批次表单：直接选日期 / 生产日期+天数换算)
utils/   cloud(凭证) data-access(表访问+白名单+logRecord) constants(品类+图标)
         date(换算+分级+effectiveExpiry) plan-doses(doses生成) allergy(冲突匹配)
         vision(拍照识别) subscribe(订阅占位) workbuddy-*(SDK 层)
sql/     00/01/02/03/04 五个幂等脚本
docs/    data-contract.md(v1.8)、test-plan.md(v3.0)、evidence/(7份验收证据)、briefs/(8份简报)
```

## 7. 现状与下一步

- **状态（2026-11-23 更新）**：M1 / M2 / V2 全部关账；UI 升级两轮（Phase A 首页 + Codex Phase B 多页样式）；**发布前 P0 阻塞已排除**——漏服 cron 经 DB 只读诊断确认正常（job `active=true`、每 5 分钟 succeeded、探针剂量终态 `missed`、当日 missed 2 条）；静态自检 **108 项全 PASS**（`node scripts/verify-static.js`）
- **待办**：
  1. 真机目视确认：首页「今日漏服 2 次」红条与用药页 missed；大字模式开关/切页持久化；拍照识别链路（`cloud.llm` 可用性）；库存搜索/筛选组合
  2. 发布：应用卡「分享 / Share」→ 体验版
  3. V3 选题：昵称设置（`records.owner_name` 全空）、全量审计、位置分类（location kind）、家庭成员用量统计——风险与实施门槛见 `docs/briefs/v3-backend-risk-brief.md`
- **验收方式**：总控 `exec_sql` 查 DB 终态 + 用户真机操作（扫码/拍照必须真机，模拟器不支持）

## 8. 里程碑

- **11-19** 立项，三窗口（前端/后端/测试）+ 总控协作模式；契约 v1.0→v1.6；双应用错位 403 → 环境收敛 r53cb（含基础 schema 逆向补档）
- **11-21** M1 八条全 PASS 关账；M2 全关账（doses/打卡/cron/过敏/开封）；V2 立项（契约 v1.7→v1.8），Step1 重排验收
- **11-22** V2-01/02/03 全 PASS，V2 关账；Apple 风格 UI；三项可用性改进（居中/图标/拍照识别）
- **11-23** Codex 协作轮：Phase B 多页样式（11 页 page-root）、大字模式、库存搜索/筛选/排序/分页、tabBar PNG 图标、猫主题背景、三份验收/风险文档；总控接手：**P0 漏服阻塞经 DB 诊断排除**、vision 字段校验 + 30s 超时 + 隐私提示、首页查询上限提升、库存筛选越界防御、静态自检脚本（108 项 PASS）
