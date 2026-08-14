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

const ROLES = [
  { name: "提议者", kind: "propose", duty: "提最小改动" },
  { name: "反驳者", kind: "attack", duty: "只找反例" },
  { name: "复核者", kind: "audit", duty: "判绿后复核" }
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
  assert.ok(host.say({ role: "提议者", summary: "x" }).error);
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
  assert.ok(/judge 还没有判过达标/.test(cheat.error));
  assert.ok(host.status().active, "被拒之后回环必须还在跑,不能被这一下带停");
  ok("★ gate 没判过就说 goal_met → 拒绝,且回环继续（这是整层存在的理由）");

  // 角色名不在表里 → 拒(否则页面上会长出一个没登记的角色)
  assert.ok(host.say({ role: "不存在的人", summary: "x" }).error);
  ok("不在角色表里的 role → 拒绝");

  const said = host.say({ role: "提议者", summary: "加唯一索引", body: "详细理由…" });
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
  m.host.begin({ goal: failing, budget: { rounds: 9, seconds: 0, noProgressRounds: 99 }, roles: ROLES });
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
  assert.ok(/无法判定达标/.test(nb.note), "没判据要在返回值里就把后果说清");
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
    [path.join(__dirname, "server.js"), "--no-open", "--reset", "--file", logFile, "--port", String(port)],
    { stdio: ["ignore", "pipe", "pipe"] });

  return new Promise(function (resolve, reject) {
    let ready = false;
    consoleProc.stdout.on("data", function (b) { if (!ready && /监控台/.test(b.toString())) { ready = true; go(); } });
    setTimeout(function () { if (!ready) { consoleProc.kill(); reject(new Error("监控台起不来")); } }, 8000);

    function go() {
      const mcp = spawn(process.execPath,
        [path.join(__dirname, "server.js"), "--mcp", "--url", "http://localhost:" + port],
        { stdio: ["pipe", "pipe", "pipe"] });
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
          assert.deepStrictEqual(names, ["loop_begin", "loop_end", "loop_gate", "loop_say", "loop_status"]);
          list.result.tools.forEach(function (t) {
            assert.ok(t.description.length > 60, t.name + " 描述太短,宿主分不清何时该调");
            assert.ok(t.inputSchema.type === "object");
          });
          // 工具描述里必须写着「不许自己宣布达标」—— 提示词侧先禁,代码侧才兜底
          const gateDesc = list.result.tools.filter(function (t) { return t.name === "loop_gate"; })[0].description;
          assert.ok(/不得自行宣布达成/.test(gateDesc), "loop_gate 描述必须明写不许自己宣布达标");
          ok("tools/list 五个工具齐全,且描述里明写「达标不由你说」");

          const suite = path.join(os.tmpdir(), "cf-mcp-suite-" + process.pid + ".js");
          fs.writeFileSync(suite, "console.log('coverage: 91%');process.exit(0);");
          const begun = await callTool("loop_begin", {
            session: "MCP 全链路",
            goal: { command: JSON.stringify(process.execPath) + " " + JSON.stringify(suite),
              metric: { name: "覆盖率", pattern: "coverage: ([0-9]+)", min: 80 } },
            budget: { rounds: 3, seconds: 600 },
            roles: ROLES
          });
          assert.strictEqual(begun.isError, false);
          assert.strictEqual(begun.json.round, 1);
          assert.ok(begun.json.console);
          ok("loop_begin 经 MCP 开局,返回监控台地址");

          const cheat = await callTool("loop_end", { reason: "goal_met", detail: "我觉得可以了" });
          assert.strictEqual(cheat.isError, true);
          assert.ok(/judge 还没有判过达标/.test(cheat.text));
          ok("★ 经 MCP 自称达标 → 被拒(拒绝一路传到宿主看得见的地方)");

          const bad = await callTool("loop_say", { role: "查无此人", summary: "x" });
          assert.strictEqual(bad.isError, true);
          ok("loop_say 未登记角色 → isError,不静默吞掉");

          const s1 = await callTool("loop_say", { role: "提议者", summary: "加唯一索引", body: "..." });
          assert.strictEqual(s1.isError, false);
          const s2 = await callTool("loop_say", { role: "反驳者", summary: "并发窗口仍在", targets: ["提议者"] });
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
  assert.ok(/不得自行宣布达成|不许宣布达标/.test(skill), "SKILL.md 必须明写不许自己宣布达标");
  assert.ok(/不许改判据/.test(skill), "SKILL.md 必须禁止为了达标而放宽判据");
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

  // ---- 判据命令候选（gatesuggest.js）----
  const gs = require("./gatesuggest.js");

  // 解析要挺得住模型的各种吐法:markdown 包裹、前后带话、stream 外层、纯垃圾
  const P = gs.parseCandidates;
  assert.strictEqual(P('{"candidates":[{"command":"pytest -q"}]}').candidates[0].command, "pytest -q");
  assert.strictEqual(P('```json\n{"candidates":[{"command":"npm test"}]}\n```').candidates[0].command, "npm test");
  assert.strictEqual(P('看了一下。{"candidates":[{"command":"cargo test"}]} 以上').candidates[0].command, "cargo test");
  assert.strictEqual(P(JSON.stringify({ type: "result", result: '{"candidates":[{"command":"go test ./..."}]}' }))
    .candidates[0].command, "go test ./...");
  assert.deepStrictEqual(P("I could not find any tests.").candidates, []);
  assert.deepStrictEqual(P("").candidates, []);
  assert.deepStrictEqual(P(null).candidates, []);
  ok("候选解析挺得住 markdown/前后带话/外层包裹/垃圾/空");

  // ★ 空数组 + note 必须原样保留 —— 「这个仓库没有可运行的检查」比编一条有用得多
  const none = P('{"candidates":[],"note":"这个仓库没有任何可运行的检查"}');
  assert.strictEqual(none.candidates.length, 0);
  assert.ok(/没有任何可运行的检查/.test(none.note));
  ok("★ 「没有可运行的检查」如实回空 + note（不编一条充数）");

  // 脏条目一律丢:没有 command、空串、非字符串
  const dirty = P('{"candidates":[{"why":"没 command"},{"command":""},{"command":123},{"command":"ok"}]}');
  assert.deepStrictEqual(dirty.candidates.map((c) => c.command), ["ok"]);
  ok("缺 command / 空 / 非字符串的候选被丢掉");

  // 启发式只提议**真的存在**的东西:本项目 package.json 里有 test 脚本
  const h = gs.heuristics(__dirname);
  assert.ok(h.some((c) => /npm (run )?test/.test(c.command)), "本项目应能猜出 npm test");
  // 不许凭空猜:一个空目录里应该什么都猜不出来
  const empty = path.join(os.tmpdir(), "cf-empty-" + process.pid);
  fs.mkdirSync(empty, { recursive: true });
  assert.deepStrictEqual(gs.heuristics(empty), [], "空目录不许猜出任何命令");
  fs.rmdirSync(empty);
  ok("启发式只认真实文件（空目录一条都不猜）");

  // npm run test / npm test 是同一条,不该占两个菜单位
  const dd = P('{"candidates":[{"command":"npm test"},{"command":"npm run test"}]}');
  assert.strictEqual(dd.candidates.length, 1, "npm test 与 npm run test 要去重");
  ok("等价命令去重（npm test ⇄ npm run test）");

  // noModel 时必须零调用、只走启发式 —— 这条是「不联网也能用」的保证
  const noModel = await gs.suggest({ cwd: __dirname, noModel: true });
  assert.strictEqual(noModel.source, "启发式");
  ok("noModel 时零调用,只走文件启发式");

  // ★ 目标没确立之前不许问协调者:它只能按仓库现状给通用命令,而那些命令
  //   长得像是为你的目标挑的 —— 比不给更误导。闸放在这一层,因为界面不止一个。
  assert.strictEqual(gs.taskEstablished("修一下"), true);
  assert.strictEqual(gs.taskEstablished("修"), false);
  assert.strictEqual(gs.taskEstablished("   "), false);
  assert.strictEqual(gs.taskEstablished(undefined), false);
  for (const t of [undefined, "", "  ", "修"]) {
    const r = await gs.suggest({ task: t, cwd: __dirname });   // 没目标 → 绝不该起协调者
    assert.strictEqual(r.source, "启发式", "没目标时不许问协调者（task=" + JSON.stringify(t) + "）");
    assert.strictEqual(r.basedOnTask, null);
    assert.ok(r.needsTask, "没目标时必须明说「先说要做什么」");
  }
  ok("★ 目标没确立 → 不问协调者，只给启发式并明说原因");

  // 候选要带上「为哪个目标挑的」,调用方才能在目标改了之后标脏
  const withTask = await gs.suggest({ task: "把重复回调修掉", cwd: __dirname, noModel: true });
  assert.strictEqual(withTask.basedOnTask, "把重复回调修掉");
  ok("候选带 basedOnTask（目标改了才能标脏）");

  // 页面上那道闸:按钮默认 disabled、目标变了标脏、目标清空无条件收掉候选
  const setupHtml = fs.readFileSync(path.join(__dirname, "setup.html"), "utf8");
  // 「重新取」按钮默认藏着:目标没确立、或还没取过候选时,它没有任何可做的事。
  // (更早那版是 disabled;改成 hide 之后这条断言要跟着改 —— 闸变了,钉子也得钉在新闸上)
  assert.ok(/id="suggest"[^>]*class="[^"]*\bhide\b|class="[^"]*\bhide\b[^"]*"[^>]*id="suggest"/.test(setupHtml),
    "「重新取」按钮默认必须是隐藏的");
  assert.ok(/toggle\("hide", !ok \|\| sugTask === null\)/.test(setupHtml),
    "只有目标确立且取过候选之后才许露出「重新取」");
  assert.ok(/sugTask !== str\("task"\)/.test(setupHtml), "目标改了要能看出候选过期");
  assert.ok(/目标改了/.test(setupHtml), "过期要有人话提示");
  assert.ok(setupHtml.indexOf("① 目标") >= 0 && setupHtml.indexOf("② 判据") >= 0,
    "页面顺序要写明先目标后判据");
  // 无条件收掉:之前是 if (sugTask !== null) 才收,于是别的路径留下的候选会在目标没了之后继续挂着
  const gateFn = /function syncSuggestGate\(\)[\s\S]*?\n}/.exec(setupHtml)[0];
  const notOk = gateFn.indexOf("if (!ok) {");
  const hide = gateFn.indexOf('box.classList.add("hide")');
  assert.ok(notOk >= 0 && hide > notOk, "目标不合格时要收掉候选");
  assert.ok(!/if \(sugTask !== null\) \{ box\.classList\.add\("hide"\)/.test(gateFn),
    "收候选不许再有 sugTask 前置条件");
  ok("页面：按钮默认禁用 / 目标改了标脏 / 目标清空无条件收候选");

  // 向导里目标是第一问,且太短会重问 —— 顺序不能反
  const tsrc0 = fs.readFileSync(path.join(__dirname, "tui.js"), "utf8");
  const qTask = tsrc0.indexOf('"① 要做什么？"');
  const qSuggest = tsrc0.indexOf("gsug.suggest(");
  assert.ok(qTask >= 0 && qSuggest > qTask, "向导必须先问目标再取候选");
  assert.ok(/while \(!gsug\.taskEstablished\(task\)\)/.test(tsrc0), "目标太短要重问");
  ok("向导：先问目标（太短重问），之后才按目标取候选");

  // ★ 协调者「没给出贴题候选」与「给了」在界面上必须长得不一样。
  //   原始 bug:协调者读了 47s、正确地判定这仓库没有相关检查并写在 note 里回了空候选,
  //   而两侧都静默退回文件启发式(`npm run test`),还把它当候选 1 / 自动填进判据 ——
  //   于是一条**与目标毫无关系**的命令成了 judge,用户无从看出。
  //   两侧都按来源分拨:贴题的才自动选,猜的必须标明「与目标无关」。
  for (const [src, name] of [[tsrc0, "tui"], [setupHtml, "页面"]]) {
    assert.ok(/from === "协调者"/.test(src), name + "：必须按来源(协调者/启发式)分拨候选");
    assert.ok(/与目标无关/.test(src), name + "：猜的那批必须标明与目标无关");
    assert.ok(/没找到跟这个目标相关的检查命令|说没有跟这个目标相关的检查命令/.test(src),
      name + "：协调者交白卷必须显眼地说出来");
    // 「它看过说没有」与「它压根没跑完」是两个不同的原因。报错原因必须是真的响了那一条 ——
    // 超时报成「这仓库没有相关检查」会让人去改判据,而实际该做的是重取或自己填。
    assert.ok(/没跑完/.test(src), name + "：超时/报错要与「看过说没有」分开报");
  }
  // 没有贴题候选时,默认值/自动填都不许落在「猜的」那条上
  assert.ok(/byCoord\.length \? "1" : "0"/.test(tsrc0), "tui：没有贴题候选时默认必须是「自己填」");
  assert.ok(/if \(byCoord\.length && \(!str\("cmd"\) \|\| wasAuto\)\)/.test(setupHtml),
    "页面：只有贴题候选才许自动填进判据命令");
  // 等待要报时间(那次调用真要 40~60s,不报时间会被当成卡死),且残字要整行清掉
  assert.ok(/读项目中…/.test(tsrc0) && /Date\.now\(\) - t0/.test(tsrc0), "tui：等协调者时要报已用秒数");
  assert.ok(/\\x1b\[2K\\r/.test(tsrc0), "tui：清 spinner 要整行清（留残字会看起来像两问一起出）");
  // 交白卷时 note 是它给出的**全部**理由 —— 折行,不许截断
  const tuiMod = require("./tui.js");
  const longNote = "当前仓库 code-forge 是对抗回环工具本身，不含支付相关代码。" +
    "package.json 里的 npm test 只测这个框架自己的事件流与判据逻辑，跑绿也说明不了支付回调修好了。";
  const wrapped = tuiMod.wrapText(longNote, 40, "   ");
  assert.ok(wrapped.length > 2, "长 note 要折成多行");
  const strip = function (s) { return s.replace(/\s+/g, ""); };
  assert.strictEqual(strip(wrapped.join("")), strip(longNote),
    "折行不许丢字（交白卷时这段话是唯一的理由）");
  assert.ok(wrapped.every(function (l) { return tuiMod.dispWidth(l) <= 43; }), "每行不许超宽");
  assert.ok(!/它说：" \+ clip\(/.test(tsrc0), "交白卷的 note 不许再用 clip 截断");
  ok("★ 协调者交白卷 ≠ 有贴题候选：两侧分拨来源、不自动填猜的、等待报时间、理由折行不截断");

  // 提议者用的是只读工具:它的活是看一眼然后提议,不是动手
  const gsrc = fs.readFileSync(path.join(__dirname, "gatesuggest.js"), "utf8");
  assert.ok(/"--allowedTools", "Read", "Grep", "Glob"/.test(gsrc), "建议者只许有只读工具");
  assert.ok(/不许发明/.test(gsrc), "提示词里必须明写不许发明命令");
  assert.ok(/timeoutMs/.test(gsrc) && /超时/.test(gsrc), "必须有超时（不能让人干等）");
  ok("建议者只读 + 提示词禁止发明 + 有超时");

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
  const arsrc = fs.readFileSync(path.join(__dirname, "agentrun.js"), "utf8");
  assert.ok(acsrc.indexOf("shell") < 0 || /不用 shell/.test(acsrc), "agentcli 不许走 shell");
  assert.ok(arsrc.indexOf('shell: true') < 0, "agentrun 不许再自己 spawn 带 shell");
  assert.ok(gsrc.indexOf("shell: true") < 0, "gatesuggest 不许再自己 spawn 带 shell");
  assert.ok(acsrc.indexOf("CODE_FORGE_AGENT_CLI") >= 0, "要能换成别的 agent 命令行");
  ok("起进程不走 shell，且执行者命令行可替换");

  // ---- 通用性要写清楚（这是用户会踩空的地方）----
  const ag = fs.readFileSync(path.join(__dirname, "AGENTS.md"), "utf8");
  assert.ok(/哪些通用/.test(ag), "AGENTS.md 要有通用性对照表");
  ["loop_begin", "forge-", "CODE_FORGE_AGENT_CLI", "文件启发式"].forEach(function (w) {
    assert.ok(ag.indexOf(w) >= 0, "通用性表里缺：" + w);
  });
  const sk = fs.readFileSync(path.join(__dirname, "skills", "code-forge", "SKILL.md"), "utf8");
  assert.ok(/候选/.test(sk) && /不许发明/.test(sk),
    "候选式确认必须写进技能（这才是跨宿主通用的那一半）");
  ok("通用性对照表在 AGENTS.md，候选式确认在技能里（跨宿主）");

  // ---- 终端界面（tui.js）----
  const tui = require("./tui.js");
  const st = tui.newState();
  [{ t: "run.start", session: "S", mode: "host", goal: "G", budget: { rounds: 6 } },
   { t: "role.add", id: "role1", name: "提议者", model: "sonnet" },
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
  assert.ok(out.indexOf("提议者") >= 0 && out.indexOf("判据") >= 0, "角色表要有名字");
  ok("TUI 渲染是纯函数：判据走势 / 停止原因 / 角色表都在");

  // 一条 gate 事件都没有时不许画一排「—」——那会被读成「量过了,没有数」
  const st2 = tui.newState();
  [{ t: "run.start", session: "S" }, { t: "round.start", n: 1 },
   { t: "event", round: 1, role: "r1", kind: "propose", summary: "x" }].forEach((e) => tui.reduce(st2, e));
  assert.ok(tui.render(st2, 96).indexOf("判据") < 0, "没有判据事件时整行不画");
  ok("没有判据事件时不画判据行（不假装量过）");

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

  // 非 TTY 时不许画屏:clear-screen 与 raw mode 在管道/CI 里只会产出垃圾
  const tsrc = fs.readFileSync(path.join(__dirname, "tui.js"), "utf8");
  assert.ok(/function paint\(\) \{\s*if \(!TTY\) return;/.test(tsrc), "paint 必须在非 TTY 时直接返回");
  assert.ok(/if \(TTY\) \{[\s\S]*setRawMode/.test(tsrc), "raw mode 必须裹在 TTY 判断里");
  ok("非 TTY 时退化成逐行输出（不画屏、不进 raw mode）");

  // ★ stdin 提前关掉必须吼一声 —— 否则 await 挂住、进程静默退出,用户以为命令坏了
  assert.ok(tsrc.indexOf('rl.once("close", onClose)') >= 0, "ask 必须守住 rl close");
  assert.ok(/stdin 不是终端/.test(tsrc), "非交互时要给出可行动的提示");
  assert.ok(tsrc.indexOf("--config") >= 0 && tsrc.indexOf("--preset") >= 0, "要有可脚本化的入口");
  ok("★ stdin 关掉时报错而不是静默退出，并给出 --config/--preset");

  // ---- 页面点 Run（headless agent）----
  const ar = fs.readFileSync(path.join(__dirname, "agentrun.js"), "utf8");
  // ★ 提示词必须走 stdin。Windows 上要 shell:true 才起得动 claude.cmd,而 shell 会把
  //   多行提示词切碎（实测:agent 只收到了第一个字「用」）。argv 里再出现提示词就是回归。
  assert.ok(ar.indexOf("child.stdin.write(prompt)") >= 0, "提示词必须写进 stdin");
  const argsLine = /const args = \[[^\]]*\]/.exec(ar)[0];
  assert.ok(argsLine.indexOf("prompt") < 0, "argv 里不许出现 prompt（shell 会切碎它）");
  ok("★ 提示词走 stdin,不进 argv（Windows shell 会切碎多行参数）");

  // 非交互模式没人能点确认 —— 五个回环工具与只读工具必须预先放行
  ["loop_begin", "loop_say", "loop_gate", "loop_status", "loop_end"].forEach(function (t) {
    assert.ok(ar.indexOf("mcp__code-forge__" + t) >= 0, "必须预先放行 " + t);
  });
  assert.ok(ar.indexOf("--allowedTools") >= 0, "要用 --allowedTools 精确放行,而不是整体放开");
  ok("回环工具预先放行（否则 headless 下卡在「等待权限授予中」）");

  // ★ --url 不许有默认值:mcp.js 把「传了 url」当成「别发现、别自动拉起」
  const srv = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
  assert.ok(srv.indexOf('serve({ url: opt("url", null) })') >= 0,
    "server.js 给 --url 传默认值会永久锁死 4610");
  ok("★ --url 无默认值（否则端口发现与自动拉起一起失效）");

  // 端口文件:4610 被占用会自动 +1,两边必须还能找到彼此
  const mcpSrc = fs.readFileSync(path.join(__dirname, "mcp.js"), "utf8");
  assert.ok(srv.indexOf("code-forge-port.json") >= 0 && mcpSrc.indexOf("code-forge-port.json") >= 0,
    "监控台要写端口文件,MCP 要读它");
  assert.ok(mcpSrc.indexOf("CODE_FORGE_URL") >= 0 && ar.indexOf("CODE_FORGE_URL") >= 0,
    "页面起的 agent 要把监控台地址传给它拉起的 MCP server");
  ok("端口/地址两侧都对得上（监控台换端口时仍能对上）");

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
    "反驳者与提议者必须跑在不同模型上");
  ok("三个角色定义齐全,且反驳者与提议者不同模型");

  // ★ 反驳者的写权限必须在**工具层面**就没有 —— 只写在提示词里挡不住顺手抹平
  ["Write", "Edit", "Bash", "NotebookEdit"].forEach(function (t) {
    assert.ok(parsed["forge-critic"].tools.indexOf(t) < 0,
      "forge-critic 不许有 " + t + " 工具（能改文件的反驳者会顺手把问题抹平)");
    assert.ok(parsed["forge-reviewer"].tools.indexOf(t) < 0, "forge-reviewer 不许有 " + t);
  });
  assert.ok(parsed["forge-proposer"].tools.indexOf("Edit") >= 0, "提议者得能改文件");
  ok("★ 反驳者/复核者工具层面就没有写权限（不是靠提示词请求）");

  // 提议者那份必须明写红线:不许改判据来达标
  assert.ok(/不许为了让判据变绿去改判据|不许.*改判据/.test(parsed["forge-proposer"].body),
    "提议者定义里必须明写不许改判据");
  ok("提议者定义里明写「不许改判据来达标」这条红线");

  // 技能里要把派发方式和模型表写清,否则装了角色也不会被用
  const skillSrc = fs.readFileSync(path.join(__dirname, "skills", "code-forge", "SKILL.md"), "utf8");
  ["forge-proposer", "forge-critic", "forge-reviewer", "并发"].forEach(function (w) {
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

  // ★ dry-run 真的必须什么都不做 —— 这里踩过:探测与注册写在一起,`--dry-run` 把 MCP 真装了
  const cliFn = /function tryClaudeCli\(\)[\s\S]*?\n}/.exec(inst)[0];
  const dryGuard = cliFn.indexOf("if (DRY)");
  const firstWrite = cliFn.indexOf("execFileSync(\"claude\", [\"mcp\"");
  assert.ok(dryGuard >= 0, "tryClaudeCli 必须有 DRY 分支");
  assert.ok(dryGuard < firstWrite, "DRY 分支必须在任何 mcp 写操作之前返回");
  ok("★ --dry-run 在任何 MCP 写操作之前就返回（不产生副作用）");
}

(async function main() {
  try {
    await testStateMachine();
    await testStops();
    await testMcpEndToEnd();
    await testPackaging();
    console.log("\n" + pass + " 项断言全部通过（宿主驱动模式）");
    process.exit(0);
  } catch (err) {
    console.error("\n✗ 失败：" + (err && err.message) + "\n" + (err && err.stack));
    process.exit(1);
  }
})();
