"use strict";
/**
 * 宿主适配器 —— 「怎么把一个 coding agent 非交互地起起来、怎么读懂它吐的东西、
 * MCP 往哪注册」,每个宿主一份描述。
 *
 * 为什么要这一层:回环本身、判据、留痕、直播早就是通用的了,但**「起」和「数用量」**
 * 一直写死在 claude 上 —— 于是别的宿主只能「你自己驱动」。把这三件事抽成数据,
 * 加一个宿主就只是加一条记录,不用改回环里的任何代码。
 *
 * ## 诚实分级(`verified`)
 *
 * 这里的参数分两种,**必须分开标**:
 *   `verified: true`  —— 在这台机器上真跑过,输出样本是抄下来的,不是记忆里的。
 *   `verified: false` —— 按各家公开的约定写的,**没实测**。可能是对的,也可能这一版改了名。
 * 把没验过的写成验过的,后果是用户按提示装完发现起不来,却以为是自己环境的问题。
 * 所以 `code-forge doctor` 会把这个标记原样显示出来。
 *
 * 任何一条都能被 `~/.code-forge/agents.json` 覆盖或新增 —— 不认识的 CLI 也能自己接进来,
 * 不必等我们支持。
 *
 * ## 一个宿主要给出什么
 *
 *   bin / versionArgs      怎么探测它装没装
 *   buildArgs(o)           非交互跑一段提示词的参数(提示词走 stdin,不进 argv)
 *   perms                  把统一的三档权限映射到它自己的说法
 *   parse(obj)             它吐的一行 → { log, records[] }(records 见 usage.js)
 *   mcp                    MCP 注册方式:cli / json / toml
 *   subagents              它能不能派子 agent(决定用量能不能摊到角色)
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

/* ================================================================
 * Claude Code —— 实测过
 * 样本(2026-08，claude-code CLI):
 *   {"type":"system","subtype":"init","model":…,"mcp_servers":[…]}
 *   {"type":"assistant","parent_tool_use_id":null|"toolu_…",
 *    "message":{"id":"msg_…","model":…,"content":[…],"usage":{input_tokens,output_tokens,
 *               cache_read_input_tokens,cache_creation_input_tokens}}}
 *   {"type":"result","total_cost_usd":…,"num_turns":…,"usage":{…}}
 * 三个坑都在 usage.js 顶部记着:消息会被拆成多条重复报 usage、派子 agent 的工具叫
 * `Agent` 不叫 `Task`、result 里那份不是全程总数。
 * ================================================================ */
