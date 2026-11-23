# V3 决策候选：一人一家庭的并发竞态（2026-11-23）

> 状态：**决策候选，本文档不执行任何变更**——不含 DDL/DML、不创建索引、不替换函数、不修改契约。
> 依据：`sql/01-rpc-household.sql`（v1.2）、`sql/02-base-schema.sql`、`docs/data-contract.md` v1.4、`docs/briefs/v3-backend-risk-brief.md`「P1：一人一家庭并发竞态」。
> 文中所有 SQL 均为**只读**审计/验证查询，可在只读账号或 `exec_sql` 只读通道执行。

## 结论先行

| 项 | 结论 |
|---|---|
| 风险是否成立 | **成立**。两个 RPC 都是「先 SELECT 判断、再 INSERT」，唯一约束只有 `(household_id, owner_id)`；并发下同一 `owner_id` 可落入两个家庭。 |
| 推荐方案 | **A + B 组合（编号 A 为主、B 为辅）**：`members.owner_id` 唯一索引作最终防线，`join_household` / `create_household` 加 `pg_advisory_xact_lock` 保证返回码友好。**A 必须落地，B 是体验层**。 |
| 只有 A 够不够 | 够「正确」，但用户会看到原始 `23505 duplicate key` 文案，且 `create_household` 需要异常块包裹整个子事务，否则留孤儿家庭。 |
| 只有 B 够不够 | **不够**。`members` 对 `authenticated` 有 INSERT 权限且 RLS `WITH CHECK (owner_id = auth.uid())`，可绕过 RPC 直写成员行；锁只覆盖两个 RPC。 |
| 冲突返回码 | 沿用 `'already_joined'`，不新增码、前端零改动；契约只加一句语义注记。 |
| 实施门槛 | 生产只读审计「重复归属 = 0、`owner_id` 无 NULL」+ 非生产并发四用例通过 + 回滚脚本备好。 |

## 1. 问题复述

### 1.1 现网实现

`join_household`（`sql/01-rpc-household.sql:56-66`）：

```sql
IF EXISTS (SELECT 1 FROM public.members WHERE owner_id = v_uid) THEN
  RETURN 'already_joined';
END IF;
SELECT id INTO v_hid FROM public.households WHERE invite_code = p_code;
IF v_hid IS NULL THEN RETURN 'not_found'; END IF;
INSERT INTO public.members (household_id, owner_id, role) VALUES (v_hid, v_uid, 'member');
```

`create_household`（`sql/01-rpc-household.sql:99-124`）同样是 `EXISTS` 判断 → INSERT households → INSERT members。

### 1.2 为什么约束拦不住

| 事实 | 出处 | 后果 |
|---|---|---|
| 唯一约束是 `members_household_id_owner_id_key UNIQUE (household_id, owner_id)` | `sql/02-base-schema.sql:61` | 只拦「同一人重复进同一家」 |
| `owner_id` 上只有普通索引 `idx_members_owner` | `sql/02-base-schema.sql:110` | 无全局唯一性保证 |
| `EXISTS` 判断不加锁，默认隔离级为 READ COMMITTED | PG 默认行为 | 两个事务读不到对方未提交行，都判定「尚无家庭」 |
| 两行 `household_id` 不同 | 竞态必然 | 唯一约束对两行都成立，**两次 INSERT 都成功** |

### 1.3 竞态时间线（join 两家）

| 时刻 | T1（join A 家，member 角色） | T2（join B 家，member 角色） | 数据库可见 |
|---|---|---|---|
| t1 | `EXISTS` → false | — | members 无该 uid |
| t2 | — | `EXISTS` → false | 同上（T1 未提交） |
| t3 | `INSERT (A, uid, 'member')` | — | 仅 T1 可见 |
| t4 | `COMMIT` → `'ok'` | — | 1 行 |
| t5 | — | `INSERT (B, uid, 'member')` 无冲突 | 约束按 (B,uid) 判定 → 通过 |
| t6 | — | `COMMIT` → `'ok'` | **2 行，契约被违反** |

### 1.4 影响面

