"use strict";
/**
 * 终端里的配置 + 直播。零依赖,只用 ANSI 与 readline。
 *
 *   code-forge tui          问几个问题 → 开跑 → 就地直播（默认路径）
 *   code-forge watch        只直播（回环是从聊天里 /code-forge 起的时候用这个）
 *   code-forge tui --dry    只打印将要提交的配置,不开跑（给脚本/自测用）
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
  goal_met: "达标停止", budget_rounds: "轮数用完", budget_time: "超出时限",
  no_progress: "连续零进展", stopped: "手动停止", gate_broken: "判据本身失败",
  abandoned: "agent 放弃", driver_error: "驱动异常", budget_tokens: "TOKEN 用尽"
};

/* ---------------- 找监控台（与 mcp.js 同一套三级发现） ---------------- */
function discoverBase() {
  if (process.env.CODE_FORGE_URL) return process.env.CODE_FORGE_URL;
  try {
    const info = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), "code-forge-port.json"), "utf8"));
    if (info && info.port) return "http://localhost:" + info.port;
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
  throw new Error("监控台起不来（手动跑一次 code-forge 看看报什么）");
}

/* ---------------- 事件 → 状态（与网页同一套 reduce 语义） ---------------- */
function newState() {
  return { run: null, roles: {}, roleOrder: [], rounds: [], byN: {}, ended: null, count: 0, unknown: 0 };
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
      role(ev.role).calls++;
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
    if (w + cw > n) return out + "…";
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

function render(st, width) {
  const W = Math.max(60, Math.min(width || 100, 120));
  const L = [];
  const run = st.run || {};
  const cur = st.rounds.length ? st.rounds[st.rounds.length - 1] : null;

  L.push(C.teal(C.bold("CODE-FORGE")) + "  " + C.dim(clip(run.session || "（还没开局）", W - 24)));
  if (run.goal) L.push(C.dim("目标  ") + clip(run.goal, W - 8));
  const b = run.budget || {};
  const meta = [
    cur ? "第 " + cur.n + " 轮" : "—",
    b.rounds ? "上限 " + b.rounds + " 轮" : null,
    b.seconds ? "限时 " + b.seconds + "s" : null,
    run.mode === "host" ? "宿主执行 · 用量不可得" : null
  ].filter(Boolean).join("  ·  ");
  L.push(C.dim(meta));
  L.push(C.dim(bar(W)));

  // 判据走势 —— 一眼看出在不在收敛,这是整个回环最该被看见的一行。
  // 一条判据事件都没有时整行不画:画一排「—」会被读成「量过了,没有数」。
  const gateRounds = st.rounds.filter(function (r) {
    return r.events.some((e) => e.role === "gate");
  });
  if (gateRounds.length) {
    const trail = gateRounds.map(function (r) {
      const g = r.events.filter((e) => e.role === "gate").pop();
      const v = g.meta && g.meta.value;
      const met = /^达标/.test(g.summary || "");
      const txt = "R" + r.n + " " + (v == null ? (met ? "过" : "未过") : v);
      return met ? C.green(txt) : C.dim(txt);
    }).join(C.dim(" → "));
    L.push(C.dim("判据  ") + trail);
  }

  // 角色
  const roles = st.roleOrder.map((id) => st.roles[id]);
  if (roles.length) {
    L.push("");
    roles.forEach(function (r, i) {
      const col = r.id === "gate" ? C.grey : ROLE_COLORS[i % ROLE_COLORS.length];
      L.push("  " + col("●") + " " + pad(r.name, 12) + C.dim(pad(r.model, 22)) +
        C.dim(r.calls ? r.calls + " 次" : "未发言"));
    });
  }

  // 本轮发生了什么（倒序不如顺序 —— 对抗是有先后的）
  if (cur && cur.events.length) {
    L.push("");
    L.push(C.dim("第 " + cur.n + " 轮") + (cur.verdict ? C.dim("  裁决 ") + clip(cur.verdict.score, W - 20) : ""));
    const show = cur.events.slice(-8);
    if (cur.events.length > show.length) L.push(C.dim("  … 前 " + (cur.events.length - show.length) + " 条略"));
    show.forEach(function (e) {
      const r = st.roles[e.role] || { name: e.role, color: 0 };
      const idx = st.roleOrder.indexOf(e.role);
      const col = e.role === "gate" ? C.grey : ROLE_COLORS[(idx < 0 ? 0 : idx) % ROLE_COLORS.length];
      const kind = KIND_LABEL[e.kind] || "";
      const head = "  " + C.dim(pad(e.ts || "", 9)) + col(pad(r.name, 10)) + C.dim(pad(kind, 8));
      const met = e.role === "gate" && /^达标/.test(e.summary || "");
      L.push(head + (met ? C.green(clip(e.summary, W - 30)) : clip(e.summary, W - 30)));
    });
  }

  if (st.ended) {
    L.push("");
    const good = st.ended.reason === "goal_met";
    const tag = (good ? C.green : C.yellow)("■ " + (STOP_LABEL[st.ended.reason] || st.ended.reason));
    L.push(tag + "  " + C.dim(clip(st.ended.detail || "", W - 24)));
    if (st.ended.rounds) L.push(C.dim("  跑了 " + st.ended.rounds + " 轮" +
      (st.ended.seconds ? "，" + st.ended.seconds + " 秒" : "")));
  } else if (st.streaming) {
    L.push("");
    L.push(C.teal("▸ ") + C.dim(clip(st.streaming.text || "进行中…", W - 6)));
  }
  if (st.unknown) L.push(C.yellow("  ⚠ " + st.unknown + " 条认不出的事件（已忽略但计数）"));
  return L.join("\n");
}

/* ---------------- 直播 ---------------- */
function watch(base, opts) {
  opts = opts || {};
  const st = newState();
  let dirty = false;
  let lastPaint = 0;

  function paint() {
    if (!TTY) return;
    process.stdout.write("\x1b[H\x1b[2J" + render(st, process.stdout.columns) + "\n\n" +
      C.dim("  s 停止   o 网页   q 退出（后台继续）") + "\n");
    lastPaint = Date.now();
    dirty = false;
  }
  const timer = setInterval(function () {
    if (dirty && Date.now() - lastPaint > 150) paint();
  }, 120);

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

  if (TTY) {
    paint();
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.setRawMode) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("keypress", async function (ch, key) {
      const k = (key && key.name) || ch;
      if (k === "q" || (key && key.ctrl && key.name === "c")) {
        if (process.stdin.setRawMode) process.stdin.setRawMode(false);
        clearInterval(timer);
        console.log("\n" + C.dim("已退出。回环仍在后台跑,`code-forge watch` 可以再接回来。"));
        process.exit(0);
      }
      if (k === "s") { await req(base, "/agent/stop", "POST", {}).catch(() => {}); }
      if (k === "o") {
        const cmd = process.platform === "win32" ? ["cmd", ["/c", "start", "", base]]
          : process.platform === "darwin" ? ["open", [base]] : ["xdg-open", [base]];
        try { spawn(cmd[0], cmd[1], { detached: true, stdio: "ignore" }).unref(); } catch (_) {}
      }
    });
  }
  return st;
}