const claude = {
  id: "claude",
  label: "Claude Code",
  bin: "claude",
  verified: true,
  subagents: true,
  cost: true,
  // 唯一会**自动加载** skills/code-forge/SKILL.md 的宿主。别的宿主要把协议内联进提示词。
  skill: true,
  versionArgs: ["--version"],
  promptVia: "stdin",
  models: function () { return claudeModels(); },
  perms: {
    // readOnly 没有对应的 permission-mode —— claude 的只读是**工具层面**的,
    // 见下面 o.readOnly:只放行 Read/Grep/Glob,写工具一个都不给。
    readOnly: "auto",
    auto: "auto",
    acceptEdits: "acceptEdits",
    bypassPermissions: "bypassPermissions"
  },
  buildArgs: function (o) {
    const args = ["-p", "--permission-mode", o.permission || "auto",
      "--output-format", "stream-json", "--verbose"];
    if (o.readOnly) {
      // 只读角色(反驳者/复核者):**只**放行读工具。一个能顺手把问题抹平的反驳者
      // 等于没有反驳者 —— 所以这条是工具层面的硬约束,不是提示词里的请求。
      args.push("--allowedTools", "Read", "Grep", "Glob");
    } else if (o.allowTools !== false) {
      // 回环那五个工具与只读工具**预先放行**:非交互模式下没人能点确认,而 agent 第一步
      // 就要调 loop_begin —— 不放行它会卡在「等待权限授予中」什么都没干完就退出(实测)。
      args.push("--allowedTools",
        "mcp__code-forge__loop_begin", "mcp__code-forge__loop_say", "mcp__code-forge__loop_gate",
        "mcp__code-forge__loop_status", "mcp__code-forge__loop_end", "mcp__code-forge__loop_agent",
        "Read", "Grep", "Glob");
    }
    if (o.model) args.push("--model", o.model);
    return args;
  },
  mcp: {
    kind: "cli",
    add: function (name, cmd) { return ["mcp", "add", "--scope", "user", name, "--"].concat(cmd); },
    remove: function (name) { return ["mcp", "remove", "--scope", "user", name]; },
    /**
     * 「注册了没」直接读磁盘,**不要**去问 `claude mcp list`。
     *
     * 实测:`claude mcp list` 要 6.8~7.9s —— 它会把已配置的每个 MCP server 都**拉起来**
     * 做一次健康检查(顺带把 code-forge 自己也起一遍)。而 doctor 只想知道一个布尔值。
     * 光这一句就占了 `code-forge doctor` 9.5s 里的 8s;test-host 的 doctor 那段更惨,
     * 它要连着调 probeHosts 好几次。
     *
     * 三个 scope 全查(用户可能不是用 install 装的):
     *   user  → ~/.claude.json 顶层 mcpServers   ← install.js 写的是这儿(--scope user)
     *   local → ~/.claude.json 的 projects[cwd].mcpServers
     *   project → 工作目录里的 .mcp.json
     * 读不着/解析不了就回 null(=「查不出来」),调用方会退回问 CLI —— 别把
     * 「没查到」说成「没注册」。
     */
    registered: function (name) {
      const f = path.join(os.homedir(), ".claude.json");
      let j = null;
      try { j = JSON.parse(fs.readFileSync(f, "utf8")); } catch (_) { return null; }
      if (!j || typeof j !== "object") return null;
      const inMap = function (m) { return !!(m && typeof m === "object" && m[name]); };
      if (inMap(j.mcpServers)) return true;
      const pr = j.projects && typeof j.projects === "object" ? j.projects : {};
      if (Object.keys(pr).some(function (k) { return inMap(pr[k] && pr[k].mcpServers); })) return true;
      try {
        const pj = JSON.parse(fs.readFileSync(path.join(process.cwd(), ".mcp.json"), "utf8"));
        if (inMap(pj && pj.mcpServers)) return true;
      } catch (_) { /* 没这个文件是常态 */ }
      return false;
    }
  },
  parse: function (m) {
    if (!m || typeof m !== "object") return null;
    if (m.type === "system" && m.subtype === "init") {
      return { log: "agent 就绪（model " + (m.model || "?") + "，mcp " +
        ((m.mcp_servers || []).map(function (s) { return s.name; }).join(",") || "none") + "）" };
    }
    if (m.type === "result") {
      const u = m.usage || {};
      return {
        log: (m.is_error ? "✗ " : "✓ ") + "agent 结束" +
          (m.num_turns ? "（" + m.num_turns + " turns）" : "") +
          (m.result ? "：" + String(m.result).split("\n")[0].slice(0, 200) : ""),
        // 这个角色进程最后说了什么。per-role 模式下它就是这一轮该角色的发言 ——
        // 拿不到就没有发言可记,所以每个适配器都得给。
        text: typeof m.result === "string" ? m.result : null,
        final: {
          costUsd: typeof m.total_cost_usd === "number" ? m.total_cost_usd : null,
          seconds: m.duration_ms ? Math.round(m.duration_ms / 1000) : null,
          turns: m.num_turns || null,
          in: u.input_tokens || 0, out: u.output_tokens || 0,
          cacheRead: u.cache_read_input_tokens || 0,
          cacheWrite: u.cache_creation_input_tokens || 0,
          thinking: (u.output_tokens_details && u.output_tokens_details.thinking_tokens) || 0,
          isError: !!m.is_error,
          byModel: m.modelUsage ? Object.keys(m.modelUsage).map(function (name) {
            const v = m.modelUsage[name] || {};
            return { model: name, in: v.inputTokens || 0, out: v.outputTokens || 0,
              cacheRead: v.cacheReadInputTokens || 0, cacheWrite: v.cacheCreationInputTokens || 0,
              costUsd: typeof v.costUSD === "number" ? v.costUSD : null };
          }) : null
        }
      };
    }
    if (m.type !== "assistant" || !m.message) return null;

    const msg = m.message;
    const logs = [];
    const tools = [];
    (Array.isArray(msg.content) ? msg.content : []).forEach(function (c) {
      if (!c) return;
      if (c.type === "text" && c.text && c.text.trim()) logs.push("· " + c.text.trim().split("\n")[0]);
      if (c.type !== "tool_use") return;
      logs.push("→ " + c.name + (c.input && c.input.subagent_type ? "(" + c.input.subagent_type + ")" : ""));
      tools.push({
        id: c.id || null, name: c.name,
        // 派子 agent 按 **subagent_type** 认,不按工具名 —— 实测这一版叫 `Agent` 不叫 `Task`
        subagent: (c.input && c.input.subagent_type) || null,
        description: (c.input && c.input.description) || "",
        prompt: c.input && typeof c.input.prompt === "string" ? c.input.prompt.slice(0, 400) : ""
      });
    });
    const u = msg.usage || null;
    return {
      log: logs.join("\n") || null,
      records: [{
        parent: m.parent_tool_use_id || null,
        model: msg.model || null,
        // 同一条消息会被拆成多条事件重复报 usage —— 用 message.id 做去重键
        key: msg.id || null,
        tools: tools,
        usage: u ? {
          in: u.input_tokens || 0, out: u.output_tokens || 0,
          cacheRead: u.cache_read_input_tokens || 0,
          cacheWrite: u.cache_creation_input_tokens || 0
        } : null
      }]
    };
  }
};

