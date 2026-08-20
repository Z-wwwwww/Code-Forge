#!/usr/bin/env node
"use strict";
/**
 * 对抗编程监控台 — 本地服务
 *
 * 一个进程干三件事:
 *   1. 托出监控台页面           GET  /
 *   2. 把事件流推给页面 (SSE)    GET  /events        (支持 Last-Event-ID 断线续传)
 *   3. 收角色/工具报上来的事件   POST /events        (单条或数组)
 *
 * 事件日志是 append-only 的 JSONL(默认 ./run.jsonl),它是唯一的事实来源:
 * 页面上所有数字都由它 reduce 出来,不在别处另存一份状态。故重启、重连、回放
 * 都是同一条路径 —— 从第 N 条之后接着发。
 *
 * 零依赖,只用 Node 标准库。
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = __dirname;
const argv = process.argv.slice(2);
const flag = (name) => argv.includes("--" + name);
const opt = (name, dflt) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

if (flag("help") || flag("h")) {
  console.log(`
对抗编程监控台（观察面）

  执行只发生在 coding agent 里：
    Claude Code / Codex 聊天里    /code-forge <目标>
  （角色/判据/预算在那边确认；这边只负责判定、记账和直播）

  code-forge [子命令] [选项]

  (不带参数)        只打这份指引，什么都不执行
  watch             回放档案并接上直播（回环开跑时会自动弹这个窗口;--web 同时弹浏览器）
  web               起监控台 + 弹浏览器（--port/--demo/--no-open 照常认）
  preview           改 UI 用:示例档案+私有端口,零回环零模型调用;网页刷新即新,TUI 重开即新
  usage             逐 agent 用量：谁烧了多少、每一轮各花了多少、用了哪些工具
  doctor            MCP 接没接好、哪个 coding agent 里能用
  mousetest         直播点不动时用它：分清是终端不上报鼠标，还是没接住
  install           一键接入（技能/角色/斜杠命令/MCP；幂等，--dry-run 只看）
  uninstall         卸掉上面那些

  --demo            日志为空时灌入示例回环(4 轮支付幂等性对抗)
  --live            配合 --demo:按时间轴逐条播出,看得见流式追加
  --reset           先清掉现有日志
  --file <path>     事件日志路径(默认 ./run.jsonl)
  --port <n>        端口(默认 4610,被占用则自动 +1)
  --no-open         不自动打开浏览器
  --no-port-file    不登记进全局端口发现文件(一次性/测试实例用,别让别人找到你)
  --stay            常驻(默认没人看且没回环在跑 30s 就自灭,不留僵尸)
  --mcp             以 MCP server(stdio)运行,供各家 coding agent 接入
  --url <base>      配合 --mcp:监控台地址(默认按端口文件/环境变量发现)

  往里喂事件:
  curl -X POST localhost:4610/events -H 'content-type: application/json' \
       -d '{"t":"event","round":1,"role":"critic","kind":"attack","summary":"…"}'
`);
  process.exit(0);
}

// 一键接入 Claude Code。install.js 自己会解析 --dry-run / --uninstall,
// 这里只是让 `npx code-forge install` 这条路走得通(不必先 clone 仓库)
if (argv[0] === "install" || argv[0] === "uninstall") {
  if (argv[0] === "uninstall" && !argv.includes("--uninstall")) process.argv.push("--uninstall");
  require("./install.js");
  return;
}

// ── 入口的约定(定死,别再漂):
//   code-forge                裸命令 = tui(终端是默认的脸;网页是可选项,不是必经之路)
//   code-forge --web          tui 照跑,同时弹浏览器(两边看同一份事件流)
//   code-forge web            只要网页:起监控台 + 弹浏览器(原来裸命令的行为)
//   code-forge --demo/--port… 带服务参数 = 起监控台(脚本/CI 在用,不动)
/*
 * ── 入口的约定(2026-08 收窄):**执行只发生在 coding agent 里**(/code-forge 或 MCP 协议),
 *    终端这头只有观察面。以前 tui/go 会自己拉一个 headless 宿主当执行者 —— 那条路整个删了:
 *    它逼用户挑宿主/挑模型/管进程,而这些在 coding agent 会话里本来就是现成的。
 *
 *   code-forge            = watch:接上正在跑的回环直播(没有就等着)
 *   code-forge web        起监控台 + 弹浏览器(纯观察,--port/--demo 照常认)
 *   code-forge usage      逐 agent 用量
 *   code-forge doctor     MCP 接没接好、哪个 agent 里能用
 */