| 场景 | 终态 | 严重度 |
|---|---|---|
| join ∥ join | 用户在两个家庭各有一条 member 行；`my_household_ids()` 返回 2 个 id，RLS 让两个家庭的数据都可见；`leave_household` 按 `joined_at` 只删最早一条，剩余一条继续「隐身持有」 | 高：数据可见范围超出用户认知 |
| create ∥ create | 产生 **2 个 households** + 2 条 owner 成员行；第二个家庭无其他成员但邀请码有效，可被别人加入 → 幽灵家庭 | 高：脏家庭无法用现有 RPC 解散（owner 不可退出） |
| join ∥ create | 同上，且哪个家庭「有效」取决于时序，用户端 UI 显示不确定 | 高 |
| 顺序重复调用（双击） | 第二次命中 `already_joined`，行为正确 | 无：现有验收只覆盖了这一类 |

### 1.5 旁路：RPC 不是唯一写入通道

`members` 的 `GRANT INSERT ... TO authenticated`（`sql/02-base-schema.sql:173`）与 `members_all` 的 `WITH CHECK (owner_id = auth.uid())`（`:145`）意味着：**任何已登录用户都可用 SDK 直接向任意 `household_id` 插入自己的成员行**，完全跳过两个 RPC 的判断。任何只作用于 RPC 的方案（锁、应用层串行）都无法覆盖这条路径——这是推荐 A 的关键理由。

## 2. 方案对比

| 方案 | 机制 | 优点 | 缺点 | 冲突暴露形态 | 对未来多家庭的影响 |
|---|---|---|---|---|---|
| **A. `owner_id` 全局唯一索引** | `CREATE UNIQUE INDEX ... ON members(owner_id)`（或部分索引 `WHERE owner_id IS NOT NULL`） | 数据库级最终防线；覆盖 RPC 与 SDK 直写；一处生效、以后新增入口自动受保护；实现最简单 | 把「一人一家庭」写死进表结构；历史脏数据会阻塞建索引；裸冲突对前端不友好 | `23505 unique_violation`，`constraint/index` 名为 `members_owner_id_key`，message 含 `duplicate key value` | 若将来放多家庭需先删索引并重定契约（可接受：多家庭本就要重设计 RPC 与 RLS） |
| **B. advisory lock** | 两个 RPC 入口处 `PERFORM pg_advisory_xact_lock(hashtext(v_uid)::bigint)`，置于 `EXISTS` 之前 | 不改表结构、保留多家庭弹性；冲突方拿到的仍是 `'already_joined'`，前端无感 | 所有写入入口必须同键同位置，漏一个即失效；不覆盖 SDK 直写；键是 32 位哈希，存在极小概率不同用户互相排队（只损并发度、不损正确性）；部署需两函数同批切换 | 不产生错误，返回业务码 | 弹性最好 |
| **C. 沿用现状 + 应用层串行** | 前端 `familyBusy` 防抖、云函数单实例队列、失败重试 | 零数据库变更 | **不可靠**：多端（两台手机/小程序+Web）天然并发；客户端防抖只防同一端双击；无共享互斥、无跨实例协调；重试反而放大窗口；DB 直写完全绕过 | 无（错误被静默接受） | 无影响，因为根本没解决 |
| **D. 单语句原子写** | `INSERT INTO members ... SELECT ... WHERE NOT EXISTS (...)` | 少一次往返，看起来「原子」 | **无效**：READ COMMITTED 下两个事务仍各看到空集，且无共享行/谓词锁可互斥；结论与现状相同 | 无 | 同 A/B 之间，不解决 |

> 备注：`SERIALIZABLE` 隔离级 + 冲突重试理论上可行，但要求所有读写路径统一隔离级并在 SDK 层实现重试，成本高于 A，本文不展开推荐。

## 3. 推荐

**推荐 A + B，分两步落地，A 为门槛、B 为体验。**

