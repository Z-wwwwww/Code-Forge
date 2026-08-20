"use strict";
/**
 * 用量归属 —— 把 `claude -p --output-format stream-json` 的输出摊到**每个 agent** 头上。
 *
 * ⚠ 这层管的是**我们自己 spawn 的执行者**(loop_agent/评审者)。聊天里 Claude Code
 *   派的子 agent 走的是另一条路:它把每个子 agent 单独存了档,由 `chatusage.js` 读出来
 *   造成同样形状的 usage 事件,再进这里的 reduceEvents 汇总。两条路进的是同一个漏斗。
 *
 * 为什么这层能存在(而 README 以前说「用量不可得」):
 *   「不可得」只对**聊天里驱动**那条路成立 —— 那时执行者是你正在用的那个交互式会话,
 *   它不向我们报账。但页面点 Run / `code-forge tui` 起的是**我们自己 spawn 的**
 *   `claude -p`,它每条 assistant 事件都带 `message.usage`,收尾的 result 还带
 *   `total_cost_usd` 与 `modelUsage`。这些是**它自己报的真数**,不是我们估的。
 *   所以这条路上用量可得,那条路上仍然不可得 —— 两者必须分开说,不能拿一条的数字
 *   去糊另一条的空(那就成了假账)。
 *
 * 怎么分到每个 agent:
 *   子 agent 的事件带 `parent_tool_use_id`,它等于派它出去的那次 Task 调用的
 *   `tool_use.id`。于是先记下「Task(id) → subagent_type」,再把带同一个 parent 的
 *   用量记到那个子 agent 名下;不带 parent 的就是协调者本人。
 *
 * 三个容易出错的地方(都在下面对应处标了):
 *   ① 同一条 assistant 消息会被拆成**多个** stream-json 事件,每个都重复带一份
 *      相同的 usage。按 `message.id` 去重,否则用量会翻好几倍。
 *   ② tool_use 块反而分散在那些被拆开的事件里,所以工具要**逐事件**扫、按块 id 去重。
 *   ③ 成本只认它自己报的 `total_cost_usd`。我们不查价目表去乘 —— 价格会变,
 *      算出来的是编的。报不出就报不出。
 *
 * 还有一个**必须说出来的偏差**(实测,不是推测):
 *   逐条 assistant 的 `usage.output_tokens` **不含 thinking tokens**,而 thinking
 *   不带 `parent_tool_use_id` —— 它摊不到任何 agent 头上。所以**逐 agent 那几行的 out
 *   是下界**。中间那些 `system/thinking_tokens` 事件写的是 `estimated_tokens`
 *   (实测那次估到 131、实际 62),拿它去补只会补出一个更错的数。
 *
 * 那能不能拿 result 里的数当合计?**不能。** 实测同一次运行里三个数互不相等:
 *   逐条去重求和  in=29  cacheRead=88551
 *   result.usage  in=19  cacheRead=56789   ← iterations 只有 1 条,它是某一次调用的
 *   modelUsage    in=29  cacheRead=56789
 * 能说清出处的只有两样:我们自己摊出来的那份,以及 `total_cost_usd`(=各 modelUsage
 * 成本之和,这次运行真花的钱)。所以:**合计用摊出来的那份,成本用 total_cost_usd,
 * result 里那份只作为「CLI 收尾自报」摆在旁边** —— 三个数都摆着但各自标明出处,
 * 比挑一个当「权威」再让另外两个对不上要诚实。
 */

const EMPTY = function () {
  return { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, msgs: 0, tools: {} };
};

function addInto(dst, src) {
  dst.in += src.in || 0;
  dst.out += src.out || 0;
  dst.cacheRead += src.cacheRead || 0;
  dst.cacheWrite += src.cacheWrite || 0;
  dst.msgs += src.msgs || 0;
  Object.keys(src.tools || {}).forEach(function (k) {
    dst.tools[k] = (dst.tools[k] || 0) + src.tools[k];
  });
  return dst;
}

function isEmpty(b) {
  return !b.in && !b.out && !b.cacheRead && !b.cacheWrite && !b.msgs &&
    Object.keys(b.tools).length === 0;
}

/**
 * 从本次回环的角色表造一个「subagent_type + Task 描述 → 角色名」的解析器。
 * 角色名对得上,监控台里那几根用量条就落在**回环的角色**上,而不是一堆 forge-critic。
 */
