# 小咪工具箱

家庭物品**保质期 + 用药管理**微信小程序（界面名「小咪工具箱」，注册名「家庭保质期」）。

家庭成员共享一份库存；临期按红/橙/绿三分级提醒；药品支持过敏档案、冲突标红、用药计划、打卡与漏服红标；V2 增扫码录入、存放位置、操作流水与拍照识别。

## 功能

| 模块 | 内容 |
|---|---|
| 库存与保质期 | 录入（直接填到期日，或生产日期 + 保质期天数换算）、看板三分区（已过期 / 危险期 / 警告期）、品类分组、批次增删改、开封 / 用完 / 报废 |
| 家庭协作 | 邀请码加入、成员管理、一人一家庭门禁 |
| 用药管理 | 过敏档案、药品过敏关联、冲突标红（禁用红 / 慎用橙）、用药计划（每日 / 隔日，疗程 ≤180 天）、整疗程 doses 一次性生成、打卡、cron 漏服翻转 |
| V2 增强 | 存放位置、扫码录入（命中 / 未命中 / 取消三分支）、操作流水（create / open / use_up / discard）、拍照识别录入 |

## 技术栈

- 微信小程序原生（WXML / WXSS / JS），无框架
- 云端：WorkBuddy Cloud Service（PostgreSQL，行级权限 RLS 隔离家庭数据）
- 定时任务：`pg_cron` 每 5 分钟把超阈值的 `pending` doses 翻为 `missed`
- 视觉识别：`glm-5.3-flash` 多模态模型

## 目录结构

```
pages/         home 看板 · inventory 库存 · item 详情 · item-form 录入
               scan 扫码 · profile 我的 · locations 位置 · records 流水
               medication 用药 · plan-form 计划 · allergy 过敏档案
components/    login-panel 登录面板 · batch-form 批次表单
utils/         cloud 凭证 · data-access 表访问与字段白名单 · constants 品类图标
               date 日期换算与分级 · plan-doses 疗程生成 · allergy 冲突匹配 · vision 拍照识别
sql/           00 扩展 · 01 RPC · 02 基础 schema · 03 用药模块 · 04 cron（全部幂等可重跑）
docs/          data-contract 数据契约 · test-plan 测试计划 · evidence 验收证据 · briefs 开发简报
```

## 本地运行

1. 微信开发者工具导入项目根目录
2. 终端执行 `npm install`，再点开发者工具「工具 → 构建 npm」
3. 修改 `utils/cloud.js` 中的 `publicConfig`，填入你自己的云端 `publishableKey` 与 `workbuddyOAuthClientId`

> 本仓库中的 `publishableKey` 属可公开凭证（小程序前端本就会将其打包，抓包可见），数据安全由云端 RLS 行级权限保证，不依赖该字符串保密。

## 数据模型

- 基础 6 表：`households` `members` `items` `batches` `locations` `records`
- 用药 4 表：`allergies` `drug_allergy_links` `medication_plans` `medication_doses`
- 业务函数 5 个：`my_household_ids`（RLS 依赖）、`join_household` / `create_household` / `leave_household` / `remove_member`（SECURITY DEFINER，一人一家庭）
- 字段与常量语义以 [`docs/data-contract.md`](docs/data-contract.md) 为唯一权威

## 开发约定

几条踩过坑才立下的规则，改动前值得先看：

1. `utils/data-access.js` 的 `*_FIELDS` 白名单必须包含全部读写字段——漏字段会静默返回 `INVALID_PAYLOAD`
2. 修改 `utils/` 后必须「清缓存 → 全部清除 → 重新编译」，热重载不刷新工具层模块
3. WXML 事件绑定名一律小写，驼峰名会被编译层小写化导致找不到处理函数
4. 任何结构 / 函数 / RLS 变更都要落 `sql/*.sql` 留档，保持幂等可重跑
5. 三色语义固定不可翻转（红 = 过期/危险，橙 = 临期注意，绿 = 安全/在库）
