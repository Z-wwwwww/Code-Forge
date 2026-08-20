"use strict";
/**
 * 终端里的配置 + 直播。零依赖,只用 ANSI 与 readline。
 *
 *   code-forge              直播正在跑的回环（观察面;开跑在 coding agent 里）
 *   code-forge watch        只直播（回环是从聊天里 /code-forge 起的时候用这个）
 *
 * 两条设计纪律:
 *  ① **不是 TTY 就不要画面**。管道/CI 里 clear-screen 与 raw mode 只会产出垃圾,
 *    此时退化成一行一条的顺序输出 —— 同一份数据,两种呈现。
 *  ② 渲染是纯函数(reduce → render → 字符串),所以它可被单测,不必靠肉眼看。
 */

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const { spawn } = require("child_process");

/* ---------------- 颜色（NO_COLOR / 非 TTY 时自动退化） ---------------- */
const TTY = process.stdout.isTTY && !process.env.NO_COLOR;
const C = (function () {
  const wrap = (n) => (s) => (TTY ? "\x1b[" + n + "m" + s + "\x1b[0m" : String(s));
  return {
    dim: wrap(90), bold: wrap(1),
    teal: wrap(36), red: wrap(31), yellow: wrap(33), green: wrap(32),
    blue: wrap(34), magenta: wrap(35), grey: wrap(37)
  };
})();
const ROLE_COLORS = [C.teal, C.red, C.yellow, C.blue, C.green, C.magenta];
const KIND_LABEL = {
  propose: "PROPOSE", attack: "ATTACK", defend: "DEFEND", verdict: "VERDICT",
  patch: "PATCH", test: "TEST", audit: "AUDIT", route: "ROUTE"
};
const STOP_LABEL = {
  // ★ 达标有两种,显示上必须分得清:命令判过是可复现的,评审判定不是
  goal_met: "达标停止（命令判过）",
  judged_met: "达标停止（评审判定）",
  reported_met: "达标停止（角色上报的指标）",
  interrupted: "中断（上一局没收尾就断了 —— 已补账,不是还在跑）",
  idle_spin: "空跑（没人真的改过东西）",
  stalled: "停滞（角色进程卡住）",
  judge_broken: "评审判据本身失败", budget_rounds: "轮数用完", budget_time: "超出时限",
  no_progress: "连续零进展", stopped: "手动停止", gate_broken: "判据本身失败",
  abandoned: "agent 放弃", driver_error: "驱动异常", budget_tokens: "TOKEN 用尽"
};

/* ---------------- 找监控台（与 mcp.js 同一套三级发现） ---------------- */
function discoverBase() {
  if (process.env.CODE_FORGE_URL) return process.env.CODE_FORGE_URL;
  const pf = path.join(os.tmpdir(), "code-forge-port.json");
  try {
    const info = JSON.parse(fs.readFileSync(pf, "utf8"));
    if (info && info.port) {
      /* ★ 先验尸再信。实测事故链:监控台被硬杀(exit 清理没跑)→ 端口文件指着尸体 →
       *   发现机制永远打一个死端口 → 每次都再拉新监控台 → 新的把 4610+ 都占满后
       *   自己也起不来 —— 而那些「僵尸」其实都活着、/health 全答 200,明明可以复用。
       *   pid 验活(kill 0);死了就删文件,发现机制落回默认口,正好接上活着的那个。 */
      let aliveOwner = true;
      if (info.pid) { try { process.kill(info.pid, 0); } catch (_) { aliveOwner = false; } }
      if (aliveOwner) return "http://localhost:" + info.port;
      try { fs.unlinkSync(pf); } catch (_) {}
    }
  } catch (_) {}
  return "http://localhost:4610";
}

function req(base, p, method, body) {
  return new Promise(function (resolve, reject) {
    const u = new URL(base + p);
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body), "utf8");
    const r = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: method || "GET",
      headers: data ? { "content-type": "application/json", "content-length": data.length } : {}
    }, function (res) {
      let s = "";
      res.on("data", (d) => { s += d; });
      res.on("end", function () {
        let j = null;
        try { j = s ? JSON.parse(s) : {}; } catch (_) { j = { raw: s }; }
        resolve({ status: res.statusCode, body: j });
      });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

async function ensureConsole(base) {
  try { const h = await req(base, "/health"); if (h.status === 200) return base; } catch (_) {}
  // 没起来就拉一个（不开浏览器 —— 用 TUI 的人要的就是别弹网页）
  const child = spawn(process.execPath, [path.join(__dirname, "server.js"), "--no-open"],
    { detached: true, stdio: "ignore" });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const b = discoverBase();
    try { const h = await req(b, "/health"); if (h.status === 200) return b; } catch (_) {}
  }
  throw new Error("监控台起不来。手动诊断：node " + path.join(__dirname, "server.js") +
    " web --no-open   （裸跑只打指引,不起服务 —— 要带 web）");
}

/* ---------------- 事件 → 状态（与网页同一套 reduce 语义） ---------------- */
function newState() {
  /* ⚠ 每个会在 reduce 里赋值的字段都必须列在这儿:run.start 换茬走的是
   *   Object.keys(newState()) 逐键复位 —— 漏一个键,旧局的值就活进新局。
   *   实测:streaming 没列,新局 R1 挂着上一局的「第 2 轮 · 距上一条发言已 593s」。 */
  return { run: null, roles: {}, roleOrder: [], rounds: [], byN: {}, ended: null, count: 0, unknown: 0,
    usageEvents: [], streaming: null };
}
function reduce(st, ev) {
  st.count++;
  const role = function (id) {
    if (!st.roles[id]) {
      st.roles[id] = { id: id, name: id, model: "—", calls: 0, color: st.roleOrder.length };
      st.roleOrder.push(id);
    }
    return st.roles[id];
  };
  const round = function (n) {
    if (!st.byN[n]) {
      st.byN[n] = { n: n, title: "第 " + n + " 轮", events: [], conflicts: 0, live: true, verdict: null };
      st.rounds.push(st.byN[n]);
      st.rounds.sort((a, b) => a.n - b.n);
    }
    return st.byN[n];
  };
  switch (ev.t) {
    case "run.start":
      // 新一轮回环:换一茬,否则两次的「第 1 轮」会挤在同一格(与网页同一条纪律)
      if (st.run) { const f = newState(); Object.keys(f).forEach((k) => { st[k] = f[k]; }); st.count = 1; }
      st.run = ev; break;
    case "role.add": {
      const r = role(ev.id);
      if (ev.name) r.name = ev.name;
      if (ev.model) r.model = ev.model;
      if (ev.duty) r.duty = ev.duty;
      break;
    }
    case "round.start": { const r = round(ev.n); if (ev.title) r.title = ev.title; break; }
    case "event": {
      const r = round(ev.round || 1);
      r.events.push(ev);
      const ro = role(ev.role);
      ro.calls++;
      // loop_say 可以带 tok(执行者看得到子 agent 用量时报的) —— 攒进角色行,
      // 不然聊天路径的角色永远「不可得」,而账其实有一半是报了的
      if (ev.tok && (ev.tok.in || ev.tok.out)) {
        ro.tokIn = (ro.tokIn || 0) + (ev.tok.in || 0);
        ro.tokOut = (ro.tokOut || 0) + (ev.tok.out || 0);
      }
      break;
    }
    case "conflict": round(ev.round || 1).conflicts++; break;
    case "round.end": {
      const r = round(ev.n);
      r.live = false;
      r.verdict = { winner: ev.winner, score: ev.score };
      break;
    }
    case "run.end": st.ended = ev; break;
    case "run.streaming": st.streaming = ev; break;
    case "patch": break;
    // 用量原样收着,汇总在渲染时现算 —— 与网页、`code-forge usage` 共用 usage.reduceEvents,
    // 三个地方算出三个不一样的总数是最难查的那种 bug
    case "usage": st.usageEvents.push(ev); break;
    default: st.unknown++;
  }
  return st;
}

/* ---------------- 渲染（纯函数,可单测） ---------------- */
function bar(width, ch) { return new Array(Math.max(0, width)).join(ch || "─"); }
function clip(s, n) {
  s = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  // 中文按两格算,否则表格会歪
  let w = 0, out = "";
  for (const ch of s) {
    const cw = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1;
    if (w + cw > n) {
      // ⚠ 省略号**也占一格**。以前直接 `out + "…"`,截出来能比 n 还宽一格 ——
      //   一格不起眼,可每张表都歪一格,那正是「一屏看起来很乱」的底噪。先腾位置再加。
      while (out && w > n - 1) {
        const last = Array.from(out).pop();
        out = out.slice(0, out.length - last.length);
        w -= dispWidth(last);
      }
      return n >= 1 ? out + "…" : out;
    }
    out += ch; w += cw;
  }
  return out;
}
// 补齐也必须按显示宽度算 —— padEnd 数的是字符数,一列中文名就把整张表顶歪
function dispWidth(s) {
  let w = 0;
  for (const ch of String(s == null ? "" : s)) {
    w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1;
  }
  return w;
}
function pad(s, n) {
  const c = clip(s, n);
  return c + " ".repeat(Math.max(0, n - dispWidth(c)));
}
/**
 * 折行而不是截断。**只用在「这段话本身就是唯一的信息」的地方** ——
 * 协调者交白卷时,note 是它给出的全部理由,截掉一半等于把原因藏起来。
 * 表格列仍然用 clip(截断)：那里错的是布局,不是信息。
 */
function wrapText(s, width, indent) {
  s = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  if (!s) return [];
  const lines = [];
  let cur = "", w = 0;
  for (const ch of s) {
    const cw = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1;
    if (w + cw > width) { lines.push(cur); cur = ""; w = 0; }
    cur += ch; w += cw;
  }
  if (cur) lines.push(cur);
  return lines.map(function (l, i) { return (i === 0 ? "" : (indent || "")) + l; });
}

/* ---------------- 视觉件（整屏只用这几种元件） ---------------- */
/**
 * 一屏东西之所以「乱」,基本不是因为信息多,是因为**同一种东西每处画法不一样**:
 * 这儿两个空格那儿四个、这儿一条线那儿一个空行、数字有的左对齐有的右对齐。
 * 所以元件收在这里,别在各处现编 —— 多一种画法就多一份「看起来不像同一个程序」。
 */
