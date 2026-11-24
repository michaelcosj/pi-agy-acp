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
- **Workspace folders:** agy asks before it touches files outside its workspace. A child agent's folder (for example its worktree) joins the workspace at the next turn. For a file outside the workspace, the dialog also offers "Allow <repo> for this session" and "Always allow <parent folder>". `/antigravity-status` shows the extra folders.
- **agy commands:** `/agy <command> [args]`, for example `/agy goal …`. `/compact` runs agy's own compaction.
- **Background work:** when agy continues by itself, Pi shows the result as a message.
- **Pi child agents:** Gemini gets Pi's `agent` tool over a local MCP server. It can start, message, wait for, and stop Pi child agents on other providers. A child's result starts a new Gemini turn. Needs [agent-bridge](https://github.com/michaelcosj/dotfiles/tree/main/nix/config/pi/agent/extensions/agent-bridge) and Rex.
- **agy subagents:** agy's own subagents show as read-only `agy-<role>` rows in the agent list. `/agy-subagents` lists them.
- **Status:** `/antigravity-status` shows sign-in, tier, quota, session, automatic turns, and subagents.
- **Suspension stop:** when Google's suspension notice arrives, all Antigravity turns and child agents stop.

## How it works

Pi starts `agy acp` and talks to it over the Agent Client Protocol, as Zed and T3 Code do. agy owns the agent: tools, system prompt, context, and subagents. Pi is the UI. Pi does not read your Google credentials and does not call Google's APIs.

Each Pi session keeps one agy session. A branch, or a session that agy lost, starts a new agy session, and Pi asks whether to send the earlier messages.

Turns that you did not type, such as a child's result, use a budget (2 per typed message). Pi children may not use `antigravity/*` models.

Pi's own tools, tool hooks, and system prompt do not apply to these models. agy reads `AGENTS.md`, `GEMINI.md`, and its own skills.

## Compared with T3 Code

[T3 Code](https://github.com/pingdotgg/t3code) is a popular ACP client for agy. pi-agy-acp does nothing toward agy or Google that T3 Code does not also do, with one exception: the quota (see below). The table lists each thing that Pi sends to agy or starts. It was checked against T3 Code's source in November 2026.

| pi-agy-acp | T3 Code |
|---|---|
| Starts `agy acp` | Same, with its own profile flags |
| `initialize`: can read files; no file writes, no terminal | Same capabilities |
| `session/new` with the cwd, one MCP server (a stdio bridge to Pi's `agent` tool), and a short `systemPrompt.append` | Same: its `t3-code` MCP server and a system prompt append |
| `session/resume`, `session/close` | Same, and also `session/load`, `fork`, and `list` |
| `additionalDirectories` on new and resume; a change restarts agy between turns | Same: tracked folders and worktrees, sent on new, resume, load, and fork |
| `set_config_option`: `mode=auto`, `model`, `thought_level` at each turn | Same |
| `session/prompt` with text, images, and files; a prompt during a turn as a steer | Same, also audio and PDF links |
| `session/cancel` on Escape | Same, then `session/close` |
| A scratch session in a temp folder to read the model list | Same (`t3-antigravity-setup-*`) |
| Earlier Pi messages as text in a new session, after you confirm | Same "context handoff", with no question |
| Approves its own MCP tool, shows a dialog for all else | Approves its own MCP tools; in full access, approves all |
| Reads agy's subagent records and transcripts on disk (read-only) | Same, also agy's SQLite files, and deletes old session files |
| A child's result starts a turn (at most 2 per message that you type) | Same, and also "continue" after errors and after a limit reset, with no fixed limit |
| agy's own background output is only shown | Same |
| `/compact` and `/agy <command>` send slash text as a prompt | Same |
| **Quota: runs `agy -p "/usage"`** | **Reads agy's OAuth token and calls Google's quota API (`cloudcode-pa…/v1internal`) with an Antigravity user agent** |

The quota is the one difference. Pi runs agy's own CLI command, which you can also type yourself. Pi does not read agy's credentials and does not call Google's APIs. T3 Code's method reads more.

T3 Code also does things that Pi does not do: its own sign-in flow, a `zed` client name for old agy versions, a download and update of agy, and extra agy prompts in hidden sessions (for example, for commit messages).

This comparison does not make either client safe. Google's terms still apply, and T3 Code users were suspended too.

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
| `PI_ANTIGRAVITY_CONFIG` | `~/.pi/agent/pi-agy-acp.json` | File with the "always" folders (`additionalDirectories`) |

## License

MIT