/* ================================================================
 * Codex CLI —— 实测过（codex-cli 0.130.0）
 * 样本:
 *   {"type":"thread.started","thread_id":…}
 *   {"type":"turn.started"}
 *   {"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":…}}
 *   {"type":"turn.completed","usage":{input_tokens,cached_input_tokens,
 *                                     output_tokens,reasoning_output_tokens}}
 *
 * ## 子 agent：有，而且比 claude 的强（这一条我先前写错过）
 *
 * 早先这里写的是「exec 模式没有子 agent」。**错的。** 实测让 codex 自己列工具,
 * 它给出一整套:`spawn_agent` / `send_input` / `resume_agent` / `wait_agent` / `close_agent`。
 * `spawn_agent` 的参数(实测抄下来的 schema)比 claude 的 Agent 更全:
 *
 *   agent_type        内置 default / explorer / worker 三种角色类型
 *   model             逐子 agent 覆盖模型            ← claude 也有
 *   reasoning_effort  逐子 agent 覆盖推理档          ← claude **没有**
 *   fork_context      可选把父线程历史 fork 给它     ← claude **永远不共享**
 *   send_input/resume 子 agent 可续对话,不是一次性   ← claude 的 Task 是一次性
 *
 * 所以 codex 完全能做「一个进程内多角色、各绑模型」。
 *
 * ⚠ 但**默认仍然走 per-role 进程**,理由不是能力,是这两条实测:
 *   ① codex 在 workspace-write 下把 MCP 工具调用直接判 `user cancelled`,而协调者那条路
 *      必须调 loop_*(见下面 mcpNeedsPermission)—— 等于逼用户开 danger-full-access。
 *   ② 同宿主同模型的 A/B:协调者那条路 $0.3399 且两轮没过,per-role $0.0436 且一轮就过。
 *   能力和策略是两件事,别再混在一个布尔量里。
 *
 * ## 另一个跟 claude 不同的地方
 *
 *   不报成本 → costUsd 永远 null,页面显示「成本未上报」。
 * ================================================================ */
