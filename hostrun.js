"use strict";
/**
 * 宿主驱动模式的服务端状态机。
 *
 * 谁执行:**宿主 agent**(Claude Code / Codex / opencode …)。它已经有模型访问权,
 * 所以这里一个 key 都不需要、一次模型调用都不发。
 *
 * 那这层还剩什么用?—— 剩下的正是**不能交给模型自己做**的两件事:
 *   1. 达标与否(gate):模型有充分动机说「已达标」。判定必须是代码算的。
 *   2. 还能不能继续(budget/轮数/零进展):同理,不能由被限制的人自己宣布放行。
 *
 * 所以 begin/say/gate/end 是一套**带状态的协议**,而不是四个无关接口:
 * `end(goal_met)` 在 gate 没真的判过之前会被拒 —— 这条拒绝是这层存在的理由。
 */

const gate = require("./gate.js");
const chatusage = require("./chatusage.js");   // 聊天那条路的真模型/真用量(读 Claude Code 自己的子 agent 档案)
const judge = require("./judge.js");
const i18n = require("./i18n.js");   // 事件里机器写的话按回环 lang 出(用户点名:UI 文字跟对话语言)   // 评审判据（不可量化目标）—— 判定人是独立评审者，不是协调者

/* 停止原因的**键**是协议;给协调者看的 label 用英文表(提示词一律英文),
 * 给用户看的翻译在 TUI/网页各自的词典里按 run.lang 取。
 * ★ 评审判定/角色上报**单列**,绝不混进 goal_met —— 命令退出码可复现,模型的话不可;
 * ★ idle_spin/stalled 是「流程出了问题」不是「没达标」,各占一条,不许糊成 no_progress。 */
const REASONS = i18n.TABLES.en.reasons;

function stamp() {
  const d = new Date();
  const p = function (n) { return String(n).padStart(2, "0"); };
  return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}

