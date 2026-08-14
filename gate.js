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
    const timer = setTimeout(function () { killed = true; child.kill(); }, timeoutMs || 600000);
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
async function check(goal) {
  if (!goal || !goal.command) {
    return { met: false, skipped: "未配置判据命令", detail: "没有可判定的目标 —— 只能靠预算闸停止" };
  }
  const r = await runCommand(goal.command, goal.cwd, goal.timeoutMs);
  const out = { exitCode: r.code, ms: r.ms, output: r.out.slice(-4000) };

  if (r.spawnFailed) {
    // 命令都起不来,这不是「没达标」,是判据本身坏了 —— 必须说清楚,不许静默当未达标
    return Object.assign(out, { met: false, broken: true, detail: "判据命令无法执行：" + r.out.slice(0, 200) });
  }
  if (r.timedOut) {
    return Object.assign(out, { met: false, broken: true, detail: "判据命令超时被中止" });
  }
  // shell:true 之下「命令不存在」不会让 spawn 失败,而是由 shell 用哨兵退出码报出来:
  // POSIX 127 / cmd.exe 9009。不认这两个数,「判据打错字」就会被当成「测试没过」,
  // 于是回环会一轮轮去修一个根本没跑起来的判据。
  // 中文 Windows 的 cmd 用中文报「不是内部或外部命令」且退出码只是 1,所以两种线索都得认
  if (r.code === 127 || r.code === 9009 ||
      /not recognized as an internal|command not found|No such file or directory/i.test(r.out) ||
      /不是内部或外部命令|无法将|不是可运行的程序/.test(r.out)) {
    return Object.assign(out, { met: false, broken: true,
      detail: "判据命令找不到（exit " + r.code + "）：" + (r.out.split("\n")[0] || "").slice(0, 160) });
  }

  let value = null;
  let metricOk = true;
  if (goal.metric && goal.metric.pattern) {
    let m = null;
    try { m = new RegExp(goal.metric.pattern).exec(r.out); }
    catch (e) {
      return Object.assign(out, { met: false, broken: true, detail: "指标正则无法编译：" + e.message });
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
  const parts = ["exit " + r.code];
  if (goal.metric && goal.metric.pattern) {
    parts.push((goal.metric.name || "指标") + " " +
      (value == null ? "未抓到" : value) +
      (goal.metric.min != null ? " / 需 ≥ " + goal.metric.min : "") +
      (goal.metric.max != null ? " / 需 ≤ " + goal.metric.max : ""));
  }
  return Object.assign(out, {
    met: codeOk && metricOk,
    metric: goal.metric ? (goal.metric.name || "指标") : null,
    value: value,
    detail: parts.join(" · ")
  });
}

/** 进展判定:指标在往目标方向走就算有进展;没有指标就只能看达标翻转 */
function madeProgress(goal, prev, cur) {
  if (!goal || !goal.metric || prev == null || cur == null) return null;
  if (goal.metric.min != null) return cur > prev;
  if (goal.metric.max != null) return cur < prev;
  return null;
}

module.exports = { check: check, madeProgress: madeProgress, runCommand: runCommand };
