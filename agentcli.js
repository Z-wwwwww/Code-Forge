"use strict";
/**
 * 起「宿主 agent 的命令行」这一件事的唯一收口。
 *
 * 两个理由必须收在一处:
 *
 * ① **安全**。之前是 spawn("claude", args, {shell:true}) —— Node 自己都会警告
 *    (DEP0190):shell:true 配数组参数时,参数**不转义只拼接**。而 args 里有
 *    用户可控的值(--model 来自表单/向导),于是 `sonnet & something` 会被 shell
 *    当成两条命令。现在:先把可执行文件解析成真实路径,**不走 shell**;
 *    并且凡是用户可控的值一律过白名单。
 *
 * ② **通用性**。执行者不该写死成 claude。CODE_FORGE_AGENT_CLI 可以指到别的 agent
 *    命令行(Codex / opencode …),形状是「命令 + 前置参数」,例如 "codex exec"。
 *    ⚠ 换掉之后 -p / --output-format stream-json 这些 claude 专属参数就不适用了 ——
 *    所以调用方要自己决定传什么,这一层只负责「安全地把它起起来」。
 */

const fs = require("fs");
const path = require("path");
const { spawnSync, spawn } = require("child_process");

// 模型别名白名单。别的值一律拒 —— 这是唯一进 argv 的用户可控值。
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
function safeModel(m) {
  if (!m) return null;
  const s = String(m).trim();
  return MODEL_RE.test(s) ? s : null;
}

let cached = null;

/** 找到宿主 agent 的可执行文件真实路径。找不到回 null(调用方给可行动的报错)。 */
function resolve() {
  if (cached) return cached;
  const custom = (process.env.CODE_FORGE_AGENT_CLI || "").trim();
  const parts = custom ? custom.split(/\s+/) : ["claude"];
  const name = parts[0];
  const preArgs = parts.slice(1);

  let bin = null;
  if (path.isAbsolute(name) && fs.existsSync(name)) {
    bin = name;
  } else {
    // where/which 拿真实路径。Windows 上 claude 是 .cmd,不走 shell 就必须用全名。
    const finder = process.platform === "win32" ? "where" : "which";
    const r = spawnSync(finder, [name], { encoding: "utf8" });
    if (r.status === 0 && r.stdout) {
      const lines = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      // Windows 的 where 可能同时列出 claude 与 claude.cmd —— 挑能直接 spawn 的那个
      bin = lines.filter((l) => /\.(cmd|bat|exe)$/i.test(l))[0] || lines[0] || null;
    }
  }
  if (!bin) return null;
  cached = { bin: bin, preArgs: preArgs, name: name };
  return cached;
}

/**
 * 起进程。args 由调用方给全(这一层不猜),env/cwd 透传。
 * 返回 { child } 或 { error }。
 */
function run(args, opts) {
  opts = opts || {};
  const r = resolve();
  if (!r) {
    const nm = (process.env.CODE_FORGE_AGENT_CLI || "claude").split(/\s+/)[0];
    return { error: "找不到可执行文件 `" + nm + "`。装了吗?在 PATH 里吗?" +
      "（换别的 agent 命令行:设 CODE_FORGE_AGENT_CLI）" };
  }
  try {
    // 不用 shell:参数按数组原样交给内核,不会被拼接成命令行
    const child = spawn(r.bin, r.preArgs.concat(args), {
      cwd: opts.cwd || process.cwd(),
      env: opts.env || process.env,
      stdio: opts.stdio || ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    return { child: child, bin: r.bin };
  } catch (err) {
    return { error: "起不了 " + r.bin + "：" + err.message };
  }
}

function available() { return !!resolve(); }
function describe() {
  const r = resolve();
  return r ? (r.name + (r.preArgs.length ? " " + r.preArgs.join(" ") : "")) : null;
}

module.exports = { run: run, resolve: resolve, available: available, describe: describe, safeModel: safeModel };
