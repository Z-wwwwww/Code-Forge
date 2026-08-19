# code-forge — 给 Codex / opencode / 其它 agent 的接入说明

Claude Code 走插件(`/plugin marketplace add` + `/plugin install`,技能会自动加载)。
其它宿主目前没有统一的技能格式,所以这里给两样东西:**怎么把 MCP 接上**、**照什么协议走**。

## 0. 哪些通用，哪些只认 Claude Code

先把这条说清楚,免得踩空:

| 部件 | 通用吗 | 说明 |
|---|---|---|
| MCP 协议 `loop_begin / loop_say / loop_gate / loop_status / loop_end` | ✅ | 任何支持 stdio MCP 的宿主 |
| 判据(`gate.js`)、预算、以及那条「没判过不许说达标」的拒绝(`hostrun.js`) | ✅ | 纯代码,与宿主无关 |
| 监控台、事件流、`code-forge`(直播) / `usage` | ✅ | 只读事件流,不关心谁在执行 |
| **逐 agent 用量**(`usage` 事件 / `GET /usage`) | ⚠ | **事件格式通用,采集看适配器**。记账(去重/归属/分轮)在 `usage.js`,解析在各自的 `adapters.parse`。粒度也各不相同:claude 摊得到子 agent,codex 只到「执行者」一行且不报成本。没有适配器的宿主自己 `POST /events` 一条 `usage`(字段见下)。你不报,页面就如实显示「未上报」——**不要为了让表好看而报估算值** |
| 纯 HTTP `/host/*` | ✅ | 不装 MCP 也能驱动 |
| `skills/code-forge/SKILL.md` 的协议与三条纪律 | ✅ | 是文本,贴进任何 agent 的 rules/AGENTS.md 都成立 |
| **判据命令「候选式确认」** | ✅ | 写在技能里 —— 由**宿主自己**看仓库、自己提 2~4 条候选 |
| `agents/forge-*.md` 三个角色(各绑模型与工具集) | ❌ | Claude Code 的 subagent 格式 |
| `/code-forge` 斜杠命令、`install.js`、插件清单 | ❌ | Claude Code 的目录约定 |
| **`loop_agent` 把角色派成独立进程**(评审判据的评审者也走这条) | ⚠️ | 由 `adapters.js` 里的宿主适配器决定。**claude 与 codex 实测过**;opencode / gemini / cursor-agent 按公开约定写了但**没实测**;别的 CLI 自己写 `~/.code-forge/agents.json`(见第 4 节)。`npx github:Z-wwwwww/Code-Forge doctor` 把每一项的实测状态原样显示出来 |
| `/setup` 页上「让协调者建议判据」 | ⚠️ | 同上走本地 `claude -p`;**失败自动退回零调用的文件启发式**(pytest.ini、package.json 的 scripts、Cargo.toml…),那半是通用的。⚠ 退回来的那批**与目标无关**,页面与 tui 都按来源分拨、只有贴题候选才自动填 —— 把猜的呈现成「按目标出的」等于拿一条不相干的命令当 judge |

一句话:**回环本身、判定、留痕、直播都是通用的;「独立进程角色」和「数用量」看适配器**。执行发生在你的 coding agent 会话里(/code-forge 或直接调 loop_* 工具)。
先跑 `npx github:Z-wwwwww/Code-Forge doctor` —— 它会告诉你这台机器上 MCP 接没接好、哪个 agent 里能用,
哪个只能走「你自己驱动」那条路(接上 MCP、照下面的协议走,回环效果完全一样)。

## 0.5 先跑 doctor

```
npx github:Z-wwwwww/Code-Forge doctor
```

它一次回答四个问题:装了哪些 agent CLI、MCP 注册没有、角色能不能被派成独立进程
直接开跑、用量能解到多细。**「未实测」那一栏要认真看** —— 标未实测的适配器参数是按公开
约定写的、没在真机上验过,起不来先怀疑它,别怀疑自己的环境。

