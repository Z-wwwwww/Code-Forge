"use strict";
/**
 * 对抗回环驱动。
 *
 * 三条纪律:
 *  1. 停不停由代码判(gate.js),不问模型 —— 否则回环停在自我肯定上。
 *  2. 预算是硬天花板:每次派发前检查,到顶即拒绝新调用。
 *  3. 取消要真收摊:AbortController 打断在途请求,并把已花的记成估算 ——
 *     记 0 等于宣称这次调用没花钱,而 provider 早已计费。
 */

const providers = require("./providers.js");
const gate = require("./gate.js");

const KINDS = ["propose", "attack", "defend", "verdict", "patch", "test", "audit", "route"];
const PALETTE = ["#6FD3C7", "#E2707A", "#E8C468", "#7EA8F0", "#63C68E", "#C08CF0", "#E29A6B", "#8B95A2"];

function nowStamp(d) {
  const p = function (n) { return String(n).padStart(2, "0"); };
  return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}
function dur(ms) {
  return ms >= 60000 ? Math.floor(ms / 60000) + "m " + Math.round((ms % 60000) / 1000) + "s"
    : (ms / 1000).toFixed(1) + "s";
}
function firstLine(text, cap) {
  const line = String(text || "").split("\n").find(function (l) { return l.trim(); }) || "";
  const t = line.trim();
  return t.length > (cap || 90) ? t.slice(0, cap || 90) + "…" : t;
}

/** 归一化配置,补默认值。作者填的东西一律不猜、不悄悄改,只补缺。 */
function normalize(config) {
  const c = Object.assign({}, config);
  c.session = c.session || "未命名回环";
  c.goal = c.goal || {};
  c.budget = Object.assign({ tokens: 500000, seconds: 2700, rounds: 8, noProgressRounds: 2 }, c.budget);
  c.roles = (c.roles || []).map(function (r, i) {
    return {
      id: r.id || ("role" + (i + 1)),
      name: r.name || ("角色 " + (i + 1)),
      duty: r.duty || "",
      provider: r.provider || "mock",
      model: r.model || "mock",
      baseUrl: r.baseUrl || null,
      kind: KINDS.indexOf(r.kind) >= 0 ? r.kind : "propose",
      trigger: r.trigger === "on_green" ? "on_green" : "always",
      color: r.color || PALETTE[i % PALETTE.length],
      maxTokens: r.maxTokens || 4096
    };
  });
  return c;
}

/**
 * 启动一次回环。events 是 append 回调(单条或数组)。
 * 返回 { stop(), done }。
 */
