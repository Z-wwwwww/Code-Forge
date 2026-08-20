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
      "开一局对抗回环。**流程由这里的状态机编排,你只当手**:每次回复只给当前这一步的指令和" +
      "一次性 token,照做后带 token 重调;乱序/跳步会被弹回当前步。步骤:目标 → 配置卡 → 确认卡 → 开局。" +
      "第一次调可以只带 task(用户已给目标时),或什么都不带。",
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
                pattern: { type: "string", description: "正则,第一个捕获组当数字,如 coverage: ([0-9]+)（source:say 时不用）" },
                source: { type: "string", enum: ["say"],
                  description: "值从哪来。say = 反驳者/复核者每轮 loop_say 带 value 上报（判据是停止条件,不必是可执行命令;停止原因单列 reported_met,可信度低于命令）" },
                source: { type: "string", enum: ["say"],
                  description: "值从哪来。\"say\" = 反驳者/复核者每轮 loop_say 带 value 上报" +
                    "（判据是停止条件,不必是可执行命令;停止原因会单列「角色上报」,可信度低于命令）" },
                min: { type: "number" }, max: { type: "number" }
              }
            },
            // metric.source==="say":判据是**停止条件**,不必是可执行命令。
            // 值由反驳者/复核者每轮 loop_say 带 value 上报(实现者报的不算,它有动机报 0)。
            // 例:「修 bug 直到连续 3 轮挖不出新 bug」= metric:{name:"新bug数",source:"say",max:0} + streak:3
            // metric.source==="say":判据是**停止条件**,不必是可执行命令。
            // 值由反驳者/复核者每轮 loop_say 带 value 上报(实现者报的不算,它有动机报 0)。
            // 例:「修 bug 直到连续 3 轮挖不出新 bug」= metric:{name:"新bug数",source:"say",max:0} + streak:3
            streak: {
              type: "number",
              description: "可选。要求**连续 N 轮**判过才算达标(断一次从头攒)。" +
                "对应「修 bug 直到连续 3 轮挖不出新 bug」这类判据;期间判过的轮不计零进展。"
            }
          }
        },
        budget: {
          type: "object",
          description: "硬闸。到顶时 loop_gate 会回 continue:false,你必须停手。",
          properties: {
            rounds: { type: "number", description: "最多几轮(默认 8)。0 = **不限轮数** —— 时限与零进展闸门仍然生效" },
            tokens: { type: "number", description: "token 预算,0/不填 = **不限(首选)**。只计量得到的部分" +
              "(Claude Code 子 agent 档案 + loop_agent 派的角色/评审者报的账;协调者本人摊不出来)—— 这是个下界闸" },
            seconds: { type: "number", description: "最长多少秒(默认 3600)" },
            noProgressRounds: { type: "number", description: "指标连续几轮不进步就停(默认 2)" }
          }
        },
        token: { type: "string", description: "上一条回复发的一次性步骤码。每步都换;丢了就不带,从头走。" },
        task: { type: "string", description: "目标(第 1 步交,或首调顺路带)" },
        go: { type: "boolean", description: "第 3 步:用户在确认卡选了「开跑」" },
        revise: { type: "boolean", description: "第 3 步:用户选了「再改一项」,回到配置卡" },
        roles: {
          type: "array",
          description: "按发言顺序排。至少两个(一个提议、一个反驳)才叫对抗。",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "角色名,如 实现者 / 反驳者 / 安全审查" },
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
      "token 不要编。Claude Code 里子 agent 的账**我们自己从它的档案里读**(模型也是真的);" +
      "别的宿主报不出就留空,页面会如实标。",
    inputSchema: {
      type: "object",
      properties: {
        role: { type: "string", description: "角色 id 或名字,必须是 loop_begin 里登记过的" },
        value: { type: "number",
          description: "本轮量出来的数(如挖到的 bug 数)。判据是 metric.source:say 时必带 —— 只有反驳者/复核者报的算数,实现者报的会被忽略(它有动机报 0)" },
        value: { type: "number",
          description: "本轮量出来的数(如挖到的 bug 数)。判据是 metric.source:\"say\" 时必带 ——" +
            "只有反驳者/复核者报的算数,实现者报的会被忽略(它有动机报 0)" },
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
    name: "loop_agent",
    description:
      "把一个角色派到**独立进程**里跑并等它做完 —— 给聊天里没有子 agent 的宿主(Codex 等)用,\n" +
      "让角色获得真隔离:独立会话、可指定模型、反驳者/复核者在工具层就是只读。\n" +
      "Claude Code 里**别用这个**,用你自己的 Task 子 agent(forge-proposer / forge-critic / forge-reviewer)。\n" +
      "role 必须是 loop_begin 登记过的名字。prompt 要自带全部上下文(目标、这一轮别人说了什么、\n" +
      "判据上次的失败输出) —— 独立进程看不见你的对话。\n" +
      "结果会**自动 loop_say**,不必再报;返回的 text 用来决定下一步。可能要跑几分钟。",
    inputSchema: {
      type: "object",
      required: ["role", "prompt"],
      properties: {
        role: { type: "string", description: "loop_begin 登记过的角色名或 id" },
        prompt: { type: "string", description: "给这个角色的完整任务书(它看不见你的对话)" },
        model: { type: "string", description: "可选:这个角色用什么模型(不给就用宿主默认)" },
        agent: { type: "string", description: "可选:用哪个 CLI 当这个角色的宿主(claude/codex/…)" },
        timeoutMs: { type: "number", description: "可选:无输出多久算卡住,默认 240000" }
      }
    }
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
  for (let i = 0; i < (d.tries || 40); i++) {
    await d.sleep(100);
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
      base: state.base, sleep: sleep, tries: 40,        // 最多等 4 秒
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

        // 没带 token / token 不对 → 从头(或回到当前步:把当前步指令原样再发一遍)
        if (!state.setup || !args.token || args.token !== state.setup.token) {
          // 首调可以顺路带 task(用户在 /code-forge 后面写了目标) —— 顺序不变,只是省一回合
          if (!state.setup || !args.token) {
            if (taskOk(args.task)) {
              state.setup = { stage: "config", token: tok(), task: String(args.task).trim() };
              return reply(id, configInstruction(state.setup), true);
            }
            state.setup = { stage: "task", token: tok() };
            return reply(id, {
              步骤: "1/3 目标",
              指令: "这一回合只做一件事:等用户输入目标(对话里刚讨论过具体问题就用 AskUserQuestion 摆 1~2 条候选;否则一行「目标：要做什么？」然后停)。禁止扫仓库/配置/开局。",
              然后: "带 { token, task } 重调 loop_begin。",
              token: state.setup.token
            }, true);
          }
          return reply(id, { error: "token 不对(每一步都换)。当前停在第 " +
            ({ task: "1/3 目标", config: "2/3 配置", confirm: "3/3 确认" })[state.setup.stage] +
            " 步,用上一条回复里的 token。丢了就不带 token 重调,从头走。" }, true);
        }

        function configInstruction(st) {
          const wantStreak = /连续\s*\d+\s*轮|直到.*(为\s*0|清零|挖不出|干净)/.test(st.task);
          return {
            步骤: "2/3 配置",
            目标已立: st.task,
            指令: "出配置卡(AskUserQuestion,每题推荐排第一,用户一路回车=全默认)。题目按下面出,不许增删改序:",
            题1_判据: "带着目标看一眼仓库给 2~4 条候选命令(只提议真实存在的;与目标相关的排前面)。" +
              "没有命令能判的量给 metric.source:\"say\"(角色上报,如「挖到的 bug 数」);完全不可量化才用 rubric。",
            题2_模型: "推荐分配 (Recommended,写明 实现者X·反驳者Y·复核者Z) / 全用最强 / 全用最省 / 逐角色挑(选它再出一卡)",
            题3_轮数: "8 (Recommended) / 不限(rounds:0) / 3(快速) —— Other 自填",
            题5_token预算: "不限 (Recommended) / 500k / 200k —— Other 自填。" +
              "只计量得到的部分(Claude Code 子 agent 的账我们读得到;协调者本人摊不出来)",
            题4_时限: "3600s (Recommended) / 7200s" +
              (wantStreak ? "。目标里有「连续 N 轮」——**必须**再出 streak 一题(推荐=目标里的 N)" : ""),
            然后: "带 { token, goal, budget, roles } 重调 loop_begin(roles 至少两个;kind 用 propose/attack/audit)。",
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
              { 缺: missing, 注意: "配置卡答完才许交;缺的字段说明有题没问。" }), true);
          }
          // 服务端拼小结 —— 确认卡上摆什么由这里定,模型原样展示
          const mtx = g.metric && g.metric.name
            ? "，指标 " + g.metric.name +
              (g.metric.min != null ? " ≥ " + g.metric.min : "") +
              (g.metric.max != null ? " ≤ " + g.metric.max : "")
            : "";
          const gateTxt = g.command ? "命令 " + g.command + mtx
            : g.metric && g.metric.source === "say"
              ? "角色上报 " + (g.metric.name || "指标") +
                (g.metric.max != null ? " ≤ " + g.metric.max : "") +
                (g.metric.min != null ? " ≥ " + g.metric.min : "")
            : "评审 rubric";
          const summary = [
            "目标  " + state.setup.task,
            "判据  " + gateTxt + (g.streak > 1 ? "（连续 " + g.streak + " 轮判过才算达标）" : ""),
            "角色  " + roles.map((r) => r.name + (r.model ? "(" + r.model + ")" : "")).join(" · "),
            "预算  " + (b.rounds === 0 ? "不限轮" : b.rounds + " 轮") + " / " + b.seconds + "s" +
              (b.noProgressRounds != null ? " / 零进展 " + b.noProgressRounds + " 轮停" : "")
          ].join("\n");
          state.setup = { stage: "confirm", token: tok(), task: state.setup.task,
            cfg: Object.assign({}, args, { task: state.setup.task, session: args.session || state.setup.task.slice(0, 60) }) };
          return reply(id, {
            步骤: "3/3 确认",
            指令: "把下面的小结**原样**摆给用户,然后 AskUserQuestion 问一次:「就这么开跑？」" +
              "选项: 开跑 (Recommended) / 再改一项 / 取消。",
            小结: summary,
            用户选开跑: "带 { token, go: true } 重调 loop_begin。",
            用户选再改: "带 { token, revise: true } 重调,会回到配置卡。",
            token: state.setup.token
          }, true);
        }

        if (state.setup.stage === "confirm") {
          if (args.revise) {
            state.setup = { stage: "config", token: tok(), task: state.setup.task };
            return reply(id, configInstruction(state.setup), true);
          }
          if (!args.go) {
            return reply(id, { error: "确认步只认 { go: true }(用户选了开跑)或 { revise: true }(再改一项)。" +
              "用户选「取消」就别再调了。" }, true);
          }
          /* ★ 把**你干活的那个目录**带过去。子 agent 的档案是按目录分的
           *   (~/.claude/projects/<cwd 转成的名字>/),而监控台可能是从别处起的 ——
           *   不带这一项,它就照自己的目录去找,一条档案都找不到,角色行又回到「不可得」。 */
          const cfg = Object.assign({ cwd: process.cwd() }, state.setup.cfg);
          state.setup = null;   // 用掉即弃 —— 开局失败也从头走,别留半截状态
          const up = await ensureConsole();
          if (!up) {
            return reply(id, "起不了监控台。手动诊断：`node " + path.join(__dirname, "server.js") +
              " web --no-open`（裸跑只打指引,要带 web）;或用 --url 指向已经在跑的那个。", true);
          }
          const r = await post("/host/begin", cfg);
          if (!r.ok) return reply(id, r.body, true);
          await ensureViewer();
          return reply(id, Object.assign({ console: state.base }, r.body,
            { 协议: "每个角色发言后调 loop_say;一轮结束调 loop_gate;continue:false 就停手。" }));
        }

        // stage === "task":收目标
        if (!taskOk(args.task)) {
          return reply(id, { error: "目标还没立住(太短/太含糊)。问清楚再来 —— 判据候选是按目标挑的。",
            token: state.setup.token }, true);
        }
        state.setup = { stage: "config", token: tok(), task: String(args.task).trim() };
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
