#!/usr/bin/env node
"use strict";
/**
 * 自动接入 Claude Code(用户级)。
 *
 *   node install.js              装
 *   node install.js --uninstall  卸
 *   node install.js --dry-run    只看会动哪些文件
 *
 * 走的全是**受支持的用户级配置**:
 *   ~/.claude/skills/code-forge/SKILL.md   技能
 *   ~/.claude/agents/adv-*.md                    三个角色(各绑不同模型)
 *   ~/.claude/commands/code-forge.md       /code-forge 斜杠命令
 *   MCP:优先 `claude mcp add --scope user`,没有 CLI 就写 ~/.claude.json 的 mcpServers
 *
 * ⚠ 刻意**不动** ~/.claude/plugins/*.json（installed_plugins / known_marketplaces）——
 * 那是插件管理器的内部账本,手改会把 /plugin 弄坏。要走插件那条路就用 /plugin marketplace add。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const HERE = __dirname;
const HOME = os.homedir();
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, ".claude");
const MCP_NAME = "code-forge";

const argv = process.argv.slice(2);
const has = (f) => argv.includes("--" + f);
const DRY = has("dry-run");
const UNINSTALL = has("uninstall");

/**
 * 运行时装在哪。
 *
 * 关键在 npx:`npx code-forge install` 时 __dirname 在 npm 的临时缓存里,
 * 那个目录**过一阵就没了**。把 MCP 指到那儿,注册当时能用,几天后 agent 一调
 * loop_begin 就是「找不到模块」—— 而且看上去像是插件坏了,不像是装法有问题。
 * 所以从临时目录跑时先把运行时**复制**到 ~/.claude/code-forge/,再指到那份副本。
 * 从 clone 出来的仓库里跑就直接指仓库(改代码立刻生效,开发的人要的是这个)。
 */
const RUNTIME_DIR = path.join(CLAUDE_DIR, "code-forge");
const EPHEMERAL = /[\\/](_npx|\.npm[\\/]_cacache|npm-cache)[\\/]/i.test(HERE) ||
  (process.env.npm_config_cache && HERE.startsWith(process.env.npm_config_cache));
const COPY = has("copy") || (EPHEMERAL && !has("no-copy"));
// MCP 指向哪一份 server.js —— 复制过就指副本,否则指这里
const RUNTIME = COPY ? RUNTIME_DIR : HERE;

const done = [];
const skipped = [];
const failed = [];

function say(s) { console.log(s); }
function C_dim(s) { return (process.stdout.isTTY && !process.env.NO_COLOR) ? "\x1b[90m" + s + "\x1b[0m" : s; }
function rel(p) { return p.replace(HOME, "~"); }

function writeFile(dest, content) {
  if (DRY) { say("  [dry] 写 " + rel(dest)); return; }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest) && fs.readFileSync(dest, "utf8") === content) {
    skipped.push(rel(dest) + "（内容相同）");
    return;
  }
  fs.writeFileSync(dest, content, "utf8");
  done.push(rel(dest));
}
function removeFile(dest) {
  if (!fs.existsSync(dest)) { skipped.push(rel(dest) + "（本来就没有）"); return; }
  if (DRY) { say("  [dry] 删 " + rel(dest)); return; }
  fs.unlinkSync(dest);
  done.push("删 " + rel(dest));
  // 技能是「一个目录一个技能」,删了文件留下空目录会让人以为它还在。
  // 只删空的、且只删我们自己建的那一层(不往上爬到 ~/.claude/skills 本身)。
  const dir = path.dirname(dest);
  const guard = path.join(CLAUDE_DIR, "skills");
  if (dir !== guard && dir.startsWith(guard)) {
    try {
      if (fs.readdirSync(dir).length === 0) { fs.rmdirSync(dir); done.push("删 " + rel(dir) + "（空目录）"); }
    } catch (_) {}
  }
}

/* ---------------- 运行时副本（npx 那条路） ---------------- */
function copyTree(src, dst) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    if (!DRY) fs.mkdirSync(dst, { recursive: true });
    fs.readdirSync(src).forEach((f) => copyTree(path.join(src, f), path.join(dst, f)));
    return;
  }
  if (DRY) return;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