if (argv[0] === "tui" || argv[0] === "go") {
  console.error(["这条路移除了:执行只发生在 coding agent 里。",
    "  在 Claude Code / Codex 的聊天里:  /code-forge <目标>",
    "  看直播:开跑时会自动弹终端窗口;网页监控台地址也会一并给出"
  ].join(String.fromCharCode(10)));
  process.exit(1);
}
if (argv.length === 0) {
  // 裸命令**什么都不执行** —— 连观察面都不进。实测:默认进 watch 会回放旧档案,
  // 一屏「第 1 轮…提案者…」滚出来,怎么标注都还是像「它直接跑了一个回环」。
  // 这个工具只在 coding agent 里使用,裸命令唯一的活就是把这句话说清。
console.log([
    "code-forge 在 coding agent 里使用,终端不需要认识它：",
    "",
    "  Claude Code / Codex 的聊天里    /code-forge <目标>",
    "",
    "看过程不需要任何命令：",
    "  · 开跑时自动弹出终端直播窗口",
    "  · 网页监控台的地址会在开跑时告诉你（默认 http://localhost:4610,含逐 agent 用量）",
    "",
    "  npx github:Z-wwwwww/Code-Forge install    接入/更新",
    "  npx github:Z-wwwwww/Code-Forge doctor     诊断 MCP 接没接好"
  ].join(String.fromCharCode(10)));
  return;
}
if (argv[0] === "preview") {
  /* ★ UI 预览:**零回环、零模型调用**地看/改两个观察面(用户点名:每次看效果都要
   * 启动真回环,太费 token)。示例档案 + 私有端口 + --no-port-file,不打扰真回环。
   * 网页:改 index.html 后浏览器刷新即是新的(每次请求都从磁盘读)。
   * TUI:按下面打印的 watch 命令另开一个终端;改 tui.js 后 q 掉重开即是新的。 */
  argv.splice(0, 1);
  ["--demo", "--reset", "--no-port-file"].forEach(function (f) { if (!argv.includes(f)) argv.push(f); });
  if (!argv.includes("--port")) argv.push("--port", "4650");
  if (!argv.includes("--file")) {
    argv.push("--file", path.join(require("os").tmpdir(), "cf-preview.jsonl"));
  }
  console.log("UI 预览（示例档案,零模型调用）");
  console.log("  网页  改 index.html → 浏览器刷新即生效");
  console.log("  TUI   另开终端跑:node " + path.join(__dirname, "tui.js") +
    " watch --url http://localhost:" + argv[argv.indexOf("--port") + 1] +
    "   （改 tui.js → q 退出重跑即生效）");
}
else if (argv[0] === "web") {
  argv.splice(0, 1);          // 剩下的照旧交给监控台(--port/--demo/… 都还认)
}
else if (argv[0] === "watch" || argv[0] === "usage" ||
    argv[0] === "doctor" || argv[0] === "mousetest") {
  // ⚠ 必须显式调 main:被 require 进来时 tui.js 里的 require.main===module 是假,
  // 只 require 一下等于什么都没发生(静默退出,用户以为命令坏了)
  require("./tui.js").main(argv).catch((e) => {
    console.error("出错：" + e.message);
    process.exit(1);
  });
  return;
}

