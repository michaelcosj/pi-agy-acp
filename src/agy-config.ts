// pi-antigravity's changes to agy's own config:
// - adds `mcp(pi/*)` to agy's allow list, so Pi's agent tool runs without a
//   permission prompt in auto mode;
// - removes the old subagent-deny hook (pi-antigravity 0.1 before this
//   change installed it; T3 Code turns off its Antigravity text generation
//   when ~/.gemini/config/hooks.json has hooks).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PI_ENV = "PI_ANTIGRAVITY";
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

export function mcpAllowed(p: AgyPaths): boolean {
  try {
    return (readJson(p.settingsJson)?.permissions?.allow ?? []).includes(MCP_ALLOW_RULE);
  } catch {
    return false;
  }
}

/** Adds the allow rule and removes the old hook. Returns what it changed. */
export function updateAgyConfig(p: AgyPaths): string[] {
  const changed: string[] = [];
  if (!mcpAllowed(p)) {
    const settings = readJson(p.settingsJson) ?? {};
    settings.permissions ??= {};
    const allow: string[] = (settings.permissions.allow ??= []);
    allow.push(MCP_ALLOW_RULE);
    writeJson(p.settingsJson, settings);
    changed.push(`${p.settingsJson}: added ${MCP_ALLOW_RULE}`);
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

const SUBAGENT_TITLE = /\b(invoke_subagent|start_subagent)\b/;

/** An ACP tool call that starts an agy subagent. */
export function isSubagentTool(t: { title?: string; name?: string; rawInput?: unknown }): boolean {
  return SUBAGENT_TITLE.test(t.title ?? "") || SUBAGENT_TITLE.test((t as any).name ?? "");
}
