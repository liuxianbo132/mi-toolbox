# 开工简报 · UI 轻量美化（前端窗口，2026-11-20）

## 目标（一句话）

纯样式层的轻量美化：建立设计令牌体系，补齐层次感与品牌温度——**不动任何业务逻辑，不阻塞 M1 真机验收**。

## 现状诊断（总控已核）

- `app.wxss` 有基础组件（card/btn/tag/form），语义三色正确，但颜色/圆角/间距全部硬编码散落各页，无统一令牌
- 无阴影/层次（卡片是纯平面）、无品牌延伸色（只有主色 #185FA5 孤立存在）、空态为纯灰字、标题层级弱、tabBar 默认配色
- 页面间同名样式重复定义（home.wxss 与 app.wxss 的 card-title/form-row/ipt 取值一致但各写一份）

## 设计方向（家庭工具 + 药品可信感）

- 主色延续 #185FA5（tabBar 与品牌一致性），衍生浅底/描边/按压态三档
- 语义三色**必须保留现有映射**：tag-red=过期/危险、tag-amber=临期注意、tag-green=安全/在库（测试断言依赖此语义）
- 温度感：卡片加极轻阴影（如 0 4rpx 16rpx rgba(0,0,0,0.04)）、空态用图标+引导文案样式、页面标题加字重与层级

## 实施清单

1. **设计令牌**：`app.wxss` 的 `page` 上用 CSS variables 声明（小程序支持）：色板（primary/-light/-press、bg、card、text-1/2/3、border、red/amber/green 三组语义色）、圆角三档（8/12/16rpx）、间距体系（8/16/24/32rpx）、字号层级（22/26/28/32/40rpx）
2. **组件重绘**：card（阴影+统一令牌）、btn-primary/ghost/warn/danger（按压态 hover-class 风格）、tag 三色（保持语义值）、ipt（focus 态描边）、空态样式（.center 系列：图标位+主文案+副文案层级）
3. **收编重复**：home.wxss 与 app.wxss 重复的 card-title/form-row/ipt 等改为引用全局（删页面内重复定义，确认视觉无回归）
4. **tabBar**：app.json 的 color/selectedColor 与令牌对齐（selectedColor 用 primary）；window 的 backgroundColor 保持浅色
5. **范围**：app.wxss + 5 个页面 wxss + components（login-panel/batch-form）wxss + app.json（仅 tabBar/window 颜色字段）

## 红线

- **js 文件零改动**（diff 自查必须为空）
- **wxml 只允许追加 class 属性**（为样式提供钩子），禁止改结构层级/删除节点/改文案/改绑定事件——测试断言依赖现有文案与操作路径
- 语义三色映射不得翻转；test-plan 相关按钮文案保持原样
- M1 验收（test-plan v2.2 八条用例）优先级高于本简报：两者冲突时先保验收

## 验收标准

1. 微信开发者工具编译通过、无样式类报错
2. `git diff` 自查：js 无变化；wxml 仅新增 class 属性；改动范围在本简报清单内
3. 前后对比截图存 `docs/evidence/ui/`（home/inventory/item/item-form/profile 五页，改前改后各一张）
4. 完成回报总控，附改动文件清单与截图路径