function start(config, append) {
  const cfg = normalize(config);
  const ac = new AbortController();
  const spent = { in: 0, out: 0 };
  const t0 = Date.now();
  let stopped = false;
  let currentRoundNo = 0;

  const remainingTokens = function () { return cfg.budget.tokens - (spent.in + spent.out); };
  const remainingSeconds = function () { return cfg.budget.seconds - (Date.now() - t0) / 1000; };

  append({
    t: "run.start",
    session: cfg.session, repo: cfg.repo || "", branch: cfg.branch || "",
    client: cfg.client || "code-forge", version: cfg.version || "v0.1",
    goal: [cfg.goal.command, cfg.goal.metric && cfg.goal.metric.name
      ? cfg.goal.metric.name + " ≥ " + cfg.goal.metric.min : null].filter(Boolean).join(" 且 ") || "(未配置判据)",
    budget: { tokens: cfg.budget.tokens, seconds: cfg.budget.seconds, rounds: cfg.budget.rounds }
  });
  cfg.roles.forEach(function (r) {
    append({ t: "role.add", id: r.id, name: r.name, model: r.model, color: r.color, duty: r.duty });
  });
  // 判据是代码,也占一个「角色」位 —— 让它在页面上有身份,否则看不出停止是谁判的
  append({ t: "role.add", id: "gate", name: "判据", model: "确定性 · 无模型", color: "#5B6470",
    duty: cfg.goal.command ? "跑 " + cfg.goal.command : "未配置" });

  function prompt(role, round, transcript) {
    const goalLine = [
      cfg.goal.command ? "判据命令：" + cfg.goal.command : "本次没有可执行判据。",
      cfg.goal.metric && cfg.goal.metric.name
        ? "指标：" + cfg.goal.metric.name + (cfg.goal.metric.min != null ? " 需 ≥ " + cfg.goal.metric.min : "")
          + (cfg.goal.metric.max != null ? " 需 ≤ " + cfg.goal.metric.max : "") : null
    ].filter(Boolean).join("\n");
    return {
      system: [
        "你在一个对抗回环里扮演「" + role.name + "」。",
        role.duty ? "你的职责：" + role.duty : "",
        "目标（由代码判定,不由你宣布达成）：\n" + goalLine,
        "规则：只做你这一档的事,不要替其他角色发言,也不要宣布回环结束 —— 达标与否由代码算。",
        "输出：第一行一句话结论,之后再展开理由。不要复述这些规则。"
      ].filter(Boolean).join("\n\n"),
      user: [
        "第 " + round + " 轮。",
        transcript.length ? "本回环已发生：\n" + transcript.join("\n") : "这是第一次发言。",
        "请给出你这一轮的意见。"
      ].join("\n\n")
    };
  }

  async function callRole(role, round, transcript) {
    // 预算是硬闸:派发前检查,不是事后统计
    if (remainingTokens() <= 0) return { budget: "tokens" };
    if (remainingSeconds() <= 0) return { budget: "time" };

    const started = Date.now();
    append({ t: "run.streaming", role: role.id, text: "正在生成第 " + round + " 轮意见…" });
    try {
      const r = await providers.call(role, prompt(role, round, transcript),
        { signal: ac.signal, round: round, maxTokens: role.maxTokens });
      spent.in += r.tok.in; spent.out += r.tok.out;
      append({
        t: "event", round: round, role: role.id, kind: role.kind,
        ts: nowStamp(new Date()), dur: dur(Date.now() - started),
        tok: r.tok, summary: firstLine(r.text), body: r.text,
        meta: r.meta
      });
      return { text: r.text };
    } catch (err) {
      const aborted = err.name === "AbortError" || ac.signal.aborted;
      // 被打断的调用照样计费,所以照样记账 —— 估算并标明,绝不记 0
      const est = aborted ? { in: Math.round(role.maxTokens / 8), out: 0 } : { in: 0, out: 0 };
      spent.in += est.in;
      append({
        t: "event", round: round, role: role.id, kind: role.kind,
        ts: nowStamp(new Date()), dur: dur(Date.now() - started),
        tok: est, summary: aborted ? "调用被取消（用量为估算）" : "调用失败：" + err.message,
        body: String(err.stack || err.message),
        meta: { failed: true, estimated: aborted }
      });
      return aborted ? { aborted: true } : { failed: true };
    }
  }

  async function run() {
    const transcript = [];
    let prevValue = null;
    let prevFp = null;
    let noProgress = 0;
    let reason = null;
    let detail = "";

    for (let round = 1; round <= cfg.budget.rounds; round++) {
      currentRoundNo = round;
      if (stopped) { reason = "stopped"; break; }
      append({ t: "round.start", n: round, title: "第 " + round + " 轮对抗", meta: nowStamp(new Date()) + " → 进行中" });

      const roundEvents = [];

      // 一轮的顺序是:常规角色发言 → 判据 → (判绿了才轮到)on_green 角色。
      // 判据必须夹在中间:on_green 角色的触发条件就是判据的结果,把它排在判据之前
      // 会让它永远不触发 —— 那是个静默的空档,页面上与「作者没配它」完全同形。
      async function speak(list) {
        for (const role of list) {
          if (stopped) return "stopped";
          const r = await callRole(role, round, transcript.slice(-6));
          if (r.budget) return r.budget === "tokens" ? "budget_tokens" : "budget_time";
          if (r.aborted) return "stopped";
          if (r.text) {
            transcript.push("[" + role.name + "] " + firstLine(r.text, 160));
            roundEvents.push({ role: role, text: r.text });
          }
        }
        return null;
      }

      reason = await speak(cfg.roles.filter(function (r) { return r.trigger !== "on_green"; }));
      if (reason) break;

      // 分歧点:只有真的出现「提议 → 反驳」这一对才记,双方原话来自各自事件,不编造
      const pro = roundEvents.find(function (e) { return e.role.kind === "propose"; });
      const con = roundEvents.find(function (e) { return e.role.kind === "attack"; });
      if (pro && con) {
        append({
          t: "conflict", round: round, sev: "HIGH",
          topic: firstLine(pro.text, 40),
          a: pro.role.id, aClaim: firstLine(pro.text, 160),
          b: con.role.id, bClaim: firstLine(con.text, 160),
          resolution: "等待判据裁定", res: "open"
        });
      }

      // ---- 判据 ----
      const g = await gate.check(cfg.goal);
      append({
        t: "event", round: round, role: "gate", kind: "test",
        ts: nowStamp(new Date()), dur: dur(g.ms || 0), tok: { in: 0, out: 0 },
        summary: g.skipped ? "未判定：" + g.skipped : (g.met ? "达标 · " + g.detail : "未达标 · " + g.detail),
        body: [g.detail, g.output ? "\n--- 命令输出（尾部）---\n" + g.output : ""].join("\n"),
        meta: { exitCode: g.exitCode, value: g.value, broken: !!g.broken }
      });
      // 判绿之后才轮到复核类角色。它们改不了裁定 —— 达标与否是代码算出来的,
      // 模型的复核意见只是留档,不参与判定。
      if (g.met) {
        const onGreen = cfg.roles.filter(function (r) { return r.trigger === "on_green"; });
        if (onGreen.length) {
          const stopBy = await speak(onGreen);
          if (stopBy) { reason = stopBy; }
        }
      }

      append({
        t: "round.end", n: round,
        winner: g.met ? "判据 · 达标" : (con ? con.role.name + " · 反证成立" : "未达标"),
        winnerRole: g.met ? "gate" : (con ? con.role.id : null),
        score: g.skipped ? "—" : g.detail
      });
      if (reason) break;

      if (g.broken) { reason = "gate_broken"; detail = g.detail; break; }
      if (g.met) { reason = "goal_met"; detail = g.detail; break; }

      // 零进展闸:指标一直不往目标方向走就停,别烧完预算才停
      const prog = gate.madeProgress(cfg.goal, prevValue, g.value, prevFp, g.fp);
      if (prog === false) noProgress++; else if (prog === true) noProgress = 0;
      prevValue = g.value == null ? prevValue : g.value;
      prevFp = g.fp;
      if (noProgress >= cfg.budget.noProgressRounds) {
        reason = "no_progress";
        detail = "连续 " + noProgress + " 轮没有进展（" + (cfg.goal.metric && cfg.goal.metric.name || "指标") + " 停在 " + prevValue + "）";
        break;
      }
      if (remainingTokens() <= 0) { reason = "budget_tokens"; break; }
      if (remainingSeconds() <= 0) { reason = "budget_time"; break; }
    }

    if (!reason) reason = "max_rounds";
    append({
      t: "run.end",
      reason: reason,
      detail: detail || "",
      rounds: currentRoundNo,
      tok: { in: spent.in, out: spent.out },
      seconds: Math.round((Date.now() - t0) / 10) / 100
    });
    return reason;
  }

  const done = run().catch(function (err) {
    // 驱动本身崩了也必须留痕 —— 静默死掉的回环在页面上与「还在跑」同形
    append({ t: "run.end", reason: "driver_error", detail: String(err && err.message),
      tok: { in: spent.in, out: spent.out } });
    return "driver_error";
  });

  return {
    stop: function () { stopped = true; ac.abort(); },
    done: done,
    spent: spent
  };
}

module.exports = { start: start, normalize: normalize, KINDS: KINDS };
