"use strict";
/**
 * 一个角色 = 一个宿主进程。
 *
 * ## 为什么要这一层
 *
 * 硬要求是「**每个角色必须有自己的会话**」。一个会话里先当提议者再当反驳者,等于让它
 * 复核自己刚说过的话 —— 反驳强度必然偏软,而这正是整个项目想防的东西。
 *
 * 能派子 agent 的宿主天然满足:子 agent 各有独立上下文、各绑模型。这一层是另一条路 ——
 * **一个角色起一个进程**,给三类宿主用:
 *   ① 压根没有子 agent 机制的;
 *   ② 有、但走协调者那条路要开危险权限档的(codex:workspace-write 下 loop_* 被判
 *      `user cancelled`,只有 danger-full-access 能过);
 *   ③ 有、但实测协调者那条路更贵的(同宿主同模型 A/B:$0.3399/两轮没过 vs $0.0436/一轮过)。
 *
 * ⚠ 别把「有没有子 agent」和「该走哪条路」混成一件事 —— 我混过一次:codex 其实**有**
 * 完整的 spawn_agent / send_input / resume_agent,能覆盖 model 和 reasoning_effort,
 * 甚至能 fork_context。它默认走 per-role 是**策略**(上面 ②③),不是能力缺失。
 *
 * 顺带解决了三件事:
 *   ① **逐角色用量天然分开** —— 每个进程自己报的账就是那个角色的账,不需要
 *      `parent_tool_use_id` 这类宿主特有的东西。
 *   ② **反驳者的只读约束由宿主自己强制** —— codex 起它时给 `-s read-only`(操作系统级),
 *      claude 起它时只放行 Read/Grep/Glob。都比写在提示词里硬。
 *   ③ **角色进程完全不需要 MCP** —— 协议由这一层直接调 hostrun 走完。于是 codex
 *      那道「workspace-write 下 MCP 工具一律被判 user cancelled」的门槛直接不存在了
 *      (不是绕过沙箱,是根本不用 MCP)。
 *
 * ## 和 claude 子 agent 的真实区别（别搞错）
 *
 * ⚠ 「角色之间没有共享上下文」**不是这条路特有的代价** —— claude 的子 agent 也没有。
 * 实测问过子 agent 本人:「你能看到派你出来的那个会话之前的对话历史吗」→ **不能**;
 * 它手上只有自己的 system prompt、父 agent 显式写给它的那段 prompt、和自己的工具集,
 * 收工时只交回一段最终报告。用量也印证:同一次回环里协调者 cacheRead 478.6k,
 * 而两个子 agent 分别只有 75.9k / 15.5k —— 量级不同,各自独立。
 *
 * 真正的区别是**谁负责把上下文喂给角色**:
 *
 *   claude 子 agent  → **协调者模型**转述。它读了判据输出,自己决定告诉反驳者什么。
 *   per-role 进程    → **代码**按模板拼。判据输出原文、上一轮反驳点原文照搬。
 *
 * 各有代价,得说清:
 *   ① 协调者转述是**有损**的,而且它有动机让事情看起来在进展 —— 可能把判据里刺眼的
 *      失败信息说轻了。代码拼是无损的:失败输出原样进反驳者的提示词,没有中间人。
 *   ② 代码拼**不会挑重点**,给的是模板里那几段;协调者会挑(挑得好不好另说)。
 *   ③ 协调者那份长上下文在整个回环里被反复复用(缓存命中好);per-role 每个进程各自建,
 *      **总 token 明显更高**。这是这条路真正的代价。
 */

const fs = require("fs");
const adapters = require("./adapters.js");
const agentcli = require("./agentcli.js");
const usage = require("./usage.js");

/**
 * 角色规格：`名字[:宿主][:模型][:权限档]`
 *   proposer:codex:gpt-5.5:acceptEdits
 *   反驳者:claude:opus
 *   critic                       ← 宿主/模型/权限全用默认与自动分配
 *
 * 名字认下面这些别名以定 kind;认不出的按 propose 处理(原名留着当显示名)。
 */
