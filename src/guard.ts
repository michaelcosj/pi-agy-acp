// Subagent and swarm deny. agy has no per-session switch for these tools, so
// pi-antigravity enforces the deny in three layers:
//   1. an agy PreToolUse hook in agy's global hooks.json that denies the
//      tools only when the agy process has PI_ANTIGRAVITY=1 (set by Pi), so
//      your other agy sessions are not affected;
//   2. Pi rejects agy permission requests for these tools;
//   3. Pi cancels the turn if one of these tools runs anyway.
// Pi also refuses /swarm and /teamwork, which only start swarms.
// The installer also adds `mcp(pi/*)` to agy's allow list, so Pi's agent tool
// runs in auto mode without a prompt.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const GUARD_NAME = "pi-antigravity-guard";
export const PI_ENV = "PI_ANTIGRAVITY";
export const MCP_ALLOW_RULE = "mcp(pi/*)";

/** agy's subagent and swarm tools. */
export const DENIED_TOOL_RE = /^(invoke_subagent|start_subagent|define_subagent|manage_subagents|send_message|swarm_\w+|read_board|board_\w+)$/;
/** The same tools inside an ACP tool-call title, for example "Running invoke_subagent". */
const DENIED_TITLE_RE = /\b(invoke_subagent|start_subagent|define_subagent|manage_subagents|swarm_[a-z_]+|read_board|board_post|board_head)\b/;
/** agy slash commands that only start subagents or swarms. */
export const DENIED_COMMANDS = new Set(["swarm", "teamwork"]);

export const DENY_REASON = "Subagents and swarms are turned off in Pi. Do the work yourself, or delegate to Pi child agents with the pi agent tool.";

export interface GuardPaths {
  stateDir: string;
  hookScript: string;
  hooksJson: string;
  settingsJson: string;
}

export function guardPaths(home = os.homedir()): GuardPaths {
  const stateDir = path.join(process.env.XDG_STATE_HOME || path.join(home, ".local", "state"), "pi-antigravity");
  return {
    stateDir,
    hookScript: path.join(stateDir, "guard.sh"),
    hooksJson: path.join(home, ".gemini", "config", "hooks.json"),
    settingsJson: path.join(home, ".gemini", "antigravity-cli", "settings.json"),
  };
}

export function hookScript(): string {
  const tools = DENIED_TOOL_RE.source.slice(2, -2); // the alternation inside ^(...)$
  return `#!/bin/sh
# ${GUARD_NAME}: denies agy subagent and swarm tools in agy processes started
# by Pi (${PI_ENV}=1). Installed by pi-antigravity. Other agy sessions: "allow".
in=$(cat)
if [ "$${PI_ENV}" = 1 ]; then
  name=$(printf '%s' "$in" | tr -d '\\n' | grep -oE '"toolCall"[[:space:]]*:[[:space:]]*\\{[^}]*"name"[[:space:]]*:[[:space:]]*"[^"]+"' | head -n 1 | sed -E 's/.*"([^"]+)"$/\\1/')
  if printf '%s' "$name" | grep -qE '^(${tools})$'; then
    printf '{"decision":"deny","reason":"${DENY_REASON}"}\\n'
    exit 0
  fi
fi
printf '{"decision":"allow"}\\n'
`;
}

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e: any) {
    if (e?.code === "ENOENT") return {};
    throw new Error(`cannot read ${file}: ${e.message}`);
  }
}

function writeJson(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.pi-antigravity.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

export interface GuardStatus {
  hook: boolean;
  script: boolean;
  mcpAllow: boolean;
}

export function guardStatus(p: GuardPaths): GuardStatus {
  let hook = false;
  let mcpAllow = false;
  try {
    const entry = readJson(p.hooksJson)?.[GUARD_NAME];
    hook = !!entry && entry.enabled !== false && JSON.stringify(entry).includes(p.hookScript);
    mcpAllow = (readJson(p.settingsJson)?.permissions?.allow ?? []).includes(MCP_ALLOW_RULE);
  } catch {}
  let script = false;
  try {
    script = fs.readFileSync(p.hookScript, "utf8") === hookScript();
  } catch {}
  return { hook, script, mcpAllow };
}

/** Installs or repairs the hook and the allow rule. Returns what it changed. */
export function installGuard(p: GuardPaths): string[] {
  const changed: string[] = [];
  const s = guardStatus(p);
  if (!s.script) {
    fs.mkdirSync(p.stateDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(p.hookScript, hookScript(), { mode: 0o755 });
    fs.chmodSync(p.hookScript, 0o755);
    changed.push(p.hookScript);
  }
  if (!s.hook) {
    const hooks = readJson(p.hooksJson);
    hooks[GUARD_NAME] = { enabled: true, PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: p.hookScript, timeout: 10 }] }] };
    writeJson(p.hooksJson, hooks);
    changed.push(p.hooksJson);
  }
  if (!s.mcpAllow) {
    const settings = readJson(p.settingsJson);
    settings.permissions ??= {};
    const allow: string[] = (settings.permissions.allow ??= []);
    if (!allow.includes(MCP_ALLOW_RULE)) allow.push(MCP_ALLOW_RULE);
    writeJson(p.settingsJson, settings);
    changed.push(`${p.settingsJson} (${MCP_ALLOW_RULE})`);
  }
  return changed;
}

/** The denied agy tool in an ACP tool call, if any. */
export function deniedTool(t: { title?: string; kind?: string; rawInput?: unknown }): string | undefined {
  const m = DENIED_TITLE_RE.exec(t.title ?? "");
  if (m) return m[1];
  const raw = t.rawInput as any;
  if (raw && typeof raw === "object" && Array.isArray(raw.Subagents)) return "invoke_subagent";
  return undefined;
}

/** The command name of a prompt that starts with /name, if denied. */
export function deniedCommand(text: string): string | undefined {
  const m = /^\s*\/([a-z][\w-]*)/i.exec(text);
  return m && DENIED_COMMANDS.has(m[1].toLowerCase()) ? m[1] : undefined;
}
