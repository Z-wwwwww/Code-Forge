"use strict";
/**
 * 判据命令的候选建议。
 *
 * 两条来源,合并去重:
 *   ① 协调者看一眼项目（headless `claude -p`,**只读工具**,小模型,严格 JSON 输出）
 *   ② 文件启发式（零调用、零等待:有 pytest.ini 就猜 pytest -q …）
 *
 * 三条纪律:
 *   - **只许提议仓库里已经能跑的命令**,不许发明脚本。仓库里压根没有可运行的检查时,
 *     必须如实回空 —— 编一条 `pytest -q` 给一个没有测试的仓库,比不建议更糟:
 *     用户会以为有判据,而第一轮 loop_gate 会报 gate_broken。
 *   - **绝不阻塞**:模型失败/超时/吐垃圾,一律退回启发式;启发式也没有就回空,让人自己填。
 *   - **建议不等于验证**。这里不去跑那条命令(可能很慢),第一轮 loop_gate 会真跑它,
 *     跑不起来是 gate_broken 而不是「未达标」—— 这个区别在页面与终端上都看得见。
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

/* ---------------- ① 文件启发式（零调用） ---------------- */
const HEURISTICS = [
  { file: "pytest.ini", cmd: "pytest -q", why: "有 pytest.ini" },
  { file: "tox.ini", cmd: "pytest -q", why: "有 tox.ini" },
  { file: "Cargo.toml", cmd: "cargo test", why: "Rust 项目" },
  { file: "go.mod", cmd: "go test ./...", why: "Go 项目" },
  { file: "Makefile", cmd: "make test", why: "有 Makefile" },
  { file: "pom.xml", cmd: "mvn -q test", why: "Maven 项目" },
  { file: "build.gradle", cmd: "gradle test", why: "Gradle 项目" }
];

function heuristics(cwd) {
  const out = [];
  const has = function (f) { try { return fs.existsSync(path.join(cwd, f)); } catch (_) { return false; } };

  HEURISTICS.forEach(function (h) {
    if (has(h.file)) out.push({ command: h.cmd, why: h.why, from: "文件启发式" });
  });

  // package.json 要看它**真的有**哪个脚本 —— 猜一个不存在的 npm run 是在制造 gate_broken
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
    const s = pkg.scripts || {};
    ["test", "lint", "typecheck", "check"].forEach(function (k) {
      if (s[k]) out.push({ command: "npm run " + k, why: "package.json 里有 " + k + " 脚本", from: "文件启发式" });
    });
  } catch (_) {}

  // pyproject 只在真的配了 pytest 时才提议
  try {
    const t = fs.readFileSync(path.join(cwd, "pyproject.toml"), "utf8");
    if (/pytest/.test(t)) out.push({ command: "pytest -q", why: "pyproject.toml 里提到 pytest", from: "文件启发式" });
  } catch (_) {}

  return dedupe(out);
}

// `npm run test` 与 `npm test` 是同一条,占两个菜单位就是浪费(且看起来像凑数)
function canonical(cmd) {
  return String(cmd || "").trim()
    .replace(/^npm\s+run\s+(test|start)\b/, "npm $1")
    .replace(/\s+/g, " ");
}
function dedupe(list) {
  const seen = {};
  return list.filter(function (c) {
    const k = canonical(c.command);
    if (!k || seen[k]) return false;
    seen[k] = true;
    return true;
  });
}

/* ---------------- ② 协调者看一眼项目 ---------------- */
function buildPrompt(task, cwd) {
  return [
    "我要在这个仓库里跑一个「改到判据变绿」的回环,需要一条**判据命令**。",
    "",
    "要做的事：" + (task || "（没说,按仓库现状给通用的检查命令）"),
    "",
    "请先看一眼仓库(README / package.json / pyproject.toml / Makefile / CI 配置 / 测试目录),",
    "然后给出 2~4 条**这个仓库现在就能跑**的检查命令,按可信度从高到低排。",
    "",
    "硬要求:",
    "- 只许提议仓库里**已经存在**的命令(脚本在 package.json 里、测试目录真的有用例、CI 里在用的那条)。",
    "  **不许发明**不存在的脚本名或参数。",
    "- 与「要做的事」相关的排前面:改支付回调就优先跑那部分的测试,而不是全量。",
    "- 如果这个仓库**没有任何可运行的检查**,就回空数组并在 note 里说清 —— 这比编一条更有用。",
    "- 不要跑任何命令(你只有只读工具),也不要改任何文件。",
    "",
    "只输出 JSON,不要解释、不要 markdown 代码块:",
    '{"candidates":[{"command":"pytest -q tests/webhook","why":"tests/webhook 下有 12 个用例,覆盖回调路径",' +
      '"metric":{"name":"覆盖率","pattern":"coverage: ([0-9]+)"}}],"note":"..."}',
    "",
    "metric 可选:只有当那条命令的输出里**确实**会打印一个可抓的数(覆盖率、通过数)时才给,",
    "pattern 是能抓到它的正则(第一个捕获组是数字)。不确定就别给。"
  ].join("\n");
}

