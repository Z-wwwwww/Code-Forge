"use strict";
/**
 * 判据 —— 全部由代码算,一行模型都不问。
 *
 * 「达到目的了吗」如果问模型,回环会停在自我肯定上:它有充分动机说「已达标」。
 * 所以目标必须是可判定的:一条命令的退出码,外加(可选)从输出里抓一个数比区间。
 *
 * 返回 { met, exitCode, metric, value, detail, ms, skipped }
 * 判不了(没配命令)就如实说 skipped —— 不许在判不了的时候签「已达标」。
 */

const { spawn } = require("child_process");

/**
 * 判据命令的输出要给人看、也要回喂给 agent,所以编码不能猜错。
 * 先按 UTF-8 严格解;解不通说明是系统 ANSI 代码页(中文 Windows 上是 GBK,
 * 那边 cmd 的报错、pytest 的中文输出全是这个)—— 再退几档试。
 * ⚠ 必须把 chunk 全收完再解:逐块解会在多字节字符正好跨块时把它切坏。
 */
function decodeOutput(buf) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buf); }
  catch (_) {
    const fallbacks = process.platform === "win32" ? ["gbk", "big5", "windows-1252"] : ["windows-1252"];
    for (const enc of fallbacks) {
      try { return new TextDecoder(enc).decode(buf); } catch (_) {}
    }
    return buf.toString("latin1");
  }
}

function runCommand(command, cwd, timeoutMs) {
  return new Promise(function (resolve) {
    const started = Date.now();
    // shell:true 让作者能直接写 "pytest -q && npm test" 这类命令
    const child = spawn(command, { cwd: cwd || process.cwd(), shell: true });
    const chunks = [];
    let size = 0;
    let killed = false;
    const cap = 200000;   // 输出封顶,防一条刷屏命令把内存吃光
    function grab(chunk) { if (size < cap) { chunks.push(chunk); size += chunk.length; } }
    child.stdout.on("data", grab);
    child.stderr.on("data", grab);
    const out = function () { return decodeOutput(Buffer.concat(chunks)); };
    // win32 下 child.kill() 只杀得掉 shell 起的 cmd.exe 本身,杀不掉它派生的孙进程
    // (比如 npm 起的 node)。孙进程还攥着 stdout/stderr 管道的写端时,"close" 事件
    // 永远等不到,这个 Promise 就挂死。用 taskkill /T 连子孙一起杀。
    const timer = setTimeout(function () {
      killed = true;
      if (process.platform === "win32" && child.pid) {
        try {
          // taskkill 若 ENOENT(极端环境没这个命令)会异步发 "error" 事件 —— 不接住的话
          // 会变成 uncaughtException,把常驻的 server 进程一起拖垮。这里只是兜底杀,
          // 接住就好,不必再报什么。
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"]).on("error", function () {
            try { child.kill(); } catch (_) {}
          });
        } catch (_) { try { child.kill(); } catch (_) {} }
      } else {
        child.kill();
      }
    }, timeoutMs || 600000);
    child.on("error", function (err) {
      clearTimeout(timer);
      resolve({ code: -1, out: String(err.message), ms: Date.now() - started, spawnFailed: true });
    });
    child.on("close", function (code) {
      clearTimeout(timer);
      resolve({ code: killed ? -1 : code, out: out(), ms: Date.now() - started, timedOut: killed });
    });
  });
}

/**
 * goal = { command, cwd, timeoutMs, metric: { name, pattern, min, max } }
 * metric.pattern 是正则,第一个捕获组当数字用。
 */
