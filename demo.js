"use strict";
/**
 * 示例回环:修复支付回调幂等性缺陷,4 轮对抗。
 *
 * 这里只放「事实」,不放任何显示派生量 —— 角色的 token 总计、模型采纳次数、
 * 全会话总量都由页面从事件流 reduce 出来。故这份示例与真实运行走的是同一条路径。
 */

const C = {
  proposer: "#6FD3C7", critic: "#E2707A", judge: "#E8C468", coder: "#7EA8F0",
  tester: "#63C68E", security: "#C08CF0", refactor: "#E29A6B", orch: "#8B95A2"
};

const ROLES = [
  { id: "proposer", name: "提案者",   model: "claude-opus-4",   color: C.proposer, duty: "提出最小侵入方案" },
  { id: "critic",   name: "批判者",   model: "gpt-5-codex",     color: C.critic,   duty: "找反例,永远试着推翻" },
  { id: "judge",    name: "裁判",     model: "gemini-2.5-pro",  color: C.judge,    duty: "打分与裁决,唯一能结轮的人" },
  { id: "coder",    name: "实现者",   model: "claude-sonnet-4", color: C.coder,    duty: "按裁决落地补丁" },
  { id: "tester",   name: "测试者",   model: "gpt-5-mini",      color: C.tester,   duty: "写用例并复现" },
  { id: "security", name: "安全审查", model: "claude-opus-4",   color: C.security, duty: "阻塞项审查" },
  { id: "refactor", name: "重构者",   model: "gpt-5-codex",     color: C.refactor, duty: "收口歧义写法" },
  { id: "orch",     name: "协调者",   model: "gpt-5-mini",      color: C.orch,     duty: "分派与预算" }
];

function d(lines) {
  return lines.map(function (l, i) {
    const sign = l[0];
    return { sign: sign === " " ? "" : sign, text: l.slice(1), ln: 148 + i, kind: sign };
  });
}

// "6.4k / 3.1k" → { in: 6400, out: 3100 }
function tok(s) {
  const p = s.split("/").map(function (x) { return Math.round(parseFloat(x.trim()) * 1000); });
  return { in: p[0] || 0, out: p[1] || 0 };
}

