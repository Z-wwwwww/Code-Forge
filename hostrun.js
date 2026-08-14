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

const REASONS = {
  goal_met: "达标停止",
  budget_rounds: "到达轮数上限",
  budget_time: "超出时限",
  no_progress: "连续零进展",
  stopped: "手动停止",
  gate_broken: "判据本身失败",
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
    turns: 0, endedReason: null
  };

  function remaining() {
    if (!st.active) return { rounds: 0, seconds: 0 };
    return {
      rounds: Math.max(0, st.cfg.budget.rounds - st.round),
      seconds: Math.max(0, Math.round(st.cfg.budget.seconds - (Date.now() - st.startedAt) / 1000))
    };
  }

  function begin(cfg) {
    if (st.active) return { error: "已有回环在进行中,先 loop_end 或停止它" };
    if (!cfg || !Array.isArray(cfg.roles) || !cfg.roles.length) {
      return { error: "至少要有一个角色" };
    }
    const budget = Object.assign({ rounds: 8, seconds: 3600, noProgressRounds: 2 }, cfg.budget);
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
  async function runGate() {
    if (!st.active) return { error: "还没有 loop_begin" };
    const g = await gate.check(st.cfg.goal);
    st.gatePassed = !!g.met;

    append({
      t: "event", round: st.round, role: "gate", kind: "test",
      ts: stamp(), dur: ((g.ms || 0) / 1000).toFixed(1) + "s", tok: { in: 0, out: 0 },
      summary: g.skipped ? "未判定：" + g.skipped
        : (g.met ? "达标 · " + g.detail : "未达标 · " + g.detail),
      body: [g.detail, g.output ? "\n--- 命令输出（尾部）---\n" + g.output : ""].join("\n"),
      meta: { exitCode: g.exitCode, value: g.value, broken: !!g.broken, executor: "code" }
    });

    let stop = null;
    if (g.met) stop = "goal_met";
    else if (g.broken) stop = "gate_broken";
    else {
      const prog = gate.madeProgress(st.cfg.goal, st.lastValue, g.value);
      if (prog === false) st.noProgress++; else if (prog === true) st.noProgress = 0;
      if (g.value != null) st.lastValue = g.value;
      const rem = remaining();
      if (st.noProgress >= st.cfg.budget.noProgressRounds) stop = "no_progress";
      else if (rem.seconds <= 0) stop = "budget_time";
      else if (rem.rounds <= 0) stop = "budget_rounds";
    }

    append({
      t: "round.end", n: st.round,
      winner: g.met ? "判据 · 达标" : "未达标",
      winnerRole: g.met ? "gate" : null,
      score: g.skipped ? "—" : g.detail
    });

    const verdict = {
      round: st.round, met: !!g.met, value: g.value,
      // 判不了要先说判不了 —— agent 拿到的第一句话必须是「为什么没有结论」,
      // 而不是一句听起来像结论的话
      detail: g.skipped ? "未判定：" + g.skipped : (g.detail || ""),
      output: g.output ? g.output.slice(-1200) : "",
      "continue": !stop,
      stopReason: stop,
      stopLabel: stop ? REASONS[stop] : null,
      noProgressRounds: st.noProgress,
      remaining: remaining()
    };

    if (stop) {
      finish(stop, g.detail || "");
    } else {
      st.round++;
      append({ t: "round.start", n: st.round, title: "第 " + st.round + " 轮对抗", meta: stamp() + " → 进行中" });
      verdict.nextRound = st.round;
      verdict.instruction = "未达标。把判据输出里的失败信息带回给各角色,开第 " + st.round + " 轮。";
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
      return {
        error: "拒绝：judge 还没有判过达标,不能以 goal_met 收工。先调 loop_gate。",
        hint: "达标与否由代码算。若你确实要放弃,用 reason=\"abandoned\" 并在 detail 里说明为什么。"
      };
    }
    const r = REASONS[reason] ? reason : "abandoned";
    finish(r, detail || "");
    return { ended: true, reason: r, label: REASONS[r] };
  }

  function status() {
    return {
      active: st.active,
      mode: "host",
      round: st.round,
      turns: st.turns,
      gatePassed: st.gatePassed,
      noProgressRounds: st.noProgress,
      lastValue: st.lastValue,
      endedReason: st.endedReason,
      remaining: remaining(),
      roles: st.cfg ? st.cfg.roles.map(function (r) { return { id: r.id, name: r.name, kind: r.kind }; }) : [],
      goal: st.cfg ? st.cfg.goal : null
    };
  }

  return { begin: begin, say: say, gate: runGate, end: end, status: status, REASONS: REASONS,
    isActive: function () { return st.active; } };
}

module.exports = { create: create, REASONS: REASONS };
