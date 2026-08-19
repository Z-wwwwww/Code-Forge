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

const cache = new Map();   // 可执行名 → 真实路径 | null（探测一次就够，别每次都 spawn 一个 where）

/**
 * 把一个可执行名解析成真实路径。找不到回 null。
 * 独立出来是因为 doctor / 适配器选择都要「装了吗」这个答案,而它们不该顺带起进程。
 */
function which(name) {
  if (!name) return null;
  if (cache.has(name)) return cache.get(name);
  let bin = null;
  if (path.isAbsolute(name) && fs.existsSync(name)) {
    bin = name;
  } else {
    // where/which 拿真实路径。Windows 上这些 CLI 多是 .cmd,不走 shell 就必须用全名。
    const finder = process.platform === "win32" ? "where" : "which";
    const r = spawnSync(finder, [name], { encoding: "utf8" });
    if (r.status === 0 && r.stdout) {
      const lines = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      // Windows 的 where 可能同时列出 claude 与 claude.cmd —— 挑能直接 spawn 的那个
      bin = lines.filter((l) => /\.(cmd|bat|exe)$/i.test(l))[0] || lines[0] || null;
    }
  }
  cache.set(name, bin);
  return bin;
}

/**
 * Windows 的 `.cmd` 包装脚本 → 里面那个真正的 JS 入口。
 *
 * 为什么非拆不可:**Node 不允许不带 shell 直接 spawn `.cmd` / `.bat`**
 * (CVE-2024-27980 之后的行为,实测起 `codex.cmd` 直接 EINVAL)。而 shell:true 配
 * 数组参数是「不转义只拼接」—— 路径里一个 `&` 就变成两条命令,这正是这个仓库
 * 一开始就避开的东西。
 *
 * npm 生成的 shim 里有一行 `"%_prog%"  "%dp0%\node_modules\…\x.js" %*`,
 * 把那个 .js 抠出来,用**当前这个 node** 去跑它:shell 不碰,参数照样按数组传。
 *
 * claude 是 `.exe`,走不到这里 —— 所以这个坑一直到接 codex 才暴露。
 */
function unwrapShim(bin) {
  if (!/\.(cmd|bat)$/i.test(bin || "")) return null;
  let txt;
  try { txt = fs.readFileSync(bin, "utf8"); } catch (_) { return null; }
  const m = /"%(?:dp0|~dp0)%[\\/]?([^"]+\.js)"/i.exec(txt);
  if (!m) return null;
  const p = path.join(path.dirname(bin), m[1].replace(/^[\\/]+/, ""));
  return fs.existsSync(p) ? p : null;
}

/**
 * 一个可执行名 → 真正能 spawn 的 { cmd, pre }。
 * `.exe` 直接用;`.cmd` 拆成 node + 入口脚本;拆不开就如实说拆不开。
 */
function spawnable(name) {
  const bin = which(name);
  if (!bin) return { error: "找不到可执行文件 `" + name + "`。装了吗?在 PATH 里吗?" };
  const js = unwrapShim(bin);
  if (js) return { cmd: process.execPath, pre: [js], bin: bin };
  if (/\.(cmd|bat)$/i.test(bin)) {
    return { error: "`" + name + "` 是一个 " + path.extname(bin) + " 包装脚本，" +
      "而 Node 不允许不带 shell 起它，里面也没找到可以直接跑的 .js 入口。" +
      "把可执行文件的绝对路径写进 " + require("path").join(require("os").homedir(),
        ".code-forge", "agents.json") + " 的 bin 字段。" };
  }
  return { cmd: bin, pre: [], bin: bin };
}

/** 同步跑一下(探测用,比如 `codex mcp list`)。回 { status, stdout, stderr } 或 { error }。 */
function exec(name, args, opts) {
  const s = spawnable(name);
  if (s.error) return { error: s.error };
  const r = spawnSync(s.cmd, s.pre.concat(args), Object.assign(
    { encoding: "utf8", timeout: 20000, windowsHide: true }, opts || {}));
  if (r.error) return { error: r.error.code || r.error.message };
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

let cached = null;

/** 找到宿主 agent 的可执行文件真实路径。找不到回 null(调用方给可行动的报错)。 */
function resolve() {
  if (cached) return cached;
  const custom = (process.env.CODE_FORGE_AGENT_CLI || "").trim();
  const parts = custom ? custom.split(/\s+/) : ["claude"];
  const name = parts[0];
  const preArgs = parts.slice(1);
  const bin = which(name);
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
  // opts.bin:适配器指定的可执行名(codex / gemini / …)。给了就用它,
  // 不给才退回 CODE_FORGE_AGENT_CLI / claude 那条老路。
  if (opts.bin) {
    const s = spawnable(opts.bin);
    if (s.error) return { error: s.error };
    try {
      const child = spawn(s.cmd, s.pre.concat(args), {
        cwd: opts.cwd || process.cwd(), env: opts.env || process.env,
        stdio: opts.stdio || ["pipe", "pipe", "pipe"], windowsHide: true
      });
      return { child: child, bin: s.bin };
    } catch (err) { return { error: "起不了 " + s.bin + "：" + err.message }; }
  }
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

module.exports = { run: run, resolve: resolve, which: which, spawnable: spawnable,
  exec: exec, unwrapShim: unwrapShim, available: available,
  describe: describe, safeModel: safeModel };