/* ---------------- 问几个问题 ---------------- */
const ROLE_PRESETS = {
  1: { label: "提议者 + 反驳者 + 复核者（默认）", roles: [
    { name: "提议者", kind: "propose", subagent: "forge-proposer", model: "sonnet", trigger: "always", duty: "提出最小侵入的改法并落地" },
    { name: "反驳者", kind: "attack", subagent: "forge-critic", model: "opus", trigger: "always", duty: "只找反例，不许改文件" },
    { name: "复核者", kind: "audit", subagent: "forge-reviewer", model: "sonnet", trigger: "on_green", duty: "判绿后查是否把判据糊弄过去了" }
  ] },
  2: { label: "提议者 + 反驳者（快）", roles: [
    { name: "提议者", kind: "propose", subagent: "forge-proposer", model: "sonnet", trigger: "always", duty: "提出最小侵入的改法并落地" },
    { name: "反驳者", kind: "attack", subagent: "forge-critic", model: "opus", trigger: "always", duty: "只找反例，不许改文件" }
  ] },
  3: { label: "提议者 + 三个反驳者（狠）", roles: [
    { name: "提议者", kind: "propose", subagent: "forge-proposer", model: "sonnet", trigger: "always", duty: "提出最小侵入的改法并落地" },
    { name: "反驳者·并发", kind: "attack", subagent: "forge-critic", model: "opus", trigger: "always", duty: "只查并发与顺序问题" },
    { name: "反驳者·覆盖", kind: "attack", subagent: "forge-critic", model: "opus", trigger: "always", duty: "只查漏掉的入口与边界" },
    { name: "反驳者·判据", kind: "attack", subagent: "forge-critic", model: "opus", trigger: "always", duty: "只查判据有没有被糊弄过去" }
  ] }
};
const PERMS = [
  { id: "auto", label: "auto（推荐）", desc: "常规操作由 Claude Code 的安全判定放行" },
  { id: "acceptEdits", label: "acceptEdits", desc: "自动接受改文件；Bash 仍要批准 —— 无人值守会卡住" },
  { id: "bypassPermissions", label: "bypassPermissions（危险）", desc: "什么都不拦：能改任何文件、跑任何命令" }
];