// MCP 模式:只跑 stdio server,不起 HTTP、不碰日志文件
if (flag("mcp")) {
  // ⚠ 这里**不能给默认值**。mcp.js 把「传了 url」理解为「你自己指定了地址」,
  // 于是同时关掉两件事:按环境变量/端口文件发现监控台、以及连不上时自动拉起。
  // 之前这里写了 opt("url","http://localhost:4610"),结果永远认死 4610 ——
  // 监控台在别的端口时 agent 只会说「监控台没起来」(实测)。
  require("./mcp.js").serve({ url: opt("url", null) });
  return;
}

const LOG_FILE = path.resolve(opt("file", path.join(ROOT, "run.jsonl")));
const START_PORT = parseInt(opt("port", "4610"), 10);

/* ---------------- append-only 事件日志 ---------------- */
if (flag("reset")) { try { fs.unlinkSync(LOG_FILE); } catch (_) {} }

const log = [];           // 内存镜像,序号 = SSE 的 event id(从 1 起)
const clients = new Set();

function load() {
  let raw = "";
  try { raw = fs.readFileSync(LOG_FILE, "utf8"); } catch (_) { return; }
  raw.split("\n").forEach((line) => {
    if (!line.trim()) return;
    let e;
    try { e = JSON.parse(line); }
    // 坏行只跳过这一行、吼一声 —— 不因为一行畸形就丢掉整段历史
    catch (_) { console.warn("[log] 跳过一行无法解析的记录"); return; }
    // 合法 JSON 但不是对象(比如整行就是字面量 null)同样跳过 —— 参照 append() 的过滤,
    // 否则 reconcileLog/usage 解引用 e.t 时直接崩
    if (e && typeof e === "object") log.push(e);
  });
}

/**
 * 补账:档案里最后一局没有 run.end(执行者被中断,没走到收尾)时,启动即补一条「中断」。
 * 不补的话回放停在「第 N 轮 · 进行中」—— 一个死去的回环**伪装成还在跑**,
 * 用户重开工具会以为「关掉的流程还在后台」(实测这么问过)。
 * 在**新进程**里补是诚实的:这个进程的回环状态是空的,那一局必然不会在这里继续。
 */
function reconcileLog() {
  let lastStart = -1, lastEnd = -1, lastRound = 0;
  log.forEach(function (e, i) {
    if (e.t === "run.start") { lastStart = i; lastRound = 0; }
    if (e.t === "run.end") lastEnd = i;
    if (e.t === "round.start" && typeof e.n === "number") lastRound = e.n;
  });
  if (lastStart < 0 || lastEnd > lastStart) return;   // 没开过局 / 最后一局收过尾
  append({
    t: "run.end", reason: "interrupted", mode: "host", rounds: lastRound,
    detail: "上一局没有收尾就中断了(执行者会话关闭/进程被杀)。这里补账,免得回放伪装成进行中。"
  });
  console.log("补账            上一局未收尾,已补「中断」(第 " + lastRound + " 轮)");
}

function append(events) {
  const list = (Array.isArray(events) ? events : [events]).filter((e) => e && typeof e === "object");
  if (!list.length) return 0;
  fs.appendFileSync(LOG_FILE, list.map((e) => JSON.stringify(e)).join("\n") + "\n");
  list.forEach((e) => {
    log.push(e);
    const frame = "id: " + log.length + "\ndata: " + JSON.stringify(e) + "\n\n";
    clients.forEach((res) => res.write(frame));
  });
  return list.length;
}

/* ---------------- HTTP ---------------- */
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
                ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8" };