1. **A 先行（必须）**：`members.owner_id` 唯一索引。理由是它同时封住 §1.5 的 SDK 直写通道，而这条通道 B 永远管不到。没有 A，任何「应用层约定」都可以被一次手写 SDK 调用推翻。
2. **B 随后（强烈建议）**：在 A 之上加 `pg_advisory_xact_lock`，把并发冲突从「异常」转成「正常返回码」。A 单独上线时冲突方会收到 `23505`，`pages/home/home.js:457-459` 会把 `res.error.message` 原样 toast 出来（英文、含表名），属可接受但不合格的体验。
3. **不做 C，也不靠 D**：C 是把并发问题降级为「用户手速问题」，与契约「RPC 层强制一人一家庭」的表述直接矛盾。

实施顺序上，两步必须**同一次变更窗口**：先加索引，再替换两个函数。若先换函数后加索引，锁能挡住 RPC 层但仍留直写窗口；若加索引后长期不换函数，用户会周期性看到报错。

## 4. 迁移前审计（只读）

目标：确认索引可建、脏数据可解释。四条查询，期望值均为 `0 行 / 0`。

**4.1 同一 `owner_id` 多家庭成员行（存在即阻塞建索引）**

```sql
-- 只读
SELECT owner_id,
       count(*)                                   AS member_rows,
       array_agg(household_id ORDER BY joined_at) AS households,
       array_agg(role       ORDER BY joined_at)   AS roles
FROM public.members
GROUP BY owner_id
HAVING count(*) > 1
ORDER BY member_rows DESC;
```

**4.2 `owner_id` 是否为 NULL（决定用限定索引还是裸索引）**

```sql
-- 只读
SELECT count(*) AS null_owner_rows
FROM public.members
WHERE owner_id IS NULL;
```

`owner_id` 现为 `NOT NULL DEFAULT auth.uid()`，理论上恒为 0。若出现 NULL，说明有绕开默认值的写入路径，需先查明来源；部分索引写法为 `CREATE UNIQUE INDEX members_owner_id_key ON public.members (owner_id) WHERE owner_id IS NOT NULL;` —— 与裸索引语义差别仅在「未来若放开可空，NULL 行不参与唯一性」。

**4.3 `households.owner_id` 与其 owner 成员行是否错位（历史竞态残留）**

```sql
-- 只读
SELECT h.id AS household_id, h.owner_id, h.created_at, m.household_id AS member_household_id
FROM public.households h
LEFT JOIN public.members m ON m.owner_id = h.owner_id AND m.role = 'owner'
WHERE m.id IS NULL OR m.household_id <> h.id
ORDER BY h.created_at DESC;
```

> 另需一条规模分布查询（`households LEFT JOIN members` 后 `HAVING count(m.id)=0`）确认是否存在 0 成员家庭——即 §1.4 的幽灵家庭残留。处置口径需单独裁决：**保留哪一条成员关系**（一般取 `joined_at` 最早者，并让 `households.owner_id` 与之对齐）、多余家庭是删除还是标记，均不在本文档授权范围内。

## 5. 冲突时的返回码

### 5.1 建议

| 场景 | 建议返回 | 前端现状（无需改动） |
|---|---|---|
| join：并发下唯一冲突 | `'already_joined'` | 「已在家庭中，请先退出再加入」+ `loadHousehold()`（`home.js:490-493`） |
| create：并发下唯一冲突 | `'already_joined'` | 同款提示 + `loadHousehold()`（`home.js:461-464`） |
| 未登录 / 邀请码不存在 | `'not_signed_in'` / `'not_found'` | 不变 |

**不新增 `'conflict'` 类码**，理由：冲突发生时的客观事实就是「该账号已在某个家庭里」，`already_joined` 语义准确；前端已有分支可直接复用，避免契约升版与前端同步发布。代价是日志层面难以区分「顺序重复调用」与「真并发」，可在函数内 `RAISE LOG` / `RAISE WARNING` 记录，不进入返回值。

### 5.2 实现要点（B 落地时）

- **锁键必须在 `EXISTS` 之前获取**，且两个函数、以及未来任何新增成员写入口必须同键：`pg_advisory_xact_lock(hashtext(v_uid)::bigint)`。`hashtext` 返回 `integer`，单参 advisory lock 只接受 `bigint`，**必须显式转型**，否则报 `42883`。
- 锁是**事务级**（`_xact_`），函数返回即释放；不得换成会话级 `pg_advisory_lock`，否则连接复用会持锁泄漏。
- `create_household` 捕获唯一冲突时，**异常块必须包住「INSERT households + INSERT members」整段**：

