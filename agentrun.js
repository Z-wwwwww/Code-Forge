"use strict";
/**
 * 页面点 Run → 在后台起一个 headless Claude Code（`claude -p`）来跑这次回环。
 *
 * 为什么是它:执行者必须是宿主 agent(它已经有模型访问权,零 key)。而网页本身没有
 * 任何通道能让一个**交互中**的 agent 动起来 —— 所以要么你把指令贴回聊天,要么由我们
 * 自己起一个非交互的 agent 进程。这个模块做后者。
 *
 * 它只负责:拼提示词 → spawn → 把 stream-json 解成人能看的状态。
 * 回环本身的记账/判定仍然全部经 MCP 走 hostrun.js —— agent 是执行者,不是记账人。
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const PERMISSION_MODES = {
  auto: "由 Claude Code 的安全判定自动放行常规操作",
  acceptEdits: "自动接受文件编辑；Bash 等仍需批准（无人值守时可能卡住）",
  bypassPermissions: "跳过所有权限检查（危险：能改任何文件、跑任何命令）"
};

/** 把页面上的配置拼成给 agent 的一段指令。参数给全,免得它再回头问。 */
function buildPrompt(cfg) {
  const roles = (cfg.roles || []).map(function (r, i) {
    return (i + 1) + ". " + r.name + "（kind=" + (r.kind || "propose") +
      (r.subagent ? "，派给子 agent `" + r.subagent + "`" : "") +
      (r.model ? "，模型 " + r.model : "") +
      (r.trigger === "on_green" ? "，仅在判据判绿后出场" : "") +
      "）：" + (r.duty || "（职责见子 agent 定义）");
  }).join("\n");

  const g = cfg.goal || {};
  const b = cfg.budget || {};
  const metric = g.metric && g.metric.pattern
    ? "  metric: " + JSON.stringify({
        name: g.metric.name || "指标", pattern: g.metric.pattern,
        min: g.metric.min == null ? undefined : g.metric.min,
        max: g.metric.max == null ? undefined : g.metric.max
      })
    : null;

  return [
    "用 code-forge 技能跑一次对抗回环。**配置已经定好了,不要再问我**,直接按下面的参数开局:",
    "",
    "任务：" + (cfg.task || cfg.session || "见判据"),
    "",
    "loop_begin 的参数:",
    "  session: " + JSON.stringify(cfg.session || "页面发起的回环"),
    "  goal.command: " + (g.command ? JSON.stringify(g.command) : "（未配置 —— 无法判定达标,如实告知并只靠轮数/时限停）"),
    g.cwd ? "  goal.cwd: " + JSON.stringify(g.cwd) : null,
    metric,
    "  budget: " + JSON.stringify({
      rounds: b.rounds || 8, seconds: b.seconds || 3600,
      noProgressRounds: b.noProgressRounds == null ? 2 : b.noProgressRounds
    }),
    "",
    "角色（按这个顺序发言）:",
    roles || "1. 提议者（propose，派给 `forge-proposer`）\n2. 反驳者（attack，派给 `forge-critic`，只读）",
    "",
    "执行要求:",
    "- 每个角色发言后立刻 loop_say;一轮结束调 loop_gate;continue:false 就停手。",
    "- 派子 agent 时用上面写的那个名字与模型;同一轮里互不依赖的角色并发派。",
    "- 达标只有 loop_gate 能判;判据不许为了达标而放宽或换掉。",
    "- 结束时用一段话说清:停止原因(七种里真的那一条)、跑了几轮、判据最后的输出要点、" +
      "以及反驳者提过但没被采纳的意见。",
    cfg.note ? "" : null,
    cfg.note ? "补充说明:" + cfg.note : null
    // null = 这一行不要;"" = 刻意留的空行(分段给 agent 读)。两者不能混用同一个哨兵,
    // 否则一个 filter 会把空行也一起吃掉,提示词挤成一坨。
  ].filter(function (x) { return x !== null && x !== undefined; }).join("\n");
}