const GL = {
  head: "━",      // 顶栏/收尾:重
  rule: "─",      // 分节:轻
  gutter: "│",    // 行内竖线（时间 | 角色）
  dot: "●", ring: "○",
  ok: "✔", run: "▸", stop: "■", arrow: "→"
};
const SPARK = "▁▂▃▄▅▆▇█";

/** 这一屏画多宽。问答与直播共用同一把尺子,否则线长一屏一个样。 */
function termW() { return Math.max(60, Math.min(process.stdout.columns || 80, 100)); }

/** 右对齐。数字列左对齐时位数一多就读不出大小 —— 表格里所有数字都走这条。 */
function padL(s, n) {
  const c = clip(s, n);
  return " ".repeat(Math.max(0, n - dispWidth(c))) + c;
}

/**
 * 把几段带颜色的东西塞进一行,**按给的先后当优先级**:先来的先占位,最后那段放不下就截掉。
 *
 * 为什么非有这个不可:一行溢出去,终端会**硬折**成两行 —— 在确认那一屏上,
 * 硬折会把下面每一行都顶下去一格,于是「点第 3 行」点中的是第 4 项。
 * 也就是说这不只是好不好看,溢出会让点选**点错**。
 */
function fitSegs(segs, avail) {
  const out = [];
  let w = 0;
  for (let i = 0; i < segs.length; i++) {
    const t = segs[i].t;
    const paint = segs[i].c || function (x) { return x; };
    if (!t) continue;
    const left = avail - w;
    if (left <= 1) break;
    if (dispWidth(t) <= left) { out.push(paint(t)); w += dispWidth(t); continue; }
    const cut = clip(t, left);
    out.push(paint(cut));
    break;
  }
  return out.join("");
}

/** 「标签 + 值」。标签列宽固定,整屏的标签才对得齐。 */
function kv(label, value) { return C.dim(pad(label, 6)) + value; }

/**
 * 一条带标题的细线：`─ 角色 ────────────  裁决 覆盖率 82 ─`。
 * 分节用线不用空行:空行只说明「这里断开了」,线还能顺便说清「下面是什么」。
 */
function rule(title, W, right) {
  const t = title ? " " + title + " " : "";
  const r = right ? " " + right + " " : "";
  const fill = Math.max(3, W - 1 - dispWidth(t) - dispWidth(r) - (right ? 1 : 0));
  return C.dim(GL.rule) + (title ? C.bold(t) : "") +
    C.dim(GL.rule.repeat(fill)) + (right ? C.dim(r) + C.dim(GL.rule) : "");
}

/**
 * 迷你走势条。判据那串数字**只在互相比较时才有意义** —— 68 74 82 是在爬还是在原地打转,
 * 一排字要读三遍,一条 ▁▄█ 一眼就完。数字仍然照写,这条只是给它一个形状。
 */
function spark(vals) {
  const ns = vals.filter(function (v) { return typeof v === "number" && isFinite(v); });
  if (ns.length < 2) return "";
  const lo = Math.min.apply(null, ns), hi = Math.max.apply(null, ns);
  return ns.map(function (v) {
    const i = hi === lo ? SPARK.length - 1
      : Math.round((v - lo) / (hi - lo) * (SPARK.length - 1));
    return SPARK[i];
  }).join("");
}

/* ---------------- 用量（逐 agent） ---------------- */
function kfmt(n) {
  n = n || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  // ★ 两位数以上也带单位。「396↑」和「14.5k↓」混排时没人知道 396 是 396 还是 396k
  //   (实测被点名「有的有单位有的没单位」)。个位数与 0 保持裸数 —— 0.00k 更糊弄人。
  if (n >= 100) return (n / 1000).toFixed(1) + "k";
  if (n >= 10) return (n / 1000).toFixed(2) + "k";
  return String(n);
}
/** claude-opus-4-5-20251101 → opus-4-5。整串写进表格会把别的列全挤没。 */
function shortModel(m) {
  if (!m) return "—";
  return String(m).replace(/^claude-/, "").replace(/-\d{8}$/, "");
}
/** 「它这一轮到底在干什么」——工具次数比一句摘要更说明问题 */
function toolsLabel(tools, n) {
  const top = require("./usage.js").topTools(tools, n || 4);
  return top.map(function (p) { return p[0] + "×" + p[1]; }).join(" ");
}

/**
 * 用量表。**只在真有上报时才画** —— 一张全是「—」的表会被读成「量过了,都是零」,
 * 而实际是「这条路根本没人报账」(聊天里驱动就是这样)。两者的下一步动作完全不同。
 *
 * @param u      usage.reduceEvents(...) 的结果
 * @param curN   当前轮次(用来单列「本轮」)
 */
function renderUsage(u, curN, W) {
  if (!u || !u.measured) return [];
  const L = [];
  const cur = (u.rounds || []).filter(function (r) { return r.n === curN; })[0] || null;
  // ★ 按 key(agent id)对轮内账,不按角色名 —— 三个反驳者并发时按名字对,
  //   三行全命中第一份的数(实测:本轮列三行都是 46/14.5k,工具列也一样)
  const roundOf = function (key) {
    if (!cur) return null;
    return cur.agents.filter(function (a) { return a.key === key; })[0] || null;
  };

  // 合计 = **摊出来的那份**。不用 result 里的数冒充总数 —— 实测它和逐条求和对不上,
  // 而且 iterations 只有一条,它压根不是全程的(详见 usage.js 顶部)。
  const g = u.grand;
  const parts = [
    /* ★ 口径要跟用户屏上那把尺一致:头号数字 = 各 agent **末次上下文**之和(Claude Code
     *   给 agent 显示的就是它)。缓存**累计**是另一把尺(计费口径:每次调用把整个上下文
     *   重读一遍,十几次调用轻松累到千万级) —— 必须带解释地降级摆,不然会被当成账炸了。 */
    g.ctx != null ? "上下文 " + kfmt(g.ctx) + "（各 agent 末次之和,Claude Code 同口径）" : null,
    kfmt(g.in) + "↑ / " + kfmt(g.out) + "↓",
    g.cacheRead ? "缓存重读累计 " + kfmt(g.cacheRead) + "（计费口径:每次调用重读全上下文,非占用量）" : null,
    g.cacheWrite ? "缓存写累计 " + kfmt(g.cacheWrite) : null,
    // 成本只在 agent 自己报了的时候写。我们不查价目表去乘 —— 那是编的。
    // ★ 混宿主时只有一部分宿主报成本(codex 就不报),裸写一个数等于少报账 —— 标出来
    u.costUsd != null
      ? "$" + u.costUsd.toFixed(4) + (u.costPartial ? "（仅 " + u.costFrom.join("/") + "）" : "")
      : null,
    // 加不齐的那部分要说清楚,否则看的人只会觉得这表在瞎报
    u.unattributedOut ? "另有 " + kfmt(u.unattributedOut) + " 输出摊不到 agent（thinking）" : null
  ].filter(Boolean);
  L.push("");
  L.push(rule("用量", W, "agent 自己报的"));
  // 放不下就换行,而且**按段换**:每一段自己是完整的一句,拦腰折断反而更难读
  const headRows = [];
  let seg = [], segW = 0;
  parts.forEach(function (t) {
    const add = (seg.length ? 5 : 0) + dispWidth(t);
    if (seg.length && segW + add > W - 7) { headRows.push(seg); seg = []; segW = 0; }
    seg.push(t);
    segW += (seg.length > 1 ? 5 : 0) + dispWidth(t);
  });
  if (seg.length) headRows.push(seg);
  headRows.forEach(function (ps, i) {
    L.push("  " + C.dim(i === 0 ? "合计 " : "     ") + ps.join(C.dim("  ·  ")));
  });

  const wide = W >= 96;
  L.push(C.dim("  " + pad("AGENT", 12) + pad("MODEL", 13) +
    (wide ? padL("本轮 in/out", 14) + "  " : "") + padL("累计 in/out", 14) + "  在干什么"));
  u.agents.forEach(function (a, i) {
    const col = ROLE_COLORS[i % ROLE_COLORS.length];
    const r = roundOf(a.key);
    const rtxt = r ? kfmt(r.in) + "/" + kfmt(r.out) : "—";
    const ttxt = kfmt(a.in) + "/" + kfmt(a.out);
    L.push("  " + col(pad(a.role, 12)) + C.dim(pad(shortModel(a.model), 13)) +
      (wide ? padL(rtxt, 14) + "  " : "") + padL(ttxt, 14) + "  " +
      C.dim(clip(toolsLabel(r ? r.tools : a.tools, wide ? 4 : 3), Math.max(10, W - (wide ? 59 : 43)))));
  });
  return L;
}

/**
 * 直播画面的**行**（不是一整段字符串）。每一行带着「它代表哪一轮」——
 * 点击上报的是行号,没有这张对照表就只知道「点在第 7 行」,不知道那是第几轮。
 *
 * view = { open: 展开哪一轮（null = 都收起）, sel: 键盘停在哪一轮 }
 * 不给 view 就默认展开最后一轮 —— 也就是老样子:进来先看见正在跑的这一轮。
 */
