# code-forge

**对抗回环插件**:一个角色提方案、一个角色专门推翻它、由**代码**跑判据裁定,不达标就带着失败信息再来一轮 ——
全过程实时直播到本地监控台网页。

**执行者是你的 coding agent 自己**(Claude Code / Codex / opencode …)。它已经有模型访问权,
所以**不需要配任何 API key**,也不产生额外的模型账单。

仓库:<https://github.com/Z-wwwwww/Code-Forge>（本地目录 `code-forge`,命令与包名同为小写 `code-forge`）。

## 装:一条命令

```
node install.js          # 装（幂等，可反复跑）
node install.js --dry-run   # 只看会动哪些文件，不改任何东西
node install.js --uninstall # 卸
```

装进的都是**受支持的用户级配置**,重开一个 Claude Code 会话即生效:

```
~/.claude/skills/code-forge/SKILL.md   技能（自动触发）
~/.claude/agents/forge-proposer|critic|reviewer.md   三个角色，各绑不同模型
~/.claude/commands/code-forge.md       /code-forge 斜杠命令
MCP: claude mcp add --scope user code-forge
```

它**刻意不动** `~/.claude/plugins/*.json`(插件管理器的内部账本)—— 手改那些会把 `/plugin` 弄坏。
改 `~/.claude.json` 之前会先备份成 `.bak-code-forge`。

**或者走插件那条路**(想让 `/plugin` 管版本时):

```
/plugin marketplace add C:\Projects_GitHub_my\code-forge
/plugin install code-forge@code-forge
```

两条路等价,别同时用(会装两份技能)。其它宿主(Codex / opencode / 任何支持 stdio MCP 的)
见 **`AGENTS.md`**。第一次用时监控台**自动拉起并打开浏览器**。

## 用:两条路

### ① 页面上填完,点 Run

```
code-forge          # 起监控台（第一次用 MCP 时也会自动拉起）
# 浏览器打开 http://localhost:4610/setup
```

在 `/setup` 里填**目标 / 判据命令 / 限制 / 角色 / 权限**,点 **Run** —— 后台起一个
headless Claude Code(`claude -p`)当执行者,用你自己的订阅,**不需要 key**。页面上能看到它
一步步在干什么,监控台里是完整的轮次档案。配置同时存成工作目录下的 `.code-forge.json`,下次可复用。

不想让它自动跑?点 **只生成指令**,把那段话复制到你自己的 Claude Code 会话里粘上 —— 权限还是你现场点。

⚠ **权限那一栏要按仓库可信度选**:`auto`(推荐,由 Claude Code 的安全判定放行常规操作)/
`acceptEdits`(自动接受文件编辑,但 Bash 仍需批准 —— 无人值守时会卡住)/
`bypassPermissions`(**危险**:能改任何文件、跑任何命令,没人拦)。
回环自己的五个工具与只读工具是**预先精确放行**的,其余一律按你选的模式走。

### ② 在聊天里说一句

```
/code-forge 把 payments/webhook 的重复回调修掉，pytest 全绿且覆盖率 ≥ 80%
```

或者直接说人话:「对抗一下」「让它俩吵一架直到测试通过」「盯着改到绿」—— 技能的触发词覆盖了这些。

它会先跟你确认**判据命令**(一条现在就能跑的命令),然后:

```
loop_begin  → 开局，浏览器弹出监控台
每一轮:  提议者做事 → loop_say
        反驳者找反例 → loop_say
        loop_gate()  ← 代码跑判据,裁定
          met      → 收工
          continue → 带着失败输出进下一轮
          停       → 如实报是七种原因里的哪一条
```

## 多角色多模型（Claude Code 内,零 key）

同一个模型自己跟自己唱反调,反驳强度明显偏软。所以三个角色**派给不同模型的子 agent**,
用的是宿主自己的模型访问权:

| 角色 | 子 agent | 模型 | 工具 |
|---|---|---|---|
| 提议者 | `forge-proposer` | `sonnet` | 读写 + Bash |
| 反驳者 | `forge-critic` | `opus` | **只有 Read/Grep/Glob** |
| 复核者 | `forge-reviewer` | `sonnet` | 只读 |

