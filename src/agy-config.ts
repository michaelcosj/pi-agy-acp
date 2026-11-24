// Clean-up of pi-antigravity's earlier changes to agy's own config:
// - the `mcp(pi/*)` allow rule in ~/.gemini/antigravity-cli/settings.json
//   (agy ignores allow rules for MCP tools over ACP; Pi approves its own
//   agent tool instead, see Runtime.permission);
// - the old subagent-deny hook in ~/.gemini/config/hooks.json.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const MCP_ALLOW_RULE = "mcp(pi/*)";
const OLD_HOOK = "pi-antigravity-guard";

export interface AgyPaths {
  settingsJson: string;
  hooksJson: string;
  oldStateDir: string;
}

export function agyPaths(home = os.homedir()): AgyPaths {
  return {
    settingsJson: path.join(home, ".gemini", "antigravity-cli", "settings.json"),
    hooksJson: path.join(home, ".gemini", "config", "hooks.json"),
    oldStateDir: path.join(process.env.XDG_STATE_HOME || path.join(home, ".local", "state"), "pi-antigravity"),
  };
}

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e: any) {
    if (e?.code === "ENOENT") return undefined;
    throw new Error(`cannot read ${file}: ${e.message}`);
  }
}

function writeJson(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.pi-antigravity.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** Removes the old allow rule and hook. Returns what it changed. */
export function updateAgyConfig(p: AgyPaths): string[] {
  const changed: string[] = [];
  const settings = readJson(p.settingsJson);
  const allow: unknown = settings?.permissions?.allow;
  if (Array.isArray(allow) && allow.includes(MCP_ALLOW_RULE)) {
    settings.permissions.allow = allow.filter((x) => x !== MCP_ALLOW_RULE);
    if (!settings.permissions.allow.length) delete settings.permissions.allow;
    if (!Object.keys(settings.permissions).length) delete settings.permissions;
    writeJson(p.settingsJson, settings);
    changed.push(`${p.settingsJson}: removed ${MCP_ALLOW_RULE} (agy ignores it over ACP)`);
  }
  const hooks = readJson(p.hooksJson);
  if (hooks && typeof hooks === "object" && OLD_HOOK in hooks) {
    delete hooks[OLD_HOOK];
    if (Object.keys(hooks).length) writeJson(p.hooksJson, hooks);
    else fs.rmSync(p.hooksJson, { force: true });
    changed.push(`${p.hooksJson}: removed the old ${OLD_HOOK} hook`);
  }
  if (fs.existsSync(path.join(p.oldStateDir, "guard.sh"))) {
    fs.rmSync(path.join(p.oldStateDir, "guard.sh"), { force: true });
    try {
      fs.rmdirSync(p.oldStateDir);
    } catch {}
  }
  return changed;
}

/** agy's ACP title for a call of a tool on Pi's MCP server: "Run mcp_pi_<tool>". */
const PI_TOOL_TITLE = /^Run(?:ning)? mcp_pi_[A-Za-z0-9_-]+\??$/;
export function isPiTool(t: { title?: string }): boolean {
  return PI_TOOL_TITLE.test((t.title ?? "").trim());
}

const SUBAGENT_TITLE = /\b(invoke_subagent|start_subagent)\b/;

/** An ACP tool call that starts an agy subagent. */
export function isSubagentTool(t: { title?: string; name?: string; rawInput?: unknown }): boolean {
  return SUBAGENT_TITLE.test(t.title ?? "") || SUBAGENT_TITLE.test((t as any).name ?? "");
}