const codex = {
  id: "codex",
  label: "Codex CLI",
  bin: "codex",
  verified: true,
  // 有子 agent（spawn_agent 那一套，实测）。这是**能力**;走不走那条路是策略,见 preferPerRole。
  subagents: true,
  subagentApi: "spawn_agent",   // 顺带能覆盖 model 与 reasoning_effort,还能 fork_context
  /**
   * 尽管有子 agent,**默认仍然走 per-role 进程**。两条实测理由:
   *   ① 协调者那条路必须调 loop_* MCP 工具,而 codex 在 workspace-write 下一律判
   *      `user cancelled` —— 走它就得开 danger-full-access,不值得。
   *   ② 同宿主同模型 A/B:协调者 $0.3399 / 两轮没过,per-role $0.0436 / 一轮就过。
   * `--single` 可以强制走协调者那条路(记得同时给 --perm bypassPermissions)。
   */
  preferPerRole: true,
  cost: false,          // 不报 total cost
  versionArgs: ["--version"],
  promptVia: "stdin",
  models: function () { return codexModels(); },
  perms: {
    // codex 的沙箱档位。语义对不上就别硬对 —— acceptEdits 在 codex 里最接近的是
    // 「能写工作区」,而它的 danger-full-access 才对应 bypassPermissions。
    // ★ readOnly 这一档是 codex 的强项:`read-only` 是**操作系统级**的沙箱,
    //   反驳者在它下面根本改不动文件 —— 比任何提示词都硬。
    readOnly: "read-only",
    auto: "workspace-write",
    acceptEdits: "workspace-write",
    bypassPermissions: "danger-full-access"
  },
  /**
   * ★ codex 在 `workspace-write` 及以下**一律不放行 MCP 工具调用**:每次都在几十毫秒内
   * 回 `Err: user cancelled MCP tool call`(MCP server 跑在沙箱外,需要批准,而 exec
   * 模式下没人能批)。实测排除过的:`approval_policy` 四个取值都不行、
   * `mcp_servers.<name>.default_tools_approval_mode="auto"` 不行、
   * `sandbox_workspace_write.network_access=true` 也不行 —— **只有 danger-full-access 能过**
   * (同一条 loop_status,在它下面真的打到了我们的 MCP server)。
   *
   * 所以这条要显式声明出来,让上层在**开跑之前**就拦住并说清楚。
   * 绝不自动替用户升到这一档 —— 那是背着人把沙箱关了。
   */
  mcpNeedsPermission: "bypassPermissions",
  mcpNeedsWhy: "codex 在 workspace-write 沙箱下会把 MCP 工具调用直接判为" +
    "「user cancelled」（MCP server 在沙箱外、需要批准，而 exec 模式没人能批）。" +
    "实测 approval_policy / default_tools_approval_mode / network_access 都改不动这一点，" +
    "只有 danger-full-access 能过。",
  buildArgs: function (o) {
    // `-` = 提示词从 stdin 读(和 claude 一样不进 argv)
    const args = ["exec", "--json", "--skip-git-repo-check",
      "-s", o.permission || "workspace-write"];
    // ★ 监控台地址必须显式注进去。**codex 不把父进程的环境变量传给 MCP server** ——
    //   claude 传,所以这条一直没暴露。实测后果:codex 起的 MCP server 收不到
    //   CODE_FORGE_URL,退回「自己拉一个监控台」,于是它老老实实调了 loop_begin,
    //   事件却全写进了另一个没人看的监控台 —— 发起这次 Run 的那个台子上一条都没有,
    //   看起来就像「agent 根本没调协议」。
    //   codex 的 -c 能改 MCP server 的 env(实测 `codex mcp get` 里看得到)。
    if (o.consoleUrl) {
      args.push("-c", 'mcp_servers.code-forge.env={CODE_FORGE_URL="' + o.consoleUrl + '"}');
    }
    // ★ 还要放行审批。codex 里 MCP 工具默认 `default_tools_approval_mode = "prompt"`,
    //   而 exec 模式下没人能点确认 —— 实测结果是每次调用都直接
    //   `Err: user cancelled MCP tool call`(50ms 内返回)。表现极具迷惑性:agent
    //   **确实按协议调了 loop_begin**、参数也完全正确,但监控台上一条事件都没有,
    //   它最后还会好心告诉你「该 MCP 调用在当前环境里被取消了」。
    //   跟 claude 那边 --allowedTools 预先放行是同一件事、同一个理由。
    //   ⚠ 只放行 **code-forge 这一个 server**:这五个工具只往本地日志写,
    //   loop_gate 跑的是**你自己填的那条命令**。别的 MCP server 一律不碰。
    args.push("-c", 'mcp_servers.code-forge.default_tools_approval_mode="auto"');
    if (o.model) args.push("-m", o.model);
    if (o.cwd) args.push("-C", o.cwd);
    args.push("-");
    return args;
  },
  mcp: {
    kind: "cli",
    add: function (name, cmd) { return ["mcp", "add", name, "--"].concat(cmd); },
    remove: function (name) { return ["mcp", "remove", name]; },
    // 同 claude:读文件,别起 CLI(codex mcp list 也要 ~390ms,而它就写在这个文件里)。
    // codex 把 server 落成 TOML 的一张表:[mcp_servers.code-forge] —— 带连字符的裸键
    // 合法,但也允许写成 ["code-forge"],两种都认。读不着回 null(=查不出来)。
    registered: function (name) {
      const f = path.join(os.homedir(), ".codex", "config.toml");
      let raw = "";
      try { raw = fs.readFileSync(f, "utf8"); } catch (_) { return null; }
      const esc = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp("^\\s*\\[mcp_servers\\.\"?" + esc + "\"?\\]", "m").test(raw);
    }
  },
  parse: function (m) {
    if (!m || typeof m !== "object" || !m.type) return null;
    if (m.type === "thread.started") return { log: "codex 线程 " + String(m.thread_id || "").slice(0, 8) };
    if (m.type === "error" || m.type === "turn.failed") {
      return { log: "✗ " + String((m.error && m.error.message) || m.message || "出错").split("\n")[0].slice(0, 200) };
    }
    if (m.type === "item.completed" && m.item) {
      const it = m.item;
      // MCP 调用要显示**具体是哪个工具**、以及失败了没有。只打「mcp_tool_call」的话,
      // 「它调了 loop_begin 但被宿主拦下了」这件事在界面上完全看不出来 ——
      // 而那恰恰是接一个新宿主时最需要看见的一行。
      const isMcp = it.type === "mcp_tool_call";
      const failed = it.status === "failed" || !!it.error;
      const name = isMcp ? (it.tool || "mcp_tool_call") : it.type;
      const label = it.type === "agent_message" ? "· " + String(it.text || "").split("\n")[0]
        : (failed ? "✗ " : "→ ") + name +
          (failed && it.error && it.error.message ? "：" + String(it.error.message).slice(0, 120) : "");
      // 工具动作:codex 把它们表达成 item 类型(command_execution / file_change /
      // mcp_tool_call / …)。原样用 item.type 当工具名 —— 不认识的类型也不会丢掉。
      const isTool = it.type !== "agent_message" && it.type !== "reasoning";
      return {
        log: label.slice(0, 220),
        // codex 没有单独的「最终答复」事件 —— 最后那条 agent_message 就是。
        // 驱动方留最后一条即可。
        text: it.type === "agent_message" && it.text ? String(it.text) : null,
        records: isTool ? [{
          parent: null, model: null, key: null,
          // 失败的调用单独标出来。算成成功的一次会让「它到底干成了什么」失真。
          tools: [{ id: it.id || null, name: name + (failed ? "(失败)" : ""),
            subagent: null, description: "" }],
          usage: null
        }] : null
      };
    }
    if (m.type === "turn.completed") {
      const u = m.usage || {};
      return {
        log: "✓ 一轮完成（in " + (u.input_tokens || 0) + " / out " + (u.output_tokens || 0) + "）",
        records: [{
          parent: null, model: null,
          // 每个 turn.completed 只来一次,没有重复报的问题 —— 没有去重键就按到达顺序计
          key: null,
          tools: [],
          usage: {
            in: u.input_tokens || 0, out: u.output_tokens || 0,
            cacheRead: u.cached_input_tokens || 0, cacheWrite: 0,
            // codex 的 reasoning **包含在** output_tokens 里(实测 out=47、reasoning=39),
            // 跟 claude 正好相反(那边逐条 out 不含 thinking)。所以这里不另外加。
            reasoning: u.reasoning_output_tokens || 0
          }
        }]
      };
    }
    return null;
  }
};