function installRuntime() {
  // 从副本自己跑的:什么都不用做,否则会自己复制自己
  if (path.resolve(HERE) === path.resolve(RUNTIME_DIR)) { skipped.push("运行时已经就位"); return; }
  // 抄谁:以 package.json 的 files 为准 —— 那是唯一一份「跑起来需要哪些文件」的清单,
  // 在这里另写一份,两份迟早对不上(而对不上的表现是运行时 require 失败)
  let list = [];
  try {
    list = JSON.parse(fs.readFileSync(path.join(HERE, "package.json"), "utf8")).files || [];
  } catch (_) {}
  list = list.concat(["package.json"]).filter((f) => fs.existsSync(path.join(HERE, f)));
  if (!list.length) { failed.push("找不到要复制的运行时文件（package.json 的 files 空了?）"); return; }
  if (DRY) { say("  [dry] 复制运行时 " + list.length + " 项 → " + rel(RUNTIME_DIR)); return; }
  fs.rmSync(RUNTIME_DIR, { recursive: true, force: true });   // 旧版本残留会盖不掉,先清
  list.forEach((f) => copyTree(path.join(HERE, f), path.join(RUNTIME_DIR, f)));
  done.push("运行时 → " + rel(RUNTIME_DIR) + "（" + list.length + " 项）");
}

/* ---------------- 把 `code-forge` 这条命令放进 PATH ---------------- */
/**
 * 上一版漏了这一步:技能/角色/MCP 都装好了,但 `code-forge go` 是「command not found」——
 * README 通篇在教人打 `code-forge xxx`,而装完根本没有这条命令。装了一半比没装更让人困惑。
 *
 * 从 clone 出来的仓库跑用 `npm link`(改代码立刻生效,开发的人要的是这个);
 * 从副本跑用 `npm i -g <副本>`。两条都可能因为权限/npm 前缀失败 —— 失败不算致命,
 * 打一行「你自己跑这条」就够了,别把整个安装判死。
 */
/**
 * 找 npm 的 JS 入口,用**当前这个 node** 去跑它。
 *
 * 为什么不直接 execFileSync("npm"/"npm.cmd"):实测两条都不通 ——
 *   npm      → ENOENT（execFile 不做 PATHEXT 补全）
 *   npm.cmd  → EINVAL（CVE-2024-27980 之后 Node 不再允许不带 shell 直接起 .cmd/.bat）
 * 而 shell:true 配一个可能带空格或 & 的路径参数,正是这个仓库刻意避开的那种拼接。
 * 走 npm-cli.js 两个问题一起没有:参数按数组原样传,也不碰 shell。
 */
