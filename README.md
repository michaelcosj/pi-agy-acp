# pi-antigravity

A [Pi](https://github.com/earendil-works/pi) provider for your **Google AI
subscription** through the official Antigravity CLI. Pi starts the
unmodified `agy acp` server and acts as an interactive ACP client, like Zed
or T3 Code.

**agy owns the agent:** its tools, system prompt, context, compaction,
subagents and swarms, `/goal`, and background wakes. **Pi owns the UI:** the prompt
box, the stream, permission prompts, model and thinking pickers, and
sessions.

## Install

```sh
pi install /path/to/pi-antigravity     # or: pi -e /path/to/pi-antigravity/src/index.ts
agy                                    # sign in once with Google
pi --model antigravity/gemini-4-neon
```

The models show only when agy is signed in.

## Use

- Type prompts as usual. Tool calls show as one line each (`▸ title ✓`).
- agy runs **only in auto mode** (edits and safe commands run; risky ones
  ask). Pi sets auto on every session and sets it again if agy leaves it. A
  session that cannot switch to auto does not run.
- Permission prompts that agy still sends open as Pi dialogs. Escape rejects.
- `/agy <command> [args]` runs an agy slash command, for example
  `/agy goal migrate the auth module`.
- A message that you send during a turn goes to agy at once (agy steers).
- When agy continues by itself (a background command or timer finished),
  Pi shows that work as a message. It does not start a Pi turn.
- `/compact` runs agy's own `/compact`. Pi's automatic compaction is off.
- `/antigravity-status` shows the CLI, sign-in, tier, session, the
  automatic-turn count, and agy's subagents.

### Pi's agent tool for Gemini

Pi serves its `agent` tool to agy over an in-process MCP server (HTTP on
127.0.0.1, bearer token), as T3 Code serves its orchestrator tools. Gemini
can start Pi child agents in Rex panes on any model, `antigravity/*`
included. Needs agent-bridge.

- When a child settles, its result posts to the Pi session and starts an
  Antigravity turn, so Gemini can end its turn while children run (hours
  are fine). `wait` (at most 240 s per call) is for short tasks.
- At most 6 children. `PI_ANTIGRAVITY_AGENT_TOOL=0` turns the tool off.

### Turns that you did not type

Any new message can start a turn: text that you type, a child's result, or
another extension's prompt. New messages go to agy as one prompt. A turn
that you did not type uses one unit of a budget (5,
`PI_ANTIGRAVITY_AUTO_TURNS`); text that you type refills it. So children
that start children cannot loop without you. A message that agy already
got (Pi's auto-retry) is not sent again.

### agy's own subagents (read-only)

agy's subagents and swarms run as agy decides. Pi shows them in the agent
list (↓ on an empty prompt, or `/agents`) as `agy-<role>` rows, and
`/agy-subagents` lists them. Enter opens a viewer with the role, the state,
the last reply, and recent steps. Pi cannot message or stop them; agy owns
them. The data comes from agy's records in `~/.gemini/antigravity-cli/brain/`
(ACP does not report subagent steps).

On start, Pi adds `mcp(pi/*)` to agy's allow list in
`~/.gemini/antigravity-cli/settings.json`, so the agent tool runs without
a prompt.

## Policy

Google permits `agy acp` on a consumer sign-in for "custom or non-editor
interactive ACP UIs … when a human user is directly driving the session"
([#1493](https://github.com/google-antigravity/antigravity-cli/issues/1493),
[T3 Code ruling](https://discuss.ai.google.dev/t/tos-clarification-is-t3-code-official-antigravity-acp-agent-permitted-under-the-antigravity-terms-of-service/192027)).
It does not permit agy as a backend worker or overriding agy's system
identity.

This extension does what T3 Code does: it gives agy orchestration tools
over MCP, a child's result starts a parent turn, and agy's subagents run
(T3 Code issues #17412, #30082, #39298). It does not replace agy's system
prompt (it adds one short note about the Pi UI) and never reads Google
credentials. Google did not name Pi. Use at your own risk.

## Limits

- Pi tools, tool hooks, and the Pi system prompt do not apply to this
  provider. agy loads `AGENTS.md`, `GEMINI.md`, and its own skills.
- A branch, or a session that agy lost, starts a new agy session. Pi asks
  whether to send the visible history.
- No Pi auto-compaction. A retry of a turn that agy got is not sent again.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `PI_ANTIGRAVITY_COMMAND` | `agy` | The agy binary (or `agy_acp_server`) |
| `PI_ANTIGRAVITY_ARGS` | `acp` | Arguments (`--process-per-session` is added for MCP) |
| `PI_ANTIGRAVITY_AGENT_TOOL` | on | `0` turns off Pi's agent tool |
| `PI_ANTIGRAVITY_AUTO_TURNS` | 5 | Turns that you did not type, per typed message |
| `PI_AG_MAX_WAIT_S` | 240 | Longest `agent wait` per call |
| `PI_ANTIGRAVITY_LOG` | off | `1` writes `/tmp/pi-antigravity-<pid>.jsonl` (methods, timings, no text) |
| `PI_AG_MAX_CHILDREN` | 6 | Most children at once |
