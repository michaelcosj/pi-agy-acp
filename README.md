# pi-antigravity

A [Pi](https://github.com/earendil-works/pi) provider for your **Google AI
subscription** through the official Antigravity CLI. Pi starts the
unmodified `agy acp` server and acts as an interactive ACP client, like Zed
or T3 Code.

**agy owns the agent:** its tools, system prompt, context, compaction,
subagents, `/goal`, and background wakes. **Pi owns the UI:** the prompt
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
- `/antigravity-status` shows the CLI, sign-in, tier, session, and guards.

### Pi's agent tool for Gemini

Pi serves its `agent` tool to agy over an in-process MCP server (HTTP on
127.0.0.1, bearer token), so Gemini can start and wait for Pi child agents
in Rex panes. Needs agent-bridge. Rules:

- Children need a non-Antigravity `model` (for example
  `claude-code/claude-opus-5-5`); `antigravity/*` is refused.
- Child results never post to the Pi session; Gemini gets them from
  `wait` (at most 240 s per call, then it calls `wait` again).
- At most 6 children. `PI_ANTIGRAVITY_AGENT_TOOL=0` turns the tool off.

### Subagents and swarms are denied

agy's own `invoke_subagent`, `define_subagent`, `manage_subagents`,
`send_message`, and swarm tools are denied, in three layers:

1. A PreToolUse hook in `~/.gemini/config/hooks.json` that denies these
   tools only in agy processes that Pi started (`PI_ANTIGRAVITY=1`).
2. Pi rejects agy permission requests for these tools.
3. If one runs anyway, Pi cancels the turn and shows an error.

`/swarm` and `/teamwork` are refused. On start, Pi installs the hook script
in `~/.local/state/pi-antigravity/guard.sh` and adds `mcp(pi/*)` to agy's
allow list in `~/.gemini/antigravity-cli/settings.json`.

## Policy

Google permits `agy acp` on a consumer sign-in for "custom or non-editor
interactive ACP UIs … when a human user is directly driving the session"
([#1493](https://github.com/google-antigravity/antigravity-cli/issues/1493),
[T3 Code ruling](https://discuss.ai.google.dev/t/tos-clarification-is-t3-code-official-antigravity-acp-agent-permitted-under-the-antigravity-terms-of-service/192027)).
It does not permit agy as a backend worker, prompts made by another agent or
loop, or overriding agy's system identity. So this extension:

- sends only messages that you type (no retries, automatic summaries, or
  prompts from extensions, RPC, or `pi -p`),
- does not replace agy's system prompt (it adds one short note about the
  Pi UI),
- refuses Pi children on `antigravity/*` models.

**Risk you accepted:** Pi gives agy its `agent` tool over MCP. Google's
statements do not cover a client that supplies tools to agy, and they
forbid agy as a "backend worker inside a third-party coding agent". A
Pi-supplied orchestration tool is closer to that line than plain chat. It
can lead to an account suspension.

The extension also
- never reads Google credentials.

Google did not name Pi. The design follows the pattern that it permits. Use
at your own risk.

## Limits

- Pi tools, tool hooks, and the Pi system prompt do not apply to this
  provider. agy loads `AGENTS.md`, `GEMINI.md`, and its own skills.
- A branch, or a session that agy lost, starts a new agy session. Pi asks
  whether to send the visible history.
- No auto-retry and no Pi auto-compaction.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `PI_ANTIGRAVITY_COMMAND` | `agy` | The agy binary (or `agy_acp_server`) |
| `PI_ANTIGRAVITY_ARGS` | `acp` | Arguments (`--process-per-session` is added for MCP) |
| `PI_ANTIGRAVITY_AGENT_TOOL` | on | `0` turns off Pi's agent tool |
| `PI_AG_MAX_WAIT_S` | 240 | Longest `agent wait` per call |
| `PI_ANTIGRAVITY_LOG` | off | `1` writes `/tmp/pi-antigravity-<pid>.jsonl` (methods, timings, no text) |
| `PI_AG_MAX_CHILDREN` | 6 | Most children at once |