function npmCli() {
  const dir = path.dirname(process.execPath);
  const cands = [
    path.join(dir, "node_modules", "npm", "bin", "npm-cli.js"),            // Windows / nvm4w
    path.join(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js") // 类 Unix
  ];
  for (const c of cands) { if (fs.existsSync(c)) return c; }
  return null;
}

function runNpm(args, cwd) {
  const cli = npmCli();
  if (!cli) return "找不到 npm（node 旁边没有 npm-cli.js）";
  try {
    execFileSync(process.execPath, [cli].concat(args), { cwd: cwd, stdio: "ignore" });
    return null;
  } catch (e) { return e.message.split("\n")[0]; }
}

function binCommandWorks() {
  // 同 haveClaudeCli:自己扫 PATH,不 spawn 一个 where(~90ms)。
  // ⚠ 必须在 npm link/i -g **之后**才调 —— which 有进程内缓存,提前问会把「还没装上」缓存住。
  return !!require("./agentcli.js").which("code-forge");
}

function installBin() {
  const args = COPY ? ["i", "-g", RUNTIME_DIR] : ["link"];
  const cwd = COPY ? process.cwd() : HERE;
  if (DRY) { say("  [dry] npm " + args.join(" ") + (COPY ? "" : "（在 " + rel(HERE) + "）")); return; }
  const err = runNpm(args, cwd);
  if (err) {
    failed.push("`code-forge` 没能放进 PATH（" + err + "）。自己跑一次:  npm " + args.join(" ") +
      (COPY ? "" : "   （在 " + rel(HERE) + " 里）") +
      "\n    不装也能用,只是要打全:  node " + rel(path.join(RUNTIME, "server.js")) + " go \"…\"");
    return;
  }
  if (binCommandWorks()) {
    done.push("`code-forge` 命令（npm " + args.join(" ") + "）");
  } else {
    // npm 说成功但 which 找不到 = npm 的全局 bin 目录不在 PATH 里。这是个**用户侧**问题,
    // 得说清楚是哪一段没接上,否则他只会觉得「装了但没用」。
    let prefix = "（npm prefix 取不到）";
    const cli = npmCli();
    if (cli) {
      try { prefix = String(execFileSync(process.execPath, [cli, "prefix", "-g"],
        { encoding: "utf8" })).trim(); } catch (_) {}
    }
    failed.push("npm 装成功了,但 PATH 里还是找不到 `code-forge` —— " +
      "npm 的全局 bin 目录没在 PATH 里。把这个目录加进 PATH:  " + prefix);
  }
}

function removeBin() {
  // 两种装法都清:npm link 装的(unlink)与 npm i -g 装的(rm -g)。
  // ⚠ 新版 npm 的 unlink 在没有 link 记录时会直接报错 —— 所以 rm -g 兜底必须无条件跑。
  if (DRY) { say("  [dry] npm unlink / npm rm -g code-forge"); return; }
  let removed = false;
  if (!COPY && fs.existsSync(path.join(HERE, "package.json"))) {
    if (!runNpm(["unlink"], HERE)) removed = true;
  }
  if (!runNpm(["rm", "-g", "code-forge"], process.cwd())) removed = true;
  if (removed) done.push("`code-forge` 命令（已从 PATH 移除 —— 终端不需要认识它）");
  else skipped.push("`code-forge` 命令（PATH 里本来就没有）");
}

function removeRuntime() {
  if (!fs.existsSync(RUNTIME_DIR)) { skipped.push(rel(RUNTIME_DIR) + "（本来就没有）"); return; }
  if (DRY) { say("  [dry] 删 " + rel(RUNTIME_DIR)); return; }
  fs.rmSync(RUNTIME_DIR, { recursive: true, force: true });
  done.push("删 " + rel(RUNTIME_DIR));
}

/* ---------------- 技能 / 角色 / 命令 ---------------- */
const SKILL_SRC = path.join(HERE, "skills", "code-forge", "SKILL.md");
const SKILL_DEST = path.join(CLAUDE_DIR, "skills", "code-forge", "SKILL.md");
const AGENT_FILES = fs.existsSync(path.join(HERE, "agents"))
  ? fs.readdirSync(path.join(HERE, "agents")).filter((f) => f.endsWith(".md"))
  : [];
const CMD_DEST = path.join(CLAUDE_DIR, "commands", "code-forge.md");

// 斜杠命令用户级是 markdown + frontmatter（插件里那份是 .toml，两种格式各自的地盘）
function commandMarkdown() {
  return [
    "---",
    "description: 在一个可验证的目标上跑对抗回环（提方案 ⇄ 找反例 ⇄ 代码判定），过程直播到本地监控台",
    "argument-hint: \"<目标，例如：把 payments 的重复回调修掉，pytest 全绿且覆盖率 ≥ 80%>\"",
    "---",
    "",
    "Use the code-forge skill to run an adversarial loop on this goal: $ARGUMENTS",
    "",
    // ⚠ 空目标那两行不是废话:实测用户只打 `/code-forge` 时,模型照着下面那句
    //   「先确认判据命令」直接开扫仓库去了 —— 指令的第一条必须是把目标立住。
    "If the text after the colon above is empty or too vague to be a goal (\"optimize it\"):",
    "this turn does exactly one thing: **wait for the goal**.",
    "If this conversation just discussed a concrete problem, call AskUserQuestion (header: goal)",
    "with 1-2 candidate goals distilled from it (Other lets me type my own); with no usable context,",
    "output a single line asking what to do in my language (e.g. Chinese: 目标：要做什么？), then stop.",
    "Forbidden: scanning the repo, picking gate commands, listing menus, explaining how this works,",
    "or calling loop_begin. None of this may happen until the goal is established.",
    "",
    "Once the goal is established, follow the skill's protocol: look at the repo with the goal in",
    "mind and offer 2-4 gate-command candidates for me to pick (AskUserQuestion in Claude Code;",
    "each runnable right now and reflecting the goal; add a metric if the goal carries a number).",
    "The order is iron: **config first, confirm last**. After the gate question, show the config",
    "card via AskUserQuestion (max 4 questions per card: model assignment / rounds (incl.",
    "unlimited) / time limit / streak when needed; recommended first so plain Enter = all",
    "defaults), and only after every config question show the confirm card: summary + start?",
    "(Start recommended / change one thing / cancel). Never substitute \"start? change later\" -",
    "that hides the cost of changing behind the confirmation.",
    "The start flow is orchestrated by loop_begin's state machine - you are only the hands: each",
    "reply carries the current step's instruction and a one-time token; follow it and call again",
    "with the token; out-of-order calls bounce back. Even the confirm summary comes prepared -",
    "show it verbatim, never rewrite. Pass lang = the language I am speaking.",
    "Then loop_begin and tell me the console URL; each round dispatch roles to forge-proposer /",
    "forge-critic (different models), loop_say for each, and loop_gate at the round's end.",
    "",
    "Remember three things: only loop_gate rules success; the gate must never be loosened or",
    "swapped to pass; when it stops, state truthfully which of the seven stop reasons it was.",
    ""
  ].join("\n");
}

/* ---------------- MCP ---------------- */
function mcpArgs() {
  return ["node", path.join(RUNTIME, "server.js"), "--mcp"];
}

function haveClaudeCli() {
  // 别为了「装了吗」起一个 claude 进程:`claude --version` 实测 353ms,而 which 是 ~0ms
  // (agentcli.which 自己扫 PATH/PATHEXT,不 spawn where)。
  return !!require("./agentcli.js").which("claude");
}

/**
 * ~/.claude.json 里已经注册的那条(--scope user 写的就是顶层 mcpServers)。没有回 null。
 * 只读不写 —— 写还是交给 claude CLI,它知道自己的格式。
 */
function claudeMcpEntry() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude.json"), "utf8"));
    const e = j && j.mcpServers && j.mcpServers[MCP_NAME];
    return e && typeof e === "object" ? e : null;
  } catch (_) { return null; }
}