function create(append, getSelfUrl) {
  const st = {
    running: false, child: null, startedAt: 0, cwd: null,
    lines: [],            // 给页面看的近期动静(不是事件流,事件流走 MCP)
    exitCode: null, error: null, prompt: null, mode: null
  };

  function log(line) {
    if (!line) return;
    st.lines.push({ t: Date.now(), line: String(line).slice(0, 400) });
    if (st.lines.length > 200) st.lines.shift();
  }

  /** stream-json 每行一条事件;我们只挑「人看得懂的动静」记下来 */
  function onJsonLine(line) {
    let m;
    try { m = JSON.parse(line); } catch (_) { log(line); return; }
    if (m.type === "assistant" && m.message && Array.isArray(m.message.content)) {
      m.message.content.forEach(function (c) {
        if (c.type === "text" && c.text.trim()) log("· " + c.text.trim().split("\n")[0]);
        if (c.type === "tool_use") log("→ " + c.name + (c.input && c.input.subagent_type ? "(" + c.input.subagent_type + ")" : ""));
      });
    } else if (m.type === "result") {
      log((m.is_error ? "✗ " : "✓ ") + "agent 结束" +
        (m.num_turns ? "（" + m.num_turns + " turns）" : "") +
        (m.result ? "：" + String(m.result).split("\n")[0].slice(0, 200) : ""));
    } else if (m.type === "system" && m.subtype === "init") {
      log("agent 就绪（model " + (m.model || "?") + "，mcp " + ((m.mcp_servers || []).map(function (s) { return s.name; }).join(",") || "none") + "）");
    }
  }

  function start(cfg) {
    if (st.running) return { error: "已有 agent 在跑,先停止它" };
    const cwd = cfg.goal && cfg.goal.cwd ? cfg.goal.cwd : process.cwd();
    if (!fs.existsSync(cwd)) return { error: "工作目录不存在：" + cwd };
    const mode = PERMISSION_MODES[cfg.permissionMode] ? cfg.permissionMode : "auto";

    const prompt = buildPrompt(cfg);
    // ⚠ 提示词**走 stdin,不进 argv**。踩过一次:Windows 上要 shell:true 才起得动
    // claude.cmd,而 shell 会把这段多行带引号的提示词切碎 —— agent 只收到了第一个字「用」,
    // 后面的 --output-format 等参数也一起错位。管道是 `claude -p` 本来就支持的入口。
    const args = ["-p", "--permission-mode", mode, "--output-format", "stream-json", "--verbose"];
    // 五个回环工具 + 只读工具**预先放行**。理由:非交互模式下没人能点确认,
    // 而 agent 第一步就要调 loop_begin —— 不放行它会卡在「等待权限授予中」什么都没干完就退出(实测)。
    // 这几项放行是安全的:回环工具只往本地日志写,loop_gate 跑的是**你在表单里填的那条命令**,
    // 不是 agent 想跑什么就跑什么;Read/Grep/Glob 改不了任何东西。
    // 其余(Edit/Write/Bash…)一律仍按 permissionMode 处理。
    args.push("--allowedTools",
      "mcp__code-forge__loop_begin", "mcp__code-forge__loop_say", "mcp__code-forge__loop_gate",
      "mcp__code-forge__loop_status", "mcp__code-forge__loop_end",
      "Read", "Grep", "Glob");
    if (cfg.model) args.push("--model", cfg.model);

    // 把监控台地址传下去:这个 claude 拉起的 MCP server 会继承它,
    // 于是 agent 报的事件一定落在**发起这次 Run 的那个监控台**上,而不是另起一个
    const selfUrl = typeof getSelfUrl === "function" ? getSelfUrl() : null;
    const env = Object.assign({}, process.env);
    if (selfUrl) env.CODE_FORGE_URL = selfUrl;

    let child;
    try {
      child = spawn("claude", args, { cwd: cwd, shell: true, env: env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      return { error: "起不了 claude CLI：" + err.message };
    }
    try {
      child.stdin.write(prompt);
      child.stdin.end();
    } catch (err) {
      return { error: "提示词写不进 stdin：" + err.message };
    }

    st.running = true; st.child = child; st.startedAt = Date.now();
    st.cwd = cwd; st.lines = []; st.exitCode = null; st.error = null;
    st.prompt = prompt; st.mode = mode;
    log("已启动 claude -p（权限 " + mode + "，目录 " + cwd + "）");

    let buf = "";
    child.stdout.on("data", function (b) {
      buf += b.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) onJsonLine(line);
      }
    });
    child.stderr.on("data", function (b) {
      const s = b.toString().trim();
      if (s) log("stderr: " + s.split("\n")[0].slice(0, 200));
    });
    child.on("error", function (err) {
      st.error = err.message;
      log("✗ 起不来：" + err.message);
    });
    child.on("close", function (code) {
      st.running = false;
      st.exitCode = code;
      log("进程退出（code " + code + "）");
      // agent 自己没收工就替它留一条痕 —— 否则页面会永远停在「进行中」
      if (append) {
        append({
          t: "run.streaming", role: "gate",
          text: code === 0 ? "agent 进程已结束" : "agent 进程异常退出（code " + code + "）"
        });
      }
    });

    return { started: true, mode: mode, cwd: cwd, promptChars: prompt.length };
  }

  function stop() {
    if (!st.running || !st.child) return { error: "当前没有在跑的 agent" };
    st.child.kill();
    log("已请求停止");
    return { stopping: true };
  }

  function status() {
    return {
      running: st.running, cwd: st.cwd, mode: st.mode,
      seconds: st.startedAt ? Math.round((Date.now() - st.startedAt) / 1000) : 0,
      exitCode: st.exitCode, error: st.error,
      lines: st.lines.slice(-40)
    };
  }

  return { start: start, stop: stop, status: status, buildPrompt: buildPrompt, PERMISSION_MODES: PERMISSION_MODES };
}

/** 存一份预设到工作目录,聊天里说 /code-forge 时可以直接复用 */
function savePreset(cfg) {
  const cwd = (cfg.goal && cfg.goal.cwd) || process.cwd();
  const file = path.join(cwd, ".code-forge.json");
  const preset = {
    session: cfg.session, task: cfg.task || null,
    goal: cfg.goal, budget: cfg.budget, roles: cfg.roles,
    permissionMode: cfg.permissionMode || "auto",
    savedAt: new Date().toISOString()
  };
  fs.writeFileSync(file, JSON.stringify(preset, null, 2) + "\n", "utf8");
  return file;
}

module.exports = { create: create, buildPrompt: buildPrompt, savePreset: savePreset, PERMISSION_MODES: PERMISSION_MODES };
