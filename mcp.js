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
 * 监控台没起来时自动拉起,并弹一个终端窗口直播(code-forge watch;CODE_FORGE_VIEW=web|none 可改)
 * —— 用的人不该先记住要开一个服务。
 *
 * 传输:换行分隔的 JSON-RPC 2.0。⚠ stdout 只许放协议帧,调试一律走 stderr。
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn } = require("child_process");

/**
 * 监控台在哪:四级查找。
 *   ① --url（显式指定,也意味着「别自动拉起」）
 *   ② CODE_FORGE_URL —— 页面点 Run 起的 claude 进程带下来的,MCP server 由那个
 *      claude 拉起因而继承得到,两边必然指向同一个监控台
 *   ③ 端口文件 —— 监控台启动时写下自己的真实端口。**必须有这一层**:4610 被占用时
 *      监控台会自动 +1,而写死 4610 的一侧就再也找不到它了(实测踩过这个)
 *   ④ 兜底 4610
 */
function portFile() { return path.join(os.tmpdir(), "code-forge-port.json"); }

function discoverBase(explicitUrl) {
  if (explicitUrl) return explicitUrl;
  if (process.env.CODE_FORGE_URL) return process.env.CODE_FORGE_URL;
  try {
    const info = JSON.parse(fs.readFileSync(portFile(), "utf8"));
    if (info && info.port) {
      // ★ 先验尸再信(与 tui 同一刀,事故链见 tui.discoverBase 的注释):
      //   pid 死了就删文件、落回默认口 —— 那里往往有个活着的监控台等着被复用
      let aliveOwner = true;
      if (info.pid) { try { process.kill(info.pid, 0); } catch (_) { aliveOwner = false; } }
      if (aliveOwner) return "http://localhost:" + info.port;
      try { fs.unlinkSync(portFile()); } catch (_) {}
    }
  } catch (_) {}
  return "http://localhost:4610";
}

/**
 * 监控台由我们拉起时,直播开在哪。
 *
 * 从聊天里(/code-forge)用的时候,以前这里什么都不传,server.js 默认弹**浏览器** ——
 * 而 `code-forge tui` 拉的时候特意带了 --no-open(「用 TUI 的人要的就是别弹网页」)。
 * 同一个产品,两个入口一个弹网页一个进终端,这不是偏好差异,是漏传参数。
 *
 * 现在的落点:**弹一个终端窗口跑 `code-forge watch`**(终端直播),浏览器只当退路
 * (没有终端模拟器/弹不出来时)。CODE_FORGE_VIEW=web|tui|none 可改。
 * 只在**我们刚拉起**监控台时弹 —— 台子本来就在跑,说明有人已经在看,别再糊他一脸窗口。
 */