async function check(goal, lang) {
  const tt = require("./i18n.js").T(lang);   // 判据结论会进事件档案,按回环 lang 出词
  if (!goal || !goal.command) {
    return { met: false, skipped: tt.gNoCmd, detail: tt.gNoCmdDetail };
  }
  const r = await runCommand(goal.command, goal.cwd, goal.timeoutMs);
  const out = { exitCode: r.code, ms: r.ms, output: r.out.slice(-4000), fp: fingerprint(r.out) };

  if (r.spawnFailed) {
    // 命令都起不来,这不是「没达标」,是判据本身坏了 —— 必须说清楚,不许静默当未达标
    return Object.assign(out, { met: false, broken: true, detail: tt.gCantRun + r.out.slice(0, 200) });
  }
  if (r.timedOut) {
    return Object.assign(out, { met: false, broken: true, detail: tt.gTimeout });
  }
  // shell:true 之下「命令不存在」不会让 spawn 失败,而是由 shell 用哨兵退出码报出来:
  // POSIX 127 / cmd.exe 9009。不认这两个数,「判据打错字」就会被当成「测试没过」,
  // 于是回环会一轮轮去修一个根本没跑起来的判据。
  // 中文 Windows 的 cmd 用中文报「不是内部或外部命令」且退出码只是 1,所以两种线索都得认
  // ⚠ 这些哨兵只能在退出码非 0 时才生效 —— 否则 exit 0(全通过)或正常失败但输出里
  // 恰好含这类字样(比如测试用例名字/日志文本)的情况会被误判成「判据坏了」
  if (r.code !== 0 && (r.code === 127 || r.code === 9009 ||
      /not recognized as an internal|command not found|No such file or directory/i.test(r.out) ||
      /不是内部或外部命令|无法将|不是可运行的程序/.test(r.out))) {
    return Object.assign(out, { met: false, broken: true,
      detail: tt.gNotFound(r.code, (r.out.split("\n")[0] || "").slice(0, 160)) });
  }

  let value = null;
  let metricOk = true;
  if (goal.metric && goal.metric.pattern) {
    let m = null;
    try { m = new RegExp(goal.metric.pattern).exec(r.out); }
    catch (e) {
      return Object.assign(out, { met: false, broken: true, detail: tt.gBadRegex + e.message });
    }
    if (m && m[1] !== undefined && m[1] !== "") {
      value = parseFloat(m[1]);
      if (goal.metric.min != null && value < goal.metric.min) metricOk = false;
      if (goal.metric.max != null && value > goal.metric.max) metricOk = false;
    } else {
      // 抓不到数就不能当成达标 —— 「量不出来」与「量出来合格」是两件事
      metricOk = false;
      value = null;
    }
  }

  const codeOk = r.code === 0;
  const parts = [tt.gExit(r.code)];
  if (goal.metric && goal.metric.pattern) {
    parts.push(tt.gMetric(goal.metric.name || tt.gateLabel, value,
      (goal.metric.min != null ? ">= " + goal.metric.min : "") +
      (goal.metric.max != null ? (goal.metric.min != null ? ", " : "") + "<= " + goal.metric.max : "")));
  }
  return Object.assign(out, {
    met: codeOk && metricOk,
    metric: goal.metric ? (goal.metric.name || tt.gateLabel) : null,
    value: value,
    detail: parts.join(" · ")
  });
}

/**
 * 判据输出的指纹 —— 给**没有 metric** 的目标用来判「有没有进展」。
 *
 * ★ 为什么要这个:metric 是可选的(只有输出里确实有可抓的数时才配),而
 *   `madeProgress` 在没有 metric 时回 null = 不计入零进展。后果:**绝大多数回环的
 *   `no_progress` 闸门根本不生效**,一个原地打转的回环能把轮数烧满才停。
 *   连续两轮判据输出一模一样,基本就是没动到判据关心的东西。
 *
 * 归一化掉每次都会变的东西(耗时、时间戳、临时路径、内存地址),否则指纹永远不同,
 * 这个闸门还是等于没有。
 */
function fingerprint(output) {
  const s = String(output || "")
    .replace(/\d+\.\d+s|\d+ms|\b\d+\.\d{2,}\b/g, "T")          // 耗时
    .replace(/\d{2}:\d{2}:\d{2}|\d{4}-\d{2}-\d{2}/g, "D")      // 时间戳
    .replace(/0x[0-9a-f]+/gi, "A")                              // 地址
    .replace(/[\\/][\w.-]*(tmp|temp)[\w.-]*[\\/][\w.-]+/gi, "P") // 临时路径
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return "";
  return require("crypto").createHash("sha1").update(s).digest("hex").slice(0, 16);
}

/**
 * 进展判定。
 *   有 metric → 看它是否往目标方向走(这是最可靠的信号)
 *   没有 metric → 退回比**判据输出指纹**:连续两轮一模一样 = 没有进展
 * 两者都拿不到就回 null(不计入)。
 */
function madeProgress(goal, prev, cur, prevFp, curFp) {
  if (goal && goal.metric && prev != null && cur != null) {
    if (goal.metric.min != null) return cur > prev;
    if (goal.metric.max != null) return cur < prev;
  }
  // 没有 metric 时的兜底 —— 少了这一档,零进展闸门对多数回环都是空的
  if (prevFp && curFp) return prevFp !== curFp;
  return null;
}

module.exports = { check: check, madeProgress: madeProgress, runCommand: runCommand,
  fingerprint: fingerprint };
