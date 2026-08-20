"use strict";
/**
 * 示例回环:修复支付回调幂等性缺陷,3 轮对抗(第 3 轮进行中)。
 *
 * ★ 阵容必须是**现在这个产品真实的样子**(实测被问「demo 里怎么还有协调者」):
 *   - 3 个模型角色:实现者(propose) / 反驳者(attack) / 复核者(audit) —— 即
 *     forge-proposer / forge-critic / forge-reviewer 三个子 agent;
 *   - +1 个非模型角色:判据(gate,代码跑命令,零 token);
 *   - **没有「协调者」这个角色** —— 协调者是宿主会话本身,不进角色表,
 *     它的账也摊不出来(usage 层的 soloLabel 才叫协调者,那是另一条路)。
 *   老 demo 的 8 角色竞标裁决(提案者/裁判/实现者…)是本地驱动模式时代的剧本,已废。
 *
 * 这里只放「事实」,不放任何显示派生量 —— 角色的 token 总计、全会话总量
 * 都由页面从事件流 reduce 出来。故这份示例与真实运行走的是同一条路径、同一批形状:
 * loop_say 的 event、gate 的 test 事件(meta.met)、round.end、run.streaming 心跳、
 * chatusage 的 usage 事件(增量 + ctx 快照)。
 */

const ROLES = [
  { id: "r1", name: "实现者", model: "claude-sonnet-5", color: "#6FD3C7", kind: "propose",
    duty: "修复反驳者挖出的问题,最小侵入落地" },
  { id: "r2", name: "反驳者", model: "claude-opus-5", color: "#E2707A", kind: "attack",
    duty: "只读挖掘:找反例、边界、触发路径" },
  { id: "r3", name: "复核者", model: "claude-sonnet-5", color: "#E8C468", kind: "audit",
    duty: "判绿后复核:真修好还是糊弄判据" }
];
const GATE = { id: "gate", name: "判据", model: "确定性 · 无模型", color: "#5B6470",
  duty: "跑 pytest -q tests/webhook" };

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

// 判据事件:跟 hostrun.gate() 落盘的形状一字不差(meta.met 是界面判「过没过」的唯一依据)
function gateEv(round, ts, dur, met, summary, output, value) {
  return { t: "event", round: round, role: "gate", kind: "test", ts: ts, dur: dur,
    tok: { in: 0, out: 0 },
    summary: (met ? "达标 · " : "未达标 · ") + summary,
    body: summary + (output ? "\n--- 命令输出（尾部）---\n" + output : ""),
    meta: { met: met, exitCode: met ? 0 : 1, value: value == null ? null : value,
      broken: false, executor: "code" } };
}