**反驳者没有写权限,这是工具层面的硬约束** —— 一个能顺手把问题抹平的反驳者等于没有反驳者。
上一版这条只写在提示词里,现在结构上就做不到了。

想换模型就改 `~/.claude/agents/forge-*.md` 里的 `model:` 那一行(`opus` / `sonnet` / `haiku` / `fable`)。
想要更强的反驳,同一轮可以派多个 `forge-critic`、各给一个攻击面(并发 / 边界 / 入口覆盖)。

**跨厂商同场**(gpt / gemini 一起上)才需要 API key —— 那是下面的可选本地模式。

## 为什么值得多这一层

一个 agent 自己迭代时,**没有人能阻止它宣布成功**。这个插件把两件事从模型手里拿走了:

| 拿走的 | 交给谁 | 强制方式 |
|---|---|---|
| 「达标了吗」 | `loop_gate`:跑你给的命令,看退出码 +(可选)一个指标数 | `loop_end(goal_met)` 在 gate 没真判过之前**直接被拒**,并告诉它去调 gate |
| 「还能不能继续」 | 代码:轮数 / 时限 / 连续无进展 | `loop_gate` 回 `continue:false`,技能里明写必须停手 |

配套的三条纪律写在 `skills/code-forge/SKILL.md` 里(**提示词先禁,代码再兜底** —— 只靠代码拒绝
等于让 agent 每次都去撞一次墙):

1. 不许自行宣布达标。
2. **不许为了达标去改判据** —— 不放宽阈值、不注释掉失败用例、不换一条更好过的命令。那是把尺子锯短。
3. 停了要如实说是哪一条原因。「烧完预算」说成「已完成」是这里最不能出的错。

## 停止原因（七种，页头显示真的那一条）

| reason | 含义 | 你下一步该做什么 |
|---|---|---|
| `goal_met` | 判据判过了 | 看复核意见,合了 |
| `budget_rounds` / `budget_time` | 轮数/时限到顶 | 加预算再来,或换个更小的目标 |
| `no_progress` | 指标连续 N 轮不往目标方向走 | 方向错了,别再喂轮次 |
| `gate_broken` | 判据命令跑不起来/超时/正则抓不到数 | **先修判据**,这时的「未达标」不算数据 |
| `stopped` | 你在页面上按了停 | — |
| `abandoned` | agent 自己判断做不下去(detail 里有理由) | 读它的理由 |

## 关于 token

宿主执行时,用量在**你自己的订阅账上**,监控台拿不到 —— 所以页面如实显示
「TOKENS 不可得」「用量不可得（宿主执行）」,**不显示 0**。显示 0 等于宣称这次没花钱,那是假账。
能数的是轮数、发言次数、耗时、判据走势。

想要逐角色 token 明细,就得由本地进程自己发调用 —— 那是下面那个可选模式。

## 可选:本地驱动模式（自带 key）

不想让宿主执行、想给每个角色配不同的模型并逐角色数 token 时用它。这不是默认路径:

```
code-forge            # 起监控台
# 打开 http://localhost:4610/setup-local 配角色（provider + 模型）→ 启动
```

provider:`mock`(零 key,先跑通)/ `anthropic` / `openai` / `deepseek` / `qwen` / `openrouter` / `ollama`,
其它网关填 base URL。key 从环境变量读(`ANTHROPIC_API_KEY` 等),**不经过页面、不落盘**。
未登记的 provider 名**必须自带 baseUrl** —— 否则一个拼错的名字会把正文发到别人家去。

## 自测

```
node test-host.js    # 42 项：宿主驱动（默认模式）+ MCP 全链路 + 插件包装
node test.js         # 29 项：本地驱动模式（可选）
```

零 key、不联网、不发一次模型调用。钉住的都是**会静默出错**的那几条:自称达标必须被拒、
判据坏了不许报成未达标、宿主执行时不许写 0 用量、停止原因必须是真的那一条。

## 目录

