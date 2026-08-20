"use strict";
/**
 * 聊天里那条路的**真模型与真用量** —— 从 Claude Code 自己写的子 agent 档案里读。
 *
 * ## 为什么以前是「不可得」,现在不是
 *
 * 老结论是:聊天里驱动时执行者是用户正在用的那个交互式会话,它不向我们报账,所以
 * 用量拿不到、模型只能显示 `roles[*].model` 里那个占位。**前半句仍然对,后半句不对了** ——
 * 派出去的每个子 agent,Claude Code 都单独存了一份档案:
 *
 *   ~/.claude/projects/<把 cwd 里非字母数字全换成 - >/<sessionId>/subagents/
 *       agent-xxxx.jsonl        逐条 assistant 消息,带 message.model 与 message.usage
 *       agent-xxxx.meta.json    { agentType: "forge-critic", description: "反驳者③…" }
 *
 * 这不是估算,是**它自己写下来的数**:哪个模型、进了多少 token、缓存读了多少。
 * 角色 = 子 agent,所以这份档案正好就是「逐角色的账」。
 *
 * ## 三个必须处理的坑(都是实测,不是推测)
 *
 *  ① **同一条消息在文件里出现好几次**(流式分片各写一行,每行都带同一份 usage)。
 *     实测一个反驳者的档案 25 行 assistant、只有 10 个不同的 message.id ——
 *     不按 id 去重,账直接翻 2.5 倍。工具块同理,按 tool_use.id 去重。
 *  ② **不是这个回环的子 agent 不能算进来**。同一个项目目录下用户可能还在别的会话里
 *     干别的活(Explore、general-purpose…)。所以两道闸:消息时间戳要在本次回环开始
 *     之后,agentType 要么是 forge-*、要么描述里点了名字对得上某个角色。
 *  ③ **协调者本人的账仍然拿不到**,这里也不假装拿得到:它的 token 混在用户那条会话的
 *     整个对话里(还包括跟这次回环无关的聊天),摊不出来。所以这份账是**角色的账**,
 *     UI 上必须这么说,不能当成「这次回环的全部花费」。
 *
 * 收敛方式是**增量**:每次 pull 把「档案里现在的总数」减掉「上次报过的总数」,
 * 只发差额。usage 事件在下游是累加语义(usage.reduceEvents),发全量会越加越多。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

/** cwd → Claude Code 的项目目录名(非字母数字一律换成 -,与它自己的规则一致) */
function slugFor(cwd) {
  return String(cwd || "").replace(/[^a-zA-Z0-9]/g, "-");
}

