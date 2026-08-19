"use strict";
/**
 * 端到端自测。零依赖、零 key(全走 mock provider)、不碰真网络。
 *   node test.js
 *
 * 钉住的是「会静默出错的那几条」:停止原因必须是真的那一条、预算是硬闸、
 * 判据坏了不许当成未达标、取消要记估算而不是记 0、MCP 握手真的能握上。
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const net = require("net");
const loop = require("./loop.js");
const gate = require("./gate.js");

let pass = 0;
function ok(name) { pass++; console.log("  ✓ " + name); }

function collect() {
  const events = [];
  return {
    events: events,
    append: function (e) { (Array.isArray(e) ? e : [e]).forEach(function (x) { events.push(x); }); }
  };
}
const ROLES = [
  { name: "提议者", kind: "propose", provider: "mock", model: "mock" },
  { name: "反驳者", kind: "attack", provider: "mock", model: "mock" },
  { name: "复核者", kind: "audit", provider: "mock", model: "mock", trigger: "on_green" }
];
const endOf = function (evs) { return evs.filter(function (e) { return e.t === "run.end"; }).pop(); };

/* ---------------- gate:判据全在代码 ---------------- */
async function testGate() {
  console.log("gate — 判据");

  const okRes = await gate.check({ command: process.execPath + " -e \"console.log('coverage: 91%')\"",
    metric: { name: "覆盖率", pattern: "coverage: (\\d+)", min: 80 } });
  assert.strictEqual(okRes.met, true);
  assert.strictEqual(okRes.value, 91);
  ok("退出码 0 且指标达标 → met");

  const low = await gate.check({ command: process.execPath + " -e \"console.log('coverage: 71%')\"",
    metric: { name: "覆盖率", pattern: "coverage: (\\d+)", min: 80 } });
  assert.strictEqual(low.met, false);
  assert.strictEqual(low.value, 71);
  ok("指标未达标 → 不 met,且值如实记下");

  const nonzero = await gate.check({ command: process.execPath + " -e \"process.exit(1)\"" });
  assert.strictEqual(nonzero.met, false);
  assert.strictEqual(nonzero.exitCode, 1);
  ok("退出码非 0 → 不 met");

  // 抓不到数不许当达标:「量不出来」与「量出来合格」是两件事
  const nomatch = await gate.check({ command: process.execPath + " -e \"console.log('nothing')\"",
    metric: { name: "覆盖率", pattern: "coverage: (\\d+)", min: 80 } });
  assert.strictEqual(nomatch.met, false);
  assert.strictEqual(nomatch.value, null);
  ok("指标抓不到 → 不 met(不许当合格)");

  const broken = await gate.check({ command: "definitely-not-a-real-binary-xyz --nope" });
  assert.strictEqual(broken.met, false);
  assert.ok(broken.broken || broken.exitCode !== 0, "命令跑不起来必须能看出异常");
  ok("判据命令本身失败 → 标出来,不静默当未达标");

  const skipped = await gate.check({});
  assert.strictEqual(skipped.met, false);
  assert.ok(skipped.skipped, "没配命令要如实说 skipped");
  ok("没有判据 → skipped,绝不签「已达标」");

  assert.strictEqual(gate.madeProgress({ metric: { min: 80 } }, 70, 74), true);
  assert.strictEqual(gate.madeProgress({ metric: { min: 80 } }, 74, 74), false);
  ok("进展判定按目标方向算");
}