function renderLines(st, width, view) {
  const W = Math.max(60, Math.min(width || 100, 120));
  const LL = [];
  // 老代码全都是 L.push(字符串);这里保持那个写法,顺手包成 {text}
  const L = { push: function (t) { LL.push(typeof t === "string" ? { text: t } : t); } };
  const run = st.run || {};
  const cur = st.rounds.length ? st.rounds[st.rounds.length - 1] : null;
  const b = run.budget || {};
  const usg = require("./usage.js").reduceEvents(st.usageEvents || []);

  /* ── 顶栏:左边「这次在干什么」,右上角「现在什么状态」。
   *    状态右对齐是**故意的**:它是唯一一个每次刷新都可能变的字段,固定在同一个角落,
   *    眼睛就不必每次重新找它。 */
  const ended = st.ended;
  const good = ended && ended.reason === "goal_met";
  const judged = ended && (ended.reason === "judged_met" || ended.reason === "reported_met");
  const statusTxt = ended
    ? (good || judged ? GL.ok : GL.stop) + " " + (STOP_LABEL[ended.reason] || ended.reason)
    : GL.run + " 运行中" + (cur ? " · 第 " + cur.n + (b.rounds ? "/" + b.rounds : "") + " 轮" : "");
  const statusCol = ended ? (good ? C.green : judged ? C.teal : C.yellow) : C.teal;
  const name = "CODE-FORGE";
  // session 十有八九就是目标截前 60 字。两行说同一句话是「乱」的主要来源之一 ——
  // 重复的那半边让给状态,完整的目标由下面那行折行写全。
  const goalTxt = String(run.goal || "").trim();
  const sessTxt = String(run.session || "").trim();
  const dupe = goalTxt && sessTxt && goalTxt.indexOf(sessTxt) === 0;
  const sess = dupe ? "" : clip(sessTxt || (goalTxt ? "" : "（还没开局）"),
    Math.max(10, W - dispWidth(name) - dispWidth(statusTxt) - 6));
  // 宽度按**素文本**算,算完再上色 —— 转义符也在字符串里,先上色再对齐,整行就歪了(踩过)
  const gap = Math.max(2, W - dispWidth(name) - 2 - dispWidth(sess) - dispWidth(statusTxt));
  L.push(C.teal(C.bold(name)) + "  " + C.dim(sess) + " ".repeat(gap) + statusCol(statusTxt));
  L.push(C.dim(GL.head.repeat(W)));

  // 目标:跟 session 是同一句话就不画第二遍(十有八九是同一句)。
  // 这里**折行不截断** —— 目标是判据的来源,截掉一半等于把「为什么这么判」藏起来。
  const goal = goalTxt;
  if (goal) {
    wrapText(goal, W - 6, "      ").forEach(function (l, i) {
      L.push(i === 0 ? kv("目标", l) : l);
    });
  }

  // 判据走势 —— 一眼看出在不在收敛,这是整个回环最该被看见的一行。
  // 一条判据事件都没有时整行不画:画一排「—」会被读成「量过了,没有数」。
  const gateRounds = st.rounds.filter(function (r) {
    return r.events.some((e) => e.role === "gate");
  });
  if (gateRounds.length) {
    const vals = [];
    const trail = gateRounds.map(function (r) {
      const g = r.events.filter((e) => e.role === "gate").pop();
      const v = g.meta && g.meta.value;
      if (typeof v === "number") vals.push(v);
      // 优先读事件自己带的标志。老日志没有 meta.met 时才退回文字匹配 ——
      // 靠文字推状态很脆:评审那条摘要是「评审判定达标」,/^达标/ 匹配不上。
      const met = g.meta && typeof g.meta.met === "boolean"
        ? g.meta.met : /达标/.test(g.summary || "") && !/未达标/.test(g.summary || "");
      const txt = "R" + r.n + " " + (v == null ? (met ? "过" : "未过") : v);
      return met ? C.green(C.bold(txt)) + C.green(" " + GL.ok) : C.dim(txt);
    }).join(C.dim(" " + GL.arrow + " "));
    const sp = spark(vals);
    L.push(kv("判据", (sp ? C.teal(sp) + "  " : "") + trail));
  }

  const budget = [
    b.rounds === 0 ? "不限轮" : b.rounds ? b.rounds + " 轮" : null,
    b.seconds ? b.seconds + "s" : null,
    // token 预算:0/没配 = 不限(首选)。只计量得到的部分,闸门在 hostrun
    b.tokens > 0 ? "token " + kfmt(b.tokens) : "token 不限",
    b.noProgressRounds ? "零进展 " + b.noProgressRounds + " 轮停" : null
  ].filter(Boolean).join(C.dim(" · "));
  if (budget) L.push(kv("预算", C.dim(budget)));
  // 用量不单开一行也不单开区域(用户点名:「用量显示在角色后面就够了」) ——
  // 数字全在下面的角色行上;要深挖逐轮/工具明细,走 `code-forge usage`

  // 展开/选中哪一轮:调用方(直播那层)说了算;没说就是最后一轮 —— 也就是老样子
  const openN = view && "open" in view ? view.open : (cur ? cur.n : null);
  const selN = view && view.sel != null ? view.sel : openN;

  // ── 角色。没发言的画空心圈:「谁还没动」和「谁动了几次」是两件事,得一眼分得开
  const roles = st.roleOrder.map((id) => st.roles[id]);
  if (roles.length) {
    L.push("");
    L.push(rule("角色", W));
    roles.forEach(function (r, i) {
      const col = r.id === "gate" ? C.grey : ROLE_COLORS[i % ROLE_COLORS.length];
      // 量到了真模型就显示真的。`role.add` 里那个是 agent 自己声明的,宿主执行时它多半写
      // 「宿主模型」—— 同一屏上一处写「宿主模型」、一处写「sonnet-5」会让人以为是两个东西。
      /* ★ 同一个角色可能同时派出去好几份(三个反驳者各攻一片、或跨轮换了模型) ——
       *   账要**全部加起来**。原来取 [0] 只显示第一份,三个反驳者的账少报两份。 */
      const mine = (usg.agents || []).filter(function (a) { return a.role === r.name; });
      const measured = mine.length
        ? mine.reduce(function (acc, a) {
          acc.in += a.in; acc.out += a.out;
          acc.cache += (a.cacheRead || 0) + (a.cacheWrite || 0);
          if (a.ctx != null) acc.ctx = (acc.ctx || 0) + a.ctx;   // 各 agent 末次上下文之和
          return acc;
        }, { in: 0, out: 0, cache: 0, ctx: null })
        : null;
      // 模型也可能不止一个(中途换过 / 同角色派了不同模型):都列出来,不挑一个当代表
      const models = [];
      mine.forEach(function (a) {
        const m = a.model ? shortModel(a.model) : null;
        if (m && models.indexOf(m) < 0) models.push(m);
      });
      // 没量到账的角色用 role.add 里的模型,也过一遍 shortModel —— 同一列里
      // 一行「sonnet-5」一行「claude-sonnet-5」会被当成两个东西
      const model = models.length ? models.join("/") : shortModel(r.model);
      // 账的优先级:独立进程/档案自报(最准) > loop_say 带的 tok > 留空
      // (量不到就空着 —— 用户点名:「没发言的不需要显示 token 不可得,显示空就可以了」)
      /* ★ 首位那个数用 **Claude Code 同口径**:该角色各 agent **末次上下文**之和。
       *   两个方向都实测踩过:只显示 in+out(8k)被对照协调者屏上的 300k+ 当成漏账;
       *   改成历次缓存读累计(13.98M)又被当成账炸了(「预计只有 1000k 上下」)——
       *   Claude Code 给每个 agent 显示的是它当前的上下文规模,这里必须同一把尺。
       *   出 token 单列在后:占了多大上下文看前者,干出多少活看它。 */
      const said = (r.tokIn || 0) + (r.tokOut || 0);
      const io = measured
        ? (measured.ctx != null
          ? C.dim("上下文") + padL(kfmt(measured.ctx), 7) + " " + padL(kfmt(measured.out), 6) + "↓"
          // 老事件/别的宿主没报 ctx 时退回含缓存累计 —— 有什么报什么,不硬凑
          : C.dim("含缓存") + padL(kfmt(measured.in + measured.out + measured.cache), 7) +
            " " + padL(kfmt(measured.out), 6) + "↓")
        : said > 0
          ? padL(kfmt(r.tokIn || 0), 7) + "↑ " + padL(kfmt(r.tokOut || 0), 6) + "↓"
          : "";
      // 判据不是辩论的一方(它不发表意见,只跑命令),记号也不该跟角色一样。
      // 正在干活的角色记号换成 spinner 帧(view.activeRole 由直播层判定:最近有它的活动) ——
      // 「谁在动」要在角色表上看得见,不只是底部那一行字
      const isActive = view && view.activeRole === r.id && !st.ended;
      const mark = isActive ? ((view && view.spinFrame) || GL.dot)
        : r.id === "gate" ? "▪" : r.calls ? GL.dot : GL.ring;
      // 窄屏先砍列,不许让行溢出去 —— 溢出的行会被终端硬折成两行,整屏就散了
      const showIo = W >= 84;
      const mw = Math.max(8, Math.min(20, W - 22 - (showIo ? 24 : 0)));
      L.push({
        text: "  " + col(mark) + " " + pad(r.name, 11) +
          C.dim(pad(model, mw)) + C.dim(padL(r.calls ? r.calls + " 次" : "未发言", 7)) +
          (showIo && io ? "   " + C.dim(io) : ""),
        // 快帧要单独刷这一格 —— 标出来让 watch 记它的屏幕行号
        pulseRole: isActive ? r.id : undefined
      });
    });
  }

  /* ── 轮次。**每一轮一行,点哪一行就在它底下摊开那一轮做了什么。**
   *
   * 以前这里只画「本轮」的最后 8 条 —— 前面几轮做了什么、反驳者当时抓到的是什么,
   * 全看不见,只能去翻网页或 run.jsonl。而回环的价值恰恰在**几轮之间的变化**。
   * 默认仍然展开最后一轮,所以进来第一眼跟以前一样。 */
  if (st.rounds.length) {
    L.push("");
    L.push(rule("轮次", W, st.rounds.length + " 轮" +
      (st.rounds.length > 1 ? "　点一行看那一轮" : "")));
    st.rounds.forEach(function (r) {
      const isOpen = r.n === openN;
      const isSel = r.n === selN;
      const g = r.events.filter(function (e) { return e.role === "gate"; }).pop();
      const met = g && (g.meta && typeof g.meta.met === "boolean"
        ? g.meta.met : /达标/.test(g.summary || "") && !/未达标/.test(g.summary || ""));
      const val = g
        ? (g.meta && g.meta.value != null ? String(g.meta.value) : (met ? "过" : "未过"))
        : "";
      const span = r.events.length
        ? (r.events[0].ts || "") + (r.events.length > 1 ? "→" + (r.events[r.events.length - 1].ts || "") : "")
        : "";
      L.push({
        round: r.n,
        text: (isSel ? C.teal("❯") : " ") + " " +
          C.dim(isOpen ? "▾" : "▸") + " " +
          (isOpen ? C.bold("R" + r.n) : "R" + r.n) + "  " +
          C.dim(pad(clip(span, 19), 20)) +
          C.dim(pad(r.events.length + " 事件", 9)) +
          (val ? (met ? C.green(pad(val + " " + GL.ok, 8)) : C.dim(pad(val, 8))) : " ".repeat(8)) +
          (r.live ? C.teal("进行中") : C.dim(clip(r.verdict && r.verdict.score ? r.verdict.score : "", W - 50)))
      });
      if (!isOpen) return;

      // 展开:这一轮**全部**事件,顺序不倒序（对抗是有先后的）
      const show = r.events.slice(-(view && view.max ? view.max : 12));
      if (r.events.length > show.length) {
        L.push({ inRound: r.n, text: C.dim("     … 前 " + (r.events.length - show.length) + " 条略") });
      }
      show.forEach(function (e, si) {
        const ro = st.roles[e.role] || { name: e.role };
        const idx = st.roleOrder.indexOf(e.role);
        const col = e.role === "gate" ? C.grey : ROLE_COLORS[(idx < 0 ? 0 : idx) % ROLE_COLORS.length];
        const kind = KIND_LABEL[e.kind] || "";
        // 每条聊天记录像 Claude Code 那样**点开看细节**(body 全文/工具调用/diff)。
        // evKey 是它的身份(轮:序号),点击对照表靠它区分「点了哪一条」
        const evKey = r.n + ":" + (r.events.length - show.length + si);
        const evOpen = !!(view && view.openEv && view.openEv.has && view.openEv.has(evKey));
        const caret = C.dim(evOpen ? "▾" : "▸");
        const head = "   " + caret + " " + C.dim(pad(e.ts || "", 9)) + C.dim(GL.gutter) + " " +
          col(pad(ro.name, 10)) + C.dim(pad(kind, 8));
        const emet = e.role === "gate" && (e.meta && typeof e.meta.met === "boolean"
          ? e.meta.met : /达标/.test(e.summary || "") && !/未达标/.test(e.summary || ""));
        const txt = clip(e.summary, W - 37);
        L.push({ inRound: r.n, evKey: evKey, text: head + (emet ? C.green(txt) : txt) });
        if (!evOpen) return;
        // 细节:能给多少给多少,一样都没带就直说 —— 别让人以为展开坏了
        const det = [];
        if (e.body && String(e.body).trim() && e.body !== e.summary) {
          wrapText(String(e.body), W - 14, "").slice(0, 8).forEach(function (l) { det.push(l); });
        }
        if (e.tool && e.tool.name) {
          det.push("→ " + e.tool.name + (e.tool.status === "error" ? "（失败)" : "") +
            (e.tool.args ? "  " + clip(JSON.stringify(e.tool.args), W - 24 - dispWidth(e.tool.name)) : ""));
          if (e.tool.result) {
            String(e.tool.result).split("\n").slice(-2).forEach(function (l) {
              det.push("  " + clip(l, W - 16));
            });
          }
        }
        if (e.diff && e.diff.file) {
          det.push("± " + e.diff.file +
            (e.diff.add != null ? " +" + e.diff.add : "") +
            (e.diff.del != null ? " -" + e.diff.del : ""));
          String(e.diff.lines || "").split("\n").filter(Boolean).slice(0, 6).forEach(function (l) {
            det.push("  " + clip(l, W - 16));
          });
        }
        if (e.output) {
          String(e.output).split("\n").slice(-4).forEach(function (l) { det.push(clip(l, W - 14)); });
        }
        if (!det.length) det.push("（这条只带了 summary —— body/tool/diff 都没报）");
        det.forEach(function (l) {
          // 细节行**惰性**:只有条目行(角色名那行)能开合 —— Claude Code 同款(用户点名)。
          // 内容行点了不该有任何反应,不然想选中复制一段命令都会把块合上
          L.push({ inRound: r.n, text: "         " + C.dim(l) });
        });
      });
      // 那一轮各人烧了多少 —— 「谁在烧钱」和「它在干什么」本来就是同一张表
      const ru = (usg.rounds || []).filter(function (x) { return x.n === r.n; })[0];
      if (ru && ru.agents.length) {
        L.push({ inRound: r.n, text: C.dim("     用量 " + ru.agents.map(function (a) {
          return a.role + " " + kfmt(a.in) + "↑" + kfmt(a.out) + "↓";
        }).join(" · ")) });
      }
      if (r.conflicts) {
        L.push({ inRound: r.n, text: C.yellow("     这一轮有 " + r.conflicts + " 处分歧") });
      }
      // ★ 进行中的轮在聊天记录末尾挂一条**实时活动行**(带脉搏) ——
      //   展开的轮里要能看到「此刻哪个角色在干什么」,不用低头去找底栏
      if (r.live && !st.ended && st.streaming && st.streaming.text) {
        const frame = (view && view.spinFrame) || GL.run;
        // 左侧必须有角色名 —— 「谁在动」不能让人从活动文本里猜。
        // streaming 自带角色(dispatch 的活动)就用它;心跳类(role=gate)用当前活跃角色顶上
        const rid = st.streaming.role && st.streaming.role !== "gate" && st.roles[st.streaming.role]
          ? st.streaming.role
          : (view && view.activeRole && st.roles[view.activeRole]) ? view.activeRole : null;
        let ltxt = String(st.streaming.text);
        let lhead = "";
        if (rid) {
          const nm = st.roles[rid].name;
          const ridx = st.roleOrder.indexOf(rid);
          const rcol = ROLE_COLORS[(ridx < 0 ? 0 : ridx) % ROLE_COLORS.length];
          if (ltxt.indexOf(nm + " · ") === 0) ltxt = ltxt.slice(nm.length + 3);   // 别重复一遍名字
          lhead = rcol(C.bold(nm)) + C.dim(" │ ");
        }
        // inRound 而不是 round:活动行是聊天内容,点它不该折叠这一轮
        L.push({ inRound: r.n, pulseCol: 6,
          text: "     " + C.teal(C.bold(frame)) + " " + lhead +
            C.dim(clip(ltxt, W - 20)) });
      }
    });
  }

  // 用量区域从直播画面里撤了(用户点名:「不需要用量区域,用量显示在角色后面就够了」)。
  // renderUsage 保留给 `code-forge usage` 一类深挖场景与测试 —— 口径逻辑还在那里钉着。

  // ── 收尾:整条横杠上色。这一屏只有这一处允许「大面积颜色」——
  //    它是唯一一个「看完就可以走了」的信号,值得被一眼撞见。
  if (ended) {
    const col = good ? C.green : judged ? C.teal : C.yellow;
    L.push("");
    L.push(col(GL.head.repeat(W)));
    L.push(col(C.bold((good || judged ? GL.ok : GL.stop) + " " +
      (STOP_LABEL[ended.reason] || ended.reason))) +
      (ended.detail ? "  " + C.dim(clip(ended.detail, W - 30)) : ""));
    if (ended.rounds) {
      L.push(C.dim("  跑了 " + ended.rounds + " 轮" +
        (ended.seconds ? "，" + ended.seconds + " 秒" : "")));
    }
  } else if (st.streaming) {
    L.push("");
    L.push(C.teal(GL.run + " ") + C.dim(clip(st.streaming.text || "进行中…", W - 6)));
  }
  if (st.unknown) L.push(C.yellow("  ⚠ " + st.unknown + " 条认不出的事件（已忽略但计数）"));
  return LL;
}

