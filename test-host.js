"use strict";
/**
 * 宿主驱动模式的自测(默认模式)。零 key、不联网、不发一次模型调用。
 *   node test-host.js
 *
 * 钉住的核心是那条**拒绝**:gate 没判过达标时,宿主不许以 goal_met 收工。
 * 那条拒绝是这一层存在的全部理由 —— 它一旦失效,整个工具就退化成一个记事本。
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

let pass = 0;
function ok(n) { pass++; console.log("  ✓ " + n); }

// model 必带:配置卡模型题的结果要落到每个角色上,向导校验会拦没带的(用户实测:
// 不落的话观察面只能显示「宿主模型」占位,看起来就是「没有模型名字」)
const ROLES = [
  { name: "实现者", kind: "propose", duty: "提最小改动", model: "sonnet" },
  { name: "反驳者", kind: "attack", duty: "只找反例", model: "opus" },
  { name: "复核者", kind: "audit", duty: "判绿后复核", model: "sonnet" }
];

/* ---------------- 状态机(纯函数级) ---------------- */
async function testStateMachine() {
  console.log("hostrun — 协议与拒绝");
  const events = [];
  const host = require("./hostrun.js").create(function (e) { events.push(e); });
  const suite = path.join(os.tmpdir(), "cf-host-suite-" + process.pid + ".js");
  const covFile = path.join(os.tmpdir(), "cf-host-cov-" + process.pid + ".txt");
  fs.writeFileSync(suite,
    "const fs=require('fs'),p=" + JSON.stringify(covFile) + ";" +
    "let v=0;try{v=parseInt(fs.readFileSync(p,'utf8'),10)||0}catch(e){}" +
    "v+=30;fs.writeFileSync(p,String(v));console.log('coverage: '+v+'%');process.exit(v>=80?0:1);");
  const goal = {
    command: JSON.stringify(process.execPath) + " " + JSON.stringify(suite),
    metric: { name: "覆盖率", pattern: "coverage: ([0-9]+)", min: 80 }
  };

  // say / gate 在 begin 之前必须拒
  assert.ok(host.say({ role: "实现者", summary: "x" }).error);
  assert.ok((await host.gate()).error);
  ok("没 begin 就 say/gate → 拒绝(不静默建一个隐形回环)");

  assert.ok(host.begin({ roles: [] }).error);
  ok("零角色 → 拒绝");

  const b = host.begin({ session: "宿主测试", goal: goal, budget: { rounds: 5, seconds: 600, noProgressRounds: 3 }, roles: ROLES });
  assert.strictEqual(b.round, 1);
  assert.strictEqual(b.gateConfigured, true);
  assert.strictEqual(events.filter(function (e) { return e.t === "role.add"; }).length, 4, "三个角色 + 判据");
  assert.ok(events.some(function (e) { return e.t === "run.start" && e.mode === "host"; }));
  assert.ok(events.some(function (e) { return e.t === "round.start" && e.n === 1; }));
  ok("begin 开局:登记角色(含判据)并开第 1 轮");

  assert.ok(host.begin({ roles: ROLES }).error);
  ok("已有回环在跑时再 begin → 拒绝");

  // ★ 核心:gate 没判过之前,不许自称达标
  const cheat = host.end("goal_met", "我觉得改好了");
  assert.ok(cheat.error, "必须拒绝");
  assert.ok(/the gate has not ruled the goal met/.test(cheat.error));
  assert.ok(host.status().active, "被拒之后回环必须还在跑,不能被这一下带停");
  ok("★ gate 没判过就说 goal_met → 拒绝,且回环继续（这是整层存在的理由）");

  // 角色名不在表里 → 拒(否则页面上会长出一个没登记的角色)
  assert.ok(host.say({ role: "不存在的人", summary: "x" }).error);
  ok("不在角色表里的 role → 拒绝");

  const said = host.say({ role: "实现者", summary: "加唯一索引", body: "详细理由…" });
  assert.strictEqual(said.recorded, true);
  const ev = events.filter(function (e) { return e.t === "event"; }).pop();
  assert.strictEqual(ev.role, "role1", "名字要归一成 id");
  assert.strictEqual(ev.tok, null, "宿主执行:用量拿不到就留 null,不许写 0");
  assert.strictEqual(ev.meta.executor, "host");
  ok("say 记一条事件,用量留 null（不写 0 = 不记假账）");

  // 第 1 轮:30% → 未达标,continue
  let v = await host.gate();
  assert.strictEqual(v.met, false);
  assert.strictEqual(v.value, 30);
  assert.strictEqual(v["continue"], true);
  assert.strictEqual(v.nextRound, 2);
  assert.ok(events.some(function (e) { return e.t === "round.end" && e.n === 1; }));
  assert.ok(events.some(function (e) { return e.t === "round.start" && e.n === 2; }));
  ok("未达标 → continue:true 并自动开下一轮");

  const gateEv = events.filter(function (e) { return e.t === "event" && e.role === "gate"; }).pop();
  assert.strictEqual(gateEv.tok.in + gateEv.tok.out, 0);
  assert.strictEqual(gateEv.meta.executor, "code");
  ok("判据事件零 token,标明 executor=code");

  // 第 2 轮:60% → 仍未达标(有进展,不该记零进展)
  v = await host.gate();
  assert.strictEqual(v.value, 60);
  assert.strictEqual(v.noProgressRounds, 0, "指标在涨,零进展计数必须归零");
  ok("指标在涨 → 零进展计数归零");

  // 第 3 轮:90% → 达标,自动收工
  v = await host.gate();
  assert.strictEqual(v.met, true);
  assert.strictEqual(v["continue"], false);
  assert.strictEqual(v.stopReason, "goal_met");
  assert.strictEqual(host.status().active, false, "达标后必须自动收工");
  const end = events.filter(function (e) { return e.t === "run.end"; }).pop();
  assert.strictEqual(end.reason, "goal_met");
  ok("达标 → 自动收工,run.end 记 goal_met");

  // 达标之后 goal_met 才被接受(此时已经结束,所以回「没有在进行的回环」)
  assert.ok(host.end("goal_met").error);
  ok("已经结束后再 end → 拒绝");

  fs.unlinkSync(suite); try { fs.unlinkSync(covFile); } catch (_) {}
}

/* ---------------- 停止原因 ---------------- */
async function testStops() {
  console.log("hostrun — 停止原因");
  const mk = function () {
    const events = [];
    return { events: events, host: require("./hostrun.js").create(function (e) { events.push(e); }) };
  };
  const failing = { command: JSON.stringify(process.execPath) + " -e \"console.log('coverage: 40%');process.exit(1)\"",
    metric: { name: "覆盖率", pattern: "coverage: ([0-9]+)", min: 80 } };

  let m = mk();
  m.host.begin({ goal: failing, budget: { rounds: 2, seconds: 600, noProgressRounds: 99 }, roles: ROLES });
  await m.host.gate();
  let v = await m.host.gate();
  assert.strictEqual(v.stopReason, "budget_rounds");
  assert.strictEqual(v["continue"], false);
  ok("轮数用完 → budget_rounds");

  m = mk();
  m.host.begin({ goal: failing, budget: { rounds: 9, seconds: 600, noProgressRounds: 2 }, roles: ROLES });
  // 第 1 轮没有基线可比(判不了,既不算进展也不算无进展),第 2、3 轮才是两轮持平
  v = await m.host.gate();
  assert.strictEqual(v.noProgressRounds, 0, "首轮无基线,不该记成零进展");
  v = await m.host.gate();
  assert.strictEqual(v.noProgressRounds, 1);
  assert.strictEqual(v["continue"], true);
  v = await m.host.gate();
  assert.strictEqual(v.stopReason, "no_progress", "指标一直 40 应判零进展");
  ok("指标不动 → no_progress（首轮无基线不计入）");

  m = mk();
  // seconds:0 = **不限时**(与 rounds/tokens 同一套规矩,回环修 bug 时改的语义):
  // 首次 gate 不许再当成「时限 0 秒已超」立即停
  m.host.begin({ goal: failing, budget: { rounds: 9, seconds: 0, noProgressRounds: 99 }, roles: ROLES });
  v = await m.host.gate();
  assert.notStrictEqual(v.stopReason, "budget_time", "seconds:0 是不限时,不是立即超时");
  ok("seconds:0 = 不限时（与 rounds/tokens 同一套 0=不限的规矩）");

  m = mk();
  m.host.begin({ goal: failing, budget: { rounds: 9, seconds: 1, noProgressRounds: 99 }, roles: ROLES });
  await new Promise(function (r) { setTimeout(r, 1150); });
  v = await m.host.gate();
  assert.strictEqual(v.stopReason, "budget_time");
  ok("时限用完 → budget_time");

  m = mk();
  m.host.begin({ goal: { command: "definitely-not-a-real-binary-xyz" }, budget: { rounds: 9 }, roles: ROLES });
  v = await m.host.gate();
  assert.strictEqual(v.met, false);
  assert.strictEqual(v.stopReason, "gate_broken");
  ok("判据命令坏掉 → gate_broken（不报成未达标,更不报达标）");

  m = mk();
  const nb = m.host.begin({ goal: {}, budget: { rounds: 3 }, roles: ROLES });
  assert.strictEqual(nb.gateConfigured, false);
  assert.ok(/cannot rule the goal met/.test(nb.note), "没判据要在返回值里就把后果说清");
  v = await m.host.gate();
  assert.strictEqual(v.met, false);
  assert.ok(/未配置|判据/.test(v.detail));
  ok("没有判据 → 如实说判不了,绝不签达标");

  m = mk();
  m.host.begin({ goal: failing, budget: { rounds: 9 }, roles: ROLES });
  const e = m.host.end("abandoned", "判据本身要先修");
  assert.strictEqual(e.reason, "abandoned");
  assert.strictEqual(m.events.filter(function (x) { return x.t === "run.end"; }).pop().detail, "判据本身要先修");
  ok("abandoned 可以收工,理由写进档案");
}

/* ---------------- MCP + HTTP 全链路 ---------------- */
function testMcpEndToEnd() {
  console.log("mcp — 宿主驱动全链路（真起监控台 + 真走 stdio）");
  const port = 4791;
  const logFile = path.join(os.tmpdir(), "cf-mcp-" + process.pid + ".jsonl");
  const consoleProc = spawn(process.execPath,
    [path.join(__dirname, "server.js"), "--no-open", "--reset", "--file", logFile,
      "--port", String(port), "--no-port-file"],
    { stdio: ["ignore", "pipe", "pipe"] });

  return new Promise(function (resolve, reject) {
    let ready = false;
    consoleProc.stdout.on("data", function (b) { if (!ready && /监控台/.test(b.toString())) { ready = true; go(); } });
    setTimeout(function () { if (!ready) { consoleProc.kill(); reject(new Error("监控台起不来")); } }, 8000);

    function go() {
      /* ★ CODE_FORGE_VIEW=none:这条 e2e 会把 loop_begin 走到 go,真开局后 ensureViewer
       *   一看测试台 0 观众就会**真弹一个 watch 终端窗**。实测事故:用户刚立完目标,
       *   协调者跑 npm test 摸基线,屏幕上凭空弹出 TUI、里面还全是旧档案。测试永不弹窗。 */
      const mcp = spawn(process.execPath,
        [path.join(__dirname, "server.js"), "--mcp", "--url", "http://localhost:" + port],
        { stdio: ["pipe", "pipe", "pipe"],
          env: Object.assign({}, process.env, { CODE_FORGE_VIEW: "none" }) });
      let out = "";
      const byId = {};
      const waiters = {};
      mcp.stdout.on("data", function (b) {
        out += b.toString();
        let nl;
        while ((nl = out.indexOf("\n")) >= 0) {
          const line = out.slice(0, nl).trim(); out = out.slice(nl + 1);
          if (!line) continue;
          const m = JSON.parse(line);
          byId[m.id] = m;
          if (waiters[m.id]) { waiters[m.id](m); delete waiters[m.id]; }
        }
      });
      let seq = 0;
      function rpc(method, params) {
        const id = ++seq;
        return new Promise(function (res, rej) {
          waiters[id] = res;
          setTimeout(function () { if (waiters[id]) rej(new Error(method + " 超时")); }, 10000);
          mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: id, method: method, params: params }) + "\n");
        });
      }
      const callTool = async function (name, args) {
        const m = await rpc("tools/call", { name: name, arguments: args || {} });
        const text = m.result.content[0].text;
        let parsed = null;
        try { parsed = JSON.parse(text); } catch (_) {}
        return { isError: !!m.result.isError, text: text, json: parsed };
      };

      (async function () {
        try {
          const init = await rpc("initialize", { protocolVersion: "2025-06-18" });
          assert.strictEqual(init.result.serverInfo.name, "code-forge");
          ok("initialize 握手");

          const list = await rpc("tools/list");
          const names = list.result.tools.map(function (t) { return t.name; }).sort();
          assert.deepStrictEqual(names,
            ["loop_agent", "loop_begin", "loop_end", "loop_gate", "loop_say", "loop_status"]);
          list.result.tools.forEach(function (t) {
            assert.ok(t.description.length > 60, t.name + " 描述太短,宿主分不清何时该调");
            assert.ok(t.inputSchema.type === "object");
          });
          // 工具描述里必须写着「不许自己宣布达标」—— 提示词侧先禁,代码侧才兜底
          const gateDesc = list.result.tools.filter(function (t) { return t.name === "loop_gate"; })[0].description;
          assert.ok(/must not declare success yourself/.test(gateDesc), "loop_gate 描述必须明写不许自己宣布达标");
          ok("tools/list 六个工具齐全,且描述里明写「达标不由你说」");

          const suite = path.join(os.tmpdir(), "cf-mcp-suite-" + process.pid + ".js");
          fs.writeFileSync(suite, "console.log('coverage: 91%');process.exit(0);");
          /* ★ 硬闸:不带 confirmed 的 loop_begin 必须被拒 ——
           *   实测确认步骤只写在提示词里时模型会跳过,用户看到的就是
           *   「没有选择角色模型和轮数的选项」。拒绝语要教它怎么摆确认。 */
          /* ★ 开局流程由 loop_begin 的**状态机**编排,模型只当手(用户指令:
           *   「整个流程顺序要机械化,不能由大模型自己编排」)。改过三版的教训:
           *   提示词流程被跳过 → 布尔被自我盖章 → 确认码可能连码带流程一起绕 ——
           *   现在每步只发当前指令+一次性 token,乱序/跳步一律弹回。 */
          const CFGE = { goal: { command: JSON.stringify(process.execPath) + " " + JSON.stringify(suite),
              metric: { name: "覆盖率", pattern: "coverage: ([0-9]+)", min: 80 } },
            budget: { rounds: 3, seconds: 600 }, roles: ROLES };
          const w1 = await callTool("loop_begin", Object.assign({ go: true }, CFGE));
          assert.ok(w1.isError && w1.json && w1.json.step === "1/3 goal",
            "★ 上来就想开局 → 弹回第 1 步(问目标),带全套配置也没用");
          const w2 = await callTool("loop_begin", { token: w1.json.token, task: "MCP 全链路测试目标" });
          assert.ok(w2.isError && w2.json.step === "2/3 config", "交目标 → 配置卡指令");
          assert.ok(/recommended option first/i.test(w2.text) && /Enter = all defaults/.test(w2.text),
            "配置卡指令要写明:每题推荐排第一、一路回车=全默认");
          const wOld = await callTool("loop_begin", Object.assign({ token: w1.json.token }, CFGE));
          assert.ok(wOld.isError && /Wrong token/.test(wOld.text), "★ 旧 token 被拒 —— 每步都换,不能跳");
          const w3 = await callTool("loop_begin", { token: w2.json.token, goal: CFGE.goal, budget: CFGE.budget });
          assert.ok(w3.isError && w3.json.missing && /roles/.test(JSON.stringify(w3.json.missing)),
            "缺字段要点名 —— 说明有题没问");
          const w4 = await callTool("loop_begin", Object.assign({ token: w3.json.token }, CFGE));
          assert.ok(w4.isError && w4.json.step === "3/3 confirm", "配置交齐 → 确认卡");
          assert.ok(/verbatim/.test(w4.text) && w4.json.summary && /覆盖率/.test(w4.json.summary),
            "★ 确认卡小结由服务端拼,模型原样摆(task 是中文 → lang=zh → 小结按中文出)");
          const w5 = await callTool("loop_begin", { token: w4.json.token, revise: true });
          assert.ok(w5.isError && w5.json.step === "2/3 config", "「再改一项」回配置卡");
          const w6 = await callTool("loop_begin", Object.assign({ token: w5.json.token }, CFGE));
          const begun = await callTool("loop_begin", { token: w6.json.token, go: true });
          assert.strictEqual(begun.isError, false);
          assert.strictEqual(begun.json.round, 1);
          assert.ok(begun.json.console);
          ok("★ 开局全程由状态机编排:跳步弹回、每步一次性 token、小结服务端拼、go 才开局");

          const cheat = await callTool("loop_end", { reason: "goal_met", detail: "我觉得可以了" });
          assert.strictEqual(cheat.isError, true);
          assert.ok(/the gate has not ruled the goal met/.test(cheat.text));
          ok("★ 经 MCP 自称达标 → 被拒(拒绝一路传到宿主看得见的地方)");

          const bad = await callTool("loop_say", { role: "查无此人", summary: "x" });
          assert.strictEqual(bad.isError, true);
          ok("loop_say 未登记角色 → isError,不静默吞掉");

          const s1 = await callTool("loop_say", { role: "实现者", summary: "加唯一索引", body: "..." });
          assert.strictEqual(s1.isError, false);
          const s2 = await callTool("loop_say", { role: "反驳者", summary: "并发窗口仍在", targets: ["实现者"] });
          assert.strictEqual(s2.isError, false);
          ok("两个角色各 loop_say 一次");

          const v = await callTool("loop_gate", {});
          assert.strictEqual(v.json.met, true);
          assert.strictEqual(v.json["continue"], false);
          assert.strictEqual(v.json.stopReason, "goal_met");
          ok("loop_gate 判达标并自动收工");

          const st = await callTool("loop_status", {});
          assert.strictEqual(st.json.active, false);
          assert.strictEqual(st.json.endedReason, "goal_met");
          ok("loop_status 报告已结束及原因");

          const lines = fs.readFileSync(logFile, "utf8").trim().split("\n").map(JSON.parse);
          const sayEvents = lines.filter(function (e) { return e.t === "event" && e.role !== "gate"; });
          assert.strictEqual(sayEvents.length, 2);
          sayEvents.forEach(function (e) { assert.strictEqual(e.tok, null, "宿主执行的事件不许有假 token"); });
          assert.strictEqual(lines.filter(function (e) { return e.t === "run.end"; }).pop().reason, "goal_met");
          ok("全部落盘:两条发言无假用量,run.end 记 goal_met");

          fs.unlinkSync(suite);
          mcp.kill(); consoleProc.kill();
          try { fs.unlinkSync(logFile); } catch (_) {}
          resolve();
        } catch (err) { mcp.kill(); consoleProc.kill(); reject(err); }
      })();
    }
  });
}