/* ---------------- loop:停止原因 ---------------- */
async function testStopReasons() {
  console.log("loop — 停止原因");

  var c = collect();
  var r = loop.start({
    session: "达标", roles: ROLES,
    goal: { command: process.execPath + " -e \"console.log('coverage: 95%')\"",
      metric: { name: "覆盖率", pattern: "coverage: (\\d+)", min: 80 } },
    budget: { tokens: 500000, seconds: 600, rounds: 5 }
  }, c.append);
  assert.strictEqual(await r.done, "goal_met");
  assert.strictEqual(endOf(c.events).reason, "goal_met");
  // 达标那一轮之后不许再开新轮
  assert.strictEqual(c.events.filter(function (e) { return e.t === "round.start"; }).length, 1);
  ok("达标即停,且不再开新一轮");

  // trigger: on_green 的角色只在判绿那轮发言
  var greenSpeaker = c.events.filter(function (e) { return e.t === "event" && e.role === "role3"; });
  assert.strictEqual(greenSpeaker.length, 1, "复核者应恰好发言一次");
  ok("on_green 角色只在判据判绿后发言");

  c = collect();
  r = loop.start({
    session: "零进展", roles: ROLES.slice(0, 2),
    goal: { command: process.execPath + " -e \"console.log('coverage: 71%')\"",
      metric: { name: "覆盖率", pattern: "coverage: (\\d+)", min: 80 } },
    budget: { tokens: 500000, seconds: 600, rounds: 9, noProgressRounds: 2 }
  }, c.append);
  assert.strictEqual(await r.done, "no_progress");
  assert.ok(/停在 71/.test(endOf(c.events).detail), "零进展要说清停在哪个值");
  ok("指标不动 → no_progress(不等烧完预算)");

  c = collect();
  r = loop.start({
    session: "预算", roles: ROLES.slice(0, 2),
    goal: { command: process.execPath + " -e \"console.log('coverage: 1%')\"",
      metric: { name: "覆盖率", pattern: "coverage: (\\d+)", min: 80 } },
    budget: { tokens: 1200, seconds: 600, rounds: 9, noProgressRounds: 99 }
  }, c.append);
  assert.strictEqual(await r.done, "budget_tokens");
  ok("token 预算是硬闸 → budget_tokens");

  c = collect();
  r = loop.start({
    session: "轮数", roles: [ROLES[0]],
    goal: { command: process.execPath + " -e \"process.exit(1)\"" },
    budget: { tokens: 500000, seconds: 600, rounds: 2, noProgressRounds: 99 }
  }, c.append);
  assert.strictEqual(await r.done, "max_rounds");
  assert.strictEqual(c.events.filter(function (e) { return e.t === "round.start"; }).length, 2);
  ok("轮数上限 → max_rounds");

  c = collect();
  r = loop.start({
    session: "判据坏了", roles: [ROLES[0]],
    goal: { command: "definitely-not-a-real-binary-xyz" },
    budget: { tokens: 500000, seconds: 600, rounds: 5 }
  }, c.append);
  var reason = await r.done;
  assert.ok(reason === "gate_broken" || reason === "max_rounds", "判据坏了不能报成 goal_met,实得 " + reason);
  assert.notStrictEqual(reason, "goal_met");
  ok("判据命令坏掉 → 绝不报 goal_met");

  c = collect();
  r = loop.start({
    session: "手动停", roles: ROLES,
    goal: { command: process.execPath + " -e \"console.log('coverage: 1%')\"",
      metric: { pattern: "coverage: (\\d+)", min: 80 } },
    budget: { tokens: 500000, seconds: 600, rounds: 9, noProgressRounds: 99 }
  }, c.append);
  setTimeout(function () { r.stop(); }, 30);
  assert.strictEqual(await r.done, "stopped");
  ok("stop() → stopped");
}

/* ---------------- loop:记账 ---------------- */
async function testAccounting() {
  console.log("loop — 记账");

  const c = collect();
  const r = loop.start({
    session: "记账", roles: ROLES.slice(0, 2),
    goal: { command: process.execPath + " -e \"process.exit(1)\"" },
    budget: { tokens: 500000, seconds: 600, rounds: 2, noProgressRounds: 99 }
  }, c.append);
  await r.done;

  const modelEvents = c.events.filter(function (e) {
    return e.t === "event" && e.role !== "gate";
  });
  const sum = modelEvents.reduce(function (a, e) { return a + e.tok.in + e.tok.out; }, 0);
  assert.strictEqual(sum, r.spent.in + r.spent.out, "事件里的 token 之和必须等于账上花的");
  ok("事件流的 token 之和 = 驱动记的花费(同一个数,一处算)");

  const gateEvents = c.events.filter(function (e) { return e.t === "event" && e.role === "gate"; });
  assert.ok(gateEvents.length >= 1);
  gateEvents.forEach(function (e) {
    assert.strictEqual(e.tok.in + e.tok.out, 0, "判据是代码,不该有 token");
  });
  ok("判据零 token(它是代码,不是模型)");

  // 判据也在角色表里,否则页面上看不出停止是谁判的
  const roleAdds = c.events.filter(function (e) { return e.t === "role.add"; });
  assert.ok(roleAdds.some(function (e) { return e.id === "gate"; }), "判据必须作为角色登记");
  ok("判据在角色表里有身份");

  // 分歧点只在真出现「提议 → 反驳」时记,两侧原话来自各自事件
  const conflicts = c.events.filter(function (e) { return e.t === "conflict"; });
  assert.ok(conflicts.length >= 1);
  conflicts.forEach(function (cf) {
    assert.ok(cf.aClaim && cf.bClaim, "分歧两侧都要有原话");
    const claims = modelEvents.map(function (e) { return e.body; }).join("\n");
    assert.ok(claims.indexOf(cf.aClaim.replace(/…$/, "").slice(0, 20)) >= 0, "aClaim 必须出自真实事件,不许编");
  });
  ok("分歧点两侧原话都出自真实事件(不编造)");
}

