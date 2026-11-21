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
- Permission prompts from agy open as Pi dialogs. Escape rejects.
- `/antigravity-mode default|accept-edits|auto|plan` sets agy's mode.
- `/agy <command> [args]` runs an agy slash command, for example
  `/agy goal migrate the auth module` or `/agy swarm …`.
- A message that you send during a turn goes to agy at once (agy steers).
- When agy continues by itself (a background command, subagent, or timer
  finished), Pi shows that work as a message. It does not start a Pi turn.
- `/compact` runs agy's own `/compact`. Pi's automatic compaction is off.
- `/antigravity-status` shows the CLI version, sign-in, tier, and session.

### Pi child agents (`pi-agent`)

agy can start Pi child agents on Claude or other non-Gemini models with the
`pi-agent` command (needs agent-bridge and Rex). Copy
`skills/pi-agent/SKILL.md` to `~/.agents/skills/pi-agent/` so Gemini knows
how to use it, and put `bin/` on your `PATH`. Gemini runs
`pi-agent wait NAME` as a background command, and agy's own background-task
wake continues the turn when the child finishes. Consider an agy allow rule
for `pi-agent *`.

## Policy

Google permits `agy acp` on a consumer sign-in for "custom or non-editor
interactive ACP UIs … when a human user is directly driving the session"
([#1493](https://github.com/google-antigravity/antigravity-cli/issues/1493),
[T3 Code ruling](https://discuss.ai.google.dev/t/tos-clarification-is-t3-code-official-antigravity-acp-agent-permitted-under-the-antigravity-terms-of-service/192027)).
It does not permit agy as a backend worker, prompts made by another agent or
loop, or overriding agy's system identity. So this extension:

- sends only messages that you type (no retries, automatic summaries, or
  prompts from extensions, RPC, or `pi -p`),
- gives agy no Pi tools and does not replace its system prompt (it adds
  one short note about the Pi UI),
- refuses Pi children on `antigravity/*` models,
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
| `PI_ANTIGRAVITY_ARGS` | `acp` | Arguments, for example `acp --agent reviewer` |
| `PI_ANTIGRAVITY_LOG` | off | `1` writes `/tmp/pi-antigravity-<pid>.jsonl` (methods, timings, no text) |
| `PI_AG_MAX_CHILDREN` | 6 | Most `pi-agent` children at once |