/** 已注册的那条跟这次要写的**完全一样**吗(命令 + 参数)。一样就没必要重写一遍。 */
function claudeMcpUpToDate(want) {
  const e = claudeMcpEntry();
  if (!e) return false;
  const args = Array.isArray(e.args) ? e.args : [];
  return e.command === want[0] && args.length === want.length - 1 &&
    args.every(function (v, i) { return v === want[i + 1]; });
}

function tryClaudeCli() {
  // 有 claude CLI 就用它 —— 它知道自己的配置格式,比我手写 JSON 稳
  const a = mcpArgs();
  // ⚠ dry-run 必须真的什么都不做。这里踩过一次:探测与注册写在一起,
  //   于是 `--dry-run` 真的把 MCP 注册进去了 —— 一个「只看看」的选项产生了副作用,
  //   而且它在输出里被 DRY 分支跳过、连一行都没提。探测与写入必须分开。
  if (DRY) {
    const have = haveClaudeCli();
    say("  [dry] " + (have
      ? (!UNINSTALL && claudeMcpUpToDate(a)
          ? "已经注册成一样的了,跳过 claude mcp add（读 ~/.claude.json 对出来的）"
          : "claude mcp " + (UNINSTALL ? "remove" : "add") + " --scope user " + MCP_NAME)
      : "没有 claude CLI → 会改 ~/.claude.json 的 mcpServers." + MCP_NAME));
    return have;
  }
  if (!haveClaudeCli()) return false;
  /* ★ 已经是同一条就直接算数,一个 claude 进程都不起。
   *   `claude mcp remove` + `mcp add` 实测各 ~1.3s,而 install 最常见的用法恰恰是
   *   「再跑一遍来更新」—— 那一次两条命令写回去的东西跟原来一字不差。 */
  if (!UNINSTALL && claudeMcpUpToDate(a)) {
    skipped.push("Claude Code 的 MCP（已经注册成一样的了）");
    return true;
  }
  // 反过来:本来就没注册,uninstall 也不必起进程去删一个不存在的东西
  if (UNINSTALL && !claudeMcpEntry()) return true;
  try {
    execFileSync("claude", ["mcp", "remove", "--scope", "user", MCP_NAME], { stdio: "ignore" });
  } catch (_) { /* 本来没有,正常 */ }
  if (UNINSTALL) return true;
  try {
    execFileSync("claude",
      ["mcp", "add", "--scope", "user", MCP_NAME, "--", a[0], a[1], a[2]],
      { stdio: "ignore" });
    return true;
  } catch (_) { return false; }
}