const ALIASES = {
  proposer: { name: "提议者", kind: "propose" },
  "提议者": { name: "提议者", kind: "propose" },
  critic: { name: "反驳者", kind: "attack" },
  "反驳者": { name: "反驳者", kind: "attack" },
  reviewer: { name: "复核者", kind: "audit", trigger: "on_green" },
  "复核者": { name: "复核者", kind: "audit", trigger: "on_green" }
};

/** 各 kind 的默认权限档。**反驳者只读** —— 这是它存在的前提,不是可选项。 */
const DEFAULT_PERM = {
  propose: "acceptEdits", attack: "readOnly", audit: "readOnly", verdict: "readOnly"
};

const DUTY = {
  propose: "读代码,提出**最小侵入**的改法并**落地**(真的改文件)。不追求漂亮,只追求过判据。",
  attack: "只找反例。找出这个改法在哪些情况下失效、哪些入口没覆盖、判据有没有被糊弄过去。" +
    "**你不许改任何文件** —— 一个能顺手把问题抹平的反驳者等于没有反驳者。",
  audit: "判据已经判绿了。只回答一个问题:这是真修好了,还是把判据糊弄过去了?只读。",
  verdict: "看证据下结论。"
};

function parseRoleSpec(spec) {
  const parts = String(spec || "").split(":");
  const key = (parts[0] || "").trim();
  const base = ALIASES[key] || ALIASES[key.toLowerCase()] || { name: key || "角色", kind: "propose" };
  const r = Object.assign({}, base);
  if (parts[1] && parts[1].trim()) r.agent = parts[1].trim();
  if (parts[2] && parts[2].trim()) r.model = parts[2].trim();
  if (parts[3] && parts[3].trim()) r.permissionMode = parts[3].trim();
  return r;
}

/**
 * 补全角色:定 kind → 定宿主 → **自动分模型** → 定权限档。
 * 每个角色可以指到**不同的宿主** —— claude 演提议者、codex 演反驳者是合法配置。
 */
function resolveRoles(roles, opts) {
  opts = opts || {};
  const rs = (roles || []).map(function (r) {
    const o = Object.assign({}, r);
    o.kind = o.kind || "propose";
    o.name = o.name || "角色";
    o.agent = o.agent || opts.defaultAgent || null;
    o.permissionMode = o.permissionMode || DEFAULT_PERM[o.kind] || "auto";
    return o;
  });

  // 模型按**宿主**分组分配 —— 不同宿主的模型名不通用,混在一起分会分出不存在的组合
  const groups = new Map();
  rs.forEach(function (r, i) {
    const k = r.agent || "";
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push({ i: i, r: r });
  });
  const out = rs.slice();
  groups.forEach(function (items, agentId) {
    const ad = adapters.get(agentId);
    const assigned = adapters.assignModels(ad, items.map(function (x) { return x.r; }));
    assigned.forEach(function (r, n) { out[items[n].i] = r; });
  });
  return out;   // 顺序保持原样 —— 发言先后是有意义的(先提议后反驳)
}

/**
 * 拼一个角色这一轮的提示词。
 *
 * **它必须自成一体** —— 这个进程没有任何历史上下文,看不到别人的会话。上一轮为什么没过、
 * 本轮别人说了什么,全靠这段话带进去。漏一样它就只能瞎猜。
 */
