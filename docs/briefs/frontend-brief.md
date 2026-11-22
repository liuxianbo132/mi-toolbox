# 开工简报 · 前端窗口

## 你是谁

负责小咪工具箱 V1 前端实现的窗口。工程：D:/Code/Project/mi-toolbox（原生小程序 + @tencent-ai/workbuddy-cloud-sdk 云数据层）。

## 开工前必读（按序）

1. `docs/data-contract.md` —— 字段名以此为准，禁止自造
2. `.workbuddy/memory/2026-11-19.md` —— 需求拍板结论（两里程碑、药品增强范围、名称统一）
3. `utils/workbuddy-data-access.js` —— 数据读写复用 `createTableAccess`，不要绕过它裸写增删改

## 你的领地（只许改这些）

- `pages/`（新增录入页或改造 pages/item/item）、`components/`、`app.json`（M1 不加 tab，M2 才加「用药」tab）、`app.wxss`、`sitemap.json`
- `utils/` 仅允许新增文件或给 `date.js` 补纯函数；`utils/cloud.js` 的 publicConfig 一字不动

## 禁区

- 云数据库结构 / RLS / RPC：后端窗口领地。查询报"表不存在/无权限"→ 回报总控，不要自行改结构
- `sql/`、`docs/`、`.workbuddy/`：不写
- 删除文件、git push：红线，先问用户

## M1 任务（顺序执行）

1. 录入页：物品表单（name/category/unit/brand/spec）+ 批次（expiry_date 支持「生产日期+保质期天数」换算，date.js 已有 toDateOnly；quantity/unit）
2. `pages/item` 详情页：物品信息 + 批次列表 + 新增批次 / 报废(status='discarded') / 用完(status='used') / 编辑 / 删除
3. 库存页可写化：列表项可点进详情 + 顶部新增按钮
4. home 看板条目点击跳详情
5. 订阅授权收集：录入成功后、看板首屏各埋一次 `wx.requestSubscribeMessage`（模板 id 未定时留 TODO 常量，等总控下发）
6. 微信开发者工具编译通过 + 自测一轮

**依赖说明**：任务 1-4 不依赖后端，可全程推进；任务 5 的模板 id 是唯一外部依赖，留 TODO 不阻塞。

## 汇报格式

完成后在对话里列：改动文件清单、契约字段是否全部对齐、编译结果、TODO 清单（如模板 id 占位）。
