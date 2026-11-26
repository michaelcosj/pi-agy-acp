// Pi's tools for agy: every active Pi tool except Pi's file and shell tools
// (agy has its own) and codemode. agy sees them on the `pi` MCP server.
import { getCurrentTools } from "@earendil-works/pi-ai";

export interface PiToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Pi's default tools, which agy has its own versions of, codemode, and
 *  tool_search (agy gets the tools that it loads only at its next restart, see
 *  Runtime.offerTools, so a search result would name tools that agy lacks). */
export const EXCLUDED = new Set(["read", "bash", "edit", "write", "grep", "find", "ls", "codemode", "tool_search"]);
const NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** The message that agy gets for a Pi tool call; the result comes in the next prompt. */
export const runningText = (name: string) => `Running ${name}; result arrives in next message.`;

/** The text of a Pi tool result in the next prompt to agy. */
export function resultText(name: string, isError: boolean, text: string): string {
  return `${isError ? "Error from" : "Result of"} ${name}:\n${text}`;
}

function withoutNullVariant(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(withoutNullVariant);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) out[k] = withoutNullVariant(v);
  if (Array.isArray(out.type) && out.type.includes("null")) {
    const rest = (out.type as unknown[]).filter((t) => t !== "null");
    out.type = rest.length === 1 ? rest[0] : rest;
  }
  if (Array.isArray(out.anyOf)) {
    const nonNull = (out.anyOf as any[]).filter((b) => !(b && typeof b === "object" && b.type === "null"));
    if (nonNull.length === 1 && nonNull.length !== (out.anyOf as unknown[]).length) {
      delete out.anyOf;
      if (nonNull[0] && typeof nonNull[0] === "object") Object.assign(out, nonNull[0]);
    }
  }
  return out;
}

/** A JSON schema that MCP clients accept: plain JSON, an object at the top. */
export function inputSchema(schema: unknown): Record<string, unknown> {
  let plain: unknown;
  try {
    plain = JSON.parse(JSON.stringify(schema ?? {}));
  } catch {
    plain = {};
  }
  const s = withoutNullVariant(plain) as Record<string, unknown>;
  if (s.type !== "object") return { type: "object", properties: {} };
  if (!s.properties || typeof s.properties !== "object") s.properties = {};
  return s;
}

/** Names from PI_ANTIGRAVITY_EXCLUDE_TOOLS (comma-separated), added to EXCLUDED. */
export function excludedTools(env: Record<string, string | undefined> = process.env): Set<string> {
  const extra = (env.PI_ANTIGRAVITY_EXCLUDE_TOOLS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return new Set([...EXCLUDED, ...extra]);
}

/** The Pi tools for agy from a model call's context. */
/** `drop`: name prefixes to leave out (Pi's MCP servers that agy also has). */
export function piToolsFrom(
  context: { messages?: readonly { role: string }[]; tools?: readonly any[] },
  exclude = excludedTools(),
  drop: readonly string[] = [],
): PiToolDef[] {
  let tools: readonly any[] = [];
  try {
    tools = context.messages ? getCurrentTools(context.messages) : [];
  } catch {}
  if (!tools.length && Array.isArray(context.tools)) tools = context.tools;
  const out: PiToolDef[] = [];
  const seen = new Set<string>();
  for (const t of tools) {
    if (!t || typeof t.name !== "string" || !NAME.test(t.name) || exclude.has(t.name) || seen.has(t.name)) continue;
    if (drop.some((p) => t.name.startsWith(p))) continue;
    seen.add(t.name);
    out.push({ name: t.name, description: String(t.description ?? ""), inputSchema: inputSchema(t.parameters) });
  }
  return out;
}
