"use strict";
/**
 * MCP server（stdio）—— 即插即用的那一层。
 *
 * 执行者是**宿主 agent 自己**(Claude Code / Codex / opencode …):它已经有模型访问权,
 * 所以这里一个 API key 都不需要、一次模型调用都不发。角色由宿主扮演/派发。
 *
 * 这层只提供宿主**不该自己做**的三件事:
 *   loop_gate   —— 达标与否由代码算(模型有充分动机说「已达标」)
 *   loop_status —— 还能不能继续,由代码管
 *   loop_say    —— 留痕:每一步进 append-only 事件流,页面实时可见
 * 外加 loop_begin / loop_end 两端。
 *
 * 监控台没起来时自动拉起并打开浏览器 —— 用的人不该先记住要开一个服务。
 *
 * 传输:换行分隔的 JSON-RPC 2.0。⚠ stdout 只许放协议帧,调试一律走 stderr。
 */

const path = require("path");
const { spawn } = require("child_process");

const TOOLS = [
  {
    name: "loop_begin",
    description:
      "开一次对抗回环并打开监控台(不在跑就自动拉起)。先调这个,再按轮次让各角色发言。\n" +
      "goal.command 是**判定达标的唯一依据**:一条能跑的命令,退出码 0 视为通过;" +
      "可选 metric 从它的输出里抓一个数比区间。没有 command 就无法判定达标,只能靠轮数/时限停。\n" +
      "roles 是你自己要扮演/派发的角色 —— 不需要填模型,你自己就是执行者。",
    inputSchema: {
      type: "object",
      properties: {
        session: { type: "string", description: "这次回环叫什么(会显示在页头)" },
        repo: { type: "string" }, branch: { type: "string" },
        goal: {
          type: "object",
          properties: {
            command: { type: "string", description: "判据命令,如 pytest -q 或 npm test" },
            cwd: { type: "string", description: "在哪个目录跑,默认监控台进程的目录" },
            metric: {
              type: "object",
              description: "可选。从命令输出里抓一个数,比区间。",
              properties: {
                name: { type: "string" },
                pattern: { type: "string", description: "正则,第一个捕获组当数字,如 coverage: ([0-9]+)" },
                min: { type: "number" }, max: { type: "number" }
              }
            }
          }
        },
        budget: {
          type: "object",
          description: "硬闸。到顶时 loop_gate 会回 continue:false,你必须停手。",
          properties: {
            rounds: { type: "number", description: "最多几轮(默认 8)" },
            seconds: { type: "number", description: "最长多少秒(默认 3600)" },
            noProgressRounds: { type: "number", description: "指标连续几轮不进步就停(默认 2)" }
          }
        },
        roles: {
          type: "array",
          description: "按发言顺序排。至少两个(一个提议、一个反驳)才叫对抗。",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "角色名,如 提议者 / 反驳者 / 安全审查" },
              duty: { type: "string", description: "它这一档负责什么" },
              kind: { type: "string", enum: ["propose", "attack", "defend", "verdict", "patch", "test", "audit", "route"],
                description: "档位,决定页面上的配色与标签" }
            },
            required: ["name"]
          }
        }
      },
      required: ["roles"]
    }
  },
  {
    name: "loop_say",
    description:
      "记录某个角色这一轮说了什么(提议 / 反驳 / 补丁 / 审查结论)。每个角色每轮发言后都调一次," +
      "页面会实时出现。summary 写一句话结论,body 写完整理由。\n" +
      "可选带 tool(这一步用了什么工具及结果)与 diff(改了哪个文件、加删几行、逐行内容)。\n" +
      "token 用量在宿主账上、这里拿不到,**不要编** —— 留空即可,页面会如实显示「不可得」。",
    inputSchema: {
      type: "object",
      properties: {
        role: { type: "string", description: "角色 id 或名字,必须是 loop_begin 里登记过的" },
        summary: { type: "string", description: "一句话结论(页面折叠行显示这句)" },
        body: { type: "string", description: "完整理由/内容" },
        kind: { type: "string", enum: ["propose", "attack", "defend", "verdict", "patch", "test", "audit", "route"] },
        targets: { type: "array", items: { type: "string" }, description: "这次是针对哪些角色的" },
        dur: { type: "string", description: "耗时,如 12.7s" },
        tool: {
          type: "object",
          properties: { name: { type: "string" }, args: { type: "string" },
            result: { type: "string" }, status: { type: "string" }, ms: { type: "string" } }
        },
        diff: {
          type: "object",
          properties: {
            file: { type: "string" }, add: { type: "number" }, del: { type: "number" },
            lines: { type: "array", description: "每行 { sign:'+'|'-'|'', text, ln }", items: { type: "object" } }
          }
        }
      },
      required: ["role", "summary"]
    }
  },
  {
    name: "loop_gate",
    description:
      "跑判据,并告诉你还能不能继续。**这是唯一能判「达标」的地方 —— 你不得自行宣布达成。**\n" +
      "每轮所有角色发言完毕后调一次。返回 met(达标了吗)、value(抓到的指标值)、output(命令输出尾部)、" +
      "continue(还能不能继续)与 stopReason。continue:false 就必须停手并 loop_end。\n" +
      "未达标时把 output 里的失败信息带回给各角色,再开下一轮。",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "loop_status",
    description:
      "读回当前回环的状态:第几轮、还剩几轮、还剩多少秒、判据是否已经判过达标、" +
      "连续无进展了几轮、当前角色表、以及(若已结束)停止原因。\n" +
      "什么时候调:不确定还能不能再来一轮、被打断后要接着干、或要向用户汇报进度时。" +
      "不要凭记忆估剩余预算 —— 这里的数才是准的。",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "loop_end",
    description:
      "收工。reason 取 stopped(人喊停)/ abandoned(你判断做不下去,detail 里说清为什么)。\n" +
      "⚠ reason=goal_met 只有在 loop_gate 真的判过达标之后才会被接受 —— 否则会被拒绝。" +
      "通常你不需要手动调它:loop_gate 判出达标或预算到顶时会自动收工。",
    inputSchema: {
      type: "object",
      properties: {
        reason: { type: "string", enum: ["stopped", "abandoned", "goal_met"] },
        detail: { type: "string", description: "一句话说明,会写进档案" }
      }
    }
  }
];