function roleResolver(roles) {
  const list = (roles || []).filter(function (r) { return r && r.name; });
  return function (task) {
    const desc = String((task && task.description) || "") + " " + String((task && task.prompt) || "");
    // 先按描述里出现的角色名认 —— 同一个 subagent 派出多个角色时(三个反驳者各管一片)
    // 只有描述能把它们分开
    const named = list.filter(function (r) { return desc.indexOf(r.name) >= 0; });
    if (named.length === 1) return named[0].name;
    const sub = task && task.subagent;
    if (sub) {
      const bySub = list.filter(function (r) { return r.subagent === sub; });
      if (bySub.length === 1) return bySub[0].name;
    }
    return null;   // 认不出就用 subagent_type 本身当名字,不猜
  };
}

/**
 * tracker：喂 stream-json 的每一条,攒增量;flush() 取出可以写进事件流的那批。
 *
 * 增量而不是快照 —— 事件日志是 append-only 且会被从头 reduce 一遍,
 * 增量相加天然就是「累计」,同时还保留了「这一轮花了多少」这个信息。
 */
function createTracker(opts) {
  opts = opts || {};
  const resolveRole = typeof opts.roleOf === "function" ? opts.roleOf : function () { return null; };
  // 数字是谁报的,要跟着数字一起走 —— 页面上一句「来源」能省掉一场「这数准不准」的争论
  const source = opts.source || null;
  // 不带 parent 的那份账记在谁头上。能派子 agent 的宿主叫「协调者」(它下面还有别人);
  // 不能派的(codex exec)就叫「执行者」—— 它一个人把所有角色都演了,叫协调者是误导。
  const soloLabel = opts.soloLabel || "协调者";
  /**
   * 不带 parent 的那份账用什么**键**。
   *
   * ★ 默认 "coordinator" 只在「一个进程跑完全程」时对。per-role 模式下每个角色各有
   *   一个 tracker,如果都用同一个键,`reduceEvents` 会按键归并 —— 三个角色的账合成
   *   一条,表里只剩第一个角色(实测踩过:三份 usage 事件都在,表里只显示实现者)。
   *   所以 per-role 要把角色名当键传进来。
   */
  const soloKey = opts.soloKey || "coordinator";
  // 宿主输出里不带模型名时的兜底(codex 就不带)。per-role 模式下调用方**知道**
  // 这个进程用的是哪个模型 —— 传进来,表里那一列才是真的而不是「—」。
  const defaultModel = opts.model || null;

  const seenMsg = new Set();      // message.id → 已计过 usage（① 拆包重复）
  const seenBlock = new Set();    // tool_use.id → 已计过工具（② 同上）
  const tasks = new Map();        // Task 的 tool_use id → { subagent, description }
  const agents = new Map();       // key → { key, label, agentType, model, total }
  const pending = new Map();      // key + "|" + round → 增量（跨轮不能混,否则「本轮花了多少」是错的）
  const labels = new Map();       // label → 已占用它的 key（同名并发要区分开）
  let result = null;

  function agentFor(parentId, model) {
    const key = parentId || soloKey;
    let a = agents.get(key);
    if (!a) {
      let label, agentType = null;
      if (!parentId) {
        label = soloLabel;
      } else {
        const t = tasks.get(parentId);
        agentType = (t && t.subagent) || null;
        label = (t && resolveRole(t)) || agentType || "子 agent";
      }
      // 同一个名字并发跑两份(比如两个 forge-critic)必须能分开,否则两条账并成一条
      const owner = labels.get(label);
      if (owner && owner !== key) {
        let n = 2;
        while (labels.get(label + "·" + n)) n++;
        label = label + "·" + n;
      }
      labels.set(label, key);
      a = { key: key, label: label, agentType: agentType,
        model: model || defaultModel || null, total: EMPTY() };
      agents.set(key, a);
    }
    if (model && !a.model) a.model = model;
    return a;
  }

  function bucket(key, round) {
    const k = key + "|" + round;
    if (!pending.has(k)) pending.set(k, EMPTY());
    return pending.get(k);
  }

  /**
   * 喂一条**统一记录**(由宿主适配器从它自己的输出解出来,见 adapters.js)。
   *
   *   { parent, model, key, tools:[{id,name,subagent,description}], usage:{in,out,cacheRead,cacheWrite} }
   *
   * 这一层不认识任何一家的输出格式 —— 记账(去重/归属/分轮)与解析分开,
   * 加一个宿主就只是加一个 parse,不用碰这里。
   *
   * 返回 true 表示这条带来了新用量(调用方可据此决定要不要 flush)。
   */
  function ingestRecord(rec, round) {
    if (!rec || typeof rec !== "object") return false;
    round = round || 1;

    const a = agentFor(rec.parent || null, rec.model);
    const b = bucket(a.key, round);
    let changed = false;

    // ② 工具按块 id 去重 —— 同一条消息被拆成多条事件时,块会重复出现。
    //    形状防一手:适配器可以是用户自己写的,给个对象而不是数组不该把整个回环崩掉 ——
    //    记账错了是小事,回环挂了是大事。
    (Array.isArray(rec.tools) ? rec.tools : []).forEach(function (c) {
      if (!c || !c.name) return;
      const id = c.id || "";
      if (id && seenBlock.has(id)) return;
      if (id) seenBlock.add(id);
      b.tools[c.name] = (b.tools[c.name] || 0) + 1;
      changed = true;
      // 派子 agent:记下 id,后面带这个 parent 的用量就归它。
      // ⚠ 认的是 **subagent**(适配器从 input.subagent_type 取),不是工具名。踩过:
      //   原本写死 `name === "Task"`,而实测这版 Claude Code 派子 agent 的工具叫 `Agent`,
      //   于是每个子 agent 都掉进「认不出」那一档,一张按角色分的表变成一堆匿名行。
      if (c.subagent) {
        tasks.set(id, {
          subagent: c.subagent,
          description: c.description || "",
          prompt: c.prompt || ""
        });
      }
    });

    // ① 用量按 key 只计一次。key 是适配器给的去重键(claude 用 message.id ——
    //    同一条消息会被拆成多条事件、每条都重复带一份相同的 usage)。
    //    没有 key 的宿主(如 codex 的 turn.completed,每轮只来一次)按到达顺序直接计。
    const u = rec.usage;
    if (u && (!rec.key || !seenMsg.has(rec.key))) {
      if (rec.key) seenMsg.add(rec.key);
      b.in += u.in || 0;
      b.out += u.out || 0;
      b.cacheRead += u.cacheRead || 0;
      b.cacheWrite += u.cacheWrite || 0;
      // 上下文快照(末次调用的 in+缓存读写),给显示层用 Claude Code 的口径 —— 不累加
      a.ctx = (u.in || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
      b.msgs += 1;
      changed = true;
    }
    return changed;
  }

  /** 收尾汇总(适配器解出来的那份)。没有就没有 —— 成本不编。 */
  function setFinal(fin) { if (fin) result = fin; }

  /**
   * 喂一条宿主原始输出。适配器负责解,这里只负责记。
   * 返回 { log, changed } —— log 给「近期动静」那一栏用。
   */
  function ingestRaw(adapter, obj, round) {
    if (!adapter || typeof adapter.parse !== "function") return { log: null, changed: false };
    const r = adapter.parse(obj);
    if (!r) return { log: null, changed: false };
    let changed = false;
    (r.records || []).forEach(function (rec) {
      if (ingestRecord(rec, round)) changed = true;
    });
    if (r.final) { setFinal(r.final); changed = true; }
    return { log: r.log || null, changed: changed };
  }

  /** 取出待写的增量事件（取完清空)。没有增量就返回空数组 —— 不发空事件。 */
  function flush() {
    const out = [];
    pending.forEach(function (b, k) {
      if (isEmpty(b)) return;
      const cut = k.lastIndexOf("|");
      const key = k.slice(0, cut);
      const round = Number(k.slice(cut + 1)) || 1;
      const a = agents.get(key);
      if (!a) return;
      addInto(a.total, b);
      out.push({
        t: "usage", round: round,
        role: a.label, agent: a.key, agentType: a.agentType,
        model: a.model || null,
        in: b.in, out: b.out, cacheRead: b.cacheRead, cacheWrite: b.cacheWrite,
        ctx: a.ctx != null ? a.ctx : undefined,   // 快照,下游取最新,不累加
        msgs: b.msgs, tools: b.tools,
        source: source || "宿主自报"
      });
    });
    pending.clear();
    return out;
  }

  /**
   * 收尾汇总。**只在 agent 自己报了 result 时才有**;它没报就返回 null ——
   * 宁可没有这一行,也不要一行编出来的成本。
   */
  function finalEvent() {
    if (!result) return null;
    const ev = {
      t: "usage", total: true,
      costUsd: typeof result.costUsd === "number" ? result.costUsd : null,
      seconds: result.seconds || null,
      turns: result.turns || null,
      in: result.in || 0, out: result.out || 0,
      cacheRead: result.cacheRead || 0, cacheWrite: result.cacheWrite || 0,
      // thinking 只出现在收尾这一份里,逐条的 out 不含它 —— 单独记下来,好让页面把
      // 「逐 agent 之和」与「CLI 自报」的差额说清楚,而不是二选一硬凑
      thinking: result.thinking || 0,
      isError: !!result.isError,
      source: source || "宿主收尾自报"
    };
    if (result.byModel) ev.byModel = result.byModel;
    return ev;
  }

  /** 当前累计（给 /agent/status 用,页面不必等事件流) */
  function snapshot() {
    return {
      agents: Array.from(agents.values()).map(function (a) {
        return {
          key: a.key, role: a.label, agentType: a.agentType, model: a.model,
          in: a.total.in, out: a.total.out,
          cacheRead: a.total.cacheRead, cacheWrite: a.total.cacheWrite,
          msgs: a.total.msgs, tools: a.total.tools
        };
      }),
      costUsd: result && typeof result.costUsd === "number" ? result.costUsd : null
    };
  }

  return { ingestRecord: ingestRecord, ingestRaw: ingestRaw, setFinal: setFinal,
    flush: flush, finalEvent: finalEvent, snapshot: snapshot };
}

/**
 * 把事件流里的 usage 事件收成表 —— TUI、`code-forge usage`、网页共用同一套语义,
 * 免得三个地方各算各的、算出三个不一样的总数。
 */
function reduceEvents(events) {
  const byAgent = new Map();
  const byRound = new Map();
  let total = null;
  // ★ 混宿主时**每个宿主各发一条 total**,而且不是每家都报成本(codex 就不报)。
  //   两个后果都得处理:
  //     ① 原来 `total = ev` 是 last-wins —— 先来那条被直接丢掉,成本少算
  //     ② 只有一部分宿主报了成本时,那个数**不是整次运行的花费** ——
  //        显示成裸的 "$0.03" 等于少报账,跟这个项目其它地方的纪律冲突
  const sources = new Set();        // 有账可算的来源(发过增量的)
  const costSources = new Set();    // 真报了成本的来源
  let costSum = null;
  (events || []).forEach(function (ev) {
    if (!ev || ev.t !== "usage") return;
    if (ev.total) {
      // 多家各报一条 → 成本相加,别覆盖
      if (typeof ev.costUsd === "number") {
        costSum = (costSum || 0) + ev.costUsd;
        if (ev.source) costSources.add(String(ev.source).split("（")[0]);
      }
      total = total ? Object.assign({}, total, ev, {
        in: (total.in || 0) + (ev.in || 0), out: (total.out || 0) + (ev.out || 0),
        cacheRead: (total.cacheRead || 0) + (ev.cacheRead || 0),
        cacheWrite: (total.cacheWrite || 0) + (ev.cacheWrite || 0),
        thinking: (total.thinking || 0) + (ev.thinking || 0)
      }) : ev;
      return;
    }
    if (ev.source) sources.add(String(ev.source).split("（")[0]);
    const key = ev.agent || ev.role || "?";
    if (!byAgent.has(key)) {
      byAgent.set(key, {
        key: key, role: ev.role || key, agentType: ev.agentType || null,
        model: ev.model || null, rounds: new Set(), acc: EMPTY()
      });
    }
    const a = byAgent.get(key);
    if (ev.model && !a.model) a.model = ev.model;
    a.rounds.add(ev.round || 1);
    // ctx 是**快照**(该 agent 末次调用的上下文规模),取最新值 —— 累加它就是把
    // 同一段上下文数 N 遍(实测被用户当成账炸了:「预计只有 1000k 上下」)
    if (ev.ctx != null) a.ctx = ev.ctx;
    addInto(a.acc, ev);

    const rk = ev.round || 1;
    if (!byRound.has(rk)) byRound.set(rk, new Map());
    const rm = byRound.get(rk);
    // key 要一路带出去:同一角色并发派了三份(三个反驳者)时,轮内账只有按 key
    // 才对得上是哪一份 —— 按角色名对,三行全命中第一份(实测:表里三行同一个数)
    if (!rm.has(key)) rm.set(key, { key: key, role: ev.role || key, acc: EMPTY() });
    addInto(rm.get(key).acc, ev);
  });

  const agents = Array.from(byAgent.values()).map(function (a) {
    return {
      key: a.key, role: a.role, agentType: a.agentType, model: a.model,
      rounds: Array.from(a.rounds).sort(function (x, y) { return x - y; }),
      in: a.acc.in, out: a.acc.out, cacheRead: a.acc.cacheRead, cacheWrite: a.acc.cacheWrite,
      ctx: a.ctx != null ? a.ctx : null,
      msgs: a.acc.msgs, tools: a.acc.tools
    };
  }).sort(function (x, y) { return (y.in + y.out) - (x.in + x.out); });

  const grand = agents.reduce(function (acc, a) {
    acc.in += a.in; acc.out += a.out; acc.cacheRead += a.cacheRead; acc.cacheWrite += a.cacheWrite;
    acc.msgs += a.msgs;
    return acc;
  }, { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, msgs: 0 });
  // 上下文合计 = 各 agent 末次上下文之和(每只各报一次,不重复) —— Claude Code 屏上
  // 那些「N tokens」加起来就是它。没有任何 agent 报过 ctx 就是 null,不硬凑
  const ctxKnown = agents.filter(function (a) { return a.ctx != null; });
  grand.ctx = ctxKnown.length
    ? ctxKnown.reduce(function (s, a) { return s + a.ctx; }, 0) : null;

  const rounds = Array.from(byRound.keys()).sort(function (x, y) { return x - y; }).map(function (n) {
    return {
      n: n,
      agents: Array.from(byRound.get(n).values()).map(function (v) {
        return {
          key: v.key, role: v.role, in: v.acc.in, out: v.acc.out,
          cacheRead: v.acc.cacheRead, cacheWrite: v.acc.cacheWrite,
          msgs: v.acc.msgs, tools: v.acc.tools
        };
      }).sort(function (x, y) { return (y.in + y.out) - (x.in + x.out); })
    };
  });

  // result 里那份**不是全程总数**,别拿它当合计。实测同一次运行的三个数互不相等:
  //   逐条 assistant 去重求和  in=29  cacheRead=88551
  //   result.usage             in=19  cacheRead=56789   (iterations 只有 1 条 → 它是某一次调用的)
  //   result.modelUsage        in=29  cacheRead=56789
  // 能说清出处的只有两样:**我们自己摊出来的那份**(grand),和 **total_cost_usd**
  // (它等于 modelUsage 各项成本之和,是这次运行的钱)。所以合计用 grand,
  // result 那份只作为「CLI 自己收尾时说的数」单独摆出来,不冒充总数。
  const reported = total ? { in: total.in || 0, out: total.out || 0,
    cacheRead: total.cacheRead || 0, cacheWrite: total.cacheWrite || 0,
    thinking: total.thinking || 0 } : null;

  return {
    agents: agents, rounds: rounds, grand: grand, reported: reported,
    // CLI 自报的 out 比逐 agent 之和多出来的部分。主要是 thinking —— 它不带
    // parent_tool_use_id,摊不到任何 agent 头上。标出来是为了解释「为什么加不齐」,
    // 不是为了当成合计的一部分。
    unattributedOut: reported ? Math.max(0, reported.out - grand.out) : 0,
    // 有就是它自己报的;没有就是 null。null ≠ 0 —— 一个是「没报」,一个是「免费」。
    costUsd: costSum,
    // 成本覆盖了哪些宿主 / 有没有宿主没报 —— 只有一部分报了的时候,那个数不是全程花费
    costFrom: Array.from(costSources),
    costMissing: Array.from(sources).filter(function (x) { return !costSources.has(x); }),
    costPartial: costSum != null && sources.size > costSources.size,
    total: total, measured: agents.length > 0
  };
}

/**
 * MCP 工具的全名长得吓人(`mcp__code-forge__loop_begin`),一条就把「它在干什么」
 * 那一列占满、后面几个工具全被截掉。只留最后那一段 —— 服务器名在这一列里没有信息量。
 */
function shortTool(name) {
  return String(name || "").replace(/^mcp__.+__/, "");
}

/** 工具次数排个序,取前几个 —— 「这一轮它到底在干什么」看这个最直接 */
function topTools(tools, n) {
  return Object.keys(tools || {})
    .map(function (k) { return [shortTool(k), tools[k]]; })
    .sort(function (a, b) { return b[1] - a[1]; })
    .slice(0, n || 4);
}

module.exports = {
  createTracker: createTracker, reduceEvents: reduceEvents,
  roleResolver: roleResolver, topTools: topTools, shortTool: shortTool
};