/* ---------------- 别的宿主的 MCP ---------------- */
/**
 * 给**除 Claude Code 之外**、这台机器上确实装了的宿主也注册上。
 *
 * 两条纪律:
 *   ① **只碰装了的**。给没装的工具凭空造一个配置文件,是往人家目录里乱扔东西。
 *   ② 改别人的配置文件之前先备份。那是他们的主配置,不是我们的。
 */
function registerOtherHosts() {
  const adapters = require("./adapters.js");
  const cli = require("./agentcli.js");
  const cmd = mcpArgs();

  adapters.all().forEach(function (a) {
    if (a.id === "claude") return;             // 它走上面那条专门的路(有 CLI 优先)
    if (!a.mcp) return;
    if (!cli.which(a.bin)) return;             // ① 没装就不碰

    if (a.mcp.kind === "cli") {
      const args = UNINSTALL ? a.mcp.remove(MCP_NAME) : a.mcp.add(MCP_NAME, cmd);
      if (DRY) { say("  [dry] " + a.bin + " " + args.join(" ")); return; }
      /* 先 remove 一次再 add —— 否则重复装会撞「已存在」而整条失败(幂等)。
       * 但「本来就没注册」时这一次 remove 纯属白起一个进程(codex 实测 ~390ms):
       * 适配器能从配置文件里直接看出来没注册(registered()===false)时就跳过它。
       * 拿不准(null)照旧无条件 remove —— 幂等比省下的那 400ms 重要。 */
      const known = typeof a.mcp.registered === "function" ? a.mcp.registered(MCP_NAME) : null;
      if (!UNINSTALL && known !== false) cli.exec(a.bin, a.mcp.remove(MCP_NAME));
      const r = cli.exec(a.bin, args);
      if (r.error || r.status !== 0) {
        failed.push(a.label + " 的 MCP 没注册上（" + (r.error || ("退出码 " + r.status) ) +
          "）。自己跑:  " + a.bin + " " + args.join(" "));
      } else {
        done.push(a.label + " 的 MCP" + (UNINSTALL ? "（已移除）" : ""));
      }
      return;
    }

    if (a.mcp.kind === "json") {
      patchJsonConfig(a, cmd);
      return;
    }

    // 认不出的注册方式:不猜着写,把该加什么原样打出来让人自己贴
    failed.push(a.label + " 的 MCP 要手动加（注册方式 " + a.mcp.kind + " 我不会写）：" +
      JSON.stringify({ command: cmd[0], args: cmd.slice(1) }));
  });
}