function ask(rl, q, dflt) {
  return new Promise(function (resolve, reject) {
    let done = false;
    // stdin 提前关掉（管道喂完了、Ctrl-D）时 rl.question 的回调永远不会被调,
    // 于是 await 挂住、事件循环空掉、进程静默退出 —— 用户看到的是「命令坏了」。
    // 必须吼一声,并指向可脚本化的那条路。
    const onClose = function () {
      if (done) return;
      done = true;
      reject(new Error("输入提前结束（stdin 关掉了）。交互式运行 `code-forge tui`，" +
        "或用 `code-forge tui --config cfg.json` / `--preset` 跳过问答。"));
    };
    rl.once("close", onClose);
    rl.question(q + (dflt ? C.dim(" [" + dflt + "]") : "") + " ", function (a) {
      if (done) return;
      done = true;
      rl.removeListener("close", onClose);
      resolve((a || "").trim() || dflt || "");
    });
  });
}

async function wizard(rl) {
  console.log(C.teal(C.bold("CODE-FORGE")) + C.dim("  配置一次对抗回环（回车用括号里的默认值）\n"));
  // 第一步就是确立目标 —— 后面的判据候选全靠它,空着往下走只会拿到一堆通用命令
  const gsug = require("./gatesuggest.js");
  let task = await ask(rl, "① 要做什么？");
  while (!gsug.taskEstablished(task)) {
    console.log(C.yellow("  目标太短。判据候选是按目标挑的,先说清要做什么(一句话就行)。"));
    task = await ask(rl, "① 要做什么？");
  }
  const cwd = await ask(rl, "② 工作目录", process.cwd());

  // 判据命令:让协调者**按上面那个目标**看一眼项目给候选,选号即用,也可以直接把命令打进去。
  // 建议只是省打字 —— 它没跑过那条命令,第一轮 loop_gate 才是真跑。
  let cmd = "";
  let metric = null;
  console.log("");
  console.log(C.dim("③ 判据命令 —— 按目标「") + clip(task, 40) + C.dim("」找候选…"));
  process.stdout.write(C.dim("   正在看项目（只读，最多 60s）…"));
  let sug = { candidates: [] };
  try { sug = await gsug.suggest({ task: task, cwd: cwd, timeoutMs: 60000 }); }
  catch (e) { sug = { candidates: [], error: e.message }; }
  process.stdout.write("\r" + " ".repeat(46) + "\r");

  if (sug.candidates.length) {
    console.log(C.dim("   候选（" + (sug.source || "") + "，按可信度排）："));
    sug.candidates.forEach(function (c, i) {
      console.log("  " + (i + 1) + ") " + C.bold(c.command) +
        (c.why ? C.dim("  — " + clip(c.why, 56)) : "") +
        (c.metric ? C.dim("  [带指标 " + c.metric.name + "]") : ""));
    });
    if (sug.note) console.log(C.dim("  注：" + clip(sug.note, 80)));
    console.log(C.dim("  0) 自己填 / 直接把命令打进来也行"));
    const pick = await ask(rl, "判据命令", "1");
    const n = Number(pick);
    if (!isNaN(n) && n >= 1 && n <= sug.candidates.length) {
      const chosen = sug.candidates[n - 1];
      cmd = chosen.command;
      metric = chosen.metric || null;
      console.log(C.dim("  用 " + cmd + (metric ? "（指标 " + metric.name + "）" : "")));
    } else if (pick === "0" || pick === "") {
      cmd = await ask(rl, "  自己填（留空=判不出达标）", "");
    } else {
      cmd = pick;   // 不是号码就当成命令本身 —— 想直接打的人不该被逼着先选 0
    }
  } else {
    if (sug.error) console.log(C.dim("协调者没能给出候选（" + clip(sug.error, 60) + "），自己填："));
    if (sug.note) console.log(C.dim("注：" + clip(sug.note, 80)));
    cmd = await ask(rl, "判据命令（能跑的那条，留空=判不出达标）", "");
  }

  // 候选自带指标就不必再问;否则给机会配一个
  if (cmd && !metric) {
    const pattern = await ask(rl, "指标正则（留空=只看退出码）", "");
    if (pattern) {
      const name = await ask(rl, "  指标名", "指标");
      const min = await ask(rl, "  需 ≥（留空跳过）", "");
      const max = await ask(rl, "  需 ≤（留空跳过）", "");
      metric = { name: name, pattern: pattern,
        min: min === "" ? null : Number(min), max: max === "" ? null : Number(max) };
    }
  }
  const rounds = Number(await ask(rl, "最多几轮", "6"));
  const seconds = Number(await ask(rl, "最长多少秒", "1800"));
  const nop = Number(await ask(rl, "零进展几轮即停", "2"));

  console.log("\n" + C.dim("角色："));
  Object.keys(ROLE_PRESETS).forEach((k) => console.log("  " + k + ") " + ROLE_PRESETS[k].label));
  const pick = await ask(rl, "选一个", "1");
  const roles = (ROLE_PRESETS[pick] || ROLE_PRESETS[1]).roles;

  console.log("\n" + C.dim("权限（agent 要改文件、跑测试才干得成活）："));
  PERMS.forEach((p, i) => console.log("  " + (i + 1) + ") " + p.label + C.dim(" — " + p.desc)));
  const pi = Number(await ask(rl, "选一个", "1")) - 1;
  let perm = (PERMS[pi] || PERMS[0]).id;
  if (perm === "bypassPermissions") {
    const yes = await ask(rl, C.red("这会让它无人拦地改文件、跑命令。确认？输入 yes"), "no");
    if (yes.toLowerCase() !== "yes") { perm = "auto"; console.log(C.dim("  已改回 auto。")); }
  }
  const model = await ask(rl, "协调者模型（opus/sonnet/haiku/fable，留空=默认）", "");

  return {
    session: (task || "终端发起的回环").slice(0, 60), task: task,
    goal: { command: cmd, cwd: cwd || null, metric: metric },
    budget: { rounds: rounds || 6, seconds: seconds || 1800, noProgressRounds: isNaN(nop) ? 2 : nop },
    roles: roles, permissionMode: perm, model: model || null, client: "code-forge tui"
  };
}