function serve(opts) {
  const explicitUrl = opts && opts.url;
  let base = explicitUrl || "http://localhost:4610";
  let consoleChild = null;
  let buf = "";

  function log(s) { process.stderr.write("[code-forge] " + s + "\n"); }
  function send(msg) { process.stdout.write(JSON.stringify(msg) + "\n"); }
  function ok(id, result) { send({ jsonrpc: "2.0", id: id, result: result }); }
  function failRpc(id, code, message) { send({ jsonrpc: "2.0", id: id, error: { code: code, message: message } }); }
  function reply(id, obj, isError) {
    ok(id, { content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }],
      isError: !!isError });
  }

  const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  async function alive() {
    try {
      const res = await fetch(base + "/health");
      return res.ok;
    } catch (_) { return false; }
  }

  /**
   * 监控台不在就拉起来。用的人不该先记住要开一个服务 —— 那就不叫即插即用了。
   * 显式给了 --url 就不自动拉(那是「连到别处」的意思)。
   */
  async function ensureConsole() {
    if (await alive()) return true;
    if (explicitUrl) {
      log("连不上 " + base + "（--url 指定的地址,不自动拉起）");
      return false;
    }
    if (!consoleChild) {
      log("监控台没在跑,正在拉起…");
      consoleChild = spawn(process.execPath, [path.join(__dirname, "server.js")], {
        detached: true, stdio: "ignore"
      });
      consoleChild.unref();
    }
    for (let i = 0; i < 40; i++) {          // 最多等 4 秒
      await sleep(100);
      if (await alive()) { log("监控台已就绪 " + base); return true; }
    }
    log("监控台没能在 4 秒内就绪");
    return false;
  }

  async function api(path, init) {
    const res = await fetch(base + path, init);
    const text = await res.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch (_) { body = { raw: text }; }
    return { status: res.status, ok: res.ok, body: body };
  }
  function post(p, obj) {
    return api(p, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(obj === undefined ? {} : obj)
    });
  }

  async function callTool(id, name, args) {
    args = args || {};
    try {
      if (name === "loop_begin") {
        const up = await ensureConsole();
        if (!up) {
          return reply(id, "起不了监控台。手动跑一次 `code-forge` 再重试;" +
            "或用 --url 指向已经在跑的那个。", true);
        }
        const r = await post("/host/begin", args);
        if (!r.ok) return reply(id, r.body, true);
        return reply(id, Object.assign({ console: base }, r.body,
          { 协议: "每个角色发言后调 loop_say;一轮结束调 loop_gate;continue:false 就停手。" }));
      }
      if (name === "loop_say") {
        const r = await post("/host/say", args);
        return reply(id, r.body, !r.ok);
      }
      if (name === "loop_gate") {
        const r = await post("/host/gate", {});
        return reply(id, r.body, !r.ok);
      }
      if (name === "loop_status") {
        const r = await api("/host/status");
        return reply(id, r.body, !r.ok);
      }
      if (name === "loop_end") {
        const r = await post("/host/end", args);
        return reply(id, r.body, !r.ok);
      }
      return failRpc(id, -32601, "未知工具：" + name);
    } catch (err) {
      return reply(id, "调用失败：" + err.message +
        "\n（监控台在跑吗？先执行 code-forge,或用 --url 指定端口）", true);
    }
  }

  function handle(msg) {
    if (msg.method === "initialize") {
      return ok(msg.id, {
        protocolVersion: (msg.params && msg.params.protocolVersion) || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "code-forge", version: "0.2.0" }
      });
    }
    if (msg.method === "notifications/initialized" || msg.method === "notifications/cancelled") return;
    if (msg.method === "ping") return ok(msg.id, {});
    if (msg.method === "tools/list") return ok(msg.id, { tools: TOOLS });
    if (msg.method === "tools/call") {
      return callTool(msg.id, msg.params && msg.params.name, msg.params && msg.params.arguments);
    }
    if (msg.id !== undefined) failRpc(msg.id, -32601, "未实现的方法：" + msg.method);
  }

  process.stdin.on("data", function (chunk) {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); }
      catch (e) { log("无法解析的一行,已跳过"); continue; }
      try { handle(msg); }
      catch (e) { if (msg.id !== undefined) failRpc(msg.id, -32603, String(e.message)); }
    }
  });
  process.stdin.on("end", function () { process.exit(0); });
  log("MCP server on stdio · 监控台 " + base + "（宿主执行,零 key）");
}

module.exports = { serve: serve, TOOLS: TOOLS };