/* ---------------- 插件包装 ---------------- */
async function testPackaging() {
  console.log("packaging — 即插即用的那几个文件");
  const plugin = JSON.parse(fs.readFileSync(path.join(__dirname, ".claude-plugin", "plugin.json"), "utf8"));
  assert.ok(plugin.mcpServers && plugin.mcpServers["code-forge"], "插件必须自带 MCP 声明,否则还要手动接");
  const args = plugin.mcpServers["code-forge"].args.join(" ");
  assert.ok(/\$\{CLAUDE_PLUGIN_ROOT\}/.test(args), "路径必须用 CLAUDE_PLUGIN_ROOT,写死的路径换台机器就废了");
  assert.ok(/--mcp/.test(args));
  ok("plugin.json 自带 MCP server 声明(装完即可用,不必手动 add)");

  const mp = JSON.parse(fs.readFileSync(path.join(__dirname, ".claude-plugin", "marketplace.json"), "utf8"));
  assert.strictEqual(mp.plugins[0].source, "./");
  ok("marketplace.json 指向本目录(可 /plugin marketplace add 本地路径)");

  const skill = fs.readFileSync(path.join(__dirname, "skills", "code-forge", "SKILL.md"), "utf8");
  assert.ok(/^---/.test(skill), "技能必须有 frontmatter");
  const fm = skill.split("---")[1];
  assert.ok(/name:\s*code-forge/.test(fm));
  assert.ok(/description:/.test(fm));
  // 技能的触发词得覆盖用户会怎么说,否则永远不被自动调用
  ["对抗", "adversarial", "推翻", "测试通过"].forEach(function (w) {
    assert.ok(fm.indexOf(w) >= 0, "description 里缺触发词：" + w);
  });
  // 代码侧的拒绝之前,提示词侧必须先禁 —— 只靠代码兜底等于让模型每次都去撞墙
  assert.ok(/must not declare success yourself/.test(skill), "SKILL.md 必须明写不许自己宣布达标");
  assert.ok(/Never bend the gate/.test(skill), "SKILL.md 必须禁止为了达标而放宽判据");
  assert.ok(/loop_begin[\s\S]*loop_say[\s\S]*loop_gate/.test(skill), "SKILL.md 必须写清协议顺序");
  ok("SKILL.md：frontmatter、触发词、三条纪律、协议顺序都在");

  const cmd = fs.readFileSync(path.join(__dirname, "commands", "code-forge.toml"), "utf8");
  assert.ok(/description\s*=/.test(cmd) && /prompt\s*=/.test(cmd));
  assert.ok(/\{\{args\}\}/.test(cmd), "斜杠命令要能接目标参数");
  ok("/code-forge 斜杠命令存在且接参数");

  const agents = fs.readFileSync(path.join(__dirname, "AGENTS.md"), "utf8");
  ["Codex", "opencode", "mcp_servers", "/host/gate"].forEach(function (w) {
    assert.ok(agents.indexOf(w) >= 0, "AGENTS.md 里缺：" + w);
  });
  ok("AGENTS.md 给了 Codex / opencode 的接法与纯 HTTP 兜底");

  // （2026-08 收窄）gatesuggest / setup.html / tui 向导删了 —— 执行只发生在 coding agent 里,
  // 判据候选由聊天里的执行者按技能给(候选式确认的规矩钉在 SKILL.md 那组断言里)。

  // ---- 起 agent 命令行必须安全（agentcli.js）----
  const cli = require("./agentcli.js");
  assert.strictEqual(cli.safeModel("sonnet"), "sonnet");
  assert.strictEqual(cli.safeModel("claude-opus-4-8"), "claude-opus-4-8");
  // ★ 模型名是用户填的,而它要进 argv。shell:true 配数组参数不转义只拼接
  assert.strictEqual(cli.safeModel("sonnet & calc"), null);
  assert.strictEqual(cli.safeModel("a;rm -rf /"), null);
  assert.strictEqual(cli.safeModel(""), null);
  ok("★ 模型名过白名单（挡住经 argv 的命令注入）");

  const acsrc = fs.readFileSync(path.join(__dirname, "agentcli.js"), "utf8");
  assert.ok(acsrc.indexOf("shell") < 0 || /不用 shell/.test(acsrc), "agentcli 不许走 shell");
  assert.ok(acsrc.indexOf("CODE_FORGE_AGENT_CLI") >= 0, "要能换成别的 agent 命令行");
  ok("起进程不走 shell，且执行者命令行可替换");

  // ---- 通用性要写清楚（这是用户会踩空的地方）----
  const ag = fs.readFileSync(path.join(__dirname, "AGENTS.md"), "utf8");
  assert.ok(/哪些通用/.test(ag), "AGENTS.md 要有通用性对照表");
  ["loop_begin", "forge-", "CODE_FORGE_AGENT_CLI", "文件启发式"].forEach(function (w) {
    assert.ok(ag.indexOf(w) >= 0, "通用性表里缺：" + w);
  });
  const sk = fs.readFileSync(path.join(__dirname, "skills", "code-forge", "SKILL.md"), "utf8");
  assert.ok(/candidates/.test(sk) && /Never invent/.test(sk),
    "候选式确认必须写进技能（这才是跨宿主通用的那一半）");
  // ★ 聊天里也要能「选模型 / 定目标」:目标来自用户的话、判据走候选式（上面钉过了）,
  //   模型这块以前是缺的 —— 角色模型写死在子 agent 定义里,技能没说用户点名就换。
  //   Task/Agent 派发本来就支持 model 覆盖,缺的只是把这条写给执行者。
  assert.ok(/Models are swappable on the spot/.test(sk), "★ 技能要写明:用户点名换模型就用 model 参数覆盖");
  assert.ok(/say so honestly and keep the default/.test(sk),
    "★ 点了不存在的模型要如实说并保持默认 —— 不许静默换成别的（跟 tui 同一条纪律）");
  assert.ok(/a soft critic is no critic/.test(sk), "反驳者往弱了换要提醒（跟 tui 的推荐理由同源）");
  // ★ 开跑前的确认要**可点**,不是一段说明文 —— 只给小结等于「看得见改不了」(用户指出过:
  //   聊天里从没被问过模型和轮数)。选项:开跑(推荐)/改模型/改预算/改判据,改完重新确认。
  assert.ok(/every option gets its window first/.test(sk),
    "★ 顺序铁律:先配置卡(模型/轮数/时限)后确认卡 —— 不许把改项藏在「开跑?」后面");
  assert.ok(/Config card/.test(sk) && /Confirm card/.test(sk) && /Enter = all defaults/.test(sk),
    "配置卡每题推荐排第一,一路回车=全默认;答完才出确认卡");
  assert.ok(/unlimited \(rounds:0\)/.test(sk), "轮数那一题要摆出「不限」这个档");
  assert.ok(/Start \(Recommended\)/.test(sk), "确认卡上开跑是推荐项 —— 回车即走");
  // ★ 宿主有原生选项组件就必须用它。Claude Code 的 AskUserQuestion 本来就能列选项点选 ——
  //   打一段文字列表让人打号码回话,是把「能点」的界面用成了「只能打字」（用户当面指出过）。
  assert.ok(/AskUserQuestion/.test(sk), "★ 技能要点名 AskUserQuestion —— 有点选组件就不许让人打字");
  assert.ok(/Recommended/.test(sk), "推荐的那条要标 (Recommended) 且排第一（组件的约定）");
  assert.ok(/Other built in|built-in Other/.test(sk), "「自己填」由组件的 Other 项承担,不许再手摆一个 0)");
  assert.ok(/without such a component/.test(sk) && /numbered list/.test(sk),
    "纯文本宿主（Codex 聊天等）才退回编号列表 —— 降级要写明是降级");
  /* ★ 只打 `/code-forge` 不写目标:两个入口都不许脑补一个目标开跑。
   *   判据候选是按目标挑的 —— 没有目标就去扫仓库、猜一个开跑,
   *   等于替用户决定他要什么,烧的还是他的额度。 */
  assert.ok(/start nothing/.test(sk), "★ 技能要有「目标缺席」这一节,且排在开跑之前");
  assert.ok(/1-2 candidate goals/.test(sk), "对话里刚讨论过的问题要凝成候选目标让用户选,别让人重打一遍");
  assert.ok(/one thing: \*\*wait for the goal\*\*/.test(sk), "★ 空目标那一回合只许等输入 —— 像备注输入,不是拒掉重打");
  assert.ok(/goals may not/.test(sk),
    "★ 判据候选可以按仓库给,目标不许按仓库编 —— 那是用户的事");
  assert.ok(/no established goal, no `loop_begin`/.test(sk), "目标立不住就不许 loop_begin（与 tui 的 taskEstablished 同源）");
  assert.ok(/goal → look at the repo with the goal → candidates/.test(sk),
    "★ 顺序写死:目标先立,再带着它看仓库 —— 先扫仓库挑出来的是「仓库能跑什么」,不是「目标该用什么判」");
  const cfToml = fs.readFileSync(path.join(__dirname, "commands", "code-forge.toml"), "utf8");
  assert.ok(/do not invent a goal and start/.test(cfToml),
    "★ codex 命令空参时 {{args}} 展开成空 —— toml 里必须写明不许脑补目标");
  assert.ok(/不要调 loop_begin|loop_begin/.test(cfToml), "toml：目标立住之前不许 loop_begin");
  /* ★ Claude Code 那边的斜杠命令(install.js 生成)同样要带这条。
   *   实测过:命令提示词开头写「先确认判据命令」,用户只打 /code-forge 时
   *   模型照着它**直接开扫仓库**,目标问都不问 —— 命令是模型看到的第一段指令,
   *   空目标的处理必须写在它自己身上,不能指望它去翻技能正文。 */
  // ⚠ 不许 require("./install.js") —— 它没有 require.main 守卫,一 require 就真装一遍。
  //   只读源码切出 commandMarkdown 那一段来断言。
  const instSrc = fs.readFileSync(path.join(__dirname, "install.js"), "utf8");
  const cmdAt = instSrc.indexOf("function commandMarkdown");
  const cmdMd = instSrc.slice(cmdAt, instSrc.indexOf(String.fromCharCode(10) + "}", cmdAt));
  assert.ok(/exactly one thing: \*\*wait for the goal\*\*/.test(cmdMd), "★ Claude Code 斜杠命令也要有空目标处理（等输入）");
  assert.ok(/Forbidden: scanning the repo/.test(cmdMd),
    "★ 必须明写禁扫仓库 —— 实测模型照着「先确认判据命令」就直接开扫了");
  assert.ok(/Once the goal is established/.test(cmdMd) &&
    cmdMd.indexOf("wait for the goal") < cmdMd.indexOf("gate-command candidates"),
    "★ 空目标处理要排在「找判据」之前 —— 顺序就是模型的执行顺序");
  ok("通用性对照表在 AGENTS.md，候选式确认在技能里（跨宿主）；聊天里可换模型、开跑前有小结");

  // ---- 终端界面（tui.js）----
  const tui = require("./tui.js");
  const st = tui.newState();
  [{ t: "run.start", session: "S", mode: "host", goal: "G", budget: { rounds: 6 } },
   { t: "role.add", id: "role1", name: "实现者", model: "sonnet" },
   { t: "role.add", id: "gate", name: "判据", model: "确定性 · 无模型" },
   { t: "round.start", n: 1 },
   { t: "event", round: 1, role: "role1", kind: "propose", ts: "10:00:01", summary: "补用例" },
   { t: "event", round: 1, role: "gate", kind: "test", ts: "10:00:09", summary: "未达标 · 覆盖率 68", meta: { value: 68 } },
   { t: "round.end", n: 1, winner: "未达标", score: "覆盖率 68" },
   { t: "round.start", n: 2 },
   { t: "event", round: 2, role: "gate", kind: "test", ts: "10:01:09", summary: "达标 · 覆盖率 82", meta: { value: 82 } },
   { t: "run.end", reason: "goal_met", detail: "exit 0 · 覆盖率 82", rounds: 2, seconds: 96 }
  ].forEach(function (e) { tui.reduce(st, e); });
  const out = tui.render(st, 96);
  assert.ok(out.indexOf("R1 68") >= 0 && out.indexOf("R2 82") >= 0, "判据走势必须出现在画面上");
  assert.ok(out.indexOf("达标停止") >= 0, "停止原因要显示成人话");
  assert.ok(out.indexOf("实现者") >= 0 && out.indexOf("判据") >= 0, "角色表要有名字");
  ok("TUI 渲染是纯函数：判据走势 / 停止原因 / 角色表都在");

  // 一条 gate 事件都没有时不许画一排「—」——那会被读成「量过了,没有数」
  const st2 = tui.newState();
  [{ t: "run.start", session: "S" }, { t: "round.start", n: 1 },
   { t: "event", round: 1, role: "r1", kind: "propose", summary: "x" }].forEach((e) => tui.reduce(st2, e));
  assert.ok(tui.render(st2, 96).indexOf("判据") < 0, "没有判据事件时整行不画");
  ok("没有判据事件时不画判据行（不假装量过）");

  /* ★ 点开某一轮，看那一轮做了什么。
   *
   * 以前画面上只有「本轮最后 8 条」—— 前几轮反驳者抓到的是什么、判据当时卡在哪，
   * 全看不见,只能去翻网页或 run.jsonl。而回环的价值恰恰在**几轮之间的变化**。
   */
  {
    const many = tui.newState();
    [
      { t: "run.start", session: "S", mode: "host", goal: "G", budget: { rounds: 6 } },
      { t: "role.add", id: "r1", name: "实现者", model: "sonnet" },
      { t: "role.add", id: "gate", name: "判据", model: "确定性" },
      { t: "round.start", n: 1 },
      { t: "event", round: 1, role: "r1", kind: "propose", ts: "10:00:01", summary: "第一轮的提案内容" },
      { t: "event", round: 1, role: "gate", kind: "test", ts: "10:00:09",
        summary: "未达标 · 覆盖率 68", meta: { value: 68, met: false } },
      { t: "round.end", n: 1, winner: "未达标", score: "覆盖率 68" },
      { t: "round.start", n: 2 },
      { t: "event", round: 2, role: "r1", kind: "patch", ts: "10:01:01", summary: "第二轮的补丁内容" },
      { t: "event", round: 2, role: "gate", kind: "test", ts: "10:01:09",
        summary: "达标 · 覆盖率 82", meta: { value: 82, met: true } }
    ].forEach(function (e) { tui.reduce(many, e); });

    // ① 每一轮都摆一行,而且这一行知道自己是第几轮 —— 点击上报的是行号,
    //    没有这张对照表就只知道「点在第 7 行」,不知道那是第几轮
    const lines = tui.renderLines(many, 100);
    [1, 2].forEach(function (n) {
      assert.ok(lines.some(function (l) { return l.round === n; }),
        "★ 第 " + n + " 轮必须有一行带着 round=" + n + "（否则点下去不知道点中了谁）");
    });

    // ② 默认展开最新那一轮 —— 老样子:进来第一眼看见的就是正在跑的这一轮
    const dflt = tui.render(many, 100);
    assert.ok(dflt.indexOf("第二轮的补丁内容") >= 0, "默认要展开最新那一轮");
    assert.ok(dflt.indexOf("第一轮的提案内容") < 0, "默认不展开老的那一轮（一屏放不下）");

    // ③ 点开第 1 轮 → 看得见第一轮做了什么
    const openFirst = tui.render(many, 100, { open: 1, sel: 1 });
    assert.ok(openFirst.indexOf("第一轮的提案内容") >= 0,
      "★ 点开第 1 轮就要看得见第 1 轮做了什么");
    assert.ok(openFirst.indexOf("第二轮的补丁内容") < 0, "同时只摊开一轮（收起的那轮不占地方）");
    // 收起的那一轮仍然摆着一行结论:过没过、几条事件
    assert.ok(/R2/.test(openFirst) && /82/.test(openFirst), "收起的轮次仍要有一行摘要");

    // ④ 全收起
    const allClosed = tui.render(many, 100, { open: null });
    assert.ok(allClosed.indexOf("第一轮的提案内容") < 0 &&
      allClosed.indexOf("第二轮的补丁内容") < 0, "open=null 就都收起");
    assert.ok(/R1/.test(allClosed) && /R2/.test(allClosed), "收起之后每轮仍各占一行");

    /* ⑤ ★ 显示不下**不裁中间,加滚动**(Claude Code 同款,用户点名改的:原来裁中间)。
     *    全量渲染 → 视口切片;对照表按视口内行号建,点击行号才对得上。 */
    const wsrc = fs.readFileSync(path.join(__dirname, "tui.js"), "utf8");
    assert.ok(/all\.slice\(scroll, scroll \+ vp\)/.test(wsrc),
      "★ 视口 = 全量渲染的切片(不裁中间,滚动看长回环)");
    assert.ok(/stickBottom/.test(wsrc) && /scroll >= maxScroll/.test(wsrc),
      "跟底模式:贴着最新;滚上去就停住,滚回底部/按 f 恢复");
    assert.ok(/btn === 64 \|\| btn === 65/.test(wsrc), "滚轮要接住(以前直接 continue 扔掉)");
    assert.ok(wsrc.indexOf("[5~") >= 0 && wsrc.indexOf("[6~") >= 0, "PgUp/PgDn 也要能翻");
    assert.ok(/⇅/.test(wsrc), "有滚动余量时底栏要有位置指示(第几行/共几行)");

    // ⑥ 你自己点开一轮之后,新事件不许把你拽走 —— 直播画面最气人的就是「刚要看清就跳走」
    assert.ok(/view\.follow = view\.open === last/.test(wsrc),
      "★ 点开老的一轮要停住（follow 关掉），点最新那轮才继续跟");
    assert.ok(/if \(view\.follow && st\.rounds\.length\)/.test(wsrc),
      "跟最新那一轮的逻辑要在重画时生效");
    assert.ok(/hit = lines\.map/.test(wsrc),
      "★ 对照表必须按视口切片建（全量行号对不上屏幕行号）");
    ok("★ 点一行看那一轮做了什么：每轮一行带轮号、只摊开一轮、超高加滚动、点开后不被新事件拽走");
  }

  // 新一轮 run.start 要换一茬,否则两次回环的「第 1 轮」挤在同一格（与网页同一条纪律）
  const st3 = tui.newState();
  [{ t: "run.start", session: "A" }, { t: "round.start", n: 1 },
   { t: "event", round: 1, role: "r1", summary: "第一次" },
   { t: "run.start", session: "B" }, { t: "round.start", n: 1 },
   { t: "event", round: 1, role: "r1", summary: "第二次" }].forEach((e) => tui.reduce(st3, e));
  assert.strictEqual(st3.rounds.length, 1);
  assert.strictEqual(st3.rounds[0].events.length, 1, "第二次回环不该继承第一次的事件");
  assert.strictEqual(st3.run.session, "B");
  ok("遇到新 run.start 换一茬（两次回环不混格）");

  /* ★ 换茬必须把**流式提示**也换掉。实测:newState() 里漏了 streaming 键,
   *   换茬逐键复位时它漏网 —— 新局刚开(R1 · 0 事件),挂的却是上一局的
   *   「第 2 轮 · 距上一条发言已 593s(上一条:反驳者…)」,像旧回环还在跑。 */
  const st4 = tui.newState();
  [{ t: "run.start", session: "旧局" }, { t: "round.start", n: 2 },
   { t: "run.streaming", role: "gate", text: "第 2 轮 · 距上一条发言已 593s" },
   { t: "run.end", reason: "stopped" },
   { t: "run.start", session: "新局" }, { t: "round.start", n: 1 }].forEach((e) => tui.reduce(st4, e));
  assert.strictEqual(st4.streaming, null, "★ 新局不许继承旧局的流式提示");
  const linesNew = tui.renderLines(st4, 100, { open: 1, max: 400, openEv: new Set() })
    .map(function (l) { return typeof l === "string" ? l : l.text; }).join("\n");
  assert.ok(linesNew.indexOf("第 2 轮 · 距上一条发言已") < 0,
    "★ 画面上也不许出现旧局的活动行(两个渲染点:轮内活动行 + 底部进行中行)");
  ok("★ 换茬连流式提示一起换（新局 R1 不再挂旧局的「第 2 轮 · 593s」）");

  /* ★ 连胜判据 + 不限轮数。
   *
   * 「修掉查出的 bug,直到**连续 3 轮** bug 数为 0」—— 单轮判过不算数,断一次从头攒;
   * 这类目标说不准要几轮,所以 rounds:0 = 不限轮(时限/零进展闸门仍在,烧不完的是轮数不是钱)。
   */
  {
    const evs = [];
    const h = require("./hostrun.js").create(function (e) { evs.push(e); });
    h.begin({ session: "s", task: "修到连续 3 轮干净",
      goal: { command: "node -e process.exit(0)", cwd: process.cwd(), streak: 3 },
      budget: { rounds: 0, seconds: 600, noProgressRounds: 2 },
      roles: [{ name: "实现者", kind: "propose" }, { name: "反驳者", kind: "attack" }],
      quietWarnMs: 999999 });
    h.say({ role: "反驳者", summary: "没挖到", body: "" });
    const v1 = await h.gate();
    assert.strictEqual(v1.met, false, "★ 单轮判过不算达标 —— met 回的是「攒满没」,不是「本轮过没过」");
    assert.strictEqual(v1.roundMet, true, "本轮结果单独放 roundMet");
    assert.deepStrictEqual(v1.streak, { need: 3, have: 1 }, "连胜进度要回给 agent");
    assert.strictEqual(v1.continue, true, "还要继续");
    assert.ok(/3 consecutive/.test(v1.instruction) && /1\/3/.test(v1.instruction),
      "指令要说清:本轮过了、还差几轮、反驳者接着挖");
    assert.strictEqual(v1.remaining.rounds, null, "★ rounds:0 = 不限轮,remaining 回 null(不是 Infinity)");
    // 攒到 1/3 时自称达标必须被拒,而且拒绝语要带进度 —— 「还没判过」对着 2/3 的 agent 是错的
    const e1 = h.end("goal_met", "");
    assert.ok(e1.error && /1\/3/.test(e1.error), "★ 中途自称达标被拒,且拒绝语带连胜进度");
    h.say({ role: "反驳者", summary: "没挖到", body: "" });
    const v2 = await h.gate();
    assert.strictEqual(v2.streak.have, 2);
    assert.strictEqual(v2.met, false, "2/3 仍不算达标");
    // ★ 判过的轮不计零进展:输出指纹三轮全同,noProgressRounds=2 也不许把确认期误杀
    assert.strictEqual(v2.noProgressRounds, 0, "★ 确认期的判过轮不算零进展（那是判据定义的一部分）");
    h.say({ role: "反驳者", summary: "没挖到", body: "" });
    const v3 = await h.gate();
    assert.strictEqual(v3.met, true, "连续 3 轮判过 → 达标");
    assert.strictEqual(v3.stopReason, "goal_met");
    assert.strictEqual(evs.filter(function (e) { return e.t === "run.end"; })[0].reason, "goal_met");
    // 直播上每一轮要看得见连胜进度
    const re1 = evs.filter(function (e) { return e.t === "round.end" && e.n === 1; })[0];
    assert.ok(/连胜 1\/3/.test(re1.winner), "round.end 要标连胜进度,不能显示成「达标」");

    // ── 断一次从头攒
    const flag = path.join(os.tmpdir(), "cf-streak-" + process.pid);
    fs.writeFileSync(flag, "1");
    const h2 = require("./hostrun.js").create(function () {});
    h2.begin({ session: "s2", task: "t",
      goal: { command: "node -e \"process.exit(require('fs').existsSync(String.raw`" + flag + "`)?0:1)\"",
        cwd: process.cwd(), streak: 2 },
      budget: { rounds: 10, seconds: 600, noProgressRounds: 5 },
      roles: [{ name: "实现者", kind: "propose" }], quietWarnMs: 999999 });
    h2.say({ role: "实现者", summary: "x", body: "" });
    const w1 = await h2.gate();
    fs.unlinkSync(flag);
    h2.say({ role: "实现者", summary: "x", body: "" });
    const w2 = await h2.gate();
    fs.writeFileSync(flag, "1");
    h2.say({ role: "实现者", summary: "x", body: "" });
    const w3 = await h2.gate();
    assert.strictEqual(w1.streak.have, 1);
    assert.strictEqual(w3.streak.have, 1, "★ 断一次必须从头攒 —— 「连续」是判据的一部分,不是修辞");
    assert.strictEqual(w3.met, false);
    try { fs.unlinkSync(flag); } catch (_) {}
    h2.end("stopped", "测试收尾");

    // ── 不限轮:多轮失败也不触发 budget_rounds(零进展闸门另测,这里放宽它)
    const h3 = require("./hostrun.js").create(function () {});
    h3.begin({ session: "s3", task: "t",
      goal: { command: "node -e process.exit(1)", cwd: process.cwd() },
      budget: { rounds: 0, seconds: 600, noProgressRounds: 99 },
      roles: [{ name: "实现者", kind: "propose" }], quietWarnMs: 999999 });
    for (let i = 0; i < 5; i++) {
      h3.say({ role: "实现者", summary: "改 " + i, body: "" });
      const w = await h3.gate();
      assert.notStrictEqual(w.stopReason, "budget_rounds", "不限轮不许因轮数停");
    }
    h3.end("stopped", "测试收尾");

    // schema 与技能要把这两个选项摆出来 —— 功能在而没人知道等于没有
    const mcpS = fs.readFileSync(path.join(__dirname, "mcp.js"), "utf8");
    assert.ok(/streak/.test(mcpS) && /unlimited rounds/.test(mcpS), "loop_begin 的 schema 要写明 streak 与 rounds:0");
    const skS = fs.readFileSync(path.join(__dirname, "skills", "code-forge", "SKILL.md"), "utf8");
    assert.ok(/goal\.streak/.test(skS) && /rounds: 0/.test(skS),
      "技能要教:连续 N 轮干净 → streak;不限轮数 → rounds:0（并提醒确认时限）");
    ok("★ 连胜判据（连续 N 轮判过才达标,断了从头攒,确认期不算零进展）+ 不限轮数（rounds:0）");
  }

  /* ★ 判据的第三种:**角色上报指标** —— 判据是「停止需要达到的条件」,不必是可执行命令。
   *   「修 bug 直到连续 3 轮挖不出新 bug」:bug 数来自反驳者每轮挖掘的结果,
   *   世界上没有一条命令能数它。metric.source:"say" + max:0 + streak:3 就是这个判据。 */
  {
    const evs = [];
    const h = require("./hostrun.js").create(function (e) { evs.push(e); });
    h.begin({ session: "挖bug", task: "连续3轮0bug停",
      goal: { cwd: process.cwd(), metric: { name: "新bug数", source: "say", max: 0 }, streak: 3 },
      budget: { rounds: 0, seconds: 600, noProgressRounds: 9 },
      roles: [{ name: "实现者", kind: "propose" }, { name: "反驳者", kind: "attack" }],
      quietWarnMs: 999999 });
    h.say({ role: "反驳者", summary: "挖到2个", body: "", value: 2 });
    const v1 = await h.gate();
    assert.strictEqual(v1.roundMet, false);
    assert.ok(/新bug数 = 2/.test(v1.detail) && /反驳者/.test(v1.detail),
      "裁决要写清:值是谁报的、比的什么区间(task 中文 → lang zh → 中文裁决)");
    // ★ 实现者报 0 不算数 —— 它有动机报 0。没有合法上报 = 判不了,不是达标
    h.say({ role: "实现者", summary: "我修完了,0个!", body: "", value: 0 });
    const v2 = await h.gate();
    assert.strictEqual(v2.roundMet, false, "★ 实现者自报 0 不许当达标");
    assert.ok(/没人报/.test(v2.detail) && /实现者报的不算/.test(v2.detail),
      "要说清:数得由找茬的那方报");
    // 连续 3 轮反驳者报 0 → reported_met(单列,不冒充命令判过)
    for (let i = 0; i < 3; i++) {
      h.say({ role: "反驳者", summary: "没挖到", body: "", value: 0 });
      await h.gate();
    }
    const end = evs.filter(function (e) { return e.t === "run.end"; })[0];
    assert.strictEqual(end.reason, "reported_met",
      "★ 停止原因单列 reported_met —— 角色报的数可信度低于命令,不许混进 goal_met");
    assert.ok(/role-reported/.test(require("./hostrun.js").REASONS.reported_met));
    // 上报值不许跨轮滚动:每轮都得重新报(evs 里第 2 轮的 gate 事件是「没人报」)
    const gates = evs.filter(function (e) { return e.t === "event" && e.role === "gate"; });
    assert.ok(gates.some(function (e) { return /没人报/.test(e.summary); }),
      "上一轮报的数过期 —— 反驳者每轮得重新挖、重新报");
    assert.ok(gates.some(function (e) { return e.meta && e.meta.executor === "say-metric"; }),
      "判据事件要标明 executor=say-metric —— 这不是代码量出来的,别标成 code");
    // 三个观察面都认得新停止原因
    const tuiS = fs.readFileSync(path.join(__dirname, "tui.js"), "utf8");
    const htmlS = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
    assert.ok(/reported_met/.test(tuiS) && /reported_met/.test(htmlS), "终端与网页都要认 reported_met");
    const mcpS2 = fs.readFileSync(path.join(__dirname, "mcp.js"), "utf8");
    assert.ok(/source: \{ type: "string", enum: \["say"\]/.test(mcpS2),
      "loop_begin 的 schema 要摆出 metric.source:say");
    assert.ok(/value: \{ type: "number"/.test(mcpS2), "loop_say 的 schema 要有 value");
    const skS2 = fs.readFileSync(path.join(__dirname, "skills", "code-forge", "SKILL.md"), "utf8");
    assert.ok(/stop CONDITION/.test(skS2) && /source:"say"/.test(skS2),
      "技能要教:判据是停止条件,不必是命令;三种判据按可信度排");
    ok("★ 角色上报指标判据：反驳者报数、实现者报 0 无效、连续 3 轮 0 → reported_met（单列）");
  }

  // 非 TTY 时不许画屏:clear-screen 与 raw mode 在管道/CI 里只会产出垃圾
  const tsrc = fs.readFileSync(path.join(__dirname, "tui.js"), "utf8");
  assert.ok(/function paint\(\) \{\s*if \(!TTY\) return;/.test(tsrc), "paint 必须在非 TTY 时直接返回");
  // 比原来更严:光 stdout 是终端不够,**stdin 也得是**。stdout 重定向而 stdin 还连着键盘
  // 的场合确实存在(`code-forge watch > log`),那时进 raw mode 会把用户的终端搞坏。
  assert.ok(/if \(TTY && process\.stdin\.isTTY[\s\S]*setRawMode/.test(tsrc),
    "raw mode 必须裹在 TTY 判断里（而且 stdin 也要是终端）");
  ok("非 TTY 时退化成逐行输出（不画屏、不进 raw mode）");

  // （向导删了:ask()/stdin-close 守卫随之删除。观察面(watch/usage)不再问任何问题。）

  // （执行路线删了:提示词拼装/agent 进程都不存在了。adapters 的 buildArgs 契约仍在下面的适配器组测）

  // ---- 多角色多模型 ----
  const dir = path.join(__dirname, "agents");
  const files = fs.readdirSync(dir).filter(function (f) { return f.endsWith(".md"); });
  assert.ok(files.length >= 3, "至少要有提议/反驳/复核三个角色定义");
  const parsed = {};
  files.forEach(function (f) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    assert.ok(/^---\n/.test(src), f + " 缺 frontmatter");
    const fm = src.split("---")[1];
    const get = function (k) { const m = new RegExp("^" + k + ":\\s*(.+)$", "m").exec(fm); return m && m[1].trim(); };
    parsed[get("name")] = { model: get("model"), tools: (get("tools") || "").split(/\s*,\s*/), body: src };
  });
  ["forge-proposer", "forge-critic", "forge-reviewer"].forEach(function (n) {
    assert.ok(parsed[n], "缺角色 " + n);
    assert.ok(parsed[n].model, n + " 必须指定 model,否则「多模型」是句空话");
  });
  // 多模型的意义在于**真的不同**:三个都写 sonnet 就退回成自己跟自己唱反调
  assert.notStrictEqual(parsed["forge-critic"].model, parsed["forge-proposer"].model,
    "反驳者与实现者必须跑在不同模型上");
  ok("三个角色定义齐全,且反驳者与实现者不同模型");

  // ★ 反驳者的写权限必须在**工具层面**就没有 —— 只写在提示词里挡不住顺手抹平
  ["Write", "Edit", "Bash", "NotebookEdit"].forEach(function (t) {
    assert.ok(parsed["forge-critic"].tools.indexOf(t) < 0,
      "forge-critic 不许有 " + t + " 工具（能改文件的反驳者会顺手把问题抹平)");
    assert.ok(parsed["forge-reviewer"].tools.indexOf(t) < 0, "forge-reviewer 不许有 " + t);
  });
  assert.ok(parsed["forge-proposer"].tools.indexOf("Edit") >= 0, "实现者得能改文件");
  ok("★ 反驳者/复核者工具层面就没有写权限（不是靠提示词请求）");

  // 实现者那份必须明写红线:不许改判据来达标
  assert.ok(/Never modify the gate to make it green/.test(parsed["forge-proposer"].body),
    "实现者定义里必须明写不许改判据");
  ok("实现者定义里明写「不许改判据来达标」这条红线");

  // 技能里要把派发方式和模型表写清,否则装了角色也不会被用
  const skillSrc = fs.readFileSync(path.join(__dirname, "skills", "code-forge", "SKILL.md"), "utf8");
  ["forge-proposer", "forge-critic", "forge-reviewer", "concurrently"].forEach(function (w) {
    assert.ok(skillSrc.indexOf(w) >= 0, "SKILL.md 里缺：" + w);
  });
  ok("SKILL.md 写清了派给哪三个子 agent、以及并发派发");

  // 安装脚本:必须幂等、可卸、且不去动插件管理器的内部账本
  const inst = fs.readFileSync(path.join(__dirname, "install.js"), "utf8");
  assert.ok(/--uninstall/.test(inst) && /--dry-run/.test(inst), "install.js 要能卸、能预览");
  assert.ok(/installed_plugins/.test(inst) && /刻意\*\*不动\*\*|刻意不动/.test(inst),
    "install.js 必须明说不动插件管理器的内部账本");
  assert.ok(/bak-code-forge/.test(inst), "改用户主配置前必须先备份");
  ok("install.js 幂等/可卸/改主配置前先备份/不碰插件内部账本");

  /* ★ /code-forge 空目标:**停下来等输入**(像备注输入那样),不是拒掉重打。
   *
   * 第一版钩子是 exit 2 拦截 —— 零 token,但体感是「被拒了,重打一遍 /code-forge」。
   * 用户要的是输入等待,而 Claude Code 里能画输入等待的只有模型侧(AskUserQuestion/提问),
   * 钩子画不出 UI。所以钩子改成**注入**:exit 0 + stdout 进上下文,把模型这一回合
   * 钉死在「只问目标」上(有上下文用选项组件,没有就一行提问),禁止扫仓库/loop_begin。
   */
  {
    const run = function (input) {
      const r = require("child_process").spawnSync(process.execPath,
        [path.join(__dirname, "hookprompt.js")], { input: input, encoding: "utf8", timeout: 8000 });
      return { code: r.status, out: r.stdout || "", err: r.stderr || "" };
    };
    const inj = run(JSON.stringify({ prompt: "/code-forge" }));
    assert.strictEqual(inj.code, 0, "★ 空目标是注入(exit 0),不是拦截 —— 拦截画不出输入等待");
    assert.ok(/exactly one thing/.test(inj.out) && /wait for the goal/.test(inj.out),
      "注入的指令要把这一回合钉死在「等目标」上");
    assert.ok(/AskUserQuestion/.test(inj.out), "有上下文时要用选项组件（凝出来的候选 + Other 自填）");
    assert.ok(/目标：要做什么/.test(inj.out), "没上下文时只输出一行提问,然后停");
    assert.ok(/Forbidden/.test(inj.out) && /[Ss]canning the repo/.test(inj.out) && /loop_begin/.test(inj.out),
      "★ 必须明写禁区 —— 实测不禁的话模型会顺势开扫仓库");
    assert.ok(/exactly one thing/.test(run(JSON.stringify({ prompt: "/code-forge   " })).out),
      "只有空白也算空目标");
    // ★ 放行面必须宽而且**静默**:这个钩子跑在用户每一条消息上,
    //   带目标的调用注入了任何字都会污染上下文
    const pass = function (input, why) {
      const r = run(input);
      assert.strictEqual(r.code, 0, why);
      assert.strictEqual(r.out, "", why + "（而且必须一个字都不注入）");
    };
    pass(JSON.stringify({ prompt: "/code-forge 修掉重复回调" }), "带了目标就静默放行");
    pass(JSON.stringify({ prompt: "随便聊聊" }), "普通聊天静默放行");
    pass(JSON.stringify({ prompt: "/code-forgex" }), "前缀相同的别的命令静默放行");
    pass("这不是 JSON", "★ fail-open:stdin 读不懂必须静默放行");
    pass(JSON.stringify({}), "没有 prompt 字段也静默放行");

    // 装/卸纪律（读 install.js 源码,不许 require —— 一 require 就真装一遍）
    const inst = fs.readFileSync(path.join(__dirname, "install.js"), "utf8");
    assert.ok(/function patchHooks/.test(inst), "install.js 要有 patchHooks");
    assert.ok(/hookprompt\.js/.test(inst.slice(inst.indexOf("const ours"))),
      "★ 卸载只认 command 里带 hookprompt.js 的条目 —— 别人的钩子一根不动");
    assert.ok(/\.bak-code-forge/.test(inst.slice(inst.indexOf("function patchHooks"))),
      "改 settings.json 前要备份（跟 MCP 那步同一条纪律）");
    assert.ok(/解析失败/.test(inst.slice(inst.indexOf("function patchHooks"))),
      "settings.json 是坏 JSON 时不许硬写 —— 报出来让人修,别把主配置抹掉");
    const pj = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));
    assert.ok(pj.files.indexOf("hookprompt.js") >= 0,
      "★ hookprompt.js 要进 files —— 运行时复制走的就是这份清单,漏了它钩子指向不存在的文件");
    ok("★ /code-forge 空目标 → 停下来等输入：钩子注入「只问目标」、其余静默放行、装卸幂等");

    /* ★ 聊天路径的直播落点:**终端窗口(watch)**,不是浏览器。
     *   实测:mcp.js 拉 server.js 时什么参数都没传,server 默认 open(url) 弹网页 ——
     *   而 tui 拉的时候特意带了 --no-open。同一个产品两个入口两种行为,是漏参数不是偏好。 */
    const mcpSrc2 = fs.readFileSync(path.join(__dirname, "mcp.js"), "utf8");
    assert.ok(/server\.js"\), "--no-open"/.test(mcpSrc2),
      "★ mcp 拉监控台必须带 --no-open —— 弹什么由 openView 定,server 别抢着开浏览器");
    assert.ok(/function openView/.test(mcpSrc2), "要有 openView");
    assert.ok(/CODE_FORGE_VIEW/.test(mcpSrc2), "CODE_FORGE_VIEW=web|tui|none 可改");
    assert.ok(/newWindowCmd/.test(mcpSrc2), "默认弹终端窗口跑 watch（复用 newWindowCmd）");
    // ★ 弹不弹看**观众数**,不看谁拉起的监控台。第一版看 consoleChild(刚拉起才弹),
    //   而监控台是常驻进程 —— 第二次开跑它早在跑,窗口永远不弹(实测:「完全看不到 tui」)。
    //   /health 的 clients = SSE 连接数;0 个观众才弹,有人看就不再糊窗口。
    assert.ok(/ensureViewer/.test(mcpSrc2) && /clients/.test(mcpSrc2),
      "★ loop_begin 后按观众数决定弹不弹(clients===0 才弹)");
    // ★ 第二道闸(实测反馈):台子上没有**进行中的回环**就不许弹 ——
    //   弹出去只能回放已停止的旧档案,用户会以为「旧回环还在跑/又被跑了一遍」。
    assert.ok(/ensureViewer[\s\S]{0,900}host\/status[\s\S]{0,300}active/.test(mcpSrc2),
      "★ ensureViewer 先查 /host/status.active —— 没有进行中的回环绝不弹窗");
    assert.ok(/loop_begin[\s\S]{0,2600}ensureViewer\(\)/.test(mcpSrc2),
      "loop_begin 成功后要真调 ensureViewer");
    assert.ok(!/if \(consoleChild\) log\("直播/.test(mcpSrc2),
      "不许再按「谁拉起的」判断 —— 那个判据实测是错的");
    process.env.CODE_FORGE_VIEW = "none";
    try {
      assert.strictEqual(require("./mcp.js").openView("http://x", function () {}), "none",
        "CODE_FORGE_VIEW=none 时什么都不弹");
    } finally { delete process.env.CODE_FORGE_VIEW; }
    ok("★ 聊天里 loop_begin 弹的是终端直播（watch），浏览器只是退路；none 可关");

    /* ★ npm test 不许弹窗、不许抢全局端口发现文件。实测事故:用户刚立完目标,
     *   协调者跑 npm test 摸基线 —— e2e 里的 loop_begin 走到 go,ensureViewer 数的是
     *   测试台(0 观众)于是真弹了 watch 窗;窗里按被测试台抢走的端口文件找台子,
     *   测试台一死又拉起正式台,回放的全是旧档案。用户看到的就是
     *   「配置还没确认,TUI 弹出来了,里面还是上一局的轮次和聊天」。 */
    {
      const TOKEN = "spawn(process.exec" + "Path";   // 拼出来,免得这段检查匹配到自己
      ["test-host.js", "test.js"].forEach(function (f) {
        const src = fs.readFileSync(path.join(__dirname, f), "utf8");
        src.split(TOKEN).slice(1).forEach(function (seg) {
          const head = seg.slice(0, 320);
          if (head.indexOf("server.js") < 0) return;
          if (head.indexOf('"--mcp"') >= 0) {
            assert.ok(seg.slice(0, 700).indexOf("CODE_FORGE_VIEW") >= 0,
              f + " 里起真 MCP 必须 CODE_FORGE_VIEW=none —— loop_begin 走到 go 会真弹直播窗");
          } else if (head.indexOf("--port") >= 0) {
            // 两种隔离都行:--no-port-file 关掉登记,或私有 tmpdir(测端口文件本身的那个用后者)
            assert.ok(head.indexOf("--no-port-file") >= 0 || seg.slice(0, 700).indexOf("TMPDIR") >= 0,
              f + " 里的测试台必须 --no-port-file(或私有 tmpdir)—— 抢了全局端口文件,别人弹的窗就找错台子");
          }
        });
      });
      const srvP = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
      assert.ok(/flag\("no-port-file"\)/.test(srvP), "server 要认 --no-port-file(一次性实例不参与全局发现)");
      assert.ok(/watch --url/.test(mcpSrc2),
        "★ mcp 弹的 watch 要带 --url 钉死台子 —— 数的是谁的观众,看的就得是谁");
      assert.ok(/indexOf\("--url"\)/.test(fs.readFileSync(path.join(__dirname, "tui.js"), "utf8")),
        "tui watch 要认 --url");
      ok("★ 测试永不弹窗/永不抢端口文件；mcp 弹的 watch 用 --url 钉死自己那个台子");
    }
  /* ★ 入口的约定(2026-08 收窄):执行只发生在 coding agent 里,终端只剩观察面。
   *   code-forge(裸) = watch;web = 监控台+浏览器;tui/go = 明确报「这条路移除了」并指回聊天。
   *   报错必须指路 —— 老用户敲 tui/go 时,一句「未知命令」等于把人扔在原地。 */
  {
    const srv = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
    assert.ok(srv.indexOf('argv[0] === "tui" || argv[0] === "go"') >= 0 && /这条路移除了/.test(srv),
      "★ tui/go 要明确报移除并指回 /code-forge（不是「未知命令」）");
    // ★ 裸命令**什么都不执行**。上一版裸=watch,回放旧档案一屏滚出来,怎么标注
    //   都还是像「它直接跑了一个回环」(用户两次这么理解) —— 观察面也得显式要。
    assert.ok(srv.indexOf("argv.length === 0") >= 0 && /什么都不执行/.test(srv),
      "★ 裸命令只打指引,不进任何画面");
    const bare = require("child_process").spawnSync(process.execPath,
      [path.join(__dirname, "server.js")], { encoding: "utf8", timeout: 15000 });
    assert.strictEqual(bare.status, 0, "裸命令正常退出");
    assert.ok(/coding agent 里使用/.test(bare.stdout) && /\/code-forge/.test(bare.stdout),
      "指引要指到聊天里的 /code-forge");
    // ★ 降级成 skill 同级之后,指引里**不再教任何 code-forge 命令** ——
    //   PATH 里没有这个名字,教了等于让人去敲一条不存在的命令。看过程零命令:
    //   直播窗口自动弹、网页地址开跑时给、诊断走一次性 npx。
    assert.ok(/自动弹出/.test(bare.stdout) && /localhost:4610|监控台/.test(bare.stdout),
      "指引要说清:直播自动弹、网页地址开跑时给（不教命令）");
    assert.ok(/npx /.test(bare.stdout), "诊断/更新走一次性 npx（不进 PATH）");
    assert.ok(!/code-forge watch/.test(bare.stdout) && !/code-forge usage/.test(bare.stdout),
      "★ 不许再教 code-forge 子命令 —— PATH 里没有这个名字");
    assert.ok(!/第 1 轮|提案者|run\.start/.test(bare.stdout),
      "★ 裸命令不许滚出任何事件 —— 那看起来就是「直接跑了」");
    assert.ok(!/对抗编程监控台/.test(bare.stdout), "也不许把 HTTP 服务起起来");
    assert.ok(srv.indexOf('argv[0] === "web"') >= 0 && srv.indexOf("argv.splice(0, 1)") >= 0,
      "web = 起监控台+弹浏览器,其余服务参数照常认");
    assert.ok(srv.indexOf('"mousetest"') >= 0, "mousetest 在分发表里");
    // 实跑:tui 子命令报移除信息并退出非零
    const r = require("child_process").spawnSync(process.execPath,
      [path.join(__dirname, "server.js"), "tui"], { encoding: "utf8", timeout: 15000 });
    assert.ok(/这条路移除了/.test(r.stderr), "实跑 tui 要看到移除说明");
    assert.strictEqual(r.status, 1, "并且退出码非零（脚本里用到旧命令要能炸出来）");
    assert.ok(srv.indexOf("410") >= 0 && srv.indexOf("/agent/run") >= 0,
      "★ /agent/run 要回 410 + 指路,老页面/脚本打过来不能装死");
    ok("★ 入口收窄：裸=只打指引、watch 显式要、tui/go=明确报移除、/agent/run=410");
  }

  /* ★ 裸命令的画面必须自我定性。
   *   watch 会先回放日志里的旧档案 —— 一屏历史事件滚出来,没有一行定性的话,
   *   看起来就像「code-forge 直接跑了一个回环」(实测被这么理解过,还专门来问)。 */
  {
    const tsrcB = fs.readFileSync(path.join(__dirname, "tui.js"), "utf8");
    assert.ok(/观察面:回放档案并接上直播/.test(tsrcB),
      "★ watch 入口要有定性行,而且**不分 TTY** —— 非 TTY 下滚出来的历史最像「跑了」");
    assert.ok(!/if \(process\.stdout\.isTTY\) \{\s*console\.log\(C\.dim\("观察面/.test(tsrcB),
      "定性行不许只在 TTY 下打");
    assert.ok(/这是已结束的档案/.test(tsrcB),
      "回环已结束时键位栏要标明是档案 —— 刚打开的人分不清「在跑」和「回放」");
    const readmeB = fs.readFileSync(path.join(__dirname, "README.md"), "utf8");
    assert.ok(/终端不需要认识它/.test(readmeB) && /自动弹出/.test(readmeB),
      "README 要写明:PATH 里没有这个命令,直播窗口自动弹、网页地址开跑时给");
    ok("★ 裸命令自我定性：观察面/回放/已结束档案都标出来（不再像「直接跑了」）");
  }

  /* ★ 开局之后的静默要有人说话。
   *
   * 实测(run.jsonl 里有实锤):loop_begin、round.start 都正常落了,然后执行者派子 agent
   * 干活 —— 第一条 loop_say 之前 5~15 分钟,直播上一条事件都没有。用户只能猜
   * 「是模型慢还是平台挂了」。三层堵:hostrun 看门狗、agentrun 起动心跳、技能要求派活先报。
   */
  {
    const evs = [];
    const h = require("./hostrun.js").create(function (e) { evs.push(e); });
    h.begin({ session: "s", task: "t", goal: { command: "node -e 0", cwd: process.cwd() },
      budget: { rounds: 5, seconds: 600 }, roles: [{ name: "实现者", kind: "propose" }],
      quietWarnMs: 60 });
    await new Promise(function (r) { setTimeout(r, 200); });
    const warns = function () {
      return evs.filter(function (e) {
        return e.t === "run.streaming" && /还没有任何角色发言/.test(e.text);
      }).length;
    };
    assert.ok(warns() >= 1, "★ 开局静默时看门狗要在直播里说话（空屏 + 无解释是最坏的等待）");
    assert.ok(/5~15 分钟正常/.test(evs.filter(function (e) {
      return e.t === "run.streaming"; })[0].text),
      "要说清这多半是正常的 —— 不然一句裸警告只会让人更慌");
    h.say({ role: "实现者", summary: "开工", body: "" });
    const n0 = warns();
    await new Promise(function (r) { setTimeout(r, 200); });
    assert.strictEqual(warns(), n0, "★ 第一条 loop_say 之后看门狗必须闭嘴");

    // （执行路线删了:agentrun 的起动心跳随它一起走;聊天路径的静默由上面的看门狗兜底）
    const skQ = fs.readFileSync(path.join(__dirname, "skills", "code-forge", "SKILL.md"), "utf8");
    assert.ok(/kind:"route"/.test(skQ) || /kind=route/.test(skQ),
      "技能要要求「派活之前先 loop_say 一条 route」—— 派出那一刻就是第一条事件");
    ok("★ 静默可解释：开局看门狗、执行者心跳、stderr 上直播、派活先报 route");
  }

  /* ★ 「像卡住了」的三个来源(用户实测报的),各钉一条:
   *   ① 事件行把 tok:null 画成 0.0k —— 拿不到 ≠ 0,那是假账观感;
   *   ② 直播窗口只在「刚拉起监控台」时弹 —— 常驻进程下第二次起永远不弹(上面 mcp 组已钉);
   *   ③ 看门狗只管第一条发言之前 —— 角色一干活十几分钟,页面全静止。 */
  {
    const html2 = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
    assert.ok(/if \(!tk\) return ""/.test(html2),
      "★ tok:null 不许画成 0.0k —— 「拿不到」和「真的是零」必须长得不一样");
    assert.ok(/return t === 0 \? "0"/.test(html2), "判据事件的真 0 显示「0」,不是 0.0k/0.0k");

    // 看门狗全程护航:发言之后的长静默也要报
    const evsW = [];
    const hw = require("./hostrun.js").create(function (e) { evsW.push(e); });
    hw.begin({ session: "s", task: "t", goal: { command: "node -e process.exit(1)", cwd: process.cwd() },
      budget: { rounds: 9, seconds: 600, noProgressRounds: 9 },
      roles: [{ name: "实现者", kind: "propose" }], quietWarnMs: 60 });
    hw.say({ role: "实现者", summary: "开工", body: "" });
    await new Promise(function (r) { setTimeout(r, 200); });
    assert.ok(evsW.some(function (e) { return e.t === "run.streaming" && /距上一条发言已/.test(e.text); }),
      "★ 发言之后的长静默也要有心跳 —— 角色一干活十几分钟,没心跳就是「像卡住了」");
    const n0 = evsW.filter(function (e) { return e.t === "run.streaming"; }).length;
    hw.say({ role: "实现者", summary: "又来", body: "" });
    await new Promise(function (r) { setTimeout(r, 70); });
    assert.ok(evsW.filter(function (e) { return e.t === "run.streaming"; }).length - n0 <= 1,
      "新发言要重置静默计时,不许攒着旧警告继续报");
    hw.end("stopped", "测试收尾");
    ok("★ 活着的样子：tok 拿不到不画 0、发言间隙有心跳、新发言重置计时、无观众才弹窗");
  }

  /* ★ 端口发现要能从「尸体」手里走出来。实测事故链(用户报「监控台起不来」):
   *   监控台被硬杀(exit 清理没跑)→ 端口文件指着死 pid → 发现机制永远打死端口 →
   *   每次都再拉新监控台 → 11 个僵尸把 4610~4620 占满 → 新进程重试 10 次饿死。
   *   而僵尸们 /health 全答 200 —— 明明可以复用。 */
  {
    const pf = path.join(os.tmpdir(), "code-forge-port.json");
    const had = fs.existsSync(pf) ? fs.readFileSync(pf, "utf8") : null;
    try {
      // 死 pid 的端口文件:不信、删掉、落回默认口(那里往往有活的监控台等着被复用)
      fs.writeFileSync(pf, JSON.stringify({ port: 4999, pid: 999999, startedAt: 1 }));
      assert.strictEqual(tui.discoverBase(), "http://localhost:4610",
        "★ 端口文件的 pid 死了就不信它 —— 信尸体的下场是永远打一个死端口");
      assert.ok(!fs.existsSync(pf), "★ 尸体文件要顺手删掉,别让下一个发现者再踩一遍");
      // 活 pid(用自己的)照常信
      fs.writeFileSync(pf, JSON.stringify({ port: 4777, pid: process.pid, startedAt: 1 }));
      assert.strictEqual(tui.discoverBase(), "http://localhost:4777", "pid 活着就照常信端口文件");
    } finally {
      if (had != null) fs.writeFileSync(pf, had);
      else { try { fs.unlinkSync(pf); } catch (_) {} }
    }
    const mcpP = fs.readFileSync(path.join(__dirname, "mcp.js"), "utf8");
    assert.ok(/process\.kill\(info\.pid, 0\)/.test(mcpP), "mcp 的发现机制也要验尸(同一事故链)");
    const srvP = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
    assert.ok(/listen\(START_PORT, 50\)/.test(srvP),
      "★ 端口重试预算 50 —— 实测 11 个历史监控台把 4610~4620 占满,10 次重试饿死了新进程");
    // 报错指引不许过期:裸 node server.js 只打指引不起服务,诊断要教带 web
    const tuiP = fs.readFileSync(path.join(__dirname, "tui.js"), "utf8");
    assert.ok(/web --no-open/.test(tuiP) && /裸跑只打指引/.test(tuiP),
      "★ 「监控台起不来」的指引要教 `node server.js web --no-open` —— 教裸跑等于教一条死路(用户照着跑过)");
    ok("★ 端口发现验尸后再信、尸体文件即删、重试预算 50、诊断指引不教死路");
  }

  /* ★ 不留僵尸监控台(用户指令:「关闭窗口就直接关闭」)。
   *   实测教训:常驻 + 分离的监控台攒了 11 个僵尸,把 4610~4620 占满,新进程全饿死。
   *   规则:没人看(SSE 观众 0)且没回环在跑,宽限期(默认 30s)一到就自灭;--stay 可常驻。 */
  {
    const { spawn } = require("child_process");
    const env2 = Object.assign({}, process.env, { CODE_FORGE_IDLE_MS: "400" });
    const c = spawn(process.execPath, [path.join(__dirname, "server.js"),
      "--no-open", "--port", "4661", "--no-port-file", "--file",
      path.join(os.tmpdir(), "cf-idle-" + process.pid + ".jsonl")], { env: env2 });
    let out = "";
    c.stdout.on("data", function (d) { out += d; });
    await new Promise(function (res) { c.on("close", res); setTimeout(res, 8000); });
    assert.notStrictEqual(c.exitCode, null, "★ 没人看且没回环 → 宽限期后必须自灭");
    assert.ok(/自灭/.test(out) && /--stay/.test(out), "退出时要说清为什么、以及怎么常驻");
    const srvI = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
    assert.ok(/host\.isActive\(\) \|\| run\.active/.test(srvI),
      "★ 回环在跑时绝不许自灭 —— 判定与记账都在这个进程里,死了回环就废了");
    assert.ok(/flag\("stay"\)/.test(srvI), "--stay 可以常驻(手动长期喂事件的人用)");
    assert.ok(/clients\.size > 0/.test(srvI), "有观众(直播窗口/网页)时不死 —— 关窗才走");
    ok("★ 监控台不留僵尸：没人看且没回环在跑 30s 自灭；回环在跑/有观众/--stay 不死");
  }

  /* ★ 烂尾档案补账。实测:执行者被中断(会话关闭)的那一局没有 run.end,
   *   回放停在「第 N 轮 · 进行中」—— 死去的回环伪装成还在跑,
   *   用户重开工具后问「是关掉了还在后台跑吗」。启动时补一条「中断」收尾:
   *   新进程的回环状态是空的,那一局必然不会在这里继续,补账是诚实的。 */
  {
    const f = path.join(os.tmpdir(), "cf-recon-t-" + process.pid + ".jsonl");
    fs.writeFileSync(f, JSON.stringify({ t: "run.start", session: "烂尾局", mode: "host" }) + "\n" +
      JSON.stringify({ t: "round.start", n: 2 }) + "\n");
    const { spawn } = require("child_process");
    const runOnce = function (port) {
      return new Promise(function (res) {
        const c = spawn(process.execPath, [path.join(__dirname, "server.js"),
          "--no-open", "--port", String(port), "--no-port-file", "--file", f],
          { env: Object.assign({}, process.env, { CODE_FORGE_IDLE_MS: "600" }) });
        let out = ""; c.stdout.on("data", function (d) { out += d; });
        c.on("close", function () { res(out); });
        setTimeout(function () { try { c.kill(); } catch (_) {} }, 8000);
      });
    };
    const o1 = await runOnce(4686);
    const tail = fs.readFileSync(f, "utf8").trim().split("\n").map(JSON.parse).pop();
    assert.strictEqual(tail.t, "run.end", "★ 烂尾档案启动即补收尾");
    assert.strictEqual(tail.reason, "interrupted", "原因单列 interrupted —— 不是达标也不是预算");
    assert.strictEqual(tail.rounds, 2, "补的收尾要带走到了第几轮");
    assert.ok(/伪装成进行中|补账/.test(tail.detail) || /补账/.test(o1), "要说清为什么补");
    const n1 = fs.readFileSync(f, "utf8").trim().split("\n").length;
    await runOnce(4687);
    assert.strictEqual(fs.readFileSync(f, "utf8").trim().split("\n").length, n1,
      "★ 已收尾的档案重启不重复补(幂等)");
    try { fs.unlinkSync(f); } catch (_) {}
    const tuiR = fs.readFileSync(path.join(__dirname, "tui.js"), "utf8");
    const htmlR = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
    assert.ok(/interrupted/.test(tuiR) && /interrupted/.test(htmlR),
      "两个观察面都要认 interrupted,显示成「中断…不是还在跑」");
    ok("★ 烂尾档案补「中断」收尾：死去的回环不再伪装成进行中（幂等,带轮数）");
  }

  /* ★ MCP 热重载:改完即生效,不再「重开会话才生效」。
   *   实测:用户会话里的 MCP 起于一天前,连着三轮反馈「还是弹 tui」——
   *   修的每一版都没到过他的进程。处理器与长活状态分离:每条消息进来先比对
   *   磁盘代码 mtime,更新了就清缓存重建处理器,向导状态(state)原样移交。 */
  {
    const { spawn } = require("child_process");
    const mcp2 = spawn(process.execPath, [path.join(__dirname, "server.js"), "--mcp"],
      { env: Object.assign({}, process.env, { CODE_FORGE_IDLE_MS: "60000", CODE_FORGE_VIEW: "none" }) });
    let buf2 = "", seq2 = 0, err2 = ""; const wait2 = {};
    mcp2.stderr.on("data", function (d) { err2 += d; });
    mcp2.stdout.on("data", function (d) {
      buf2 += d;
      let i;
      while ((i = buf2.indexOf("\n")) >= 0) {
        const l = buf2.slice(0, i); buf2 = buf2.slice(i + 1);
        if (!l.trim()) continue;
        try { const m = JSON.parse(l); if (wait2[m.id]) { wait2[m.id](m); delete wait2[m.id]; } } catch (_) {}
      }
    });
    const rpc2 = function (method, params) {
      return new Promise(function (res, rej) {
        const id = ++seq2; wait2[id] = res;
        setTimeout(function () { if (wait2[id]) rej(new Error(method + " 超时")); }, 10000);
        mcp2.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: id, method: method, params: params }) + "\n");
      });
    };
    try {
      await rpc2("initialize", {});
      const c1 = await rpc2("tools/call", { name: "loop_begin", arguments: {} });
      const tk = /"token": "(st-[a-z0-9]+)"/.exec(c1.result.content[0].text);
      assert.ok(tk, "向导第一步照常发 token");
      const now = new Date();
      fs.utimesSync(path.join(__dirname, "hostrun.js"), now, now);   // 只动 mtime,内容不变
      const c2 = await rpc2("tools/call", { name: "loop_begin",
        arguments: { token: tk[1], task: "热重载后状态仍在的测试目标" } });
      assert.ok(/已热重载/.test(err2), "★ 磁盘代码更新 → 下一条消息前热重载(不必重开会话)");
      assert.ok(/2\/3/.test(c2.result.content[0].text),
        "★ 向导状态跨重载存活 —— 重载换的是脑子,不是记忆");
    } finally { try { mcp2.kill(); } catch (_) {} }
    const mcpR = fs.readFileSync(path.join(__dirname, "mcp.js"), "utf8");
    assert.ok(/热重载失败,继续用旧代码/.test(mcpR),
      "★ 重载失败不许把会话搞死 —— 用旧代码继续,并把原因写到 stderr");
    assert.ok(/loaded = cur;\s*\/\/ 别每条消息都重试一遍失败/.test(mcpR),
      "失败后要记住这次 mtime,别每条消息都重试一遍失败");
    ok("★ MCP 热重载：改完即生效、状态跨重载存活、重载失败不搞死会话");
  }

  /* ★ 脉搏:tui 与网页都要有一个**不靠事件驱动**、每秒自转的标志(像 Claude Code 的转圈)。
   *   角色一干活十几分钟没有新事件是常态 —— 完全静止的画面和真卡死长得一模一样,
   *   实测被当成卡死问过两次。脉搏在动 = 页面活着;脉搏停了才是真出事。 */
  {
    const tuiP2 = fs.readFileSync(path.join(__dirname, "tui.js"), "utf8");
    assert.ok(/⠋/.test(tuiP2) && /pulseTimer = setInterval/.test(tuiP2),
      "★ tui 要有每秒自转的 spinner(自己的表,不等事件)");
    assert.ok(/最后事件/.test(tuiP2) && /lastEventAt = Date\.now\(\)/.test(tuiP2),
      "要带「最后事件 N 前」—— 光转圈说明页面活着,计时说明数据多久没来了");
    assert.ok(/quietSec > 300 \? C\.yellow/.test(tuiP2),
      "静默过久要变色 —— 「多半在干活」和「该去看看了」得分得开");
    assert.ok(/■ 档案/.test(tuiP2), "回环已结束就别转了 —— 档案没有「正在动」可言");
    const htmlP = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
    assert.ok(/id="pulse"/.test(htmlP) && /setInterval\(function\(\)\{\s*\n?\s*var el = document\.getElementById\("pulse"\)/.test(htmlP),
      "★ 网页同款:#pulse 每秒 JS 自转(CSS 动画不够 —— 它说明不了 JS 还活着)");
    assert.ok(/STORE\.lastEventAt = Date\.now\(\)/.test(htmlP), "网页也记最后事件时间");
    assert.ok(/ago > 300/.test(htmlP), "网页静默过久也变色");
    ok("★ 脉搏：tui/网页每秒自转 + 最后事件计时 + 静默变色 —— 静止画面不再和卡死同像");
  }

  /* ★ token 预算(首选不限) + 角色行的模型/token。
   *   只计**量得到的**部分(loop_agent 派的角色/评审者报的账) —— 聊天里子 agent 的用量
   *   在用户订阅上计不到,这是个下界闸,各处都要如实标注。 */
  {
    const evsT = [];
    const hT = require("./hostrun.js").create(function (e) { evsT.push(e); });
    hT.begin({ session: "s", task: "t", goal: { command: "node -e process.exit(1)", cwd: process.cwd() },
      budget: { rounds: 0, seconds: 600, noProgressRounds: 99, tokens: 100 },
      roles: [{ name: "实现者", kind: "propose" }, { name: "反驳者", kind: "attack" }],
      quietWarnMs: 999999 });
    const prT = require("./perrole.js");
    const realT = prT.runRole;
    prT.runRole = async function () {
      return { text: "反例:x", logs: [], exitCode: 0, wrote: false, stalled: false,
        usageEvents: [{ t: "usage", role: "反驳者", in: 60, out: 30, source: "stub" },
          { t: "usage", total: true, in: 60, out: 30, source: "stub" }] };
    };
    try {
      await hT.dispatch({ role: "反驳者", prompt: "挖" });
      const v1 = await hT.gate();
      assert.strictEqual(v1.remaining.tokens, 10,
        "★ total 汇总帧不许重复计(60+30 只算一次),remaining 要报剩余");
      await hT.dispatch({ role: "反驳者", prompt: "再挖" });
      const v2 = await hT.gate();
      assert.strictEqual(v2.stopReason, "budget_tokens", "★ 超了就停,原因单列 budget_tokens");
      assert.ok(/measurable share only/.test(require("./hostrun.js").REASONS.budget_tokens),
        "停止原因要如实标注这是下界闸(协调者可见的 label 是英文;用户看的翻译在观察面词典里)");
    } finally { prT.runRole = realT; }
    // 不限(0/不填)是首选
    const hT2 = require("./hostrun.js").create(function () {});
    hT2.begin({ session: "s", task: "t", goal: { command: "node -e process.exit(1)", cwd: process.cwd() },
      budget: { rounds: 2, seconds: 600 }, roles: [{ name: "a", kind: "propose" }], quietWarnMs: 999999 });
    assert.strictEqual((await hT2.gate()).remaining.tokens, null, "不填 = 不限,remaining 回 null");
    hT2.end("stopped", "t");
    // 观察面:预算行带 token 档;角色行模型永远在、token 量到显示/量不到**留空**
    // (用户点名:「没发言的不需要显示 token 不可得,显示空就可以了」)
    const stT = tui.newState();
    [{ t: "run.start", session: "s", mode: "host", goal: "g",
       budget: { rounds: 0, seconds: 7200, tokens: 500000 } },
     { t: "role.add", id: "r1", name: "实现者", model: "sonnet" },
     { t: "role.add", id: "r2", name: "反驳者", model: "opus" },
     { t: "usage", role: "反驳者", agent: "反驳者", model: "claude-opus-5", round: 1,
       in: 33800, out: 4200, msgs: 3, tools: {}, source: "claude" }
    ].forEach(function (e) { tui.reduce(stT, e); });
    const scr = tui.render(stT, 100);
    assert.ok(/token 500\.0k/.test(scr), "★ 预算行要显示 token 档");
    assert.ok(!/token 不可得/.test(scr), "★ 量不到的角色留空,不再写「token 不可得」(用户点名)");
    // 角色行首位数字:有 ctx 用末次上下文;这条老事件没 ctx → 退回含缓存合计(33.8k+4.2k=38.0k)
    assert.ok(/含缓存\s+38\.0k/.test(scr) && /4\.2k\s*↓/.test(scr) && /opus-5/.test(scr),
      "量到的角色显示模型 + 合计 + 出 token");
    const noTok = tui.render((function () {
      const s2 = tui.newState();
      tui.reduce(s2, { t: "run.start", session: "s", budget: { rounds: 8, seconds: 3600 } });
      return s2;
    })(), 100);
    assert.ok(/token 不限/.test(noTok), "不配就显示「token 不限」(首选)");
    // 配置卡与 schema
    const mcpT = fs.readFileSync(path.join(__dirname, "mcp.js"), "utf8");
    assert.ok(/token_budget/.test(mcpT) && /Unlimited \(Recommended\)/.test(mcpT),
      "★ 配置卡要有 token 预算题,首选不限");
    assert.ok(/tokens: \{ type: "number"/.test(mcpT) && /lower-bound gate/.test(mcpT),
      "schema 要写明 tokens 只计量得到的部分(下界闸)");
    ok("★ token 预算：首选不限、超了停 budget_tokens、不重复计汇总帧；角色行模型+token/量不到留空");
  }

  /* ★ 轮内顺序与「在等谁」。用户实测困惑:「查出 bug 后长时间没进入修改步骤」——
   *   其实实现者正在修(一改几分钟不发言),但心跳只报「距上一条发言 Ns」,没说在等谁;
   *   而挖-修类回合的轮内顺序(先修再复挖)也没写死,顺序反了会把没修的又数一遍。 */
  {
    const evsO = [];
    const hO = require("./hostrun.js").create(function (e) { evsO.push(e); });
    hO.begin({ session: "s", task: "修 bug",
      goal: { cwd: process.cwd(), metric: { name: "新bug数", source: "say", max: 0 }, streak: 3 },
      budget: { rounds: 0, seconds: 600, noProgressRounds: 99 },
      roles: [{ name: "实现者", kind: "propose" }, { name: "反驳者", kind: "attack" }],
      quietWarnMs: 60 });
    hO.say({ role: "反驳者", summary: "挖到 3 个:A/B/C", body: "", value: 3 });
    await new Promise(function (r) { setTimeout(r, 150); });
    const hb = evsO.filter(function (e) {
      return e.t === "run.streaming" && /距上一条发言/.test(e.text); }).pop();
    assert.ok(hb && /上一条:反驳者/.test(hb.text) && /挖到 3 个/.test(hb.text),
      "★ 心跳要说出上一条是谁说的 —— 「距上一条 Ns」不带主语等于没说");
    assert.ok(/在等实现者修/.test(hb.text),
      "★ 反驳者刚报完 → 心跳要点明「多半在等实现者修」,用户才知道静默是修不是卡");
    /* ★ 心跳要带 actor(大概在干活的角色 id)。实测:显示层只能靠「3 分钟内说过话」
     *   猜角色,长派发一过窗口角色名被摘掉,脉搏看起来挂在「第 N 轮」上(用户点名:
     *   「脉搏不是应该显示在正在动作的角色前面吗」)。上一条是反驳 → actor=实现者。 */
    assert.ok(hb.actor, "心跳要带 actor");
    {
      const tuiHB = require("./tui.js");
      const stHB = tuiHB.newState();
      evsO.filter(function (e) { return e.t !== "run.end"; }).forEach(function (e) { tuiHB.reduce(stHB, e); });
      const actLine = tuiHB.renderLines(stHB, 100, { spinFrame: "⠸", openEv: new Set() })
        .map(function (l) { return (l.text || "").replace(/\[[0-9;]*m/g, ""); })
        .filter(function (t) { return t.indexOf("⠸") >= 0; })[0] || "";
      assert.ok(/实现者 │/.test(actLine),
        "★ 脉搏行要钉在正在动的角色上(⠸ 实现者 │ …),不靠 3 分钟活跃窗口猜。实际:" + actLine);
    }
    const v = await hO.gate();
    assert.ok(/\(1\) the proposer fixes/.test(v.instruction) && /\(2\) the critic re-digs/.test(v.instruction),
      "★ 挖-修类未达标的 gate 指令要写死轮内顺序:先修再复挖 —— 反了会把没修的又数一遍");
    assert.ok(/Do not parallelize/.test(v.instruction), "并明说挖和修有依赖,别并发");
    hO.end("stopped", "t");
    const skO = fs.readFileSync(path.join(__dirname, "skills", "code-forge", "SKILL.md"), "utf8");
    assert.ok(/With dependencies, go serial/.test(skO) && /proposer fixes last round/.test(skO),
      "技能要写死挖-修类的轮内顺序(串行),并发只给互不依赖的角色");
    assert.ok(/report the moment fixing starts/.test(skO),
      "修的步骤开工要 loop_say —— 「挖出 bug 后长时间没动静」的困惑就是这么来的");
    ok("★ 轮内顺序:挖-修类先修再复挖(写死)、心跳带主语点明在等谁");
  }

  /* ★ 角色在动时看得见它在干什么(Claude Code TUI 同款)。
   *   loop_agent 派的角色/评审者是我们 spawn 的进程,stream-json 逐行流经手里 ——
   *   每条解析出的活动行(→ Read xxx / · 说了半句)节流后进 streaming 槽,
   *   tui 底部 ▸ 行与网页直播条实时更新。聊天里的 Task 子 agent活动在 Claude Code 自己的
   *   界面上可见,监控台拿不到 —— 边界如实。 */
  {
    const evsA = [];
    const hA = require("./hostrun.js").create(function (e) { evsA.push(e); });
    hA.begin({ session: "s", task: "t", goal: { command: "node -e process.exit(1)", cwd: process.cwd() },
      budget: { rounds: 3, seconds: 60 }, roles: [{ name: "实现者", kind: "propose" },
        { name: "反驳者", kind: "attack" }], quietWarnMs: 999999 });
    const prA = require("./perrole.js");
    const realA = prA.runRole;
    prA.runRole = async function (o) {
      for (let i = 0; i < 20; i++) { if (o.onActivity) o.onActivity("→ Read file" + i + ".js"); }
      return { text: "反例:x", logs: [], exitCode: 0, wrote: false, stalled: false, usageEvents: [] };
    };
    try {
      await hA.dispatch({ role: "反驳者", prompt: "挖" });
      const acts = evsA.filter(function (e) {
        return e.t === "run.streaming" && /反驳者 · /.test(e.text); });
      assert.strictEqual(acts.length, 1,
        "★ 活动要节流(20 条瞬时只放 1 条) —— 这些进 append-only 档案,刷密了淹日志");
      assert.ok(/→ Read file0\.js/.test(acts[0].text), "活动行原样带出(它此刻在干什么)");
      assert.strictEqual(acts[0].role, "role2", "带角色 id —— 网页直播条按它显示是谁在动");
    } finally { prA.runRole = realA; }
    hA.end("stopped", "t");
    // perrole/judge 都接了 onActivity;runRole 一条不落交出去,节流是调用方的事
    const prSrcA = fs.readFileSync(path.join(__dirname, "perrole.js"), "utf8");
    assert.ok(/opts\.onActivity/.test(prSrcA), "runRole 要逐行回调 onActivity");
    const jSrcA = fs.readFileSync(path.join(__dirname, "judge.js"), "utf8");
    // 只认「接了 onActivity」这个事实,不锁参数名(opts→o 这种重命名不该弄红这条)
    assert.ok(/\.onActivity/.test(jSrcA), "评审者在动时也要看得见");
    const hSrcA = fs.readFileSync(path.join(__dirname, "hostrun.js"), "utf8");
    assert.ok(/judgeActivity/.test(hSrcA), "runGate 给 judge 也接了活动流(文案走 i18n 词典)");
    ok("★ 角色实时活动：→ Read/Grep 逐行直播(1.5s 节流)、带角色名、评审者同款");
  }

  /* ★ 角色行三件事(用户实测点名):
   *   ① 模型名必须显示 —— 配置卡的模型题结果必须落到每个角色(向导校验拦没带的);
   *   ② token 尽量有账:独立进程自报 > loop_say 带的 tok > 才写「不可得」;
   *   ③ 正在干活的角色记号带脉搏动画。 */
  {
    // ① 向导:roles 不带 model → 点名缺
    const evsRP = [];
    const stRP = tui.newState();
    [{ t: "run.start", session: "s", mode: "host", goal: "g", budget: { rounds: 3, seconds: 60 } },
     { t: "role.add", id: "r1", name: "实现者", model: "sonnet" },
     { t: "role.add", id: "r2", name: "反驳者", model: "opus" },
     { t: "round.start", n: 1 },
     { t: "event", round: 1, role: "r1", kind: "propose", ts: "10:00:01", summary: "改",
       tok: { in: 12000, out: 3000 } }
    ].forEach(function (e) { tui.reduce(stRP, e); });
    // ② loop_say 带 tok 的角色显示数字,不写不可得
    const scrRP = tui.render(stRP, 100);
    assert.ok(/12\.0k↑/.test(scrRP), "★ loop_say 带的 tok 要进角色行 —— 只认独立进程的账,聊天路径永远「不可得」");
    assert.ok(/sonnet/.test(scrRP) && /opus/.test(scrRP), "模型名来自 role.add(配置卡落下来的)");
    // ③ activeRole:记号换 spinner 帧,行上带 pulseRole 标记(快帧靠它定位)
    const linesRP = tui.renderLines(stRP, 100, { activeRole: "r2", spinFrame: "⠸" });
    const rl = linesRP.filter(function (l) { return l.pulseRole; });
    assert.strictEqual(rl.length, 1, "★ 正在干活的角色行要带 pulseRole 标记");
    assert.ok(/⠸ 反驳者/.test(rl[0].text.replace(/\x1b\[[0-9;]*m/g, "")),
      "记号换成 spinner 帧 —— 「谁在动」在角色表上看得见");
    // 向导校验源码
    const mcpRP = fs.readFileSync(path.join(__dirname, "mcp.js"), "utf8");
    assert.ok(/roles\[\*\]\.model/.test(mcpRP),
      "★ 向导要求每个角色带 model —— 不落的话观察面只能显示「宿主模型」占位");
    // watch 侧接线 + web 侧同款
    const tuiRP = fs.readFileSync(path.join(__dirname, "tui.js"), "utf8");
    assert.ok(/activeRole = ev\.role/.test(tuiRP) && /pulseCells/.test(tuiRP),
      "watch 要跟踪谁在动,快帧统一刷所有脉搏格(底栏/角色记号/轮内活动行)");
    // ★ 展开的进行中轮要在聊天记录末尾挂实时活动行 —— 不用低头去底栏找「谁在干什么」
    const stLive = tui.newState();
    [{ t: "run.start", session: "s", mode: "host", budget: { rounds: 3, seconds: 60 } },
     { t: "role.add", id: "r1", name: "实现者", model: "sonnet" },
     { t: "round.start", n: 1 },
     { t: "run.streaming", role: "r1", text: "实现者 · → Edit x.py" }
    ].forEach(function (e) { tui.reduce(stLive, e); });
    const liveLines = tui.renderLines(stLive, 100, { spinFrame: "⠼" })
      .filter(function (l) { return l.pulseCol; });
    assert.strictEqual(liveLines.length, 1, "★ 进行中的轮要有带脉搏的实时活动行");
    const liveTxt = liveLines[0].text.replace(/\[[0-9;]*m/g, "");
    // ★ 左侧要有角色名(着色、│ 分隔),名字不重复 —— 「谁在动」不能让人从文本里猜(用户点名过)
    assert.ok(/实现者 │ → Edit x\.py/.test(liveTxt), "活动行 = 角色名 │ 动作,名字不重复");
    assert.ok(liveLines[0].inRound === 1 && !liveLines[0].round,
      "★ 活动行是聊天内容(inRound) —— 点它不许折叠这一轮(只有标题行可点)");
    // 展开轮的每一条聊天记录都不许可点:round 只留给标题行,hit 对照表只认 round
    const bodyLines = tui.renderLines(stLive, 100, {}).filter(function (l) { return l.inRound; });
    const headLines = tui.renderLines(stLive, 100, {}).filter(function (l) { return l.round; });
    assert.ok(bodyLines.length >= 1 && headLines.length === 1,
      "★ 点聊天内容触发折叠是误伤(用户点名过):内容行全走 inRound,标题行独占 round");
    const htmlRP = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
    assert.ok(/rolepulse/.test(htmlRP) && /STORE\.streamingAt/.test(htmlRP),
      "网页同款:正在动的角色行内 spinner 与页头脉搏同帧转");
    ok("★ 角色行：模型名必显(向导拦)、tok 三级账(独立进程>loop_say>留空)、活跃角色带脉搏");
  }

  /* ★ 每条聊天记录点开看细节(Claude Code 同款):body 全文/工具调用与结果/diff。
   *   点内容行的语义 = 展开那一条(不折叠整轮 —— 折叠只归标题行管)。 */
  {
    const stEV = tui.newState();
    [{ t: "run.start", session: "s", mode: "host", budget: { rounds: 3, seconds: 60 } },
     { t: "role.add", id: "r1", name: "实现者", model: "sonnet" },
     { t: "round.start", n: 1 },
     { t: "event", round: 1, role: "r1", kind: "patch", ts: "10:00:01", summary: "合并事务",
       body: "把 claim 与入账合并进单事务。",
       tool: { name: "Bash", args: { cmd: "pytest -q" }, result: "1 failed\nFAILED test_dup", status: "ok" },
       diff: { file: "payments/webhook.py", add: 12, del: 3, lines: "+ with tx:" } }
    ].forEach(function (e) { tui.reduce(stEV, e); });
    const closedEV = tui.renderLines(stEV, 100, {});
    const evLine = closedEV.filter(function (l) { return l.evKey; })[0];
    assert.ok(evLine && evLine.evKey === "1:0", "★ 聊天记录行要带身份(轮:序号),点击对照表靠它");
    assert.ok(/▸/.test(evLine.text), "收着时带 ▸ —— 「能点开」要看得出来");
    assert.ok(!closedEV.some(function (l) { return /FOR UPDATE|pytest -q/.test(l.text); }),
      "收着时不显示细节");
    const openEV = tui.renderLines(stEV, 100, { openEv: new Set(["1:0"]) })
      .filter(function (l) { return l.inRound === 1; })
      .map(function (l) { return l.text.replace(/\x1b\[[0-9;]*m/g, ""); }).join("\n");
    assert.ok(/→ Bash/.test(openEV) && /pytest -q/.test(openEV), "★ 展开要看到执行的命令与参数");
    assert.ok(/FAILED test_dup/.test(openEV), "命令结果尾部也要在(失败要看得见)");
    assert.ok(/± payments\/webhook\.py \+12 -3/.test(openEV), "diff 摘要与行");
    assert.ok(/把 claim 与入账合并进单事务/.test(openEV), "body 全文(折行)");
    // 什么都没带的条目直说,别让人以为展开坏了
    tui.reduce(stEV, { t: "event", round: 1, role: "r1", kind: "propose", ts: "10:01:01", summary: "光说" });
    const bare = tui.renderLines(stEV, 100, { openEv: new Set(["1:1"]) })
      .map(function (l) { return l.text.replace(/\x1b\[[0-9;]*m/g, ""); }).join("\n");
    assert.ok(/只带了 summary/.test(bare), "空细节要直说");
    const tuiEV = fs.readFileSync(path.join(__dirname, "tui.js"), "utf8");
    assert.ok(/hitEv\[idx\]/.test(tuiEV) && /view\.openEv\.has\(k\)/.test(tuiEV),
      "★ watch 点击分两路:标题行折叠整轮,内容行展开那一条(索引已减去自校准偏移)");
    // ★ 内容行**惰性**(用户点名:Claude Code 同款) —— 只有条目行(角色名那行)能开合,
    //   点细节行不该有任何反应,不然想选中复制一段命令都会把块合上。
    const evLines = tui.renderLines(stEV, 100, { openEv: new Set(["1:0"]) })
      .filter(function (l) { return l.evKey === "1:0"; });
    assert.strictEqual(evLines.length, 1,
      "★ evKey 只在条目行上(细节行惰性),实际 " + evLines.length + " 行带 key");
    ok("★ 每条记录点开看细节：命令+参数+结果尾+diff+body；空细节直说；点击两路分明");
  }

  /* ★ 展开/收起要把那一行**钉在原屏幕位置**。
   *
   * 实测 bug:跟底模式下展开会把视图滚到底,被点的条目行往上跑 ——
   * 用户在同一个物理位置点第二下,点到的已经是细节行(惰性),体感就是「只能展开不能关闭」。
   * ⚠ 这个测试必须**在同一物理行点两下**:旧测试每次重新查行号,正因如此漏掉了这个 bug。
   */
  {
    const { spawn } = require("child_process");
    const { PassThrough } = require("stream");
    const fA = path.join(os.tmpdir(), "cf-anchor-" + process.pid + ".jsonl");
    const evA = [JSON.stringify({ t: "run.start", session: "s", mode: "host",
      budget: { rounds: 3, seconds: 600 } }),
      JSON.stringify({ t: "role.add", id: "r1", name: "实现者", model: "sonnet" }),
      JSON.stringify({ t: "round.start", n: 1 })];
    for (let i = 1; i <= 20; i++) {
      evA.push(JSON.stringify({ t: "event", round: 1, role: "r1", kind: "patch",
        ts: "10:00:" + String(i).padStart(2, "0"), summary: "第 " + i + " 条",
        body: "细节" + i + "-A\n细节" + i + "-B\n细节" + i + "-C" }));
    }
    fs.writeFileSync(fA, evA.join("\n") + "\n");
    const conA = spawn(process.execPath, [path.join(__dirname, "server.js"),
      "--no-open", "--port", "4713", "--no-port-file", "--file", fA],
      { env: Object.assign({}, process.env, { CODE_FORGE_IDLE_MS: "60000" }) });
    await new Promise(function (res) {
      conA.stdout.on("data", function (d) { if (/监控台/.test(String(d))) res(); });
      setTimeout(res, 6000);
    });
    const inA = new PassThrough();
    inA.isTTY = true; inA.setRawMode = function () { return this; };
    const realIn = Object.getOwnPropertyDescriptor(process, "stdin");
    Object.defineProperty(process, "stdin", { value: inA, configurable: true });
    const realWrite = process.stdout.write, realTTY = process.stdout.isTTY;
    const realCols = process.stdout.columns, realRows = process.stdout.rows;
    const frames = [];
    process.stdout.isTTY = true; process.stdout.columns = 100; process.stdout.rows = 30;
    process.stdout.write = function (c) {
      const s = String(c);
      if (s.indexOf("\x1b[H") === 0) frames.push(s);   // 一帧的内容段(不清屏,见 tui.paint)
      return true;
    };
    try {
      delete require.cache[require.resolve("./tui.js")];
      const tuiA = require("./tui.js");
      tuiA.watch("http://localhost:4713", {});
      const wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
      const rowsOf = function () {
        // CSI 一律剥掉(SGR 之外还有 H/K/J:定位、擦行、擦到屏尾)
        return frames[frames.length - 1].replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").split("\n");
      };
      const click = function (row) { inA.emit("data", Buffer.from("\x1b[<0;5;" + row + "M")); };
      await wait(1200);
      const target = rowsOf().findIndex(function (l) { return l.indexOf("第 18 条") >= 0; }) + 1;
      assert.ok(target > 0, "先要能看到那一条(跟底模式下最新的在视口里)");
      click(target);
      await wait(300);
      assert.ok(rowsOf().some(function (l) { return l.indexOf("细节18-A") >= 0; }), "第一次点击要展开");
      assert.ok((rowsOf()[target - 1] || "").indexOf("第 18 条") >= 0,
        "★ 展开后那一行必须还钉在原来的物理行 —— 跑掉了用户就点不着它了");
      click(target);   // ★ 同一物理位置(用户的真实动作)
      await wait(300);
      assert.ok(!rowsOf().some(function (l) { return l.indexOf("细节18-A") >= 0; }),
        "★ 同一物理位置再点必须收起(这就是「只能展开不能关闭」的复现点)");
    } finally {
      process.stdout.write = realWrite; process.stdout.isTTY = realTTY;
      process.stdout.columns = realCols; process.stdout.rows = realRows;
      Object.defineProperty(process, "stdin", realIn);
      try { conA.kill(); } catch (_) {}
      try { fs.unlinkSync(fA); } catch (_) {}
      delete require.cache[require.resolve("./tui.js")];
    }
    const tuiAn = fs.readFileSync(path.join(__dirname, "tui.js"), "utf8");
    assert.ok(/const anchorTo = function/.test(tuiAn), "要有 anchorTo");
    assert.strictEqual((tuiAn.match(/anchorTo\(hit|anchorTo\(k,/g) || []).length, 2,
      "★ 条目展开与轮次折叠**都**要锚定(两处调用点)");
    assert.ok(/stickBottom = false/.test(tuiAn.slice(tuiAn.indexOf("const anchorTo"))),
      "锚定时要退出跟底 —— 用户在查看,不该被新事件拽到底");
    ok("★ 展开/收起锚定：那一行钉在原屏幕位置，同一物理位置再点能收起（复现即回归）");
  }

  /* ★ 屏幕行 ↔ 内容行的偏移必须**自校准**,不许假设。
   *
   * 实测 bug(用户连报两次):点第一句聊天却折叠了整轮 —— 轮标题正是它上面那行,
   * 说明点击区域整体错开一行。成因随终端/scrollback 而变(旧模拟测试假设「内容第一行
   * = 屏幕第一行」,所以一直测不出来)。解法两层:
   *   ① 备用屏幕(alt screen):vim/less/Claude Code 的做法,坐标系干净、退出还原终端;
   *   ② 首帧发一次 DSR(ESC[6n)问光标真实行号,与预期比对得出偏移,之后点击都减掉它。
   */
  {
    const tuiC = fs.readFileSync(path.join(__dirname, "tui.js"), "utf8");
    const ESC = String.fromCharCode(27);
    assert.ok(tuiC.indexOf("[?1049h") >= 0, "★ 要切到备用屏幕(坐标系干净,不受 scrollback 干扰)");
    assert.strictEqual((tuiC.match(/\[\?1049l/g) || []).length, 3,
      "★ 退出要还原(quit + exit 兜底 + 崩溃兜底各一处)—— 不许把用户终端留在备用屏");
    assert.ok(tuiC.indexOf("[6n") >= 0 && /calibrated/.test(tuiC),
      "★ 首帧要问一次光标真实行号(DSR),只问一次");
    assert.ok(/rowOffset = Number\(dsr\[1\]\) - expectRow/.test(tuiC),
      "偏移 = 实际光标行 - 预期光标行");
    assert.ok(/row - 1 - rowOffset/.test(tuiC), "★ 点击索引要减掉偏移");
    assert.ok(/expectRow = lines\.length;/.test(tuiC),
      "★ 预期行号只算到**内容尾** —— 探针量的是「内容行 ↔ 屏幕行」,别把 footer 算进去");
    /* ★ 实测 bug(第三次报):探针发在整帧写完之后,而底部键位栏比任何内容行都长,
     *   终端一折行,量出来的偏移就多算一行 —— 点第 N 行,展开的却是上一行。
     *   footer 在内容下面,压根不影响点击对位。所以写入顺序必须是 内容 → DSR → footer。 */
    const probeAt = tuiC.indexOf("[6n", tuiC.indexOf("expectRow = lines.length;"));
    const footerAt = tuiC.indexOf("GL.rule.repeat(w)", tuiC.indexOf("expectRow = lines.length;"));
    assert.ok(probeAt > 0 && footerAt > probeAt,
      "★ DSR 探针要在 footer(分隔线 + 键位栏)写出去**之前**发 —— footer 折行会污染偏移");
    // 一行内容 = 一个屏幕行,这条等式是点击对位的地基:关掉自动折行,让终端截断而不是折行
    assert.ok(tuiC.indexOf("[?7l") >= 0,
      "★ 要关掉自动折行(DECAWM) —— 折出来的那一行会把下面所有行的行号顶下去一格");
    /* ★ 整屏重画不许清屏(用户报「最下面几行在闪」)。ESC[2J 把整屏擦白再画回来,
     *   一秒一帧就是肉眼可见的闪;逐行覆盖 + ESC[K/ESC[J 才是 less/vim 的做法。 */
    assert.ok(tuiC.indexOf("x1b[2J") < 0, "★ 不许清屏 —— 擦白再画就是闪");
    assert.ok(/const EL = "\\x1b\[K"/.test(tuiC) && tuiC.indexOf("[J") >= 0,
      "★ 逐行 ESC[K 擦尾 + 收尾 ESC[J 擦掉上一帧多出来的行(不然会留残影)");
    assert.strictEqual((tuiC.match(/\[\?7h/g) || []).length, 3,
      "★ 退出要把折行还回去(quit + exit 兜底 + 崩溃兜底各一处)");
    // DSR 响应不许被当成按键漏进按键分支(否则会触发莫名其妙的动作)
    const dataFn = tuiC.slice(tuiC.indexOf("const d = buf.toString"));
    assert.ok(dataFn.indexOf("dsr") < dataFn.indexOf("x03"),
      "★ DSR 响应要在按键分支**之前**吃掉");
    ok("★ 点击坐标自校准：备用屏幕 + 首帧 DSR 问偏移；DSR 不当按键（连报两次的错行 bug）");
  }

  // （向导确认屏删了,这组视觉纪律随之删除;watch 直播画面的宽度纪律仍在下面）

    /* ★ Codex 聊天里的 /code-forge 也要存在。
     *   实测这台机器上以前只注册了 MCP —— 入口(~/.codex/prompts/code-forge.md)根本没装,
     *   「跨宿主」在 Codex 聊天里是断的:工具在,门没有。
     *   内容要按 Codex 的现实裁,不是照抄 Claude Code 那份。 */
    assert.ok(/function codexPromptMarkdown/.test(inst), "★ install.js 要给 codex 装用户级 prompt");
    assert.ok(/\.codex.*prompts.*code-forge\.md|prompts", "code-forge\.md/.test(inst),
      "要写到 ~/.codex/prompts/code-forge.md（Codex 的用户级命令目录）");
    const cpAt = inst.indexOf("function codexPromptMarkdown");
    const cpMd = inst.slice(cpAt, inst.indexOf("const CODEX_PROMPT", cpAt));
    assert.ok(/exactly one thing/.test(cpMd) && /wait for the goal/.test(cpMd), "codex 版也要有空目标处理（等输入）");
    assert.ok(/numbered list/.test(cpMd) && !/AskUserQuestion/.test(cpMd),
      "★ codex 没有选项组件 —— 候选走编号列表,不许照抄 AskUserQuestion 那句");
    assert.ok(/yourself in turn/.test(cpMd), "codex 聊天没有子 agent —— 要写明自己按角色轮流发言");
    assert.ok(/which\("codex"\)/.test(inst.slice(inst.indexOf("function installCodexPrompt"))),
      "没装 codex 就不碰它的目录");
    ok("★ Codex 聊天入口装上了：内容按 Codex 现实裁（编号列表/轮流扮演/空目标拦）");
  }

  /* ★ loop_agent:替没有子 agent 的宿主派**独立进程**的角色。
   *
   * 这是「Codex 聊天里体感追平 Claude Code」的关键一块:同一个会话轮流扮演,
   * 反驳强度明显偏软(本项目反复写过的判断)。监控台跑在宿主沙箱外,
   * 它可以起进程 —— 隔离由它代劳:独立会话、可指定模型、attack/audit 工具层只读。
   */
  {
    const perroleMod = require("./perrole.js");
    const realRunRole = perroleMod.runRole;
    const calls = [];
    perroleMod.runRole = async function (o) {
      calls.push(o);
      return { text: "反例：并发窗口仍在\n细节…", logs: [], exitCode: 0,
        wrote: false, stalled: false,
        usageEvents: [{ t: "usage", role: o.role.name, in: 100, out: 20, source: "stub" }] };
    };
    try {
      const evs = [];
      const h = require("./hostrun.js").create(function (e) { evs.push(e); });
      h.begin({ session: "s", task: "修重复回调", goal: { command: "node -e 0", cwd: process.cwd() },
        budget: { rounds: 5, seconds: 600 },
        roles: [{ name: "实现者", kind: "propose" }, { name: "反驳者", kind: "attack" }] });

      const r = await h.dispatch({ role: "反驳者", prompt: "上一轮实现者改了 X，找反例" });
      assert.strictEqual(r.said, true, "结果要自动 loop_say —— 留痕不该依赖调用方记得再报");
      assert.ok(/反例/.test(r.text), "text 要原样带回");
      // ★ 红线在服务端拼,不信调用方会带
      assert.strictEqual(calls[0].role.permissionMode, "readOnly",
        "★ attack 角色必须走只读档（工具层约束,不是提示词请求）");
      assert.ok(/must not modify any file/.test(calls[0].prompt), "★ 反驳者的红线每次都要在提示词里");
      assert.ok(/修重复回调/.test(calls[0].prompt), "目标要带给独立进程（它看不见对话）");
      const said = evs.filter(function (e) { return e.t === "event" && e.role === "role2"; })[0];
      assert.ok(said && said.meta.executor === "dispatch", "留痕要标明是代派的");
      assert.ok(evs.some(function (e) { return e.t === "usage"; }), "★ 独立进程的用量要落账（这正是逐角色记账）");

      // 纪律:角色在 loop_begin 登记,不许临时发明;上下文必须带;没开局不许派
      assert.ok(/is not in this loop/.test((await h.dispatch({ role: "裁判", prompt: "x" })).error));
      assert.ok(/prompt must not be empty/.test((await h.dispatch({ role: "反驳者", prompt: "" })).error));
      const h2 = require("./hostrun.js").create(function () {});
      assert.ok(/No loop_begin yet/.test((await h2.dispatch({ role: "x", prompt: "y" })).error));

      // MCP 面:工具挂出来了、代理到 /host/agent、要求 role+prompt
      const TOOLS = require("./mcp.js").TOOLS;
      const la = TOOLS.filter(function (t) { return t.name === "loop_agent"; })[0];
      assert.ok(la, "★ MCP 要挂出 loop_agent");
      assert.deepStrictEqual(la.inputSchema.required, ["role", "prompt"], "role 和 prompt 必填");
      assert.ok(/standalone process/.test(la.description) && /auto-loop_say-ed/.test(la.description),
        "描述要说清:真隔离、结果自动留痕");
      assert.ok(/\*\*do not use this\*\*/.test(la.description),
        "★ Claude Code 有自己的 Task 子 agent —— 别绕到进程派发上,那更慢");
      const mcpSrc = fs.readFileSync(path.join(__dirname, "mcp.js"), "utf8");
      assert.ok(/loop_agent[\s\S]{0,200}\/host\/agent/.test(mcpSrc), "工具要代理到 /host/agent");
      const srvSrc = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
      assert.ok(/\/host\/agent/.test(srvSrc) && /host\.dispatch/.test(srvSrc), "端点要接到 hostrun.dispatch");

      // 入口指引:codex 的 /code-forge 用 loop_agent;SKILL 里退化顺序是 loop_agent → 轮流
      const instSrc2 = fs.readFileSync(path.join(__dirname, "install.js"), "utf8");
      assert.ok(/standalone processes via loop_agent/.test(instSrc2), "codex 的 /code-forge 要指向 loop_agent");
      const sk2 = fs.readFileSync(path.join(__dirname, "skills", "code-forge", "SKILL.md"), "utf8");
      assert.ok(sk2.indexOf("loop_agent") >= 0 && sk2.indexOf("loop_agent") < sk2.indexOf("playing roles yourself in turn"),
        "★ 无子 agent 的退化顺序:先 loop_agent（真隔离）,起不来才轮流扮演");
      ok("★ loop_agent：Codex 聊天里的角色也有真隔离（独立进程/只读档/逐角色记账/自动留痕）");
    } finally { perroleMod.runRole = realRunRole; }
  }

  // ★ dry-run 真的必须什么都不做 —— 这里踩过:探测与注册写在一起,`--dry-run` 把 MCP 真装了
  const cliFn = /function tryClaudeCli\(\)[\s\S]*?\n}/.exec(inst)[0];
  const dryGuard = cliFn.indexOf("if (DRY)");
  const firstWrite = cliFn.indexOf("execFileSync(\"claude\", [\"mcp\"");
  assert.ok(dryGuard >= 0, "tryClaudeCli 必须有 DRY 分支");
  assert.ok(dryGuard < firstWrite, "DRY 分支必须在任何 mcp 写操作之前返回");
  ok("★ --dry-run 在任何 MCP 写操作之前就返回（不产生副作用）");

  // ★ files 漏一个 require 得到的模块 = 装出去就是坏包,而且要等到用户第一次调用才炸。
  //   这里踩过一次:tui/agentrun/agentcli/gatesuggest 四个全漏了。
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));
  const needed = new Set();
  fs.readdirSync(__dirname).filter((f) => f.endsWith(".js")).forEach(function (f) {
    const s = fs.readFileSync(path.join(__dirname, f), "utf8");
    const re = /require\("\.\/([^"]+)"\)/g;
    let m;
    while ((m = re.exec(s))) needed.add(m[1]);
  });
  const missing = Array.from(needed).filter((n) => pkg.files.indexOf(n) < 0);
  assert.strictEqual(missing.length, 0, "package.json 的 files 漏了: " + missing.join(", "));
  assert.ok(pkg.bin && pkg.bin["code-forge"], "要有 bin,否则 npx 那条路走不通");
  ok("★ package.json 的 files 覆盖了所有本地 require（漏一个就是坏包）");

  // 一键安装那条路:子命令要能走通,且从 npx 缓存里跑时不能把 MCP 指到临时目录
  const svr = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
  assert.ok(/argv\[0\] === "install"/.test(svr), "code-forge install 子命令");
  assert.ok(/"usage"/.test(svr) && /"watch"/.test(svr),
    "usage / watch 子命令还在（直播窗口和 npx 诊断走它们,不经 PATH）");
  assert.ok(/_npx/.test(inst) && /RUNTIME_DIR/.test(inst),
    "从 npx 缓存里跑时要把运行时复制出来 —— 缓存一清,MCP 指向的路径就没了");
  const mcpArgsFn = /function mcpArgs\(\)[\s\S]*?\n}/.exec(inst)[0];
  assert.ok(/RUNTIME/.test(mcpArgsFn) && !/HERE/.test(mcpArgsFn),
    "MCP 必须指向 RUNTIME（可能是副本），不能写死 HERE");
  ok("★ install/usage/go 子命令齐全；npx 那条路会先把运行时复制到 ~/.claude/code-forge");

  /* ★ （2026-08 降级）反转过来:装完 PATH 里**不许有** `code-forge`。
   *   终端不需要认识它 —— 直播窗口自动弹、网页地址开跑时给、诊断走一次性 npx。
   *   install 不但不放 bin,还要把旧版放进去的清掉(两种装法 unlink 与 rm -g 都要试:
   *   实测新版 npm 的 unlink 在没有 link 记录时直接报错,rm -g 必须无条件兜底)。 */
  const runSection = inst.split("/* ---------------- 跑")[1] || "";
  assert.ok(runSection.indexOf("installBin()") < 0,
    "★ install 流程里不许再调 installBin —— PATH 里不放 code-forge");
  assert.ok(runSection.indexOf("removeBin()") >= 0,
    "★ install 与 uninstall 都要清旧版装的 bin");
  const rmAt = inst.indexOf("function removeBin()");
  const rmFn = inst.slice(rmAt, inst.indexOf("function ", rmAt + 10));
  assert.ok(rmFn.indexOf("unlink") >= 0 && rmFn.indexOf('"rm", "-g"') >= 0,
    "两种装法(link/-g)都要清");
  assert.ok(inst.indexOf("npm-cli.js") >= 0, "要用当前 node 跑 npm-cli.js");
  assert.ok(inst.indexOf("shell: true") < 0, "不许开 shell:true（路径里一个 & 就变两条命令）");
  ok("★ PATH 里不放 code-forge（终端不需要认识它）,且旧版装的会被清掉");
}

/* ==================================================================
 * 逐 agent 用量
 *
 * 这一层最容易出的错都是**假账**:重复计数、把子 agent 的账记到协调者头上、
 * 报不出成本时编一个、以及反过来 —— 明明报得出却继续说「不可得」。
 * 下面每一条钉的都是其中一种。
 * ================================================================== */
/* ---------------- 聊天那条路的真模型/真用量（读 Claude Code 的子 agent 档案） ---------------- */
/**
 * 用户实测抱怨两句:「角色没有显示什么模型」「token 显示不可得」。
 * 成因不在显示层 —— 聊天里驱动时 roles[*].model 只有占位、也确实没人报账。
 * 但 Claude Code **自己把每个子 agent 存了档**(模型 + 逐条 usage),那才是真数。
 * 这一组钉住读档案的四条纪律:去重、分界、增量、不是我们的活不算。
 */
async function testChatUsage() {
  console.log("\n【聊天路径的真模型与真用量】");
  const cu = require("./chatusage.js");
  const roles = [{ name: "实现者", kind: "propose" }, { name: "反驳者", kind: "attack" }];

  assert.strictEqual(cu.slugFor("C:\\Projects_GitHub_my\\code-forge"),
    "C--Projects-GitHub-my-code-forge",
    "★ 项目目录名的算法要跟 Claude Code 一致(非字母数字全换成 -),错一个字符就一条档案都找不到");

  const root = path.join(os.tmpdir(), "cf-chatusage-" + process.pid);
  const sub1 = path.join(root, "sess-1", "subagents");
  fs.mkdirSync(sub1, { recursive: true });
  const T0 = Date.parse("2026-08-19T00:00:00.000Z");
  const asst = function (id, ts, u, content) {
    return JSON.stringify({ type: "assistant", timestamp: ts,
      message: { id: id, model: "claude-opus-5", usage: u, content: content || [] } });
  };
  const U = function (i, o, cr, cw) {
    return { input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: cw };
  };
  const READ = [{ type: "tool_use", id: "b1", name: "Read" }];
  const critic = path.join(sub1, "agent-aaa.jsonl");
  fs.writeFileSync(path.join(sub1, "agent-aaa.meta.json"),
    JSON.stringify({ agentType: "forge-critic", description: "挖 MCP 与服务端 bug" }));
  fs.writeFileSync(critic, [
    asst("m_old", "2026-08-18T23:59:00.000Z", U(999, 999, 0, 0)),        // 开局之前的:不算
    asst("m_1", "2026-08-19T00:00:10.000Z", U(10, 5, 100, 20), READ),
    asst("m_1", "2026-08-19T00:00:11.000Z", U(10, 5, 100, 20), READ),    // 同一条消息的第二片
    JSON.stringify({ type: "assistant", timestamp: "2026-08-19T00:00:12.000Z",
      message: { id: "m_syn", model: "<synthetic>", usage: U(7, 7, 7, 7), content: [] } })
  ].join("\n") + "\n");
  // 用户在同一个目录下干的别的活 —— 一分钱都不该算到这次回环的角色头上
  fs.writeFileSync(path.join(sub1, "agent-zzz.meta.json"),
    JSON.stringify({ agentType: "general-purpose", description: "查一下别的东西" }));
  fs.writeFileSync(path.join(sub1, "agent-zzz.jsonl"),
    asst("m_x", "2026-08-19T00:00:20.000Z", U(500, 500, 500, 500)) + "\n");

  const p = cu.createPuller({ root: root, roles: roles, sinceMs: T0 });
  const first = p.pull(1);
  assert.strictEqual(first.length, 1,
    "★ 只认本回环的子 agent(general-purpose 那份不算),实际 " + first.length + " 条");
  const e = first[0];
  assert.strictEqual(e.role, "反驳者", "★ 描述里没点名字时,按 agentType 的 kind 认角色");
  assert.strictEqual(e.model, "claude-opus-5", "★ 模型取它自己写下来的那个(合成消息不是模型说的话)");
  assert.deepStrictEqual([e.in, e.out, e.cacheRead, e.cacheWrite], [10, 5, 100, 20],
    "★ 同一条消息的多个分片只能算一次(实测 25 行 assistant 只有 10 个 id —— 不去重账翻 2.5 倍);" +
    "开局之前的旧消息与合成消息都不算");
  assert.deepStrictEqual(e.tools, { Read: 1 }, "★ 工具块也按 id 去重");
  assert.strictEqual(e.msgs, 1, "★ 条数同样去重");

  assert.strictEqual(p.pull(1).length, 0,
    "★ 没有新增就不发事件(usage 在下游是累加语义,重发一次账就翻倍)");

  fs.appendFileSync(critic, asst("m_2", "2026-08-19T00:01:00.000Z", U(3, 4, 5, 6)) + "\n");
  const second = p.pull(2);
  assert.strictEqual(second.length, 1, "档案长了就该有新事件");
  assert.deepStrictEqual([second[0].in, second[0].out, second[0].cacheRead, second[0].cacheWrite],
    [3, 4, 5, 6], "★ 发的是**增量**不是总数");
  assert.strictEqual(second[0].round, 2, "增量记到拉取时的那一轮");

  // 同一个角色同时派好几份(三个反驳者各攻一片):账要合起来,不能只显示第一份
  const tui = require("./tui.js");
  const st = tui.newState();
  [{ t: "run.start", session: "s", mode: "host", budget: { rounds: 0, seconds: 60 } },
    { t: "role.add", id: "role2", name: "反驳者", model: "宿主模型" },
    { t: "usage", agent: "a1", role: "反驳者", model: "claude-opus-5", round: 1,
      in: 10, out: 20, cacheRead: 900, cacheWrite: 30 },
    { t: "usage", agent: "a2", role: "反驳者", model: "claude-opus-5", round: 1, in: 30, out: 40 }
  ].forEach(function (ev) { tui.reduce(st, ev); });
  const row = tui.renderLines(st, 100, {}).map(function (l) { return l.text; })
    .filter(function (x) { return x.indexOf("反驳者") >= 0; }).join(" ")
    .replace(/\x1b\[[0-9;]*m/g, "");
  assert.ok(row.indexOf("opus-5") >= 0,
    "★ 角色行要显示**量到的真模型**,而不是配置里那个「宿主模型」占位");
  /* ★ 首位数字用 **Claude Code 同口径**(in+out+缓存读写=1030)。实测:协调者屏上
   *   反驳者已 300k+,这边只显示 in+out 的 8k —— 两把尺子,被用户当成账错了。 */
  assert.ok(row.indexOf("含缓存") >= 0 && /1\.0k|1030/.test(row) && /0\.06k\s*↓/.test(row),
    "★ 角色行 = 含缓存总数(10+30+20+40+900+30) + 出 token(60→0.06k,小数字也带单位);" +
    "多份账都要加进来。实际:" + row);
  assert.ok(row.indexOf("不可得") < 0, "量到了就不许再写「token 不可得」");
  // ★ 直播画面不再有独立的用量区域(用户点名:「用量显示在角色后面就够了」)
  const fullScr = tui.renderLines(st, 100, {}).map(function (l) { return l.text; }).join("\n")
    .replace(/\x1b\[[0-9;]*m/g, "");
  assert.ok(fullScr.indexOf("agent 自己报的") < 0, "★ 用量区域从直播画面撤掉,数字只在角色行上");

  /* ★ 心跳先观察后推测(实测被问:「这不是直播吗,怎么还有猜测」):
   *   档案 mtime 新鲜 = 它正在写,这是事实;看不到才退回带「多半」的推测。 */
  {
    const root2 = path.join(os.tmpdir(), "cf-act-" + process.pid);
    const sub2 = path.join(root2, "s1", "subagents");
    fs.mkdirSync(sub2, { recursive: true });
    const mkAgent = function (id, type, freshMs) {
      fs.writeFileSync(path.join(sub2, id + ".meta.json"), JSON.stringify({ agentType: type, description: "x" }));
      const f = path.join(sub2, id + ".jsonl");
      fs.writeFileSync(f, "{}" + String.fromCharCode(10));
      const t = new Date(Date.now() - freshMs);
      fs.utimesSync(f, t, t);
    };
    mkAgent("agent-fresh", "forge-critic", 5000);       // 5s 前还在写 → 正在干活
    mkAgent("agent-stale", "forge-proposer", 999000);   // 早停了 → 不算
    mkAgent("agent-alien", "general-purpose", 1000);    // 别人的活 → 不算
    const pAct = cu.createPuller({ root: root2,
      roles: [{ id: "r1", name: "实现者", kind: "propose" }, { id: "r2", name: "反驳者", kind: "attack" }],
      sinceMs: Date.now() - 3600000 });
    const act = pAct.activity(150000);
    assert.strictEqual(act.length, 1, "只有新鲜的本回环子 agent 算正在干活");
    assert.strictEqual(act[0].role, "反驳者", "按 kind 认回角色名");
    try { fs.rmSync(root2, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (_) {}
    const hostSrcA = fs.readFileSync(path.join(__dirname, "hostrun.js"), "utf8");
    assert.ok(/puller\.activity/.test(hostSrcA) && /quietWorking/.test(hostSrcA),
      "★ 心跳要先用档案观察(quietWorking,不带「多半」),观察不到才推测");
    const i18nSrcA = fs.readFileSync(path.join(__dirname, "i18n.js"), "utf8");
    assert.ok(/quietWorking/.test(i18nSrcA) && /正在干活/.test(i18nSrcA) && /is working/.test(i18nSrcA),
      "观察版心跳双语都要有");
    ok("★ 心跳先观察后推测：档案还在写=正在干活(事实)，看不到才带「多半」(推测标成推测)");
  }

  /* ★ 工具流:「掌控回环在做什么」那半边。
   *   心跳回答的是「还活着吗」(90s 才响一声),工具流回答的是「在干什么」(1s 级)。
   *   五条纪律,少一条这条流就没法信:
   *     ① 增量 —— 同一批行不许再播一遍;
   *     ② 半行不吃 —— agent 正在写,读一半会崩在 JSON.parse 上;
   *     ③ 偏移量按**字节**走 —— 中文一个字三字节,按字符算会一路错位;
   *     ④ 成功的结果不播、失败的要播 —— 单条结果 28KB,播全等于把面板灌满;
   *     ⑤ **不入档** —— 走 emit 不走 append(体积那笔账在 chatusage.createFeed 上)。 */
  {
    const NL = String.fromCharCode(10);
    const BS = String.fromCharCode(92);
    const root3 = path.join(os.tmpdir(), "cf-feed-" + process.pid);
    const sub3 = path.join(root3, "sess-f", "subagents");
    fs.mkdirSync(sub3, { recursive: true });
    const TF = Date.parse("2026-08-19T00:00:00.000Z");
    fs.writeFileSync(path.join(sub3, "agent-fff.meta.json"),
      JSON.stringify({ agentType: "forge-critic", description: "挖" }));
    const fFile = path.join(sub3, "agent-fff.jsonl");
    const asstF = function (ts, content) {
      return JSON.stringify({ type: "assistant", timestamp: ts,
        message: { id: "m" + ts, model: "claude-opus-5", content: content } });
    };
    const userF = function (ts, content) {
      return JSON.stringify({ type: "user", timestamp: ts, message: { content: content } });
    };
    fs.writeFileSync(fFile, [
      // 开局之前那一局留下的动作:同一个目录里躺着,一条都不许播
      asstF("2026-08-18T23:59:00.000Z", [{ type: "tool_use", id: "old", name: "Read", input: { file_path: "/a/old.js" } }]),
      // 思考块在档案里是空的(只有 signature)—— 播了就是一排空行
      asstF("2026-08-19T00:00:10.000Z", [{ type: "thinking", thinking: "", signature: "xx" }]),
      asstF("2026-08-19T00:00:11.000Z", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm  test" } }]),
      asstF("2026-08-19T00:00:11.500Z", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm  test" } }]),
      userF("2026-08-19T00:00:20.000Z", [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "Exit 1  boom" }]),
      userF("2026-08-19T00:00:21.000Z", [{ type: "tool_result", tool_use_id: "t2", content: "文件全文 400 行……" }]),
      asstF("2026-08-19T00:00:22.000Z", [{ type: "tool_use", id: "t3", name: "Read",
        input: { file_path: "C:" + BS + "x" + BS + "pay.js", offset: 88 } }])
    ].join(NL) + NL);

    const feed = cu.createFeed({ root: root3, roles: roles, sinceMs: TF });
    const f1 = feed.pull(3);
    assert.deepStrictEqual(f1.map(function (x) { return x.kind + ":" + (x.name || ""); }),
      ["tool:Bash", "err:", "tool:Read"],
      "★ 播的是动作:工具调用 + 失败的结果。思考空的不播、成功的结果不播(28KB 一条,播了只是灌满面板)、" +
      "上一局的不播、同一条消息的第二片不播 —— 实到 " + JSON.stringify(f1.map(function (x) { return x.kind; })));
    assert.strictEqual(f1[0].text, "npm test", "★ 一行一条:空白压成一格(几 KB 的命令会把画面顶烂)");
    assert.strictEqual(f1[2].text, "pay.js:88", "★ 长路径只留文件名 —— 整条 Windows 路径会把正文挤没");
    assert.strictEqual(f1[0].role, "反驳者", "★ 认角色跟账走同一套规矩,否则面板上的人和账上的人是两个");
    assert.strictEqual(f1[0].round, 3, "动作记在拉取时的那一轮 —— 观察面靠它换轮清屏");
    assert.strictEqual(feed.pull(3).length, 0, "★ ① 增量:没长就没有新动作(重播会让人以为它又跑了一遍)");

    // ② 半行:agent 正在写。读一半 JSON.parse 必崩,而这层崩了就等于直播黑屏
    fs.appendFileSync(fFile,
      '{"type":"assistant","timestamp":"2026-08-19T00:00:30.000Z","message":{"content":[{"type":"tool_u');
    assert.strictEqual(feed.pull(3).length, 0, "★ ② 半行留到下次,不吃也不崩");
    fs.appendFileSync(fFile, 'se","id":"t4","name":"Grep","input":{"pattern":"幂等|idempotent"}}]}}' + NL);
    const f2 = feed.pull(3);
    assert.ok(f2.length === 1 && f2[0].name === "Grep" && f2[0].text.indexOf("幂等") === 0,
      "★ 补齐了就立刻播出那一条(半行不能变成永久丢掉的一条)");
    // ③ 上一条带中文(一字三字节):偏移量若按字符算,这里开始就一路错位
    fs.appendFileSync(fFile, asstF("2026-08-19T00:00:40.000Z",
      [{ type: "tool_use", id: "t5", name: "Edit", input: { file_path: "/a/b/webhook.py" } }]) + NL);
    const f3 = feed.pull(3);
    assert.ok(f3.length === 1 && f3[0].name === "Edit" && f3[0].text === "webhook.py",
      "★ ③ 偏移量按字节走 —— 中文之后的那一条要完好地播出来,不是乱码也不是半句");

    // ④ 截断要说出来:悄悄丢掉会让面板看起来「一条没漏」
    const feedCap = cu.createFeed({ root: root3, roles: roles, sinceMs: TF, cap: 2 });
    const fc = feedCap.pull(3);
    assert.ok(fc.length === 3 && fc[0].kind === "skip" && fc[0].n >= 1,
      "★ 一拍里动作太多时留最新的几条,并明写「中间 N 条没跟上」(截断必须说出来)");
    try { fs.rmSync(root3, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (_) {}
  }

  /* ★ ⑤ 不入档:工具流走**易失**通道(emit),一条都不许进 run.jsonl。
   *   一份档案 400KB / 153 行,3 角色 × 8 轮 ~3700 条 —— 入档会同时压垮磁盘、
   *   服务端常驻的 log 数组(每个新客户端连上还要按 id 回放)和人眼(二十来条正式发言被埋)。 */
  {
    const NL = String.fromCharCode(10);
    const cfgDir = path.join(os.tmpdir(), "cf-feedcfg-" + process.pid);
    const workCwd = path.join(os.tmpdir(), "cf-feedwork-" + process.pid);
    const sub4 = path.join(cfgDir, "projects", cu.slugFor(workCwd), "s1", "subagents");
    fs.mkdirSync(sub4, { recursive: true });
    const oldCfg = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = cfgDir;
    const arch = [], live = [];
    const sink = function (bin) {
      return function (e) { (Array.isArray(e) ? e : [e]).forEach(function (x) { bin.push(x); }); };
    };
    const hf = require("./hostrun.js").create(sink(arch), sink(live));
    hf.begin({ session: "s", cwd: workCwd, lang: "zh", quietWarnMs: 999999, feedMs: 60,
      budget: { rounds: 3, seconds: 60 },
      roles: [{ id: "r1", name: "实现者", kind: "propose", model: "sonnet" },
              { id: "r2", name: "反驳者", kind: "attack", model: "opus" }] });
    // begin 之后才落的档案 —— 时间戳必须晚于开局,否则按规矩就该被当成上一局的
    fs.writeFileSync(path.join(sub4, "agent-live.meta.json"),
      JSON.stringify({ agentType: "forge-critic", description: "反驳者①" }));
    fs.writeFileSync(path.join(sub4, "agent-live.jsonl"),
      JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(),
        message: { id: "mlive", model: "claude-opus-5",
          content: [{ type: "tool_use", id: "L1", name: "Grep", input: { pattern: "event_id", path: "/a/pay.js" } }] } }) + NL);
    await new Promise(function (r) { setTimeout(r, 400); });
    hf.end("abandoned", "测完");
    if (oldCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = oldCfg;
    try { fs.rmSync(cfgDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (_) {}

    const fed = live.filter(function (e) { return e.t === "feed"; });
    assert.ok(fed.length >= 1, "★ 工具流要真的推出来(易失通道) —— 实到 " + live.length + " 条易失事件");
    assert.ok(!arch.some(function (e) { return e.t === "feed"; }),
      "★ ⑤ 一条都不许进档案:run.jsonl 是那二十来条正式发言的地方,不是日志桶");
    assert.strictEqual(fed[0].name, "Grep",
      "★ name 是**工具名** —— 写角色名进去,面板每行都会变成「反驳者 反驳者」而工具名没了");
    assert.ok(fed[0].role === "r2" && fed[0].actor === "r2",
      "★ 档案认出来的是角色名,推出去必须换成 id:颜色和脉搏都挂在 id 上");

    const srvSrc = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
    const emitBody = srvSrc.slice(srvSrc.indexOf("function emit("), srvSrc.indexOf("/* ---------------- HTTP"));
    assert.ok(emitBody.indexOf('"data: "') >= 0 && emitBody.indexOf('"id: "') < 0,
      "★ 易失帧不许带 id: —— SSE 的 id 就是档案下标,带了会顶走 Last-Event-ID,重连回放就缺一段");
    assert.ok(/create\(append, emit\)/.test(srvSrc), "工具流要接上易失通道");
    const hostSrcF = fs.readFileSync(path.join(__dirname, "hostrun.js"), "utf8");
    assert.ok(/emit\.wanted/.test(srvSrc) && /emit\.wanted && !emit\.wanted\(\)/.test(hostSrcF),
      "★ 没人在看就不去读档案 —— 回环跑一小时、人看几分钟是常态,无观众时连 readdir 都不应该发生");
    ok("★ 工具流：档案里读得到的动作 1s 级直播（增量/半行/字节偏移/失败才播），且一条不入档");
  }

  /* ★ 两个观察面一致(用户点名):工具流 TUI 与网页都要有,且只在进行中的轮里画。 */
  {
    const NL2 = String.fromCharCode(10);
    const tuiF = require("./tui.js");
    const stF = tuiF.newState();
    [{ t: "run.start", session: "s", mode: "host", lang: "zh", budget: { rounds: 3, seconds: 60 } },
     { t: "role.add", id: "r2", name: "反驳者", model: "opus" },
     { t: "round.start", n: 1 },
     { t: "feed", round: 1, role: "r2", actor: "r2", kind: "tool", name: "Grep", text: "event_id  pay.js" },
     { t: "feed", round: 1, role: "r2", actor: "r2", kind: "err", text: "Exit 1  同一 event_id 又入账了" }
    ].forEach(function (e) { tuiF.reduce(stF, e); });
    const flatF = function () {
      return tuiF.renderLines(stF, 100, { open: 1, sel: 1 })
        .map(function (l) { return (l.text || "").replace(/\x1b\[[0-9;]*m/g, ""); }).join(NL2);
    };
    const shown = flatF();
    assert.ok(/反驳者 │ → Grep event_id/.test(shown),
      "★ 工具行 = 角色名 │ → 工具 参数(「谁在动」不许让人从正文里猜)");
    assert.ok(/✗ Exit 1/.test(shown), "★ 失败的结果要显眼 —— 卡在跑不通的命令上最该被一眼看见");
    assert.strictEqual(stF.unknown, 0, "工具流不许被当成认不出的事件");
    tuiF.reduce(stF, { t: "feed", round: 2, role: "r2", actor: "r2", kind: "tool", name: "Read", text: "pay.js" });
    assert.ok(stF.feed.length === 1 && stF.feedRound === 2,
      "★ 换轮整批扔:上一轮的 Grep 留在屏上会让人以为它还在找");
    tuiF.reduce(stF, { t: "round.end", n: 2, winner: "未达标" });
    tuiF.reduce(stF, { t: "run.end", reason: "abandoned", rounds: 2 });
    assert.ok(!/→ Read/.test(flatF()),
      "★ 局散了就不画 —— 这条流不入档,回放旧档案时它本来就不存在,留在屏上等于假装还在动");

    const htmlF = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
    assert.ok(/case "feed"/.test(htmlF) && /STORE\.feedRound/.test(htmlF) && /FEED_ROWS/.test(htmlF),
      "网页同款:收工具流、按轮清屏、只画最近若干行");
    assert.ok(/isLive && STORE\.feed\.length/.test(htmlF),
      "★ 网页也只在进行中的轮里画工具流");
    const tuiSrcF = fs.readFileSync(path.join(__dirname, "tui.js"), "utf8");
    assert.ok(/ev\.t === "feed" && ev\.actor/.test(tuiSrcF),
      "★ 脉搏改吃观察:工具流的 actor 是「它的档案这一秒真的在长」,比按上一条发言推的准");
    ok("★ 工具流两面一致：TUI/网页都画、只画进行中的轮、换轮清屏、脉搏跟着观察走");
  }


  /* ★ 两个观察面功能一致(用户点名):分歧详情与补丁台账 TUI 也要看得到。 */
  {
    const tuiC2 = require("./tui.js");
    const stC = tuiC2.newState();
    [{ t: "run.start", session: "s", mode: "host", budget: { rounds: 3, seconds: 60 } },
     { t: "role.add", id: "r1", name: "实现者", model: "sonnet" },
     { t: "role.add", id: "r2", name: "反驳者", model: "opus" },
     { t: "round.start", n: 1 },
     { t: "event", round: 1, role: "r1", kind: "propose", ts: "10:00:01", summary: "改" },
     { t: "conflict", round: 1, sev: "HIGH", topic: "409 还是 200",
       a: "r2", aClaim: "409 会重投风暴", b: "r1", bClaim: "改 200 进队列", resolution: "反驳者复检中" },
     { t: "patch", round: 1, file: "webhook/handlers.py", add: 14, del: 5, by: "r1",
       note: "入口改 claim_event()", state: "被反证", st: "bad", tests: "tests 48/50" }
    ].forEach(function (e) { tuiC2.reduce(stC, e); });
    const flat = function (view) {
      return tuiC2.renderLines(stC, 100, view).map(function (l) { return (l.text || "").replace(/\[[0-9;]*m/g, ""); });
    };
    const closed = flat({ open: 1, openEv: new Set() }).join(String.fromCharCode(10));
    assert.ok(/\[HIGH\] 409 还是 200/.test(closed), "★ 分歧要有议题行(不再只是一个数)。实际:" + closed);
    assert.ok(closed.indexOf("409 会重投风暴") < 0, "详情惰性:没点开不展示");
    const opened = flat({ open: 1, openEv: new Set(["conf:1:0"]) }).join(String.fromCharCode(10));
    assert.ok(/反驳者 │ 409 会重投风暴/.test(opened) && /实现者 │ 改 200 进队列/.test(opened),
      "★ 点开分歧 → 两边原话(角色名解析自 id)。实际:" + opened);
    assert.ok(/→ 反驳者复检中/.test(opened), "处置结果也要在");
    assert.ok(/± webhook\/handlers\.py \+14 -5 · 实现者/.test(opened) && /被反证/.test(opened),
      "★ 补丁台账(t:patch)TUI 也要渲染 —— 与网页代码演进同一份事实");
    const htmlP = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
    assert.ok(/r\.usage \? " · " \+ k1\(r\.usage\)/.test(htmlP),
      "★ 反向对齐:网页轮次列表也要带逐轮用量(TUI 早就有)");
    ok("★ 观察面对齐：TUI 可看分歧详情(点开式)与补丁台账；网页轮次带逐轮用量");
  }

  /* ⚠ Windows 上 rmSync 会撞 EBUSY/EPERM(刚读过的文件句柄还没释放,杀毒软件也插一手)——
   *   force 只吞 ENOENT,不管这些,于是 catch 一声不响地放过,tmp 里就攒下一堆
   *   cf-chatusage-<pid> / cf-feedcfg-<pid>(实测:一次跑剩一份,3 天攒了 31 份)。
   *   maxRetries/retryDelay 正是给这几个错误码准备的,重试几次就干净了。 */
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (_) {}
  ok("★ 聊天路径的账:按 id 去重、开局前的不算、别人的子 agent 不算、只发增量;角色行显示真模型与合计");

  /* ★ 轮内账按 **key(agent id)** 对,不按角色名。实测:三个反驳者并发,
   *   用量表「本轮」列三行全是第一份的 46/14.5k,工具列也一样 —— 按名字对全撞在第一份上。 */
  {
    const usage = require("./usage.js");
    const u2 = usage.reduceEvents([
      { t: "usage", agent: "c1", role: "反驳者", round: 1, in: 1, out: 100, tools: { Read: 9 } },
      { t: "usage", agent: "c2", role: "反驳者", round: 1, in: 2, out: 7, tools: { Grep: 2 } }
    ]);
    assert.ok(u2.rounds[0].agents.every(function (a) { return a.key; }), "轮内账要带 key");
    const tbl = require("./tui.js").renderUsage(u2, 1, 120).map(function (l) {
      return (typeof l === "string" ? l : l.text).replace(/\x1b\[[0-9;]*m/g, "");
    }).join("\n");
    assert.ok(/1\/0\.1k/.test(tbl) && /2\/7/.test(tbl),
      "★ 同名 agent 的本轮列要各是各的账,不许全显示第一份。实际:\n" + tbl);
    assert.ok(/Read×9/.test(tbl) && /Grep×2/.test(tbl),
      "★ 工具列同理 —— 各是各的。实际:\n" + tbl);
    /* ★ 合计行的口径:头号数字 = 各 agent **末次上下文**之和(Claude Code 同口径);
     *   缓存累计只能带着「计费口径」的解释降级摆 —— 两个方向都实测踩过
     *   (只报 in+out 被当漏账;报缓存累计 14M 被当账炸了「预计只有 1000k 上下」)。 */
    const u3 = usage.reduceEvents([
      { t: "usage", agent: "c1", role: "反驳者", round: 1, in: 1, out: 2,
        cacheRead: 500, cacheWrite: 40, ctx: 150000 }]);
    const head3 = require("./tui.js").renderUsage(u3, 1, 120).map(function (l) {
      return (typeof l === "string" ? l : l.text).replace(/\x1b\[[0-9;]*m/g, "");
    }).join("\n");
    assert.ok(/上下文 150\.0k（各 agent 末次之和,Claude Code 同口径）/.test(head3),
      "★ 合计头号数字 = 末次上下文之和(Claude Code 同口径)。实际:\n" + head3);
    assert.ok(/缓存重读累计 0\.5k（计费口径/.test(head3) && /缓存写累计 0\.04k/.test(head3),
      "★ 缓存累计必须带「计费口径」解释降级摆,不许当头号数字。实际:\n" + head3);
    // ctx 是快照:两次事件后取最新,不许累加
    const u4 = usage.reduceEvents([
      { t: "usage", agent: "c1", role: "反驳者", round: 1, in: 1, out: 2, ctx: 100000 },
      { t: "usage", agent: "c1", role: "反驳者", round: 2, in: 1, out: 2, ctx: 120000 }]);
    assert.strictEqual(u4.agents[0].ctx, 120000, "★ ctx 取最新快照,不累加");
    assert.strictEqual(u4.grand.ctx, 120000, "★ 合计的 ctx 同理");
  }

  // ★ 拉账不能只挂在 loop_say/gate/status 上:子 agent 一跑十几分钟,期间协调者一声不吭,
  //   角色行就一直「token 不可得」(实测)。静默看门狗每次心跳顺手拉一次。
  const hostSrc = fs.readFileSync(path.join(__dirname, "hostrun.js"), "utf8");
  assert.ok(/quietTimer = setInterval[\s\S]{0,700}pullChatUsage\(\)/.test(hostSrc),
    "★ 静默看门狗的心跳里要 pullChatUsage —— 角色干活期间账也得动");

  // ★ 网页排行与 TUI 同口径:排序/头号数字走 roleTot(优先末次上下文)
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  assert.ok(/function roleTot\(r\)/.test(html) && /ctxBy/.test(html),
    "★ 网页角色总数走 roleTot:优先末次上下文(Claude Code 同口径),老事件退回含缓存累计");
  assert.ok(/roleTot\(r\)/.test(html) && /tot0 = roleTot/.test(html),
    "★ 页头总计与左栏角色卡必须共用 roleTot —— 各算各的迟早再撞一次口径(实测 31.2k vs 10.65M 同屏)");

  /* ★ 图例必须顶得住条里真画的东西。
   *   踩过的:图例写着「输入/输出」,而两段实际分的是「真进出 / 上下文里的缓存」——
   *   两个口径(累计 vs 快照)相除出来的百分比谁也说不出是什么,读图的人无从发现。
   *   现在:上条 输入|输出(都来自 inTok/outTok),下条 缓存(cacheRead+cacheWrite),
   *   各自比最大值 —— 因为缓存比真进出大一两个量级(实测 1.53M vs 60.5k),
   *   同一把尺下输入输出只剩 1% 的细线,等于没画。 */
  assert.ok(/legIn:/.test(html) && /legOut:/.test(html) && /legCache:/.test(html),
    "★ 三段都要有名字:输入 / 输出 / 缓存(中英各一份)");
  assert.ok(/liveW \* r\.inTok \/ live/.test(html) && /wOut = Math\.max\(0, liveW - wIn\)/.test(html),
    "★ 「输入」段必须真来自 inTok、「输出」段是其余 —— 图例说什么,条里就得画什么");
  assert.ok(/wCache = \(cacheTok \/ maxCache\) \* 100/.test(html) && /maxCache = Math\.max/.test(html),
    "★ 缓存另起一条、另一把尺(比各角色里最大的缓存),否则真进出被压成看不见的细线");
  assert.ok(/legScale:/.test(html) && /两条各自比最大值/.test(html) && /each row scaled to its own max/.test(html),
    "★ 「两条各自比最大值」要写在图例上 —— 两把尺不说出来就是另一种误导");
  assert.ok(/liveTip:/.test(html) && /cacheTip:/.test(html) && /totTipCtx:/.test(html),
    "★ 三处 tooltip:两条各自的真数、大数字的口径(上下文快照,不是累加值)");

  /* ★ UI 预览要零回环可用(用户点名:每次看效果都要启动真回环,太费 token):
   *   preview 子命令 = 示例档案 + 私有端口 + 不抢全局端口文件;
   *   示例档案必须覆盖**新用量形状**(ctx 快照 + 缓存增量) —— 不覆盖,改用量 UI 还是得跑真回环。 */
  const srvPrev = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
  assert.ok(/argv\[0\] === "preview"/.test(srvPrev) &&
    /preview[\s\S]{0,900}--no-port-file/.test(srvPrev) && /preview[\s\S]{0,900}--demo/.test(srvPrev),
    "★ preview 子命令:--demo + --no-port-file + 私有端口,零模型调用地看两个观察面");
  const demoEvs = require("./demo.js").events();
  assert.ok(demoEvs.some(function (e) {
    return e.t === "usage" && e.ctx != null && e.cacheRead > 0 && e.agent && e.model;
  }), "★ 示例档案要带新用量形状(ctx 快照+缓存增量+agent id+模型) —— 预览才看得到账目区");
  const demoCritics = demoEvs.filter(function (e) { return e.t === "usage" && e.role === "反驳者"; });
  assert.ok(new Set(demoCritics.map(function (e) { return e.agent; })).size >= 2,
    "★ 示例里同名角色要有两个 agent —— 排行合并、轮内账分开这两条预览里才看得见");
  /* ★ 示例阵容必须是产品**现在**的样子(实测被问「demo 里怎么还有协调者」):
   *   实现者/反驳者/复核者 + 判据,没有协调者(它是宿主本身,不进角色表)。 */
  const demoRoles = demoEvs.filter(function (e) { return e.t === "role.add"; })
    .map(function (e) { return e.name; });
  assert.deepStrictEqual(demoRoles, ["实现者", "反驳者", "复核者", "判据"],
    "★ 示例角色 = 现役阵容(3 角色+判据),不许再出现协调者/裁判那套老剧本");
  assert.ok(demoEvs.some(function (e) { return e.role === "gate" && e.meta && e.meta.met === false; }),
    "★ 示例要有判据事件(meta.met) —— 判据走势区不覆盖,改它还得跑真回环");
  /* ★ 提示词全英文 + UI 语言跟用户对话(用户点名)。lang 从 loop_begin 进,
   *   落进 run.start,观察面词典按它取;事件里机器写的话由 i18n 表按回环 lang 出。 */
  {
    const i18nM = require("./i18n.js");
    assert.ok(i18nM.T("en").reasons.goal_met && i18nM.T("zh").reasons.goal_met,
      "i18n 双语表要齐(zh/en 停止原因)");
    assert.strictEqual(i18nM.T("nope"), i18nM.T("zh"), "认不出的 lang 落回 zh(旧档案默认)");
    const mcpL = fs.readFileSync(path.join(__dirname, "mcp.js"), "utf8");
    assert.ok(/lang: \{/.test(mcpL) && /langOf/.test(mcpL),
      "★ loop_begin 要收 lang,且能按目标文本自动判(CJK→zh)");
    const evsL = [];
    const hL = require("./hostrun.js").create(function (e) { evsL.push(e); });
    hL.begin({ session: "en run", task: "fix the webhook", lang: "en",
      goal: { command: "node -e 0", cwd: process.cwd() },
      budget: { rounds: 2, seconds: 60 },
      roles: [{ name: "proposer", kind: "propose" }, { name: "critic", kind: "attack" }],
      quietWarnMs: 999999 });
    const rsL = evsL.filter(function (e) { return e.t === "run.start"; })[0];
    assert.strictEqual(rsL.lang, "en", "★ run.start 要带 lang —— 观察面词典按它取");
    const gateRole = evsL.filter(function (e) { return e.t === "role.add" && e.id === "gate"; })[0];
    assert.strictEqual(gateRole.name, "Gate", "★ lang=en 时判据角色名等机器文案按英文出");
    const rd1 = evsL.filter(function (e) { return e.t === "round.start"; })[0];
    assert.strictEqual(rd1.title, "Round 1", "轮标题同理");
    hL.end("stopped", "t");
    // TUI/网页词典:en 表齐、run.lang 接线
    const tuiL = fs.readFileSync(path.join(__dirname, "tui.js"), "utf8");
    assert.ok(/function uiT\(lang\)/.test(tuiL) && /uiT\(run\.lang\)|uiT\(st\.run && st\.run\.lang\)/.test(tuiL),
      "★ TUI 标签走 uiT(run.lang)");
    const htmlL = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
    assert.ok(/function WT\(\)/.test(htmlL) && /STORE\.run && STORE\.run\.lang/.test(htmlL),
      "★ 网页标签走 WT()(STORE.run.lang)");
    ok("★ lang 全程贯通:loop_begin → run.start → 机器文案(i18n) → TUI/网页词典;默认回落 zh");
  }

  // ★ 网页的 k1 要有 M 档(tui.kfmt 同款)。含缓存口径下总数轻松上百万 ——
  //   实测「13980.0k」被当成数字算错了报 bug,其实只是格式化只认 k
  assert.ok(/function k1\(n\)\{[^\n]*1e6[^\n]*M/.test(html),
    "★ k1 缺 M 档:百万级 token 会打成「13980.0k」,像账错了");
}

async function testUsage() {
  console.log("\n【逐 agent 用量】");
  const usage = require("./usage.js");
  const tui = require("./tui.js");
  const A = require("./adapters.js");
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  // 用例喂的是**宿主的原始输出**,经适配器解析后进记账 —— 这样测的是真实那条路,
  // 而不是我们自己造的中间形状(中间形状对了、解析错了,照样一条都发现不了)
  const roleOf = usage.roleResolver([
    { name: "实现者", subagent: "forge-proposer" },
    { name: "反驳者·并发", subagent: "forge-critic" },
    { name: "反驳者·覆盖", subagent: "forge-critic" }
  ]);

  // ① 同一条 assistant 消息被拆成多个事件、每个都重复带同一份 usage
  let t = usage.createTracker({ roleOf: roleOf });
  const dup = { id: "msg_1", model: "claude-opus-4-5-20251101",
    usage: { input_tokens: 100, output_tokens: 50 } };
  t.ingestRaw(A.claude, { type: "assistant", parent_tool_use_id: null,
    message: Object.assign({}, dup, { content: [{ type: "text", text: "a" }] }) }, 1);
  t.ingestRaw(A.claude, { type: "assistant", parent_tool_use_id: null,
    message: Object.assign({}, dup, { content: [{ type: "tool_use", id: "tu_x", name: "Read" }] }) }, 1);
  let evs = t.flush();
  assert.strictEqual(evs.length, 1);
  assert.strictEqual(evs[0].in, 100, "同一个 message.id 的 usage 只能计一次");
  assert.strictEqual(evs[0].out, 50);
  assert.strictEqual(evs[0].tools.Read, 1, "工具块散在被拆开的事件里,要逐事件扫");
  ok("★ 同一条消息被拆成多个事件时用量只计一次（否则账翻倍）");

  // ② 子 agent 的账要落在子 agent 头上,靠 parent_tool_use_id
  t = usage.createTracker({ roleOf: roleOf });
  t.ingestRaw(A.claude, { type: "assistant", parent_tool_use_id: null, message: {
    id: "m1", model: "opus", usage: { input_tokens: 10, output_tokens: 5 },
    content: [
      { type: "tool_use", id: "tu_1", name: "Task",
        input: { subagent_type: "forge-proposer", description: "实现者：动手改" } },
      { type: "tool_use", id: "tu_2", name: "Task",
        input: { subagent_type: "forge-critic", description: "反驳者·并发：只查并发" } },
      { type: "tool_use", id: "tu_3", name: "Task",
        input: { subagent_type: "forge-critic", description: "反驳者·覆盖：只查入口" } }
    ] } }, 1);
  t.ingestRaw(A.claude, { type: "assistant", parent_tool_use_id: "tu_1", message: {
    id: "m2", model: "sonnet", usage: { input_tokens: 900, output_tokens: 120 },
    content: [{ type: "tool_use", id: "b1", name: "Edit" }] } }, 1);
  t.ingestRaw(A.claude, { type: "assistant", parent_tool_use_id: "tu_2", message: {
    id: "m3", model: "opus", usage: { input_tokens: 700, output_tokens: 80 }, content: [] } }, 1);
  t.ingestRaw(A.claude, { type: "assistant", parent_tool_use_id: "tu_3", message: {
    id: "m4", model: "opus", usage: { input_tokens: 600, output_tokens: 60 }, content: [] } }, 1);
  const red = usage.reduceEvents(t.flush());
  const byRole = {};
  red.agents.forEach(function (a) { byRole[a.role] = a; });
  assert.strictEqual(byRole["协调者"].in, 10, "协调者只认自己那份");
  assert.strictEqual(byRole["实现者"].in, 900);
  assert.strictEqual(byRole["实现者"].tools.Edit, 1);
  // 同一个 subagent 派出两个角色 —— 只有 Task 描述能把它们分开
  assert.strictEqual(byRole["反驳者·并发"].in, 700);
  assert.strictEqual(byRole["反驳者·覆盖"].in, 600);
  assert.strictEqual(red.grand.in, 10 + 900 + 700 + 600);
  ok("★ 用量按 parent_tool_use_id 落到各子 agent，同一 subagent 的多个角色按描述分开");

  // ②b ★ 派子 agent 的工具**不叫 Task**。实测这个版本的 Claude Code 用的是 `Agent`,
  //     而这里原本写死了 name==="Task" —— 于是每个子 agent 都掉进「认不出」那一档,
  //     一张按角色分的表变成一堆匿名行,而且看上去还挺正常。按 subagent_type 认才对。
  t = usage.createTracker({ roleOf: roleOf });
  t.ingestRaw(A.claude, { type: "assistant", parent_tool_use_id: null, message: {
    id: "n1", model: "opus", usage: { input_tokens: 1, output_tokens: 1 },
    content: [{ type: "tool_use", id: "tu_9", name: "Agent",
      input: { subagent_type: "forge-proposer", description: "实现者：动手" } }] } }, 1);
  t.ingestRaw(A.claude, { type: "assistant", parent_tool_use_id: "tu_9", message: {
    id: "n2", model: "sonnet", usage: { input_tokens: 42, output_tokens: 7 }, content: [] } }, 1);
  const named = usage.reduceEvents(t.flush()).agents
    .filter(function (a) { return a.role === "实现者"; })[0];
  assert.ok(named, "工具叫 Agent 时也要认出子 agent（按 subagent_type，不按工具名）");
  assert.strictEqual(named.in, 42);
  // 注释里可以提这段历史,但**代码里**不许再按工具名认 —— 先把注释行剥掉再查。
  // 解析在适配器里(读 subagent_type),记账在 usage.js 里(读归一化后的 subagent),
  // 两边都不许出现按工具名判断的分支。
  const strip = function (f) {
    return fs.readFileSync(path.join(__dirname, f), "utf8")
      .split("\n").filter(function (l) { return !/^\s*(\/\/|\*|\/\*)/.test(l); }).join("\n");
  };
  const adaptCode = strip("adapters.js");
  const usrcCode = strip("usage.js");
  assert.ok(/subagent:\s*\(c\.input && c\.input\.subagent_type\)/.test(adaptCode),
    "claude 适配器要从 input.subagent_type 取子 agent 类型");
  assert.ok(/if \(c\.subagent\)/.test(usrcCode), "记账那层按归一化后的 subagent 认");
  assert.ok(!/name === "Task"/.test(adaptCode) && !/name === "Task"/.test(usrcCode),
    "不许再按工具名认 —— 它改过一次名(Task→Agent),还会再改");
  ok("★ 按 subagent_type 认子 agent，不按工具名（实测这版叫 Agent 不叫 Task）");

  // ②c ★ 逐条 usage 的 output_tokens **不含 thinking**(实测:逐条报 7,result 报 71/其中 62 thinking)。
  //     所以逐 agent 那几行是下界。差额必须单列,不能硬凑成一致,也不能拿
  //     system/thinking_tokens 的 estimated_tokens 去补(那次估 131、实际 62,补出来更错)。
  t = usage.createTracker({ roleOf: roleOf });
  t.ingestRaw(A.claude, { type: "assistant", parent_tool_use_id: null, message: {
    id: "k1", model: "opus", usage: { input_tokens: 9, output_tokens: 7 }, content: [] } }, 1);
  const perAgent = t.flush();
  t.ingestRaw(A.claude, { type: "result", subtype: "success", total_cost_usd: 0.02,
    usage: { input_tokens: 9, output_tokens: 71,
      output_tokens_details: { thinking_tokens: 62 } } }, 1);
  const withThink = usage.reduceEvents(perAgent.concat([t.finalEvent()]));
  assert.strictEqual(withThink.grand.out, 7, "逐 agent 之和只有非 thinking 那部分");
  assert.strictEqual(withThink.reported.out, 71, "权威总数来自 result");
  assert.strictEqual(withThink.unattributedOut, 64, "差额要能算出来并显示");
  const rep = tui.usageReport(withThink, 100);
  assert.ok(/下界/.test(rep) && /thinking/.test(rep),
    "报告里必须说清那几行是下界,否则加起来对不上合计会被当成表算错了");
  // ★ 合计必须是**各行之和**,不许拿 result 里的数冒充总数。实测 result.usage 跟逐条
  //   求和对不上(in 19 vs 29、cacheRead 56789 vs 88551)且 iterations 只有一条 ——
  //   它不是全程的。挑它当合计,页面上就会出现一个「加不出来」的总数。
  assert.ok(/合计\s+9↑ \/ 7↓/.test(rep),
    "合计要等于各行之和(9/7),不是 result 里那个 71:\n" + rep.split("\n")[1]);
  assert.ok(/各行之和/.test(rep), "要写明合计的出处");
  assert.ok(/total_cost_usd/.test(rep), "成本要标明是 CLI 自报的那个字段");
  ok("★ 逐 agent 的 out 是下界（thinking 摊不到 agent），差额单列；合计是各行之和不是 result 那个数");

  // ②d MCP 工具全名会把「它在干什么」那一列整个占满 —— 实测协调者那行显示成
  //     `mcp__code-forge__loop_beg…`,后面几个工具全被截没了。只留最后一段。
  assert.strictEqual(usage.shortTool("mcp__code-forge__loop_begin"), "loop_begin");
  assert.strictEqual(usage.shortTool("Read"), "Read", "普通工具名不许动");
  assert.deepStrictEqual(usage.topTools({ "mcp__code-forge__loop_say": 2, Read: 5 }, 2),
    [["Read", 5], ["loop_say", 2]]);
  assert.ok(/mcp__\.\+__/.test(html), "监控台那侧也要缩,不然一行只看得见一个工具");
  ok("MCP 工具名只留最后一段（全名一条就把「在干什么」那列占满）");

  // ③ 跨轮不能混:「这一轮花了多少」是判断「还值不值得再来一轮」的依据
  t = usage.createTracker({ roleOf: roleOf });
  t.ingestRaw(A.claude, { type: "assistant", parent_tool_use_id: null,
    message: { id: "r1", model: "opus", usage: { input_tokens: 100, output_tokens: 10 }, content: [] } }, 1);
  t.ingestRaw(A.claude, { type: "assistant", parent_tool_use_id: null,
    message: { id: "r2", model: "opus", usage: { input_tokens: 200, output_tokens: 20 }, content: [] } }, 2);
  const two = usage.reduceEvents(t.flush());
  assert.strictEqual(two.rounds.length, 2);
  assert.strictEqual(two.rounds[0].agents[0].in, 100);
  assert.strictEqual(two.rounds[1].agents[0].in, 200);
  ok("每一轮各记各的账（同一个 agent 跨两轮不并成一条）");

  // ④ 成本只认 agent 自己报的。没报就是 null —— null ≠ 0
  t = usage.createTracker({ roleOf: roleOf });
  t.ingestRaw(A.claude, { type: "assistant", parent_tool_use_id: null,
    message: { id: "c1", model: "opus", usage: { input_tokens: 5, output_tokens: 5 }, content: [] } }, 1);
  assert.strictEqual(t.finalEvent(), null, "没有 result 就不许有汇总行");
  assert.strictEqual(usage.reduceEvents(t.flush()).costUsd, null, "没报成本就是 null,不是 0");
  t.ingestRaw(A.claude, { type: "result", subtype: "success", total_cost_usd: 0.5, num_turns: 3,
    usage: { input_tokens: 5, output_tokens: 5 } }, 1);
  assert.strictEqual(t.finalEvent().costUsd, 0.5);
  const src = fs.readFileSync(path.join(__dirname, "usage.js"), "utf8");
  assert.ok(!/0\.0000\d*\s*\*|pricePer|PRICE|价目/.test(src.replace(/价目表/g, "")),
    "usage.js 不许自带价目表去乘 —— 价格会变,乘出来的是编的");
  ok("★ 成本只用 agent 自己报的 total_cost_usd；没报就留 null，绝不查表乘一个出来");

  // ⑤ 一条 usage 都没有时不许画表(那是「没人报账」,不是「量过了是 0」)
  assert.deepStrictEqual(tui.renderUsage(usage.reduceEvents([]), 1, 100), [],
    "没有上报就一行都不画");
  const noneTxt = tui.usageReport(usage.reduceEvents([]), 100);
  /* ★ 老文案说「聊天里驱动那条路用量**确实拿不到**」——这句已经不成立了:
   *   Claude Code 把每个子 agent 单独存了档(模型 + 逐条 usage),chatusage.js 读得到。
   *   留着这句话比没有更糟:它会让人以为空表是天生如此,而不去查真正的原因。 */
  assert.ok(!/确实拿不到/.test(noneTxt),
    "★ 不许再说「聊天里那条路用量确实拿不到」—— 子 agent 的账现在读得到");
  assert.ok(/还没真的干过活/.test(noneTxt) && /子 agent 档案/.test(noneTxt),
    "零上报要说清可能的原因(角色还没干活 / 宿主没有这份档案 / 目录对不上)");
  ok("★ 零上报时不画假表，并说清几种「没有」的区别");

  // ⑥ 网页与 TUI 走同一套 reduce,且网页按名字认回角色(否则同名两行账)
  assert.ok(/case "usage"/.test(html), "监控台要认 usage 事件");
  assert.ok(/\.name === ev\.role/.test(html), "要按角色名认回已有角色,不能另开一行");
  assert.ok(/usageTotal/.test(html) && /STORE\.usageTotal = null/.test(html),
    "换一茬回环时成本汇总也要清掉");
  const tsrc = fs.readFileSync(path.join(__dirname, "tui.js"), "utf8");
  assert.ok(/usage\.js"\)\.reduceEvents|reduceEvents\(/.test(tsrc), "TUI 用共用的 reduce");
  ok("网页/TUI/usage 子命令共用同一套汇总语义");

  // ⑦ 真的把监控台那段 reducer 跑一遍。上面第⑥条只查了字面,而这里要钉的是**行为**:
  //    用量必须并进已有的那一行角色。多出一行同名的「实现者」,页面上是两条账,
  //    看起来还都合法 —— 这种错光看代码看不出来。
  const scriptSrc = /<script[^>]*>([\s\S]*?)<\/script>/.exec(html)[1];
  const grab = function (re) {
    const m = re.exec(scriptSrc);
    assert.ok(m, "index.html 里没抓到 " + re);
    return m[0];
  };
  const harness = [
    "var STORE = { run:null, roles:{}, roleOrder:[], rounds:[], byN:{}, streaming:null," +
      " ended:null, count:0, unknown:0, usageTotal:null };",
    "var FALLBACK_COLORS=['#111'];",
    "var state={round:null,follow:true,mode:'live',open:{},roleFilter:null};",
    "function refreshServer(){}",
    // 切片环境里也要有词典(ensureRound 的默认轮标题走 WT)
    grab(/var L10N = \{[\s\S]*?\n\};/),
    grab(/function WT\(\)\{[\s\S]*?\n?\}/) || "function WT(){ return L10N.zh; }",
    grab(/function ensureRole\(id\)\{[\s\S]*?\n\}/),
    grab(/function ensureRound\(n\)\{[\s\S]*?\n\}/),
    grab(/function applyEvent\(ev\)\{[\s\S]*?\r?\n\}\r?\n/),   // index.html 是 CRLF,\n 死板会抓空
    "return { STORE: STORE, applyEvent: applyEvent };"
  ].join("\n");
  const page = new Function(harness)();
  [
    { t: "run.start", session: "X" },
    { t: "role.add", id: "role1", name: "实现者", model: "sonnet" },
    { t: "round.start", n: 1 },
    { t: "usage", round: 1, role: "实现者", agent: "tu_1", model: "claude-sonnet-4-5",
      in: 8000, out: 1200, cacheRead: 45000, tools: { Edit: 4 } },
    { t: "usage", round: 1, role: "实现者", agent: "tu_1", in: 500, out: 100, tools: { Edit: 1 } },
    { t: "usage", round: 1, role: "协调者", agent: "coordinator", in: 1200, out: 340, tools: { Task: 3 } },
    { t: "usage", total: true, costUsd: 0.42 }
  ].forEach(page.applyEvent);
  assert.strictEqual(page.STORE.roleOrder.length, 2, "实现者不能多出一行同名的（应为 实现者 + 协调者）");
  assert.strictEqual(page.STORE.roles.role1.inTok, 8500, "用量要并进 role.add 建的那一行");
  assert.strictEqual(page.STORE.roles.role1.tools.Edit, 5);
  assert.ok(page.STORE.roles.coordinator, "协调者从不 loop_say,但它烧的 token 要单独一行");
  assert.strictEqual(page.STORE.unknown, 0, "usage 不能落进「认不出的事件」");
  assert.strictEqual(page.STORE.usageTotal.costUsd, 0.42);
  page.applyEvent({ t: "run.start", session: "第二次" });
  assert.strictEqual(page.STORE.usageTotal, null, "换一茬回环,上一次的成本不能留在页头");
  ok("★ 监控台 reducer 实跑：用量并进已有角色行、协调者单列、换茬清账");

  // （执行路线删了:agentrun 的 tracker 接线随它一起走;loop_agent 的用量落账在 dispatch 组测）
}

/* ==================================================================
 * 跨宿主：适配器 + doctor
 *
 * 这一层最容易出的错是**把没验过的当验过的**:参数按记忆写、写错了用户还以为是
 * 自己环境的问题。所以这里钉的不只是「能解析」,还有「诚实分级有没有被如实显示」。
 * ================================================================== */
async function testAdapters() {
  console.log("\n【跨宿主适配器】");
  const A = require("./adapters.js");
  const usage = require("./usage.js");
  const tui = require("./tui.js");

  // 契约:每个适配器该有的字段一个都不能少,否则 doctor / agentrun 会在运行时才炸
  A.all().forEach(function (a) {
    assert.ok(a.id && a.label && a.bin, "适配器要有 id/label/bin：" + JSON.stringify(a.id));
    assert.strictEqual(typeof a.buildArgs, "function", a.id + " 要有 buildArgs");
    assert.ok(Array.isArray(a.versionArgs), a.id + " 要有 versionArgs");
    assert.ok(typeof a.verified === "boolean", a.id + " 必须明确标 verified（诚实分级）");
    assert.ok(a.parse === null || typeof a.parse === "function", a.id + " 的 parse 要么没有要么是函数");
  });
  assert.ok(A.get("claude").verified && A.get("codex").verified, "这两个是实测过的");
  assert.ok(!A.get("gemini").verified, "没装过的宿主不许标成实测过");
  assert.ok(A.get("gemini").parse === null,
    "★ 输出格式没实测就不许假装能解 —— 解错了会得到一张看起来正常的错账");
  ok("★ 适配器契约齐全，且 verified 是如实标的（没验过的 parse 直接留空）");

  // claude:真实样本 → 逐子 agent 用量（这条路以前是写死的,现在要证明搬家没搬坏）
  let t = usage.createTracker({ roleOf: usage.roleResolver([{ name: "实现者", subagent: "forge-proposer" }]) });
  [
    { type: "assistant", parent_tool_use_id: null, message: { id: "m1", model: "opus",
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 2000 },
      content: [{ type: "tool_use", id: "tu_1", name: "Agent",
        input: { subagent_type: "forge-proposer", description: "实现者：动手" } }] } },
    { type: "assistant", parent_tool_use_id: "tu_1", message: { id: "m2", model: "sonnet",
      usage: { input_tokens: 900, output_tokens: 120 },
      content: [{ type: "tool_use", id: "b1", name: "Edit" }] } },
    { type: "result", subtype: "success", total_cost_usd: 0.5, usage: { input_tokens: 9, output_tokens: 71 } }
  ].forEach(function (m) { t.ingestRaw(A.claude, m, 1); });
  let r = usage.reduceEvents(t.flush().concat([t.finalEvent()]));
  let by = {};
  r.agents.forEach(function (a) { by[a.role] = a; });
  assert.strictEqual(by["实现者"].in, 900, "子 agent 的账落在子 agent 头上");
  assert.strictEqual(by["协调者"].in, 100);
  assert.strictEqual(r.costUsd, 0.5, "claude 报成本");
  ok("claude 适配器：真实样本 → 逐子 agent 用量 + 成本");

  // codex:真实样本（codex-cli 0.130.0 抄下来的形状）
  t = usage.createTracker({ soloLabel: "执行者" });
  [
    { type: "thread.started", thread_id: "01a00dab" },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "i0", type: "agent_message", text: "收到。" } },
    { type: "item.completed", item: { id: "i1", type: "command_execution" } },
    // 被宿主拦下的 MCP 调用:要看得出是**哪个工具**、以及它失败了
    { type: "item.completed", item: { id: "i2", type: "mcp_tool_call", server: "code-forge",
      tool: "loop_begin", status: "failed", error: { message: "user cancelled MCP tool call" } } },
    { type: "turn.completed", usage: { input_tokens: 13263, cached_input_tokens: 2432,
      output_tokens: 47, reasoning_output_tokens: 39 } }
  ].forEach(function (m) { t.ingestRaw(A.codex, m, 1); });
  r = usage.reduceEvents(t.flush().concat([t.finalEvent()].filter(Boolean)));
  assert.strictEqual(r.agents.length, 1, "codex exec 没有子 agent —— 只该有一行");
  assert.strictEqual(r.agents[0].role, "执行者",
    "★ 没有子 agent 的宿主要叫「执行者」，叫「协调者」是误导（它一个人演完所有角色）");
  assert.strictEqual(r.agents[0].in, 13263);
  assert.strictEqual(r.agents[0].cacheRead, 2432, "cached_input_tokens 就是缓存读");
  assert.strictEqual(r.agents[0].tools.command_execution, 1);
  assert.strictEqual(r.agents[0].tools["loop_begin(失败)"], 1,
    "★ MCP 调用要看得出是哪个工具、且失败的不许算成干成了一件事");
  assert.strictEqual(r.costUsd, null, "★ codex 不报成本 → null，不许折算一个出来");
  ok("★ codex 适配器：真实样本 → 单行用量；MCP 失败看得见；不报成本就留 null");

  // 权限三档要映射到各家自己的说法,映射不了就是 null(调用方别传)
  assert.strictEqual(A.permissionFor(A.claude, "bypassPermissions"), "bypassPermissions");
  assert.strictEqual(A.permissionFor(A.codex, "bypassPermissions"), "danger-full-access");
  assert.strictEqual(A.permissionFor(A.codex, "auto"), "workspace-write");
  ok("统一的三档权限映射到各宿主自己的说法");

  // 用户覆盖:模板里的空值要**连同前面那个开关一起**去掉,否则会传出 `-m --next` 这种鬼参数
  assert.deepStrictEqual(A.fillTemplate(["exec", "-m", "{model}", "-"], { model: "" }),
    ["exec", "-"], "★ 空值要连同它前面的开关一起丢掉");
  assert.deepStrictEqual(A.fillTemplate(["exec", "-m", "{model}", "-"], { model: "gpt-5" }),
    ["exec", "-m", "gpt-5", "-"]);
  ok("★ 用户自定义适配器的参数模板：空值不会留下一个悬空的开关");

  // ★ Windows 上 Node 不能不带 shell 起 .cmd(EINVAL)。实测 codex 就是 .cmd ——
  //   不拆开的话「跨宿主」在 Windows 上等于一句空话。而 shell:true 是这个仓库
  //   刻意避开的(不转义只拼接)。
  const cliSrc = fs.readFileSync(path.join(__dirname, "agentcli.js"), "utf8");
  const cliCode = cliSrc.split("\n").filter(function (l) { return !/^\s*(\/\/|\*|\/\*)/.test(l); }).join("\n");
  assert.ok(/function unwrapShim/.test(cliSrc), "要能把 .cmd 包装脚本拆成 node + 入口");
  assert.ok(/process\.execPath/.test(cliCode), "拆出来后要用当前这个 node 去跑");
  assert.ok(!/shell:\s*true/.test(cliCode), "不许开 shell:true");
  const cli = require("./agentcli.js");
  const cx = cli.which("codex");
  if (cx && /\.cmd$/i.test(cx)) {
    const s = cli.spawnable("codex");
    assert.ok(!s.error && s.cmd === process.execPath && /\.js$/.test(s.pre[0]),
      "codex.cmd 要被拆成 node + codex.js（实测直接 spawn 是 EINVAL）");
    ok("★ .cmd 包装脚本被拆成 node + JS 入口（直接 spawn 是 EINVAL，shell 又不能开）");
  } else {
    ok("（这台机器上 codex 不是 .cmd，跳过 shim 拆解的实跑校验）");
  }

  // doctor 要把「未实测」原样显示出来 —— 这是用户判断「起不来该怪谁」的唯一线索
  const rep = tui.doctorReport(tui.probeHosts(), 100);
  assert.ok(/未实测|实测过/.test(rep), "doctor 必须显示诚实分级");
  assert.ok(/角色隔离/.test(rep) && /用量/.test(rep), "doctor 要说清每个宿主能给到什么");
  // 「角色隔离」是**方式**不是有无 —— 写成 ✓/✗ 等于把 per-role 那条路当不存在(改过一次)
  assert.ok(/子 agent/.test(rep) && /独立进程/.test(rep),
    "★ 角色隔离要显示方式（子 agent / 独立进程），两种都保证独立会话");
  assert.ok(/\? = 查不出来/.test(rep), "★ 查不出来 ≠ 没注册，这两件事不能混成一个符号");
  ok("doctor 如实报告每个宿主的能力与实测状态");

  /* ★ 「在跑的监控台比代码旧」要在 doctor 里看得见。
   *   监控台/MCP 都是常驻进程,代码更新不热生效 —— 实测被问过一次
   *   「改了不弹网页怎么还在弹」,根因就是三个旧 MCP + 一个旧监控台还活着。 */
  {
    const pf = path.join(os.tmpdir(), "code-forge-port.json");
    const had = fs.existsSync(pf) ? fs.readFileSync(pf, "utf8") : null;
    try {
      // ★ pid 要用**活的**(自己的):doctor 和发现机制都验尸 —— 死 pid 意味着
      //   「没有在跑的监控台」,不该警告;而且 probeHosts 探测 MCP 时会把死 pid 文件收掉。
      // 竞态防护:套件里并发存活的监控台可能正好在此刻重写端口文件(实测偶发) ——
      // 写后即读,最多重试 3 次;仍失败就把此刻文件内容带进报错,别让人猜
      let warned = false;
      let lastSeen = "";
      for (let k = 0; k < 3 && !warned; k++) {
        fs.writeFileSync(pf, JSON.stringify({ port: 4610, pid: process.pid,
          startedAt: Date.now() - 86400000 }));
        warned = /比磁盘上的代码旧/.test(tui.doctorReport(tui.probeHosts(), 100));
        lastSeen = fs.existsSync(pf) ? fs.readFileSync(pf, "utf8") : "(无)";
      }
      assert.ok(warned,
        "★ 在跑的监控台(pid 活着)比代码旧 → doctor 必须警告并给出重启指引。此刻端口文件=" + lastSeen);
      // 同样的竞态防护套在后两条上(共享 tmp 端口文件,套件里的真组件可能并发碰它)
      let deadOk = false;
      for (let k2 = 0; k2 < 3 && !deadOk; k2++) {
        fs.writeFileSync(pf, JSON.stringify({ port: 4610, pid: 999999,
          startedAt: Date.now() - 86400000 }));
        deadOk = !/比磁盘上的代码旧/.test(tui.doctorReport(tui.probeHosts(), 100));
      }
      assert.ok(deadOk, "★ pid 死了就不是「在跑的」—— 对着尸体警告只会让人去杀一个不存在的进程");
      let noneOk = false;
      for (let k3 = 0; k3 < 3 && !noneOk; k3++) {
        try { fs.unlinkSync(pf); } catch (_) {}
        noneOk = !/比磁盘上的代码旧/.test(tui.doctorReport(tui.probeHosts(), 100));
      }
      assert.ok(noneOk, "没有端口文件就不许瞎警告");
    } finally {
      if (had != null) fs.writeFileSync(pf, had);
      else { try { fs.unlinkSync(pf); } catch (_) {} }
    }
    ok("★ doctor 能认出「在跑的监控台/MCP 是旧代码」——改了代码还见旧行为的第一嫌疑人");
  }

  // （执行路线删了:buildPrompt 不存在了。跨宿主的协议内联问题只剩 loop_agent 的角色头,在 dispatch 组测）

  // （执行路线删了:buildPrompt/向导/确认屏/点选挑号那一大片测试随之删除。
  //   聊天路径的对应保证在 SKILL.md 那组断言里:候选式确认、可点确认、逐角色换模型。）


  // （执行路线删了:分派策略(协调者 vs per-role / mixedHosts)随 /agent/run 一起走。
  //   adapters 的 preferPerRole 等字段还在 —— doctor 展示用。）


  /* ★ 混宿主时成本只有**报账的那几家**。
   *
   * 实测:claude 实现者 + codex 反驳者跑完,只有 claude 发了带 total_cost_usd 的 total,
   * codex 压根不报成本。裸写一个 "$0.03" 会被读成整次运行的花费 —— 那是少报账,
   * 跟这个项目其它地方的纪律冲突。
   * 另外两家各发一条 total,原来 last-wins 会把先来的那条直接丢掉。
   */
  const mixEvs = [
    { t: "usage", role: "实现者", agent: "a", source: "claude（实现者）", in: 26, out: 3, tools: [] },
    { t: "usage", total: true, source: "claude（实现者）", costUsd: 0.0342, in: 100, out: 10 },
    { t: "usage", role: "反驳者", agent: "b", source: "codex（反驳者）", in: 112000, out: 3400, tools: [] }
  ];
  const mixU = usage.reduceEvents(mixEvs);
  assert.strictEqual(mixU.costPartial, true, "只有一部分宿主报成本 → 要标成部分");
  assert.deepStrictEqual(mixU.costFrom, ["claude"]);
  assert.deepStrictEqual(mixU.costMissing, ["codex"], "要说清是谁没报");
  // 两家都报时要相加,不是后来者覆盖
  const twoTotals = usage.reduceEvents([
    { t: "usage", role: "a", agent: "a", source: "x（a）", in: 1, out: 1, tools: [] },
    { t: "usage", total: true, source: "x（a）", costUsd: 0.1 },
    { t: "usage", role: "b", agent: "b", source: "y（b）", in: 1, out: 1, tools: [] },
    { t: "usage", total: true, source: "y（b）", costUsd: 0.2 }
  ]);
  assert.ok(Math.abs(twoTotals.costUsd - 0.3) < 1e-9,
    "★ 多家各报一条 total → 成本相加，不许后来者覆盖（实际 " + twoTotals.costUsd + "）");
  assert.strictEqual(twoTotals.costPartial, false, "都报了就不该标成部分");
  // 显示上要警告,而且不能紧接着又说「这次运行真花的钱」
  const mixRep = tui.usageReport(mixU, 100);
  assert.ok(/只有 claude 报的/.test(mixRep) && /codex 不报成本/.test(mixRep),
    "报告要说清成本只覆盖了谁");
  assert.ok(!/（这次运行真花的钱）/.test(mixRep),
    "★ 警告过成本不全之后，不许紧接着又写「这次运行真花的钱」（自相矛盾）");
  ok("★ 混宿主的成本只覆盖报账那几家：相加不覆盖、如实标出谁没报、措辞不自相矛盾");

  // ★ 监控台地址要能传到宿主拉起的 MCP server 手上。
  //   claude 传环境变量,**codex 不传**(实测) —— 于是 codex 的 MCP server 收不到
  //   CODE_FORGE_URL,退回「自己拉一个监控台」。表现是:它老老实实调了 loop_begin,
  //   而发起这次 Run 的那个台子上一条事件都没有,看起来像它根本没跑协议。
  //   所以除了 env,适配器还要有自己的注入方式。
  const withUrl = A.codex.buildArgs({ consoleUrl: "http://localhost:4777", permission: "workspace-write" });
  assert.ok(withUrl.join(" ").indexOf("CODE_FORGE_URL=\"http://localhost:4777\"") >= 0,
    "codex 要把监控台地址经 -c 注进 MCP server 的 env");
  const noUrl = A.codex.buildArgs({ permission: "workspace-write" });
  assert.ok(noUrl.join(" ").indexOf("CODE_FORGE_URL") < 0, "没有地址时不许注一个空的进去");
  ok("★ 监控台地址除 env 外还经适配器注入（codex 不传 env，事件会落到别的台子上）");

  // ★ MCP 工具的审批也要放行。codex 默认 default_tools_approval_mode="prompt",
  //   exec 模式没人能批 → 每次调用 50ms 内回 `Err: user cancelled MCP tool call`。
  //   迷惑之处在于:agent **确实按协议调了 loop_begin**、参数完全正确,
  //   但监控台一条事件都没有 —— 看起来像它没跑协议,其实是被宿主拦了。
  const cxArgs = noUrl.join(" ");
  assert.ok(/mcp_servers\.code-forge\.default_tools_approval_mode="auto"/.test(cxArgs),
    "codex 要放行 code-forge 这个 server 的工具审批");
  assert.ok(!/^-c approval_policy|--dangerously-bypass/.test(cxArgs),
    "★ 只放行我们这一个 server，不许整体关掉审批或绕过沙箱");
  assert.strictEqual((cxArgs.match(/mcp_servers\.code-forge\./g) || []).length,
    (cxArgs.match(/mcp_servers\./g) || []).length,
    "★ 所有 -c 覆盖都必须限定在 code-forge 这一个 server 上（别的 MCP server 不许碰）");
  ok("★ 只对 code-forge 这一个 MCP server 放行审批（不整体关审批、不绕沙箱）");

  // ★ 有的宿主在低权限档下**根本不放行 MCP 工具**(codex 实测)。这件事必须在**开跑前**
  //   拦住:否则用户跑完一整趟才发现监控台是空的,而 agent 参数完全正确 ——
  //   这是最难查的一类失败。而且只能拦、不能替他升权。
  assert.strictEqual(A.codex.mcpNeedsPermission, "bypassPermissions");
  assert.ok(/user cancelled/.test(A.codex.mcpNeedsWhy), "要说清为什么,不能只说「不行」");
  assert.ok(/approval_policy|network_access/.test(A.codex.mcpNeedsWhy),
    "要写明已经试过哪些更轻的办法,免得下一个人再试一遍");
  // （执行路线删了:mcpNeedsPermission 的开跑前拦截随 agentrun 一起走;
  //   字段留着是给 doctor 展示与 loop_agent 的将来使用。）
  ok("★ 宿主拦 MCP 的原因与已试过的办法记录在适配器上（mcpNeedsWhy）");

  // ★ 端口文件只能由写它的那个进程删。几个监控台并存时,先退出的那个把别人的记录删了,
  //   活着的就没人找得到 —— MCP server 只好自己再拉一个,事件写进没人看的台子。
  const svrSrc = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
  const cleanFn = /const clean = \(\) => \{[\s\S]*?\n    \};/.exec(svrSrc);
  assert.ok(cleanFn && /cur\.pid !== process\.pid/.test(cleanFn[0]),
    "删端口文件前要确认它还指着自己");
  ok("★ 端口文件只删自己写的那份（否则会把还活着的监控台从发现里抹掉）");

  // （pickAdapter 随 agentrun 删除;loop_agent 对未知宿主的拒绝在 dispatch 组测:「不认识的宿主」）
}

/* ==================================================================
 * per-role：一个角色一个宿主进程
 *
 * 硬要求(用户给的,不是推的):
 *   ① 有多个模型就**默认**用多个模型
 *   ② 只有一个模型时,各角色仍然**不许同会话**
 * 这一节钉的就是这两条,以及「反驳者的只读是真的」。
 * ================================================================== */
async function testPerRole() {
  console.log("\n【per-role：一角色一进程】");
  const P = require("./perrole.js");
  const A = require("./adapters.js");
  const usage = require("./usage.js");
  const prSrc = fs.readFileSync(path.join(__dirname, "perrole.js"), "utf8");

  const base = [{ name: "实现者", kind: "propose" }, { name: "反驳者", kind: "attack" },
    { name: "复核者", kind: "audit", trigger: "on_green" }];

  // ⚠ 分配策略要用**固定的合成宿主**来测。用真 codex 测的话,机器上那份
  //   「试过跑不了」的黑名单会随实跑变化(实测:两个模型因为 CLI 太旧被拉黑),
  //   于是同一个断言今天过明天不过 —— 测试不该依赖可变的机器状态。
  const H = function (ids) {
    return { id: "__policy__", label: "P", bin: "p", subagents: false, verified: false,
      versionArgs: [], perms: {}, buildArgs: function () { return []; },
      models: function () { return ids; } };
  };
  const four = H([{ id: "big", strong: true }, { id: "mid" }, { id: "mid2" },
    { id: "tiny", weak: true }]);

  // ★ 要求①:有多个模型就默认分开用。不是开关,是默认。
  const got = A.assignModels(four, base);
  const models = got.map(function (r) { return r.model; });
  assert.strictEqual(new Set(models).size, 3, "三个角色要拿三个不同的模型：" + models.join(","));
  assert.ok(/自动（多模型）/.test(got[0].modelSource), "要标明是自动分的");
  ok("★ 有多个模型就默认用多个（不是开关，是默认）");

  // ★ 反驳者拿最强的 —— 软反驳者等于没有反驳者。实现者紧跟(它才是真写代码的那个)。
  const byKind = {};
  got.forEach(function (r) { byKind[r.kind] = r; });
  assert.strictEqual(byKind.attack.model, "big", "反驳者要拿最强的那个");
  assert.notStrictEqual(byKind.propose.model, "tiny",
    "★ 实现者不许拿最弱的模型（它才是真正要写代码的那个，踩过一次）");
  // 模型正好够三个时,最弱的那个才轮到复核者(它只在判绿后看一眼)
  const three = A.assignModels(H([{ id: "big", strong: true }, { id: "mid" },
    { id: "tiny", weak: true }]), base);
  const k3 = {};
  three.forEach(function (r) { k3[r.kind] = r.model; });
  assert.deepStrictEqual(k3, { attack: "big", propose: "mid", audit: "tiny" },
    "顺序应为 反驳者→实现者→复核者，实际 " + JSON.stringify(k3));

  // ★ 模型不够时**不许循环回头** —— 循环会让优先级倒挂。实测:只剩 2 个模型时
  //   实现者拿到了弱的,而排在它后面的复核者又拿回了强的。
  const two = A.assignModels(H([{ id: "big", strong: true }, { id: "small", weak: true }]), base);
  const k2 = {};
  two.forEach(function (r) { k2[r.kind] = r.model; });
  assert.strictEqual(k2.attack, "big", "反驳者仍拿最强");
  assert.strictEqual(k2.propose, "small");
  assert.strictEqual(k2.audit, "small",
    "★ 不许循环回头把强模型又发给优先级更低的复核者（那样实现者反而更差）");
  assert.ok(/只有 2 个模型可用/.test(two[0].modelSource), "要说清是模型不够而不是刻意这么分");
  ok("★ 模型不够时优先级单调（靠后的角色共用最后一个，不循环回头倒挂）");

  // 真 codex 上只断言「用的都是它自己报的、且没被拉黑的」—— 具体哪几个随机器而定
  const bad = A.unusableModels("codex");
  const okIds = A.codex.models().map(function (m) { return m.id; });
  P.resolveRoles(base, { defaultAgent: "codex" }).forEach(function (r) {
    assert.ok(okIds.indexOf(r.model) >= 0, "分出来的模型必须是 codex 真报过的：" + r.model);
    assert.ok(!bad.has(r.model), "★ 不许再分一个已经试过跑不了的模型：" + r.model);
  });
  ok("★ 强模型优先给反驳者、实现者紧跟；真宿主上只用它报过且没被拉黑的");

  // ★ 要求②:只有一个模型时,模型可以一样,**会话不许一样**
  const onlyOne = { id: "solo", label: "Solo", bin: "solo", subagents: false,
    versionArgs: [], verified: false, perms: {}, buildArgs: function () { return []; },
    models: function () { return [{ id: "m1" }]; } };
  const solo = A.assignModels(onlyOne, base);
  assert.deepStrictEqual(solo.map(function (r) { return r.model; }), ["m1", "m1", "m1"]);
  assert.ok(/只有一个模型/.test(solo[0].modelSource) && /独立会话/.test(solo[0].modelSource),
    "只有一个模型时要明说「靠独立会话区分」，不能让人以为角色被合并了");
  assert.strictEqual(A.sessionMode(onlyOne), "process",
    "★ 不能派子 agent 的宿主必须一角色一进程 —— 同会话里先提议后反驳等于自己复核自己");
  assert.strictEqual(A.sessionMode(A.claude), "subagent", "能派子 agent 的用子 agent（也是独立上下文）");
  ok("★ 只有一个模型时角色仍是独立会话（同模型 ≠ 同会话）");

  // ★ 反驳者的只读要落到**宿主自己的强制手段**上,不是提示词里的一句请求
  assert.strictEqual(P.DEFAULT_PERM.attack, "readOnly", "反驳者默认只读");
  assert.strictEqual(P.DEFAULT_PERM.audit, "readOnly", "复核者默认只读");
  const cxRO = A.codex.buildArgs({ permission: A.permissionFor(A.codex, "readOnly"), readOnly: true });
  assert.ok(cxRO.join(" ").indexOf("-s read-only") >= 0,
    "codex 的只读要用它自己的沙箱档（操作系统级）");
  const clRO = A.claude.buildArgs({ permission: A.permissionFor(A.claude, "readOnly"), readOnly: true });
  const clStr = clRO.join(" ");
  assert.ok(/--allowedTools Read Grep Glob/.test(clStr), "claude 的只读要只放行读工具");
  ["Edit", "Write", "Bash", "loop_"].forEach(function (bad) {
    assert.ok(clStr.indexOf(bad) < 0, "★ 只读角色的参数里不许出现写/回环工具：" + bad);
  });
  ok("★ 反驳者只读由宿主强制（codex 走 OS 沙箱，claude 只放行读工具）");

  // 角色规格解析
  assert.deepStrictEqual(P.parseRoleSpec("proposer:codex:gpt-5.5:acceptEdits"),
    { name: "实现者", kind: "propose", agent: "codex", model: "gpt-5.5", permissionMode: "acceptEdits" });
  assert.strictEqual(P.parseRoleSpec("critic").kind, "attack");
  assert.strictEqual(P.parseRoleSpec("reviewer").trigger, "on_green", "复核者要判绿后才出场");
  // 混宿主必须合法:claude 演实现者、codex 演反驳者
  const mixed = P.resolveRoles([P.parseRoleSpec("proposer:claude"), P.parseRoleSpec("critic:codex")]);
  assert.strictEqual(mixed[0].agent, "claude");
  assert.strictEqual(mixed[1].agent, "codex");
  assert.ok(A.claude.models().some(function (m) { return m.id === mixed[0].model; }),
    "★ 模型要按各自宿主分 —— 混在一起分会分出 codex 上不存在的 opus");
  assert.ok(A.codex.models().some(function (m) { return m.id === mixed[1].model; }));
  ok("★ --role 可混宿主，模型按各自宿主分配（不会分出别家的模型名）");

  // ★ 角色提示词必须**自成一体** —— 进程没有历史上下文,漏一样它就只能瞎猜
  const p = P.rolePrompt({
    role: { name: "反驳者", kind: "attack" },
    task: "修重复回调", goal: { command: "pytest -q" }, budget: { rounds: 6 }, round: 2,
    said: [{ role: "实现者", summary: "加了幂等键", body: "改了 webhook.py:42" }],
    lastGate: { detail: "未达标 · exit 1", output: "FAILED test_dup" },
    lastAttacks: [{ summary: "并发下仍会重复" }]
  });
  assert.ok(p.indexOf("修重复回调") >= 0, "要带任务");
  assert.ok(p.indexOf("pytest -q") >= 0, "要带判据命令");
  assert.ok(/must not alter it/.test(p), "要明写不许改判据");
  assert.ok(p.indexOf("加了幂等键") >= 0, "★ 要带上本轮实现者说了什么，否则它在反驳空气");
  assert.ok(p.indexOf("FAILED test_dup") >= 0, "★ 要带上一轮判据输出，否则只会重复上一轮的改法");
  assert.ok(p.indexOf("并发下仍会重复") >= 0, "要带上一轮的反驳点");
  assert.ok(/must not modify any file/.test(p), "反驳者的职责里要写明不许改文件");
  assert.ok(/Do not call any loop_\* tool/.test(p),
    "★ 要明说别调 loop_*：本模式下协议由驱动方走，它调了只会被拦或搅乱账本");
  ok("★ 角色提示词自成一体（任务/判据/本轮他人发言/上轮失败/上轮反驳点/别调 loop_*）");

  // ★ 「角色之间没有共享上下文」**不是 per-role 特有的代价** —— claude 子 agent 也没有。
  //   实测直接问过子 agent 本人:「你能看到派你出来的那个会话之前的对话历史吗」→ 不能;
  //   它只有自己的 system prompt + 父 agent 显式写给它的 prompt + 自己的工具集。
  //   文档里把这条写成 per-role 的独有代价是错的(改过一次),真正的区别是**谁转述**:
  //   claude 是协调者模型转述(有损、且它有动机把失败说轻),per-role 是代码原文照搬。
  const readme = fs.readFileSync(path.join(__dirname, "README.md"), "utf8");
  assert.ok(/常见误解[\s\S]{0,120}子 agent[\s\S]{0,60}没有/.test(readme),
    "README 要点明「claude 子 agent 之间也没有共享上下文」这个常见误解");
  assert.ok(/谁负责把上下文喂给角色|谁转述/.test(readme),
    "★ 要把真正的区别说成「谁转述」，而不是「有没有共享上下文」");
  const prHdr = prSrc.slice(0, prSrc.indexOf("const fs"));
  assert.ok(/claude 的子 agent 也没有/.test(prHdr),
    "perrole.js 的注释也不许把这条写成自己独有的代价");
  assert.ok(/原样进反驳者的提示词|原文照搬/.test(prHdr),
    "要写明代码转述的那点好处：判据失败输出无损地进反驳者手里");
  ok("★ 澄清：claude 子 agent 之间也没有共享上下文；区别在「谁转述」不在「有没有」");

  // 本模式不需要 MCP —— 所以 codex 那道「workspace-write 下 MCP 被判 cancelled」的门槛不适用

  assert.ok(/delete env\.CODE_FORGE_URL/.test(prSrc),
    "★ 角色进程不该往监控台写事件（记账是驱动方的活，它写进来会搅乱账本）");
  // （整回环驱动 start() 删了:协议走向/observed/wrote 上报这组随之删除。
  //   剩下的 runRole 是 loop_agent 的腿,它的 wrote/stalled 观察在 dispatch 组测。）
  assert.ok(/stallTimer|stallMs/.test(prSrc), "runRole 要有停滞看门狗");

  // 用量:每个角色一个 tracker,soloLabel 就是角色名 → 天然逐角色分开
  assert.ok(/soloLabel: opts\.role\.name/.test(prSrc),
    "★ 每个角色进程的账要记在角色名下（这就是逐角色用量，不依赖 parent_tool_use_id）");
  // codex 的输出不带模型名,而 per-role 模式下我们知道 —— 传进 tracker,表里那列才是真的
  const t2 = usage.createTracker({ soloLabel: "反驳者", model: "gpt-5.5" });
  t2.ingestRecord({ parent: null, model: null, key: null, tools: [],
    usage: { in: 10, out: 2 } }, 1);
  assert.strictEqual(usage.reduceEvents(t2.flush()).agents[0].model, "gpt-5.5",
    "宿主不报模型名时用调用方给的那个（否则用量表里是一列「—」）");
  ok("逐角色用量天然分开，且模型那一列是真的");

  // ★ 「清单里有」≠「真能用」。实测两种打脸:CLI 太旧(gpt-5.6-terra requires a newer
  //   version)、账号用不了(gpt-5.6-sol not supported with a ChatGPT account)。
  //   都不该报成「这一轮没做成」—— 该记下来换一个重试。
  assert.ok(A.looksLikeModelRejected(
    '{"error":{"message":"The gpt-5.6-terra model requires a newer version of Codex."}}'));
  assert.ok(A.looksLikeModelRejected(
    "The gpt-5.6-sol model is not supported when using Codex with a ChatGPT account."));
  assert.ok(!A.looksLikeModelRejected("FAILED test_dup — 判据没过"),
    "★ 判据没过不是模型问题，认错了会把真失败当成换模型重试");
  // 黑名单要把它从后续分配里剔掉
  const fake = { id: "__t__", label: "T", bin: "t", subagents: false, verified: false,
    versionArgs: [], perms: {}, buildArgs: function () { return []; },
    models: function () { return [{ id: "m1", strong: true }, { id: "m2" }]; } };
  const both = A.assignModels(fake, [{ name: "a", kind: "attack" }, { name: "b", kind: "propose" }]);
  assert.deepStrictEqual(both.map(function (r) { return r.model; }), ["m1", "m2"]);
  const excl = A.assignModels(fake, [{ name: "a", kind: "attack" }], { exclude: ["m1"] });
  assert.strictEqual(excl[0].model, "m2", "被排除的模型不许再分出来");
  // （换模型重试的驱动逻辑随 start() 删除;识别与黑名单分配仍在上面钉着。）
  ok("★ 模型被宿主拒掉时记入黑名单并换一个重试（不报成回环失败，且下次不再撞）");
}

/* ==================================================================
 * 评审判据（不可量化的目标）+ 协调者的流程监控
 *
 * 这一节钉的是**这个项目最核心的那条性质在放宽之后有没有被拆掉**:
 * 达标与否仍然不由做事的人自己说。从「代码判」放宽到「独立第三方判」,
 * 但没有放宽到「自己判」。
 * ================================================================== */
async function testJudge() {
  console.log("\n【评审判据 + 流程监控】");
  const judge = require("./judge.js");
  const gate = require("./gate.js");

  // ★ 判定人**不能是协调者**。协调者是做事的那一方,它有动机说已达标 ——
  //   这是整个项目存在的理由,放宽判据时最容易顺手拆掉的就是它。
  const jsrc = fs.readFileSync(path.join(__dirname, "judge.js"), "utf8");
  assert.ok(/独立评审者/.test(jsrc) && /不是协调者|为什么不是「让协调者判」/.test(jsrc),
    "judge.js 要写明判定人是独立评审者、不是协调者");
  assert.ok(/readOnly/.test(jsrc) && /readOnly: true|readOnly: readOnly|readOnly: true/.test(jsrc.replace(/\s+/g, " ")),
    "评审者必须只读 —— 能改代码的评审者可以先改好再判过");
  const jcode = jsrc.split("\n").filter(function (l) { return !/^\s*(\/\/|\*|\/\*)/.test(l); }).join("\n");
  assert.ok(/permissionFor\(ad, "readOnly"\)/.test(jcode) && /readOnly: true/.test(jcode),
    "只读要落到宿主参数上，不是提示词里的一句请求");
  assert.ok(/avoidModels/.test(jcode), "要尽量避开实现者用的那个模型（同模型自评通过率虚高）");
  assert.ok(/delete env\.CODE_FORGE_URL/.test(jcode), "评审者不该往事件流里写东西");
  ok("★ 判定人是独立评审者（只读、独立会话、尽量换模型），不是协调者");

  // ★ 解不出裁定 = 判据坏了,**不是未达标** —— 与「命令找不到 ≠ 测试没过」同一条纪律
  const noVerdict = judge.parseVerdict("我觉得改得挺好的，可以了。");
  assert.strictEqual(noVerdict.broken, true, "没有 VERDICT 行就是判据坏了");
  assert.notStrictEqual(noVerdict.met, true, "判不出来时绝不许算达标");
  // ★ 空口说 MET、一条证据都不给 → 降级成未达标
  const noEvidence = judge.parseVerdict("VERDICT: MET\n看起来不错，代码清晰了很多。");
  assert.strictEqual(noEvidence.met, false,
    "★ 判了 MET 但没给证据 → 按未达标算（否则「看起来不错」就能签合格证）");
  assert.strictEqual(noEvidence.downgraded, true, "要标出这是被降级的，不能悄悄改结论");
  const withEvidence = judge.parseVerdict(
    "VERDICT: MET\n1) docstring 都有了：payments/webhook.py:12、payments/api.py:40\nNEXT: 无");
  assert.strictEqual(withEvidence.met, true);
  assert.ok(withEvidence.evidence.length >= 2, "证据要能解出来");
  const notMet = judge.parseVerdict("VERDICT: NOT_MET\n还有 3 个函数超 50 行：a.py:10\nNEXT: 先拆 a.py");
  assert.strictEqual(notMet.met, false);
  assert.strictEqual(notMet.next, "先拆 a.py", "未达标要带「下一轮改什么」");
  ok("★ 无 VERDICT = 判据坏了（不是未达标）；无证据的 MET 降级成未达标");

  // ★ 停止原因必须**单列**:命令判过和评审判定的可信度不一样,混成一个就没法事后追
  const REASONS = require("./hostrun.js").REASONS;
  assert.ok(REASONS.judged_met && REASONS.goal_met);
  assert.notStrictEqual(REASONS.judged_met, REASONS.goal_met);
  assert.ok(/command/.test(REASONS.goal_met), "goal_met 要写明是命令判过(协调者可见 label,英文)");
  assert.ok(/judge/.test(REASONS.judged_met), "judged_met 要写明是评审判定");
  assert.ok(REASONS.judge_broken, "评审判据自己坏了也要有一条原因");
  const tsrcJ = fs.readFileSync(path.join(__dirname, "tui.js"), "utf8");
  assert.ok(/judged_met: "达标停止（评审判定）"/.test(tsrcJ), "TUI 也要把两种达标分开显示");
  ok("★ judged_met 与 goal_met 严格分开（显示、回放都分得清）");

  // 评审判据能单独用（没有命令）——「不可量化的目标」就是靠这条进来的
  const evs = [];
  const host = require("./hostrun.js").create(function (e) { evs.push(e); });
  host.begin({ session: "重构可读性", task: "把 payments 重构得更好读",
    goal: { cwd: __dirname, rubric: "所有公开函数都有 docstring" },
    roles: [{ name: "实现者", kind: "propose" }], budget: { rounds: 2, seconds: 60 } });
  assert.ok(host.status().active, "只有 rubric 也要能开局（不能因为没命令就不让跑）");
  ok("评审判据可以单独用（给没有命令可判的目标）");

  /* ---- 协调者的另一半:流程监控 ---- */

  // ★ 没有 metric 时 no_progress 曾经**永远不触发** —— metric 是可选的,
  //   于是绝大多数回环的零进展闸门都是空的,原地打转能把轮数烧满。
  assert.strictEqual(gate.madeProgress({}, null, null), null, "两样都没有 → 不计入");
  assert.strictEqual(gate.madeProgress({}, null, null, "aaa", "aaa"), false,
    "★ 没 metric 时要靠判据输出指纹判零进展（少了这一档闸门等于没有）");
  assert.strictEqual(gate.madeProgress({}, null, null, "aaa", "bbb"), true);
  // 指纹要归一化掉每次都变的东西,否则永远不同,闸门还是空的
  assert.strictEqual(gate.fingerprint("12 passed in 3.41s"), gate.fingerprint("12 passed in 5.02s"),
    "耗时不同不该算变化");
  assert.notStrictEqual(gate.fingerprint("12 passed"), gate.fingerprint("13 passed"),
    "内容变了指纹要变");
  ok("★ 没有 metric 时靠判据输出指纹判零进展（补上一个一直是空的闸门）");

  // ★ 空跑检测:**只在真的观察到时**才计数。补丁台账本来靠 agent 自报,
  //   而它们经常不报 —— 把「没报」当「没改」会把健康回环误杀,比没有这个检测更糟。
  const mk = function () {
    const es = [];
    const h = require("./hostrun.js").create(function (e) { es.push(e); });
    h.begin({ session: "x", goal: { command: "node -e \"process.exit(1)\"", cwd: __dirname },
      roles: [{ name: "实现者", kind: "propose" }],
      budget: { rounds: 9, seconds: 60, idleRounds: 2 } });
    return h;
  };
  const h1 = mk();
  h1.say({ role: "实现者", summary: "我分析了一下", meta: { wrote: false } });
  let v1 = await h1.gate({ observed: true });
  assert.strictEqual(v1.idleRounds, 1);
  h1.say({ role: "实现者", summary: "再分析一下", meta: { wrote: false } });
  v1 = await h1.gate({ observed: true });
  assert.strictEqual(v1.stopReason, "idle_spin", "观察到连续没动手 → 空跑停");
  assert.ok(/权限够吗/.test(v1.anomaly || ""), "要给可行动的下一步，不是只报一个词");

  const h2 = mk();
  for (let i = 0; i < 4; i++) {
    h2.say({ role: "实现者", summary: "说了句话" });      // 不报 diff、也没人观察
    const v = await h2.gate();                            // 不传 observed
    assert.notStrictEqual(v.stopReason, "idle_spin",
      "★ 观察不到时不许算空跑（「没报」≠「没改」，误杀健康回环比没检测更糟）");
  }
  // 观察到动过手 → 计数归零
  const h3 = mk();
  h3.say({ role: "实现者", summary: "改了 a.py", meta: { wrote: true } });
  const v3 = await h3.gate({ observed: true });
  assert.strictEqual(v3.idleRounds, 0, "动过手要把空跑计数归零");
  assert.strictEqual(v3.acted, true);
  ok("★ 空跑只在观察得到时判（per-role 观察得到；纯 MCP 那条路不猜）");

  // 停滞:角色进程卡住由驱动方报上来,它是流程异常不是没达标
  const h4 = mk();
  h4.say({ role: "实现者", summary: "（卡住被中止）", meta: { stalled: true, wrote: false } });
  const v4 = await h4.gate({ observed: true });
  assert.strictEqual(v4.stopReason, "stalled", "卡住要报 stalled，不是 no_progress");
  assert.ok(/卡住/.test(v4.anomaly || ""));
  ok("★ 角色进程卡住 → stalled（流程异常，与「没达标」分开）");

  // ★ 界面不许靠**摘要文字**推「过没过」。踩过:评审那条摘要是「评审判定达标」,
  //   而判据走势那行用 /^达标/ 匹配 —— 于是评审判过的轮次在走势里显示成「未过」。
  //   事件自己带 meta.met,界面读它。
  const hsrc = fs.readFileSync(path.join(__dirname, "hostrun.js"), "utf8");
  assert.ok(/meta: \{ met: !!g\.met/.test(hsrc), "命令判据事件要带 meta.met");
  assert.ok(/met: !!j\.met, executor: "judge"/.test(hsrc), "评审判据事件也要带 meta.met");
  const tsrcM = fs.readFileSync(path.join(__dirname, "tui.js"), "utf8");
  const tui = require("./tui.js");
  // 注释里可以提这段历史,**代码里**不许再用 —— 先把注释行剥掉再查
  const tsrcMCode = tsrcM.split(String.fromCharCode(10))
    .filter(function (l) { return !/^\s*(\/\/|\*|\/\*)/.test(l); }).join(String.fromCharCode(10));
  assert.ok(!/\/\^达标\//.test(tsrcMCode), "★ 不许再用 /^达标/ 推状态（评审那条摘要匹配不上）");
  assert.ok((tsrcM.match(/typeof (g|e)\.meta\.met === "boolean"/g) || []).length >= 2,
    "走势与事件行都要优先读 meta.met");
  // 实跑一遍渲染:评审判过的那一轮在走势里必须显示成「过」
  const stJ = tui.newState();
  [
    { t: "run.start", session: "x", goal: "评审判据" },
    { t: "role.add", id: "gate", name: "判据", model: "确定性 · 无模型" },
    { t: "round.start", n: 1 },
    { t: "event", round: 1, role: "gate", kind: "audit", ts: "09:00:00",
      summary: "评审判定未达标 · 2/3 条通过", meta: { met: false, judge: true } },
    { t: "round.start", n: 2 },
    { t: "event", round: 2, role: "gate", kind: "audit", ts: "09:05:00",
      summary: "评审判定达标 · 3/3 条通过", meta: { met: true, judge: true } }
  ].forEach(function (e) { tui.reduce(stJ, e); });
  const scr = tui.render(stJ, 100);
  const trail = (scr.split(String.fromCharCode(10)).filter(function (l) { return /^判据 /.test(l); })[0] || "");
  assert.ok(/R1 未过/.test(trail) && /R2 过/.test(trail),
    "★ 评审判过的轮次在判据走势里必须显示「过」，实际：" + trail);
  ok("★ 过没过读事件自带的 meta.met，不靠摘要文字推（评审判过不再显示成未过）");
}

/* ---------------- MCP 拉监控台:端口发现 + 失败清理 ---------------- */
/**
 * ★ 两条实测踩过的坑:
 *   ② base 是 spawn **之前**算出来的(过期端口文件 / 兜底 4610)。子进程真正绑上的
 *      可能是别的端口(4610 被占就 +1),轮询却一直拿旧 base 打 /health ——
 *      4 秒后报「监控台没能在 4 秒内就绪」,哪怕它其实好好地起来了。
 *   ③ 那个子进程是 detached+unref 的,失败路径上从不 kill。每失败一次就在机器上
 *      留一个占着端口的僵尸控制台,下次更容易撞端口 → 恶性循环(本机曾同时挂 5 个)。
 */
async function testBringUpConsole() {
  console.log("mcp — 拉监控台（端口发现与失败清理）");
  const mcp = require("./mcp.js");
  const nap = function () { return Promise.resolve(); };      // 测试里不真睡

  // ② 子进程爬到了 4699,端口文件过一会儿才更新过来
  const real = "http://localhost:4699";
  const stale = "http://localhost:4610";
  let child = { killed: false, kill: function () { this.killed = true; } };
  let seen = 0;
  let r = await mcp.bringUpConsole({
    base: stale, sleep: nap, tries: 40,
    spawnConsole: function () { return child; },
    rediscover: function () { return seen >= 3 ? real : stale; },
    alive: function (b) { seen++; return Promise.resolve(b === real); }
  });
  assert.strictEqual(r.up, true, "★ 轮询时必须重新发现端口,否则真起来了也会被报成没起来");
  assert.strictEqual(r.base, real, "发现到的新端口要带回去 —— 后面所有请求都得打这个");
  assert.strictEqual(child.killed, false, "起来了就别杀");
  ok("★ 拉起后每次轮询重新发现端口 —— 子进程换了端口照样连得上");

  // ③ 一直起不来 → 收掉自己刚 spawn 的那个,别留僵尸
  child = { killed: false, kill: function () { this.killed = true; } };
  r = await mcp.bringUpConsole({
    base: stale, sleep: nap, tries: 5,
    spawnConsole: function () { return child; },
    rediscover: function () { return stale; },
    alive: function () { return Promise.resolve(false); }
  });
  assert.strictEqual(r.up, false, "一直连不上就该如实报失败");
  assert.strictEqual(child.killed, true, "★ 起不来必须 kill 掉自己 spawn 的那个 detached 控制台");
  assert.strictEqual(r.child, null, "杀完句柄要清掉,下次别再攥着一个死 pid");
  ok("★ 拉起失败就收掉自己 spawn 的控制台(不再留占着端口的僵尸)");

  // 只杀自己 spawn 的:没 spawn 过(比如已有别人的台子)时,失败路径不许乱杀/不许炸
  r = await mcp.bringUpConsole({
    base: stale, sleep: nap, tries: 2,
    spawnConsole: function () { return null; },
    rediscover: function () { return stale; },
    alive: function () { return Promise.resolve(false); }
  });
  assert.strictEqual(r.up, false);
  assert.strictEqual(r.child, null);
  ok("没自己 spawn 过就没得杀(不误伤别人的监控台)");

  // 抽出来的函数得真的被 ensureConsole 用上,否则它只是一段没人走的死代码
  const src = fs.readFileSync(path.join(__dirname, "mcp.js"), "utf8");
  assert.ok(/bringUpConsole\(\{/.test(src), "★ ensureConsole 必须走 bringUpConsole,别再自己写死等循环");
  ok("ensureConsole 走的就是这段(不是并存的第二份实现)");

  // ★ 形状契约钉死:bringUpConsole 只返回 { up, base, child },没有 state 字段。
  //   实测踩过 ensureConsole 里写成 `r.state.base` 去读它,r.state 恒为 undefined,
  //   于是 loop_begin/loop_say 一律因为「监控台没在跑」而报废。
  assert.deepStrictEqual(Object.keys(r).sort(), ["base", "child", "up"],
    "★ bringUpConsole 的返回形状钉死为 { up, base, child } —— 消费端不许猜出一个 state 字段");
}

/**
 * ★ 上面 testBringUpConsole 只钉了 bringUpConsole 自己的行为;这里补的是**消费端**
 *   (ensureConsole)有没有把返回值读对。实测踩过的崩溃就出在消费端:
 *   `state.base = r.state.base` —— bringUpConsole 压根不返回 state 字段,r.state 恒为
 *   undefined,于是 `.base` 一读就抛 `Cannot read properties of undefined`。
 *   callTool 外层有 try/catch,所以不是进程级崩溃,但会把「起不了监控台」这条正常提示
 *   顶替成一句读不出意思的「调用失败：Cannot read properties of undefined...」——
 *   而且**成功**路径下（up:true）同样会炸,因为 r.state 无论成功失败都不存在。
 *   这里从 loop_begin 的确认步真走一遍,让「拉不起来」「拉起来了」两条路径都真正执行到
 *   `state.base = r.base` 这一行。两个技巧让它不依赖真实子进程/真实端口发现:
 *     ① 预置 state.consoleChild 为一个假对象 —— ensureConsole 内部 spawnConsole()
 *        看到它非空就直接回传,不会真的 spawn server.js（不留僵尸进程)。
 *     ② 设 CODE_FORGE_URL = 本测试自己的 state.base —— discoverBase(null)(「端口文件
 *        可能是旧的,重查一次」那步)就总是拿到同一个地址,不被这台机器上真实残留的
 *        端口文件/其他监控台干扰。
 */
async function testEnsureConsole() {
  console.log("mcp — ensureConsole 消费 bringUpConsole 返回值（形状契约,消费端）");
  const mcp = require("./mcp.js");
  const http = require("http");
  const prevView = process.env.CODE_FORGE_VIEW;
  const prevUrl = process.env.CODE_FORGE_URL;
  process.env.CODE_FORGE_VIEW = "none";   // 别在测试机上弹终端/浏览器

  let seq = 0;
  async function callMcpTool(handler, name, args) {
    const writes = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = function (chunk) { writes.push(chunk.toString()); return true; };
    try {
      await handler.handle({ jsonrpc: "2.0", id: ++seq, method: "tools/call",
        params: { name: name, arguments: args || {} } });
    } finally { process.stdout.write = orig; }
    const line = writes.join("").trim().split("\n").filter(Boolean).pop();
    const msg = JSON.parse(line);
    const text = msg.result.content[0].text;
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (_) { /* 不是 JSON 就留 null */ }
    return { isError: !!msg.result.isError, text: text, json: parsed };
  }

  async function driveToGo(state) {
    const handler = mcp.createHandler(state);
    let r = await callMcpTool(handler, "loop_begin", { task: "ensureConsole 回归测试目标" });
    assert.strictEqual(r.json.step, "2/3 config");
    r = await callMcpTool(handler, "loop_begin", {
      token: r.json.token, goal: { command: "true" },
      budget: { rounds: 1, seconds: 60 }, roles: ROLES
    });
    assert.strictEqual(r.json.step, "3/3 confirm");
    return callMcpTool(handler, "loop_begin", { token: r.json.token, go: true });
  }

  try {
    // ① 监控台一直拉不起来(端口没人听,alive 永远连不上)
    let state = { opts: {}, base: "http://127.0.0.1:1",
      consoleChild: { killed: false, kill: function () { this.killed = true; } } };
    process.env.CODE_FORGE_URL = state.base;
    const r1 = await driveToGo(state);
    assert.strictEqual(r1.isError, true);
    assert.ok(/Could not start the console/.test(r1.text),
      "★ 拉不起来要如实报「起不了监控台」,不能被内部异常顶替成「调用失败：Cannot read...」" +
      "（旧 bug：读了不存在的 r.state.base）。实际：" + r1.text);
    assert.strictEqual(typeof state.base, "string", "★ 失败路径上 state.base 也必须是正常字符串（不是 undefined）");
    assert.strictEqual(state.consoleChild, null, "拉不起来要清掉 consoleChild(bringUpConsole 已经杀了它)");
    ok("★ ensureConsole 拉不起来时不抛异常,state.base/consoleChild 收尾正确(钉住消费端读的是 r.base)");

    // ② 监控台过一小会儿就活了(前几拍 503,随后 200 —— 模拟「拉起中」到「就绪」)
    const readyAt = Date.now() + 250;
    const server = http.createServer(function (_req, res) {
      if (Date.now() < readyAt) { res.writeHead(503); res.end(); } else { res.writeHead(200); res.end("ok"); }
    });
    await new Promise(function (res) { server.listen(0, "127.0.0.1", res); });
    const port = server.address().port;
    state = { opts: {}, base: "http://127.0.0.1:" + port,
      consoleChild: { killed: false, kill: function () { this.killed = true; } } };
    process.env.CODE_FORGE_URL = state.base;
    const r2 = await driveToGo(state);
    assert.strictEqual(r2.isError, false, "★ 拉起来了就该往下走,不该被内部异常当成失败：" + r2.text);
    assert.strictEqual(state.base, "http://127.0.0.1:" + port,
      "★ 成功路径上 state.base 也要落在真正就绪的那个地址(钉住消费端读的是 r.base)");
    server.close();
    ok("★ ensureConsole 拉起来(up:true)时同样不抛异常,state.base 落在 r.base 上");
  } finally {
    if (prevView === undefined) delete process.env.CODE_FORGE_VIEW; else process.env.CODE_FORGE_VIEW = prevView;
    if (prevUrl === undefined) delete process.env.CODE_FORGE_URL; else process.env.CODE_FORGE_URL = prevUrl;
  }
}

(async function main() {
  try {
    await testStateMachine();
    await testJudge();
    await testAdapters();
    await testPerRole();
    await testStops();
    await testUsage();
    await testChatUsage();
    await testMcpEndToEnd();
    await testBringUpConsole();
    await testEnsureConsole();
    await testPackaging();
    console.log("\n" + pass + " 项断言全部通过（宿主驱动模式）");
    process.exit(0);
  } catch (err) {
    console.error("\n✗ 失败：" + (err && err.message) + "\n" + (err && err.stack));
    process.exit(1);
  }
})();
