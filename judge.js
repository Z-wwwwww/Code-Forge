"use strict";
/**
 * 评审判据 —— 给**没有命令可判**的目标用（「重构得更好读」「补齐 API 文档」「命名统一」）。
 *
 * ## 为什么不是「让协调者判」
 *
 * 这是这一层唯一的设计要点,所以写在最前面。
 *
 * 协调者是**做事的那一方**。它有充分动机说「已达标」—— 整个项目存在的理由就是把这句话
 * 从做事的人手里拿走(`loop_end(goal_met)` 在判据没真判过之前会被拒)。让协调者判,
 * 等于把那条拒绝拆了,剩下一个界面。
 *
 * 所以判定人是**独立评审者**:
 *   · 独立会话 —— 不看协调者/实现者的对话历史,只看目标、rubric、和代码
 *   · **只读**  —— 宿主级强制(codex `-s read-only` / claude 只放行 Read/Grep/Glob)。
 *                  一个能顺手改代码的评审者可以先改好再判过
 *   · 尽量不同模型 —— 同一个模型评自己写的东西,通过率虚高
 *   · **必须给证据** —— 只说「看起来不错」不算达标(见 parseVerdict:无证据的 MET 降级)
 *
 * 核心性质保住了:**达标与否不由做事的人自己说。** 从「代码判」放宽到「独立第三方判」,
 * 但没有放宽到「自己判」。
 *
 * ## 它比命令判据弱，这件事必须一路标到底
 *
 * 一条命令的退出码是可复现的;一个模型的裁定不是。所以停止原因**单列** `judged_met`,
 * 绝不混进 `goal_met` —— 回放一次运行时,「真跑过 pytest」和「某个模型说了句挺好」
 * 必须分得清。页面、TUI、usage 各处都按这个区分显示。
 */

const adapters = require("./adapters.js");
const agentcli = require("./agentcli.js");
const usage = require("./usage.js");

/** 评审者的提示词。**它必须自成一体** —— 独立会话,看不到任何人的历史。 */
function judgePrompt(o) {
  const L = [];
  L.push("你是一次对抗回环的**独立评审者**。你不参与改代码,只做一件事:判这次是否达标。");
  L.push("");
  L.push("目标：" + (o.task || "（未给出）"));
  L.push("");
  L.push("判定标准（rubric，逐条判）：");
  L.push(String(o.rubric || "（未给出 —— 那就按上面的目标逐条判）").trim());
  L.push("");
  if (o.command) {
    L.push("⚠ 这次**还有**一条命令判据 `" + o.command + "`,它已经由代码跑过并且**通过**了。");
    L.push("命令过了不代表目标达成 —— 你要判的正是命令覆盖不到的那部分。");
    L.push("");
  }
  L.push("这一轮各角色说了什么（他们的原话,仅供参考,**不要因为他们说达标就判达标**）：");
  (o.said || []).forEach(function (s) {
    L.push("【" + s.role + "】" + (s.summary || ""));
    if (s.body) L.push(String(s.body).slice(0, 1200));
  });
  if (!o.said || !o.said.length) L.push("（没有发言记录）");
  L.push("");
  L.push("怎么判：**自己去读代码**。他们的自述可能不准,也可能只改了一半。");
  L.push("你是只读的 —— 改不了任何文件,这是有意的:能顺手改代码的评审者可以先改好再判过。");
  L.push("");
  L.push("输出格式（**严格照这个,第一行必须是这个词**,驱动方按行解析）:");
  L.push("VERDICT: MET        ← 达标");
  L.push("VERDICT: NOT_MET    ← 未达标");
  L.push("");
  L.push("第二行起:逐条说 rubric 的每一条过没过,每条都要**引用 `文件:行号` 作为证据**。");
  L.push("拿不出证据的条目按未过算 —— 空口说「看起来不错」不是证据。");
  L.push("最后一行以 `NEXT:` 开头,写未达标时下一轮该改什么(达标就写 NEXT: 无)。");
  return L.join("\n");
}

/**
 * 解裁定。**严格**:解不出 MET/NOT_MET 就是判据坏了(judge_broken),不是「未达标」——
 * 与 gate.js 里「命令找不到 ≠ 测试没过」同一条纪律。
 */
function parseVerdict(text, context) {
  const s = String(text || "");
  const m = /VERDICT:\s*(MET|NOT_MET)/i.exec(s);
  if (!m) {
    return { broken: true, detail: "评审者没有给出 VERDICT 行,判不出结论" };
  }
  const met = /^MET$/i.test(m[1]);
  // 证据 = 出现了 `文件:行号` 这种引用。**无证据的 MET 不算达标** ——
  // 否则「看起来不错」就能签合格证,评审判据的意义就没了。
  // ⚠ 已知局限:这里扫的是评审者整段输出,若它在作答时复述了 rubric/目标原文
  // (这些文本本身恰好含 `文件:行号` 样式的例子),会被误当成它自己找到的证据。
  // 保守处理:先把 rubric/目标的原文从待扫描文本里剔掉,降低这种复述被计入的概率。
  let scanned = s;
  if (context) {
    [context.rubric, context.task].forEach(function (t) {
      if (t && String(t).trim()) scanned = scanned.split(String(t)).join(" ");
    });
  }
  const evidence = (scanned.match(/[\w./\\-]+\.\w+:\d+/g) || []).slice(0, 20);
  const next = (/NEXT:\s*(.+)/i.exec(s) || [])[1] || "";
  if (met && !evidence.length) {
    return {
      met: false, broken: false, downgraded: true,
      evidence: [], next: next,
      detail: "评审者判了 MET 但**一条证据都没给**（要引用 文件:行号）—— 按未达标算"
    };
  }
  return {
    met: met, broken: false, evidence: evidence, next: next,
    detail: (met ? "评审判定达标" : "评审判定未达标") +
      (evidence.length ? " · " + evidence.length + " 处证据" : "")
  };
}

