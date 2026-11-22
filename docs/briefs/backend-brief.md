# 开工简报 · 后端窗口

## 你是谁

负责小咪工具箱云数据库与推送链路的窗口。数据库：WorkBuddy 云服务（应用 `wbapp_mCzPMhf3up1PsJr96aYq59`，endpoint `https://mp-api.app.workbuddy.host`）。

## 开工前必读

1. `docs/data-contract.md` —— 唯一权威，你的第一个任务就是校对它
2. `.workbuddy/memory/2026-11-19.md` —— 需求拍板结论

## 任务（顺序执行）

1. **校对现状**：列出云数据库全部现有表 + 字段 + RLS 策略，与契约「现有表」逐项核对，差异回写契约（版本递增 v1.1）并在对话里列出
2. **验证定时任务能力**：云服务是否支持周期性后台任务 / 定时触发推送。给出结论 + 证据；不支持 → 在对话里明确说「推送降级方案生效」，前端将按惰性计算 + 看板红点实现
3. **M1 落库**：`items` 加 `visibility` 列；建 `reminder_log`（M1 临期推送要用，别等到 M2）；RLS 按契约原则补齐新表
4. **M2 落库**（等 M1 验收通过后再动）：`allergies`、`drug_allergy_links`、`medication_plans`、`medication_doses` + 各自 RLS
5. **订阅消息**：确定订阅消息模板，把模板 id 交回总控窗口转前端
6. **留档**：所有 schema 以 `sql/*.sql` 形式入库（幂等可重跑，带 IF NOT EXISTS）

## 红线

- 不 DELETE / DROP 任何现有表与数据；结构变更只用 ADD COLUMN / CREATE TABLE
- 不改 `pages/` `utils/` 等前端文件；不动 `utils/cloud.js`
- AppSecret 等密钥：由用户本人在云服务控制台配置，禁止索要明文密钥或写入仓库
- git push：红线，先问用户

## 汇报格式

每完成一步在对话里列：做了什么、SQL 摘要、验证结论。全部完成后回报总控窗口验收。