function sendFile(res, rel) {
  const file = path.join(ROOT, rel);
  // 只从项目目录里取文件,防路径穿越
  if (!file.startsWith(ROOT)) { res.writeHead(403).end("forbidden"); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end("not found"); return; }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    return sendFile(res, "index.html");
  }

  if (url.pathname === "/events" && req.method === "GET") {
    // 断线重连由浏览器带 Last-Event-ID 回来;没有就看 ?since=
    const since = Math.max(0, parseInt(req.headers["last-event-id"] || url.searchParams.get("since") || "0", 10) || 0);
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });
    for (let i = since; i < log.length; i++) {
      res.write("id: " + (i + 1) + "\ndata: " + JSON.stringify(log[i]) + "\n\n");
    }
    res.write(": synced " + log.length + "\n\n");   // 注释帧:告诉页面「历史发完了」
    clients.add(res);
    const beat = setInterval(() => res.write(": ping\n\n"), 25000);  // 穿过代理的保活
    req.on("close", () => { clearInterval(beat); clients.delete(res); });
    return;
  }

  if (url.pathname === "/events" && req.method === "POST") {
    // 跨站防护:浏览器发起的跨站请求会带 Origin,且和这个服务自己的地址对不上 ——
    // 直接挡在门外。不这样做的话,随便一个网页开着就能靠 <script>fetch(...) 或者
    // 表单(POST + text/plain 属于 CORS 的 simple request,不预检)往本地这条日志里
    // 写事件。非浏览器调用(curl/脚本)不带 Origin,不受影响,--help 里教的那条 curl 照样能用。
    const origin = req.headers.origin;
    if (origin && origin !== "http://" + req.headers.host && origin !== "https://" + req.headers.host) {
      res.writeHead(403, { "content-type": "application/json" })
        .end(JSON.stringify({ error: "跨站请求拒绝(Origin 与本机地址不符)" }));
      return;
    }
    // 收 Buffer 再一次性按 UTF-8 解 —— 拼字符串会在多字节字符正好跨 chunk 时把它切坏
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      chunks.push(c); size += c.length;
      if (size > 2e6) { res.writeHead(413).end("payload too large"); req.destroy(); }
    });
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      let parsed;
      try { parsed = JSON.parse(body); }
      catch (e) { res.writeHead(400, { "content-type": "application/json" })
        .end(JSON.stringify({ error: "JSON 解析失败: " + e.message })); return; }
      // 「达标停止」这几个 reason 只该由本进程内部的驱动(hostrun.js/loop.js,直接调用
      // append(),从不走这条 HTTP 口子)在判据真的过了之后写下。从 /events 这条外部
      // 入口收到的 run.end 一旦带这几个 reason,当假货整批拒绝 —— 不然本地脚本或者
      // 上面那条跨站请求只要绕过 Origin 检查(比如同源脚本)就能给自己发合格证。
      const GOAL_REASONS = ["goal_met", "judged_met", "reported_met"];
      const list = Array.isArray(parsed) ? parsed : [parsed];
      const faked = list.some((e) => e && e.t === "run.end" && GOAL_REASONS.indexOf(e.reason) >= 0);
      if (faked) {
        res.writeHead(403, { "content-type": "application/json" })
          .end(JSON.stringify({ error: "达标类终止事件(run.end + goal_met/judged_met/reported_met)只能由内部驱动写入,HTTP 入口拒绝" }));
        return;
      }
      const n = append(parsed);
      res.writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ appended: n, total: log.length }));
    });
    return;
  }

  if (req.method === "GET" && (url.pathname === "/setup" || url.pathname === "/setup.html")) {
    return sendFile(res, "setup.html");
  }
  if (req.method === "GET" && (url.pathname === "/setup-local" || url.pathname === "/setup-local.html")) {
    return sendFile(res, "setup-local.html");   // 自带 key 的那套（可选模式）
  }

  /* ---- 宿主驱动模式:宿主 agent 自己出模型,这里只管判定与记账 ---- */
  if (url.pathname === "/host/begin" && req.method === "POST") {
    return readJson(req, res, (cfg) => {
      if (run.active) return json(res, 409, { error: "本地驱动的回环正在跑,先停止它" });
      const r = host.begin(cfg);
      json(res, r.error ? 409 : 200, r);
    });
  }
  if (url.pathname === "/host/say" && req.method === "POST") {
    return readJson(req, res, (ev) => {
      const r = host.say(ev || {});
      json(res, r.error ? 409 : 200, r);
    });
  }
  if (url.pathname === "/host/gate" && req.method === "POST") {
    // opts(observed/said…)在 body 里,不读出来就恒为 undefined —— idle_spin 闸变死代码、
    // 评审者报的 said 也传不到 hostrun 那边
    return readJson(req, res, (opts) => {
      host.gate(opts || {}).then((r) => json(res, r.error ? 409 : 200, r))
        .catch((e) => json(res, 500, { error: String(e.message) }));
    });
  }
  if (url.pathname === "/host/end" && req.method === "POST") {
    return readJson(req, res, (b) => {
      const r = host.end((b && b.reason) || "abandoned", b && b.detail);
      json(res, r.error ? 409 : 200, r);
    });
  }
  if (url.pathname === "/host/status" && req.method === "GET") {
    return json(res, 200, host.status());
  }
  if (url.pathname === "/host/agent" && req.method === "POST") {
    // 替没有子 agent 的宿主派角色(独立进程)。会跑几分钟 —— 交给 promise,别同步等
    return readJson(req, res, (b) => {
      host.dispatch(b || {}).then((r) => json(res, r.error ? 409 : 200, r))
        .catch((e) => json(res, 500, { error: String(e.message) }));
    });
  }

  /* ---- 页面点 Run:起一个 headless Claude Code 来跑（零 key,用你的订阅）---- */
  // 执行路线(网页 Run / tui / go)已移除:执行只发生在 coding agent 里。
  if (url.pathname === "/agent/run" && req.method === "POST") {
    return json(res, 410, { error: "这条路移除了:在 Claude Code / Codex 里用 /code-forge 开跑;" +
      "这里只负责判定、记账和直播。" });
  }
  if (url.pathname === "/agent/stop" && req.method === "POST") {
    // 「停止」停的是聊天里跑着的回环(watch 的 s 键/网页按钮都打到这)
    if (host.isActive()) {
      const r = host.end("stopped", "从监控台停止");
      return json(res, r.error ? 409 : 200, r);
    }
    return json(res, 409, { error: "当前没有在跑的回环" });
  }
  if (url.pathname === "/agent/status" && req.method === "GET") {
    return json(res, 200, { loop: host.status() });
  }

  // 起一次回环。一本书至多一个在跑的回环 —— 两个 driver 往同一条流里写就分不清谁说的
  if (url.pathname === "/runs" && req.method === "POST") {
    return readJson(req, res, (cfg) => {
      if (run.active) {
        return json(res, 409, { error: "已有回环在进行中,先停止它" });
      }
      if (host.isActive()) {
        return json(res, 409, { error: "宿主驱动的回环正在跑,先停止它" });
      }
      if (!Array.isArray(cfg.roles) || !cfg.roles.length) {
        return json(res, 400, { error: "至少要有一个角色" });
      }
      const loop = require("./loop.js");
      run.ctl = loop.start(cfg, append);
      run.active = true;
      run.startedAt = Date.now();
      run.ctl.done.then((reason) => { run.active = false; run.lastReason = reason; });
      json(res, 200, { started: true, roles: cfg.roles.length, events: log.length });
    });
  }

  if (url.pathname === "/runs/stop" && req.method === "POST") {
    // 页面上只有一个「停止」按钮,所以这里要能停住两种模式的任意一种
    if (host.isActive()) {
      host.end("stopped", "从监控台停止");
      return json(res, 200, { stopping: true, mode: "host" });
    }
    if (!run.active) return json(res, 409, { error: "当前没有在跑的回环" });
    run.ctl.stop();   // 打断在途调用并收摊,已花的会记成估算
    return json(res, 200, { stopping: true, mode: "local" });
  }

  // 逐 agent 用量:从事件日志里现算(日志是唯一事实来源,不在别处另存一份)
  if (url.pathname === "/usage" && req.method === "GET") {
    // 只算**最近一次**回环 —— 一份日志可以按顺序装下多次,把两次的账加在一起是错的
    let from = 0;
    for (let i = log.length - 1; i >= 0; i--) { if (log[i].t === "run.start") { from = i; break; } }
    const slice = log.slice(from);
    const u = require("./usage.js").reduceEvents(slice);
    const start = slice[0] && slice[0].t === "run.start" ? slice[0] : null;
    return json(res, 200, Object.assign({
      session: start ? start.session : null,
      mode: start ? start.mode : null,
      live: host.isActive()
    }, u));
  }

  if (url.pathname === "/health") {
    const h = host.status();
    return json(res, 200, {
      ok: true, events: log.length, file: LOG_FILE, clients: clients.size,
      run: {
        // 两种驱动模式共用一个「在跑吗」,页面只需要问一次
        active: run.active || h.active,
        mode: h.active ? "host" : (run.active ? "local" : null),
        lastReason: h.endedReason || run.lastReason || null,
        spent: run.ctl ? run.ctl.spent : null,
        round: h.active ? h.round : 0,
        remaining: h.active ? h.remaining : null,
        seconds: run.startedAt ? Math.round((Date.now() - run.startedAt) / 1000) : 0
      }
    });
  }

  res.writeHead(404).end("not found");
});