/* ================================================================
 * 下面这些**没有实测**（这台机器上没装）。参数按各家公开的约定写,
 * doctor 会把「未实测」原样显示出来。不对就用 ~/.code-forge/agents.json 覆盖,
 * 或者告诉我们改这里。
 * ================================================================ */
const unverified = [
  {
    id: "opencode", label: "opencode", bin: "opencode", verified: false,
    subagents: false, cost: false, versionArgs: ["--version"], promptVia: "arg",
    perms: { auto: null, acceptEdits: null, bypassPermissions: null },
    // promptVia:"arg" —— 提示词不走 stdin,得由调用方拼进 argv 的最后一位(见 perrole.js)
    buildArgs: function (o) {
      const args = o.model ? ["run", "-m", o.model] : ["run"];
      if (typeof o.prompt === "string") args.push(o.prompt);
      return args;
    },
    mcp: { kind: "json", file: path.join(os.homedir(), ".config", "opencode", "opencode.json"),
      key: "mcp", entry: function (cmd) { return { type: "local", command: cmd, enabled: true }; } },
    parse: null   // 输出格式没实测 → 不假装能解。用量会如实显示「未上报」
  },
  {
    id: "gemini", label: "Gemini CLI", bin: "gemini", verified: false,
    subagents: false, cost: false, versionArgs: ["--version"], promptVia: "stdin",
    perms: { auto: null, acceptEdits: null, bypassPermissions: "--yolo" },
    buildArgs: function (o) {
      const args = ["-p"];
      if (o.model) { args.push("-m", o.model); }
      if (o.permission === "--yolo") args.push("--yolo");
      return args;
    },
    mcp: { kind: "json", file: path.join(os.homedir(), ".gemini", "settings.json"),
      key: "mcpServers", entry: function (cmd) { return { command: cmd[0], args: cmd.slice(1) }; } },
    parse: null
  },
  {
    id: "cursor-agent", label: "Cursor Agent", bin: "cursor-agent", verified: false,
    subagents: false, cost: false, versionArgs: ["--version"], promptVia: "arg",
    perms: { auto: null, acceptEdits: null, bypassPermissions: "--force" },
    // promptVia:"arg" —— 同上,提示词得由调用方拼进 argv 的最后一位
    buildArgs: function (o) {
      const args = ["-p", "--output-format", "stream-json"];
      if (o.model) args.push("-m", o.model);
      if (typeof o.prompt === "string") args.push(o.prompt);
      return args;
    },
    mcp: { kind: "json", file: path.join(os.homedir(), ".cursor", "mcp.json"),
      key: "mcpServers", entry: function (cmd) { return { command: cmd[0], args: cmd.slice(1) }; } },
    parse: null
  }
];