/** 往某个宿主的 JSON 配置里加/删一条 MCP。只碰那一个键,其余原样保留。 */
function patchJsonConfig(a, cmd) {
  const file = a.mcp.file;
  const key = a.mcp.key || "mcpServers";
  let cfg = {};
  if (fs.existsSync(file)) {
    try { cfg = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")); }
    catch (e) {
      failed.push(rel(file) + " 解析失败（" + e.message + "），没有改它。请手动加 " + key + "." + MCP_NAME);
      return;
    }
  } else if (UNINSTALL) {
    skipped.push(rel(file) + "（本来就没有）");
    return;
  }
  cfg[key] = cfg[key] || {};
  if (UNINSTALL) {
    if (!cfg[key][MCP_NAME]) { skipped.push(rel(file) + " 里本来就没有 " + MCP_NAME); return; }
    delete cfg[key][MCP_NAME];
  } else {
    cfg[key][MCP_NAME] = a.mcp.entry(cmd);
  }
  if (DRY) { say("  [dry] 改 " + rel(file) + " 的 " + key + "." + MCP_NAME); return; }
  // ② 先备份 —— 这是别人的主配置
  try { if (fs.existsSync(file)) fs.copyFileSync(file, file + ".bak-code-forge"); } catch (_) {}
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", "utf8");
    done.push(rel(file) + " 的 " + key + "." + MCP_NAME + (UNINSTALL ? "（已移除）" : ""));
  } catch (e) {
    failed.push("写不了 " + rel(file) + "：" + e.message);
  }
}

