# code-forge

**对抗回环插件**:一个角色提方案、一个角色专门推翻它、由**代码**跑判据裁定,不达标就带着失败信息再来一轮 ——
全过程实时直播 —— 在终端里（`code-forge`）或网页监控台。执行只发生在 coding agent 里（`/code-forge`）。

**执行者是你的 coding agent 自己**(Claude Code / Codex / opencode …)。它已经有模型访问权,
所以**不需要配任何 API key**,也不产生额外的模型账单。

仓库:<https://github.com/Z-wwwwww/Code-Forge>（本地目录 `code-forge`,命令与包名同为小写 `code-forge`）。

## 装:一条命令

```
npx github:Z-wwwwww/Code-Forge install     # 不必先 clone
```

或者 clone 下来在目录里跑（想改代码的走这条,改完立刻生效）:

```
node install.js             # 装（幂等，可反复跑）
node install.js --dry-run   # 只看会动哪些文件，不改任何东西
node install.js --uninstall # 卸
```

装完 **PATH 里没有任何新命令** —— 终端不需要认识这个工具（旧版放进去的 `code-forge`
会被顺手清掉）。看过程零命令：直播窗口开跑时自动弹出，网页监控台地址也一并给出。

走 `npx` 时它还会先把运行时**复制**到 `~/.claude/code-forge/` 再注册 MCP —— npx 的缓存目录
过一阵就没了,直接指过去的话注册当时能用、几天后 agent 一调 `loop_begin` 就是「找不到模块」。

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
见 **`AGENTS.md`**。第一次用时监控台自动拉起（聊天开跑默认弹**终端直播**,不弹网页）。

## 用:在 coding agent 里说一句

> **执行只发生在 coding agent 里。**（2026-08 收窄:以前 `code-forge tui` / `go` / 网页 Run
> 会自己拉一个 headless 宿主当执行者 —— 那条路整个删了。它逼你挑宿主、挑模型、管进程,
> 而这些在 coding agent 会话里本来就是现成的,你也不必再多管一份账。）

```
/code-forge 把 payments/webhook 的重复回调修掉，pytest 全绿且覆盖率 ≥ 80%
```

或者直接说人话:「对抗一下」「让它俩吵一架直到测试通过」「盯着改到绿」—— 技能的触发词覆盖了这些。
只打 `/code-forge` 不带目标,它会停下来等你输入目标(不烧额度乱扫仓库)。

开跑前的顺序是铁律:**先配置后确认**(Claude Code 里是 AskUserQuestion 点选;Codex 聊天退回编号列表)。
每一题推荐排第一,一路回车就是全默认 —— 但每一项都有窗口,不会替你悄悄定:

- **判据命令**:带着目标看一眼仓库,给 2~4 条候选让你挑(只提议真实存在的命令)
- **配置卡**:模型分配(推荐组合/全最强/全最省/逐角色挑)、轮数(含不限)、时限、必要时 streak
- **确认卡**(配置卡答完才出):小结 + 就这么开跑？(开跑推荐/再改一项/取消)

两种常用变体,聊天里直接说就行:

- **「修掉查出的 bug,直到连续 3 轮 bug 数为 0」** → `goal.streak: 3`:判据要**连续 3 轮判过**
  才算达标,断一次从头攒;确认期里判过的轮不算零进展(反驳者接着挖才是那几轮的正事)。
  攒到 2/3 时 agent 自称达标照样被拒,拒绝语里带着进度。
- **「不限轮数,跑到干净为止」** → `budget.rounds: 0`:轮数不设顶,但**时限和零进展闸门仍在**
  (烧不完的是轮数,不是钱);执行者会主动跟你确认时限,默认 3600s 对这类目标往往太短。

然后按协议走:

```
loop_begin  → 开局，弹一个终端窗口直播（没有终端模拟器才退回浏览器）
每一轮:  提议者做事 → loop_say
        反驳者找反例 → loop_say
        loop_gate()  ← 代码跑判据,裁定
          met      → 收工
          continue → 带着失败输出进下一轮
          停       → 如实报是那几种原因里真的哪一条
```

