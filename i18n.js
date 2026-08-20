"use strict";
/**
 * 服务端生成文案的双语表(用户点名:提示词全英文,**UI 文字跟着用户对话的语言走**)。
 *
 * 谁用:hostrun / gate / judge 落进事件流的那些「机器写的话」(轮标题、判据结论、
 * 心跳、停止原因)。lang 由 loop_begin 时协调者带来(或按目标文本自动判),存进
 * run.start 事件 —— TUI/网页的静态标签各自有前端词典,这里只管事件里的内容。
 *
 * 纪律:**事件是档案**,写进去哪种语言就永远是哪种 —— 所以按「回环的 lang」定,
 * 不按「谁在看」定;同一份档案不同人看必须是同一份事实。
 */

const TABLES = {
  zh: {
    // hostrun:开局/角色
    unnamedRun: "未命名回环",
    hostAgent: "宿主 agent",
    hostModel: "宿主模型",
    roleN: function (i) { return "角色 " + i; },
    goalJoin: " 且 ",
    noGoal: "(未配置判据)",
    gateName: "判据",
    gateModel: "确定性 · 无模型",
    gateDuty: function (cmd) { return cmd ? "跑 " + cmd : "未配置 —— 无法判定达标"; },
    roundTitle: function (n) { return "第 " + n + " 轮对抗"; },
    inProgress: "进行中",
    // hostrun:静默看门狗
    quietStart: function (s) {
      return "开局 " + s + "s 还没有任何角色发言 —— 执行者多半在读仓库/派活(大目标首轮 5~15 分钟正常)";
    },
    quietRound: function (n, s, last) {
      return "第 " + n + " 轮 · 距上一条发言已 " + s + "s" +
        (last ? "（上一条:" + last.name + "「" + last.summary + "」" +
            (last.kind === "attack" ? "，多半在等实现者修" : "，角色多半还在干活") + "）"
          : " —— 角色多半还在干活(子 agent 一跑几分钟正常)");
    },
    quietNag: "；一直这样就回执行者那头看看它是不是停了/在等审批",
    // hostrun:判据事件
    metPrefix: "达标 · ",
    notMetPrefix: "未达标 · ",
    notJudged: "未判定：",
    outputTail: "\n--- 命令输出（尾部）---\n",
    judgeTail: "\n--- 评审者原话（尾部）---\n",
    judgeShortTail: "\n--- 评审者 ---\n",
    judgeActivity: "评审者 · ",
    judgeBroken: "评审判据失败：",
    judgeMet: "评审判定达标 · ",
    judgeNotMet: "评审判定未达标 · ",
    judgeNext: "\n下一轮该改：",
    judgeLabel: "评审",
    gateLabel: "判据",
    judgePrefix: "评审：",
    noGate2: "没有判据",
    saidNone: function (name) {
      return "本轮没人报 " + name + " —— 反驳者/复核者 loop_say 要带 value(本轮量出来的数);实现者报的不算";
    },
    saidDetail: function (name, v, role, range) { return name + " = " + v + "（" + role + " 报的,要求 " + range + "）"; },
    saidNoneShort: function (name) { return "本轮没人报 " + name + "(say)"; },
    // hostrun:流程异常(写进裁决细节与 run.end)
    idleSpin: function (n) { return "连续 " + n + " 轮没有任何角色改过文件（权限够吗？提示词是不是让它只做分析？）"; },
    stalledDetail: function (who) { return "角色进程卡住被中止：" + who; },
    // hostrun:round.end
    roundMetFinal: function (label) { return label + " · 达标"; },
    roundMetStreak: function (label, cur, need) { return label + " · 本轮过（连胜 " + cur + "/" + need + "）"; },
    roundNotMet: "未达标",
    // 停止原因(写进 run.end 的 label 与 status)
    reasons: {
      goal_met: "达标停止（命令判过）",
      judged_met: "达标停止（独立评审者判定，非命令）",
      reported_met: "达标停止（角色上报的指标，非命令）",
      budget_tokens: "TOKEN 预算用尽（只计量得到的部分）",
      budget_rounds: "到达轮数上限",
      budget_time: "超出时限",
      no_progress: "连续零进展",
      idle_spin: "空跑（没有任何角色真的改过东西）",
      stalled: "长时间停滞（角色进程卡住被中止）",
      stopped: "手动停止",
      gate_broken: "判据本身失败",
      judge_broken: "评审判据本身失败",
      abandoned: "宿主放弃(说明见 detail)",
      interrupted: "中断（执行者会话关闭/进程被杀）"
    },
    // gate.js
    gNoCmd: "未配置判据命令",
    gNoCmdDetail: "没有可判定的目标 —— 只能靠预算闸停止",
    gCantRun: "判据命令无法执行：",
    gTimeout: "判据命令超时被中止",
    gNotFound: function (code, line) { return "判据命令找不到（exit " + code + "）：" + line; },
    gBadRegex: "指标正则无法编译：",
    gExit: function (code) { return "退出码 " + code; },
    gMetric: function (name, v, range) { return name + " = " + (v == null ? "未抓到" : v) + "（要求 " + range + "）"; },
    // judge.js 解析
    jNoVerdict: "评审者没有给出 VERDICT 行,判不出结论",
    jNoEvidence: "评审者判了 MET 但**一条证据都没给**（要引用 文件:行号）—— 按未达标算",
    jMet: "评审判定达标", jNotMet: "评审判定未达标",
    jEvidence: function (n) { return " · " + n + " 处证据"; },
    jNoRubric: "评审判据没有 rubric 也没有目标 —— 判不了",
    jCantStart: "起不了评审者：",
    jNoParse: function (label) { return label + " 的输出格式没实测过，解不出评审者的裁定（换个宿主，或先给它写 parse）"; },
    jStdin: "提示词写不进评审者的 stdin：",
    judgeRole: "评审者"
  },

  en: {
    unnamedRun: "untitled loop",
    hostAgent: "host agent",
    hostModel: "host model",
    roleN: function (i) { return "role " + i; },
    goalJoin: " and ",
    noGoal: "(no gate configured)",
    gateName: "Gate",
    gateModel: "deterministic · no model",
    gateDuty: function (cmd) { return cmd ? "runs " + cmd : "not configured — success cannot be judged"; },
    roundTitle: function (n) { return "Round " + n; },
    inProgress: "in progress",
    quietStart: function (s) {
      return "No role has spoken " + s + "s into the run — the executor is likely reading the repo / " +
        "dispatching (5–15 min is normal for a big first round)";
    },
    quietRound: function (n, s, last) {
      return "Round " + n + " · " + s + "s since the last statement" +
        (last ? " (last: " + last.name + " “" + last.summary + "”" +
            (last.kind === "attack" ? ", likely waiting on the proposer" : ", roles are likely still working") + ")"
          : " — roles are likely still working (subagents often run for minutes)");
    },
    quietNag: "; if this persists, check the executor side — it may have stopped or be awaiting approval",
    metPrefix: "Met · ",
    notMetPrefix: "Not met · ",
    notJudged: "Not judged: ",
    outputTail: "\n--- command output (tail) ---\n",
    judgeTail: "\n--- judge's own words (tail) ---\n",
    judgeShortTail: "\n--- judge ---\n",
    judgeActivity: "judge · ",
    judgeBroken: "Judge gate failed: ",
    judgeMet: "Judge ruled met · ",
    judgeNotMet: "Judge ruled not met · ",
    judgeNext: "\nNext round should change: ",
    judgeLabel: "judge",
    gateLabel: "gate",
    judgePrefix: "judge: ",
    noGate2: "no gate",
    saidNone: function (name) {
      return "No one reported " + name + " this round — the critic/reviewer must loop_say with value; " +
        "proposer reports do not count";
    },
    saidDetail: function (name, v, role, range) {
      return name + " = " + v + " (reported by " + role + ", requires " + range + ")";
    },
    saidNoneShort: function (name) { return "no one reported " + name + " (say)"; },
    idleSpin: function (n) { return n + " consecutive rounds with no role changing any file (enough permissions? does the prompt ask for analysis only?)"; },
    stalledDetail: function (who) { return "role process stalled and was aborted: " + who; },
    roundMetFinal: function (label) { return label + " · met"; },
    roundMetStreak: function (label, cur, need) { return label + " · round passed (streak " + cur + "/" + need + ")"; },
    roundNotMet: "not met",
    reasons: {
      goal_met: "Stopped: goal met (ruled by command)",
      judged_met: "Stopped: goal met (independent judge, not a command)",
      reported_met: "Stopped: goal met (role-reported metric, not a command)",
      budget_tokens: "Token budget exhausted (measurable share only)",
      budget_rounds: "Round limit reached",
      budget_time: "Time limit exceeded",
      no_progress: "No progress for consecutive rounds",
      idle_spin: "Idle spin (no role actually changed anything)",
      stalled: "Stalled (a role process hung and was aborted)",
      stopped: "Stopped manually",
      gate_broken: "The gate itself failed",
      judge_broken: "The judge gate itself failed",
      abandoned: "Abandoned by the host (see detail)",
      interrupted: "Interrupted (executor session closed / process killed)"
    },
    gNoCmd: "no gate command configured",
    gNoCmdDetail: "nothing to judge against — only budget gates can stop this run",
    gCantRun: "gate command failed to execute: ",
    gTimeout: "gate command timed out and was aborted",
    gNotFound: function (code, line) { return "gate command not found (exit " + code + "): " + line; },
    gBadRegex: "metric regex failed to compile: ",
    gExit: function (code) { return "exit code " + code; },
    gMetric: function (name, v, range) {
      return name + " = " + (v == null ? "not captured" : v) + " (requires " + range + ")";
    },
    jNoVerdict: "the judge produced no VERDICT line; no conclusion can be drawn",
    jNoEvidence: "the judge ruled MET but cited **no evidence at all** (file:line required) — counted as not met",
    jMet: "judge ruled met", jNotMet: "judge ruled not met",
    jEvidence: function (n) { return " · " + n + " pieces of evidence"; },
    jNoRubric: "the judge gate has neither a rubric nor a goal — nothing to judge",
    jCantStart: "could not start the judge: ",
    jNoParse: function (label) { return label + "'s output format is untested; the judge's verdict cannot be parsed (use another host, or write a parse for it)"; },
    jStdin: "could not write the prompt to the judge's stdin: ",
    judgeRole: "judge"
  }
};

/** 取词表。认不出的 lang 落回 zh(历史档案与既有用户的默认)。 */
function T(lang) { return TABLES[String(lang || "zh").toLowerCase()] || TABLES.zh; }

module.exports = { T: T, TABLES: TABLES };