/**
 * 挑评审者用哪个宿主/模型。
 * **尽量避开实现者用的那个模型** —— 同一个模型评自己写的东西通过率虚高。
 */
function pickReviewer(opts) {
  const want = opts.agent || null;
  const picked = adapters.pickInstalled(want);
  if (picked.error) return { error: picked.error };
  const ad = picked.adapter;
  if (opts.model) return { adapter: ad, model: agentcli.safeModel(opts.model) };

  const avoid = new Set((opts.avoidModels || []).filter(Boolean));
  const list = (typeof ad.models === "function" ? ad.models() : [])
    .filter(function (m) { return !adapters.unusableModels(ad.id).has(m.id); });
  // 最强的优先(评审要看得出问题),但避开实现者那个;都被避开就只能同一个 —— 如实标出来
  const ordered = list.filter(function (m) { return m.strong; })
    .concat(list.filter(function (m) { return !m.strong && !m.weak; }))
    .concat(list.filter(function (m) { return m.weak; }));
  const fresh = ordered.filter(function (m) { return !avoid.has(m.id); })[0];
  const any = ordered[0];
  return {
    adapter: ad,
    model: (fresh || any || {}).id || null,
    sameAsProposer: !fresh && !!any && avoid.has(any.id)
  };
}

/**
 * 跑一次评审。返回 { met, broken, detail, evidence, next, output, ms, model, agent, usageEvents }。
 *
 * @param o { task, rubric, cwd, command, said, agent, model, avoidModels, round }
 */
async function check(o) {
  o = o || {};
  if (!o.rubric && !o.task) {
    return { met: false, broken: true, detail: "评审判据没有 rubric 也没有目标 —— 判不了" };
  }
  const started = Date.now();
  const pick = pickReviewer(o);
  if (pick.error) return { met: false, broken: true, detail: "起不了评审者：" + pick.error };
  const ad = pick.adapter;
  if (typeof ad.parse !== "function") {
    return { met: false, broken: true,
      detail: ad.label + " 的输出格式没实测过，解不出评审者的裁定（换个宿主，或先给它写 parse）" };
  }

  // 只读:宿主级强制。评审者能改文件的话,它可以先把问题改好再判过。
  const perm = adapters.permissionFor(ad, "readOnly");
  const args = ad.buildArgs({ model: pick.model, cwd: o.cwd, permission: perm, readOnly: true });
  const env = Object.assign({}, process.env);
  // 评审者不该往事件流里写东西 —— 记账是驱动方的活
  delete env.CODE_FORGE_URL;

  const started2 = agentcli.run(args, { cwd: o.cwd || process.cwd(), env: env, bin: ad.bin });
  if (started2.error) return { met: false, broken: true, detail: "起不了评审者：" + started2.error };
  const child = started2.child;
  const prompt = judgePrompt(o);
  try {
    if (ad.promptVia === "arg") child.stdin.end();
    else { child.stdin.write(prompt); child.stdin.end(); }
  } catch (e) {
    return { met: false, broken: true, detail: "提示词写不进评审者的 stdin：" + e.message };
  }

  const tracker = usage.createTracker({
    source: ad.id + "（评审者）", soloLabel: "评审者",
    soloKey: "role:评审者", model: pick.model || null
  });
  let text = null;
  let buf = "";
  const logs = [];
  const onLine = function (line) {
    let m;
    try { m = JSON.parse(line); } catch (_) { logs.push(line.slice(0, 200)); return; }
    const r = tracker.ingestRaw(ad, m, o.round || 1);
    if (r && r.log) {
      logs.push(r.log);
      if (o.onActivity) { try { o.onActivity(r.log); } catch (_) {} }
    }
    const parsed = ad.parse(m);
    if (parsed && parsed.text) text = parsed.text;   // 最后那条最终答复才是裁定
  };

  const done = await new Promise(function (resolve) {
    child.stdout.on("data", function (b) {
      buf += b.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) onLine(line);
      }
    });
    child.stderr.on("data", function (b) {
      const s = b.toString().trim();
      if (s) logs.push("stderr: " + s.split("\n")[0].slice(0, 160));
    });
    let settled = false;
    child.on("error", function (e) {
      if (!settled) { settled = true; resolve({ error: e.message }); }
    });
    child.on("close", function (code) {
      if (settled) return;
      settled = true;
      if (buf.trim()) onLine(buf.trim());
      resolve({ code: code });
    });
  });

  const evs = tracker.flush();
  const fin = tracker.finalEvent();
  const usageEvents = fin ? evs.concat([fin]) : evs;
  const base = {
    ms: Date.now() - started, model: pick.model, agent: ad.id,
    sameAsProposer: !!pick.sameAsProposer,
    output: String(text || logs.join("\n")).slice(-2000),
    usageEvents: usageEvents
  };
  if (done.error) {
    return Object.assign(base, { met: false, broken: true, detail: "评审者起不来：" + done.error });
  }
  if (!text) {
    // 它跑完了但一句话没说 —— 这是判据坏了,不是未达标
    return Object.assign(base, { met: false, broken: true,
      detail: "评审者没有给出结论（退出码 " + done.code + "）" });
  }
  return Object.assign(base, parseVerdict(text, { rubric: o.rubric, task: o.task }));
}

module.exports = { check: check, parseVerdict: parseVerdict, judgePrompt: judgePrompt,
  pickReviewer: pickReviewer };