const ROUNDS = [
  {
    n: 1, title: "第 1 轮对抗", meta: "14:02:11 → 14:08:03",
    end: { winner: "未达标", winnerRole: null, score: "退出码 1 · 用例 48/50（2 个并发用例红）" },
    conflicts: [
      { sev: "HIGH", topic: "幂等键应落在哪一层", a: "r1",
        aClaim: "在 handler 入口用 provider_event_id 做数据库唯一约束，最小改动。", b: "r2",
        bClaim: "入口去重挡不住重试时的并发写，DO NOTHING 还会吞掉真实冲突。",
        resolution: "方案保留,但必须补 RETURNING id 判定与 duplicate 计数", res: "ok" }
    ],
    events: [
      { role: "r1", kind: "route", ts: "14:02:11", dur: "0.3s", tok: "0.9k / 0.2k",
        summary: "已派出实现者（sonnet），开始读仓库定位重复入账根因",
        body: "任务：payments/webhook 重复回调导致重复入账。判据：pytest -q tests/webhook。\n预算：8 轮 / 3600s / 零进展 2 轮停。" },
      { role: "r1", kind: "propose", ts: "14:02:58", dur: "11.2s", tok: "6.4k / 3.1k",
        summary: "方案：provider_event_id 唯一索引 + 事务内幂等写",
        body: "根因：handler 未对 provider_event_id 去重，Stripe 在 5xx 后会重投同一事件，导致 ledger 双写。\n\n最小侵入改法：\n1. payment_events 表新增 UNIQUE(provider, provider_event_id)\n2. handler 入口改为 INSERT ... ON CONFLICT DO NOTHING\n3. 入账逻辑移入同一事务",
        tool: { name: "Grep", args: 'pattern: "def handle_webhook" · payments/**/*.py',
          result: "3 hits · payments/webhook/handlers.py:148 (主入口)\npayments/webhook/legacy.py:22 (已弃用但仍有 3 个老商户路由)\ntests/test_webhook.py:61", status: "ok", ms: "820ms" } },
      { role: "r1", kind: "patch", ts: "14:04:12", dur: "19.4s", tok: "7.6k / 5.8k",
        summary: "实现幂等入口，抽出 claim_event() 供两个入口共用",
        body: "把去重收敛成一个函数，legacy 入口直接复用。",
        diff: { file: "payments/webhook/handlers.py", add: 14, del: 5, lines: d([
          " async def handle_webhook(request):",
          "     event = verify_signature(request)",
          '-    row = await db.insert("payment_events", event)',
          "-    await ledger.credit(event.amount, event.account_id)",
          '-    return JSON({"ok": True})',
          "+    claimed = await claim_event(event)",
          "+    if not claimed:",
          '+        metrics.incr("duplicate_callback")',
          '+        return JSON({"ok": True, "duplicate": True})',
          "+    async with db.transaction():",
          "+        await ledger.credit(event.amount, event.account_id)",
          "+        await db.mark_settled(claimed.id)",
          '+    return JSON({"ok": True})'
        ]) } },
      { role: "r2", kind: "attack", ts: "14:06:31", dur: "14.8s", tok: "9.1k / 4.2k",
        summary: "挖到 3 条：并发窗口、DO NOTHING 吞冲突、legacy 入口未覆盖", targets: ["r1"],
        body: "① 并发：claim 与 credit 不在同一原子边界,200 并发下两个事务都能走进入账分支（触发路径：round 17/41 的 Δ3ms 窗口）。\n② 可观测性：DO NOTHING 吞掉真实冲突,监控上看不到重投率。\n③ 覆盖面：legacy.py:22 仍被 3 个老商户命中,补丁没碰它。" }
    ],
    patches: [
      { file: "webhook/handlers.py", add: 14, del: 5, by: "r1",
        note: "入口改为 claim_event()，重投直接 200 返回", state: "被反证", st: "bad", tests: "tests 48/50" }
    ]
  },
  {
    n: 2, title: "第 2 轮对抗", meta: "14:08:20 → 14:15:44",
    end: { winner: "未达标", winnerRole: null, score: "退出码 1 · 用例 49/50（SKIP LOCKED 的 None 分支仍红）" },
    conflicts: [
      { sev: "HIGH", topic: "RETURNING id 是否足够", a: "r1",
        aClaim: "ON CONFLICT ... RETURNING 在冲突行上不返回，已能判定首次。", b: "r2",
        bClaim: "压测复现 2 次双写：settled 标记与 credit 不在同一原子步。",
        resolution: "认领与入账合并单事务 + FOR UPDATE 收口", res: "ok" }
    ],
    events: [
      { role: "r1", kind: "route", ts: "14:08:20", dur: "0.3s", tok: "0.8k / 0.2k",
        summary: "已派出实现者（sonnet），修复上一轮挖出的 3 条" },
      { role: "r1", kind: "patch", ts: "14:10:05", dur: "22.1s", tok: "6.9k / 4.1k",
        summary: "认领与入账合并进单事务，冲突行加 FOR UPDATE SKIP LOCKED",
        body: "接受事务边界的批评。单库场景用行锁即可,不引入分布式锁。",
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
      { role: "r2", kind: "attack", ts: "14:13:58", dur: "12.7s", tok: "10.4k / 3.6k",
        summary: "复检：并发窗口已闭合；新挖 1 条 —— SKIP LOCKED 返回 None 时被当成可入账", targets: ["r1"],
        body: "锁被跳过时 claim_event 返回 None,当前代码把 None 当作「可入账」,等于把并发窗口从毫秒放大到锁持有时长。要求显式化三种结果:FIRST / DUPLICATE / CONTENDED。" }
    ],
    patches: [
      { file: "webhook/idempotency.py", add: 9, del: 4, by: "r1",
        note: "认领与入账合并单事务 + FOR UPDATE SKIP LOCKED", state: "被反证", st: "bad", tests: "tests 49/50" }
    ]
  },
  {
    n: 3, title: "第 3 轮对抗", meta: "14:16:02 → 进行中", live: true,
    conflicts: [
      { sev: "OPEN", topic: "CONTENDED 返回 409 还是 200", a: "r2",
        aClaim: "409 会让 Stripe 指数退避重投 3 天，竞争常态化时是回调风暴。", b: "r1",
        bClaim: "改 200 + 事件进 settle_retry 队列由后台补偿。", resolution: "反驳者复检中", res: "open" }
    ],
    events: [
      { role: "r1", kind: "route", ts: "14:16:02", dur: "0.3s", tok: "0.7k / 0.2k",
        summary: "已派出实现者（sonnet），显式化 Claim 三态并处理 CONTENDED" },
      { role: "r1", kind: "patch", ts: "14:18:40", dur: "16.3s", tok: "6.1k / 4.4k",
        summary: "Claim 枚举 FIRST/DUPLICATE/CONTENDED；CONTENDED → 200 + settle_retry 队列",
        diff: { file: "payments/webhook/idempotency.py", add: 11, del: 6, lines: d([
          "-        return await conn.fetchrow(SELECT_FOR_UPDATE_SKIP_LOCKED, event.id)",
          "+    try:",
          "+        row = await conn.fetchrow(SELECT_FOR_UPDATE_NOWAIT, event.id)",
          "+    except LockNotAvailable:",
          "+        return Claim(CONTENDED, None)",
          "+    if row.settled_at is not None:",
          "+        return Claim(DUPLICATE, row)",
          "+    return Claim(FIRST, row)"
        ]) } }
    ],
    patches: [
      { file: "webhook/idempotency.py", add: 11, del: 6, by: "r1",
        note: "Claim 枚举 FIRST/DUPLICATE/CONTENDED，NOWAIT 收口", state: "复检中", st: "warn", tests: "复检中" }
    ]
  }
];

/** 摊平成 append-only 事件流 —— 真实运行时宿主 loop_say / gate 落盘的就是这些形状 */
function events() {
  const out = [];
  out.push({
    t: "run.start",
    session: "修复支付回调幂等性缺陷",
    repo: "repo/payments", branch: "fix/idem-callback",
    client: "宿主 agent", version: "host", mode: "host",
    goal: "pytest -q tests/webhook",
    budget: { rounds: 8, seconds: 3600, noProgressRounds: 2, tokens: 0 }
  });
  ROLES.forEach(function (r) { out.push(Object.assign({ t: "role.add" }, r)); });
  out.push(Object.assign({ t: "role.add" }, GATE));
  ROUNDS.forEach(function (rd) {
    out.push({ t: "round.start", n: rd.n, title: rd.title, meta: rd.meta });
    rd.events.forEach(function (e) {
      out.push(Object.assign({}, e, { t: "event", round: rd.n, tok: e.tok ? tok(e.tok) : null }));
    });
    // 判据每轮收口(与 hostrun.gate 同形状);进行中的轮还没跑到判据
    if (rd.n === 1) out.push(gateEv(1, "14:07:15", "46.2s", false,
      "退出码 1 · 用例 48/50", "FAILED tests/test_webhook_concurrency.py::test_duplicate (round 17: 2 rows)\nFAILED ... (round 41: 2 rows)\n48 passed, 2 failed in 46.2s"));
    if (rd.n === 2) out.push(gateEv(2, "14:15:02", "51.8s", false,
      "退出码 1 · 用例 49/50", "FAILED tests/test_webhook_concurrency.py::test_lock_skipped_branch\n49 passed, 1 failed in 51.8s"));
    (rd.conflicts || []).forEach(function (c) { out.push(Object.assign({ t: "conflict", round: rd.n }, c)); });
    (rd.patches || []).forEach(function (p) { out.push(Object.assign({ t: "patch", round: rd.n }, p)); });
    if (rd.end) {
      out.push(Object.assign({ t: "round.end", n: rd.n }, rd.end));
    }
  });
  /* 用量事件(聊天路径 chatusage 造出来的形状):in/out/缓存是**增量**会被下游累加,
   * ctx 是**末次上下文快照**取最新不累加 —— 预览不覆盖这个形状,改用量 UI 就得跑真回环。
   * 反驳者给两个 agent:排行合并、逐 agent 的轮内账分开,这两条都能在预览里看到。 */
  [
    { agent: "agent-demo-p1", role: "实现者", type: "forge-proposer", model: "claude-sonnet-5",
      round: 1, in: 34, out: 8900, cr: 820000, cw: 41000, ctx: 96000, msgs: 9, tools: { Read: 9, Edit: 6, Bash: 3 } },
    { agent: "agent-demo-c1", role: "反驳者", type: "forge-critic", model: "claude-opus-5",
      round: 1, in: 21, out: 4200, cr: 1140000, cw: 52000, ctx: 118000, msgs: 8, tools: { Read: 14, Grep: 6 } },
    { agent: "agent-demo-p2", role: "实现者", type: "forge-proposer", model: "claude-sonnet-5",
      round: 2, in: 18, out: 4100, cr: 640000, cw: 27000, ctx: 88000, msgs: 6, tools: { Read: 5, Edit: 4, Bash: 2 } },
    { agent: "agent-demo-c2", role: "反驳者", type: "forge-critic", model: "claude-opus-5",
      round: 2, in: 8, out: 3600, cr: 430000, cw: 18000, ctx: 64000, msgs: 5, tools: { Read: 8, Grep: 3 } }
  ].forEach(function (u) {
    out.push({ t: "usage", agent: u.agent, role: u.role, agentType: u.type, model: u.model,
      round: u.round, in: u.in, out: u.out, cacheRead: u.cr, cacheWrite: u.cw,
      ctx: u.ctx, msgs: u.msgs, tools: u.tools, source: "claude 子 agent 档案" });
  });
  /* 工具流(hostrun 同款):进行中那一轮里「此刻在动什么手」。
   * ★ 真跑时这些**不入档** —— 只推给正在看的人(server.js 的 emit)。示例是罐头档案,
   *   只能靠 append 灌进来才看得见;别照着这里以为线上也往 run.jsonl 里写。
   * 形状与 chatusage.createFeed 出来的一模一样:kind=tool 时 name 是工具名,
   * err 是跑不通的命令(成功的结果不播),text 是角色自己说的话。 */
  const T0 = 1756000000000;
  [ { kind: "tool", name: "Read", text: "pay.js:88" },
    { kind: "tool", name: "Grep", text: "event_id  pay.js" },
    { kind: "tool", name: "Bash", text: "node -e \"require('./pay.js')\" | head" },
    { kind: "err", text: "Exit code 1  AssertionError: 同一 event_id 第二次仍然入账" },
    { kind: "text", text: "重放窗口只挡了 5 分钟内的 —— 跨窗口的第二次回调照样进账" },
    { kind: "tool", name: "Read", text: "pay.js:120" },
    { kind: "tool", name: "Grep", text: "SELECT .* FROM payments  pay.js" }
  ].forEach(function (f, i) {
    out.push(Object.assign({ t: "feed", round: 3, role: "r2", actor: "r2",
      agent: "agent-demo-c3", ts: T0 + i * 4000 }, f));
  });
  // 静默看门狗的心跳:能观察到就报观察(它的档案在长),措辞不带「多半」——
  // 有工具流之后这才是常态;兜底那句「多半在等实现者修」只在读不到档案时才出现
  out.push({ t: "run.streaming", role: "gate", actor: "r2",
    text: "第 3 轮 · 距上一条发言已 96s（反驳者正在干活 —— 它的档案 3s 前还在更新）" });
  return out;
}

module.exports = { events: events, ROLES: ROLES, ROUNDS: ROUNDS };
