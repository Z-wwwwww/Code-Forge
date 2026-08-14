# code-forge — 给 Codex / opencode / 其它 agent 的接入说明

Claude Code 走插件(`/plugin marketplace add` + `/plugin install`,技能会自动加载)。
其它宿主目前没有统一的技能格式,所以这里给两样东西:**怎么把 MCP 接上**、**照什么协议走**。

## 1. 接上 MCP（一次)

命令 `node <本目录>/server.js --mcp`,stdio 传输。零依赖、零 key。

- **Codex**:在 `~/.codex/config.toml` 里加
  ```toml
  [mcp_servers.code-forge]
  command = "node"
  args = ["C:/Projects_GitHub_my/Code-Forge/server.js", "--mcp"]
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