/** 从模型输出里挖 JSON。它可能裹了 markdown 或前后带话,不许因此整条失败。 */
function parseCandidates(text) {
  if (!text) return { candidates: [], note: null };
  let s = String(text).trim();
  // stream/json 模式下最外层可能是 {"type":"result","result":"..."},先剥一层
  try {
    const outer = JSON.parse(s);
    if (outer && typeof outer.result === "string") s = outer.result.trim();
    else if (outer && Array.isArray(outer.candidates)) return normalize(outer);
  } catch (_) {}
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  const i = s.indexOf("{"), j = s.lastIndexOf("}");
  if (i < 0 || j <= i) return { candidates: [], note: null };
  try { return normalize(JSON.parse(s.slice(i, j + 1))); }
  catch (_) { return { candidates: [], note: null }; }
}

function normalize(obj) {
  const list = Array.isArray(obj && obj.candidates) ? obj.candidates : [];
  return {
    candidates: dedupe(list
      .filter(function (c) { return c && typeof c.command === "string" && c.command.trim(); })
      .map(function (c) {
        return {
          command: c.command.trim(),
          why: typeof c.why === "string" ? c.why.trim() : "",
          metric: c.metric && typeof c.metric.pattern === "string"
            ? { name: (c.metric.name || "指标"), pattern: c.metric.pattern,
                min: typeof c.metric.min === "number" ? c.metric.min : null,
                max: typeof c.metric.max === "number" ? c.metric.max : null }
            : null,
          from: "协调者"
        };
      })).slice(0, 4),
    note: typeof (obj && obj.note) === "string" ? obj.note : null
  };
}

function askCoordinator(task, cwd, opts) {
  opts = opts || {};
  return new Promise(function (resolve) {
    const cli = require("./agentcli.js");
    const model = cli.safeModel(opts.model) || "haiku";   // 白名单:这是唯一进 argv 的用户可控值
    const args = ["-p", "--output-format", "json",
      // 只读:它的活是「看一眼然后提议」,不是动手
      "--allowedTools", "Read", "Grep", "Glob",
      "--permission-mode", "acceptEdits",
      "--model", model];
    const started = cli.run(args, { cwd: cwd });
    if (started.error) return resolve({ candidates: [], note: null, error: started.error });
    const child = started.child;
    let out = "", err = "";
    let settled = false;
    const done = function (r) { if (!settled) { settled = true; try { child.kill(); } catch (_) {} resolve(r); } };
    // 超时必须有:让人在终端里干等一个可能永不返回的调用是最糟的
    const timer = setTimeout(function () {
      done({ candidates: [], note: null, error: "协调者超时（" + (opts.timeoutMs || 60000) / 1000 + "s）" });
    }, opts.timeoutMs || 60000);

    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { err += d.toString(); });
    child.on("error", (e) => { clearTimeout(timer); done({ candidates: [], note: null, error: e.message }); });
    child.on("close", function () {
      clearTimeout(timer);
      const parsed = parseCandidates(out);
      if (!parsed.candidates.length && !parsed.note) {
        parsed.error = err.trim().split("\n")[0] || "协调者没给出可用的候选";
      }
      done(parsed);
    });
    try { child.stdin.write(buildPrompt(task, cwd)); child.stdin.end(); } catch (_) {}
  });
}

/**
 * 合并两条来源。协调者的排前面(它看过项目),启发式补后面。
 * 任何一侧失败都不影响另一侧 —— 这个功能只该让填写更省事,不该成为新的失败点。
 */
async function suggest(opts) {
  opts = opts || {};
  const cwd = opts.cwd && fs.existsSync(opts.cwd) ? opts.cwd : process.cwd();
  const h = heuristics(cwd);
  if (opts.noModel) return { candidates: h, note: null, source: "启发式" };
  const c = await askCoordinator(opts.task, cwd, opts);
  return {
    candidates: dedupe(c.candidates.concat(h)),
    note: c.note || null,
    error: c.error || null,
    source: c.candidates.length ? "协调者 + 启发式" : "启发式"
  };
}

module.exports = { suggest: suggest, heuristics: heuristics, parseCandidates: parseCandidates,
  buildPrompt: buildPrompt, askCoordinator: askCoordinator };
