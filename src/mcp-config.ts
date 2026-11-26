// agy's own MCP servers, compared with Pi's, and agy's allow rules for them.
//
// - Duplicates: a server in both Pi's mcp.json and agy's mcp_config.json (the
//   same URL, or the same command and arguments) reaches agy twice: as agy's
//   own server and as Pi's `mcp__<server>__*` tools on the `pi` MCP server.
//   Pi does not forward its copy; agy keeps its own.
// - Allow rules: agy does not apply `permissions.allow` from its settings.json
//   over ACP, so it asks for every call of its own MCP tools. Pi applies the
//   `mcp(<server>/<tool>)` rules for agy (`*` matches any text). Other rule
//   forms are left to the permission dialog.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface McpPaths {
  /** agy's MCP servers */
  agyServers: string;
  /** agy's CLI settings (permissions) */
  agySettings: string;
  /** agy's cached tool schemas: <dir>/<server>/<tool>.json */
  agyToolCache: string;
  /** Pi's mcp.json files: global, then project */
  piConfigs: string[];
}

export function mcpPaths(cwd: string, home = os.homedir(), env: Record<string, string | undefined> = process.env): McpPaths {
  const agent = env.PI_CODING_AGENT_DIR || path.join(home, ".pi", "agent");
  return {
    agyServers: path.join(home, ".gemini", "config", "mcp_config.json"),
    agySettings: path.join(home, ".gemini", "antigravity-cli", "settings.json"),
    agyToolCache: path.join(home, ".gemini", "antigravity-cli", "mcp"),
    piConfigs: [path.join(agent, "mcp.json"), path.join(cwd, ".pi", "mcp.json")],
  };
}

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** One key for a server: its URL, or its command line. Same key = same server. */
export function serverKey(c: any): string | undefined {
  if (!c || typeof c !== "object") return undefined;
  const url = c.url ?? c.serverUrl ?? c.httpUrl;
  if (typeof url === "string" && url) return `url:${url.replace(/\/+$/, "")}`;
  if (typeof c.command === "string" && c.command) {
    const args = Array.isArray(c.args) ? c.args.map(String) : [];
    return `cmd:${JSON.stringify([c.command, ...args])}`;
  }
  return undefined;
}

/** agy's enabled servers, by name. */
export function agyServerKeys(file: string): Map<string, string> {
  const out = new Map<string, string>();
  const servers = readJson(file)?.mcpServers;
  if (!servers || typeof servers !== "object") return out;
  for (const [name, c] of Object.entries<any>(servers)) {
    if (c?.disabled === true) continue;
    const key = serverKey(c);
    if (key) out.set(name, key);
  }
  return out;
}

/** Pi's tool namespace for a server name: `mcp__<ns>__<tool>`. */
export const piNamespace = (name: string) => name.replace(/[^A-Za-z0-9_]/g, "_");

/** Pi's servers, by name: the mcp.json files (a later file wins), then registered servers. */
export function piServerKeys(files: string[], registered: { name: string; config: unknown }[] = []): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of files) {
    const servers = readJson(f)?.mcpServers;
    if (!servers || typeof servers !== "object") continue;
    for (const [name, c] of Object.entries<any>(servers)) {
      const key = c?.enabled === false ? undefined : serverKey(c);
      if (key) out.set(name, key);
      else out.delete(name);
    }
  }
  for (const s of registered) {
    if (out.has(s.name)) continue; // a mcp.json server takes precedence
    const key = serverKey(s.config);
    if (key) out.set(s.name, key);
  }
  return out;
}

/** Tool name prefixes (`mcp__<ns>__`) of Pi's servers that agy also has. */
export function duplicatePrefixes(pi: Map<string, string>, agy: Map<string, string>): string[] {
  const agyKeys = new Set(agy.values());
  return [...pi].filter(([, key]) => agyKeys.has(key)).map(([name]) => `mcp__${piNamespace(name)}__`);
}

// ---- agy's allow rules ----

export interface McpRule {
  server: RegExp;
  tool: RegExp;
}

const glob = (s: string) => new RegExp(`^${s.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);

/** The `mcp(server/tool)` rules of a list. Other forms are ignored. */
export function mcpRules(list: unknown): McpRule[] {
  if (!Array.isArray(list)) return [];
  const out: McpRule[] = [];
  for (const r of list) {
    const m = typeof r === "string" ? /^mcp\(([^/()\s]+)\/([^/()\s]+)\)$/.exec(r.trim()) : null;
    if (m) out.push({ server: glob(m[1]), tool: glob(m[2]) });
  }
  return out;
}

export interface AgyRules {
  allow: McpRule[];
  deny: McpRule[];
}

export function readAgyRules(file: string): AgyRules {
  const p = readJson(file)?.permissions;
  return { allow: mcpRules(p?.allow), deny: mcpRules([...(Array.isArray(p?.deny) ? p.deny : []), ...(Array.isArray(p?.ask) ? p.ask : [])]) };
}

const hits = (rules: McpRule[], server: string, tool: string) => rules.some((r) => r.server.test(server) && r.tool.test(tool));

/** True when agy's rules allow the call, and no deny or ask rule matches. */
export function allowedByRules(rules: AgyRules, server: string, tool: string): boolean {
  return hits(rules.allow, server, tool) && !hits(rules.deny, server, tool);
}

/** The agy server that has `tool`, from agy's tool cache. Undefined when none or more than one. */
export function serverOfTool(cacheDir: string, tool: string): string | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(tool)) return undefined;
  let names: string[] = [];
  try {
    names = fs.readdirSync(cacheDir);
  } catch {
    return undefined;
  }
  const found = names.filter((s) => s !== "pi" && fs.existsSync(path.join(cacheDir, s, `${tool}.json`)));
  return found.length === 1 ? found[0] : undefined;
}

const str = (v: unknown) => (typeof v === "string" ? v.replace(/^"|"$/g, "") : undefined);

/** The server and tool of a call of one of agy's own MCP tools, or undefined. */
export function agyMcpCall(t: { title?: string; rawInput?: unknown }, cacheDir: string): { server: string; tool: string } | undefined {
  const raw = (t.rawInput ?? {}) as Record<string, unknown>;
  const server = str(raw.ServerName ?? raw.serverName ?? raw.server);
  const toolName = str(raw.ToolName ?? raw.toolName ?? raw.tool);
  if (server && toolName && server !== "pi") return { server, tool: toolName };
  const m = /^(?:Run(?:ning)? )?MCP [Tt]ool:? (?:([A-Za-z0-9_-]+)\/)?([A-Za-z0-9_-]+)\??$/.exec((t.title ?? "").trim());
  if (!m) return undefined;
  const tool = m[2];
  const s = m[1] ?? serverOfTool(cacheDir, tool);
  return s && s !== "pi" ? { server: s, tool } : undefined;
}
