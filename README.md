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
- **Cost:** Pi counts an API-equivalent cost: the turn's tokens at the model maker's API price (Google for Gemini, Anthropic for Claude). You pay a subscription, so this is not a bill. The price comes from Pi's model registry. When the registry has no price for a model, pi-agy-acp gets Pi's catalog from pi.dev, once a day (`~/.pi/agent/state/pi-agy-acp-prices.json`). GPT-OSS has no price and shows $0.
- **Steering:** a message that you send during a turn goes to agy at once.
- **Permissions:** agy runs in auto mode. Its permission prompts open as Pi dialogs. agy ignores the allow rules in its `settings.json` over ACP, so Pi applies agy's `mcp(<server>/<tool>)` rules for agy's own MCP tools (`*` matches any text; `deny` and `ask` rules win). Other rule forms still ask.
- **Workspace folders:** agy asks before it touches files outside its workspace. A child agent's folder joins the workspace at the next turn. For a linked git worktree, the folder that holds it joins (for example `~/.local/share/worktrees/<project>`), so new worktrees of the project do not change the list. Each change restarts agy, and agy loses its prompt cache. In the sandbox, agy can then read and write all worktrees in that folder. For a file outside the workspace, the dialog also offers "Allow <repo or worktree folder> for this session" and "Always allow <parent folder>". `/antigravity-status` shows the extra folders.
- **agy commands:** `/agy <command> [args]`, for example `/agy goal …`. `/compact` runs agy's own compaction, and Pi shows agy's summary as a collapsed compaction entry.
- **Background work:** when agy continues by itself, Pi shows the result as a message.
- **Pi's tools:** Gemini can call Pi's tools and your extensions' tools, for example `questionnaire`, `web_search`, MCP tools, or an `agent` tool. See [Pi's tools](#pis-tools).
- **agy subagents:** agy's own subagents and swarm members show as read-only `agy-<role>` rows in the agent list. Subagents that agy stopped (killed) are not in the list. Enter on a row opens the subagent's transcript in a Rex floating pane that follows new steps (`q` closes it); outside Rex, it opens in Pi. `/agy-subagents` lists all of them, also the stopped ones.
- **Instructions:** agy reads the project's `AGENTS.md` and `GEMINI.md` itself. It does not read Pi's global `~/.pi/agent/AGENTS.md`. agy's global rules are in `~/.gemini/AGENTS.md` (or `~/.gemini/GEMINI.md`, or `~/.gemini/config/rules/`). To use one file for both: `ln -s ~/.pi/agent/AGENTS.md ~/.gemini/AGENTS.md`.
- **Tool status:** the `agy: <tool>` line below the editor shows the agy tool that runs now. It clears when the tool ends.
- **Status:** `/antigravity-status` shows sign-in, tier, quota, session, automatic turns, and subagents.
- **Suspension stop:** when Google's suspension notice arrives, all Antigravity turns and Pi tool calls from agy stop.

## Pi's tools

agy gets each active Pi tool on a local MCP server named `pi`. agy gets the list when it opens the session (at start, and when it restarts, for example after a folder change or 15 minutes idle). The list stays the same while agy runs, because a new tool list makes agy lose its prompt cache. A tool that you turn on later reaches agy after its next restart.

These tools are not sent:

- Pi's file and shell tools (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`). agy has its own versions.
- `codemode`. It would get around the sandbox.
- `tool_search`. The tools that it loads reach agy only after a restart.
- Tools of a Pi MCP server that agy also has in `~/.gemini/config/mcp_config.json` (the same URL, or the same command and arguments). agy uses its own server.
- The names in `PI_ANTIGRAVITY_EXCLUDE_TOOLS`.

A call works in four steps:

1. agy calls a Pi tool, for example `questionnaire`.
2. pi-agy-acp stops agy's turn with `session/cancel`. agy makes no more model requests in that turn.
3. Pi runs the tool as a normal tool call, with its UI, tool hooks, and permission checks. The call shows in Pi as a usual tool row.
4. The next prompt sends the result to agy. This turn does not use the budget for automatic turns.

agy's permission prompt for a Pi tool is approved at once, because Pi does its own checks when it runs the tool. A child agent that agy starts with an `agent` tool must have a `provider/model` that is not `antigravity/*`.

## Sandbox (Linux)

Set `PI_ANTIGRAVITY_SANDBOX=bwrap`, or `"sandbox": "bwrap"` in `~/.pi/agent/pi-agy-acp.json`, to run agy and every command that it starts inside [bubblewrap](https://github.com/containers/bubblewrap). agy then sees:

| What | Access |
|---|---|
| `/usr`, `/etc`, `/nix`, your `PATH` folders and their install folders, git config | read-only |
| The workspace: the cwd, the extra folders, and the git folders of worktrees | read-write |
| `~/.gemini`, `~/.config/antigravity`, `~/.cache/antigravity` | read-write |
| The rest of your home (`~/.ssh`, `~/.pi/agent/auth.json`, other projects), the host `/tmp` | not there |
| Env vars with `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, or `CREDENTIAL` in the name, and `SSH_AUTH_SOCK` | removed |
| The desktop keyring (agy's sign-in) | through `xdg-dbus-proxy`, only `org.freedesktop.secrets`. The filter allows the whole service, so agy can also ask for other secrets in the keyring |
| Network | the same as the host, so agy's traffic to Google does not change |

Inside the sandbox, agy gets a copy of its settings with `enableTerminalSandbox: false`. agy's own terminal sandbox cannot start a Nix-built agy, and bwrap already contains every agy process. The host agy and its settings do not change. A change of the cwd or the extra folders restarts agy between turns with the new mounts.

Add folders in `~/.pi/agent/pi-agy-acp.json`: `"sandboxReadOnly": ["~/tools"]`, `"sandboxReadWrite": ["/data"]`. Needs `bwrap` and `xdg-dbus-proxy` (Fedora installs both with Flatpak).

### Project config

A project can have its own `.pi/pi-agy-acp.json`. pi-agy-acp reads it only when Pi trusts the project. It adds to the user config, and it can have:

- `additionalDirectories`: folders that are always in agy's workspace for this project. In the sandbox, they are mounted read-write.
- `sandboxReadOnly` and `sandboxReadWrite`: extra sandbox folders.

Paths can start with `~/` or be relative to the project. A project config cannot turn the sandbox on or off. Example for a project whose worktrees are in `~/.local/share/worktrees/<project>`:

```json
{ "additionalDirectories": ["~/.local/share/worktrees/kojama"] }
```

When agy makes a worktree outside its workspace in the sandbox, the files go to the sandbox's temporary home and are lost when agy stops. Add the worktree folder as above.

### GitHub CLI in the sandbox

`gh` does not work in the sandbox by default: `~/.config/gh` is not there, so `gh` says `gh auth login`. To let agy use your GitHub account, add the folder as read-only:

```json
{ "sandbox": "bwrap", "sandboxReadOnly": ["~/.config/gh"] }
```

`gh` then gets its token from the keyring (through the same D-Bus proxy) or from `hosts.yml`. Restart Pi after the change.

## How it works

Pi starts `agy acp` and talks to it over the Agent Client Protocol, as Zed and T3 Code do. agy owns the agent: tools, system prompt, context, and subagents. Pi is the UI. Pi does not read your Google credentials and does not call Google's APIs.

Each Pi session keeps one agy session. A branch, or a session that agy lost, starts a new agy session, and Pi asks whether to send the earlier messages.

Turns that you did not type, such as a child's result, use a budget (2 per typed message). The result of a Pi tool that agy called does not use the budget. Pi children may not use `antigravity/*` models.

agy uses its own file and shell tools and its own system prompt. Pi's system prompt and Pi's tool hooks for those tools do not apply. Pi's other tools do apply (see [Pi's tools](#pis-tools)). agy reads `AGENTS.md`, `GEMINI.md`, and its own skills.

## Compared with T3 Code

[T3 Code](https://github.com/pingdotgg/t3code) is a popular ACP client for agy. pi-agy-acp does nothing toward agy or Google that T3 Code does not also do, with one exception: the quota (see below). The table lists each thing that Pi sends to agy or starts. It was checked against T3 Code's source in November 2026.

| pi-agy-acp | T3 Code |
|---|---|
| Starts `agy acp` (optionally inside a local bubblewrap sandbox, which does not change agy's network traffic) | Same, with its own profile flags |
| `initialize`: can read files; no file writes, no terminal | Same capabilities |
| `session/new` with the cwd, one MCP server (a stdio bridge to Pi's tools), and a short `systemPrompt.append` | Same: its `t3-code` MCP server and a system prompt append |
| `session/resume`, `session/close` | Same, and also `session/load`, `fork`, and `list` |
| `additionalDirectories` on new and resume; a change restarts agy between turns | Same: tracked folders and worktrees, sent on new, resume, load, and fork |
| `set_config_option`: `mode=auto`, `model`, `thought_level` at each turn | Same |
| `session/prompt` with text, images, and files; a prompt during a turn as a steer | Same, also audio and PDF links |
| `session/cancel` on Escape, and when agy calls a Pi tool (Pi runs the tool, and the result is the next prompt) | Same on Escape, then `session/close`; its MCP tools answer in the same turn |
| A scratch session in a temp folder to read the model list | Same (`t3-antigravity-setup-*`) |
| Earlier Pi messages as text in a new session, after you confirm | Same "context handoff", with no question |
| Approves its own MCP tools, shows a dialog for all else | Approves its own MCP tools; in full access, approves all |
| Reads agy's subagent records and transcripts on disk (read-only) | Same, also agy's SQLite files, and deletes old session files |
| A child's result starts a turn (at most 2 per message that you type) | Same, and also "continue" after errors and after a limit reset, with no fixed limit |
| agy's own background output is only shown | Same |
| `/compact` and `/agy <command>` send slash text as a prompt | Same |
| **Quota: runs `agy -p "/usage"`** | **Reads agy's OAuth token and calls Google's quota API (`cloudcode-pa…/v1internal`) with an Antigravity user agent** |

The quota is the one difference. Pi runs agy's own CLI command, which you can also type yourself. Pi does not read agy's credentials and does not call Google's APIs. T3 Code's method reads more.

T3 Code also does things that Pi does not do: its own sign-in flow, a `zed` client name for old agy versions, a download and update of agy, and extra agy prompts in hidden sessions (for example, for commit messages).

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `PI_ANTIGRAVITY_COMMAND` | `agy` | The agy binary |
| `PI_ANTIGRAVITY_ARGS` | `acp` | Arguments for the agy binary |
| `PI_ANTIGRAVITY_AUTO_TURNS` | `2` | Turns that you did not type, per typed message (`0` turns them off) |
| `PI_ANTIGRAVITY_PI_TOOLS` | on | `0` gives agy none of Pi's tools |
| `PI_ANTIGRAVITY_EXCLUDE_TOOLS` | none | More Pi tools that agy does not get, comma-separated (for example `agent,web_search`) |
| `PI_ANTIGRAVITY_LOG` | off | `1` writes `/tmp/pi-antigravity-<pid>.jsonl` (no message text) |
| `PI_ANTIGRAVITY_CONFIG` | `~/.pi/agent/pi-agy-acp.json` | File with the "always" folders (`additionalDirectories`) and the sandbox settings |
| `PI_ANTIGRAVITY_SANDBOX` | `off` | `bwrap` runs agy in bubblewrap (see Sandbox) |

## License

MIT