/* ================================================================
 * 模型发现 + 逐角色分配
 *
 * 两条硬要求(来自用户,不是我推的):
 *   ① **有多个模型就默认用多个模型** —— 不是开关,是默认。同一个模型自己跟自己唱反调,
 *      反驳强度明显偏软,这是这个项目存在的理由之一。
 *   ② **只有一个模型时,各角色仍然不许同会话** —— 同模型可以,同上下文不行。
 *      一个会话里「先当实现者再当反驳者」等于让它复核自己刚说过的话。
 *
 * 实现方式按宿主能力选(见 sessionMode):能派子 agent 的用子 agent(各自独立上下文),
 * 不能派的就一个角色一个进程。**两条路都满足「独立会话」。**
 * ================================================================ */

/**
 * 「这个模型试过、跑不了」的黑名单。
 *
 * ★ 为什么非要有:模型清单**不等于能用的清单**。实测两种打脸方式:
 *   ① `~/.codex/models_cache.json` 是 `client_version 0.146.0` 写的,而本机 CLI 是
 *      0.130.0 —— 它列的 `gpt-5.6-terra` 一跑就是
 *      `400 The 'gpt-5.6-terra' model requires a newer version of Codex`。
 *   ② config.toml 里配着 `gpt-5.6-sol`,而这个账号用不了:
 *      `not supported when using Codex with a ChatGPT account`。
 * 两种都无法从清单本身看出来。所以做法是**从失败里学**:被拒一次就记下来,
 * 换下一个候选重试,并且**持久化** —— 下次不再撞同一堵墙。
 * 猜不出来的事就别猜,让它自己告诉我们。
 */
const UNUSABLE_FILE = path.join(os.homedir(), ".code-forge", "unusable-models.json");

function unusableModels(agentId) {
  try {
    const j = JSON.parse(fs.readFileSync(UNUSABLE_FILE, "utf8"));
    return new Set((j[agentId] || []).map(function (x) { return x.model || x; }));
  } catch (_) { return new Set(); }
}

function markModelUnusable(agentId, model, why) {
  if (!agentId || !model) return;
  let j = {};
  try { j = JSON.parse(fs.readFileSync(UNUSABLE_FILE, "utf8")); } catch (_) {}
  j[agentId] = (j[agentId] || []).filter(function (x) { return (x.model || x) !== model; });
  j[agentId].push({ model: model, why: String(why || "").slice(0, 300) });
  try {
    fs.mkdirSync(path.dirname(UNUSABLE_FILE), { recursive: true });
    fs.writeFileSync(UNUSABLE_FILE, JSON.stringify(j, null, 2) + "\n", "utf8");
  } catch (_) { /* 记不下只是下次会再撞一次,不该让它拦住这一次运行 */ }
}

/** 宿主吐出来的错像不像「这个模型不能用」。像就该换一个重试,而不是当成回环失败。 */
function looksLikeModelRejected(text) {
  const s = String(text || "");
  return /requires a newer version|not supported when using|model[^\n]{0,40}(not (found|available|supported)|unavailable)|unknown model|invalid[_ ]model/i.test(s);
}

/** codex 的模型清单:它自己缓存在 ~/.codex/models_cache.json 里(实测)。 */
function codexModels() {
  try {
    const f = path.join(os.homedir(), ".codex", "models_cache.json");
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    return (j.models || [])
      // codex-auto-review 是它内部的审批复核模型,不是给人当角色用的
      .filter(function (m) { return m.slug && m.slug !== "codex-auto-review"; })
      .map(function (m) {
        const d = String(m.description || "") + " " + String(m.display_name || "");
        return {
          id: m.slug,
          // 「谁更强」只能按它自己的描述判 —— 这是启发式,所以要能被 --role 覆盖,
          // 而且实际分配必须打出来让人看见。
          strong: /frontier|complex|greater reasoning/i.test(d),
          weak: /small|mini|affordable|simpler/i.test(d)
        };
      });
  } catch (_) { return []; }
}

/**
 * claude 的模型是别名(opus/sonnet/haiku/fable),没有可查的清单接口 ——
 * 这几个是这个仓库一直在用的那几个(agents/forge-*.md 里就写着)。
 */
function claudeModels() {
  return [
    { id: "opus", strong: true, weak: false },
    { id: "sonnet", strong: false, weak: false },
    { id: "haiku", strong: false, weak: true },
    { id: "fable", strong: false, weak: false }
  ];
}