const ROUNDS = [
  {
    n: 1, title: "缺陷定位与首轮方案对抗", meta: "14:02:11 → 14:06:48 · 6 事件 · 2 分歧",
    winner: "提案者 · 方案 A", winnerRole: "proposer", score: "judge 7.5 / 10",
    conflicts: [
      { sev: "HIGH", topic: "幂等键应落在哪一层", a: "proposer", aClaim: "在 handler 入口用 provider_event_id 做数据库唯一约束，最小改动。", b: "critic", bClaim: "入口去重挡不住重试时的并发写，唯一约束会抛异常污染监控。", resolution: "采纳 A，但要求补 INSERT ... ON CONFLICT 分支", res: "ok" },
      { sev: "MED", topic: "是否引入 Redis 分布式锁", a: "critic", aClaim: "需要锁保证回调与对账任务互斥。", b: "security", bClaim: "锁失效会静默丢单，不如依赖事务级唯一索引。", resolution: "本轮搁置，转 R3 再评", res: "defer" }
    ],
    events: [
      { role: "orch", kind: "route", ts: "14:02:11", dur: "0.4s", tok: "1.2k / 0.3k", summary: "解析任务，分派 8 个角色，设定 3 轮上限",
        body: "任务：payments/webhook 重复回调导致重复入账。\n路由策略：proposer 与 critic 并行竞标 → judge 打分 → coder 实现 → tester+security 验收。\n预算：单轮 ≤ 60k tokens，总预算 400k。" },
      { role: "proposer", kind: "propose", ts: "14:02:34", dur: "11.2s", tok: "6.4k / 3.1k", summary: "方案 A：provider_event_id 唯一索引 + 事务内幂等写",
        body: "根因：handler 未对 provider_event_id 去重，Stripe 在 5xx 后会重投同一事件，导致 ledger 双写。\n\n方案 A（最小侵入）：\n1. payment_events 表新增 UNIQUE(provider, provider_event_id)\n2. handler 入口改为 INSERT ... ON CONFLICT DO NOTHING，受影响行为 0 时直接 200 返回\n3. 入账逻辑移入同一事务\n代价：一次迁移 + 约 30 行改动，无新增依赖。",
        tool: { name: "repo.search", args: 'pattern: "def handle_webhook" · glob: "payments/**/*.py"', result: "3 hits · payments/webhook/handlers.py:148 (主入口)\npayments/webhook/legacy.py:22 (已弃用)\ntests/test_webhook.py:61", status: "ok", ms: "820ms" } },
      { role: "critic", kind: "attack", ts: "14:03:19", dur: "14.8s", tok: "9.1k / 4.2k", summary: "三点反驳：并发窗口、异常污染、legacy 入口未覆盖", targets: ["proposer"],
        body: "反驳 1（并发）：ON CONFLICT 能挡住重复插入，但 ledger 入账若在应用层判断“受影响行数”，两个并发事务在 READ COMMITTED 下都可能读到 0 行 → 需显式 RETURNING id 判定。\n反驳 2（可观测性）：DO NOTHING 会吞掉真实冲突，监控上看不到重投率。建议记 duplicate_callback 计数器。\n反驳 3（覆盖面）：legacy.py:22 仍被 3 个老商户路由命中，方案 A 完全没提。\n结论：方案 A 方向正确但不完备，当前实现会在压测下漏 1~2 单。" },
      { role: "security", kind: "audit", ts: "14:04:02", dur: "6.1s", tok: "4.8k / 1.4k", summary: "补充：签名校验在去重之前，重放窗口 5 分钟偏宽",
        body: "独立于本次争议的一项风险：verify_signature 的 tolerance=300s，且校验通过后才落库。攻击者可在 5 分钟内重放同一签名事件。幂等修复后影响降级为“无害重投”，但建议同时收紧到 120s。",
        tool: { name: "code.read", args: "file: payments/webhook/security.py · range: 30-58", result: 'tolerance = int(os.getenv("STRIPE_TOLERANCE", "300"))\n# 无 nonce 缓存，无重放记录', status: "ok", ms: "210ms" } },
      { role: "judge", kind: "verdict", ts: "14:05:40", dur: "8.3s", tok: "14.2k / 1.9k", summary: "采纳方案 A（7.5/10），强制吸收批判者的 3 条修正",
        body: "打分：正确性 8 / 侵入性 9 / 完备性 6 / 可观测性 5。\n判定：采纳 proposer 方案 A 作为实现基线，但以下三项为合并前的硬性条件：\n① 用 RETURNING id 判定是否首次入账，不依赖 rowcount\n② 增加 duplicate_callback 指标\n③ legacy.py 入口共用同一去重函数\n分布式锁议题不在本轮结论内，移交 R3。" },
      { role: "coder", kind: "patch", ts: "14:06:12", dur: "19.4s", tok: "7.6k / 5.8k", summary: "实现幂等入口，抽出 claim_event() 供两个入口共用",
        body: "按裁决实现。核心是把去重收敛成一个函数，legacy 入口直接复用。",
        diff: { file: "payments/webhook/handlers.py", add: 14, del: 5, lines: d([
          " async def handle_webhook(request):",
          "     event = verify_signature(request)",
          '-    row = await db.insert("payment_events", event)',
          "-    await ledger.credit(event.amount, event.account_id)",
          '-    return JSON({"ok": True})',
          "+    claimed = await claim_event(event)",
          "+    if not claimed:",
          '+        metrics.incr("duplicate_callback", tags={"provider": event.provider})',
          '+        return JSON({"ok": True, "duplicate": True})',
          "+",
          "+    async with db.transaction():",
          "+        await ledger.credit(event.amount, event.account_id)",
          "+        await db.mark_settled(claimed.id)",
          '+    return JSON({"ok": True})'
        ]) },
        tool: { name: "patch.apply", args: "files: 2 · handlers.py, legacy.py", result: "applied · 2 files changed, 19 insertions(+), 7 deletions(-)", status: "ok", ms: "1.1s" } }
    ],
    patches: [
      { file: "webhook/handlers.py", add: 14, del: 5, by: "coder", note: "入口改为 claim_event()，重投直接 200 返回", state: "被反证", st: "bad", tests: "tests 48/50" }
    ]
  },
  {
    n: 2, title: "测试反证：并发压测下仍有双写", meta: "14:07:02 → 14:12:30 · 5 事件 · 2 分歧",
    winner: "批判者 · 反证成立", winnerRole: "critic", score: "judge 9.0 / 10",
    conflicts: [
      { sev: "HIGH", topic: "RETURNING id 是否足够", a: "coder", aClaim: "ON CONFLICT ... RETURNING 在冲突行上不返回，已能判定首次。", b: "tester", bClaim: "压测 200 并发下复现 2 次双写：settled 标记与 credit 不在同一原子步。", resolution: "反证成立，需 SELECT FOR UPDATE 收口", res: "ok" },
      { sev: "LOW", topic: "指标标签基数", a: "security", aClaim: "tags 带 account_id 会打爆时序库。", b: "orch", bClaim: "只带 provider，已按此实现。", resolution: "无冲突，关闭", res: "closed" }
    ],
    events: [
      { role: "tester", kind: "test", ts: "14:07:02", dur: "46.0s", tok: "5.2k / 2.4k", summary: "写并发压测用例，200 并发重投同一事件 × 50 轮",
        body: "构造 asyncio 并发重投，断言 ledger 只应有 1 条记录。50 轮中 48 轮通过，2 轮失败。",
        tool: { name: "test.run", args: "target: tests/test_webhook_concurrency.py -k duplicate --repeat 50", result: "FAILED 2/50 · assert ledger_rows == 1, got 2\n  round 17: 2 rows (Δ 3ms)\n  round 41: 2 rows (Δ 1ms)", status: "FAILED", ms: "46.0s" } },
      { role: "critic", kind: "attack", ts: "14:08:31", dur: "12.7s", tok: "10.4k / 3.6k", summary: "正是 R1 预判的并发窗口：claim 与 credit 不在同一原子边界", targets: ["coder", "proposer"],
        body: "claim_event 自带一个隐式事务并提交，随后才开新事务做 credit。两个请求都能成功 claim（第二个走到 DO NOTHING 却因为 mark_settled 尚未写入而被判为“未结算重试”），于是双写。\n这不是索引问题，是事务边界问题——R1 我说的第 1 条只被半吸收。" },
      { role: "coder", kind: "defend", ts: "14:09:44", dur: "9.9s", tok: "6.9k / 4.1k", summary: "部分接受：认领与入账合并进单事务，冲突行加 FOR UPDATE SKIP LOCKED", targets: ["critic"],
        body: "接受事务边界的批评，不接受“需要分布式锁”的推论。单库场景用行锁即可。",
        diff: { file: "payments/webhook/idempotency.py", add: 9, del: 4, lines: d([
          "-async def claim_event(event):",
          "-    row = await db.fetchrow(INSERT_ON_CONFLICT, event.id)",
          "-    return row",
          "+async def claim_event(event, conn):",
          "+    row = await conn.fetchrow(INSERT_ON_CONFLICT_RETURNING, event.id)",
          "+    if row is None:",
          "+        return await conn.fetchrow(SELECT_FOR_UPDATE_SKIP_LOCKED, event.id)",
          "+    return row"
        ]) } },
      { role: "tester", kind: "test", ts: "14:11:06", dur: "52.0s", tok: "4.1k / 1.8k", summary: "重跑 200 并发 × 200 轮，全绿；新增回归用例 2 条",
        body: "扩到 200 轮加大暴露概率，无失败。同时补两条用例锁死行为：重投返回 duplicate=true、legacy 入口共享去重。",
        tool: { name: "test.run", args: "target: tests/test_webhook_concurrency.py --repeat 200", result: "PASSED 200/200 · 52.0s\ncoverage payments/webhook: 71% → 93%", status: "PASSED", ms: "52.0s" } },
      { role: "judge", kind: "verdict", ts: "14:12:10", dur: "7.2s", tok: "13.8k / 2.1k", summary: "批判者本轮得分 9.0，实现者扣分；补丁转为待安全复核",
        body: "反证有可复现证据，判定成立。coder 的修正方向正确且拒绝了不必要的依赖（分布式锁），这点加分。\n本轮结论：补丁进入 R3 安全与重构复核，不再重开幂等键层级之争。" }
    ],
    patches: [
      { file: "webhook/idempotency.py", add: 9, del: 4, by: "coder", note: "认领与入账合并单事务 + FOR UPDATE SKIP LOCKED", state: "安全阻塞", st: "warn", tests: "tests 200/200" }
    ]
  },
  {
    n: 3, title: "安全复核与重构收口", meta: "14:12:44 → 14:17:20 · 5 事件 · 1 分歧",
    winner: "安全审查 · 追加两项", winnerRole: "security", score: "judge 8.0 / 10",
    conflicts: [
      { sev: "MED", topic: "SKIP LOCKED 的等待语义", a: "security", aClaim: "锁被跳过时返回 None，会走回重复入账分支。", b: "refactor", bClaim: "改成 NOWAIT 并显式返回 409，让上游重投。", resolution: "采纳 refactor 写法 + security 的告警", res: "ok" }
    ],
    events: [
      { role: "security", kind: "audit", ts: "14:12:44", dur: "11.3s", tok: "7.9k / 2.6k", summary: "两项阻塞项：SKIP LOCKED 的 None 分支、重放窗口仍为 300s",
        body: "阻塞项 1：SELECT ... FOR UPDATE SKIP LOCKED 在并发时可能返回 None，当前代码把 None 当作“可入账”，等于把并发窗口从毫秒放大到锁持有时长。\n阻塞项 2：R1 提出的 tolerance=300s 至今未处理，建议 120s + nonce 缓存 15 分钟。",
        tool: { name: "sec.scan", args: "scope: diff · rules: idempotency,replay,secrets", result: "2 blocking · 1 advisory\nB-01 idempotency/lock-skip payments/webhook/idempotency.py:19\nB-02 replay/window payments/webhook/security.py:34\nA-01 log 中含 provider_event_id（可接受）", status: "2 BLOCKING", ms: "3.4s" } },
      { role: "refactor", kind: "propose", ts: "14:13:58", dur: "8.6s", tok: "5.4k / 3.2k", summary: "NOWAIT + 409 重投语义，claim 逻辑收敛为单一出口",
        body: "把三种结果显式化为枚举 FIRST / DUPLICATE / CONTENDED，调用方按枚举分支，杜绝 None 的歧义。",
        diff: { file: "payments/webhook/idempotency.py", add: 11, del: 6, lines: d([
          "-        return await conn.fetchrow(SELECT_FOR_UPDATE_SKIP_LOCKED, event.id)",
          "+    try:",
          "+        row = await conn.fetchrow(SELECT_FOR_UPDATE_NOWAIT, event.id)",
          "+    except LockNotAvailable:",
          "+        return Claim(CONTENDED, None)",
          "+    if row.settled_at is not None:",
          "+        return Claim(DUPLICATE, row)",
          "+    return Claim(FIRST, row)"
        ]) } },
      { role: "critic", kind: "attack", ts: "14:14:52", dur: "7.4s", tok: "8.2k / 2.3k", summary: "409 会让 Stripe 无限重投；应返回 200 并异步补偿", targets: ["refactor"],
        body: "CONTENDED 返回 409 时 Stripe 会按指数退避重投，最多 3 天。若竞争是常态（对账任务扫表期间），会造成回调风暴。建议 CONTENDED 也返回 200，同时把事件投递到 settle_retry 队列由后台补偿。" },
      { role: "coder", kind: "patch", ts: "14:15:47", dur: "13.1s", tok: "6.1k / 4.4k", summary: "CONTENDED → 200 + 入 settle_retry 队列；tolerance 收紧到 120s",
        body: "同时吸收 critic 与 security 两侧意见，两处改动一并提交。",
        diff: { file: "payments/webhook/handlers.py", add: 8, del: 2, lines: d([
          "     claim = await claim_event(event, conn)",
          "+    if claim.state is CONTENDED:",
          '+        await queue.push("settle_retry", event.id, delay=2)',
          '+        metrics.incr("callback_contended")',
          '+        return JSON({"ok": True, "queued": True})',
          "     if claim.state is DUPLICATE:",
          '         metrics.incr("duplicate_callback")'
        ]) } },
      { role: "judge", kind: "verdict", ts: "14:17:02", dur: "6.9s", tok: "12.4k / 1.7k", summary: "安全审查本轮最高分；补丁可合并，遗留 1 项 advisory",
        body: "两项阻塞均已闭环，critic 的回调风暴推演避免了一次线上事故，计入加分。\n合并结论：允许合并，条件是 settle_retry 补偿任务需在同一 PR 内带测试。分布式锁议题正式关闭——单库场景无必要。" }
    ],
    patches: [
      { file: "webhook/idempotency.py", add: 11, del: 6, by: "refactor", note: "Claim 枚举 FIRST/DUPLICATE/CONTENDED，NOWAIT 收口", state: "已采纳", st: "ok", tests: "tests 200/200" },
      { file: "webhook/handlers.py", add: 8, del: 2, by: "coder", note: "CONTENDED 入 settle_retry 队列；tolerance 120s", state: "已采纳", st: "ok", tests: "tests 1284/1285" }
    ]
  },
  {
    n: 4, title: "合并前终检（进行中）", meta: "14:17:41 → 进行中", live: true,
    conflicts: [
      { sev: "OPEN", topic: "settle_retry 的最大重试次数", a: "tester", aClaim: "无上限会在下游长期故障时堆积。", b: "orch", bClaim: "交由现有队列的 DLQ 策略处理即可。", resolution: "等待裁判介入", res: "open" }
    ],
    events: [
      { role: "orch", kind: "route", ts: "14:17:41", dur: "0.3s", tok: "0.9k / 0.2k", summary: "进入终检轮：tester 先跑全量，critic 只允许 1 次反驳",
        body: "剩余预算 218k tokens。终检轮限制：仅 tester / critic / judge 可发言，单角色输出上限 4k tokens。" },
      { role: "tester", kind: "test", ts: "14:18:03", dur: "2m 14s", tok: "5.3k / 2.0k", summary: "全量套件 + 补偿任务用例，1 条 flaky",
        body: "补偿任务用例覆盖“竞争 → 队列 → 二次结算”，通过。全量套件中 test_refund_race 偶发失败，与本次改动无关（历史 flaky）。",
        tool: { name: "test.run", args: "target: tests/ --full", result: "PASSED 1284 · FAILED 1 (flaky: test_refund_race) · 2m14s", status: "1 FLAKY", ms: "2m 14s" } },
      { role: "critic", kind: "attack", ts: "14:20:38", dur: "10.2s", tok: "3.4k / 1.6k", summary: "最后一击：flaky 用例掩盖了退款与回调的共享行锁", targets: ["tester", "coder"],
        body: "test_refund_race 未必是历史 flaky——退款路径也会对 payment_events 行加锁，NOWAIT 引入后它可能命中 LockNotAvailable 而走了未处理分支。要求在断定 flaky 之前跑一次隔离复现。" }
    ],
    patches: []
  }
];