/**
 * 画面比终端高时怎么裁。**必须我们自己裁,不能让终端去滚。**
 *
 * 点击上报的是屏幕行号,而「第 i 行 = lines[i]」是反查「点中了哪一轮」的唯一依据 ——
 * 一旦滚动过,这个等式就不成立了,点第 3 行会点中第 8 轮。
 * 从**中间**挖:顶上是目标/判据(每次都要看),底下是刚发生的事(正在看的)。
 */
function fitHeight(lines, room) {
  if (room < 3 || lines.length <= room) return lines;
  const keepHead = Math.max(3, Math.floor(room * 0.45));
  const keepTail = room - keepHead - 1;
  const cut = lines.length - keepHead - keepTail;
  return lines.slice(0, keepHead)
    .concat([{ text: C.dim("  … 中间 " + cut + " 行放不下（终端高一点，或按 o 看网页）") }])
    .concat(lines.slice(lines.length - keepTail));
}

/** 老接口:要一整段字符串的地方（非 TTY、单测）继续用它。 */
function render(st, width, view) {
  return renderLines(st, width, view).map(function (l) { return l.text; }).join("\n");
}
/**
 * `code-forge usage` 的整页报告：合计 + 逐 agent + 逐轮明细。
 * 纯函数(进 /usage 的返回值,出一段字符串),所以可以单测。
 */
