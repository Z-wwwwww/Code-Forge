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
const judge = require("./judge.js");   // 评审判据（不可量化目标）—— 判定人是独立评审者，不是协调者

const REASONS = {
  goal_met: "达标停止（命令判过）",
  // ★ 评审判定**单列**,绝不混进 goal_met。一条命令的退出码可复现,一个模型的裁定不可 ——
  //   回放一次运行时,「真跑过 pytest」和「某个评审者说了句达标」必须分得清。
  judged_met: "达标停止（独立评审者判定，非命令）",
  // 角色上报的指标(反驳者报「本轮挖到 N 个 bug」)也单列 —— 它和评审一样是模型的话,
  // 可信度低于命令的退出码。回放时三种「达标」必须分得清。
  reported_met: "达标停止（角色上报的指标，非命令）",
  budget_tokens: "TOKEN 预算用尽（只计量得到的部分）",
  budget_rounds: "到达轮数上限",
  budget_time: "超出时限",
  no_progress: "连续零进展",
  // ★ 协调者的另一半职责:抓异常。这三种都不是「没达标」,是**流程出问题了**,
  //   下一步动作完全不同 —— 所以各占一条停止原因,不许糊成 no_progress。
  idle_spin: "空跑（没有任何角色真的改过东西）",
  stalled: "长时间停滞（角色进程卡住被中止）",
  stopped: "手动停止",
  gate_broken: "判据本身失败",
  judge_broken: "评审判据本身失败",
  abandoned: "宿主放弃(说明见 detail)"
};

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
      seconds: Math.max(0, Math.round(st.cfg.budget.seconds - (Date.now() - st.startedAt) / 1000)),
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
      const last = Math.max(st.startedAt, st.lastSayAt || 0);
      if (last > baseline) { baseline = last; warned = 0; return; }   // 有新发言:重新计
      warned++;
      if (warned > 6) return;   // 同一段静默别刷屏;下一条发言会重置
      const sec = Math.round((Date.now() - baseline) / 1000);
      append({ t: "run.streaming", role: "gate",
        text: (st.turns === 0
          ? "开局 " + sec + "s 还没有任何角色发言 —— 执行者多半在读仓库/派活(大目标首轮 5~15 分钟正常)"
          : "第 " + st.round + " 轮 · 距上一条发言已 " + sec + "s" +
            (st.lastSay ? "（上一条:" + st.lastSay.name + "「" + st.lastSay.summary + "」" + (st.lastSay.kind === "attack" ? "，多半在等提议者修" : "，角色多半还在干活") + "）"
              : " —— 角色多半还在干活(子 agent 一跑几分钟正常)")) +
          (warned >= 3 ? "；一直这样就回执行者那头看看它是不是停了/在等审批" : "") });
    }, ms);
    quietTimer.unref && quietTimer.unref();
  }

  function begin(cfg) {
    if (st.active) return { error: "已有回环在进行中,先 loop_end 或停止它" };
    if (!cfg || !Array.isArray(cfg.roles) || !cfg.roles.length) {
      return { error: "至少要有一个角色" };
    }
    const budget = Object.assign({ rounds: 8, seconds: 3600, noProgressRounds: 2 }, cfg.budget);
    // 轮数 0 = **不限轮**(「修到连续 N 轮挖不出 bug」这类目标本来就说不准要几轮)。
    // 不限轮不等于不设防:时限与零进展/空跑闸门都还在 —— 烧不完的是轮数,不是钱。
    budget.rounds = Math.max(0, Math.floor(Number(budget.rounds) || 0));
    // token 预算:0/不填 = 不限(首选)。只计**量得到的**部分 —— loop_agent 派的角色和评审者
    // 会报账;聊天里的子 agent 用量在用户订阅上,这里计不到。所以这个闸是下界闸,如实标注。
    budget.tokens = Math.max(0, Math.floor(Number(budget.tokens) || 0));
    const PALETTE = ["#6FD3C7", "#E2707A", "#E8C468", "#7EA8F0", "#63C68E", "#C08CF0", "#E29A6B", "#8B95A2"];
    const roles = cfg.roles.map(function (r, i) {
      return {
        id: r.id || ("role" + (i + 1)), name: r.name || ("角色 " + (i + 1)),
        duty: r.duty || "", kind: r.kind || "propose",
        color: r.color || PALETTE[i % PALETTE.length],
        model: r.model || "宿主模型"
      };
    });

    st.active = true;
    st.cfg = Object.assign({}, cfg, { budget: budget, roles: roles });
    st.round = 1; st.startedAt = Date.now();
    st.lastValue = null; st.noProgress = 0; st.gatePassed = false;
    // 连胜判据:goal.streak = K 表示「连续 K 轮判过才算达标」。
    // 对应「修 bug 直到连续 3 轮挖不出新 bug」—— 单轮判过只是候选,攒满才收工。
    st.metStreak = 0;
    st.saidValue = null;
    st.tokensUsed = 0;
    st.turns = 0; st.endedReason = null;

    append({
      t: "run.start",
      session: cfg.session || "未命名回环",
      repo: cfg.repo || "", branch: cfg.branch || "",
      client: cfg.client || "宿主 agent", version: cfg.version || "host",
      mode: "host",
      goal: [cfg.goal && cfg.goal.command,
        cfg.goal && cfg.goal.metric && cfg.goal.metric.name
          ? cfg.goal.metric.name + (cfg.goal.metric.min != null ? " ≥ " + cfg.goal.metric.min : "")
          : null].filter(Boolean).join(" 且 ") || "(未配置判据)",
      budget: budget
    });
    roles.forEach(function (r) {
      append({ t: "role.add", id: r.id, name: r.name, model: r.model, color: r.color, duty: r.duty });
    });
    append({
      t: "role.add", id: "gate", name: "判据", model: "确定性 · 无模型", color: "#5B6470",
      duty: (cfg.goal && cfg.goal.command) ? "跑 " + cfg.goal.command : "未配置 —— 无法判定达标"
    });
    append({ t: "round.start", n: 1, title: "第 1 轮对抗", meta: stamp() + " → 进行中" });
    // 静默看门狗:第一条 loop_say 到来之前,每隔一阵在直播里报一声「还没人发言」——
    // 空屏 + 无解释是最坏的等待。quietWarnMs 可配只为测试(默认 90s)。
    armQuietWatch(Math.max(50, Number(cfg.quietWarnMs) || 90000));

    return {
      runId: st.startedAt, round: 1, roles: roles.map(function (r) { return { id: r.id, name: r.name, kind: r.kind }; }),
      gateConfigured: !!(cfg.goal && cfg.goal.command),
      note: (cfg.goal && cfg.goal.command)
        ? "达标由 loop_gate 判定。你不得自行宣布达成。"
        : "没有判据命令 —— 这次回环无法判定达标,只能靠轮数/时限停。页面会如实标「未判定」。"
    };
  }

  /** 记一个角色这一轮说了什么。宿主报不出 token 就别编,留空即可。 */
  function say(ev) {
    if (!st.active) return { error: "还没有 loop_begin" };
    const known = st.cfg.roles.filter(function (r) { return r.id === ev.role || r.name === ev.role; })[0];
    if (!known) {
      return { error: "角色 «" + ev.role + "» 不在本回环的角色表里(" +
        st.cfg.roles.map(function (r) { return r.id; }).join(", ") + ")" };
    }
    st.turns++;
    st.lastSayAt = Date.now();   // 看门狗的静默计时以它为基准
    // 看门狗要能说出「在等谁」:记下最后一个发言者和他说了什么
    st.lastSay = { name: known.name, kind: known.kind, summary: String(ev.summary || "").slice(0, 40) };
    // 角色上报指标:只收**反驳者/复核者**带的 value —— 提议者有动机报 0(它想收工)。
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
    if (!st.active) return { error: "还没有 loop_begin" };
    const goal = st.cfg.goal || {};
    const hasCmd = !!goal.command;
    const hasRubric = !!(goal.rubric && String(goal.rubric).trim());

    // 判据的第三种:**角色上报指标**(判据是停止条件,不必是一条可执行的命令)。
    // 「修 bug 直到连续 3 轮挖不出新 bug」—— bug 数来自反驳者每轮挖掘的结果,
    // 世界上没有一条命令能数它。goal.metric.source==="say" + max:0 + streak:3 就是这个判据。
    const m = goal.metric || {};
    const hasSay = !hasCmd && m.source === "say";
    let g;
    if (hasSay) {
      const sv = st.saidValue && st.saidValue.round === st.round ? st.saidValue : null;
      const v = sv ? sv.value : null;
      const okMin = m.min == null || (v != null && v >= m.min);
      const okMax = m.max == null || (v != null && v <= m.max);
      const range = [m.min != null ? "≥ " + m.min : null, m.max != null ? "≤ " + m.max : null]
        .filter(Boolean).join(" 且 ");
      g = v == null
        ? { met: false, value: null, broken: false, ms: 0, fp: null, output: "",
            skipped: "本轮没人报 " + (m.name || "指标") +
              " —— 反驳者/复核者 loop_say 要带 value(本轮量出来的数);提议者报的不算" }
        : { met: okMin && okMax, value: v, broken: false, ms: 0,
            // 指纹用「轮次:值」—— 连续同值是这种判据的预期形态,零进展闸门另有 met 分支护着
            fp: null, output: "",
            detail: (m.name || "指标") + " = " + v + "（" + sv.role + " 报的,要求 " + range + "）" };
    } else {
      g = await gate.check(goal);
    }
    // 只有 rubric 没有命令时,gate.check 会回 skipped —— 那不是「未达标」,
    // 是「这一半判不了」,判定权交给评审者。
    const cmdOk = hasCmd ? !!g.met : true;

    if (hasCmd || !hasRubric) {
      append({
        t: "event", round: st.round, role: "gate", kind: "test",
        ts: stamp(), dur: ((g.ms || 0) / 1000).toFixed(1) + "s", tok: { in: 0, out: 0 },
        summary: g.skipped ? "未判定：" + g.skipped
          : (g.met ? "达标 · " + g.detail : "未达标 · " + g.detail),
        body: [g.detail, g.output ? "\n--- 命令输出（尾部）---\n" + g.output : ""].join("\n"),
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
        task: st.cfg.task || st.cfg.session, rubric: goal.rubric, cwd: goal.cwd,
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
              text: "评审者 · " + String(line).slice(0, 90) });
          };
        })()
      });
      addUsage(j.usageEvents);
      append({
        t: "event", round: st.round, role: "gate", kind: "audit",
        ts: stamp(), dur: ((j.ms || 0) / 1000).toFixed(1) + "s",
        summary: (j.broken ? "评审判据失败：" : (j.met ? "评审判定达标 · " : "评审判定未达标 · ")) + j.detail,
        body: [j.detail, j.next ? "\n下一轮该改：" + j.next : "",
          j.output ? "\n--- 评审者原话（尾部）---\n" + j.output : ""].join("\n"),
        meta: {
          met: !!j.met, executor: "judge", judge: true, broken: !!j.broken,
          model: j.model, agent: j.agent, evidence: (j.evidence || []).length,
          // 实在没有第二个模型可用时如实标出来 —— 同模型自评通过率虚高
          sameAsProposer: !!j.sameAsProposer, downgraded: !!j.downgraded
        }
      });
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
      if (g.fp) st.lastFp = g.fp;
      const rem0 = remaining();
      if (rem0.seconds <= 0) stop = "budget_time";
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
      if (g.fp) st.lastFp = g.fp;

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
      else if (rem.seconds <= 0) stop = "budget_time";
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
    const kindLabel = hasRubric ? "评审" : "判据";
    const detailAll = [
      (hasCmd || hasSay) ? (g.skipped ? "未判定：" + g.skipped : g.detail) : null,
      j ? "评审：" + j.detail : null,
      anomaly
    ].filter(Boolean).join(" ｜ ");
    append({
      t: "round.end", n: st.round,
      winner: streakDone ? kindLabel + " · 达标"
        : met ? kindLabel + " · 本轮过（连胜 " + st.metStreak + "/" + need + "）"
        : "未达标",
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
      detail: detailAll || ("未判定：" + (g.skipped || "没有判据")),
      output: [g.output ? g.output.slice(-1000) : "",
        j && j.output ? "\n--- 评审者 ---\n" + j.output.slice(-1000) : ""].join(""),
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
      append({ t: "round.start", n: st.round, title: "第 " + st.round + " 轮对抗", meta: stamp() + " → 进行中" });
      verdict.nextRound = st.round;
      verdict.instruction = (met
        ? "本轮判过,但判据要求**连续 " + need + " 轮**都过（现在 " + st.metStreak + "/" + need +
          "）。还不算达标 —— 下一轮反驳者接着挖,提议者待命修;断一次就从头攒。开第 " + st.round + " 轮。"
        : hasSay
          // 挖-修类的轮内顺序是死的:先修上一轮挖出的,再让反驳者重挖复检报数 ——
          // 顺序反了(先挖)会把还没修的又数一遍,白烧一轮
          ? "未达标。第 " + st.round + " 轮按这个顺序走:①提议者先修上面报出的问题(一开工就 loop_say);" +
            "②反驳者重挖复检,把本轮还能挖到的数用 value 报上来;③loop_gate。别并发 —— 挖和修有依赖。"
          : "未达标。把判据输出里的失败信息带回给各角色,开第 " + st.round + " 轮。") +
        (st.idleRounds > 0
          ? "⚠ 上一轮没有任何角色改过文件 —— 先确认提议者是不是权限不够、或者以为只要做分析。"
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
  function end(reason, detail) {
    if (!st.active) return { error: "当前没有在进行的回环" };
    if (reason === "goal_met" && !st.gatePassed) {
      // 连胜判据攒到一半时这句必须把进度说出来 —— 「还没判过」对着 2/3 的 agent 是错的
      const need = Math.max(1, Math.floor(Number(st.cfg.goal && st.cfg.goal.streak) || 1));
      return {
        error: "拒绝：判据还没有判过达标" +
          (need > 1 ? "（要求连续 " + need + " 轮判过,现在 " + st.metStreak + "/" + need + "）" : "") +
          ",不能以 goal_met 收工。先调 loop_gate。",
        hint: "达标与否由代码算。若你确实要放弃,用 reason=\"abandoned\" 并在 detail 里说明为什么。"
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
    if (!st.active) return { error: "还没有 loop_begin" };
    const roleName = String(args.role || "").trim();
    const known = st.cfg.roles.filter(function (r) {
      return r.id === roleName || r.name === roleName;
    })[0];
    if (!known) {
      return { error: "角色 «" + roleName + "» 不在本回环的角色表里(" +
        st.cfg.roles.map(function (r) { return r.id + "=" + r.name; }).join(", ") +
        ")。角色在 loop_begin 时登记,这里不许临时发明。" };
    }
    const brief = String(args.prompt || "").trim();
    if (!brief) {
      return { error: "prompt 不能为空 —— 独立进程看不见你的对话,上下文要全部带过去" +
        "(目标、这一轮别人说了什么、判据上次的失败输出)。" };
    }

    const perrole = require("./perrole.js");
    const adapters = require("./adapters.js");
    const agentcli = require("./agentcli.js");
    let ad = null;
    if (args.agent) {
      ad = adapters.get(String(args.agent));
      if (!ad) return { error: "不认识的宿主：" + args.agent };
    } else {
      ad = adapters.all().filter(function (a) { return agentcli.which(a.bin); })[0];
      if (!ad) return { error: "这台机器上一个 coding agent CLI 都没找到" };
    }

    const kind = known.kind || "attack";
    const role = {
      name: known.name, kind: kind,
      model: args.model || known.model || null,
      permissionMode: perrole.DEFAULT_PERM[kind] || "readOnly"
    };
    const cwd = (st.cfg.goal && st.cfg.goal.cwd) || process.cwd();
    // 角色头写在服务端,不信调用方会带 —— 红线(反驳者不许改文件)必须每次都在
    const prompt = [
      "你是对抗回环里的「" + role.name + "」。职责：" + (perrole.DUTY[kind] || known.duty || ""),
      "目标：" + (st.cfg.task || st.cfg.session || ""),
      "",
      brief,
      "",
      "把结论直接写成最终答复 —— 它会被原样带回对抗回环。不要调用任何 loop_* 工具。"
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
    if (res.error) return { error: role.name + " 起不来：" + res.error };
    addUsage(res.usageEvents);
    if (res.modelRejected) {
      return { error: "模型 " + res.modelRejected + " 在 " + ad.label +
        " 上用不了(版本/账号不支持) —— 换一个,或不指定用默认。" };
    }
    const text = res.text || "";
    if (!text) {
      return { error: role.name + " 没有产出最终答复(exit " + res.exitCode +
        (res.stalled ? "，卡住被中止" : "") + ")。日志尾部：" +
        (res.logs || []).slice(-3).join(" | ") };
    }
    // 自动留痕 —— wrote/stalled 是**观察到的**,不靠 agent 自报
    say({
      role: known.id,
      summary: text.split(String.fromCharCode(10)).filter(function (l) { return l.trim(); })[0].slice(0, 120),
      body: text,
      meta: { wrote: res.wrote, stalled: res.stalled, executor: "dispatch",
        agent: ad.id, model: role.model || "（宿主默认）" }
    });
    return {
      text: text, wrote: res.wrote, stalled: res.stalled,
      said: true, agent: ad.id, model: role.model || null,
      注意: "结果已自动 loop_say,不必再报一遍。"
    };
  }

  function status() {
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