`code-forge install` 会给所有**探测到的**宿主注册 MCP(只碰装了的),所以多数情况下
装完直接就能跑。

## 0.55 别照着「它有没有子 agent」下结论

接一个新宿主时容易犯两个错，我两个都犯过：

**① 想当然认为它没有子 agent。** codex 有，而且比 claude 的更全 ——
`spawn_agent` / `send_input` / `resume_agent` / `wait_agent` / `close_agent`，
`spawn_agent` 能覆盖 `model` 与 `reasoning_effort`，还能 `fork_context`（claude 永远不共享）。
**查法很简单**：让它自己列工具 —— `<cli> exec` 跑一句「把你可用的工具名全部列出来」。

**② 把「有子 agent」当成「该走协调者那条路」。** 这是两件事。codex 有子 agent，但默认
仍走一角色一进程，因为协调者那条路在它上面要开 `danger-full-access`，而且实测更贵。
`adapters.js` 里因此分成两个字段：`subagents`（能力）与 `preferPerRole`（策略）。

还有一个跟我们相关的细节：**它有子 agent ≠ 它认得我们那几个角色名。**
`forge-proposer` / `forge-critic` 是 Claude Code 的 `.md` 格式，codex 的类型是
`default` / `explorer` / `worker`。所以内联协议时会把 SKILL.md 里那张 `forge-*` 表**剥掉**，
只保留通用原则，再告诉它「用你自己的机制给每个角色派一个，并给不同模型」。

## 0.6 宿主会不会拦住 MCP 调用（实测踩过两次）

自动驱动一个宿主时,**回环跑不起来的原因往往不在回环这边**,而在宿主的两道关卡上。
两道都会产生同一种迷惑现象:agent **确实按协议调了 `loop_begin`**、参数也完全正确,
而监控台上**一条事件都没有** —— 看起来像协议没被执行。

| 关卡 | 表现 | 怎么过 |
|---|---|---|
| **工具审批** | 调用在几十毫秒内回 `user cancelled MCP tool call`。非交互模式没人能点确认 | claude:`--allowedTools` 预先放行那六个工具<br>codex:`-c mcp_servers.code-forge.default_tools_approval_mode="auto"` |
| **环境变量不透传** | 事件写进了另一个自动拉起的监控台,你盯着的那个是空的 | claude 会把 `CODE_FORGE_URL` 传给它拉起的 MCP server;**codex 不传**,要 `-c mcp_servers.code-forge.env={CODE_FORGE_URL="…"}` |

`adapters.js` 已经替这两家处理了。**接第三家时先查这两条** —— 而且放行只能限定到
`code-forge` 这一个 server,不要整体关掉审批、更不要绕过沙箱。

## 1. 接上 MCP（一次)

命令 `node <本目录>/server.js --mcp`,stdio 传输。零依赖、零 key。

- **Codex**:在 `~/.codex/config.toml` 里加
  ```toml
  [mcp_servers.code-forge]
  command = "node"
  args = ["C:/Projects_GitHub_my/code-forge/server.js", "--mcp"]
  ```
- **opencode**:在 `opencode.json` 的 `mcp` 段里加同样的 command/args(`"type": "local"`)。
- **任何支持 stdio MCP 的宿主**:同上,把 command 与 args 填进它的 MCP 配置。

接上后会多出六个工具:`loop_begin` / `loop_say` / `loop_gate` / `loop_status` / `loop_end` /
`loop_agent`（把角色派成独立进程 —— 给聊天里没有子 agent 的宿主用,真隔离、可指定模型、
反驳者工具层只读;结果自动 loop_say）。
第一次调 `loop_begin` 时监控台会自动拉起并打开浏览器。

## 2. 协议

完整版在 `skills/code-forge/SKILL.md` —— 那份是给 agent 读的,内容与宿主无关,
Codex / opencode 也可以直接把它贴进自己的 rules/AGENTS.md 或让 agent 读一遍。

