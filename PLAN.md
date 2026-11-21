# Implementation plan: pi-antigravity

A Pi extension that registers an `antigravity` provider. It drives the
official, unmodified `agy acp` server with your Google AI subscription
(`oauth-personal`). Pi is an interactive ACP client, like Zed or T3 Code.

**agy owns the agent:** its own tools, system prompt, context, compaction,
subagents, and wakes. **Pi owns the UI:** the prompt box, the stream,
permission prompts, model and thinking pickers, and sessions. **A bridge
command** lets agy start Pi child agents (Claude and others) as background
commands, so Gemini can orchestrate them.

## 1. Policy rules (hard)

Sources: [T3 Code ruling](https://discuss.ai.google.dev/t/tos-clarification-is-t3-code-official-antigravity-acp-agent-permitted-under-the-antigravity-terms-of-service/192027)
(Oct 26), [antigravity-cli#1493](https://github.com/google-antigravity/antigravity-cli/issues/1493)
(Nov 12).

| Rule | How the code keeps it |
|---|---|
| A human drives every prompt that Pi sends | Gate: only turns from `input` with `source: "interactive"` and a UI. No retry, no auto-compaction, no branch summary, no prompts from extensions, RPC, or print mode. |
| Do not override agy's system identity | Only a short `systemPrompt.append` note about the Pi UI. |
| agy is not a backend worker | agy keeps all its tools. Pi gives agy no tools over MCP. |
| No other agent drives agy | The bridge refuses `antigravity/*` children. Pi children run on other providers. |
| No token access, no proxy | Pi never reads `~/.gemini` credentials. Auth status comes from ACP only. |

agy's own wakes (`/goal`, background tasks, background subagents,
`/schedule`) are first-party. Pi shows them and does not start them.

## 2. Facts from the probe (`spike/probe-session-new.txt`)

- `agy acp` 1.5.12, ACP protocol 1. Capabilities: `loadSession`, session
  resume/close/load/list/additionalDirectories, images, embedded context,
  `_meta.antigravity.{tier, systemPrompt.append}`.
- `session/new` returns `models` (IDs with a thinking suffix, for example
  `gemini-4-neon-high`), `modes` (`default`, `accept-edits`, `auto`, `plan`),
  `configOptions` (`model`, `thought_level`: low/medium/high/xhigh, `mode`),
  and `_meta.antigravity.tier` (`Google AI Pro`).
- Models offered to `clientInfo.name = "pi-antigravity"` include Gemini 4
  Neon/Argon/Hydrogen, Orchestrator, Gemini 3.8 Flash, Claude Opus/Sonnet
  5.5, and GPT-OSS 120B.

Still to check with real prompts (Step 7): update kinds, permission shape,
usage, steering, `/compact`, wakes with no prompt open, background command
behaviour.

## 3. Package layout

```
package.json  tsconfig.json  README.md  ARCHITECTURE.md
src/
  index.ts           extension entry: provider, events, commands
  acp/rpc.ts         NDJSON JSON-RPC over stdio (requests, notifications, server requests)
  acp/agent.ts       AgyProcess: spawn, initialize, sessions, idle stop
  provider.ts        createProvider: ambient auth check, models, stream
  models.ts          catalog from configOptions (model × thought_level)
  gate.ts            human-driven turn gate
  stream.ts          one Pi turn → session/prompt; updates → Pi events
  translate.ts       session/update → text / thinking / tool lines
  permissions.ts     request_permission → ctx.ui.select
  binding.ts         Pi session ↔ ACP sessionId; divergence detection
  wakes.ts           updates with no prompt open → Pi custom messages
  compaction.ts      session_before_compact / session_before_tree handlers
  status.ts          /antigravity-status
  log.ts             /tmp/pi-antigravity-<pid>.jsonl (0600, no prompt text)
bin/pi-agent         bridge command (Phase 2)
skills/pi-agent/SKILL.md   instructions for Gemini (Phase 2)
tests/               node --test with a fake ACP agent
spike/               probes and transcripts
```

## 4. Phase 1: the provider

### 4.1 ACP process (`acp/rpc.ts`, `acp/agent.ts`)

- Own NDJSON client (no SDK dependency). It handles responses, notifications,
  and requests from the agent (`session/request_permission`,
  `fs/read_text_file`).
- One `agy acp` process per Pi process, started on first use. Stopped on
  `session_shutdown` and after 15 minutes idle with no prompt open.
- `initialize`: protocol 1, `clientInfo {name: "pi-antigravity"}`,
  `clientCapabilities {fs: {readTextFile: true}}`. Reads limited to the cwd.
- `PI_ANTIGRAVITY_COMMAND` (default `agy`) and `PI_ANTIGRAVITY_ARGS`
  (default `acp`).

### 4.2 Auth and models (`provider.ts`, `models.ts`)

- `check()`: `initialize` + `session/new` in a scratch cwd, then
  `session/close`. Error `-32000` means "not configured", so Pi hides the
  models. The result caches the catalog.
- `oauth` metadata method with `isSubscription: true`. `login()` throws:
  "Run `agy` once to sign in."
- Model IDs: the base values of the `model` config option, for example
  `antigravity/gemini-4-neon`. Pi thinking maps to `thought_level`:
  minimal/low → low, medium → medium, high → high, xhigh → xhigh.
- Cost 0 (subscription). Context window 1M, so Pi auto-compaction rarely
  fires (it is also cancelled, see 4.7).

### 4.3 Turn gate (`gate.ts`)

- The `input` handler records `{text, source, at}`. `stream()` accepts the
  turn only when the last context message is a user message, it matches the
  recorded input, the source is `interactive`, and `ctx.hasUI` is true.
- Otherwise: error "Antigravity accepts only prompts that you type"
  (non-retryable).

### 4.4 Stream (`stream.ts`, `translate.ts`)

- Binding gives the ACP session. Set model, thinking, and mode with
  `session/set_config_option` only when they change.
- Send `session/prompt` with the user text and images. Translate updates:
  - `agent_message_chunk` → text block
  - `agent_thought_chunk` → thinking block
  - `tool_call` / `tool_call_update` → one text line per tool:
    `▸ <title> — <status>`
  - `plan` → text checklist
  - `available_commands_update` → stored for `/agy` command completion
  - `session_info_update` title → `pi.setSessionName` when unset
- `stopReason` mapping: `end_turn` → `stop`, `max_tokens` → `length`,
  `cancelled` → `aborted`, `refusal` → `error`.
- Abort signal → `session/cancel`.
- Steering: an `input` with `streamingBehavior: "steer"` while an
  Antigravity turn runs → `session/prompt` (agy treats it as a steer). Shown
  as a custom message, returns `handled`.

### 4.5 Permissions (`permissions.ts`)

- `session/request_permission` → `ctx.ui.select(title, options)`.
- Escape or no UI → the `reject_once` option or `cancelled`.
- `/antigravity-mode [default|accept-edits|auto|plan]` → the `mode` config
  option. Saved in the session.

### 4.6 Binding and wakes (`binding.ts`, `wakes.ts`)

- A custom entry `antigravity-session {sessionId, cwd}` binds the Pi branch.
  On resume, `session/resume`. On failure, start a new session.
- Divergence (the last message that agy saw is not on the current branch):
  new agy session, then `ctx.ui.confirm` "Send visible history?". Yes →
  history as text with the prompt.
- Updates that arrive with no prompt open (agy wakes): collect them until
  idle, then post one `pi.sendMessage({customType: "antigravity-wake",
  display: true})` with no `triggerTurn`. Permission requests during a wake
  go to the UI as usual.

### 4.7 Compaction (`compaction.ts`)

- `session_before_compact`, model is `antigravity`: threshold/overflow →
  cancel. Manual → run `/compact` in agy (you typed it), return Pi
  compaction with agy's reply as the summary.
- `session_before_tree` → no summary for this provider.

### 4.8 Commands

`/antigravity-status`, `/antigravity-mode`, `/agy <command> [args]` (sends
`/<command>` to agy, for example `/agy goal ...`, `/agy swarm ...`).

## 5. Phase 2: the bridge for Pi child agents

```
agy run_command (background): pi-agent wait tests-a
        │  Unix socket, token from env (agy's terminal inherits it)
        ▼
Pi parent (agent-bridge, role "cli")
        │  start / send / wait / status / stop, notify: false
        ▼
child pi in a Rex pane (claude-code/... or another non-antigravity model)
```

- `bin/pi-agent`: a Node script. Subcommands `start NAME --model M
  [--title T] [--task-file F | --task T]`, `send NAME TEXT`,
  `wait [NAME] [--timeout S]`, `status [NAME]`, `stop NAME`. Exit code is not
  zero on error.
- Pi starts `agy acp` with `PI_AG_BRIDGE` (socket path) and `PI_AG_TOKEN`.
- agent-bridge change (in `~/.dotfiles/nix/config/pi/agent/extensions/agent-bridge`):
  a `cli` role with methods that call the existing `start/send/wait/status/stop`
  logic. Children from the CLI always use `notify: false`. Models that
  start with `antigravity/` are refused.
- `skills/pi-agent/SKILL.md` tells Gemini: start, then run
  `pi-agent wait NAME` as a background command, then continue when it
  finishes.
- Suggested agy allow rule: `pi-agent *`.

## 6. Steps

1. Skeleton: package, tsconfig, git init, fake ACP agent for tests.
2. `acp/rpc.ts`, `acp/agent.ts` + tests.
3. `models.ts`, `provider.ts` (check, catalog) + tests.
4. `gate.ts`, `translate.ts`, `stream.ts`, `permissions.ts` + tests.
5. `binding.ts`, `wakes.ts`, `compaction.ts`, commands.
6. Load in Pi, manual test with a typed prompt.
7. Spike with real prompts that you type: update kinds, permissions,
   steering, `/compact`, wakes, background command.
8. Phase 2: agent-bridge `cli` role, `bin/pi-agent`, skill.
9. README with policy notes and limits, ARCHITECTURE.md.

## 7. Limits (README)

- No Pi tools for this provider (agy uses its own). No Pi system prompt.
- No auto-retry, no auto-compaction, no Pi prompts from extensions or `pi -p`.
- Branches start a new agy session.
- Pi child agents only on other providers.
- Policy: Pi is not named in Google's ruling. The design follows the pattern
  that the ruling permits.