function rolePrompt(ctx) {
  const r = ctx.role;
  const g = ctx.goal || {};
  const L = [];
  L.push("你是一次对抗回环里的「" + r.name + "」。现在是第 " + ctx.round + " 轮" +
    (ctx.budget && ctx.budget.rounds ? "（上限 " + ctx.budget.rounds + " 轮）" : "") + "。");
  L.push("");
  L.push("任务：" + (ctx.task || "见判据"));
  L.push("");
  L.push("判据命令：" + (g.command ? "`" + g.command + "`" : "（没有 —— 这次判不出达标）"));
  L.push("**判据由驱动方跑,不是你跑。你不许改它** —— 不放宽阈值、不注释掉失败用例、" +
    "不换一条更好过的命令。那是把尺子锯短。");
  if (g.metric && g.metric.name) {
    L.push("指标：" + g.metric.name +
      (g.metric.min != null ? " 需 ≥ " + g.metric.min : "") +
      (g.metric.max != null ? " 需 ≤ " + g.metric.max : ""));
  }
  L.push("");
  L.push("你这一轮要做的：" + (r.duty || DUTY[r.kind] || DUTY.propose));

  // 上一轮为什么没过 —— 没有这一段,提议者只会重复上一轮的改法
  if (ctx.lastGate) {
    L.push("");
    L.push("【上一轮判据结果】" + (ctx.lastGate.detail || ""));
    if (ctx.lastGate.output) {
      L.push("命令输出（尾部）：");
      L.push("```");
      L.push(String(ctx.lastGate.output).slice(-1500));
      L.push("```");
    }
  }
  // 本轮已发言的角色 —— 反驳者要看到提议者刚做了什么,否则它在反驳空气
  (ctx.said || []).forEach(function (s) {
    L.push("");
    L.push("【本轮 " + s.role + " 说】" + s.summary);
    if (s.body) L.push(String(s.body).slice(0, 2000));
  });
  // 上一轮反驳者提过什么 —— 提议者这一轮该正面回应
  if (ctx.lastAttacks && ctx.lastAttacks.length) {
    L.push("");
    L.push("【上一轮反驳者提过的问题（这一轮要正面回应）】");
    ctx.lastAttacks.forEach(function (s) { L.push("- " + s.summary); });
  }

  L.push("");
  L.push("输出格式（**严格照这个**,驱动方要按行解析）:");
  L.push("第一行：一句话结论,不超过 60 字,不要加任何前缀。");
  L.push("其后：分点说清理由与证据,引用 `文件:行号`。");
  L.push("");
  L.push("⚠ **不要调用任何 loop_* 工具**。这次回环的记账与裁定由驱动方做," +
    "你只管做好自己这个角色,然后把结论说出来。");
  return L.join("\n");
}

/**
 * 跑一个角色一轮。返回 { text, logs[], usageEvents[], exitCode } 或 { error }。
 * 用量单独一个 tracker,`soloLabel` 就是角色名 —— 这就是「逐角色的账」。
 */