function usageReport(u, W) {
  W = Math.max(60, Math.min(W || 100, 120));
  const L = [];
  L.push(C.teal(C.bold("CODE-FORGE 用量")) + (u.session ? "  " + C.dim(clip(u.session, W - 20)) : ""));
  L.push(C.dim(GL.head.repeat(W)));

  // 说明文字一律走这条:**折行,不溢出**。溢出的行被终端硬折之后缩进就全乱了,
  // 一段本来读得通的解释会看起来像三段没头没尾的碎话。
  const note = function (text, indent) {
    const ind = indent || "      ";
    wrapText(text, W - dispWidth(ind), ind).forEach(function (l, i) {
      L.push(C.dim((i === 0 ? ind : "") + l));
    });
  };

  if (!u || !u.measured) {
    L.push("");
    L.push(C.yellow("这次回环一条用量都没有。可能是:"));
    note("· 角色还没真的干过活 —— 账是角色干完活才有的,开局那几分钟本来就空。", "  ");
    note("· 宿主不是 Claude Code —— 逐角色的账现在读的是 Claude Code 自己存的子 agent 档案", "  ");
    note("(~/.claude/projects/…/subagents/),别的宿主没有这份档,只有 loop_agent 派出去的", "    ");
    note("独立进程会自己报账。", "    ");
    note("· 起监控台的目录跟你干活的目录不是同一个 —— 档案是按目录分的,找不到就是空。", "  ");
    return L.join("\n");
  }

  // 合计 = 下面那几行的和。**不拿 result 里的数冒充总数** —— 实测它和逐条求和对不上,
  // 而且它只覆盖某一次调用(usage.js 顶部有三个数的实测对照)。
  const g = u.grand;
  // 每一段都是完整的一句,放不下就整段换行(拦腰折断的数字比换行更难读)
  const segs = [
    { t: kfmt(g.in) + "↑ / " + kfmt(g.out) + "↓", c: C.bold },
    { t: "缓存 读 " + kfmt(g.cacheRead) + " / 写 " + kfmt(g.cacheWrite), c: C.dim },
    { t: g.msgs + " 次调用", c: C.dim },
    u.costUsd != null
      ? { t: "$" + u.costUsd.toFixed(4), c: function (x) { return C.green(C.bold(x)); } }
      : { t: "成本未上报", c: C.dim }
  ];
  let row = [], roww = 0, firstRow = true;
  const flush = function () {
    if (!row.length) return;
    L.push(C.dim(firstRow ? "合计  " : "      ") +
      row.map(function (x) { return x.c(x.t); }).join("   "));
    row = []; roww = 0; firstRow = false;
  };
  segs.forEach(function (x) {
    const add = (row.length ? 3 : 0) + dispWidth(x.t);
    if (row.length && roww + add > W - 6) flush();
    row.push(x); roww += add;
  });
  flush();
  // 混宿主时这个数只覆盖报账的那几家 —— 说清楚,别让人当成整次运行的花费
  if (u.costPartial) {
    const warn = "⚠ 这个成本只有 " + u.costFrom.join("/") + " 报的；" +
      u.costMissing.join("/") + " 不报成本 —— 整次运行的实际花费更高。";
    wrapText(warn, W - 6, "      ").forEach(function (l, i) {
      L.push(C.yellow((i === 0 ? "      " : "") + l));
    });
  }
  // ★ 协调者本人的账**摊不出来**(它的 token 混在用户那条会话的整个对话里,还夹着跟这次
  //   回环无关的聊天)。不说清楚,这个合计会被当成「这次回环花的全部」——那是少报。
  note("↑ 只含**角色**(子 agent / 独立进程)的账。聊天里那个协调者本人的 token 混在你自己" +
    "那条会话里,摊不到这次回环头上 —— 所以实际花费比这个数高。");
  note("↑ 这是下面各行之和。成本是 CLI 收尾自报的 total_cost_usd" +
    // 混宿主且只有一部分报账时不能再说「这次运行真花的钱」—— 上面刚警告过它不全,
    // 紧接着又这么写就是自相矛盾
    (u.costPartial ? "（只覆盖上面那几家）" : "（这次运行真花的钱）") + "。");
  // 加不齐的那部分:逐条 usage 的 output_tokens 不含 thinking(实测),而 thinking
  // 不带 parent、摊不到任何 agent 头上。说清楚,别让人以为表算错了。
  if (u.unattributedOut) {
    note("CLI 收尾还自报了 " + kfmt(u.reported.out) + " 输出（其中 thinking " +
      kfmt(u.reported.thinking) + "）—— thinking 不带归属信息，摊不到具体 agent，" +
      "所以下面每行的 out 是下界。");
  }

  L.push("");
  L.push(rule("逐 agent", W));
  // 窄屏先砍「缓存读/轮次」这两列 —— 它们是参考量,砍了不影响判断谁在烧钱
  const full = W >= 92;
  const toolW = Math.max(8, W - (full ? 66 : 47));
  L.push(C.dim("  " + pad("AGENT", 13) + pad("MODEL", 14) + padL("in", 8) + padL("out", 8) +
    (full ? padL("缓存读", 10) + "   " + pad("轮次", 8) : "  ") + "工具"));
  u.agents.forEach(function (a, i) {
    const col = ROLE_COLORS[i % ROLE_COLORS.length];
    L.push("  " + col(pad(a.role, 13)) + C.dim(pad(shortModel(a.model), 14)) +
      padL(kfmt(a.in), 8) + padL(kfmt(a.out), 8) +
      (full ? C.dim(padL(kfmt(a.cacheRead), 10)) + "   " +
        C.dim(pad("R" + (a.rounds || []).join(",R"), 8)) : "  ") +
      C.dim(clip(toolsLabel(a.tools, full ? 5 : 3), toolW)));
  });

  (u.rounds || []).forEach(function (r) {
    L.push("");
    L.push(rule("第 " + r.n + " 轮", W));
    r.agents.forEach(function (a) {
      L.push("  " + pad(a.role, 13) + padL(kfmt(a.in), 8) + "↑" + padL(kfmt(a.out), 8) + "↓   " +
        C.dim(clip(toolsLabel(a.tools, 6), Math.max(8, W - 36))));
    });
  });
  return L.join("\n");
}

/* ---------------- 点选（能点就点；点不动照样打号码） ---------------- */

// 1000=按下/松开　1003=移动也上报(为了悬停高亮)　1006=SGR 编码(列号超过 223 也不会坏)
const MOUSE_ON = "\x1b[?1000h\x1b[?1003h\x1b[?1006h";
const MOUSE_OFF = "\x1b[?1006l\x1b[?1003l\x1b[?1000l";
let mouseArmed = false;

/**
 * 关掉鼠标上报 —— **进程无论怎么退都必须走到这里**。
 * 忘了关的后果不是「少个功能」,是用户的终端从此拖不动、选不中字(终端还在把拖动当事件上报),
 * 得自己敲 reset 才能救。所以挂在 exit 上,不指望正常路径每次都走对。
 */
function mouseOff() {
  if (!mouseArmed) return;
  mouseArmed = false;
  try { process.stdout.write(MOUSE_OFF + "\x1b[?25h"); } catch (_) {}
}
process.on("exit", mouseOff);

/** 两端都得是真终端才谈得上点。CODE_FORGE_NO_MOUSE=1 强制退回打号码(终端不认时的退路)。 */
function canPoint() {
  return !!(process.stdout.isTTY && process.stdin.isTTY && process.stdin.setRawMode &&
    !process.env.CODE_FORGE_NO_MOUSE);
}

/**
 * `code-forge mousetest` —— 五秒钟判断「这个终端到底把鼠标事件送不送得进来」。
 * 有这条,是因为送不送得进来取决于终端 + Node 的组合,猜不得:点了没反应时,
 * 它能当场分清是「终端不上报」还是「我们没接住」。
 */
function mouseTest() {
  if (!canPoint()) {
    console.log(C.yellow("这不是终端（或设了 CODE_FORGE_NO_MOUSE），点选本来就用不了。"));
    return Promise.resolve();
  }
  console.log(C.bold("鼠标自检") + C.dim("　在这个窗口里点几下、动一动。q 退出。"));
  console.log(C.dim("看到 [鼠标] 行 = 能点；一直只有 [按键] = 这个终端不上报，tui 会自动退回打号码。"));
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  mouseArmed = true;
  process.stdout.write(MOUSE_ON);
  return new Promise(function (resolve) {
    stdin.on("data", function (b) {
      const s = b.toString("utf8");
      if (s === "q" || s.indexOf("\x03") >= 0) {
        mouseOff();
        stdin.setRawMode(false);
        stdin.pause();
        console.log("");
        resolve();
        return;
      }
      let m, hit = false;
      const re = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
      while ((m = re.exec(s))) {
        hit = true;
        console.log(C.green("[鼠标] ") + "按钮 " + m[1] + "　列 " + m[2] + "　行 " + m[3] +
          "　" + (m[4] === "M" ? "按下/移动" : "松开"));
      }
      if (!hit) console.log(C.dim("[按键] ") + JSON.stringify(s));
    });
  });
}


/** 弹浏览器看监控台。跟直播里按 o 是同一件事 —— --web 只是把那一下提前到启动时。 */
function openWeb(base) {
  const cmd = process.platform === "win32" ? ["cmd", ["/c", "start", "", base]]
    : process.platform === "darwin" ? ["open", [base]] : ["xdg-open", [base]];
  try { spawn(cmd[0], cmd[1], { detached: true, stdio: "ignore" }).unref(); } catch (_) {}
}