function create(append) {
  const st = {
    active: false, cfg: null, round: 0, startedAt: 0,
    lastValue: null, noProgress: 0, gatePassed: false,
    turns: 0, endedReason: null,
    // 协调者的流程监控:判据输出指纹(没 metric 时靠它判零进展)、连续空跑轮数、
    // 本轮有没有人真的改过东西。
    // ⚠ actedThisRound 有**三态**:true=动过 / false=观察到没动 / null=不知道。
    //   「不知道」绝不能当成「没动」—— 补丁台账本来就靠 agent 自己报,而它们经常不报;
    //   把「没报」算成「空跑」会把健康的回环误杀,比没有这个检测更糟(踩过)。
    lastFp: null, idleRounds: 0, actedThisRound: null, stalls: []
  };

  /* 聊天里驱动那条路的账:执行者(用户的会话)不向我们报,但它派出去的**子 agent**
   * 每个都被 Claude Code 单独存了档(模型 + 逐条 usage)。这里定期去把新增的那部分
   * 读过来,角色行才有真模型、真 token,而不是「宿主模型 / token 不可得」。
   * 拿不到就当没有 —— 任何异常都不许影响回环本身(fail-open)。 */
  let puller = null;
  function pullChatUsage() {
    if (!puller) return;
    try {
      const evs = puller.pull(st.round);
      if (evs.length) addUsage(evs);
    } catch (_) { puller = null; }   // 一次读挂就别再试了,别在每条发言上重复报错
  }

  // usage 事件统一从这走:落账 + 给 token 预算计数(total 汇总帧不重复计)
  function addUsage(evs) {
    (evs || []).forEach(function (e) {
      append(e);
      if (e.t === "usage" && !e.total) st.tokensUsed += (e.in || 0) + (e.out || 0);
    });
  }

  function remaining() {
    if (!st.active) return { rounds: 0, seconds: 0 };
    return {
      // null = 不限轮。不用 Infinity:JSON.stringify 会把它悄悄变成 null,不如一开始就明说
      rounds: st.cfg.budget.rounds === 0 ? null
        : Math.max(0, st.cfg.budget.rounds - st.round),
      // seconds:0 跟 rounds/tokens 同一套规矩 —— 0 = 不限时,回 null 而不是让
      // Math.max(0, 负数) 悄悄夹成 0(那样首次 loop_gate 就会当成 budget_time 停掉)
      seconds: st.cfg.budget.seconds === 0 ? null
        : Math.max(0, Math.round(st.cfg.budget.seconds - (Date.now() - st.startedAt) / 1000)),
      tokens: st.cfg.budget.tokens === 0 ? null
        : Math.max(0, st.cfg.budget.tokens - (st.tokensUsed || 0))
    };
  }

  /**
   * 静默看门狗:**全程护航**,不只是第一条发言之前。
   * 实测:第一版只管开局静默,而角色(子 agent/独立进程)一干活就是十几分钟 ——
   * 那期间页面全静止,用户的原话是「全是静态的,像是卡住了」。
   * 每次 loop_say 都把静默计时清零;同一段静默最多报 6 次,别刷屏。50ms 级只给测试用。
   */
  let quietTimer = null;
  function armQuietWatch(ms) {
    if (quietTimer) clearInterval(quietTimer);
    let warned = 0;
    let baseline = Date.now();
    quietTimer = setInterval(function () {
      if (!st.active) { clearInterval(quietTimer); quietTimer = null; return; }
      /* ★ 顺手拉一次账。原来只在 loop_say/gate/status 时拉 —— 子 agent 一跑十几分钟,
       *   期间协调者一声不吭,角色行就一直挂着「token 不可得」,而账在档案里明明在涨(实测)。 */
      pullChatUsage();
      const last = Math.max(st.startedAt, st.lastSayAt || 0);
      if (last > baseline) { baseline = last; warned = 0; return; }   // 有新发言:重新计
      warned++;
      if (warned > 6) return;   // 同一段静默别刷屏;下一条发言会重置
      const sec = Math.round((Date.now() - baseline) / 1000);
      const tq = i18n.T(st.lang);
      append({ t: "run.streaming", role: "gate",
        text: (st.turns === 0
          ? tq.quietStart(sec)
          : tq.quietRound(st.round, sec, st.lastSay)) +
          (warned >= 3 ? tq.quietNag : "") });
    }, ms);
    quietTimer.unref && quietTimer.unref();
  }

  function begin(cfg) {
    if (st.active) return { error: "A loop is already running - loop_end it or stop it first" };
    if (!cfg || !Array.isArray(cfg.roles) || !cfg.roles.length) {
      return { error: "At least one role is required" };
    }
    const budget = Object.assign({ rounds: 8, seconds: 3600, noProgressRounds: 2 }, cfg.budget);
    // 轮数 0 = **不限轮**(「修到连续 N 轮挖不出 bug」这类目标本来就说不准要几轮)。
    // 不限轮不等于不设防:时限与零进展/空跑闸门都还在 —— 烧不完的是轮数,不是钱。
    budget.rounds = Math.max(0, Math.floor(Number(budget.rounds) || 0));
    // token 预算:0/不填 = 不限(首选)。只计**量得到的**部分 —— loop_agent 派的角色和评审者
    // 会报账;Claude Code 的子 agent 从它自己的档案里读得到(chatusage.js)。
    // 协调者本人的账摊不出来 —— 所以这个闸是**下界闸**,如实标注。
    budget.tokens = Math.max(0, Math.floor(Number(budget.tokens) || 0));
    // 时限:同样规范成非负整数,配合 remaining() 里「0 = 不限」的处理
    budget.seconds = Math.max(0, Math.floor(Number(budget.seconds) || 0));
    const PALETTE = ["#6FD3C7", "#E2707A", "#E8C468", "#7EA8F0", "#63C68E", "#C08CF0", "#E29A6B", "#8B95A2"];
    // UI 语言:loop_begin 带来的 lang(按用户对话语言),事件里机器写的话都按它出
    const tt = i18n.T(cfg.lang);
    const roles = cfg.roles.map(function (r, i) {
      return {
        id: r.id || ("role" + (i + 1)), name: r.name || tt.roleN(i + 1),
        duty: r.duty || "", kind: r.kind || "propose",
        color: r.color || PALETTE[i % PALETTE.length],
        model: r.model || tt.hostModel
      };
    });

    st.active = true;
    st.cfg = Object.assign({}, cfg, { budget: budget, roles: roles });
    st.lang = cfg.lang || "zh";
    st.round = 1; st.startedAt = Date.now();
    st.lastValue = null; st.noProgress = 0; st.gatePassed = false;
    // 连胜判据:goal.streak = K 表示「连续 K 轮判过才算达标」。
    // 对应「修 bug 直到连续 3 轮挖不出新 bug」—— 单轮判过只是候选,攒满才收工。
    st.metStreak = 0;
    st.saidValue = null;
    st.tokensUsed = 0;
    st.turns = 0; st.endedReason = null;
    // ⚠ 这些是上一局的残留状态 —— 同一个进程(比如常驻的 MCP server)跑第二局时
    // 若不清,新的一局一开局就会被上一局死掉的尸体判死(比如上一局挖出的 stalls/
    // idleRounds 直接带进新一局的 idle_spin/stalled 判定)。actedThisRound 归位到
    // null(不知道),跟每轮末尾重置时的语义一致 —— 不是 false(那等于「观察到没动」)。
    st.stalls = []; st.idleRounds = 0; st.lastFp = null; st.actedThisRound = null;
    // ⚠ 同一进程里旧局若卡在 runGateInner 的 await(慢判据)时被 loop_end 收掉,
    // st.active 会翻 false 但 gateRunning 锁不会被那次 end 动 —— 不清掉的话,
    // 这里刚开的新局第一次 loop_gate 会被残留的锁拒掉。begin 是新局的起点,归零。
    st.gateRunning = false;

    append({
      t: "run.start",
      session: cfg.session || tt.unnamedRun,
      repo: cfg.repo || "", branch: cfg.branch || "",
      client: cfg.client || tt.hostAgent, version: cfg.version || "host",
      mode: "host",
      lang: st.lang,   // ★ 观察面(TUI/网页)按它取词典 —— UI 语言跟用户对话语言
      goal: [cfg.goal && cfg.goal.command,
        cfg.goal && cfg.goal.metric && cfg.goal.metric.name
          ? cfg.goal.metric.name + (cfg.goal.metric.min != null ? " ≥ " + cfg.goal.metric.min : "")
          : null].filter(Boolean).join(tt.goalJoin) || tt.noGoal,
      budget: budget
    });
    roles.forEach(function (r) {
      append({ t: "role.add", id: r.id, name: r.name, model: r.model, color: r.color, duty: r.duty });
    });
    append({
      t: "role.add", id: "gate", name: tt.gateName, model: tt.gateModel, color: "#5B6470",
      duty: tt.gateDuty(cfg.goal && cfg.goal.command)
    });
    // 角色表定了才建得起来 —— 认档案靠的就是角色名与 kind
    // cwd:优先用协调者带过来的(它在你干活的目录里),其次判据命令的目录,最后才是本进程的
    puller = chatusage.createPuller({ roles: roles, sinceMs: st.startedAt,
      cwd: cfg.cwd || (cfg.goal && cfg.goal.cwd) || process.cwd() });
    append({ t: "round.start", n: 1, title: tt.roundTitle(1), meta: stamp() + " → " + tt.inProgress });
    // 静默看门狗:第一条 loop_say 到来之前,每隔一阵在直播里报一声「还没人发言」——
    // 空屏 + 无解释是最坏的等待。quietWarnMs 可配只为测试(默认 90s)。
    armQuietWatch(Math.max(50, Number(cfg.quietWarnMs) || 90000));

    return {
      runId: st.startedAt, round: 1, roles: roles.map(function (r) { return { id: r.id, name: r.name, kind: r.kind }; }),
      gateConfigured: !!(cfg.goal && cfg.goal.command),
      note: (cfg.goal && cfg.goal.command)
        ? "Success is ruled by loop_gate only. You must not declare the goal met yourself."
        : "No gate command - this loop cannot rule the goal met; only round/time limits can stop it. The page will honestly show it as not-judged."
    };
  }

  /** 记一个角色这一轮说了什么。宿主报不出 token 就别编,留空即可。 */
  function say(ev) {
    if (!st.active) return { error: "No loop_begin yet" };
    const known = st.cfg.roles.filter(function (r) { return r.id === ev.role || r.name === ev.role; })[0];
    if (!known) {
      return { error: "Role \"" + ev.role + "\" is not in this loop's role table (" +
        st.cfg.roles.map(function (r) { return r.id; }).join(", ") + ")" };
    }
    st.turns++;
    st.lastSayAt = Date.now();   // 看门狗的静默计时以它为基准
    // 看门狗要能说出「在等谁」:记下最后一个发言者和他说了什么
    st.lastSay = { name: known.name, kind: known.kind, summary: String(ev.summary || "").slice(0, 40) };
    // 角色上报指标:只收**反驳者/复核者**带的 value —— 实现者有动机报 0(它想收工)。
    // 同一轮报多次以最后一次为准(反驳者可能先报初步数、再报核完的数)。
    if (typeof ev.value === "number" && isFinite(ev.value) &&
        (known.kind === "attack" || known.kind === "audit" || known.kind === "verdict")) {
      st.saidValue = { value: ev.value, role: known.name, round: st.round };
    }
    // ★ 「这一轮有人真的动手了吗」。空跑就是:各角色都发了言,但一个文件都没改。
    //   靠两个信号:agent 自己报的 diff,或驱动方观察到的写工具(meta.wrote)。
    //   两个都没有 = 只是在说话。
    if (ev.diff || (ev.meta && ev.meta.wrote)) st.actedThisRound = true;
    // 角色进程卡住被中止的,驱动方在 meta.stalled 里报上来 —— 它是流程异常,不是没达标
    if (ev.meta && ev.meta.stalled) st.stalls.push(known.name);
    append(Object.assign({}, ev, {
      t: "event",
      round: ev.round || st.round,
      role: known.id,
      kind: ev.kind || known.kind,
      ts: ev.ts || stamp(),
      // 宿主执行时用量在宿主账上,拿不到 —— 留 null 让页面显示「不可得」,而不是显示 0
      tok: ev.tok || null,
      meta: Object.assign({ executor: "host" }, ev.meta || {})
    }));
    pullChatUsage();   // 角色刚干完活,它那份档案正好是新的
    return { recorded: true, round: st.round, turns: st.turns };
  }

  /**
   * 跑判据并决定要不要继续。**这是唯一能说「达标」的地方。**
   * 返回 continue=false 时宿主必须停手。
   */
  /**
   * 跑判据。两种可以单独用也可以叠着用:
   *   命令判据(gate.js)   —— 全代码,可复现。有命令时它是**硬门槛**。
   *   评审判据(judge.js)  —— 独立评审者按 rubric 判,给**没有命令可判**的目标用。
   *
   * 叠着用时:**命令先过,评审再判**。命令没过就没必要花一次评审调用;
   * 命令过了也不代表目标达成 —— 评审判的正是命令覆盖不到的那部分。
   */
  async function runGate(opts) {
    if (!st.active) return { error: "No loop_begin yet" };
    // 重入锁:判据是唯一能改「达标与否」状态(metStreak/round/gatePassed)的地方,
    // 两次并发的 loop_gate 若都跑到底,会各自 metStreak++ —— 一轮就能把连胜刷成 2。
    // 第二次调用直接被拒,调用方老老实实等第一次的结果。
    if (st.gateRunning) {
      return { error: "The previous loop_gate is still running - the gate is not reentrant; wait for its result" };
    }
    st.gateRunning = true;
    try {
      return await runGateInner(opts);
    } finally {
      st.gateRunning = false;
    }
  }

  async function runGateInner(opts) {
    // ★ 回合代次守卫:begin() 每次都把 startedAt 重设成新时间戳(它同时也是 runId),
    //   在这里跑之前的 await(gate.check/judge.check)之外先捕获一份 —— 等 await 都
    //   完了再跟 st.startedAt 比对。不只挡「同一局被 loop_end」(那种 st.active 会变
    //   false),更要挡「旧局的 await 还没回来,新局已经 begin」——那种 st.active 早被
    //   新局重新置回 true,单靠 !st.active 判断不出「这结果是哪一局的」。
    const gen = st.startedAt;
    // 判据在一轮的末尾跑 —— 这一刻把这一轮各角色的账收齐,token 预算闸才是按真数关的
    pullChatUsage();
    const goal = st.cfg.goal || {};
    const hasCmd = !!goal.command;
    const hasRubric = !!(goal.rubric && String(goal.rubric).trim());

    // 判据的第三种:**角色上报指标**(判据是停止条件,不必是一条可执行的命令)。
    // 「修 bug 直到连续 3 轮挖不出新 bug」—— bug 数来自反驳者每轮挖掘的结果,
    // 世界上没有一条命令能数它。goal.metric.source==="say" + max:0 + streak:3 就是这个判据。
    const m = goal.metric || {};
    // hasSay = **纯 say 判据**(没有命令,say 是唯一的判定来源)。
    // hasSayMetric = 只要配了 say 指标(带 min/max)就为真,不管有没有 command/rubric ——
    // 否则 command+say 组合会把 say 判据静默丢掉(达标只看 command,say 报的数没人理)。
    const hasSay = !hasCmd && m.source === "say";
    const hasSayMetric = m.source === "say" && (m.min != null || m.max != null);
    function evalSayMetric() {
      const sv = st.saidValue && st.saidValue.round === st.round ? st.saidValue : null;
      const v = sv ? sv.value : null;
      const okMin = m.min == null || (v != null && v >= m.min);
      const okMax = m.max == null || (v != null && v <= m.max);
      const range = [m.min != null ? "≥ " + m.min : null, m.max != null ? "≤ " + m.max : null]
        .filter(Boolean).join(" 且 ");
      return { v: v, ok: v != null && okMin && okMax, range: range, role: sv && sv.role };
    }
    let g;
    if (hasSay) {
      const say = evalSayMetric();
      g = say.v == null
        ? { met: false, value: null, broken: false, ms: 0, fp: null, output: "",
            skipped: i18n.T(st.lang).saidNone(m.name || i18n.T(st.lang).gateLabel) }
        : { met: say.ok, value: say.v, broken: false, ms: 0,
            // 指纹用「轮次:值」—— 连续同值是这种判据的预期形态,零进展闸门另有 met 分支护着
            fp: null, output: "",
            detail: i18n.T(st.lang).saidDetail(m.name || i18n.T(st.lang).gateLabel, say.v, say.role, say.range) };
    } else {
      g = await gate.check(goal, st.lang);
      // command(/rubric)判据之外**同时**配了 say 指标 —— 两边都得过,say 不能被静默吞掉
      if (hasSayMetric) {
        const say = evalSayMetric();
        const sayDetail = say.v != null
          ? (m.name || "指标") + "(say) = " + say.v + "（" + say.role + " 报的,要求 " + say.range + "）"
          : i18n.T(st.lang).saidNoneShort(m.name || i18n.T(st.lang).gateLabel);
        g = Object.assign({}, g, {
          met: !!g.met && say.ok,
          detail: (g.detail || "") + " · " + sayDetail
        });
      }
    }
    // 只有 rubric 没有命令、也没有 say 判据时,gate.check 会回 skipped —— 那不是「未达标」,
    // 是「这一半判不了」,判定权交给评审者。
    const cmdOk = (hasCmd || hasSay) ? !!g.met : true;

    if (hasCmd || hasSay || hasSayMetric || !hasRubric) {
      append({
        t: "event", round: st.round, role: "gate", kind: "test",
        ts: stamp(), dur: ((g.ms || 0) / 1000).toFixed(1) + "s", tok: { in: 0, out: 0 },
        summary: g.skipped ? i18n.T(st.lang).notJudged + g.skipped
          : (g.met ? i18n.T(st.lang).metPrefix + g.detail : i18n.T(st.lang).notMetPrefix + g.detail),
        body: [g.detail, g.output ? i18n.T(st.lang).outputTail + g.output : ""].join("\n"),
        // ★ 带上明确的 met —— 界面不许靠摘要文字去推「过没过」(踩过:评审那条摘要是
        //   「评审判定达标」,而走势那行用 /^达标/ 匹配,于是判过的轮次显示成未过)
        meta: { met: !!g.met, exitCode: g.exitCode, value: g.value,
          broken: !!g.broken, executor: hasSay ? "say-metric" : "code" }
      });
    }

    // 评审只在「命令这一半没拦住」时才跑 —— 命令都没过,花一次评审调用没有意义
    let j = null;
    if (hasRubric && cmdOk && !g.broken) {
      j = await judge.check({
        task: st.cfg.task || st.cfg.session, rubric: goal.rubric, lang: st.lang,
        cwd: st.cfg.cwd || (st.cfg.goal && st.cfg.goal.cwd) || process.cwd(),
        command: hasCmd ? goal.command : null,
        said: (opts && opts.said) || [], round: st.round,
        agent: goal.judgeAgent || null, model: goal.judgeModel || null,
        avoidModels: (st.cfg.roles || []).map(function (r) { return r.model; }),
        // 评审者在动时也要看得见(同 dispatch 的实时活动,1.5s 节流)
        onActivity: (function () {
          let lastJ = 0;
          return function (line) {
            const now = Date.now();
            if (now - lastJ < 1500) return;
            lastJ = now;
            append({ t: "run.streaming", role: "gate",
              text: i18n.T(st.lang).judgeActivity + String(line).slice(0, 90) });
          };
        })()
      });
      addUsage(j.usageEvents);
      append({
        t: "event", round: st.round, role: "gate", kind: "audit",
        ts: stamp(), dur: ((j.ms || 0) / 1000).toFixed(1) + "s",
        summary: (j.broken ? i18n.T(st.lang).judgeBroken
          : (j.met ? i18n.T(st.lang).judgeMet : i18n.T(st.lang).judgeNotMet)) + j.detail,
        body: [j.detail, j.next ? i18n.T(st.lang).judgeNext + j.next : "",
          j.output ? i18n.T(st.lang).judgeTail + j.output : ""].join("\n"),
        meta: {
          met: !!j.met, executor: "judge", judge: true, broken: !!j.broken,
          model: j.model, agent: j.agent, evidence: (j.evidence || []).length,
          // 实在没有第二个模型可用时如实标出来 —— 同模型自评通过率虚高
          sameAsProposer: !!j.sameAsProposer, downgraded: !!j.downgraded
        }
      });
    }

    // 上面两个 await(gate.check / judge.check)执行期间,回环可能已经被 loop_end
    // 收掉了,甚至新的一局已经 begin —— 那样的话不能再往下写 round.end/round.start,
    // 否则会在 run.end 之后又续上一轮,甚至把这一局的判据结果污染到下一局头上(旧局
    // 的 metStreak++/round.end/finish 全按新局的状态去改)。st.startedAt !== gen
    // 就是「已经换局」的证据,跟 !st.active 一样都要作废。
    if (!st.active || st.startedAt !== gen) {
      return { error: "The loop ended or was replaced while the gate was running (loop_end / a new loop_begin arrived first); this gate result is void" };
    }

    // 达标 = 该过的都过了。命令是硬门槛,评审是它覆盖不到的那部分。
    const met = hasRubric ? (cmdOk && !!(j && j.met)) : !!g.met;
    // 连胜判据:单轮判过只是「本轮过」,连续 need 轮都过才算达标。
    // 断一次就从头攒 —— 「连续」两个字是判据的一部分,不是修辞。
    const need = Math.max(1, Math.floor(Number(goal.streak) || 1));
    if (met) st.metStreak++; else st.metStreak = 0;
    const streakDone = met && st.metStreak >= need;
    // ★ loop_end(goal_met) 只认攒满的 —— 攒到 2/3 时 agent 自称达标必须被拒
    st.gatePassed = streakDone;
    // ★ 停止原因要能区分:纯命令判过 = goal_met;掺了评审 = judged_met。
    //   两者显示、回放、复盘时的可信度不一样,混成一个就没法事后追。
    st.gateKind = hasRubric ? "judge" : hasSay ? "reported" : "command";

    let stop = null;
    if (streakDone) stop = hasRubric ? "judged_met" : hasSay ? "reported_met" : "goal_met";
    else if (met) {
      // 本轮判过但连胜没攒满:**不算零进展、不算空跑** —— 这是判据定义里的确认期,
      // 反驳者接着挖才是这几轮该干的事。但时限和轮数上限照常管着。
      st.noProgress = 0;
      if (g.value != null) st.lastValue = g.value;
      if (g.fp != null) st.lastFp = g.fp;   // 空输出的 fp 是 "" —— falsy 但仍是有效指纹,得存
      const rem0 = remaining();
      if (rem0.seconds != null && rem0.seconds <= 0) stop = "budget_time";
      else if (rem0.rounds != null && rem0.rounds <= 0) stop = "budget_rounds";
      else if (rem0.tokens != null && rem0.tokens <= 0) stop = "budget_tokens";
    }
    else if (g.broken) stop = "gate_broken";
    else if (j && j.broken) stop = "judge_broken";
    else {
      // 进展:有 metric 看指标,没 metric 退回比判据输出指纹(少了后者,这个闸门对
      // 绝大多数回环都是空的 —— metric 是可选的)
      const prog = gate.madeProgress(st.cfg.goal, st.lastValue, g.value, st.lastFp, g.fp);
      if (prog === false) st.noProgress++; else if (prog === true) st.noProgress = 0;
      if (g.value != null) st.lastValue = g.value;
      if (g.fp != null) st.lastFp = g.fp;   // 同上:空串也要能存,否则 lastFp 永远不更新

      // ★ 空跑:这一轮各角色都说了话,但没有任何人真的改过东西。
      //   跟「零进展」不是一回事 —— 零进展是改了但没往好的方向走,空跑是**压根没改**。
      //   下一步动作也不同:空跑多半是权限不够 / 提示词让它以为只用分析。
      //
      //   ⚠ **只在真的观察到时才计数**。调用方看得见每个角色的工具调用时传
      //   `observed:true`(per-role 驱动能);看不见的(纯 MCP 那条路,补丁靠 agent 自己报)
      //   传不了,那就是「不知道」—— 不知道不许算空跑,否则会把不报 diff 的健康回环误杀。
      const observed = !!(opts && opts.observed);
      if (st.actedThisRound === true) st.idleRounds = 0;
      else if (observed && st.actedThisRound !== true) st.idleRounds++;

      const rem = remaining();
      const idleMax = st.cfg.budget.idleRounds == null ? 2 : st.cfg.budget.idleRounds;
      if (st.stalls.length) stop = "stalled";
      else if (st.idleRounds >= idleMax) stop = "idle_spin";
      else if (st.noProgress >= st.cfg.budget.noProgressRounds) stop = "no_progress";
      else if (rem.seconds != null && rem.seconds <= 0) stop = "budget_time";
      else if (rem.rounds != null && rem.rounds <= 0) stop = "budget_rounds";
      else if (rem.tokens != null && rem.tokens <= 0) stop = "budget_tokens";
    }
    // 异常要写进裁决细节,否则「为什么停」只剩一个词
    const anomaly = stop === "idle_spin"
      ? "连续 " + st.idleRounds + " 轮没有任何角色改过文件（权限够吗？提示词是不是让它只做分析？）"
      : stop === "stalled"
        ? "角色进程卡住被中止：" + st.stalls.join("、")
        : null;

    // 裁决那一行要说清是**谁**判的 —— 评审判过和命令判过不该看起来一样
    const kindLabel = hasRubric ? i18n.T(st.lang).judgeLabel : i18n.T(st.lang).gateLabel;
    const detailAll = [
      (hasCmd || hasSay) ? (g.skipped ? "未判定：" + g.skipped : g.detail) : null,
      j ? i18n.T(st.lang).judgePrefix + j.detail : null,
      anomaly
    ].filter(Boolean).join(" ｜ ");
    append({
      t: "round.end", n: st.round,
      winner: streakDone ? i18n.T(st.lang).roundMetFinal(kindLabel)
        : met ? i18n.T(st.lang).roundMetStreak(kindLabel, st.metStreak, need)
        : i18n.T(st.lang).roundNotMet,
      winnerRole: met ? "gate" : null,
      score: detailAll || "—"
    });

    const verdict = {
      // ⚠ met 回的是**达标与否**(连胜攒满),不是「本轮过没过」—— agent 看的是这个字段,
      //   回单轮结果它就会自称达标。本轮结果单独放 roundMet/streak 里。
      round: st.round, met: streakDone, roundMet: met, value: g.value,
      streak: need > 1 ? { need: need, have: st.metStreak } : null,
      // 判不了要先说判不了 —— agent 拿到的第一句话必须是「为什么没有结论」,
      // 而不是一句听起来像结论的话
      detail: detailAll || (i18n.T(st.lang).notJudged + (g.skipped || i18n.T(st.lang).noGate2)),
      output: [g.output ? g.output.slice(-1000) : "",
        j && j.output ? i18n.T(st.lang).judgeShortTail + j.output.slice(-1000) : ""].join(""),
      // 让宿主也知道这次是谁判的:它收尾时要如实说停止原因,不能把评审判过说成命令判过
      judgedBy: hasRubric ? "reviewer" : hasSay ? "attacker-report" : "command",
      judge: j ? { met: !!j.met, model: j.model, evidence: (j.evidence || []).length,
        next: j.next || "", broken: !!j.broken } : null,
      "continue": !stop,
      stopReason: stop,
      stopLabel: stop ? REASONS[stop] : null,
      noProgressRounds: st.noProgress,
      // 流程健康度一并回给协调者 —— 它的职责之一就是看着这几个数纠正流程
      idleRounds: st.idleRounds,
      acted: st.actedThisRound,   // true/false/null —— null = 这条路观察不到,不是「没动」
      anomaly: anomaly,
      remaining: remaining()
    };

    if (stop) {
      finish(stop, detailAll || "");
    } else {
      st.round++;
      st.actedThisRound = null;   // 逐轮重置回「不知道」,否则第一轮动过手就永远不算空跑
      st.saidValue = null;        // 上一轮报的数过期 —— 反驳者这一轮得重新挖、重新报
      st.stalls = [];
      append({ t: "round.start", n: st.round, title: i18n.T(st.lang).roundTitle(st.round), meta: stamp() + " → " + i18n.T(st.lang).inProgress });
      verdict.nextRound = st.round;
      verdict.instruction = (met
        ? "This round passed, but the gate requires **" + need + " consecutive** passing rounds (now " +
          st.metStreak + "/" + need + "). Not met yet - next round the critic keeps digging while the " +
          "proposer stands by to fix; a miss resets the streak. Start round " + st.round + "."
        : hasSay
          // 挖-修类的轮内顺序是死的:先修上一轮挖出的,再让反驳者重挖复检报数 ——
          // 顺序反了(先挖)会把还没修的又数一遍,白烧一轮
          ? "Not met. Round " + st.round + " runs strictly in this order: (1) the proposer fixes the " +
            "issues reported above (loop_say as soon as it starts); (2) the critic re-digs and re-checks, " +
            "reporting this round's count via value; (3) loop_gate. Do not parallelize - digging depends on fixing."
          : "Not met. Carry the failure output back to the roles and start round " + st.round + ".") +
        (st.idleRounds > 0
          ? " WARNING: no role changed any file last round - check whether the proposer lacks write " +
            "permission or believes analysis alone suffices."
          : "");
    }
    return verdict;
  }

  function finish(reason, detail) {
    st.active = false;
    st.endedReason = reason;
    append({
      t: "run.end", reason: reason, detail: detail || "",
      rounds: st.round, mode: "host",
      seconds: Math.round((Date.now() - st.startedAt) / 1000)
    });
  }

  /**
   * 宿主主动收工。goal_met 只有在 gate 真的判过之后才接受 ——
   * 这条拒绝是整层的核心:不许模型给自己发合格证。
   */
  // 达标类停止原因——不论是命令判过(goal_met)、评审判过(judged_met)还是角色上报
  // 判过(reported_met),同样都是「自称达标」的语义,同样必须先过 gate 攒满连胜。
  // 只挡 goal_met 会漏掉另外两条:agent 照样能拿 judged_met/reported_met 自己发合格证。
  const MET_REASONS = { goal_met: true, judged_met: true, reported_met: true };
  function end(reason, detail) {
    if (!st.active) return { error: "No loop is currently running" };
    if (MET_REASONS[reason] && !st.gatePassed) {
      // 连胜判据攒到一半时这句必须把进度说出来 —— 「还没判过」对着 2/3 的 agent 是错的
      const need = Math.max(1, Math.floor(Number(st.cfg.goal && st.cfg.goal.streak) || 1));
      return {
        error: "Rejected: the gate has not ruled the goal met" +
          (need > 1 ? " (requires " + need + " consecutive passing rounds; currently " + st.metStreak + "/" + need + ")" : "") +
          ", so ending with goal_met is not allowed. Call loop_gate first.",
        hint: "Success is computed by code. If you truly want to give up, use reason=\"abandoned\" and explain why in detail."
      };
    }
    const r = REASONS[reason] ? reason : "abandoned";
    finish(r, detail || "");
    return { ended: true, reason: r, label: REASONS[r] };
  }

  /**
   * 替宿主派一个角色到**独立进程**里跑(等它做完)。
   *
   * 为什么在这层:Codex 等宿主的聊天里**没有子 agent** —— 技能只能退化成同一个会话
   * 轮流扮演,而「同一个模型自己跟自己唱反调,反驳强度明显偏软」是这个项目反复写过的判断。
   * 监控台/MCP server 跑在宿主沙箱**外面**,它可以起进程 —— 于是隔离由我们代劳:
   * 独立会话、可指定模型、attack/audit 走工具层只读档(perrole.runRole 全套)。
   *
   * 结果**自动 loop_say**:留痕不该依赖调用方记得再报一遍;它忘了,页面上就是空的。
   */
  async function dispatch(args) {
    if (!st.active) return { error: "No loop_begin yet" };
    const roleName = String(args.role || "").trim();
    const known = st.cfg.roles.filter(function (r) {
      return r.id === roleName || r.name === roleName;
    })[0];
    if (!known) {
      return { error: "Role \"" + roleName + "\" is not in this loop's role table (" +
        st.cfg.roles.map(function (r) { return r.id + "=" + r.name; }).join(", ") +
        "). Roles are registered at loop_begin; inventing new ones here is not allowed." };
    }
    const brief = String(args.prompt || "").trim();
    if (!brief) {
      return { error: "prompt must not be empty - the standalone process cannot see your conversation; " +
        "carry the full context over (goal, what others said this round, last gate failure output)." };
    }

    const perrole = require("./perrole.js");
    const adapters = require("./adapters.js");
    const agentcli = require("./agentcli.js");
    let ad = null;
    if (args.agent) {
      ad = adapters.get(String(args.agent));
      if (!ad) return { error: "Unknown host CLI: " + args.agent };
    } else {
      ad = adapters.all().filter(function (a) { return agentcli.which(a.bin); })[0];
      if (!ad) return { error: "No coding-agent CLI found on this machine" };
    }

    const kind = known.kind || "attack";
    const role = {
      name: known.name, kind: kind,
      model: args.model || known.model || null,
      permissionMode: perrole.DEFAULT_PERM[kind] || "readOnly"
    };
    const cwd = st.cfg.cwd || (st.cfg.goal && st.cfg.goal.cwd) || process.cwd();
    // 角色头写在服务端,不信调用方会带 —— 红线(反驳者不许改文件)必须每次都在。
    // 提示词一律英文(用户点名);角色名保持原样(那是 UI/账目的键)
    const prompt = [
      "You are the \"" + role.name + "\" in an adversarial loop. Duty: " + (perrole.DUTY[kind] || known.duty || ""),
      "Goal: " + (st.cfg.task || st.cfg.session || ""),
      "",
      brief,
      "",
      "Write your conclusion directly as the final reply — it is carried back into the loop verbatim. " +
      "Do not call any loop_* tool."
    ].join(String.fromCharCode(10));

    // 实时活动:像 Claude Code 的 TUI 那样,角色在动时看得见它在干什么。
    // 1.5s 节流 —— 这些事件会进 append-only 档案,刷太密会把日志淹掉
    let lastAct = 0;
    const res = await perrole.runRole({
      adapter: ad, role: role, cwd: cwd, prompt: prompt, round: st.round,
      stallMs: Math.min(Math.max(Number(args.timeoutMs) || 240000, 30000), 600000),
      onActivity: function (line) {
        const now = Date.now();
        if (now - lastAct < 1500) return;
        lastAct = now;
        append({ t: "run.streaming", role: known.id,
          text: known.name + " · " + String(line).slice(0, 90) });
      }
    });
    if (res.error) return { error: role.name + " failed to start: " + res.error };
    addUsage(res.usageEvents);
    if (res.modelRejected) {
      return { error: "Model " + res.modelRejected + " is not usable on " + ad.label +
        " (version/account) - pick another, or omit it to use the default." };
    }
    const text = res.text || "";
    // 纯空白(" "/"\n\n")能骗过 !text 但骗不过 !text.trim() —— 不挡住的话下面
    // split("\n").filter(...)[0] 会因为空数组的 [0] 是 undefined 而抛 TypeError
    if (!text || !text.trim()) {
      return { error: role.name + " produced no final reply (exit " + res.exitCode +
        (res.stalled ? ", stalled and aborted" : "") + "). Log tail: " +
        (res.logs || []).slice(-3).join(" | ") };
    }
    // 自动留痕 —— wrote/stalled 是**观察到的**,不靠 agent 自报
    say({
      role: known.id,
      summary: text.split(String.fromCharCode(10)).filter(function (l) { return l.trim(); })[0].slice(0, 120),
      body: text,
      meta: { wrote: res.wrote, stalled: res.stalled, executor: "dispatch",
        agent: ad.id, model: role.model || "(host default)" }
    });
    return {
      text: text, wrote: res.wrote, stalled: res.stalled,
      said: true, agent: ad.id, model: role.model || null,
      note: "The result was auto-loop_say-ed; do not report it again."
    };
  }

  function status() {
    pullChatUsage();   // 协调者来问进度时顺手收一次账(它问得比谁都勤)
    return {
      active: st.active,
      mode: "host",
      round: st.round,
      turns: st.turns,
      gatePassed: st.gatePassed,
      noProgressRounds: st.noProgress,
      idleRounds: st.idleRounds,
      gateKind: st.gateKind || null,
      lastValue: st.lastValue,
      endedReason: st.endedReason,
      remaining: remaining(),
      roles: st.cfg ? st.cfg.roles.map(function (r) { return { id: r.id, name: r.name, kind: r.kind }; }) : [],
      goal: st.cfg ? st.cfg.goal : null
    };
  }

  return { begin: begin, say: say, gate: runGate, end: end, status: status,
    dispatch: dispatch, REASONS: REASONS,
    isActive: function () { return st.active; } };
}

module.exports = { create: create, REASONS: REASONS };