/** 这个宿主怎么给每个角色开独立会话 */
function sessionMode(adapter) {
  return adapter && adapter.subagents ? "subagent" : "process";
}

/**
 * 给每个角色分一个模型。返回新的 roles 数组(不改原对象)。
 *
 * 分配规则,按优先级:
 *   1. 角色自己写死了 model 的,照它的(用户显式指定 > 我们的启发式)。
 *   2. **反驳者优先拿最强的那个** —— 一个软反驳者等于没有反驳者,这是这里最该避免的失败。
 *   3. 其余角色依次拿剩下的,尽量不重复。
 *   4. 模型比角色少就循环用,但**保证相邻角色不同**(实在只有一个就都一样,
 *      此时靠「独立会话」保证它们不是同一个人)。
 */
function assignModels(adapter, roles, opts) {
  opts = opts || {};
  // 试过跑不了的直接踢掉 —— 清单说有 ≠ 真能用(见 UNUSABLE_FILE 上面那段)
  const bad = unusableModels(adapter && adapter.id);
  const excl = new Set((opts.exclude || []).concat(Array.from(bad)));
  const list = (typeof (adapter && adapter.models) === "function" ? adapter.models() : [])
    .filter(function (m) { return !excl.has(m.id); });
  const rs = (roles || []).map(function (r) { return Object.assign({}, r); });
  if (!rs.length) return rs;

  // 已经被显式指定的不动
  const free = rs.filter(function (r) { return !r.model; });
  if (!free.length || !list.length) {
    return rs.map(function (r) {
      return Object.assign(r, { modelSource: r.model ? "显式指定" : "宿主默认" });
    });
  }

  const strong = list.filter(function (m) { return m.strong; });
  const mid = list.filter(function (m) { return !m.strong && !m.weak; });
  const weak = list.filter(function (m) { return m.weak; });
  // 强 → 中 → 弱。反驳者排在最前,所以它拿到最强的那个。
  const pool = strong.concat(mid, weak).map(function (m) { return m.id; });

  // 拿强模型的优先级:反驳者 → 实现者 → 复核者。
  //   反驳者最先 —— 软反驳者等于没有反驳者,是这里最该避免的失败。
  //   实现者紧跟 —— 它才是真正要写代码的那个。把最弱的模型给它是本末倒置(改过一次)。
  //   复核者最后 —— 它只在判绿之后看一眼「有没有把判据糊弄过去」。
  const order = free.slice().sort(function (a, b) {
    const w = function (r) { return r.kind === "attack" ? 0 : r.kind === "audit" ? 2 : 1; };
    return w(a) - w(b);
  });
  order.forEach(function (r, i) {
    // 模型不够时**不循环回头** —— 循环会让优先级倒挂:实测只剩 2 个模型时
    // 实现者拿到弱的、而排在它后面的复核者又拿回了强的。改成「不够就一直用最后那个」,
    // 保证「优先级高的角色不会比优先级低的拿到更差的模型」。
    r.model = pool[Math.min(i, pool.length - 1)];
    r.modelSource = pool.length >= order.length
      ? "自动（多模型）"
      : "自动（只有 " + pool.length + " 个模型可用，靠后的角色共用同一个）";
  });
  rs.forEach(function (r) { if (!r.modelSource) r.modelSource = "显式指定"; });

  // 只有一个模型时说清楚:靠独立会话区分,不是靠模型
  if (pool.length === 1) {
    rs.forEach(function (r) { r.modelSource = "只有一个模型（各角色仍是独立会话）"; });
  }
  return rs;
}

/* ---------------- 用户覆盖 ---------------- */
const OVERRIDE_FILE = process.env.CODE_FORGE_AGENTS ||
  path.join(os.homedir(), ".code-forge", "agents.json");

/**
 * 读用户自己的适配器。形状与上面一样,但**只能是数据**(JSON 里放不下函数),
 * 所以 buildArgs 用一个模板数组表达:`["exec","--json","-m","{model}","-"]`,
 * `{model}` / `{cwd}` / `{permission}` 会被替换;值为空时**整个参数连同它前面那个
 * 开关一起去掉** —— 否则会传一个 `-m` 后面跟着下一个开关,起不来还看不出为什么。
 */
