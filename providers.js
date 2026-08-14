"use strict";
/**
 * 模型调用层 —— 零依赖,只用 Node 18+ 的全局 fetch。
 *
 * 为什么角色执行留在本地进程里:只有自己发出的调用,token 与花费才数得清。
 * 让宿主 agent 去调,用量就记在宿主账上,我们只能事后解析各家格式各异的日志。
 *
 * 每个 provider 归一成同一个返回形状:
 *   { text, tok: { in, out }, meta }
 * tok 一律取 provider 报的真值;报不出来才估算,并在 meta.estimated 标明。
 */

const MOCK_LINES = {
  propose: [
    "方案：把去重收敛成一个函数,两个入口共用。\n1. 唯一索引 UNIQUE(provider, provider_event_id)\n2. 入口改 INSERT ... ON CONFLICT,受影响 0 行直接返回\n3. 入账逻辑并入同一事务",
    "改法：把就地平移拆成纯函数,落库推迟到调用成功返回之后。同一批输入重放两次结果逐字相等。"
  ],
  attack: [
    "反驳 1（并发）：应用层判「受影响行数」在 READ COMMITTED 下两个事务都可能读到 0 行,需要 RETURNING 判定。\n反驳 2（可观测性）：DO NOTHING 会吞掉真实冲突,监控上看不到重投率。",
    "反驳：跨段路径没走这条分支,重入相等只在单段成立。反例已写进用例。"
  ],
  defend: [
    "接受事务边界的批评,不接受「需要分布式锁」的推论 —— 单库场景行锁即可。"
  ],
  audit: [
    "两项阻塞：① 锁被跳过时返回 None,当前代码把 None 当成可入账;② 重放窗口仍是 300s,建议收到 120s。"
  ],
  test: [
    "构造 200 并发重投 × 50 轮,断言只应有 1 条记录。48 轮通过,2 轮失败。"
  ],
  review: [
    "复核通过：判据由代码算出,证据齐全,无遗留阻塞项。"
  ],
  route: [
    "分派完成,本轮限制：仅指定角色可发言。"
  ]
};

function mockCall(role, round) {
  const pool = MOCK_LINES[role.kind] || MOCK_LINES.propose;
  const text = pool[(round - 1) % pool.length];
  // 让假数据也有随轮次变化的量,便于验证记账链路
  const inTok = 900 + role.name.length * 40 + round * 120;
  const outTok = Math.round(text.length / 1.6);
  return { text, tok: { in: inTok, out: outTok }, meta: { provider: "mock" } };
}

/* ---------------- Anthropic (raw HTTP,项目零依赖) ---------------- */
async function callAnthropic(role, prompt, opts) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("缺少 ANTHROPIC_API_KEY");
  const body = {
    model: role.model,
    max_tokens: opts.maxTokens || 4096,
    system: prompt.system,
    messages: [{ role: "user", content: prompt.user }]
  };
  // ⚠ 当前 Claude 模型上 temperature/top_p/top_k 与 thinking.budget_tokens 一律 400,
  //   深度只能用 output_config.effort 调。这里刻意什么都不发,取默认。
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify(body),
    signal: opts.signal
  });
  const data = await res.json();
  if (!res.ok) throw new Error("anthropic " + res.status + ": " + (data.error && data.error.message));
  // 分类器可能拒答:HTTP 200 + stop_reason=refusal,content 可能是空数组。
  // 先判 stop_reason 再读 content —— 无条件读 content[0] 正是会崩在这里。
  if (data.stop_reason === "refusal") {
    const cat = (data.stop_details && data.stop_details.category) || "未分类";
    throw new Error("模型拒答(" + cat + ")");
  }
  const u = data.usage || {};
  return {
    text: (data.content || []).filter(function (b) { return b.type === "text"; })
      .map(function (b) { return b.text; }).join("\n"),
    // Anthropic 的 input_tokens 只是「没命中缓存的那部分」,总输入要把缓存两项加回来
    tok: {
      in: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
      out: u.output_tokens || 0
    },
    meta: { provider: "anthropic", cached: u.cache_read_input_tokens || 0, stop: data.stop_reason }
  };
}

/* ---------------- OpenAI 兼容(openai / deepseek / qwen / openrouter / ollama …) ---------------- */
const OPENAI_COMPATIBLE = {
  openai: { base: "https://api.openai.com/v1", env: "OPENAI_API_KEY" },
  deepseek: { base: "https://api.deepseek.com/v1", env: "DEEPSEEK_API_KEY" },
  qwen: { base: "https://dashscope.aliyuncs.com/compatible-mode/v1", env: "DASHSCOPE_API_KEY" },
  openrouter: { base: "https://openrouter.ai/api/v1", env: "OPENROUTER_API_KEY" },
  ollama: { base: "http://localhost:11434/v1", env: null }
};

async function callOpenAICompatible(role, prompt, opts) {
  const cfg = OPENAI_COMPATIBLE[role.provider];
  // 未登记的 provider 名必须自带 base_url —— 否则一个拼错的名字会把内容发到别人家去
  const base = role.baseUrl || (cfg && cfg.base);
  if (!base) throw new Error("provider «" + role.provider + "» 未登记,必须自带 baseUrl");
  const key = process.env[(cfg && cfg.env) || "OPENAI_API_KEY"];
  if (!key && role.provider !== "ollama") {
    throw new Error("缺少 " + ((cfg && cfg.env) || "OPENAI_API_KEY"));
  }
  const res = await fetch(base.replace(/\/$/, "") + "/chat/completions", {
    method: "POST",
    headers: Object.assign({ "content-type": "application/json" },
      key ? { authorization: "Bearer " + key } : {}),
    body: JSON.stringify({
      model: role.model,
      max_tokens: opts.maxTokens || 4096,
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user }
      ]
    }),
    signal: opts.signal
  });
  const data = await res.json();
  if (!res.ok) throw new Error(role.provider + " " + res.status + ": " + (data.error && data.error.message));
  const u = data.usage || {};
  const text = ((data.choices || [])[0] || {}).message;
  const est = Math.round(((prompt.system || "").length + (prompt.user || "").length) / 2.2);
  const reported = (u.prompt_tokens || 0) + (u.completion_tokens || 0) > 0;
  return {
    text: (text && text.content) || "",
    tok: reported
      ? { in: u.prompt_tokens || 0, out: u.completion_tokens || 0 }
      : { in: est, out: Math.round(((text && text.content) || "").length / 2.2) },
    // 拿不到真值时估算,但必须标出来 —— 记估算 ≫ 记 0,记 0 等于宣称这次没花钱
    meta: { provider: role.provider, estimated: !reported }
  };
}

/**
 * 统一入口。role.provider === "mock" 时零 key 可跑(默认),用来验证整条回环。
 * 抛错即视为本次调用失败,由 loop 记一条 event 并继续 —— 一个角色失败不该让整轮塌掉。
 */
async function call(role, prompt, opts) {
  opts = opts || {};
  if (!role.provider || role.provider === "mock") return mockCall(role, opts.round || 1);
  if (role.provider === "anthropic") return callAnthropic(role, prompt, opts);
  return callOpenAICompatible(role, prompt, opts);
}

module.exports = { call: call, OPENAI_COMPATIBLE: OPENAI_COMPATIBLE };