摘要:

```
loop_begin({session, goal:{command, cwd, metric}, budget, roles})
每一轮: 各角色做事 → 各自 loop_say({role, summary, body, diff?, tool?}) → loop_gate()
  met:true → 已自动收工     continue:true → 带着失败信息进下一轮     continue:false → 停手
```

三条纪律,任何宿主都一样:

1. **达标只有 `loop_gate` 能判。** `loop_end(goal_met)` 在 gate 没真判过之前会被拒绝 ——
   这条拒绝是这个工具存在的理由。
2. **判据不许为了达标而放宽或换掉。** 判据坏了就停下来报,不要注释掉失败用例或调低阈值。
3. **停了要如实说为什么停。** `goal_met` / `budget_rounds` / `budget_time` / `no_progress` /
   `gate_broken` / `stopped` / `abandoned` —— 「烧完预算」说成「已完成」是最不能出的错。

## 4. 让 loop_agent 也能派你的 agent 当角色

上面第 1、2 节走的是「你自己驱动」那条路 —— 完全够用。但如果想让
`loop_agent` 的 `agent` 参数也能**指到你的 CLI**,写一份适配器就行,
不用改我们的代码。

`~/.code-forge/agents.json`（也可以用 `CODE_FORGE_AGENTS` 指到别处）:

```json
[{
  "id": "myagent",
  "label": "My Agent",
  "bin": "myagent",
  "args": ["run", "--model", "{model}", "--cwd", "{cwd}", "-"],
  "promptVia": "stdin",
  "mcp": { "kind": "json", "file": "/home/me/.myagent/config.json", "key": "mcpServers" }
}]
```

- `{model}` / `{cwd}` / `{permission}` 会被替换。**值为空时连同它前面那个开关一起去掉** ——
  否则会传出 `--model --cwd` 这种起不来还看不出原因的参数。
- `promptVia`:`stdin`(默认)或 `arg`。提示词**不进 argv** 是首选 ——
  多行带引号的文本经 shell 会被切碎。
- 同 `id` 会整条覆盖内置的那份(部分合并会得到一个两边都不像的东西)。
- 写完 `npx github:Z-wwwwww/Code-Forge doctor` 里立刻能看到它,标成「未实测」。

**用量解析**这里给不了(JSON 放不下函数),所以那一栏会显示「未上报」。想要用量就自己
`POST /events` 报一条 `usage`(见上一节),或者给 `adapters.js` 提个 `parse`。

只想换个执行者、不在乎这些细节的话,老办法还认:

```
CODE_FORGE_AGENT_CLI="myagent run"
```

它会变成一个 id 为 `custom` 的适配器。⚠ 这条路**没有参数映射也没有输出解析** ——
权限档位、结构化输出这些得你自己在那串命令里写全。

## 3. 不装 MCP 也能用（纯 HTTP）

先 `node server.js` 起监控台,然后打 HTTP:

```
POST /host/begin   {session, goal, budget, roles}
POST /host/say     {role, summary, body, ...}
POST /host/gate    {}                        → { met, value, output, continue, stopReason }
GET  /host/status
POST /host/end     {reason, detail}
GET  /usage                                  → 逐 agent 用量（从事件日志现算）
```

想让自己的用量出现在监控台里,每轮往 `POST /events` 报**增量**:

```json
{"t":"usage","round":2,"role":"反驳者","agent":"critic-1","model":"gpt-5",
 "in":5500,"out":900,"cacheRead":30000,"msgs":5,"tools":{"Read":6,"Grep":3}}
```

收尾可以再报一条 `{"t":"usage","total":true,"costUsd":0.42}` —— **只在你真知道成本时报**。
`role` 用回环角色表里的名字,页面才会并进那一行而不是另开一行。

⚠ Windows 终端里直接写中文会按 GBK 发出去,落库变 `����` —— 存成 UTF-8 文件再 `--data-binary @f.json`。