角色怎么隔离:Claude Code 里派 forge-proposer / forge-critic / forge-reviewer 三个子 agent
（各绑模型,反驳者工具层只读);Codex 等没有子 agent 的宿主用 `loop_agent` ——
监控台替它把角色派成**独立进程**（可指定模型,反驳者是 OS 沙箱级只读）。

### 终端不需要认识它

PATH 里**没有** `code-forge` 这条命令(旧版装过的,重装时会顺手清掉)。看过程不需要任何命令:

- 开跑时自动弹出**终端直播窗口**:判据走势(`▁▄█ R1 68 → R2 74 → R3 82 ✔`)、角色表、
  每轮点开看做了什么、逐 agent 用量、停止原因。按 `q` 关窗**回环仍在跑**。
- **网页监控台**地址在开跑时一并给出(默认 http://localhost:4610),和终端看同一份事件流,
  逐 agent 用量、每轮明细都在。
- 诊断/更新走 npx(一次性,不进 PATH):`npx github:Z-wwwwww/Code-Forge doctor` / `install`。


## 多模型对抗：默认就开，且每个角色一定是独立会话

两条硬规矩:

1. **有多个模型就默认用多个模型。** 不是开关。同一个模型自己跟自己唱反调,反驳强度
   明显偏软 —— 这是这个项目存在的理由之一。
2. **只有一个模型时,各角色仍然不共用会话。** 同模型可以,同上下文不行:一个会话里
   先当提议者再当反驳者,等于让它复核自己刚说过的话。

怎么保证第 2 条,按宿主能力自动选,你不用管:

| 宿主 | 会话怎么分开 | 备注 |
|---|---|---|
| Claude Code | **子 agent**(各有独立上下文、各绑模型) | 开箱带我们那三个角色定义，默认走这条 |
| Codex CLI | **一个角色一个进程** | 它其实**也有**子 agent（见下），默认仍走进程，理由是实测 |
| 没有子 agent 机制的 | **一个角色一个进程** | 唯一可行的路 |

模型是**自动分**的(从宿主自己报的清单里挑,已剔掉试过跑不了的),分配规则:
**反驳者拿最强的** —— 软反驳者等于没有反驳者;**提议者紧跟** —— 它才是真正要写代码的那个;
复核者最后。

聊天里想换模型就点选:开跑前的确认里选「改模型」,一题一个角色摆候选,
**推荐的排第 1 位**并带一句按角色给的理由(反驳者最强、提议者紧跟、复核者最省)。
点了不存在的模型会**如实说并保持默认**,不静默换一个。
Codex 聊天里的角色经 `loop_agent` 派成独立进程,模型用它的 `model` 参数指定。


### 反驳者的只读是真的

一角色一进程时,反驳者的「不许改文件」由**宿主自己强制**,不是提示词里的一句请求:

- codex → `-s read-only`，**操作系统级沙箱**
- claude → `--allowedTools Read Grep Glob`，写工具一个都不给

### 清单里有 ≠ 真能用（会自我纠正）

实测被打脸两次:`~/.codex/models_cache.json` 是 `client_version 0.146.0` 写的,而本机 CLI
是 `0.130.0` —— 它列的 `gpt-5.6-terra` / `gpt-5.6-luna` 一跑就是
`400 requires a newer version of Codex`;config 里配的 `gpt-5.6-sol` 则是
`not supported when using Codex with a ChatGPT account`。**这两种都无法从清单本身看出来。**

所以不猜:被拒一次就记进 `~/.code-forge/unusable-models.json`、换下一个候选重试,
下次不再撞同一堵墙。这跟「判据没过」是两件事 —— **挑错模型不会被报成回环失败**。

### 两条路的真实区别（不是「有没有共享上下文」）

⚠ 常见误解:以为 claude 的子 agent 之间有共享上下文。**没有。** 实测直接问过子 agent 本人：

> (1) 你能看到派你出来的那个会话之前的对话历史吗？ → **不能**
> (2) 我只有系统配置信息（工作目录、可用工具清单…），没收到别的

它手上只有:自己的 system prompt + **父 agent 显式写给它的那段 prompt** + 自己的工具集;
收工时只交回**一段最终报告**,父 agent 看不到它中间的步骤。用量也印证 —— 同一次回环里
协调者 `cacheRead=478.6k`，两个子 agent 分别只有 `75.9k` / `15.5k`。

所以两条路都是「角色之间无共享上下文」。真正的区别是**谁负责把上下文喂给角色**:

| | claude 子 agent | 一角色一进程 |
|---|---|---|
| 角色间共享上下文 | 无 | 无 |
| 谁转述 | **协调者模型** —— 它读了判据输出，自己决定告诉反驳者什么 | **代码** —— 判据输出原文、上一轮反驳点原文照搬 |
| 转述质量 | 会挑重点，但**有损**；而且它有动机让事情看起来在进展 | 无损但死板，不会挑重点 |
| 谁在编排 | **多出一个协调者模型**（它自己也烧 token，而且上下文逐轮累积） | 代码编排，**零 token** |
| 缓存 | 一个进程内系统提示/工具定义全程复用 | 每个进程各自付一次缓存写入（约 8k/进程） |

第三行值得多说一句:协调者转述时可能把判据里刺眼的失败信息说轻了 —— 而代码拼的时候,
失败输出**原样**进反驳者的提示词,没有中间人。这跟「判定权交给代码」是同一个思路。

### 「协调者转述能省 token」这个直觉是反的（实测）

同一宿主（claude）、同一模型（haiku）、同一任务，两种模式各跑一次：

| | A：协调者转述 | B：per-role |
|---|---|---|
| 缓存读 | **1.30M** | 142.2k |
| 缓存写 | 57.5k | 16.1k |
| 调用次数 | 38 | 5 |
| **成本（CLI 自报）** | **$0.3399** | **$0.0436** |
| 结果 | `budget_rounds`（2 轮都没过） | **`goal_met`**（1 轮就过） |

A 里**协调者一个人 1.13M cacheRead，占全部输入的 87%**。它还自作主张派了 5 个子 agent
（配置只有 2 个角色），自己又跑了 `Bash×5` 和 PowerShell —— 它不只在转述，它在干活，
而这些都记在账上。按轮折算（A 两轮 / B 一轮）仍然约 4 倍。

为什么必然如此:协调者是**多出来的一个模型**，不是省下来的；转述也省不掉子 agent 的
上下文 —— 两条路的反驳者都要自己去读代码，它的大头是**文件内容**，不是对话历史。
协调者的上下文还逐轮累积，越跑越贵；per-role 每轮是平的。

per-role 真正多花的只有「每个进程各自付一次系统提示的缓存写入」（实测约 8~16k/进程）
和进程启动延迟。

⚠ 各一次，agent 行为方差很大，这个倍数别当精确值 —— 但方向与结构原因是稳的。

### 那为什么还留着协调者那条路

**因为统一不了。** 三个理由，第一个是决定性的:

1. **不是每个宿主都有子 agent。** 没有的话，统一走协调者转述就等于「一个会话轮流扮演所有
   角色」—— 直接违反「每个角色必须独立会话」这条硬要求。
2. **聊天里那条路本来就是协调者。** 你在 Claude Code 里打 `/code-forge` 时，**你那个会话
   就是协调者**，它只能派子 agent，没有第二种可能。
3. **协调者能临机应变。** 这一轮觉得该派三个反驳者、各给一个攻击面；发现判据本身有 bug
   就停下来报 `gate_broken`。代码按模板走，不会这样判断。

所以两条都留，按宿主能力自动选（`--per-role` / `--single` 可强制）。

### codex 也有子 agent（而且比 claude 的更全）

这一条我先前写错过 —— 早期版本说「codex exec 没有子 agent」。**错的。** 实测让 codex
自己列工具，它给出一整套 `spawn_agent` / `send_input` / `resume_agent` / `wait_agent` /
`close_agent`，`spawn_agent` 的参数（抄下来的 schema）比 claude 的更全：

| | claude `Agent` | codex `spawn_agent` |
|---|---|---|
| 逐子 agent 指定模型 | ✓ | ✓ `model` |
| 逐子 agent 指定**推理档** | ✗ | ✓ `reasoning_effort` |
| 内置角色类型 | 自己写 `.md` | ✓ `default` / `explorer` / `worker` |
| **共享父上下文** | **永远不共享** | ✓ **可选** `fork_context` |
| 子 agent 可续对话 | ✗ 一次性 | ✓ `send_input` / `resume_agent` |

那 doctor 里 codex 为什么还写「独立进程」？因为**能力和策略是两件事**（我也混过一次）。
codex 默认仍走 per-role，两条理由都是实测：

1. 协调者那条路必须调 `loop_*` MCP 工具，而 codex 在 `workspace-write` 下一律判
   `user cancelled` —— 走它就得开 `danger-full-access`，不值得。
2. 上面那张 A/B 表：协调者 $0.3399 且没过，per-role $0.0436 且过了。

`--single --perm bypassPermissions` 可以强制走 codex 自己的子 agent 那条路。

顺带说，`send_input` / `resume_agent` 能做一件两条现有路都做不到的事：**让反驳者跨轮活着**，
记得自己上一轮提过什么。目前没用上。

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

## 协调者的职责边界（它是领导，不是裁判）

协调者**只管流程**:开局、给初始条件、盯着回环、出问题了解决或决定停止。
具体开发交给回环里的角色 —— 相当于员工。

| 协调者管 | 协调者**不管** |
|---|---|
| 开局：给目标、判据、预算、角色 | ❌ **判达标** |
| 推进轮次、把上一轮的失败信息带下去 | ❌ 自己写代码（那是提议者的活） |
| 抓异常：空跑 / 停滞 / 原地打转 | ❌ 决定「还能不能再来一轮」（代码算） |
| 出问题时纠正或停手，并如实报原因 | |

「判达标」为什么必须拿走:协调者是**做事的那一方**,它有充分动机说「已达标」。
`loop_end(goal_met)` 在判据没真判过之前会被直接拒 —— 这条拒绝是这个工具存在的理由。

### 抓异常：三种，各占一条停止原因

早先这三种都不存在或者形同虚设:

| 异常 | 怎么发现 | 你下一步该做什么 |
|---|---|---|
| `idle_spin` **空跑** | 观察到连续 N 轮**没有任何角色改过文件** | 权限够吗？提示词是不是让它以为只做分析？ |
| `stalled` **停滞** | 某个角色进程 240s 一个字都不吐 → 中止 | 换个模型/宿主重试；看那个角色的日志 |
| `no_progress` **原地打转** | 指标不动；**没有 metric 时比判据输出指纹** | 方向错了，别再喂轮次 |

最后一行是补的一个**一直是空的闸门**:`metric` 是可选的（只有输出里确实有可抓的数时才配），
而旧代码在没有 metric 时直接回「不计入零进展」—— 于是绝大多数回环的零进展闸门根本不生效，
一个原地打转的回环能把轮数烧满才停。现在没有 metric 就比**判据输出的指纹**（归一化掉耗时、
时间戳、临时路径），连续两轮一模一样就是没动到判据关心的东西。

⚠ 空跑检测**只在真的观察得到时才生效**。补丁台账本来就靠 agent 自己报（`loop_say` 带
`diff`），而它们经常不报 —— 把「没报」当成「没改」会把健康的回环误杀，那比没有这个检测更糟。
所以 per-role 那条路（看得见每次工具调用）才传 `observed: true`；纯 MCP 那条路观察不到，
就是「不知道」，不猜。

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

## 不可量化的目标：交给独立评审者

「重构得更好读」「补齐 API 文档」「命名统一」—— 这类目标没有命令可判。以前它们直接被挡在门外。

```
/code-forge 把 payments 重构得更好读 —— 判定标准:所有公开函数都有 docstring;
没有超过 50 行的函数;命名统一用 snake_case
```

聊天里的执行者带着目标看过仓库、确认没有可跑的命令后,会问你要不要交给**独立评审者**按标准判。

### 判定人是独立评审者，不是协调者

这一点是刻意的,而且是这个功能能存在的前提:

| | 协调者 | 独立评审者 |
|---|---|---|
| 立场 | **做事的那一方**，有动机说「已达标」 | 不参与改代码 |
| 会话 | 有全程历史 | **独立会话**，只看目标 + rubric + 代码 |
| 权限 | 提议者要能写 | **只读**（宿主级强制，不是提示词请求） |
| 模型 | — | **尽量换一个**（同模型自评通过率虚高） |

核心性质保住了:**达标与否不由做事的人自己说。** 从「代码判」放宽到「独立第三方判」,
但没有放宽到「自己判」。

### 三条防线，防的是「一句好话就签合格证」

1. **必须给证据。** 裁定里要引用 `文件:行号`。判了 `MET` 但一条证据都没给 →
   **降级成未达标**，并标明是被降级的。
2. **解不出裁定 = 判据坏了**（`judge_broken`），**不是**未达标 —— 与「命令找不到 ≠ 测试没过」
   同一条纪律。这时的「未达标」不算数据。
3. **命令是硬门槛。** 同时给了命令和 rubric 时：命令先跑，没过就不花评审那次调用；
   命令过了也不算完，评审判的正是命令覆盖不到的那部分。

### 它比命令判据弱，这件事一路标到底

一条命令的退出码可复现，一个模型的裁定不可。所以停止原因**单列** `judged_met`，
**绝不混进** `goal_met`：

```
■ 达标停止（评审判定）     ← 某个独立评审者按标准判的
■ 达标停止（命令判过）     ← 真跑过 pytest
```

回放一次运行时，这两者必须分得清。直播窗口与网页监控台都按这个区分显示。

## 停止原因（终端与页头都显示真的那一条）

| reason | 含义 | 你下一步该做什么 |
|---|---|---|
| `goal_met` | **命令**判据判过了 | 看复核意见,合了 |
| `judged_met` | **独立评审者**按 rubric 判过了（不可复现，弱一档） | 自己再看一眼证据 |
| `budget_rounds` / `budget_time` | 轮数/时限到顶 | 加预算再来,或换个更小的目标 |
| `no_progress` | 指标不动；没 metric 时判据输出连续相同 | 方向错了,别再喂轮次 |
| `idle_spin` | **空跑** —— 观察到连续 N 轮没人改过文件 | 权限够吗？提示词是不是让它只做分析？ |
| `stalled` | **停滞** —— 角色进程长时间没输出被中止 | 换模型/宿主重试，看那个角色的日志 |
| `gate_broken` | 判据命令跑不起来/超时/正则抓不到数 | **先修判据**,这时的「未达标」不算数据 |
| `judge_broken` | 评审者没给出 VERDICT / 起不来 | 同上：这时的「未达标」不算数据 |
| `stopped` | 你按了停（终端 `s` 键 / 页面按钮） | — |
| `abandoned` | agent 自己判断做不下去(detail 里有理由) | 读它的理由 |

## 跨宿主：先问一句 `npx github:Z-wwwwww/Code-Forge doctor`

「哪个 coding agent 现在能跑」不该靠读文档猜。装完打这一条:

```
$ npx github:Z-wwwwww/Code-Forge doctor
CODE-FORGE doctor  这台机器上哪个 coding agent 现在能跑对抗回环
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

─ 能用的 ───────────────────────────────────────────────────────────── 2 个 ─
  宿主            装了  MCP   自动起  用量  角色隔离  适配器
  Claude Code     ✓     ✓     ✓       ✓     子 agent  实测过
  Codex CLI       ✓     ✓     ✓       ✓     独立进程  实测过

  没装：opencode(opencode)  Gemini CLI(gemini)  Cursor Agent(cursor-agent)

─ 列的意思 ───────────────────────────────────────────────────────────────────
  MCP       回环的六个工具注册了没（? = 查不出来，不等于没注册）
  …

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
现在就能用  在 Claude Code 的聊天里: /code-forge <你的目标>
```

| 列 | 意思 |
|---|---|
| MCP | 回环那六个工具注册了没（`?` = **查不出来**，不等于没注册） |
| 自动起 | 能不能被 `loop_agent` 派成独立进程的角色（判据评审者也走它） |
| 用量 | 它的输出能不能解出 token（`✗` = 回环照跑，用量那栏显示「未上报」） |
| 角色隔离 | 每个角色怎么拿到**独立会话**：子 agent（一个进程内）/ 独立进程（一角色一个）。两种都能逐角色记账 |
| 适配器 | **未实测** = 参数按公开约定写的、没在真机上验过 |

`install` 会给**所有探测到的**宿主注册 MCP（claude / codex 走各自的 `mcp add`，其余改各自的
配置文件、改前备份）。**只碰装了的** —— 给没装的工具凭空造配置文件是往人家目录里乱扔东西。

### 加一个我们没支持的 agent

不用等我们。写 `~/.code-forge/agents.json`：

```json
[{ "id": "myagent", "label": "My Agent", "bin": "myagent",
   "args": ["run", "--model", "{model}", "-"], "promptVia": "stdin" }]
```

`{model}` / `{cwd}` / `{permission}` 会被替换；**值为空时连同它前面那个开关一起去掉**
（否则会传出 `--model --next` 这种起不来还看不出原因的参数）。它立刻出现在 `doctor` 里，
标成「未实测」。用量解不出来不影响回环 —— 只是那栏显示「未上报」，或者你自己
`POST /events` 报一条（格式见 `AGENTS.md`）。

### 各宿主给到的粒度不一样，这必须如实说

| | Claude Code | Codex CLI |
|---|---|---|
| 用量粒度 | 逐条消息带 `parent_tool_use_id` → **摊得到子 agent** | 每轮一条 `turn.completed` → 只到「执行者」一行 |
| 成本 | `total_cost_usd` | **不报** → 显示「成本未上报」 |
| 角色怎么演 | 派给三个子 agent，各绑不同模型、反驳者工具层面没有写权限 | 同一个进程按协议轮流扮演 |
| 权限 | `auto` 就能跑（五个回环工具 `--allowedTools` 预先放行） | **必须 `--perm bypassPermissions`**，见下 |

所以 codex 那边看不到「提议者花了多少、反驳者花了多少」—— 分不开就不分，
**不会因为 claude 那边有一张按角色分的表，就在这边编一张出来**。

⚠ **codex 有一道硬门槛。** 它在 `workspace-write` 沙箱下会把 MCP 工具调用直接判成
`user cancelled`（MCP server 跑在沙箱外、需要批准，而 `exec` 模式下没人能批）。实测排除过
`approval_policy` 的四个取值、`mcp_servers.<name>.default_tools_approval_mode="auto"`、
`sandbox_workspace_write.network_access=true` —— **只有 `danger-full-access` 能过**。

所以往 codex 的**协调者路线**派活在低权限档下走不通(这也是它聊天里角色改走 `loop_agent`
独立进程的原因之一) —— 独立进程不经 MCP,绕开了这道门。以前 go 会在开跑前报错,而不是让你跑完一整趟
才发现监控台是空的：

```
启动失败：Codex CLI 在权限档 «auto» 下跑不了这个回环：codex 在 workspace-write 沙箱下会把
MCP 工具调用直接判为「user cancelled」…只有 danger-full-access 能过。
要么加 --perm bypassPermissions（⚠ 它能改任何文件、跑任何命令，没人拦），
要么换一个宿主（doctor 看有哪些）。
```

**它只拦，不替你升权** —— 背着人把沙箱关掉是这里最不能做的事。这个失败模式极具迷惑性：
agent 确实按协议调了 `loop_begin`、参数完全正确，最后还会好心告诉你「该 MCP 调用被取消了」，
而监控台上一条事件都没有。所以宁可开跑前挡住。

## 关于 token：哪条路数得出，哪条数不出

**看执行者是不是我们自己起的**,这决定了有没有账可看:

| 起法 | 逐 agent 用量 | 为什么 |
|---|---|---|
| `loop_agent` 派出的角色 / 独立评审者 | ✅ **数得出** | 它们是我们 spawn 的进程,自己报账 |
| Claude Code 聊天里派的**子 agent**（即角色） | ✅ **数得出** | Claude Code 自己给每个子 agent 存了档(`~/.claude/projects/…/subagents/`,带真模型与逐条 usage),监控台直接读那份 —— 见 `chatusage.js` |
| 聊天里那个**协调者本人** | ❌ 摊不出来 | 它的 token 混在你那条会话的整个对话里,还夹着跟这次回环无关的聊天 |

所以聊天这条路上看到的合计是**角色的账**,不是这次回环的全部花费 —— 界面上也是这么标的。

数得出的时候:

```
打开网页监控台（开跑时给的地址）,「用量」那栏就是;直播窗口底部也有同一张表:
```

```
合计  14.7k↑ / 2.4k↓   缓存 读 285.0k / 写 9.0k   15 次调用   $0.4231
      ↑ 这是下面各行之和。成本是 CLI 收尾自报的 total_cost_usd（这次运行真花的钱）。
      CLI 收尾还自报了 24.1k 输出（其中 thinking 21.7k）—— thinking 不带归属信息，摊不到具体 agent，
      所以下面每行的 out 是下界。

─ 逐 agent ───────────────────────────────────────────────────────────────────
  AGENT        MODEL               in     out    缓存读   轮次    工具
  提议者       sonnet-4-5        8.0k    1.2k     45.0k   R1,R2   Read×9 Edit×4
  反驳者       opus-4-5          5.5k     900     30.0k   R1,R2   Read×6 Grep×3
  协调者       opus-4-5          1.2k     340    210.0k   R1      Agent×3 Read×2

─ 第 2 轮 ────────────────────────────────────────────────────────────────────
  反驳者           5.5k↑     900↓   Read×6 Grep×3
```

同一份数字也在 `code-forge` 的终端直播和网页监控台上。**「谁在烧钱」和「它在干什么」
是同一张表** —— 工具次数比一句摘要更能说明这一轮它到底做了什么。

怎么摊到每个 agent 头上:子 agent 的事件带 `parent_tool_use_id`,它等于**派它出去的那次
调用**的 `tool_use.id`;不带的就是协调者本人。同一个 subagent 派出多个角色(三个反驳者
各管一片)按那次调用的 `description` 里的角色名分开。

五条不让它变成假账的规矩(全部是**实测**踩出来的,不是推测):

1. **同一条消息会被拆成多个 stream-json 事件、每个都重复带一份相同的 usage** —— 按
   `message.id` 去重,否则账翻好几倍。
2. **派子 agent 的工具不叫 `Task`。** 实测这一版叫 `Agent`。所以认的是
   `input.subagent_type` **而不是工具名** —— 按名字认的话,子 agent 全变成匿名行,
   而表面上还挺正常。
3. **逐 agent 的 `out` 是下界。** 逐条 assistant 的 `output_tokens` **不含 thinking**,
   而 thinking 不带 `parent_tool_use_id` —— 摊不到任何 agent 头上。中途那些
   `thinking_tokens` 事件写的是*估算*(实测那次估 131、实际 62),拿它去补只会补出一个
   更错的数。所以差额单列成「CLI 收尾还自报了 N 输出（其中 thinking M）」,**不硬凑成一致**。
4. **合计就是各行之和,不拿 `result` 里的数冒充总数。** 实测同一次运行里三个数互不相等:

   | 出处 | in | cacheRead |
   |---|---|---|
   | 逐条 assistant 去重求和 | 29 | 88551 |
   | `result.usage`（`iterations` 只有 1 条 → 它是某一次调用的） | 19 | 56789 |
   | `result.modelUsage` | 29 | 56789 |

   能说清出处的只有两样:**我们自己摊出来的那份**,和 **`total_cost_usd`**(=各
   `modelUsage` 成本之和,这次运行真花的钱)。所以合计用前者、成本用后者,
   result 那份只作为「CLI 收尾自报」摆在旁边。挑一个当「权威」,结果就是页面上出现一个
   **加不出来的总数**。
5. **成本只用 `total_cost_usd`。** 不自带价目表去乘 —— 价格会变,乘出来的是编的。
   它没报就留空,不写 0。一条上报都没有时**整张表不画**:一张全是「—」的表会被读成
   「量过了,都是零」,而实际是「这条路没人报账」。

⚠ 这些 token 仍然花在**你自己的订阅账上**(执行者用的是宿主的模型访问权,不额外收费)。
这里数出来的是**明细**,不是一张新账单。

想按角色配不同厂商的模型、由本地进程自己发调用,那是下面那个可选模式。

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
node test-host.js    # 122 项：宿主驱动 + 跨宿主适配器 + 逐 agent 用量 + MCP 全链路 + 插件包装
node test.js         # 29 项：本地驱动模式（可选）
```

零 key、不联网、不发一次模型调用。钉住的都是**会静默出错**的那几条:自称达标必须被拒、
判据坏了不许报成未达标、停止原因必须是真的那一条、用量不许重复计数也不许编成本、
`package.json` 的 `files` 漏一个 require 到的模块就是坏包。

## 目录

```
install.js                         一条命令接入 Claude Code（幂等 / --dry-run / --uninstall / npx 时复制运行时）
tui.js                             终端界面：doctor / go / 问答向导 / 就地直播 / usage 报告（纯函数渲染）
adapters.js                        宿主适配器：怎么起、怎么解、MCP 往哪注册、有哪些模型。claude/codex 实测过，其余标「未实测」，
perrole.js                         一角色一进程：没有子 agent 的宿主走这条（各自模型/沙箱档、逐角色账、不需要 MCP）
                                   ~/.code-forge/agents.json 可覆盖或新增
usage.js                           逐 agent 用量：按 message.id 去重、按 parent_tool_use_id 归属、成本只认它自己报的
agentcli.js                        起 agent 命令行的唯一收口（不走 shell、模型名过白名单、可换 CLI）
perrole.js                         loop_agent 的腿：把一个角色跑成独立进程（只读档/逐角色记账）
skills/code-forge/SKILL.md   技能：协议 + 三条纪律（给 agent 读的那份）
agents/forge-proposer|critic|reviewer.md  三个角色，各绑不同模型与工具集
commands/code-forge.toml     /code-forge 斜杠命令（插件版）
.claude-plugin/                    插件与 marketplace 清单（自带 MCP 声明）
AGENTS.md                          Codex / opencode / 纯 HTTP 的接法

mcp.js        MCP server（stdio）：六个工具 + 监控台自动拉起
hostrun.js    宿主驱动的状态机：begin/say/gate/end，以及那条拒绝
gate.js       命令判据（全代码）：退出码 + 可选指标区间 + 输出指纹（没 metric 时判零进展）
judge.js      评审判据：不可量化目标交给**独立评审者**判（只读/独立会话/换模型/必须给证据）
server.js     HTTP + SSE + append-only 日志；--mcp 时转 stdio
index.html    监控台（reducer + 渲染）
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
| `POST /agent/stop`, `GET /agent/status` | 停止在跑的回环 / 看回环状态（`/agent/run` 回 410：执行在 coding agent 里） |
| `POST /runs` `/runs/stop` | 本地驱动模式的起/停 |
| `GET /usage` | 逐 agent 用量（从事件日志现算，只算最近一次回环） |
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
| `usage` | `round` `role` `agent` `agentType` `model` `in` `out` `cacheRead` `cacheWrite` `msgs` `tools{}`（增量）<br>`total:true` 那条:`costUsd` `turns` `seconds` `byModel[]` |
| `run.streaming` / `run.end` | `role` `text` / `reason` `detail` `rounds` `seconds` |

`kind` ∈ `propose` `attack` `defend` `verdict` `patch` `test` `audit` `route`。
认不出的 `t` 不会被静默吞掉:计数并在页头显示「未知 N」。

## 还没做的

- **补丁台账靠 agent 自己报**(`loop_say` 带 `diff`)。插件不去猜谁改了哪个文件 —— 凭空生成一条 = 编造。
- **分歧点在宿主模式下也靠 agent 报**(`POST /events` 一条 `conflict`);本地驱动模式会自动从
  「提议 → 反驳」这一对里生成,两侧原话都截自真实事件。
- **一次只跑一个回环**(第二次 begin → 409)。两个回环写同一条流,谁说的话就分不清了。
- **一份日志按顺序装多次回环**:页面在遇到新 `run.start` 时切到最新那次(硬盘历史一条不丢)。