```
install.js                         一条命令接入 Claude Code（幂等 / --dry-run / --uninstall）
agentrun.js                        页面点 Run：拼提示词 + 起 headless claude -p + 解 stream-json
skills/code-forge/SKILL.md   技能：协议 + 三条纪律（给 agent 读的那份）
agents/forge-proposer|critic|reviewer.md  三个角色，各绑不同模型与工具集
commands/code-forge.toml     /code-forge 斜杠命令（插件版）
.claude-plugin/                    插件与 marketplace 清单（自带 MCP 声明）
AGENTS.md                          Codex / opencode / 纯 HTTP 的接法

mcp.js        MCP server（stdio）：五个工具 + 监控台自动拉起
hostrun.js    宿主驱动的状态机：begin/say/gate/end，以及那条拒绝
gate.js       判据（全代码）：命令退出码 + 可选指标区间
server.js     HTTP + SSE + append-only 日志；--mcp 时转 stdio
index.html    监控台（reducer + 渲染）
setup.html    Run 页（填完点 Run，宿主执行）
setup-local.html  自带 key 那套的配置页（可选模式）

loop.js       本地驱动（可选）：自带 key 时的回环驱动
providers.js  本地驱动（可选）：mock / anthropic / OpenAI 兼容各家
demo.js       示例回环 → 事件流（code-forge --demo --live）
design/       Claude Design 原始设计稿（provenance，别直接改）
run.jsonl     运行产物（已 gitignore）
```

## 接口（不装 MCP 也能用）

| 接口 | 用途 |
|---|---|
| `POST /host/begin` `\|` `/host/say` `\|` `/host/gate` `\|` `/host/end`, `GET /host/status` | 宿主驱动协议 |
| `GET /` `/setup` `/setup-local` | 监控台 / Run 页 / 自带 key 的配置页 |
| `GET /events?since=N` | SSE;浏览器重连自动带 `Last-Event-ID` 续传 |
| `POST /events` | 直接写事件(任何工具链都能往里报) |
| `POST /agent/run` `/agent/stop` `/agent/prompt`, `GET /agent/status` | 页面点 Run：起/停 headless agent、只拼提示词、看进度 |
| `POST /runs` `/runs/stop` | 本地驱动模式的起/停 |
| `GET /health` | 事件数、客户端数、回环状态 |

⚠ Windows 终端里直接写中文会按 GBK 发出去 —— 存成 UTF-8 文件再 `--data-binary @f.json`。
(判据命令的**输出**不受此限:GBK 输出会被自动认出来正确解码,中文 cmd 的「不是内部或外部命令」
也因此能被识别成 `gate_broken` 而不是「测试没过」。)

## 事件类型

| `t` | 字段 |
|---|---|
| `run.start` | `session` `repo` `branch` `client` `mode` `goal` `budget` |
| `role.add` | `id` `name` `model` `color` `duty` |
| `round.start` / `round.end` | `n` `title` `meta` / `n` `winner` `winnerRole` `score` |
| `event` | `round` `role` `kind` `ts` `dur` `tok` `summary` `body` `targets[]` `tool{}` `diff{}` `meta{}` |
| `conflict` | `round` `sev` `topic` `a` `aClaim` `b` `bClaim` `resolution` `res` |
| `patch` | `round` `file` `add` `del` `by` `note` `state` `st` `tests` |
| `run.streaming` / `run.end` | `role` `text` / `reason` `detail` `rounds` `seconds` |

`kind` ∈ `propose` `attack` `defend` `verdict` `patch` `test` `audit` `route`。
认不出的 `t` 不会被静默吞掉:计数并在页头显示「未知 N」。

## 还没做的

- **补丁台账靠 agent 自己报**(`loop_say` 带 `diff`)。插件不去猜谁改了哪个文件 —— 凭空生成一条 = 编造。
- **分歧点在宿主模式下也靠 agent 报**(`POST /events` 一条 `conflict`);本地驱动模式会自动从
  「提议 → 反驳」这一对里生成,两侧原话都截自真实事件。
- **一次只跑一个回环**(第二次 begin → 409)。两个回环写同一条流,谁说的话就分不清了。
- **一份日志按顺序装多次回环**:页面在遇到新 `run.start` 时切到最新那次(硬盘历史一条不丢)。