/** 摊平成 append-only 事件流 —— 真实运行时各角色 POST 上来的就是这些形状 */
function events() {
  const out = [];
  out.push({
    t: "run.start",
    session: "修复支付回调幂等性缺陷",
    repo: "repo/payments", branch: "fix/idem-callback",
    client: "claude-code · codex · opencode",
    version: "v0.4.1",
    goal: "webhook 重复回调不得重复入账，且并发压测 200×200 全绿",
    budget: { tokens: 400000 }
  });
  ROLES.forEach(function (r) { out.push(Object.assign({ t: "role.add" }, r)); });
  ROUNDS.forEach(function (rd) {
    out.push({ t: "round.start", n: rd.n, title: rd.title, meta: rd.meta });
    rd.events.forEach(function (e) {
      out.push(Object.assign({}, e, { t: "event", round: rd.n, tok: tok(e.tok) }));
    });
    rd.conflicts.forEach(function (c) { out.push(Object.assign({ t: "conflict", round: rd.n }, c)); });
    rd.patches.forEach(function (p) { out.push(Object.assign({ t: "patch", round: rd.n }, p)); });
    if (!rd.live) {
      out.push({ t: "round.end", n: rd.n, winner: rd.winner, winnerRole: rd.winnerRole, score: rd.score });
    }
  });
  /* 用量事件(聊天路径 chatusage 造出来的形状):in/out/缓存是**增量**会被下游累加,
   * ctx 是**末次上下文快照**取最新不累加 —— 预览不覆盖这个形状,改用量 UI 就得跑真回环。
   * 同名角色给两个 agent(批判者),排行合并、逐 agent 的轮内账分开这两条都能看到。 */
  [
    { agent: "agent-demo-p1", role: "提案者", type: "forge-proposer", model: "claude-opus-4",
      round: 1, in: 34, out: 3100, cr: 820000, cw: 41000, ctx: 96000, msgs: 6, tools: { Read: 9, Edit: 4 } },
    { agent: "agent-demo-c1", role: "批判者", type: "forge-critic", model: "gpt-5-codex",
      round: 1, in: 21, out: 4200, cr: 1140000, cw: 52000, ctx: 118000, msgs: 8, tools: { Read: 14, Grep: 6 } },
    { agent: "agent-demo-c2", role: "批判者", type: "forge-critic", model: "gpt-5-codex",
      round: 2, in: 8, out: 1600, cr: 430000, cw: 18000, ctx: 64000, msgs: 3, tools: { Read: 5, Grep: 3 } },
    { agent: "agent-demo-t1", role: "测试者", type: "forge-reviewer", model: "gpt-5-mini",
      round: 2, in: 12, out: 2000, cr: 610000, cw: 22000, ctx: 87000, msgs: 5, tools: { Bash: 7, Read: 4 } }
  ].forEach(function (u) {
    out.push({ t: "usage", agent: u.agent, role: u.role, agentType: u.type, model: u.model,
      round: u.round, in: u.in, out: u.out, cacheRead: u.cr, cacheWrite: u.cw,
      ctx: u.ctx, msgs: u.msgs, tools: u.tools, source: "claude 子 agent 档案" });
  });
  out.push({ t: "run.streaming", role: "judge", text: "正在生成第 4 轮反驳…" });
  return out;
}

module.exports = { events: events, ROLES: ROLES, ROUNDS: ROUNDS };