function openView(base, log) {
  const view = String(process.env.CODE_FORGE_VIEW || "tui").toLowerCase();
  if (view === "none") return "none";
  if (view !== "web") {
    try {
      const t = require("./tui.js");
      const cli = require("./agentcli.js");
      const q = function (x) { return /[\s"]/.test(x) ? '"' + x + '"' : x; };
      /* ★ --url 钉死看哪个台子。ensureViewer 数的是 state.base 那个台子的观众数 ——
       *   弹出的窗若再走一遍全局发现(端口文件),文件恰好被别的实例(如 npm test 的
       *   一次性测试台)抢走时就会看错台子(实测:弹出的窗回放的是旧档案)。 */
      const line = q(process.execPath) + " " + q(path.join(__dirname, "tui.js")) +
        " watch --url " + q(base);
      const plan = t.newWindowCmd(process.platform, line, function (b) { return !!cli.which(b); });
      if (plan) {
        // windowsVerbatimArguments 跟 tui.js:openInNewWindow 保持一致 —— 没有 wt 时
        // newWindowCmd 会拼一条整串命令行给 cmd /c start,漏了这个选项在 Windows 上
        // node 路径带空格时新窗口起不来(实测过)。
        spawn(plan.cmd, plan.args, { detached: true, stdio: "ignore",
          windowsVerbatimArguments: !!plan.verbatim }).unref();
        return "tui";
      }
      log("没找到终端模拟器,直播退回浏览器");
    } catch (e) { log("弹终端直播失败(" + e.message + "),退回浏览器"); }
  }
  const cmd = process.platform === "win32" ? ["cmd", ["/c", "start", "", base]]
    : process.platform === "darwin" ? ["open", [base]] : ["xdg-open", [base]];
  try { spawn(cmd[0], cmd[1], { detached: true, stdio: "ignore" }).unref(); } catch (_) {}
  return "web";
}

const TOOLS = [
  {
    name: "loop_begin",
    description:
      "Start an adversarial loop. **The pre-start flow is orchestrated by a server-side state machine; " +
      "you are only the hands**: each reply gives you the instruction for the CURRENT step plus a one-time " +
      "token; follow it and call again with the token. Out-of-order or skipped steps bounce back to the " +
      "current step. Steps: goal -> config card -> confirm card -> start. " +
      "The first call may carry just task (if the user already stated the goal), or nothing.",
    inputSchema: {
      type: "object",
      properties: {
        session: { type: "string", description: "Display name of this loop (shown in the page header)" },
        repo: { type: "string" }, branch: { type: "string" },
        lang: {
          type: "string",
          description: "UI language for the observers (\"zh\"/\"en\"...): the language you are speaking " +
            "with the user. Omit to auto-detect from the task text."
        },
        goal: {
          type: "object",
          properties: {
            command: { type: "string", description: "Gate command, e.g. pytest -q or npm test" },
            cwd: { type: "string", description: "Directory to run it in; defaults to the console's cwd" },
            metric: {
              type: "object",
              description: "Optional. Capture one number from the command output and compare against a range.",
              properties: {
                name: { type: "string" },
                pattern: { type: "string", description: "Regex; first capture group is the number, " +
                  "e.g. coverage: ([0-9]+). Not used with source:\"say\"." },
                source: { type: "string", enum: ["say"],
                  description: "Where the value comes from. \"say\" = the critic/reviewer reports value via " +
                    "loop_say each round (the gate is a stop CONDITION, not necessarily a runnable command; " +
                    "the stop reason is reported separately as reported_met, lower trust than a command)." },
                min: { type: "number" }, max: { type: "number" }
              }
            },
            // metric.source==="say": e.g. "fix bugs until 3 consecutive clean rounds" =
            //   metric:{name:"new bugs",source:"say",max:0} + streak:3. Only critic/reviewer reports count -
            //   the proposer has every incentive to report 0.
            streak: {
              type: "number",
              description: "Optional. Require **N consecutive passing rounds** to count as met " +
                "(a miss resets the streak). Passing rounds during the streak are not counted as no-progress."
            }
          }
        },
        budget: {
          type: "object",
          description: "Hard limits. When exhausted, loop_gate returns continue:false and you must stop.",
          properties: {
            rounds: { type: "number", description: "Max rounds (default 8). 0 = **unlimited rounds** - " +
              "the time limit and no-progress gates still apply" },
            tokens: { type: "number", description: "Token budget; 0/omitted = **unlimited (preferred)**. " +
              "Counts only what is measurable (Claude Code subagent archives + loop_agent roles/judges; " +
              "the coordinator itself cannot be attributed) - a lower-bound gate" },
            seconds: { type: "number", description: "Max seconds (default 3600); 0 = unlimited" },
            noProgressRounds: { type: "number", description: "Stop after this many consecutive rounds " +
              "without metric progress (default 2)" }
          }
        },
        token: { type: "string", description: "One-time step token from the previous reply. Changes every " +
          "step; if lost, call without it to restart." },
        task: { type: "string", description: "The goal (submitted at step 1, or with the first call)" },
        go: { type: "boolean", description: "Step 3: the user chose Start on the confirm card" },
        revise: { type: "boolean", description: "Step 3: the user chose Change-one-thing; returns to the config card" },
        roles: {
          type: "array",
          description: "In speaking order. At least two (one proposing, one attacking) or it is not adversarial.",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Role name shown in the UI, in the user's language" },
              duty: { type: "string", description: "What this role is responsible for" },
              kind: { type: "string", enum: ["propose", "attack", "defend", "verdict", "patch", "test", "audit", "route"],
                description: "Tier; controls colors/labels in the UI" }
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
      "Record what a role said this round (proposal / rebuttal / patch / audit verdict). Call once after " +
      "each role speaks; it appears live on the page. summary = one-sentence conclusion, body = full reasoning.\n" +
      "Optionally attach tool (what tool was used and its result) and diff (file, +/- counts, line contents).\n" +
      "Never fabricate token usage. In Claude Code we read each subagent's own archive (real model, real usage); " +
      "on other hosts leave it out and the page will honestly show it as unavailable.",
    inputSchema: {
      type: "object",
      properties: {
        role: { type: "string", description: "Role id or name; must be registered in loop_begin" },
        value: { type: "number",
          description: "The number measured this round (e.g. bugs found). Required when the gate is " +
            "metric.source:\"say\" - only critic/reviewer reports count; proposer reports are ignored " +
            "(it has every incentive to report 0)" },
        summary: { type: "string", description: "One-sentence conclusion (shown on the collapsed row)" },
        body: { type: "string", description: "Full reasoning/content" },
        kind: { type: "string", enum: ["propose", "attack", "defend", "verdict", "patch", "test", "audit", "route"] },
        targets: { type: "array", items: { type: "string" }, description: "Which roles this addresses" },
        dur: { type: "string", description: "Elapsed, e.g. 12.7s" },
        tool: {
          type: "object",
          properties: { name: { type: "string" }, args: { type: "string" },
            result: { type: "string" }, status: { type: "string" }, ms: { type: "string" } }
        },
        diff: {
          type: "object",
          properties: {
            file: { type: "string" }, add: { type: "number" }, del: { type: "number" },
            lines: { type: "array", description: "Each line: { sign:'+'|'-'|'', text, ln }", items: { type: "object" } }
          }
        }
      },
      required: ["role", "summary"]
    }
  },
  {
    name: "loop_gate",
    description:
      "Run the gate and learn whether you may continue. **This is the only place that can rule the goal met - " +
      "you must not declare success yourself.**\n" +
      "Call once after all roles have spoken in a round. Returns met, value (captured metric), " +
      "output (command output tail), continue, and stopReason. continue:false means stop and loop_end.\n" +
      "When not met, carry the failure output back to the roles and start the next round.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "loop_status",
    description:
      "Read the current loop state: round number, rounds/seconds remaining, whether the gate has ever passed, " +
      "consecutive no-progress rounds, the role table, and (if ended) the stop reason.\n" +
      "When to call: unsure whether another round is allowed, resuming after an interruption, or reporting " +
      "progress to the user. Never estimate remaining budget from memory - these numbers are authoritative.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "loop_agent",
    description:
      "Run a role in a **standalone process** and wait for it - for hosts without subagents in chat (Codex etc.), " +
      "giving the role true isolation: its own session, chooseable model, and critics/reviewers read-only at the " +
      "tool layer.\n" +
      "In Claude Code, **do not use this** - use your own Task subagents " +
      "(forge-proposer / forge-critic / forge-reviewer).\n" +
      "role must be a name registered in loop_begin. prompt must be self-contained (goal, what others said this " +
      "round, last gate failure output) - the standalone process cannot see your conversation.\n" +
      "The result is **auto-loop_say-ed**; do not report it again. Use the returned text to decide the next step. " +
      "May run for minutes.",
    inputSchema: {
      type: "object",
      required: ["role", "prompt"],
      properties: {
        role: { type: "string", description: "Role name or id registered in loop_begin" },
        prompt: { type: "string", description: "Complete brief for this role (it cannot see your conversation)" },
        model: { type: "string", description: "Optional: model for this role (host default if omitted)" },
        agent: { type: "string", description: "Optional: which CLI hosts this role (claude/codex/...)" },
        timeoutMs: { type: "number", description: "Optional: silence duration counted as stalled, default 240000" }
      }
    }
  },
  {
    name: "loop_end",
    description:
      "Wrap up. reason is stopped (a human called it off) or abandoned (you judge it unworkable; say why in " +
      "detail).\n" +
      "NOTE: reason=goal_met is only accepted after loop_gate has actually ruled the goal met - otherwise it is " +
      "rejected. You normally never call this yourself: the loop auto-ends when the gate rules met or the budget " +
      "runs out.",
    inputSchema: {
      type: "object",
      properties: {
        reason: { type: "string", enum: ["stopped", "abandoned", "goal_met"] },
        detail: { type: "string", description: "One-sentence explanation, written into the archive" }
      }
    }
  }
];

/**
 * 拉起监控台并等它就绪。依赖全从外面注入,好单测。
 *
 * 两条实测踩过的坑,就靠这里两行:
 *   ① **每次轮询都重新发现一次端口**。base 是 spawn 之前算出来的(过期端口文件 / 兜底 4610),
 *      子进程真正绑上的可能是别的端口(4610 被占就 +1)。抱着旧 base 死等的结果是:
 *      控制台明明好好地起来了,却报「4 秒内没就绪」。
 *   ② **失败就把自己刚 spawn 的那个收掉**。它是 detached+unref 的,没人管;
 *      每失败一次就在机器上留一个占着端口的僵尸,下次更容易撞端口 → 恶性循环。
 *      只杀 spawnConsole 交回来的那个句柄 —— 别人的监控台不归我们处置。
 */
async function bringUpConsole(d) {
  let child = d.spawnConsole();
  let base = d.base;
  for (let i = 0; i < (d.tries || 46); i++) {
    // 头几拍问得密一点。server.js 实测 ~200ms 就绪,而固定 100ms 一拍的话
    // 「第一拍先睡 100ms」平均要多等半拍 —— 25ms×8 + 100ms×38 总预算还是 4 秒,
    // 但常见情况(一起就好)少等 ~100ms。开局那一下是有人在盯着的。
    await d.sleep(i < 8 ? 25 : 100);
    const rd = d.rediscover();
    if (rd && rd !== base) base = rd;
    if (await d.alive(base)) return { up: true, base: base, child: child };
  }
  if (child) { try { child.kill(); } catch (_) {} child = null; }
  return { up: false, base: base, child: child };
}

/**
 * 处理器与长活状态分离 —— 为了**热重载**。
 *
 * 这个进程由 coding agent 会话启动、一活一整天。以前每次改代码都要「重开会话生效」,
 * 实测用户连着几天打在昨天的代码上,以为修了没修(「还是弹 tui」×3)。
 * 现在 serve() 只留 stdio 框架;每条消息进来先看磁盘代码有没有更新,更新了就
 * 清 require 缓存、重建处理器 —— 长活状态(state)原样移交,改完即生效。
 */
function createHandler(state) {
  const explicitUrl = state.opts && state.opts.url;
  if (!state.base) state.base = discoverBase(explicitUrl);


  function log(s) { process.stderr.write("[code-forge] " + s + "\n"); }
  function send(msg) { process.stdout.write(JSON.stringify(msg) + "\n"); }
  function ok(id, result) { send({ jsonrpc: "2.0", id: id, result: result }); }
  function failRpc(id, code, message) { send({ jsonrpc: "2.0", id: id, error: { code: code, message: message } }); }
  function reply(id, obj, isError) {
    ok(id, { content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }],
      isError: !!isError });
  }

  const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  async function alive(at) {
    try {
      const res = await fetch((at || state.base) + "/health");
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
      log("连不上 " + state.base + "（--url 指定的地址,不自动拉起）");
      return false;
    }
    // 端口文件可能是上次留下的死记录 —— 重查一次,别抱着一个连不上的地址去拉新进程
    const rediscovered = discoverBase(null);
    if (rediscovered !== state.base) {
      state.base = rediscovered;
      if (await alive()) { log("监控台在 " + state.base); return true; }
    }
    const r = await bringUpConsole({
      base: state.base, sleep: sleep, tries: 46,        // 25ms×8 + 100ms×38 = 最多等 4 秒
      alive: alive,
      rediscover: function () { return discoverBase(null); },
      spawnConsole: function () {
        if (state.consoleChild) return state.consoleChild;
        log("监控台没在跑,正在拉起…");
        // ⚠ --no-open:弹什么由下面 openView 定(默认终端直播),server 自己别抢着开浏览器
        state.consoleChild = spawn(process.execPath, [path.join(__dirname, "server.js"), "--no-open"], {
          detached: true, stdio: "ignore"
        });
        state.consoleChild.unref();
        return state.consoleChild;
      }
    });
    state.base = r.base;                                 // bringUpConsole 返回的是 { up, base, child } —— 没有 state 字段
    state.consoleChild = r.child;                        // 失败时 bringUpConsole 已把它杀掉并置空
    if (r.up) {
      log("监控台已就绪 " + state.base);
      return true;
    }
    log("监控台没能在 4 秒内就绪（已收掉刚拉起的那个,免得留下占端口的僵尸）");
    return false;
  }

  // ⚠ 内部 fetch 撞 Node 内置 undici 的默认 headersTimeout=300s:loop_agent/loop_gate
  // 常跑超 5 分钟,一撞就报假失败(UND_ERR_HEADERS_TIMEOUT)并被上层重试。
  // 真正的修法是拿到 undici 的 Agent 把 headersTimeout/bodyTimeout 设成 0 再
  // setGlobalDispatcher/per-request dispatcher —— 但这要求能 require("undici")。
  // 实测过:这个仓库不装 undici 依赖(零依赖),裸 node_modules 下 require("undici")
  // 直接 MODULE_NOT_FOUND;Node 内置 fetch 也不对外暴露任何配置 dispatcher 超时的
  // 公开 API。所以下面这段**不能真正解除 300s 限制** —— 只是在环境里恰好能
  // require 到 undici(比如它被别的包提到了 node_modules 顶层)时顺手用上,
  // 多数安装不会有这个包,那时超 300s 的判据/agent 调用依然会被 UND_ERR_HEADERS_TIMEOUT
  // 打断。AbortSignal.timeout(3600000) 只是给单个请求加一道 1 小时的兜底中止点,
  // 跟 headersTimeout 是两件事,加了它也挡不住 300s 那次假失败。
  // 不加依赖前提下从客户端侧无法根治 —— 真正的根治点在服务端:改成异步执行 +
  // 轮询/SSE 取结果,不要把 HTTP 响应挂在长任务结束上;这是架构改动,本轮不做。
  let noTimeoutDispatcher;
  try {
    const { Agent } = require("undici");
    noTimeoutDispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
  } catch (_) { noTimeoutDispatcher = null; }
  async function api(path, init) {
    init = init || {};
    if (noTimeoutDispatcher) {
      init = Object.assign({}, init, { dispatcher: noTimeoutDispatcher });
    } else if (!init.signal) {
      init = Object.assign({}, init, { signal: AbortSignal.timeout(3600000) }); // 不解决 300s 假失败,只挡「真正卡死」的极端情况
    }
    const res = await fetch(state.base + path, init);
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
      /**
       * 开跑时保证**有人在看**。以前只在「刚拉起监控台」时弹直播窗口 —— 而监控台是
       * 常驻进程,第二次开跑它早就在跑,窗口就永远不弹了(实测:「聊天里启动完全看不到 tui」)。
       * 正确的判据是**观众数**:/health 的 clients = SSE 连接数(直播窗口和网页都算)。
       * 没人看才弹;有人看就别再糊一个窗口。CODE_FORGE_VIEW=none 仍可关掉。
       */
      async function ensureViewer() {
        try {
          /* ★ 双闸。②是实测反馈加的:弹出的窗若只能回放**已停止的旧回环**,
           *   用户会以为「旧回环还在跑/又被跑了一遍」。这里只在 begin 成功后调,
           *   active 本该必真 —— 但把闸放进代码里,将来谁在别处误调也弹不出误导窗。 */
          const s = await api("/host/status");
          if (!(s.ok && s.body && s.body.active)) {
            log("台子上没有进行中的回环,不弹直播(弹出去只能回放旧档案)");
            return;
          }
          const r = await api("/health");
          if (r.ok && (r.body.clients || 0) === 0) log("直播 → " + openView(state.base, log));
          else log("已有 " + ((r.body && r.body.clients) || 0) + " 个观众在看,不再弹窗");
        } catch (_) { /* 看不了观众数就不弹 —— 弹错比不弹更烦 */ }
      }


      if (name === "loop_begin") {
        /* ★ 开跑前的流程由**这里的状态机**编排,模型只当手(用户指令:「整个流程顺序要
         * 机械化,不能由大模型自己编排」)。改过三版的教训:
         *   ①流程写在提示词里 → 模型跳过配置卡;②布尔硬闸 → 模型自我盖章;
         *   ③一次性确认码 → 模型还是可能把码和流程一起绕。
         * 现在:每次回复只发**当前这一步**的指令 + 一次性 token;乱序/跳步/错 token
         * 一律弹回当前步。连确认卡的小结文案都是服务端拼的 —— 模型没有可编排的东西。
         *
         * 步骤:task(目标) → config(判据/模型/预算) → confirm(用户点开跑) → 开局。 */
        const tok = () => "st-" + Math.random().toString(36).slice(2, 10);
        const taskOk = (t) => {
          let w = 0;
          for (const ch of String(t || "").replace(/\s+/g, "")) w += ch.charCodeAt(0) > 0x2e7f ? 2 : 1;
          return w >= 4;
        };
        /* ★ UI 语言跟随用户(用户点名:提示词全英文,UI 文字按对话语言)。
         *   目标文本里有 CJK 就当 zh,否则 en;协调者也可显式传 lang 覆盖。
         *   lang 随 cfg 进 /host/begin → run.start 事件 → TUI/网页按它取词典。 */
        const langOf = (t) => /[぀-ヿ一-鿿]/.test(String(t || "")) ? "zh" : "en";

        // 没带 token / token 不对 → 从头(或回到当前步:把当前步指令原样再发一遍)
        if (!state.setup || !args.token || args.token !== state.setup.token) {
          // 首调可以顺路带 task(用户在 /code-forge 后面写了目标) —— 顺序不变,只是省一回合
          if (!state.setup || !args.token) {
            if (taskOk(args.task)) {
              state.setup = { stage: "config", token: tok(), task: String(args.task).trim(),
                lang: args.lang || langOf(args.task) };
              return reply(id, configInstruction(state.setup), true);
            }
            state.setup = { stage: "task", token: tok() };
            return reply(id, {
              step: "1/3 goal",
              instruction: "This turn, do exactly one thing: wait for the user to state the goal. " +
                "If the conversation just discussed a concrete problem, use AskUserQuestion with 1-2 candidate goals; " +
                "otherwise output a single line asking what to do (in the user's language), then stop. " +
                "Scanning the repo, configuring, or starting the loop is forbidden until the goal is set.",
              then: "Call loop_begin again with { token, task }.",
              token: state.setup.token
            }, true);
          }
          return reply(id, { error: "Wrong token (it changes every step). You are currently at step " +
            ({ task: "1/3 goal", config: "2/3 config", confirm: "3/3 confirm" })[state.setup.stage] +
            "; use the token from the previous reply. If you lost it, call again without a token to restart." }, true);
        }

        function configInstruction(st) {
          const wantStreak =
            /连续\s*\d+\s*轮|直到.*(为\s*0|清零|挖不出|干净)|\bconsecutive\b|\buntil\b.*\b(clean|zero|none|no new)\b/i
              .test(st.task);
          return {
            step: "2/3 config",
            goal_set: st.task,
            instruction: "Show the config card (AskUserQuestion, in the user's language; recommended option first " +
              "in every question, so plain Enter = all defaults). Ask exactly these questions, no additions/removals/reordering:",
            q1_gate: "Look at the repo WITH the goal in mind and offer 2-4 candidate commands " +
              "(only commands that really exist; goal-relevant ones first). If no command can measure it, " +
              "use metric.source:\"say\" (role-reported, e.g. \"new bugs found\"); only if truly unquantifiable, use a rubric.",
            q2_models: "Recommended assignment (Recommended; spell out proposer X / critic Y / reviewer Z) " +
              "/ all-strongest / all-cheapest / pick per role (then show one more card)",
            q3_rounds: "8 (Recommended) / unlimited (rounds:0) / 3 (quick) - Other for custom",
            q4_time: "3600s (Recommended) / 7200s" +
              (wantStreak ? ". The goal mentions consecutive rounds - you MUST also ask a streak question " +
                "(recommended = the N in the goal)" : ""),
            q5_token_budget: "Unlimited (Recommended) / 500k / 200k - Other for custom. " +
              "Counts only what is measurable (Claude Code subagent archives; the coordinator itself cannot be attributed).",
            then: "Call loop_begin again with { token, goal, budget, roles } " +
              "(at least two roles; kind is propose/attack/audit).",
            token: st.token
          };
        }

        if (state.setup.stage === "config") {
          // 顺路允许在 task 步之后直接交 config?不允许 —— 上面 token 校验已保证只能按步走
          const g = args.goal || {};
          const b = args.budget || {};
          const roles = Array.isArray(args.roles) ? args.roles : [];
          const gateOk = !!(g.command || (g.metric && g.metric.source === "say") ||
            (g.rubric && String(g.rubric).trim()));
          const missing = [
            gateOk ? null : "goal(command / metric.source:\"say\" / rubric 三选一)",
            typeof b.rounds === "number" ? null : "budget.rounds(0=不限)",
            typeof b.seconds === "number" && b.seconds > 0 ? null : "budget.seconds",
            roles.length >= 2 ? null : "roles(至少实现者+反驳者)",
            roles.length >= 2 && roles.some(function (r) { return !r.model; })
              ? "roles[*].model(模型题的结果要落到每个角色上 —— 不落,观察面只能显示「宿主模型」占位)"
              : null
          ].filter(Boolean);
          if (missing.length) {
            return reply(id, Object.assign(configInstruction(state.setup),
              { missing: missing,
                note: "Submit only after every config question was asked; a missing field means a question was skipped." }),
              true);
          }
          /* 服务端拼小结 —— 确认卡上摆什么由这里定,模型原样展示。
           * ★ 小结是**给用户看的**,按 setup.lang 出词;指令本身照旧全英文。 */
          const zh = (state.setup.lang || "zh") === "zh";
          const mtx = g.metric && g.metric.name
            ? (zh ? "，指标 " : ", metric ") + g.metric.name +
              (g.metric.min != null ? " ≥ " + g.metric.min : "") +
              (g.metric.max != null ? " ≤ " + g.metric.max : "")
            : "";
          const gateTxt = g.command ? (zh ? "命令 " : "command ") + g.command + mtx
            : g.metric && g.metric.source === "say"
              ? (zh ? "角色上报 " : "role-reported ") + (g.metric.name || (zh ? "指标" : "metric")) +
                (g.metric.max != null ? " ≤ " + g.metric.max : "") +
                (g.metric.min != null ? " ≥ " + g.metric.min : "")
            : (zh ? "评审 rubric" : "judge rubric");
          const summary = zh ? [
            "目标  " + state.setup.task,
            "判据  " + gateTxt + (g.streak > 1 ? "（连续 " + g.streak + " 轮判过才算达标）" : ""),
            "角色  " + roles.map((r) => r.name + (r.model ? "(" + r.model + ")" : "")).join(" · "),
            "预算  " + (b.rounds === 0 ? "不限轮" : b.rounds + " 轮") + " / " + b.seconds + "s" +
              (b.noProgressRounds != null ? " / 零进展 " + b.noProgressRounds + " 轮停" : "")
          ].join("\n") : [
            "Goal    " + state.setup.task,
            "Gate    " + gateTxt + (g.streak > 1 ? " (" + g.streak + " consecutive passing rounds required)" : ""),
            "Roles   " + roles.map((r) => r.name + (r.model ? "(" + r.model + ")" : "")).join(" · "),
            "Budget  " + (b.rounds === 0 ? "unlimited rounds" : b.rounds + " rounds") + " / " + b.seconds + "s" +
              (b.noProgressRounds != null ? " / stop after " + b.noProgressRounds + " no-progress rounds" : "")
          ].join("\n");
          state.setup = { stage: "confirm", token: tok(), task: state.setup.task, lang: state.setup.lang,
            cfg: Object.assign({}, args, { task: state.setup.task, lang: state.setup.lang,
              session: args.session || state.setup.task.slice(0, 60) }) };
          return reply(id, {
            step: "3/3 confirm",
            instruction: "Show the summary below to the user **verbatim**, then ask once via AskUserQuestion " +
              "(in the user's language): start as configured? Options: Start (Recommended) / Change one thing / Cancel.",
            summary: summary,
            on_start: "Call loop_begin again with { token, go: true }.",
            on_change: "Call loop_begin again with { token, revise: true } to return to the config card.",
            token: state.setup.token
          }, true);
        }

        if (state.setup.stage === "confirm") {
          if (args.revise) {
            state.setup = { stage: "config", token: tok(), task: state.setup.task, lang: state.setup.lang };
            return reply(id, configInstruction(state.setup), true);
          }
          if (!args.go) {
            return reply(id, { error: "The confirm step accepts only { go: true } (user chose Start) " +
              "or { revise: true } (change one thing). If the user chose Cancel, stop calling." }, true);
          }
          /* ★ 把**你干活的那个目录**带过去。子 agent 的档案是按目录分的
           *   (~/.claude/projects/<cwd 转成的名字>/),而监控台可能是从别处起的 ——
           *   不带这一项,它就照自己的目录去找,一条档案都找不到,角色行又回到「不可得」。 */
          const cfg = Object.assign({ cwd: process.cwd() }, state.setup.cfg);
          state.setup = null;   // 用掉即弃 —— 开局失败也从头走,别留半截状态
          const up = await ensureConsole();
          if (!up) {
            return reply(id, "Could not start the console. Diagnose manually: `node " +
              path.join(__dirname, "server.js") +
              " web --no-open` (bare run only prints guidance; the `web` subcommand is required); " +
              "or use --url to point at one already running.", true);
          }
          const r = await post("/host/begin", cfg);
          if (!r.ok) return reply(id, r.body, true);
          await ensureViewer();
          return reply(id, Object.assign({ console: state.base }, r.body,
            { protocol: "Call loop_say after each role speaks; call loop_gate at the end of each round; " +
              "when it returns continue:false, stop." }));
        }

        // stage === "task":收目标
        if (!taskOk(args.task)) {
          return reply(id, { error: "The goal is not established yet (too short/vague). Ask the user to clarify - " +
            "gate candidates are chosen from the goal.", token: state.setup.token }, true);
        }
        state.setup = { stage: "config", token: tok(), task: String(args.task).trim(),
          lang: args.lang || langOf(args.task) };
        return reply(id, configInstruction(state.setup), true);
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
      if (name === "loop_agent") {
        const r = await post("/host/agent", args);
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


  return { handle: handle };
}

function serve(opts) {
  const state = { opts: opts, base: null, setup: null, consoleChild: null };
  const MODS = ["./mcp.js", "./hostrun.js", "./perrole.js", "./adapters.js",
    "./agentcli.js", "./usage.js", "./gate.js", "./judge.js"];
  const stamp = function () {
    return MODS.reduce(function (mx, m) {
      try { return Math.max(mx, fs.statSync(path.join(__dirname, m)).mtimeMs); }
      catch (_) { return mx; }
    }, 0);
  };
  let loaded = stamp();
  let handler = createHandler(state);
  function maybeReload() {
    const cur = stamp();
    if (cur <= loaded) return;
    try {
      MODS.forEach(function (m) {
        try { delete require.cache[require.resolve(m)]; } catch (_) {}
      });
      handler = require("./mcp.js").createHandler(state);
      loaded = cur;
      process.stderr.write("[code-forge] 磁盘代码更新,已热重载（不必重开会话）" + String.fromCharCode(10));
    } catch (e) {
      // 热重载失败不许把会话搞死 —— 继续用旧代码,并把原因说出来
      process.stderr.write("[code-forge] 热重载失败,继续用旧代码: " + e.message + String.fromCharCode(10));
      loaded = cur;   // 别每条消息都重试一遍失败
    }
  }

  let buf = "";
  const failRaw = function (id, message) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: id,
      error: { code: -32603, message: message } }) + String.fromCharCode(10));
  };
  process.stdin.setEncoding("utf8"); // 不设的话跨 64KB 块的中文会被硬切成 U+FFFD
  process.stdin.on("data", function (chunk) {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf(String.fromCharCode(10))) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); }
      catch (e) { process.stderr.write("[code-forge] 无法解析的一行,已跳过" + String.fromCharCode(10)); continue; }
      maybeReload();
      try { handler.handle(msg); }
      catch (e) { if (msg.id !== undefined) failRaw(msg.id, String(e.message)); }
    }
  });
  process.stdin.on("end", function () { process.exit(0); });
  process.stderr.write("[code-forge] MCP server on stdio · 监控台 " +
    (state.base || discoverBase(opts && opts.url)) + "（宿主执行,零 key,支持热重载）" + String.fromCharCode(10));
}

module.exports = { serve: serve, createHandler: createHandler, TOOLS: TOOLS, openView: openView, bringUpConsole: bringUpConsole };
