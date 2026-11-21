# pi-agy-acp

Use Antigravity (Gemini) models in [Pi](https://github.com/earendil-works/pi) on your Google AI subscription, through the official `agy acp` server.

> [!WARNING]
> **This can get your account suspended.** Google's FAQ says that wrapping `agy` inside third-party coding agents is not supported on consumer plans. Since November 2026, users of ACP clients (including T3 Code) report `403 TOS_VIOLATION` suspensions. A suspension blocks Antigravity on the account everywhere, and Google allows one appeal. Use an account that you can afford to lose. Use at your own risk.

## Install

```sh
pi install git:github.com/michaelcosj/pi-agy-acp
agy                                   # sign in once with Google
pi --model antigravity/gemini-4-neon
```

Needs Node 22.19+, the `agy` CLI, and an interactive Pi session. Print and RPC mode are not supported.

## Features

- **Models:** every model that agy offers (`antigravity/*`), with thinking levels, in Pi's model picker.
- **Streaming:** text, thinking, one line per tool call, token usage, and session titles. Escape cancels.
- **Steering:** a message that you send during a turn goes to agy at once.
- **Permissions:** agy runs in auto mode. Its permission prompts open as Pi dialogs.
- **agy commands:** `/agy <command> [args]`, for example `/agy goal …`. `/compact` runs agy's own compaction.
- **Background work:** when agy continues by itself, Pi shows the result as a message.
- **Pi child agents:** Gemini gets Pi's `agent` tool over a local MCP server. It can start, message, wait for, and stop Pi child agents on other providers. A child's result starts a new Gemini turn. Needs [agent-bridge](https://github.com/michaelcosj/dotfiles/tree/main/nix/config/pi/agent/extensions/agent-bridge) and Rex.
- **agy subagents:** agy's own subagents show as read-only `agy-<role>` rows in the agent list. `/agy-subagents` lists them.
- **Status:** `/antigravity-status` shows sign-in, tier, quota, session, automatic turns, and subagents.
- **Suspension stop:** when Google's suspension notice arrives, all Antigravity turns and child agents stop.

## How it works

Pi starts `agy acp --process-per-session` and talks to it over the Agent Client Protocol, as Zed and T3 Code do. agy owns the agent: tools, system prompt, context, and subagents. Pi is the UI. Pi does not read your Google credentials and does not call Google's APIs.

Each Pi session keeps one agy session. A branch, or a session that agy lost, starts a new agy session, and Pi asks whether to send the earlier messages.

Turns that you did not type, such as a child's result, use a budget (2 per typed message). Pi children may not use `antigravity/*` models.

Pi's own tools, tool hooks, and system prompt do not apply to these models. agy reads `AGENTS.md`, `GEMINI.md`, and its own skills.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `PI_ANTIGRAVITY_COMMAND` | `agy` | The agy binary |
| `PI_ANTIGRAVITY_ARGS` | `acp` | Arguments for the agy binary |
| `PI_ANTIGRAVITY_AUTO_TURNS` | `2` | Turns that you did not type, per typed message (`0` turns them off) |
| `PI_ANTIGRAVITY_AGENT_TOOL` | on | `0` turns off the `agent` tool |
| `PI_AG_MAX_CHILDREN` | `6` | Most child agents at once |
| `PI_AG_MAX_WAIT_S` | `240` | Longest `agent wait` per call |
| `PI_ANTIGRAVITY_LOG` | off | `1` writes `/tmp/pi-antigravity-<pid>.jsonl` (no message text) |

## License

MIT
