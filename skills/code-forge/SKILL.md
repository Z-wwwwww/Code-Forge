---
name: code-forge
description: >
  Run an adversarial loop on a verifiable goal: one role proposes and lands changes, one role
  specializes in overturning them, and code (not a model) rules whether the goal is met; failing
  rounds carry the failure output forward until the gate passes or the budget runs out. The whole
  process streams live to a local console (rounds, every role's words, gate trend, stop reason).
  You are the executor yourself - no API key needed. Use when the user says "adversarial",
  "对抗", "互相推翻", "让它们吵一架", "iterate until tests pass", "反复迭代直到测试通过",
  "run until coverage passes", "跑到覆盖率达标", "盯着它改到绿", or asks for an iterative loop
  whose progress they can watch. Not for: small one-shot edits, or pure discussion with no
  runnable gate (test/command).
---

# Adversarial loop

One writes, one tears down, code rules. You play every role; the verdict belongs to code.

**Language rule: all prompts and role briefs are English (this file included). Everything the USER
sees - role names, AskUserQuestion cards, your chat replies - is in the user's conversation
language. Pass that language as `lang` in `loop_begin` (e.g. "zh", "en") so the observers (TUI /
web console) label everything in it too.**

## Why the verdict must be handed over

You have every incentive to say "goal met" - any agent does. So this skill takes "did it pass"
away from you and gives it to `loop_gate`: it runs the command you configured and reads the exit
code and (optionally) one metric. **You must not declare success yourself**; `loop_end(goal_met)`
is rejected until the gate has actually ruled it met.

Budgets work the same way: whether another round is allowed is said by `loop_gate`'s `continue`
field, not estimated by you.

## Until the goal is stated, start nothing

When the user typed just `/code-forge` (or the goal is as vague as "optimize it"), this turn does
exactly one thing: **wait for the goal**. It should feel like an input prompt: stop and let them
type - do not reject and make them retype, and do not guess for them. Gate candidates are chosen
from the goal and role briefs carry the goal - scanning the repo to invent a goal means deciding
for the user and burning their quota. Three steps:

1. **The conversation just discussed a concrete problem** → don't make them retype it: call
   AskUserQuestion (header: goal) with 1-2 candidate goals distilled from it (recommended first;
   the component has a built-in Other).
2. **No usable context** → output a single line asking what to do (in the user's language,
   e.g. Chinese: 「目标：要做什么？一句话说清」), then stop and wait. Do NOT invent goal options
   from repo files - gate candidates may come from the repo, goals may not; that is the user's call.
   No explanations, no menus - every extra character on a waiting screen is noise.
3. **The answer is still too short/vague** → explain why specificity matters ("gate candidates are
   chosen from the goal") and ask once more. Rule: no established goal, no `loop_begin`.

## Two things to settle before starting

1. **The gate command** - one command runnable right now that reflects the goal.

   **Never ask "what's the gate command" cold**: the user would have to type a long string while
   the repo is in your hands. **With the established goal in mind**, spend a minute on the repo
   (README / package.json / pyproject.toml / Makefile / CI config / test dirs), then **offer 2-4
   candidates to pick from**, each with a reason.
   The order is fixed: goal → look at the repo with the goal → candidates.
   The reverse (scan first, imagine a goal from files) picks "what this repo
   can run", not "what this goal should be judged by" - often not the same command.

   **If the host has a clickable option component, use it - never a numbered text list.** In
   Claude Code that is AskUserQuestion: candidates as options (label = the command itself,
   description = why), **recommended first, tagged (Recommended)**; don't add a "type my own"
   option - the component has Other built in. Write the card in the user's language.
   Only hosts without such a component (plain-text chats like Codex) fall back to a
   numbered list ending with "0) I'll type my own" - that is a downgrade, and labeled as one.

   Three hard rules:
   - **Only offer commands that actually exist** - script names, test dirs, the CI command: things
     you actually saw. **Never invent** script names or flags: the first `loop_gate` really runs
     it, an invented one reports `gate_broken`, burning a round and looking like a code bug.
   - **Goal-relevant candidates first**: for a payment-callback fix, that module's tests beat a
     full run.
   - **If the repo truly has no runnable check, say so honestly.** Then ask: write a rough check
     first, or accept "this run cannot rule success - only round/time limits stop it" (both the
     page and terminal will honestly show "not judged").

   If the goal carries a number, propose `metric` too: a regex capturing one number from the
   command's output, compared to a range, e.g. `{ name:"coverage", pattern:"coverage: ([0-9]+)",
   min:80 }`. **Only when you have confirmed the command really prints that number** - an
   uncaptured metric never counts as met.

   **A gate is a stop CONDITION, not necessarily a runnable command.** Three kinds, by trust:

   | Kind | How | Stop reason | Fits |
   |---|---|---|---|
   | Command | `goal.command` (+ optional metric.pattern) | `goal_met` (strongest, reproducible) | goals with tests/checks |
   | **Role-reported metric** | `goal.metric: {name, source:"say", max/min}`; the critic reports `value` via `loop_say` each round | `reported_met` | counts no command can measure ("bugs found this round") |
   | Judge rubric | `goal.rubric` | `judged_met` | truly unquantifiable ("more readable") |

   For "fix until N consecutive clean rounds" goals, add `goal.streak: N`: the gate must pass
   **N rounds in a row**; a miss resets the streak, and passing rounds during it don't count as
   no-progress (that's the confirmation window - the critic keeps digging).
   Example: "fix found bugs until 3 consecutive rounds with 0 bugs" →
   `goal: { metric: {name:"new bugs", source:"say", max:0}, streak: 3 }` + `budget.rounds: 0`;
   each round the critic reports `loop_say({role:"<critic>", value: N, ...})`.
   **Proposer-reported values are ignored** - it has every incentive to report 0; the count must
   come from the side doing the digging.

2. **Budget** - rounds and seconds. Defaults: 8 rounds / 3600s / stop after 2 no-progress rounds.
   If unspecified, use defaults and say so when starting. "Unlimited rounds" / "run until clean"
   → `rounds: 0` - time and no-progress gates still apply; confirm the time limit too (3600s is
   usually too short for unlimited rounds - ask).

If the user already stated all of this, don't re-ask - start.

**Config order is iron: every option gets its window first, and "start?" comes last.**
Never substitute "start? you can change it after" - that hides the cost of changing behind the
confirmation (a user called this out explicitly). Recommended option first in every question, so
plain Enter = all defaults.

**Config card** (one AskUserQuestion carries at most 4 questions; merge where possible; in the
user's language):

```
Q1 gate      candidate commands (recommended first; Other is built in)
Q2 models    recommended assignment (Recommended, spelling out proposer X · critic Y · reviewer Z)
             / all-strongest / all-cheapest / pick per role (then one more card, one role each)
Q3 rounds    8 (Recommended) / unlimited (rounds:0) / 3 (quick) - Other for custom
Q4 time      3600s (Recommended) / 7200s - put longer first when rounds are unlimited
```

If the goal mentions "N consecutive rounds", streak gets a question too (recommended = the N from
the goal, with one quicker/stricter alternative). Niche knobs (no-progress rounds etc.) don't get
questions; the confirm card is the catch-all.

**Confirm card** (only after every config question): lay out the final summary, ask once, in the
user's language, e.g.:

```
question: "Start as configured?", header: "confirm",
options: [
  { label: "Start (Recommended)", description: "begin with the summary above" },
  { label: "Change one thing", description: "back to the config card (say which)" },
  { label: "Cancel", description: "not this time" }
]
```

**The start flow is orchestrated by `loop_begin`'s state machine - you are only the hands, never
the scheduler** (tested: flows written in prompts get skipped; boolean gates get self-stamped -
so the order lives in code):
1. First `loop_begin` call (with task if the user gave the goal, or empty; **pass `lang`**) - it
   returns the CURRENT step's instruction and a one-time token;
2. Follow the instruction (ask the goal / show the config card / show its prepared summary on the
   confirm card), call again with the token;
3. Out-of-order, skipped steps, or wrong tokens bounce back to the current step. Only when the
   user picks Start does `{token, go:true}` actually begin.
The confirm-card summary comes back prepared by the server - **show it verbatim, no rewriting**.

## Roles: dispatch to different models, don't act alone

At least two roles, or it isn't adversarial. **A model debating itself is measurably softer** -
dispatch subagents when you can, on **different models**. Zero keys: it's the host's own model
access.

The skill ships three role definitions (installed in `~/.claude/agents/` or the plugin's
`agents/`). **Register their display names in the user's language** (e.g. zh: 实现者 / 反驳者 /
复核者; en: proposer / critic / reviewer):

| Role | Subagent | Model | Tools | kind |
|---|---|---|---|---|
| proposer | `forge-proposer` | `sonnet` | read/write + Bash | `propose` |
| critic | `forge-critic` | `opus` | **Read/Grep/Glob only** | `attack` |
| reviewer | `forge-reviewer` | `sonnet` | read-only | `audit` |

**The critic has no write access - a tool-level hard constraint, not a polite request.** A critic
that can quietly patch over problems is no critic; its product is "which line, which trigger
path", and the proposer does the changing.

**Models are swappable on the spot**: the table above is only the defaults (frontmatter of the
agent definitions). If the user names models in chat ("critic on opus", "proposer on haiku to
save"), override with the `model` param on that Task/Agent dispatch and state the final lineup in
the start summary. If they say "let me pick" without naming, use clickable options again
(AskUserQuestion, one question per role, recommended first with reasons - critic strongest,
proposer close, reviewer cheapest). Two edges:
- A named model this host doesn't have (errors out) → **say so honestly and keep the default**;
  never silently substitute.
- Downgrading the critic gets one warning ("a soft critic is no critic"); if the user insists, obey.

Dispatch (Claude Code): the Task/Agent tool with `subagent_type` set to the three names above.
When the proposer and critic are independent within a round, **dispatch them concurrently in one
message**, then `loop_say` each result. **With dependencies, go serial**: dig-fix rounds have a
fixed order - (1) proposer fixes last round's findings → (2) critic re-digs and reports `value`
→ (3) `loop_gate`. Reversed order counts unfixed bugs again and burns a round. `loop_say` a
`route` line when dispatching, and report the moment fixing starts - users watching "bugs found,
then long silence" assume a hang (tested).
For a stronger adversarial pass, dispatch several `forge-critic`s in one round with different
attack surfaces (concurrency / boundaries / entry-point coverage), then merge their findings into
one `loop_say`.

**Hosts without subagents** (Codex etc.): use `loop_agent` to run a role as a **standalone
process** - the console hosts it: isolated session, chooseable model, critics read-only at the
tool layer. The prompt must be self-contained (it cannot see your conversation); results are
auto-loop_say-ed. Only if `loop_agent` fails, fall back to playing roles yourself in turn - it
works, but the adversarial strength drops a tier; follow `forge-critic`'s brief all the more
strictly, hunting real counterexamples, not going through motions.

Add more tiers when needed: `test` (add cases), `patch` (land changes), `defend` (rebuttal
defense), `verdict`, `audit` (security/perf specials).

**Cross-vendor multi-model** (gpt / gemini in the same arena) needs API keys and the local-driver
mode - see README; not this skill's path.

## Protocol (in this order)

```
loop_begin({session, lang, goal:{command, cwd, metric}, budget, roles})
  ↓  ← auto-pops a terminal live window (browser only as fallback); tell the user the web URL too
each round:
  proposer works → loop_say({role:"<proposer>", summary, body, diff?})
  critic works   → loop_say({role:"<critic>", summary, body, targets:["<proposer>"]})
  (other roles likewise)
  loop_gate()
    ├ met:true            → already wrapped up. Report the verdict and gate output to the user.
    ├ continue:true       → carry the failure output into the next round, back to the top
    └ continue:false      → stop; report the true stopReason (never dress it up as "done")
```

Key points:

- **`loop_say` immediately after each role speaks** - never batch at the end; the page is live for
  humans, batching defeats it.
- **Report before dispatching too**: `loop_say({role, kind:"route", summary:"dispatched (sonnet),
  reading the repo"})`. A subagent legitimately runs 5-15 minutes on a real goal - with zero
  events in that window the user can only guess "slow model or hang?" (tested). Dispatch moment =
  first event.
- `summary` is the one-sentence conclusion (collapsed rows show it), `body` the full reasoning -
  **both in the user's language**; they are user-facing archive content.
- Attach `diff` (file / add / del / lines) when files changed - the page grows a patch trail.
- Attach `tool` (name / args / result / status) when tools were used - rendered as tool blocks.
- **Never fabricate token usage**: in Claude Code the subagent accounts are read from its own
  archives (`~/.claude/projects/…/subagents/`, real models, per-message usage). If your own
  result carries usage, you may pass `loop_say({tok:{in,out}})`; otherwise omit - **never
  estimate**.
- Parallelize when independent; `loop_status` when unsure whether another round is allowed -
  never estimate.

## Three disciplines

1. **Never declare success.** Only `loop_gate` can. If it says `met:false`, it did not pass, even
   if you are sure the fix is right.
2. **Never bend the gate to pass it.** If the gate itself is broken (command won't run, regex
   captures nothing), `loop_gate` reports `gate_broken` - stop and tell the user the gate needs
   fixing. **Do not** loosen `min`, comment out failing tests, or swap in an easier command. That
   is sawing off the ruler.
3. **When it stops, say why truthfully.** `stopReason` is one of `goal_met` / `budget_rounds` /
   `budget_time` / `no_progress` / `gate_broken` / `stopped` / `abandoned` - each demands a
   different next move. Reporting "budget exhausted" as "completed" is this skill's cardinal sin.

## When wrapping up, tell the user

- The stop reason (the true one of the seven) and rounds run
- The gate's final output highlights (which tests still red, where the metric stopped)
- Critic remarks that were **not** adopted - often where the next bug lives
- The console URL: the full archive (every round, every role's words, gate trend) lives there

## When not to use this

- One-shot fixable: just fix it; the loop's overhead isn't worth it.
- No runnable gate and unwilling to write one: that's a discussion, not a loop.
- The user wants an answer, not a process: just answer.
