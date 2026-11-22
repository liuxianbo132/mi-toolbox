# 闭环验证证据 · r53cb 环境（2026-11-20 22:19-22:20）

> 对应总控指令：启动③闭环验证（backend-resume.md 之后、M1 全套之前的准入门）。
> 验证项①②均通过 → M1 全套（test-plan v2.2，M1-01~07+S1）准入放行。
> 操作方式：用户在微信开发者工具模拟器（xiaomi-toolbox, Stable 1.06.2405010）手动执行 UI 两步；
> 后端窗口 exec_sql / user_list_end_users 核对云端终态。

## 验证① 微信编译登录 · end_users 0→1 · 无 403 ✅

- **操作**：模拟器首页点「微信一键登录」（`pages/home/home.wxml` .login-btn → `app.js` loginWithWechat → wx.login code → `cloud.auth.signInWithWechat`）
- **基线**：22:10 前后 `user_list_end_users` = `[]`（0 人）
- **终态**：22:19:34 注册 1 人（User List 实查）：
  - CreatedAt `2026-11-20T22:19:34.360954+08:00`
  - UID/Email/Name/Provider 均空值（微信 code 换 session 路径的正常形态，非邮箱注册）
  - IsAnonymous=false
- **403 消失**：R6 前双应用身份错位导致的登录 403 未复现（utils/cloud.js publicConfig 已指向 wbpk_r53cb…，链路打通）

## 验证② create_household 建家 · 邀请码 HB+6 位格式 ✅

- **操作**：登录成功后家庭名输入「四百五之家」→ 点「创建家庭」（`home.js` createHousehold 已切 `create_household` RPC，非旧两段直接插入）
- **DB 终态**（exec_sql 实查）：
  - `households` id=1, name=四百五之家, **invite_code=HBBWXC52**, created_at `22:20:14.15641`
  - `members` 1 行, role=**owner**, household_id=1（与 households.owner_id 同人）
  - 原子性：两表同一 RPC 内落库，无孤儿数据
- **格式断言**：`HBBWXC52` = `HB` 前缀 + 6 位大写字母数字（BWXC52，36 进制字符集内），总长 8，与契约 v1.6「invite_code 沿用 HB+6 位格式」精确一致；服务端生成路径（`create_household` 内 random 36 选 6）工作正常
- **时间线**：登录 22:19:34 → 创建 22:20:14，40 秒两步，顺序自洽

## M1 准入环境（开工前置状态）

- 账号 A（owner）：当前模拟器微信账号，uid 已注册（end_users 第 1 条）
- 主家庭：「四百五之家」id=1, 邀请码 HBBWXC52（M1-01 加入流用 B 账号时使用此码）
- DB 干净度：items/batches/locations/records/M2 四表全空，待 M1 用例从零构造
- cron：`mi-toolbox-miss-dose-flip` 每 5 分钟在跑（M2 用例前置已就绪）