```sql
-- 示意（本次不执行）
BEGIN
  INSERT INTO public.households ... RETURNING id INTO v_hid;
  INSERT INTO public.members (household_id, owner_id, role) VALUES (v_hid, v_uid, 'owner');
EXCEPTION WHEN unique_violation THEN
  RETURN 'already_joined';   -- 子事务整体回滚，households 不会残留
END;
```

plpgsql 的 `EXCEPTION` 会建立子事务，**只回滚该块内的语句**；若只包住 members 那条 INSERT，已插入的 households 会存活 → 正是 §1.4 的幽灵家庭。这是本方案最容易写错的一处。

等价写法是 `INSERT ... ON CONFLICT (owner_id) DO NOTHING RETURNING id`，但 `create_household` 的成员行依赖 households 主键，仍绕不开「成员冲突后撤销 households」，因此不推荐替代异常块。

## 6. 实施门槛与回滚

### 6.1 进入实施前

1. 总控书面确认「一人一家庭」仍是长期规则，且接受未来多家庭需删索引重建。
2. §4 三条审计全部为 0（或脏数据已有批准的处置决议）。
3. 非生产环境（测试应用，非生产 `wbapp_r53cbHLLmYxU6r3LT4wbA6`）完成 6.2 全部用例。
4. 变更前用 `pg_get_functiondef` 保存两个函数的当前定义，作为回滚基线；同时记录 `pg_indexes` 中 `members` 的索引清单。

### 6.2 并发验证用例（必须在非生产执行）

| # | 用例 | 断言 |
|---|---|---|
| 1 | 两个会话同时 `join_household` 不同邀请码 | 恰一个 `'ok'`、一个 `'already_joined'`；`count(*) FROM members WHERE owner_id=uid` = 1 |
| 2 | `join_household` 与 `create_household` 并发 | 终态只有 1 条成员行；`households` 中该 uid 名下 = 1；无 0 成员家庭新增 |
| 3 | 两个 `create_household` 并发 | 只建 1 个 households；另一次返回 `'already_joined'`；**无孤儿 households 行** |
| 4 | 同一请求快速重复 3 次（模拟双击） | 仅一次 `'ok'`，其余 `'already_joined'`，无 `23505` 直达前端 |
| 5 | SDK 直写 `members`（绕过 RPC）插入第二个家庭 | 被 `23505` 拒绝（此用例只适用于方案 A 已上线） |
| 6 | 回归：未登录 / `not_found` / `owner_cannot_leave` / `remove_member` | 返回值与改造前一致 |

并发手法建议：两个 psql 会话 `BEGIN` 后按 §1.3 顺序交叉执行并观察阻塞；或用临时测试函数注入 `pg_sleep` 放大窗口。**不得在生产数据上构造并发**。

### 6.3 回滚

| 变更 | 回滚动作 | 注意 |
|---|---|---|
| 唯一索引 | `DROP INDEX public.members_owner_id_key;` | 低流量可直接删；大表可 `DROP INDEX CONCURRENTLY`（不能在事务块内）。`CREATE INDEX CONCURRENTLY` 失败会留下 `indisvalid=false` 的索引，建后须查 `pg_index` 确认有效，失败索引先删再重建 |
| 两个函数 | 用 6.1 保存的定义回滚，或重跑 `sql/01-rpc-household.sql`（v1.2 幂等） | **先回滚函数、再删索引**：若只删索引而函数仍依赖冲突捕获，行为退化为「无保护但返回码正常」的静默状态，比现状更危险 |
| 顺序建议 | 索引与函数同窗口上线、同窗口回滚 | 跨窗口的半成品状态（有索引无捕获 / 有捕获无索引）都不可长期停留 |

## 7. 边界声明

本文档**不执行**任何 DDL/DML、不修改 `sql/` 下文件、不触碰生产数据、不替换函数；§5.2 的 SQL 为示意片段，只说明事务边界，不是可执行脚本。实施需另立变更单，附 §4 审计结果、§6.2 验证记录与回滚脚本，经总控批准后执行。
