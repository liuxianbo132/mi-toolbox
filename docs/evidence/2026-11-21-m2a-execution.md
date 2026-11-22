# M2a 执行证据 · 总控实查（2026-11-21 19:56）

> 环境：wbapp_r53cbHLLmYxU6r3LT4wbA6 ｜ 计划 id=1（[TEST]钙片2，daily，08:00+20:00，11-21~11-23，阈值 30）
> 判定基准：data-contract v1.7（#5/#6/#14）+ test-plan v2.2 M2-03/04/05

## M2-03 doses 生成（PASS）

- 生成 **6 条** = 3 个日历日（21/22/23）× 2 时间点（08:00/20:00），scheduled_at 全部正确、整疗程一次性生成
- plan 字段核对：times=["08:00","20:00"]、freq=daily、miss_threshold_minutes=30、status=active，与表单提交一致

## M2-04 打卡翻转（PASS）

- 用户对 11-21 20:00 剂量点「确认」→ status=**taken**，confirmed_at=`2026-11-21T19:56:14.559+08:00`（非空、写入时刻正确）

## M2-05 漏服翻转（PASS，cron 链路）

- pg_cron（每 5 分钟，jobid=1）19:55 轮次执行 `UPDATE 1` succeeded —— 将 11-21 08:00（scheduled 08:00 + 阈值 30min 已过）翻为 **missed**，confirmed_at=null
- 时序备注：计划 19:50 后保存，19:50 轮次为插入前执行（UPDATE 0 属正常），19:55 轮次正确命中——cron 无缺陷
- 中间核查排除项：job 与业务表同库（postgres-ckx9wvt2）、job 角色=表 owner 且 BYPASSRLS=true，RLS 拦截假说不成立
- UI：用药 tab 红标「漏服」+ 首页「今日漏服 1 次」红条（用户目视确认）

## M2a 关账

- 三项全部 PASS。M2b（过敏档案 / 冲突标红 / 标记开封）代码已交付（抽查痕迹齐全），真机验收入口见下：
  1. 我的页 → 我的过敏原 → 添加「海鲜」
  2. 物品详情（[TEST]钙片2）→ 过敏关联：海鲜 / 禁用
  3. 回该药品详情看冲突红标（禁用）
  4. 任一在库批次点「开封」→ 详情页到期日按 min(原到期日, 开封到期日) 变化