function patchClaudeJson() {
  // 兜底:直接改 ~/.claude.json 的 mcpServers。只碰这一个键,其余原样保留。
  const file = path.join(HOME, ".claude.json");
  let cfg = {};
  if (fs.existsSync(file)) {
    try { cfg = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")); }
    catch (e) {
      failed.push("~/.claude.json 解析失败（" + e.message + "），没有改它。请手动加 mcpServers。");
      return false;
    }
  }
  cfg.mcpServers = cfg.mcpServers || {};
  if (UNINSTALL) {
    if (!cfg.mcpServers[MCP_NAME]) { skipped.push("~/.claude.json 里本来就没有 " + MCP_NAME); return true; }
    delete cfg.mcpServers[MCP_NAME];
  } else {
    const a = mcpArgs();
    cfg.mcpServers[MCP_NAME] = { command: a[0], args: [a[1], a[2]] };
  }
  if (DRY) { say("  [dry] 改 ~/.claude.json 的 mcpServers." + MCP_NAME); return true; }
  // 先备份再改 —— 这是别人的主配置文件,不是我们的
  try { fs.copyFileSync(file, file + ".bak-code-forge"); } catch (_) {}
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  done.push("~/.claude.json 的 mcpServers." + MCP_NAME + (UNINSTALL ? "（已移除）" : ""));
  return true;
}

/* ---------------- Codex 的 /code-forge（用户级自定义 prompt） ---------------- */
/**
 * Claude Code 那边装的是 ~/.claude/commands/code-forge.md;Codex 的对应物是
 * ~/.codex/prompts/code-forge.md —— **以前根本没装**,于是「跨宿主」在 Codex 聊天里
 * 是断的:MCP 工具注册了,但 /code-forge 这个入口不存在,用户只能靠自己描述整个协议。
 *
 * 内容按 Codex 的现实裁过,不是照抄 Claude Code 那份:
 *  - 没有 AskUserQuestion → 候选摆编号列表让人打号;
 *  - 没有子 agent 模型覆盖 → 自己按角色轮流发言(反驳强度降一档,技能里写过);
 *  - 没有 prompt 钩子 → 空目标只能靠这段指令拦(要花一次模型调用,如实认)。
 */
function codexPromptMarkdown() {
  return [
    "Use code-forge's MCP tools (loop_begin / loop_say / loop_gate / loop_status / loop_end)",
    "to run an adversarial loop on this goal: $ARGUMENTS",
    "",
    "If the text after the colon above is empty or too vague (\"optimize it\"): this turn does",
    "exactly one thing: **wait for the goal**. If this conversation just discussed a concrete",
    "problem, distill it into one candidate goal and confirm with me; otherwise output a single",
    "line asking what to do, in my language, then stop and wait for my next message.",
    "Forbidden: scanning the repo, picking gate commands, listing menus, calling loop_begin.",
    "",
    "Once the goal is established: look at the repo with the goal in mind and offer 2-4",
    "gate-command candidates as a numbered list for me to pick.",
    "For \"N consecutive clean rounds\" goals set goal.streak=N; \"unlimited rounds\" is",
    "budget.rounds=0 (confirm the time limit too). Only propose commands that really exist in",
    "the repo, goal-relevant first, and end the list with \"0) I'll type my own\".",
    "Then loop_begin (pass lang = the language I am speaking) and tell me the console URL.",
    "",
    "Each round: first loop_say one kind=route line saying who was dispatched (a role runs for",
    "minutes; not reporting before dispatch means a long blank screen on the live view). Then",
    "**dispatch roles as standalone processes via loop_agent** (true isolation: own session,",
    "chooseable model, critics read-only at the tool layer). The prompt must be self-contained -",
    "it cannot see this conversation. Results are auto-loop_say-ed; do not report them again,",
    "and use the returned text to decide the next step. Only if loop_agent fails to start, fall",
    "back to playing roles yourself in turn (adversarial strength drops a tier - hunt",
    "counterexamples all the harder, and loop_say right after each role speaks). Call loop_gate",
    "at the round's end.",
    "",
    "Remember three things: only loop_gate rules success; the gate must never be loosened or",
    "swapped to pass; when it stops, state truthfully which of the seven stopReason values it",
    "was - \"budget exhausted\" must never be reported as \"completed\".",
    ""
  ].join(String.fromCharCode(10));
}

const CODEX_PROMPT = path.join(HOME, ".codex", "prompts", "code-forge.md");

function installCodexPrompt() {
  const cli = require("./agentcli.js");
  if (!cli.which("codex")) { return; }          // 没装 codex 就不碰它的目录
  if (UNINSTALL) { removeFile(CODEX_PROMPT); return; }
  writeFile(CODEX_PROMPT, codexPromptMarkdown());
}

/* ---------------- UserPromptSubmit 钩子：/code-forge 空目标 → 只等输入 ---------------- */
/**
 * 空目标时把模型钉死在「等目标」上。钩子(hookprompt.js)注入一条指令(exit 0 + stdout
 * 进上下文):这一回合只许问目标(有上下文用 AskUserQuestion,没有就一行提问),
 * 禁止扫仓库/找判据/loop_begin。
 * 为什么不拦截(exit 2,改过一次):拦截零 token,但体感是「被拒掉重打」——
 * 用户要的是备注输入那种「停下来等我打字」,而输入等待只有模型侧画得出来。
 *
 * 三条纪律:
 *  ① 幂等 —— 已有我们的条目就替换(路径可能变了),不重复追加;
 *  ② 可卸 —— uninstall 只摘 command 里带 hookprompt.js 的那几条,别人的钩子一根不动;
 *  ③ 改前备份 —— settings.json 是别人的主配置。
 */
function patchHooks() {
  const file = path.join(CLAUDE_DIR, "settings.json");
  let cfg = {};
  if (fs.existsSync(file)) {
    try { cfg = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")); }
    catch (e) {
      failed.push(rel(file) + " 解析失败（" + e.message + "），钩子没装。空目标仍会走模型问一句。");
      return;
    }
  }
  const ours = function (h) {
    return h && h.type === "command" && /hookprompt\.js/.test(String(h.command || ""));
  };
  cfg.hooks = cfg.hooks || {};
  let list = Array.isArray(cfg.hooks.UserPromptSubmit) ? cfg.hooks.UserPromptSubmit : [];
  // 先把我们旧的摘干净（幂等 + 卸载共用这一步）
  list = list.map(function (m) {
    if (!m || !Array.isArray(m.hooks)) return m;
    const rest = m.hooks.filter(function (h) { return !ours(h); });
    return rest.length === m.hooks.length ? m : Object.assign({}, m, { hooks: rest });
  }).filter(function (m) { return m && Array.isArray(m.hooks) && m.hooks.length; });

  if (!UNINSTALL) {
    list.push({ hooks: [{ type: "command",
      // 路径引起来:用户名带空格的 home 目录不引就散成两个参数。正斜杠是因为
      // 这条命令会被 shell 再解析一遍,反斜杠在里面就是转义符。
      command: "node " + JSON.stringify(
        path.join(RUNTIME, "hookprompt.js").split("\\").join("/")),
      timeout: 10 }] });
  }
  if (!list.length) delete cfg.hooks.UserPromptSubmit; else cfg.hooks.UserPromptSubmit = list;
  if (!Object.keys(cfg.hooks).length) delete cfg.hooks;

  if (DRY) { say("  [dry] 改 " + rel(file) + " 的 hooks.UserPromptSubmit"); return; }
  try { if (fs.existsSync(file)) fs.copyFileSync(file, file + ".bak-code-forge"); } catch (_) {}
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + String.fromCharCode(10), "utf8");
    done.push(rel(file) + " hooks.UserPromptSubmit" +
      (UNINSTALL ? "（已移除）" : "（/code-forge 空目标 → 停下来等你输入目标）"));
  } catch (e) {
    failed.push("写不了 " + rel(file) + "：" + e.message);
  }
}