/* ---------------- main ---------------- */
async function main(argv) {
  const dry = argv.includes("--dry") || argv.includes("--dry-run");
  const mode = argv.includes("watch") ? "watch" : "tui";
  const base = discoverBase();

  if (mode === "watch") {
    const b = await ensureConsole(base);
    watch(b, {});
    return;
  }

  // 可脚本化的两条路:显式配置文件 / 工作目录里上次存下的预设 —— 都不必回答问题
  let cfg = null;
  const ci = argv.indexOf("--config");
  if (ci >= 0 && argv[ci + 1]) {
    cfg = JSON.parse(fs.readFileSync(argv[ci + 1], "utf8"));
  } else if (argv.includes("--preset")) {
    const f = path.join(process.cwd(), ".code-forge.json");
    if (!fs.existsSync(f)) throw new Error("这个目录里没有 .code-forge.json（先跑一次 tui 或页面 Run 会存下来）");
    cfg = JSON.parse(fs.readFileSync(f, "utf8"));
    console.log(C.dim("用预设 " + f));
  }

  if (!cfg) {
    if (!process.stdin.isTTY) {
      throw new Error("stdin 不是终端,问答走不通。用 `--config cfg.json` 或 `--preset`," +
        "或者在真终端里跑 `code-forge tui`。");
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try { cfg = await wizard(rl); } finally { rl.close(); }
  }

  if (dry) { console.log("\n" + JSON.stringify(cfg, null, 2)); return; }
  if (!cfg.goal.command) {
    console.log(C.yellow("\n⚠ 没有判据命令：这次回环判不出达标，只能靠轮数/时限停。"));
  }

  const b = await ensureConsole(base);
  const r = await req(b, "/agent/run", "POST", cfg);
  if (r.status !== 200) {
    console.error(C.red("\n启动失败：") + (r.body && r.body.error ? r.body.error : "HTTP " + r.status));
    process.exit(1);
  }
  console.log(C.dim("\n已启动（" + cfg.permissionMode + "）。监控台 " + b +
    (r.body.preset ? "，配置存在 " + r.body.preset : "")));
  await new Promise((s) => setTimeout(s, 600));
  watch(b, {});
}

module.exports = { main: main, render: render, reduce: reduce, newState: newState, wizard: wizard,
  watch: watch, discoverBase: discoverBase, ROLE_PRESETS: ROLE_PRESETS, PERMS: PERMS };

if (require.main === module) {
  main(process.argv.slice(2)).catch(function (e) {
    console.error(C.red("出错：") + e.message);
    process.exit(1);
  });
}