/* ---------------- 取消:记估算而不是记 0 ---------------- */
async function testCancelBilling() {
  console.log("providers — 取消记账");
  const providers = require("./providers.js");
  const ac = new AbortController();
  ac.abort();
  let threw = false;
  try {
    await providers.call({ provider: "anthropic", model: "claude-opus-5" },
      { system: "s", user: "u" }, { signal: ac.signal });
  } catch (e) { threw = true; }
  assert.ok(threw, "被取消/缺 key 的调用必须抛错,由 loop 记账");
  ok("取消或缺 key 的调用会抛错(不静默返回空)");

  // loop 侧:失败/取消的事件也要落一条,且标出 estimated / failed
  const c = collect();
  const r = loop.start({
    session: "缺 key", roles: [{ name: "真调用", kind: "propose", provider: "anthropic", model: "claude-opus-5" }],
    goal: { command: process.execPath + " -e \"process.exit(1)\"" },
    budget: { tokens: 100000, seconds: 60, rounds: 1 }
  }, c.append);
  await r.done;
  const failed = c.events.filter(function (e) { return e.t === "event" && e.meta && e.meta.failed; });
  assert.strictEqual(failed.length, 1, "失败的调用必须留一条事件");
  ok("调用失败照样留痕(不静默跳过)");
}

// MCP 的覆盖在 test-host.js（宿主驱动模式的 loop_* 工具）——
// 这里刻意不留一份旧的 console_* 版本,两份会漂。