/* ---------------- 跑 ---------------- */
say((UNINSTALL ? "卸载" : "安装") + " code-forge → " + rel(CLAUDE_DIR) + (DRY ? "  [dry-run]" : ""));
if (!UNINSTALL && COPY) {
  say(C_dim(EPHEMERAL
    ? "  在临时目录里跑（npx?）—— 运行时会复制到 " + rel(RUNTIME_DIR) + " 再注册，否则缓存一清就失效"
    : "  --copy：运行时复制到 " + rel(RUNTIME_DIR)));
}
say("");

if (UNINSTALL) {
  removeFile(SKILL_DEST);
  AGENT_FILES.forEach((f) => removeFile(path.join(CLAUDE_DIR, "agents", f)));
  removeFile(CMD_DEST);
  removeBin();   // 旧版装过的 bin 一并清掉
  removeRuntime();
} else {
  if (COPY) installRuntime();
  // （2026-08 降级）不再往 PATH 里放 `code-forge` —— 终端不需要认识它:
  // 直播窗口在开跑时自动弹出,其余观察面都在网页监控台上。旧版装过的顺手清掉。
  removeBin();
  if (!fs.existsSync(SKILL_SRC)) {
    failed.push("找不到 " + rel(SKILL_SRC) + " —— 是不是在别的目录里跑的?");
  } else {
    writeFile(SKILL_DEST, fs.readFileSync(SKILL_SRC, "utf8"));
  }
  AGENT_FILES.forEach(function (f) {
    writeFile(path.join(CLAUDE_DIR, "agents", f), fs.readFileSync(path.join(HERE, "agents", f), "utf8"));
  });
  writeFile(CMD_DEST, commandMarkdown());
}

patchHooks();
installCodexPrompt();
const viaCli = tryClaudeCli();
if (!viaCli) {
  patchClaudeJson();
} else if (!DRY) {
  done.push("MCP " + MCP_NAME + (UNINSTALL ? "（已移除）" : "（claude mcp add --scope user）"));
}
// 别的宿主也一并接上 —— 「跨宿主」不能只是文档里的一句话
registerOtherHosts();

/* ---------------- 报告 ---------------- */
say("");
if (done.length) { say("已改:"); done.forEach((d) => say("  ✓ " + d)); }
if (skipped.length) { say("跳过:"); skipped.forEach((d) => say("  · " + d)); }
if (failed.length) {
  say("");
  say("没做成（要手动处理）:");
  failed.forEach((d) => say("  ✗ " + d));
}
say("");
if (UNINSTALL) {
  say("卸载完成。重开一个 Claude Code 会话生效。");
} else {
  say("装完了。**重开一个 Claude Code 会话**才会加载,然后在聊天里:");
  say("");
  say("  /code-forge 把 xxx 修掉，pytest 全绿且覆盖率 ≥ 80%");
  say("");
  say("终端不需要认识 code-forge:开跑时自动弹终端直播窗口,网页监控台地址也会一并给出。");
  say("");
  say("角色与模型（可在 ~/.claude/agents 里改 model: 那一行,或聊天里点「改模型」）:");
  say("  forge-proposer  sonnet  读写+Bash   提最小改动并落地");
  say("  forge-critic    opus    只读        专门找反例（工具层面没有写权限）");
  say("  forge-reviewer  sonnet  只读        判绿后查是否把判据糊弄过去了");
  say("");
  say("监控台会在第一次用时自动拉起。不需要任何 API key。");
}
process.exit(failed.length ? 1 : 0);