function runRole(opts) {
  return new Promise(function (resolve) {
    const ad = opts.adapter;
    const model = agentcli.safeModel(opts.role.model);
    if (opts.role.model && !model) {
      return resolve({ error: "模型名不合法：" + opts.role.model });
    }
    const readOnly = opts.role.permissionMode === "readOnly";
    const perm = adapters.permissionFor(ad, opts.role.permissionMode);
    let args;
    try {
      args = ad.buildArgs({ model: model, cwd: opts.cwd, permission: perm, readOnly: readOnly });
    } catch (e) { return resolve({ error: "拼参数失败：" + e.message }); }

    const env = Object.assign({}, process.env);
    // 角色进程不用 MCP。万一它自己注册了,也别让它把事件写进来搅乱账本。
    delete env.CODE_FORGE_URL;

    const started = agentcli.run(args, { cwd: opts.cwd, env: env, bin: ad.bin });
    if (started.error) return resolve({ error: started.error });
    const child = started.child;
    opts.onChild && opts.onChild(child);

    const tracker = usage.createTracker({
      source: ad.id + "（" + opts.role.name + "）",
      soloLabel: opts.role.name,
      // 键也要按角色分 —— 都用默认的 "coordinator" 的话三个角色的账会被并成一条
      soloKey: "role:" + opts.role.name,
      // per-role 模式下**我们知道**这个进程用的是哪个模型,而 codex 的输出里不带模型名。
      // 传进去,用量表那一列才是真的,而不是一个「—」。
      model: model || null
    });
    const logs = [];
    let text = null;
    let buf = "";
    // ★ 观察两件事,它们是协调者「抓异常」的原料:
    //   wrote  —— 这个角色有没有**真的改过文件**(空跑检测靠它,而且是**观察到的**,
    //             不是靠 agent 自报 diff —— 自报经常没有,拿「没报」当「没改」会误杀健康回环)
    //   stalled —— 进程长时间一个字都不吐(卡住了),超时就中止,别让它把整段时限吃光
    let wrote = false;
    let stalled = false;
    const stallMs = opts.stallMs || 240000;
    let lastOut = Date.now();
    const stallTimer = setInterval(function () {
      if (Date.now() - lastOut < stallMs) return;
      stalled = true;
      logs.push("⚠ " + Math.round(stallMs / 1000) + "s 没有任何输出，判为卡住，中止这个角色");
      try { child.kill(); } catch (_) {}
      clearInterval(stallTimer);
    }, 5000);
    stallTimer.unref && stallTimer.unref();

    const onLine = function (line) {
      lastOut = Date.now();
      if (!line) return;
      if (typeof ad.parse !== "function") { logs.push(line.slice(0, 300)); return; }
      let m;
      try { m = JSON.parse(line); } catch (_) { logs.push(line.slice(0, 300)); return; }
      const r = tracker.ingestRaw(ad, m, opts.round);
      if (r && r.log) {
        String(r.log).split("\n").forEach(function (l) {
          logs.push(l);
          // 边跑边报:这一行就是「它此刻在干什么」(→ Read xxx / · 说了半句…)。
          // 节流是调用方的事 —— 这里一条不落地交出去
          if (opts.onActivity) { try { opts.onActivity(l); } catch (_) {} }
        });
      }
      // 只有**最后**那条「最终答复」算它的发言 —— 中途的碎话不是结论
      const parsed = ad.parse(m);
      if (parsed && parsed.text) text = parsed.text;
      // 写工具:各家名字不同(claude Edit/Write/MultiEdit;codex file_change/patch_apply),
      // 所以按模式认,不枚举 —— 枚举漏一个就会把「改过」当成「没改」。
      (parsed && parsed.records || []).forEach(function (rec) {
        (Array.isArray(rec.tools) ? rec.tools : []).forEach(function (t) {
          if (/edit|write|patch|file_change|apply/i.test(String(t.name || ""))) wrote = true;
        });
      });
    };

    try {
      if (ad.promptVia === "arg") child.stdin.end();
      else { child.stdin.write(opts.prompt); child.stdin.end(); }
    } catch (e) { return resolve({ error: "提示词写不进 stdin：" + e.message }); }

    child.stdout.on("data", function (b) {
      buf += b.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) onLine(line);
      }
    });
    child.stderr.on("data", function (b) {
      const s = b.toString().trim();
      if (s) logs.push("stderr: " + s.split("\n")[0].slice(0, 160));
    });
    let settled = false;
    child.on("error", function (e) {
      if (settled) return;
      settled = true;
      resolve({ error: "起不来：" + e.message });
    });
    child.on("close", function (code) {
      if (settled) return;
      settled = true;
      clearInterval(stallTimer);
      if (buf.trim()) onLine(buf.trim());
      const evs = tracker.flush();
      const fin = tracker.finalEvent();
      // ★ 「这个模型不能用」要跟「这一轮没做成」分开。实测两种:清单里有但装着的 CLI
      //   太旧(gpt-5.6-terra → requires a newer version)、以及这个账号用不了
      //   (gpt-5.6-sol → not supported when using ChatGPT account)。
      //   都不是回环的失败,是我们挑错了模型 —— 该换一个重试,不该把这一轮判死。
      const rejected = !text && opts.role.model &&
        adapters.looksLikeModelRejected(logs.join("\n")) ? opts.role.model : null;
      resolve({ text: text, logs: logs, exitCode: code, modelRejected: rejected,
        wrote: wrote, stalled: stalled,
        usageEvents: fin ? evs.concat([fin]) : evs });
    });
  });
}

// （2026-08 收窄）整回环驱动 start() 删了 —— 执行只发生在 coding agent 里。
// 留下的 runRole 是给 loop_agent(替无子 agent 的宿主派单个角色)用的。

module.exports = {
  runRole: runRole, parseRoleSpec: parseRoleSpec, resolveRoles: resolveRoles,
  rolePrompt: rolePrompt, DEFAULT_PERM: DEFAULT_PERM, DUTY: DUTY, ALIASES: ALIASES
};