function loadOverrides() {
  let raw;
  try { raw = fs.readFileSync(OVERRIDE_FILE, "utf8"); } catch (_) { return []; }
  let list;
  try { list = JSON.parse(raw); } catch (e) {
    // 覆盖文件坏了要吼一声。静默忽略 = 用户改了半天发现「没生效」
    console.error("[code-forge] " + OVERRIDE_FILE + " 解析失败，已忽略：" + e.message);
    return [];
  }
  if (!Array.isArray(list)) list = [list];
  return list.filter(function (a) { return a && a.id && a.bin; }).map(function (a) {
    const tpl = Array.isArray(a.args) ? a.args : [];
    return Object.assign({
      label: a.id, verified: false, subagents: false, cost: false,
      versionArgs: ["--version"], promptVia: a.promptVia || "stdin",
      perms: a.perms || { auto: null, acceptEdits: null, bypassPermissions: null },
      parse: null, mcp: a.mcp || null, source: OVERRIDE_FILE
    }, a, {
      buildArgs: function (o) { return fillTemplate(tpl, o); }
    });
  });
}

function fillTemplate(tpl, o) {
  const vals = { model: o.model || "", cwd: o.cwd || "", permission: o.permission || "" };
  const out = [];
  for (let i = 0; i < tpl.length; i++) {
    const t = String(tpl[i]);
    const m = /^\{(\w+)\}$/.exec(t);
    if (m) {
      const v = vals[m[1]];
      if (!v) {
        // 空值:把它连同前面那个开关一起丢掉(`-m` `{model}` → 两个都不要)
        if (out.length && /^-/.test(out[out.length - 1])) out.pop();
        continue;
      }
      out.push(v);
      continue;
    }
    out.push(t.replace(/\{(\w+)\}/g, function (_, k) { return vals[k] || ""; }));
  }
  return out;
}

/* ---------------- 对外 ---------------- */
function all() {
  const builtin = [claude, codex].concat(unverified);
  const over = loadOverrides();
  const byId = new Map();
  builtin.forEach(function (a) { byId.set(a.id, a); });
  // 用户覆盖同 id 的内置项:整条换掉(部分合并会得到一个两边都不像的东西)
  over.forEach(function (a) { byId.set(a.id, a); });
  return Array.from(byId.values());
}

function get(id) {
  if (!id) return null;
  return all().filter(function (a) { return a.id === id; })[0] || null;
}

/** 统一三档权限 → 这个宿主自己的说法。它没有对应档位就回 null(调用方别传这个参数)。 */
function permissionFor(adapter, mode) {
  if (!adapter || !adapter.perms) return null;
  return adapter.perms[mode] || adapter.perms.auto || null;
}

/**
 * 老的 CODE_FORGE_AGENT_CLI 还认 —— 它是「命令 + 前置参数」,没有解析能力,
 * 但至少能把进程起起来。把它包成一个 id 为 `custom` 的适配器。
 */
function fromEnv() {
  const custom = (process.env.CODE_FORGE_AGENT_CLI || "").trim();
  if (!custom) return null;
  const parts = custom.split(/\s+/);
  return {
    id: "custom", label: "CODE_FORGE_AGENT_CLI（" + custom + "）",
    bin: parts[0], verified: false, subagents: false, cost: false,
    versionArgs: ["--version"], promptVia: "stdin",
    perms: { auto: null, acceptEdits: null, bypassPermissions: null },
    buildArgs: function () { return parts.slice(1); },
    parse: null, mcp: null, source: "CODE_FORGE_AGENT_CLI"
  };
}

/**
 * 挑一个能用的宿主:指定了就验证它(装没装),没指定就用第一个装了的。
 * 指定了但不存在/没装 → **报错,不默默换一个** —— 用户指定它是有理由的。
 * (原在 agentrun.js;执行路线删了,评审判据 judge.js 与 loop_agent 还要用它。)
 */
function pickInstalled(want) {
  const cli = require("./agentcli.js");
  if (want) {
    const a = get(want);
    if (!a) {
      return { error: "不认识的宿主：" + want + "（自定义的写进 " + OVERRIDE_FILE + "）" };
    }
    if (!cli.which(a.bin)) return { error: a.label + " 没装（PATH 里找不到 " + a.bin + "）" };
    return { adapter: a };
  }
  const found = all().filter(function (a) { return cli.which(a.bin); })[0];
  return found ? { adapter: found }
    : { error: "一个 coding agent CLI 都没找到（claude / codex / …）" };
}

module.exports = {
  all: all, get: get, permissionFor: permissionFor, fromEnv: fromEnv,
  fillTemplate: fillTemplate, OVERRIDE_FILE: OVERRIDE_FILE,
  assignModels: assignModels, sessionMode: sessionMode,
  unusableModels: unusableModels, pickInstalled: pickInstalled, markModelUnusable: markModelUnusable,
  looksLikeModelRejected: looksLikeModelRejected, UNUSABLE_FILE: UNUSABLE_FILE,
  claude: claude, codex: codex
};