function rootFor(home, cwd) {
  // ⚠ 没传 home 时得认 CLAUDE_CONFIG_DIR —— 跟 install.js:27 同一条规矩,
  // 否则设了这个变量的用户,子 agent 档案根本不在 ~/.claude 下,逐角色用量恒空。
  const claudeDir = home ? path.join(home, ".claude")
    : (process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"));
  return path.join(claudeDir, "projects", slugFor(cwd || process.cwd()));
}

/** 子 agent 类型 → 这个回环里的角色 kind。用户改过模型/名字都不影响这条对应关系。 */
const TYPE_KIND = { "forge-proposer": "propose", "forge-critic": "attack", "forge-reviewer": "audit" };

/**
 * 这份档案是本回环里的哪个角色?认不出来就回 null —— **不猜**。
 * 先按描述里点到的名字认(同一类型派好几个时只有它能分开),再按 agentType 的 kind 认。
 */
function resolveRole(roles, meta) {
  const list = (roles || []).filter(function (r) { return r && r.name; });
  const desc = String((meta && meta.description) || "");
  const named = list.filter(function (r) { return desc.indexOf(r.name) >= 0; });
  if (named.length === 1) return named[0].name;
  const kind = TYPE_KIND[(meta && meta.agentType) || ""];
  if (kind) {
    const byKind = list.filter(function (r) { return r.kind === kind; });
    if (byKind.length === 1) return byKind[0].name;
  }
  return null;
}

const ZERO = function () {
  return { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, msgs: 0, tools: {} };
};

/**
 * 读一份子 agent 档案,汇总 sinceMs 之后的用量。
 * 读不动(还在写、半行 JSON、文件没了)就跳过那一行 —— 这层永远不许把回环搞挂。
 */
function readTotals(file, sinceMs) {
  const acc = ZERO();
  let model = null;
  let ctx = null;   // 末次调用的上下文规模(in+缓存读+缓存写)—— Claude Code 给 agent 显示的口径
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (_) { return { acc: acc, model: null, ctx: null }; }
  const seenMsg = new Set();     // 坑①:分片重复,按 message.id 去重
  const seenBlock = new Set();
  text.split("\n").forEach(function (line) {
    if (!line) return;
    let e;
    try { e = JSON.parse(line); } catch (_) { return; }
    if (!e || e.type !== "assistant" || !e.message) return;
    if (sinceMs && e.timestamp && Date.parse(e.timestamp) < sinceMs) return;   // 坑②:上一局的不算
    const m = e.message;
    // 合成消息(中断/出错时 Claude Code 自己补的一条,usage 全 0)不是模型说的话 ——
    // 算进来只会让模型列显示「<synthetic>」,实测就是这么冒出来的
    if (m.model === "<synthetic>") return;
    if (m.model) model = m.model;
    (m.content || []).forEach(function (c) {
      if (!c || c.type !== "tool_use" || !c.id || seenBlock.has(c.id)) return;
      seenBlock.add(c.id);
      acc.tools[c.name] = (acc.tools[c.name] || 0) + 1;
    });
    const u = m.usage;
    if (!u) return;
    /* ★ 上下文规模取**最后一条**消息的(快照,不累加)。实测教训:把历次调用的缓存读
     *   加起来当「用量」,一个 agent 十几次调用直接加到几百万 —— 用户对照 Claude Code
     *   屏上的 100~300k(它显示的就是当前上下文)以为账炸了(「预计只有 1000k 上下」)。 */
    ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    if (!m.id || seenMsg.has(m.id)) return;
    seenMsg.add(m.id);
    acc.msgs++;
    acc.in += u.input_tokens || 0;
    acc.out += u.output_tokens || 0;
    acc.cacheRead += u.cache_read_input_tokens || 0;
    acc.cacheWrite += u.cache_creation_input_tokens || 0;
  });
  return { acc: acc, model: model, ctx: ctx };
}

/** 列出这个项目下所有子 agent 档案(跨会话 —— 用户中途重开会话也接得上) */
function listAgents(root) {
  const out = [];
  let sessions;
  try { sessions = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { return out; }
  sessions.forEach(function (d) {
    if (!d.isDirectory()) return;
    const dir = path.join(root, d.name, "subagents");
    let files;
    try { files = fs.readdirSync(dir); } catch (_) { return; }
    files.forEach(function (f) {
      if (!/\.meta\.json$/.test(f)) return;
      const id = f.replace(/\.meta\.json$/, "");
      const jsonl = path.join(dir, id + ".jsonl");
      let meta = null, stat = null;
      try { meta = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch (_) { return; }
      try { stat = fs.statSync(jsonl); } catch (_) { return; }
      out.push({ id: id, file: jsonl, meta: meta, mtime: stat.mtimeMs, size: stat.size });
    });
  });
  return out;
}

/**
 * 增量取数器。每次 pull 回一批 usage 事件(只含**新增的**那部分),没有新增就回空数组。
 *
 * @param opts.roles   本回环的角色表(用来把档案认到角色头上)
 * @param opts.sinceMs 本回环开始的时间戳 —— 之前的消息一律不算
 */
function createPuller(opts) {
  opts = opts || {};
  const root = opts.root || rootFor(opts.home, opts.cwd);
  const sinceMs = opts.sinceMs || 0;
  const roles = opts.roles || [];
  const seen = new Map();     // agentId → { acc, mtime, size }

  return {
    root: root,
    /* 正在干活的证据:本回环的子 agent 档案里,mtime 仍新鲜的那些。
     * ★ 这是**观察**(文件真的在被写),不是「上一条是谁说的」那种推测 ——
     *   心跳优先用它,措辞才有资格不带「多半」(实测被问:直播怎么还有猜测)。 */
    activity: function (staleMs) {
      const now = Date.now();
      return listAgents(root).filter(function (a) {
        if (a.mtime < sinceMs) return false;
        const role = resolveRole(roles, a.meta);
        const type = String((a.meta && a.meta.agentType) || "");
        if (!role && type.indexOf("forge-") !== 0) return false;
        return now - a.mtime <= (staleMs || 150000);
      }).map(function (a) {
        return { agent: a.id, role: resolveRole(roles, a.meta) || String((a.meta && a.meta.agentType) || ""),
          agoMs: now - a.mtime };
      }).sort(function (x, y) { return x.agoMs - y.agoMs; });
    },
    pull: function (round) {
      const evs = [];
      listAgents(root).forEach(function (a) {
        if (a.mtime < sinceMs) return;                    // 坑②:上一局留下的档案
        const role = resolveRole(roles, a.meta);
        const type = String((a.meta && a.meta.agentType) || "");
        // 认不出角色、又不是本技能的子 agent → 是用户在这个目录下干的别的活,不是我们的账
        if (!role && type.indexOf("forge-") !== 0) return;
        const prev = seen.get(a.id);
        if (prev && prev.mtime === a.mtime && prev.size === a.size) return;   // 没动过就别重读
        const cur = readTotals(a.file, sinceMs);
        const base = (prev && prev.acc) || ZERO();
        const d = {
          in: cur.acc.in - base.in, out: cur.acc.out - base.out,
          cacheRead: cur.acc.cacheRead - base.cacheRead,
          cacheWrite: cur.acc.cacheWrite - base.cacheWrite,
          msgs: cur.acc.msgs - base.msgs, tools: {}
        };
        Object.keys(cur.acc.tools).forEach(function (k) {
          const n = cur.acc.tools[k] - (base.tools[k] || 0);
          if (n > 0) d.tools[k] = n;
        });
        seen.set(a.id, { acc: cur.acc, mtime: a.mtime, size: a.size });
        if (!(d.in || d.out || d.cacheRead || d.cacheWrite || d.msgs)) return;
        evs.push({
          t: "usage",
          agent: a.id,                       // 键必须唯一:同一轮三个反驳者不能并成一条账
          role: role || type || "子 agent",
          agentType: type || null,
          model: cur.model || null,          // ★ 它自己写下来的真模型,不是配置里那个占位
          round: round || 1,
          in: d.in, out: d.out, cacheRead: d.cacheRead, cacheWrite: d.cacheWrite,
          ctx: cur.ctx,                      // 快照(末次上下文),下游取最新值,**不许累加**
          msgs: d.msgs, tools: d.tools,
          source: "claude 子 agent 档案"
        });
      });
      return evs;
    }
  };
}

module.exports = { slugFor: slugFor, rootFor: rootFor, resolveRole: resolveRole,
  readTotals: readTotals, listAgents: listAgents, createPuller: createPuller,
  TYPE_KIND: TYPE_KIND };
