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
 *   ~/.claude/skills/adversarial-loop/SKILL.md   技能
 *   ~/.claude/agents/adv-*.md                    三个角色(各绑不同模型)
 *   ~/.claude/commands/adversarial-loop.md       /adversarial-loop 斜杠命令
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
const MCP_NAME = "adversarial-console";

const argv = process.argv.slice(2);
const has = (f) => argv.includes("--" + f);
const DRY = has("dry-run");
const UNINSTALL = has("uninstall");

const done = [];
const skipped = [];
const failed = [];

function say(s) { console.log(s); }
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
}

/* ---------------- 技能 / 角色 / 命令 ---------------- */
const SKILL_SRC = path.join(HERE, "skills", "adversarial-loop", "SKILL.md");
const SKILL_DEST = path.join(CLAUDE_DIR, "skills", "adversarial-loop", "SKILL.md");
const AGENT_FILES = fs.existsSync(path.join(HERE, "agents"))
  ? fs.readdirSync(path.join(HERE, "agents")).filter((f) => f.endsWith(".md"))
  : [];
const CMD_DEST = path.join(CLAUDE_DIR, "commands", "adversarial-loop.md");

// 斜杠命令用户级是 markdown + frontmatter（插件里那份是 .toml，两种格式各自的地盘）
function commandMarkdown() {
  return [
    "---",
    "description: 在一个可验证的目标上跑对抗回环（提方案 ⇄ 找反例 ⇄ 代码判定），过程直播到本地监控台",
    "argument-hint: \"<目标，例如：把 payments 的重复回调修掉，pytest 全绿且覆盖率 ≥ 80%>\"",
    "---",
    "",
    "用 adversarial-loop 技能在这个目标上跑一次对抗回环：$ARGUMENTS",
    "",
    "按技能里的协议走：先确认判据命令（一条现在就能跑、能反映目标的命令；有量的话配上 metric），",
    "再 loop_begin 开局并把监控台网址告诉我，然后每轮把角色派给 adv-proposer / adv-critic",
    "（它们各绑不同模型）、各自 loop_say，一轮结束调 loop_gate。",
    "",
    "记住三条：达标只有 loop_gate 能判；判据不许为了达标而放宽或换掉；",
    "停了要如实说是七种原因里的哪一条。",
    ""
  ].join("\n");
}

/* ---------------- MCP ---------------- */
function mcpArgs() {
  return ["node", path.join(HERE, "server.js"), "--mcp"];
}

function haveClaudeCli() {
  try { execFileSync("claude", ["--version"], { stdio: "ignore" }); return true; }
  catch (_) { return false; }
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
      ? "claude mcp " + (UNINSTALL ? "remove" : "add") + " --scope user " + MCP_NAME
      : "没有 claude CLI → 会改 ~/.claude.json 的 mcpServers." + MCP_NAME));
    return have;
  }
  if (!haveClaudeCli()) return false;
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
  try { fs.copyFileSync(file, file + ".bak-adversarial"); } catch (_) {}
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  done.push("~/.claude.json 的 mcpServers." + MCP_NAME + (UNINSTALL ? "（已移除）" : ""));
  return true;
}

/* ---------------- 跑 ---------------- */
say((UNINSTALL ? "卸载" : "安装") + " adversarial-console → " + rel(CLAUDE_DIR) + (DRY ? "  [dry-run]" : ""));
say("");

if (UNINSTALL) {
  removeFile(SKILL_DEST);
  AGENT_FILES.forEach((f) => removeFile(path.join(CLAUDE_DIR, "agents", f)));
  removeFile(CMD_DEST);
} else {
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

const viaCli = tryClaudeCli();
if (!viaCli) {
  patchClaudeJson();
} else if (!DRY) {
  done.push("MCP " + MCP_NAME + (UNINSTALL ? "（已移除）" : "（claude mcp add --scope user）"));
}

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
  say("装完了。**重开一个 Claude Code 会话**才会加载,然后:");
  say("");
  say("  /adversarial-loop 把 xxx 修掉，pytest 全绿且覆盖率 ≥ 80%");
  say("");
  say("角色与模型（可在 " + rel(path.join(CLAUDE_DIR, "agents")) + " 里改 model: 那一行）:");
  say("  adv-proposer  sonnet  读写+Bash   提最小改动并落地");
  say("  adv-critic    opus    只读        专门找反例（工具层面没有写权限）");
  say("  adv-reviewer  sonnet  只读        判绿后查是否把判据糊弄过去了");
  say("");
  say("监控台会在第一次用时自动拉起。不需要任何 API key。");
}
process.exit(failed.length ? 1 : 0);