/* ---------------- 直播 ---------------- */
function watch(base, opts) {
  opts = opts || {};
  const st = newState();
  let dirty = false;
  let lastPaint = 0;
  /* 看哪一轮。open=展开哪一轮,sel=键盘停在哪一轮,follow=跟着最新那一轮跑。
   *
   * follow 这一条是重点:**你一旦自己点开某一轮,就不该再被新事件拽走**。
   * 直播画面最气人的行为就是「刚要看清就跳走了」—— 所以点过之后 follow 关掉,
   * 按 f（或点最新那一轮）再打开。 */
  const view = { open: null, sel: null, follow: true, max: 400, openEv: new Set() };
  let hit = [];        // 屏幕第几行 → 第几轮（点击上报的是行号,没这张表就不知道点中了谁）
  let hitEv = [];   // 屏幕行 → 聊天记录身份(点开看细节用)
  /* ★ 屏幕行 ↔ 内容行的偏移。理论上 lines[i] 就在屏幕第 i+1 行,但实测**差了一行**:
   *  用户点第一句聊天却折叠了整轮(轮标题正是它上面那行)。成因随终端/scrollback 而变,
   *  与其猜,不如**问终端**:第一帧发一次 DSR(ESC[6n),拿光标真实行号与预期比对,
   *  差值就是偏移。之后所有点击都减掉它 —— 自校准比任何假设都可靠。
   *
   *  ★ 但探针只能量到**内容那一段**为止(见 paint)。底部键位栏比任何内容行都长,
   *  终端一折行,量出来的偏移就多算一行 —— 而 footer 在内容下面,压根不影响点击对位。
   *  这正是「点第 N 行,展开的却是上一行」的成因:偏移被 footer 的折行污染了。 */
  let rowOffset = 0, calibrated = false, expectRow = 0;
  let altOn = false;   // 是否已切到备用屏幕(退出要还原)
  /* 脉搏:像 Claude Code 那样一直在动的标志。它**不靠事件驱动**(每秒自转一格) ——
   * 于是「页面在动但没新事件」和「真卡死了」一眼可分。实测被当成卡死问过两次。 */
  const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let spinI = 0;
  let pulseRow = 0;   // 脉搏画在屏幕第几行(paint 时记下,快帧用光标定位单独刷它)
  let lastEventAt = Date.now();
  // 正在干活的角色:最近一条带角色的活动/发言(gate 除外)。3 分钟没动静就摘掉标记
  let activeRole = null, activeAt = 0, pulseCells = [];
  let scroll = 0, stickBottom = true, maxScroll = 0;   // 滚动视口(内容撑开,不裁中间)
  const agoTxt = function () {
    const s = Math.round((Date.now() - lastEventAt) / 1000);
    return s < 3 ? "刚刚" : s < 90 ? s + "s 前" : Math.round(s / 60) + "m 前";
  };

  const roundNums = function () { return st.rounds.map(function (r) { return r.n; }); };

  function paint() {
    if (!TTY) return;
    const w = Math.max(60, Math.min(process.stdout.columns || 100, 120));
    const rows = Math.max(12, (process.stdout.rows || 40));
    if (view.follow && st.rounds.length) {
      view.open = st.rounds[st.rounds.length - 1].n;
      view.sel = view.open;
    }
    view.activeRole = activeRole && Date.now() - activeAt < 180000 ? activeRole : null;
    view.spinFrame = SPIN[spinI % SPIN.length];
    /* ★ 显示不下**不裁中间,加滚动**(Claude Code 同款,用户点名)。
     *   全量渲染 → 视口切片;滚轮/PgUp/PgDn 翻,跟底模式贴着最新;
     *   对照表按**视口内**行号建 —— 点击上报的是屏幕行,切片之后行号才对得上。 */
    const all = renderLines(st, process.stdout.columns, view);
    const vp = rows - 4;
    maxScroll = Math.max(0, all.length - vp);
    if (stickBottom) scroll = maxScroll;
    scroll = Math.min(Math.max(0, scroll), maxScroll);
    const lines = all.slice(scroll, scroll + vp);
    pulseCells = [];
    lines.forEach(function (l, i) {
      if (l.pulseRole) pulseCells.push({ row: i + 1, col: 3 });
      if (l.pulseCol) pulseCells.push({ row: i + 1, col: l.pulseCol });
    });
    hit = lines.map(function (l) { return l.round == null ? null : l.round; });
    hitEv = lines.map(function (l) { return l.evKey || null; });

    const keys = [["↑↓", "选轮次"], ["⏎", "展开/收起"], ["esc", "收起全部"],
      ["f", "跟最新"], ["s", "停止"], ["o", "网页"], ["q", "退出"]]
      .map(function (k) { return C.dim("[") + C.bold(k[0]) + C.dim("] " + k[1]); })
      .join("  ");
    const scrollTag = maxScroll > 0
      ? C.dim("  ⇅ " + (scroll + 1) + "-" + (scroll + lines.length) + "/" + all.length +
          (stickBottom ? "（跟底）" : "（滚轮/PgUp 翻,f 跟回）"))
      : "";
    // 静默久了脉搏转黄 —— 「多半在干活」和「该去看看了」要分得开
    const quietSec = Math.round((Date.now() - lastEventAt) / 1000);
    const pulse = st.ended
      ? C.dim("■ 档案")
      : (quietSec > 300 ? C.yellow : C.teal)(C.bold(SPIN[spinI % SPIN.length])) +
        C.dim(" 最后事件 " + agoTxt());
    // 快帧只重写 spinner 那一格,要知道它画在屏幕第几行(内容行数 + 空行 + 分隔线 + 1)
    pulseRow = lines.length + 3;
    /* ★ 分两次写:内容 → 探针 → footer。
     *   内容写完,光标正停在最后一条内容行(第 lines.length 行),此刻问出来的偏移才是
     *   「内容行 ↔ 屏幕行」的偏移。整帧写完再问,量到的里面就掺了 footer 的折行 ——
     *   键位栏比任何内容行都长,一折就多算一行,点击整体上移一格(点第 N 行开的是上一行)。 */
    /* ★ 不清屏。ESC[2J 是「先把整屏擦白,再画回来」—— 一秒一帧,肉眼看见的就是闪,
     *   底部那几行最明显(内容与 footer 分两次写,中间那一瞬 footer 正好是空的)。
     *   改成 less/vim 的老办法:回到左上角**逐行覆盖**,每行末尾 ESC[K 擦掉这一行的尾巴,
     *   收尾 ESC[J 擦掉上一帧多出来的行。旧像素一直留到被新内容盖住,整屏就不闪了。 */
    const EL = "\x1b[K";
    process.stdout.write("\x1b[H" + lines.map(function (l) { return l.text + EL; }).join("\n"));
    expectRow = lines.length;
    if (!calibrated) process.stdout.write(String.fromCharCode(27) + "[6n");   // 只问一次,答案在 data 里接
    process.stdout.write("\n" + EL + "\n" +
      C.dim(GL.rule.repeat(w)) + EL + "\n  " + pulse + "   " + keys + scrollTag +
      C.dim(view.follow ? "" : "   （已停在 R" + view.open + "，按 f 跟回最新）") +
      // 回环已结束时说明这是档案 —— 不然刚打开的人会以为「code-forge 跑了个回环」
      (st.ended ? C.dim("   这是已结束的档案 —— 新开跑: /code-forge（聊天里）") : "") +
      EL + "\n" + "\x1b[J");
    lastPaint = Date.now();
    dirty = false;
  }
  const timer = setInterval(function () {
    if (dirty && Date.now() - lastPaint > 150) paint();
  }, 120);
  // 脉搏两档:快帧(120ms)只用光标定位重写 spinner 那一格 —— 全屏刷这么快会闪;
  // 慢帧(1s)整屏重画,更新「最后事件 N 前」。事件再稀,画面每秒都在动 —— 不动才是真出事
  const pulseTimer = setInterval(function () {
    if (!TTY || !pulseRow || st.ended) return;
    spinI++;
    const quiet = Math.round((Date.now() - lastEventAt) / 1000);
    const frame = (quiet > 300 ? C.yellow : C.teal)(C.bold(SPIN[spinI % SPIN.length]));
    // 7/8 保存/恢复光标 —— 别把用户停着的光标拽走
    let cells = "[" + pulseRow + ";3H" + frame;
    pulseCells.forEach(function (c) { cells += "[" + c.row + ";" + c.col + "H" + frame; });
    process.stdout.write("7" + cells + "8");
  }, 120);
  pulseTimer.unref && pulseTimer.unref();
  const slowTimer = setInterval(function () {
    if (!TTY) return;
    paint();
  }, 1000);
  slowTimer.unref && slowTimer.unref();

  const u = new URL(base + "/events");
  const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: "GET",
    headers: { accept: "text/event-stream" } }, function (res) {
    let buf = "";
    res.on("data", function (d) {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        let ev;
        try { ev = JSON.parse(line.slice(5).trim()); } catch (_) { continue; }
        reduce(st, ev);
        lastEventAt = Date.now();
        if ((ev.t === "run.streaming" || ev.t === "event") && ev.role && ev.role !== "gate") {
          activeRole = ev.role; activeAt = Date.now();
        }
        if (ev.t === "run.end") activeRole = null;
        dirty = true;
        // 非 TTY:一行一条顺序输出,别画画面
        if (!TTY) {
          // 用角色名而不是 id：日志是给人读的,「[role1]」等于让人自己去查表
          const nm = (st.roles[ev.role] && st.roles[ev.role].name) || ev.role || "";
          if (ev.t === "event") console.log("[" + nm + "] " + (ev.summary || ""));
          else if (ev.t === "round.start") console.log("-- 第 " + ev.n + " 轮 --");
          else if (ev.t === "run.end") console.log("== " + (STOP_LABEL[ev.reason] || ev.reason) + " " + (ev.detail || ""));
        }
      }
    });
    res.on("end", function () { clearInterval(timer); if (TTY) paint(); });
  });
  r.on("error", function (e) { clearInterval(timer); console.error("事件流断开：" + e.message); });
  r.end();

  if (TTY && process.stdin.isTTY && process.stdin.setRawMode) {
    /* ★ 切到**备用屏幕**:vim/less/Claude Code 都这么做。两个好处:
     *  ① 视口没有 scrollback,坐标系干净 —— 鼠标行号与画面行号不再错位;
     *  ② 退出时把用户原来的终端内容原样还回去,不留一屏残骸。 */
    altOn = true;
    /* ③ 顺手关掉自动折行(DECAWM)。太长的行由终端在右边截掉,而不是折成两行 ——
     *    折出来的那一行会把它**下面所有行**的屏幕行号顶下去一格,点击就全错位。
     *    宁可少看见半句话,也不能让「第 i 条内容 = 第 i+1 个屏幕行」这条等式塌掉。 */
    process.stdout.write(String.fromCharCode(27) + "[?1049h" + String.fromCharCode(27) + "[?7l" +
      String.fromCharCode(27) + "[?25l");   // 藏光标:满屏重画时那个乱跳的方块也是「闪」
    paint();
    if (process.stdin.setRawMode) process.stdin.setRawMode(true);
    process.stdin.resume();
    if (canPoint()) { mouseArmed = true; process.stdout.write(MOUSE_ON); }
    process.on("exit", function () {
      if (altOn) { try { process.stdout.write(String.fromCharCode(27) + "[?25h" + String.fromCharCode(27) + "[?7h" + String.fromCharCode(27) + "[?1049l"); } catch (_) {} }
    });

    const quit = function () {
      // 还原用户原来的终端内容 —— 不留一屏残骸(Claude Code 退出后也是干净的)
      if (altOn) { process.stdout.write(String.fromCharCode(27) + "[?25h" + String.fromCharCode(27) + "[?7h" + String.fromCharCode(27) + "[?1049l"); altOn = false; }
      mouseOff();
      if (process.stdin.setRawMode) process.stdin.setRawMode(false);
      clearInterval(timer);
      console.log("\n" + C.dim("已退出。回环仍在后台跑,`code-forge watch` 可以再接回来。"));
      process.exit(0);
    };
    const move = function (d) {
      const ns = roundNums();
      if (!ns.length) return;
      const at = ns.indexOf(view.sel == null ? ns[ns.length - 1] : view.sel);
      view.sel = ns[Math.max(0, Math.min(ns.length - 1, (at < 0 ? ns.length - 1 : at) + d))];
      view.follow = false;
      paint();
    };
    /**
     * ★ 展开/收起之后,把被点的那一行**钉回原来的屏幕位置**。
     *
     * 不钉的下场(实测):跟底模式下展开会把视图滚到底,被点的条目行往上跑,
     * 用户在同一个物理位置点第二下,点到的已经是细节行(惰性) —— 体感就是
     * 「只能展开不能关闭」。Claude Code 展开时那一行是不动的,这里对齐它。
     */
    const anchorTo = function (key, screenRow) {
      stickBottom = false;                 // 用户在查看,别再被新事件拽到底
      view.activeRole = activeRole && Date.now() - activeAt < 180000 ? activeRole : null;
      view.spinFrame = SPIN[spinI % SPIN.length];
      const all2 = renderLines(st, process.stdout.columns, view);
      const idx = all2.findIndex(function (l) {
        return typeof key === "string" ? l.evKey === key : l.round === key;
      });
      if (idx >= 0) scroll = Math.max(0, idx - (screenRow - 1));
    };


    const toggle = function (n) {
      if (n == null) return;
      view.sel = n;
      view.open = view.open === n ? null : n;
      // 点开的是最新那一轮 → 继续跟着跑;点的是老的一轮 → 停在那儿别被拽走
      const last = st.rounds.length ? st.rounds[st.rounds.length - 1].n : null;
      view.follow = view.open === last;
      paint();
    };

    process.stdin.on("data", function (buf) {
      const d = buf.toString("utf8");
      // DSR 响应(ESC[行;列R):校准用,不是按键 —— 必须在按键分支之前吃掉
      const dsr = new RegExp(String.fromCharCode(27) + "\\[(\\d+);(\\d+)R").exec(d);
      if (dsr) {
        if (!calibrated) {
          rowOffset = Number(dsr[1]) - expectRow;
          calibrated = true;
        }
        if (d.replace(new RegExp(String.fromCharCode(27) + "\\[\\d+;\\d+R", "g"), "").trim() === "") return;
      }
      if (d.indexOf("\x03") >= 0) return quit();

      // 鼠标:SGR。点在哪一行 → hit 表里查那一行是第几轮
      let m, sawMouse = false;
      const re = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
      while ((m = re.exec(d))) {
        sawMouse = true;
        const btn = Number(m[1]), row = Number(m[3]), press = m[4] === "M";
        if (btn === 64 || btn === 65) {                 // 滚轮:翻内容(不裁中间,靠它看长回环)
          scroll += btn === 65 ? 3 : -3;
          stickBottom = scroll >= maxScroll;
          paint();
          continue;
        }
        if (btn & 32) continue;                         // 移动不管
        if (!press || (btn & 3) !== 0) continue;        // 只认左键按下
          const idx = Math.max(0, row - 1 - rowOffset);   // 减掉自校准出来的偏移
          if (hit[idx] != null) { toggle(hit[idx]); anchorTo(hit[idx], idx + 1); paint(); }
          else if (hitEv[idx]) {
            // 点聊天记录 = 展开/收起**那一条**的细节(Claude Code 同款),不折叠整轮
            const k = hitEv[idx];
            if (view.openEv.has(k)) view.openEv.delete(k); else view.openEv.add(k);
            anchorTo(k, idx + 1);
            paint();
          }
      }
      if (sawMouse) return;

      // Esc:收起全部展开的条目并跟回底部 —— Claude Code 里 Esc 就是「退出当前查看」
      if (d === "" || d === "") {
        view.openEv.clear(); stickBottom = true; view.follow = true; paint(); return;
      }
      if (d === "[H") { scroll = 0; stickBottom = false; paint(); return; }        // Home:到顶
      if (d === "[F") { stickBottom = true; paint(); return; }                     // End:到底
      if (d === "[5~") { scroll -= 20; stickBottom = false; paint(); return; }   // PgUp
      if (d === "[6~") { scroll += 20; stickBottom = scroll >= maxScroll; paint(); return; }   // PgDn
      if (/^\x1b(\[|O)A/.test(d)) return move(-1);
      if (/^\x1b(\[|O)B/.test(d)) return move(1);
      if (d === "\r" || d === "\n" || d === " ") return toggle(view.sel);
      const k = d.trim().toLowerCase();
      if (k === "q") return quit();
      if (k === "f") { view.follow = true; stickBottom = true; paint(); return; }
      if (k === "s") { req(base, "/agent/stop", "POST", {}).catch(function () {}); return; }
      if (k === "o") {
        const cmd = process.platform === "win32" ? ["cmd", ["/c", "start", "", base]]
          : process.platform === "darwin" ? ["open", [base]] : ["xdg-open", [base]];
        try { spawn(cmd[0], cmd[1], { detached: true, stdio: "ignore" }).unref(); } catch (_) {}
      }
    });
  }
  return st;
}

/* ---------------- doctor：哪个宿主已经能用 ---------------- */
/**
 * 「跨宿主」这句话说起来轻巧,落到用户手上就是一个问题:**我这台机器现在能干什么?**
 * doctor 就答这一个问题,而且把话说死 —— 装没装、MCP 注册没注册、能不能自动起、
 * 用量解不解得出、能不能摊到子 agent。
 *
 * 特别要显示 `verified` —— 没实测过的适配器参数可能是错的,让用户知道自己在试哪一档,
 * 比让他对着一个起不来的进程猜环境问题强。
 */
function probeHosts() {
  const adapters = require("./adapters.js");
  const cli = require("./agentcli.js");
  const env = adapters.fromEnv();
  return (env ? [env] : []).concat(adapters.all()).map(function (a) {
    const bin = cli.which(a.bin);
    return {
      id: a.id, label: a.label, bin: a.bin, path: bin,
      installed: !!bin, verified: !!a.verified,
      parses: !!a.parse, subagents: !!a.subagents, cost: !!a.cost,
      // 默认走哪条路。**不等于**「有没有子 agent」—— codex 有 spawn_agent,
      // 但默认仍走 per-role(协调者那条路要开 danger-full-access,而且实测更贵)。
      perRole: !a.subagents || !!a.preferPerRole || !!a.mcpNeedsPermission,
      mcp: a.mcp ? a.mcp.kind : null,
      mcpRegistered: bin ? mcpRegistered(a) : null,
      source: a.source || "内置"
    };
  });
}

/** MCP 注册了没。查得出就回 true/false,查不了回 null —— null 不是「没注册」。 */
function mcpRegistered(a) {
  const fsx = require("fs");
  const cli = require("./agentcli.js");
  try {
    if (a.mcp && a.mcp.kind === "cli") {
      // 经 agentcli.exec —— 它会把 Windows 的 .cmd 包装脚本拆成 node + 入口。
      // 直接 spawn .cmd 是 EINVAL(实测 codex),那会让「查不出来」看起来像「没注册」。
      const r = cli.exec(a.bin, ["mcp", "list"]);
      if (r.error || r.status !== 0 || !r.stdout) return null;
      return /code-forge/.test(r.stdout);
    }
    if (a.mcp && (a.mcp.kind === "json" || a.mcp.kind === "toml")) {
      if (!fsx.existsSync(a.mcp.file)) return false;
      return /code-forge/.test(fsx.readFileSync(a.mcp.file, "utf8"));
    }
  } catch (_) { return null; }
  return null;
}

function doctorReport(hosts, W) {
  W = Math.max(60, Math.min(W || 100, 120));
  const L = [];
  // ⚠ 上色**要在补齐之后**。pad() 数的是显示宽度,而 ANSI 转义符也在字符串里 ——
  //   先上色再 pad,那几个不可见字符会被算进宽度,整张表歪掉(踩过)。
  const mark = function (v, n) {
    const c = v === true ? C.green : v === false ? C.red : C.dim;
    return c(v === true ? "✓" : v === false ? "✗" : "?") + " ".repeat(Math.max(0, n - 1));
  };
  L.push(C.teal(C.bold("CODE-FORGE doctor")) +
    C.dim("  " + clip("这台机器上哪个 coding agent 现在能跑对抗回环", W - 20)));
  L.push(C.dim(GL.head.repeat(W)));

  const ready = hosts.filter(function (h) { return h.installed; });
  L.push("");
  L.push(rule("能用的", W, ready.length ? ready.length + " 个" : ""));
  L.push(C.dim("  " + pad("宿主", 16) + pad("装了", 6) + pad("MCP", 6) + pad("自动起", 8) +
    pad("用量", 6) + pad("角色隔离", 10) + "适配器"));

  ready.forEach(function (h) {
    // 「角色隔离」不是能力有无,是**默认走哪条路** —— 两种都保证每个角色独立会话、
    // 都能逐角色记账。而且它**不等于**「有没有子 agent」:codex 两样都有,
    // 默认走 per-role 是因为协调者那条路要开危险权限档、且实测更贵。
    L.push("  " + C.bold(pad(h.label, 16)) + mark(true, 6) +
      mark(h.mcpRegistered, 6) + mark(true, 8) +
      mark(h.parses, 6) +
      C.green(pad(h.perRole ? "独立进程" : "子 agent", 10)) +
      (h.verified ? C.green("实测过") : C.yellow("未实测")) +
      // 「← 从哪来的」是附注,窄屏放不下就不放 —— 它挤出去会把整张表顶歪
      (h.source !== "内置" && W >= 78
        ? C.dim("  ← " + clip(h.source, W - 64)) : ""));
  });
  if (!ready.length) L.push(C.yellow("  一个都没找到。装一个 coding agent CLI（claude / codex / …）再来。"));

  const missing = hosts.filter(function (h) { return !h.installed; });
  if (missing.length) {
    L.push("");
    wrapText("没装：" + missing.map(function (h) { return h.label + "(" + h.bin + ")"; }).join("  "),
      W - 2, "  ").forEach(function (l, i) { L.push(C.dim((i === 0 ? "  " : "") + l)); });
  }

  L.push("");
  L.push(rule("列的意思", W));
  // 图例也折行。这几段是**唯一**解释每一列什么意思的地方,溢出去等于让人读半句
  const note = function (k, lines) {
    let first = true;
    lines.forEach(function (t) {
      wrapText(t, W - 12, "").forEach(function (l) {
        L.push("  " + (first ? C.dim(pad(k, 10)) : " ".repeat(10)) + C.dim(l));
        first = false;
      });
    });
  };
  note("MCP", ["回环的六个工具注册了没（? = 查不出来，不等于没注册）"]);
  note("自动起", ["能不能被 loop_agent 派成独立进程的角色（判据评审者也走它）"]);
  note("用量", ["它的输出能不能解出 token（✗ = 回环照跑，用量那栏显示「未上报」）"]);
  note("角色隔离", [
    "**默认**怎么给每个角色开独立会话：子 agent（一个进程内）/ 独立进程",
    "两种都保证角色不共用上下文、都能逐角色记账；不共用会话是硬要求",
    "—— 一个会话里先当实现者再当反驳者，等于让它复核自己刚说过的话",
    "⚠ 这一列不等于「有没有子 agent」：codex 有 spawn_agent，但默认仍走独立进程",
    "（协调者那条路要开 danger-full-access，且实测更贵）。--single / --per-role 可强制"
  ]);
  note("适配器", [
    "未实测 = 参数按公开约定写的、这台机器上没验过。起不来就改",
    require("./adapters.js").OVERRIDE_FILE
  ]);

  /* ★ 「在跑的监控台/MCP 比磁盘上的代码旧」—— 改了代码却看到旧行为,十有八九是它。
   *    监控台和 MCP server 都是常驻进程:代码更新不会热生效,而这一点没人提醒的话,
   *    用户会以为「更新没同步」(实测被问过:改了不弹网页,结果旧 MCP 还在弹)。 */
  try {
    const info = JSON.parse(require("fs").readFileSync(
      path.join(os.tmpdir(), "code-forge-port.json"), "utf8"));
    const newest = ["server.js", "mcp.js", "hostrun.js", "agentrun.js", "tui.js"]
      .map(function (f) {
        try { return require("fs").statSync(path.join(__dirname, f)).mtimeMs; }
        catch (_) { return 0; }
      })
      .reduce(function (a, b) { return Math.max(a, b); }, 0);
    // 先验尸:pid 死了它就不是「在跑的监控台」,没什么可警告(尸体文件会被下一次发现收掉)
    let ownerAlive = true;
    if (info && info.pid) { try { process.kill(info.pid, 0); } catch (_) { ownerAlive = false; } }
    if (info && info.startedAt && ownerAlive && newest > info.startedAt) {
      L.push("");
      wrapText("⚠ 在跑的监控台(端口 " + info.port + ")比磁盘上的代码旧 —— 它还是老行为。" +
        "重启它:关掉那个进程(pid " + info.pid + ")再跑一次;MCP 同理,重开 agent 会话。",
        W - 4, "    ").forEach(function (l, i) {
        L.push(C.yellow((i === 0 ? "  " : "") + l));
      });
    }
  } catch (_) { /* 没有端口文件 = 没有在跑的监控台,没什么可警告 */ }

  const best = ready.filter(function (h) { return h.verified; })[0] || ready[0];
  if (best) {
    L.push("");
    L.push(C.dim(GL.head.repeat(W)));
    L.push(C.green("现在就能用  ") + C.bold("在 " + best.label + " 的聊天里: /code-forge <你的目标>"));
    if (best.mcpRegistered === false) {
      L.push(C.yellow("            ⚠ 但 " + best.label + " 还没注册 MCP —— 先跑一次 `code-forge install`。"));
    }
  }
  return L.join("\n");
}

/* ---------------- 从 agent 会话里弹一个真终端 ---------------- */

/**
 * 认出「我现在是被某个 coding agent 的工具调用起来的」。
 *
 * 为什么要认:agent 的 shell **没有终端**(stdin/stdout 都不是 TTY),
 * 于是问答、点选、直播画面全都用不了 —— 而报错只说「stdin 不是终端」时,
 * 人是懵的:我明明就在 Claude Code 里啊。说出「你在谁的会话里」,下一步才指得准。
 */
function hostSession() {
  const e = process.env;
  if (e.CLAUDECODE || e.CLAUDE_CODE_ENTRYPOINT) return "Claude Code";
  if (e.CODEX_SANDBOX || e.CODEX_HOME || e.CODEX_MANAGED_BY_NPM) return "Codex";
  if (e.CURSOR_AGENT || e.CURSOR_TRACE_ID) return "Cursor";
  if (e.TERM_PROGRAM === "vscode" && !process.stdout.isTTY) return "编辑器终端";
  return null;
}

/**
 * 拼出「在一个新终端窗口里跑这条命令」。**纯函数**(给平台和命令行,回 spawn 参数),
 * 所以三个平台的写法可以单测 —— 靠肉眼验的东西只能在自己这台机器上验一个平台。
 *
 * @param platform  process.platform
 * @param cmdline   要在新窗口里跑的整条命令（已经引好号）
 * @param has       (bin) => 这个程序在不在 PATH 上，用来挑终端模拟器
 */
function newWindowCmd(platform, cmdline, has) {
  has = has || function () { return false; };
  if (platform === "win32") {
    // Windows Terminal 在就用它(标签页、字体、鼠标都正常);没有就退回 cmd 的 start。
    // ⚠ `start` 的第一个引号参数会被当成**窗口标题**,所以那个空标题不能省。
    if (has("wt")) return { cmd: "wt", args: ["new-tab", "cmd", "/k", cmdline] };
    // ⚠ cmd.exe 解析命令行不按 CommandLineToArgvW 的约定 —— node 默认的参数转义
    // (给 cmdline 里的内嵌引号加 \) 会把 cmd 绕晕,含空格的 node 路径(Program Files)
    // 一弹窗口就报错。verbatim:让 spawn 原样传,别替我们转义。
    return { cmd: "cmd", args: ["/c", "start", "", "cmd", "/k", cmdline], verbatim: true };
  }
  if (platform === "darwin") {
    // osascript 是 macOS 上唯一不挑终端 app 的办法
    return { cmd: "osascript", args: ["-e",
      'tell application "Terminal" to activate',
      "-e", 'tell application "Terminal" to do script ' + JSON.stringify(cmdline)] };
  }
  // Linux:按常见程度试
  const cands = [
    ["x-terminal-emulator", ["-e", "bash", "-lc", cmdline + "; exec bash"]],
    ["gnome-terminal", ["--", "bash", "-lc", cmdline + "; exec bash"]],
    ["konsole", ["-e", "bash", "-lc", cmdline + "; exec bash"]],
    ["xfce4-terminal", ["-e", "bash -lc " + JSON.stringify(cmdline + "; exec bash")]],
    ["xterm", ["-e", "bash", "-lc", cmdline + "; exec bash"]]
  ];
  for (let i = 0; i < cands.length; i++) {
    if (has(cands[i][0])) return { cmd: cands[i][0], args: cands[i][1] };
  }
  return null;
}

/** 引号:命令行里带空格的路径（`C:\Program Files\...`）不引就散成两个参数 */
function q(s) {
  return /[\s"]/.test(String(s)) ? '"' + String(s).replace(/"/g, '\\"') + '"' : String(s);
}

/**
 * 把自己在一个真终端窗口里重开一遍(去掉 --new-window,免得它再弹一个)。
 * 回 true = 弹出去了。
 */
function relaunchLine(argv, exe, entry) {
  // ⚠ 必须把 --new-window 摘掉,否则新窗口一起来又弹一个新窗口(一秒钟几十个终端)
  const rest = (argv || []).filter(function (a) { return a !== "--new-window" && a !== "-w"; });
  return [q(exe), q(entry)].concat(rest.map(q)).join(" ");
}

function openInNewWindow(argv) {
  const cmdline = relaunchLine(argv, process.execPath, process.argv[1] || __filename);
  const cli = require("./agentcli.js");
  const plan = newWindowCmd(process.platform, cmdline, function (b) { return !!cli.which(b); });
  if (!plan) {
    console.error(C.yellow("没找到能用的终端程序（x-terminal-emulator / gnome-terminal / konsole / xterm）。"));
    console.error(C.dim("自己开一个终端跑：") + cmdline);
    return false;
  }
  try {
    spawn(plan.cmd, plan.args, { detached: true, stdio: "ignore",
      windowsVerbatimArguments: !!plan.verbatim }).unref();
  } catch (e) {
    console.error(C.yellow("弹终端失败：" + e.message));
    console.error(C.dim("自己开一个终端跑：") + cmdline);
    return false;
  }
  console.log(C.teal("已在新终端窗口里打开") + C.dim("（这个会话里没有终端，直播画面只能在那边）"));
  console.log(C.dim("  " + cmdline));
  return true;
}


/* ---------------- main ---------------- */
/**
 * 观察面(2026-08 收窄):执行只发生在 coding agent 里(/code-forge 或 MCP 协议),
 * 这里只剩看的 —— watch(直播,默认)/usage/doctor/mousetest。
 * tui/go 那套「自己拉宿主进程当执行者」的向导整个删了:它逼用户挑宿主/挑模型/管进程,
 * 而这些在 coding agent 会话里本来就是现成的。
 */
async function main(argv) {
  // --new-window:这儿没终端(agent 的 shell)时,把直播弹到一个真终端窗口里去
  if (argv.includes("--new-window") || argv.includes("-w")) {
    return void openInNewWindow(argv);
  }
  const sub = argv[0];
  const mode = sub === "usage" ? "usage" : sub === "doctor" ? "doctor"
    : sub === "mousetest" ? "mousetest" : "watch";
  /* --url:钉死看哪个台子。mcp 弹这个窗时数的是**它那个台子**的观众数 ——
   * 这里再走一遍全局发现,端口文件恰好被别的实例(如测试台)抢走时就看错台子(实测)。 */
  const uIdx = argv.indexOf("--url");
  const base = uIdx >= 0 && argv[uIdx + 1] ? argv[uIdx + 1] : discoverBase();

  // mousetest / doctor 不碰监控台 —— 它们就是给「还没跑起来」的人用的
  if (mode === "mousetest") { await mouseTest(); return; }
  if (mode === "doctor") {
    console.log(doctorReport(probeHosts(), process.stdout.columns));
    return;
  }

  if (mode === "usage") {
    const b = await ensureConsole(base);
    const r = await req(b, "/usage");
    if (r.status !== 200) throw new Error("取不到用量：HTTP " + r.status);
    console.log(usageReport(r.body, process.stdout.columns));
    return;
  }

  // watch(默认)。agent 的 shell 里没有 TTY:不装画面,退化成顺序输出(watch 自己会判)
  const b = await ensureConsole(base);
  if (argv.includes("--web")) openWeb(b);
  // ⚠ 这行不分 TTY 都要打:watch 会先回放日志里的**旧档案** —— 不定性的话,
  //   一屏历史事件滚出来,看起来就像「code-forge 直接跑了一个回环」(实测被这么理解过)。
  console.log(C.dim("观察面:回放档案并接上直播。开跑在 coding agent 里: /code-forge <目标>"));
  watch(b, {});
}


module.exports = { main: main, render: render, renderLines: renderLines, fitHeight: fitHeight,
  reduce: reduce, newState: newState, watch: watch, discoverBase: discoverBase,
  canPoint: canPoint, mouseTest: mouseTest,
  newWindowCmd: newWindowCmd, hostSession: hostSession, relaunchLine: relaunchLine,
  wrapText: wrapText, clip: clip, dispWidth: dispWidth,
  renderUsage: renderUsage, usageReport: usageReport,
  kfmt: kfmt, shortModel: shortModel, probeHosts: probeHosts, doctorReport: doctorReport };

if (require.main === module) {
  main(process.argv.slice(2)).catch(function (e) {
    console.error(C.red("出错：") + e.message);
    process.exit(1);
  });
}