/* ---------------- HTTP:起/停 ---------------- */
function testHttp() {
  console.log("server — /runs 与 /runs/stop");
  const logFile = path.join(os.tmpdir(), "cf-test-" + process.pid + ".jsonl");
  const port = 4771;
  const child = spawn(process.execPath,
    [path.join(__dirname, "server.js"), "--no-open", "--reset", "--file", logFile, "--port", String(port)],
    { stdio: ["ignore", "pipe", "pipe"] });
  const base = "http://localhost:" + port;

  return new Promise(function (resolve, reject) {
    let ready = false;
    child.stdout.on("data", function (b) {
      if (!ready && /监控台/.test(b.toString())) { ready = true; go(); }
    });
    child.on("error", reject);
    setTimeout(function () { if (!ready) { child.kill(); reject(new Error("服务起不来")); } }, 8000);

    async function go() {
      try {
        const cfg = {
          session: "HTTP 测试",
          roles: [{ name: "提议者", kind: "propose", provider: "mock", model: "mock" }],
          goal: { command: process.execPath + " -e \"process.exit(1)\"" },
          budget: { tokens: 500000, seconds: 600, rounds: 40, noProgressRounds: 99 }
        };
        const post = function (p, body) {
          return fetch(base + p, {
            method: "POST", headers: { "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body)
          });
        };

        let r = await post("/runs", { roles: [] });
        assert.strictEqual(r.status, 400);
        ok("没有角色 → 400(不静默起一个空回环)");

        r = await post("/runs", cfg);
        assert.strictEqual(r.status, 200);
        ok("POST /runs 起一次回环");

        r = await post("/runs", cfg);
        assert.strictEqual(r.status, 409);
        ok("已有回环在跑 → 409(两个 driver 写同一条流会分不清谁说的)");

        let h = await (await fetch(base + "/health")).json();
        assert.strictEqual(h.run.active, true);
        ok("/health 报告在跑");

        r = await post("/runs/stop");
        assert.strictEqual(r.status, 200);
        // 等 driver 收摊
        for (let i = 0; i < 60; i++) {
          h = await (await fetch(base + "/health")).json();
          if (!h.run.active) break;
          await new Promise(function (s) { setTimeout(s, 100); });
        }
        assert.strictEqual(h.run.active, false);
        assert.strictEqual(h.run.lastReason, "stopped");
        ok("POST /runs/stop 真的停下来,并记住原因是 stopped");

        r = await post("/runs/stop");
        assert.strictEqual(r.status, 409);
        ok("没有在跑时停止 → 409(不假装停了)");

        // 落盘的日志能读回同一份事实
        const lines = fs.readFileSync(logFile, "utf8").trim().split("\n").map(JSON.parse);
        assert.ok(lines.some(function (e) { return e.t === "run.start"; }));
        assert.strictEqual(lines.filter(function (e) { return e.t === "run.end"; }).pop().reason, "stopped");
        ok("事件全部落盘,停止原因写进 run.end");

        // （2026-08 收窄）/setup(网页 Run)删了 —— 执行只发生在 coding agent 里。404 是刻意的。
        assert.strictEqual((await fetch(base + "/setup")).status, 404, "/setup 该 404（执行路线已移除）");
        // /agent/run 要回 410 + 指路,老脚本打过来不能装死
        const gone = await fetch(base + "/agent/run", { method: "POST",
          headers: { "content-type": "application/json" }, body: "{}" });
        assert.strictEqual(gone.status, 410, "/agent/run 该回 410");
        assert.ok(/code-forge/.test((await gone.json()).error), "410 里要指回 /code-forge");
        ok("执行路线的入口已封:/setup 404、/agent/run 410 并指路");

        const local = await fetch(base + "/setup-local");
        assert.strictEqual(local.status, 200);
        assert.ok(/本地驱动/.test(await local.text()), "/setup-local 应是自带 key 那套");
        ok("GET /setup-local 托出本地驱动配置页");

        child.kill();
        try { fs.unlinkSync(logFile); } catch (_) {}
        resolve();
      } catch (e) { child.kill(); reject(e); }
    }
  });
}


/* ---------------- 端口被占用时的重试 ---------------- */
/**
 * ★ server.listen(port, host, cb) 会把 cb 挂成 listening 监听器。EADDRINUSE 重试时
 *   复用同一个 net.Server 而不摘掉上一次的 cb,最终绑定成功时 Node 会把历次累积的
 *   cb **全触发一遍**:N 条「监控台已启动」横幅(前 N-1 条印着错端口)、N 次写端口文件、
 *   没有 --no-open 时 N 个浏览器标签页。
 *   钉住:横幅只许出现一次,且横幅上的端口 == 端口文件里的 port。
 */
async function testPortRetry() {
  console.log("server — 端口被占用时的重试");
  const logFile = path.join(os.tmpdir(), "cf-retry-" + process.pid + ".jsonl");
  const nap = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  const grab = function (p) {
    return new Promise(function (res, rej) {
      const s = net.createServer();
      s.once("error", rej);
      s.listen(p, "127.0.0.1", function () { res(s); });
    });
  };
  // 抓 4 个连号端口,再把最后一个放掉 —— 前 3 个占住,server 应当正好退让到第 4 个
  let held = [];
  for (let start = 4793; start < 4900; start += 4) {
    held = [];
    let all = true;
    for (let i = 0; i < 4; i++) {
      try { held.push(await grab(start + i)); } catch (_) { all = false; break; }
    }
    if (all) break;
    held.forEach(function (s) { try { s.close(); } catch (_) {} });
    held = [];
  }
  assert.strictEqual(held.length, 4, "本机找不到 4 个连号的空端口,测不了");
  const busy = held[0].address().port;
  const expect = busy + 3;
  await new Promise(function (r) { held.pop().close(r); });   // 放掉第 4 个

  const child = spawn(process.execPath,
    [path.join(__dirname, "server.js"), "--no-open", "--reset", "--file", logFile, "--port", String(busy)],
    { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", function (b) { out += b.toString(); });
  const BANNER = "对抗编程监控台\\s+http://localhost:(\\d+)";
  try {
    for (let i = 0; i < 100 && !/对抗编程监控台/.test(out); i++) await nap(100);
    assert.ok(/对抗编程监控台/.test(out), "监控台没起来,stdout:\n" + out);
    await nap(700);                                            // 多余的横幅是紧接着打的
    const hits = out.match(new RegExp(BANNER, "g")) || [];
    assert.strictEqual(hits.length, 1,
      "★ 端口重试后启动横幅只许打一次,实际 " + hits.length + " 条:\n" + out);
    const shown = Number(new RegExp(BANNER).exec(out)[1]);
    assert.strictEqual(shown, expect, "横幅上的端口该是真正绑上的那个(" + expect + ")");
    const info = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), "code-forge-port.json"), "utf8"));
    assert.strictEqual(info.port, shown, "★ 端口文件与横幅必须是同一个端口");
    ok("★ 端口被占用 → 只报一次启动,横幅端口 == 端口文件端口(不再重复触发 ready)");
  } finally {
    try { child.kill(); } catch (_) {}
    held.forEach(function (s) { try { s.close(); } catch (_) {} });
    try { fs.unlinkSync(logFile); } catch (_) {}
  }
}

(async function main() {
  try {
    await testGate();
    await testStopReasons();
    await testAccounting();
    await testCancelBilling();
    await testHttp();
    await testPortRetry();
    console.log("\n" + pass + " 项断言全部通过");
    process.exit(0);
  } catch (err) {
    console.error("\n✗ 失败：" + (err && err.message) + "\n" + (err && err.stack));
    process.exit(1);
  }
})();
