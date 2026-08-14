# code-forge — 给 Codex / opencode / 其它 agent 的接入说明

Claude Code 走插件(`/plugin marketplace add` + `/plugin install`,技能会自动加载)。
其它宿主目前没有统一的技能格式,所以这里给两样东西:**怎么把 MCP 接上**、**照什么协议走**。

## 0. 哪些通用，哪些只认 Claude Code

先把这条说清楚,免得踩空:

| 部件 | 通用吗 | 说明 |
|---|---|---|
| MCP 协议 `loop_begin / loop_say / loop_gate / loop_status / loop_end` | ✅ | 任何支持 stdio MCP 的宿主 |
| 判据(`gate.js`)、预算、以及那条「没判过不许说达标」的拒绝(`hostrun.js`) | ✅ | 纯代码,与宿主无关 |
| 监控台、事件流、`code-forge tui` / `code-forge watch` | ✅ | 只读事件流,不关心谁在执行 |
| 纯 HTTP `/host/*` | ✅ | 不装 MCP 也能驱动 |
| `skills/code-forge/SKILL.md` 的协议与三条纪律 | ✅ | 是文本,贴进任何 agent 的 rules/AGENTS.md 都成立 |
| **判据命令「候选式确认」** | ✅ | 写在技能里 —— 由**宿主自己**看仓库、自己提 2~4 条候选 |
| `agents/forge-*.md` 三个角色(各绑模型与工具集) | ❌ | Claude Code 的 subagent 格式 |
| `/code-forge` 斜杠命令、`install.js`、插件清单 | ❌ | Claude Code 的目录约定 |
| 页面 **Run** / `tui` **自动把执行者拉起来** | ⚠️ | 默认起 `claude`;`CODE_FORGE_AGENT_CLI` 能换成别的 agent 命令行,**但 `-p` / `--output-format stream-json` / `--allowedTools` 是 claude 专属参数** —— 换了以后这条路的参数要自己对 |
| `/setup` 页上「让协调者建议判据」 | ⚠️ | 同上走本地 `claude -p`;**失败自动退回零调用的文件启发式**(pytest.ini、package.json 的 scripts、Cargo.toml…),那半是通用的。⚠ 退回来的那批**与目标无关**,页面与 tui 都按来源分拨、只有贴题候选才自动填 —— 把猜的呈现成「按目标出的」等于拿一条不相干的命令当 judge |

一句话:**回环本身、判定、留痕、直播都是通用的;只有「自动把执行者拉起来」这一件事目前对
Claude Code 开箱即用。** 其它宿主走「你自己驱动」那条路 —— 接上 MCP、照下面的协议走,效果一样。

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

接上后会多出五个工具:`loop_begin` / `loop_say` / `loop_gate` / `loop_status` / `loop_end`。
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

## 3. 不装 MCP 也能用（纯 HTTP）

先 `node server.js` 起监控台,然后打 HTTP:

```
POST /host/begin   {session, goal, budget, roles}
POST /host/say     {role, summary, body, ...}
POST /host/gate    {}                        → { met, value, output, continue, stopReason }
GET  /host/status
POST /host/end     {reason, detail}
```

⚠ Windows 终端里直接写中文会按 GBK 发出去,落库变 `����` —— 存成 UTF-8 文件再 `--data-binary @f.json`。
