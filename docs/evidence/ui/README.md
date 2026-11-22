# UI 美化验收截图 · 状态说明

## 当前状态

- 本轮 UI 轻量美化（ui-polish-brief 2026-11-20）已完成，编译通过、js/wxml 零改动（md5 自查）。
- **前后对比截图未完成**：本机微信开发者工具 1.06.2405010 的自动化通道（`cli auto` + miniprogram-automator，已试 0.12.1 与 latest 两版）握手成功但协议调用无响应，无法程序化截图；需人工在 IDE 模拟器中截取。

## 人工截图指引（五页 × 改前/改后）

命名约定：`{页面}-{before|after}.png`，存本目录。

| 页面 | 路径 | 截图要点 |
|---|---|---|
| home | /pages/home/home | 统计卡阴影、临期条目层级 |
| inventory | /pages/inventory/inventory | 顶部新增按钮、列表行、空态图标位 |
| item-form | /pages/item-form/item-form | 表单卡片、批次 segmented 控件 |
| item | /pages/item/item?id=<真实批次物品id> | 详情卡、在库/历史批次分组、按钮 |
| profile | /pages/profile/profile | 成员列表、角色标签、「我」标记 |

改前样式还原：解压 `baseline-wxss-before.tar.gz` 中对应文件覆盖工程同名文件（文件名中 `_` 对应路径 `/`，如 `pages_home_home.wxss` → `pages/home/home.wxss`），重新编译后截图，再换回新样式。

## 已核项

- 编译：DevTools CLI `preview` 通过，包体 285.5 KB，无报错
- 改动范围：app.wxss / app.json（tabBar color）/ 6 页面 wxss / batch-form.wxss，均在简报清单内
- js、wxml 文件与改前基线 md5 全一致（零改动）
