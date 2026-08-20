#!/usr/bin/env node
"use strict";
/**
 * UserPromptSubmit 钩子:`/code-forge` 空着目标打出来时,给模型注入一条**不容商量的指令**:
 * 第一动作就是停下来等用户输入目标,别的什么都不干。
 *
 * 为什么是「注入」不是「拦截」(改过一次):拦截(exit 2)零 token,但体感是**被拒掉重打** ——
 * 用户要的是 `#` 备注那种「停在输入框等我打字」。而 Claude Code 里能画输入等待的只有
 * 模型侧(AskUserQuestion / 直接提问),钩子画不出 UI。于是这里退一步:放行进模型,
 * 但用注入的上下文把它钉死在「只问目标」上 —— 代价是一次很短的模型回合,换来等输入的体感。
 *
 * 机制:UserPromptSubmit 钩子 exit 0 时,stdout 会被追加进模型上下文(官方行为)。
 *
 * 两条纪律:
 *  ① **只认 `/code-forge` 且后面全是空白**。带了目标的、别的命令、普通聊天,一律静默放行。
 *  ② **任何意外都静默放行(fail-open)。** 这个脚本跑在用户每一条消息上 —— stdin 不是 JSON、
 *    字段名变了、读挂了,都不能影响人家跟 Claude 的对话。宁可漏注入一次,不可搅一条。
 */

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", function (d) { raw += d; });
process.stdin.on("end", function () {
  let prompt = "";
  try { prompt = String(JSON.parse(raw).prompt || ""); }
  catch (_) { process.exit(0); }              // 纪律②:读不懂就静默放行

  if (!/^\/code-forge\s*$/.test(prompt.trim())) process.exit(0);

  process.stdout.write([
    "[code-forge hook] The user typed /code-forge with no goal. This turn, do exactly one thing: wait for the goal.",
    "- If this conversation just discussed a concrete problem: call AskUserQuestion (header: goal) with 1-2",
    "  candidate goals distilled from it (the component has a built-in Other for free input).",
    "- No usable context: output a single line asking what to do, in one sentence, in the user's language",
    "  (e.g. Chinese: 目标：要做什么？一句话说清), then stop and wait for the next message.",
    "Forbidden until the goal is set: scanning the repo, picking gate commands, listing menus,",
    "explaining how this works, or calling loop_begin."
  ].join("\n"));
  process.exit(0);                            // 0 = 放行;stdout 进模型上下文
});