/* ---------------- 小工具 ---------------- */
const run = { active: false, ctl: null, startedAt: 0, lastReason: null };   // 本地驱动(自带 key,可选)
const host = require("./hostrun.js").create(append);                        // 宿主驱动(默认,零 key)
// 自己的地址要能传给页面起的那个 claude —— 它拉起的 MCP server 继承这个环境变量,
// 于是两边一定指向同一个监控台(端口被占用自动 +1 的情况下尤其要紧)
let SELF_URL = null;
// getRound 从回环状态机来:用量要摊到轮上,而「第几轮」只有 hostrun 知道

function json(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" })
    .end(JSON.stringify(obj));
}
function readJson(req, res, cb) {
  const chunks = [];
  let size = 0;
  req.on("data", (c) => {
    chunks.push(c); size += c.length;
    if (size > 2e6) { res.writeHead(413).end("payload too large"); req.destroy(); }
  });
  req.on("end", () => {
    try { cb(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
    catch (e) { json(res, 400, { error: "JSON 解析失败: " + e.message }); }
  });
}

/* ---------------- 启动 ---------------- */
function listen(port, left) {
  server.once("error", (err) => {
    if (err.code === "EADDRINUSE" && left > 0) {
      // ⚠ server.listen(port,host,cb) 把 cb 挂成 listening 监听器,失败了也不摘。
      //   同一个 server 重试 N 次就攒 N 个 cb,最终绑上时全触发一遍 ——
      //   N 条横幅(前 N-1 条印着错端口)、N 次写端口文件、N 个浏览器标签页。
      server.removeAllListeners("listening");
      return listen(port + 1, left - 1);
    }
    console.error("起不来:", err.message);
    process.exit(1);
  });
  server.listen(port, "127.0.0.1", () => ready(port));
}

function open(url) {
  const cmd = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
            : process.platform === "darwin" ? ["open", [url]]
            : ["xdg-open", [url]];
  try { spawn(cmd[0], cmd[1], { detached: true, stdio: "ignore" }).unref(); } catch (_) {}
}

/**
 * 把自己的真实端口写下来,让 MCP server 找得到。
 * 4610 被占用时 listen() 会自动 +1,而 MCP server 那侧原本写死 4610 ——
 * 少了这个文件,两边就会静默指向不同的监控台(实测踩过:agent 报「监控台没起来」)。
 */
function writePortFile(port) {
  const f = path.join(require("os").tmpdir(), "code-forge-port.json");
  try {
    fs.writeFileSync(f, JSON.stringify({ port: port, pid: process.pid, startedAt: Date.now() }) + "\n");
    // ⚠ 只删**还指着自己**的那份。踩过:同时开了几个监控台,后起的覆盖了这个文件,
    //    先退出的那个把它删了 —— 于是活着的监控台没人找得到,MCP server 只好自己
    //    再拉一个,事件写进一个没人看的台子。删之前先确认这份还是我写的。
    const clean = () => {
      try {
        const cur = JSON.parse(fs.readFileSync(f, "utf8"));
        if (cur && cur.pid !== process.pid) return;   // 别人的,不动
      } catch (_) { return; }
      try { fs.unlinkSync(f); } catch (_) {}
    };
    process.on("exit", clean);
    process.on("SIGINT", () => { clean(); process.exit(0); });
    process.on("SIGTERM", () => { clean(); process.exit(0); });
  } catch (_) { /* 写不下只是少一层发现机制,不该拦住启动 */ }
}

/**
 * 自灭:**没人看、也没回环在跑**时退出(用户指令:「不要留僵尸监控台,关闭窗口就直接关闭」)。
 * 实测教训:常驻 + 分离的监控台攒了 11 个僵尸,把 4610~4620 占满,新进程都起不来。
 *
 * 三条不许死的例外:
 *   ① 回环在跑(host/run active) —— 判定与记账都在这个进程里,死了回环就废了;
 *   ② 刚断开(宽限期内) —— 页面刷新/直播窗口重连不该整死服务;
 *   ③ --stay —— 想手动开着长期喂事件的人用。
 * CODE_FORGE_IDLE_MS 可调宽限(默认 30s,测试用小值)。
 */
function armIdleExit() {
  if (flag("stay")) return;
  const IDLE = Math.max(200, parseInt(process.env.CODE_FORGE_IDLE_MS || "30000", 10) || 30000);
  let lastBusy = Date.now();
  const t = setInterval(function () {
    const busy = clients.size > 0 || host.isActive() || run.active;
    if (busy) { lastBusy = Date.now(); return; }
    if (Date.now() - lastBusy > IDLE) {
      console.log("没人看、也没回环在跑,自灭（--stay 可常驻）");
      process.exit(0);   // exit 钩子会把端口文件收掉(只收自己那份)
    }
  }, Math.min(5000, IDLE));
  t.unref && t.unref();
}

function ready(port) {
  const url = "http://localhost:" + port;
  SELF_URL = url;
  /* ★ --no-port-file:别把自己登记进全局端口发现文件。实测事故:npm test 起的
   *   一次性测试台(4791)把端口文件抢了过去 —— 恰逢用户在聊天里配置新回环,
   *   e2e 测试弹出的直播窗按被抢的文件找台子,测试台一死又拉起正式台回放旧档案,
   *   用户看到的就是「刚给完目标,TUI 弹出来还满是上一局的数据」。
   *   一次性/测试实例一律带这个 flag,不参与全局发现。 */
  if (!flag("no-port-file")) writePortFile(port);
  console.log("对抗编程监控台  " + url);
  console.log("事件日志        " + LOG_FILE + "  (" + log.length + " 条)");
  console.log("喂事件          POST " + url + "/events");
  if (flag("demo")) {
    const demo = require("./demo.js").events();
    if (log.length === 0) {
      if (flag("live")) { console.log("示例            逐条播出 " + demo.length + " 条…"); dribble(demo); }
      else { append(demo); console.log("示例            已灌入 " + demo.length + " 条"); }
    } else {
      console.log("示例            跳过(日志里已有 " + log.length + " 条,--reset 可清空)");
    }
  }
  if (!flag("no-open")) open(url);
  armIdleExit();
}

// 逐条播出:让「流式追加」这件事在页面上真的看得见
function dribble(events) {
  let i = 0;
  (function step() {
    if (i >= events.length) return;
    const e = events[i++];
    append(e);
    const gap = e.t === "event" ? 900 : e.t === "round.start" ? 600 : 90;
    setTimeout(step, gap);
  })();
}

load();
reconcileLog();
listen(START_PORT, 50);   // 预算要宽:曾实测 11 个历史监控台把 4610~4620 全占,10 次重试饿死了新进程
