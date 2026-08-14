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
对抗编程监控台

  code-forge [选项]

  --demo            日志为空时灌入示例回环(4 轮支付幂等性对抗)
  --live            配合 --demo:按时间轴逐条播出,看得见流式追加
  --reset           先清掉现有日志
  --file <path>     事件日志路径(默认 ./run.jsonl)
  --port <n>        端口(默认 4610,被占用则自动 +1)
  --no-open         不自动打开浏览器
  --mcp             以 MCP server(stdio)运行,供各家 coding agent 接入
  --url <base>      配合 --mcp:监控台地址(默认 http://localhost:4610)

  配置并启动回环:打开 http://localhost:4610/setup

  往里喂事件:
  curl -X POST localhost:4610/events -H 'content-type: application/json' \\
       -d '{"t":"event","round":1,"role":"critic","kind":"attack","summary":"…"}'
`);
  process.exit(0);
}

// MCP 模式:只跑 stdio server,不起 HTTP、不碰日志文件
if (flag("mcp")) {
  require("./mcp.js").serve({ url: opt("url", "http://localhost:4610") });
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
    try { log.push(JSON.parse(line)); }
    // 坏行只跳过这一行、吼一声 —— 不因为一行畸形就丢掉整段历史
    catch (_) { console.warn("[log] 跳过一行无法解析的记录"); }
  });
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
    const since = parseInt(req.headers["last-event-id"] || url.searchParams.get("since") || "0", 10) || 0;
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
      const n = append(parsed);
      res.writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ appended: n, total: log.length }));
    });
    return;
  }

  if (req.method === "GET" && (url.pathname === "/setup" || url.pathname === "/setup.html")) {
    return sendFile(res, "setup.html");
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
    return host.gate().then((r) => json(res, r.error ? 409 : 200, r))
      .catch((e) => json(res, 500, { error: String(e.message) }));
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

  // 起一次回环。一本书至多一个在跑的回环 —— 两个 driver 往同一条流里写就分不清谁说的
  if (url.pathname === "/runs" && req.method === "POST") {
    return readJson(req, res, (cfg) => {
      if (run.active) {
        return json(res, 409, { error: "已有回环在进行中,先停止它" });
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
    if (err.code === "EADDRINUSE" && left > 0) return listen(port + 1, left - 1);
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

function ready(port) {
  const url = "http://localhost:" + port;
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
listen(START_PORT, 10);
