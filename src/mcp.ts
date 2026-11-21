// In-process MCP server (streamable HTTP on 127.0.0.1) that gives agy Pi's
// `agent` tool. agy connects to it through `session/new.mcpServers`. Calls
// go to agent-bridge over the Pi event bus ("agent-bridge:call").
//
// You chose this over the background-command bridge and accepted the risk
// (an MCP tool that a third-party client supplies). Limits that stay:
// children never run on antigravity/* models, and their results never post
// to the Pi session, so Pi never sends agy a prompt that you did not type.
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { log } from "./log.ts";

const PROTOCOL = "2025-06-18";
const MAX_CHILDREN = Number(process.env.PI_AG_MAX_CHILDREN) || 6;
const ACTIONS = ["start", "send", "wait", "status", "stop"] as const;
/** agy's MCP calls time out; long waits return early and Gemini calls wait again. */
const MAX_WAIT_S = Number(process.env.PI_AG_MAX_WAIT_S) || 240;

type Events = { emit(name: string, data: unknown): void };

export const AGENT_TOOL = {
  name: "agent",
  description:
    "Delegate work to Pi child agents: interactive Pi sessions in Rex panes that the user can watch and steer. " +
    "Children run on non-Gemini models (for example claude-code/claude-opus-5-5); for Gemini workers do the work yourself. " +
    "start returns at once. wait blocks until a child settles and returns its final reply, or returns early after `timeout` seconds " +
    `(max ${MAX_WAIT_S}) while children still run: then call wait again. Do not end your turn while children you need still run.`,
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: [...ACTIONS], description: "start a child; send a message to a running child (a steer if busy); wait for a child to settle; status of one or all; stop (closes it)" },
      name: { type: "string", description: "Agent name: lowercase letters, digits, - (e.g. tests-auth). wait: omit to wait for any" },
      task: { type: "string", description: "start: the full task. The child does not see this conversation, so include everything it needs" },
      title: { type: "string", description: "start: short title for the agent list" },
      model: { type: "string", description: "start (required): provider/model, e.g. claude-code/claude-opus-5-5. antigravity/* is refused" },
      thinking: { type: "string", enum: ["off", "minimal", "low", "medium", "high", "xhigh"], description: "start: thinking level" },
      cwd: { type: "string", description: "start: working directory (default: the session's)" },
      worktree: { type: ["boolean", "string"], description: "start: own git worktree on branch agent/<name> (true, or a name)" },
      text: { type: "string", description: "send: the message" },
      timeout: { type: "number", description: `wait: seconds, max ${MAX_WAIT_S} (default ${MAX_WAIT_S})` },
    },
    required: ["action"],
  },
} as const;

/** Rejects calls that the limits do not allow. Returns an error message, or undefined. */
export function checkCall(params: Record<string, unknown>, started: Set<string>): string | undefined {
  const action = String(params.action ?? "");
  if (!(ACTIONS as readonly string[]).includes(action)) return `unknown action ${action || "(none)"}; use ${ACTIONS.join(", ")}`;
  if (action === "start") {
    const model = typeof params.model === "string" ? params.model.trim() : "";
    if (!model) return "start needs model, for example claude-code/claude-opus-5-5 (children may not inherit an Antigravity model)";
    if (/^antigravity\//i.test(model)) return "children may not run on antigravity/* models. Do Gemini work yourself.";
    if (params.host) return "remote hosts are not supported here";
    if (started.size >= MAX_CHILDREN) return `at most ${MAX_CHILDREN} children at once; stop one first`;
  }
  if ((action === "send" || action === "stop") && (typeof params.name !== "string" || !started.has(params.name)))
    return `no child ${String(params.name ?? "")} started from this session`;
  if (action === "wait" && typeof params.name === "string" && !started.has(params.name)) return `no child ${params.name} started from this session`;
  return undefined;
}

export interface McpServerHandle {
  url: string;
  token: string;
  /** The `mcpServers` entry for ACP session/new and session/resume. */
  acpEntry(): { type: "http"; name: string; url: string; headers: { name: string; value: string }[] };
  close(): void;
}

const g = globalThis as { __piAgMcp?: McpServerHandle & { started: Set<string> } };

export async function startMcpServer(pi: { events?: Events }): Promise<McpServerHandle | undefined> {
  if (!pi.events) return undefined;
  if (g.__piAgMcp) return g.__piAgMcp;
  const token = crypto.randomBytes(24).toString("hex");
  const started = new Set<string>();

  const callBridge = (params: Record<string, unknown>, signal: AbortSignal) =>
    new Promise<{ text?: string; error?: string }>((resolve) => {
      let accepted = false;
      let done = false;
      const reply = (r: { text?: string; error?: string }) => {
        if (done) return;
        done = true;
        resolve(r);
      };
      pi.events!.emit("agent-bridge:call", { params, signal, reply, accept: () => (accepted = true) });
      if (!accepted) reply({ error: "agent-bridge is not loaded in this Pi (it needs Rex)" });
    });

  async function callTool(name: string, args: Record<string, unknown>, signal: AbortSignal) {
    if (name !== AGENT_TOOL.name) return { isError: true, content: [{ type: "text", text: `unknown tool ${name}` }] };
    const params = { ...args };
    if (params.action === "wait") params.timeout = Math.min(Math.max(1, Number(params.timeout) || MAX_WAIT_S), MAX_WAIT_S);
    const denied = checkCall(params, started);
    if (denied) {
      log({ event: "mcp_denied", action: params.action });
      return { isError: true, content: [{ type: "text", text: denied }] };
    }
    log({ event: "mcp_call", action: params.action });
    const r = await callBridge(params, signal);
    if (!r.error && params.action === "start" && typeof params.name === "string") started.add(params.name);
    if (!r.error && params.action === "stop" && typeof params.name === "string") started.delete(params.name);
    return r.error ? { isError: true, content: [{ type: "text", text: r.error }] } : { content: [{ type: "text", text: r.text ?? "" }] };
  }

  async function handle(msg: any, signal: AbortSignal): Promise<unknown | undefined> {
    if (msg?.method) log({ event: "mcp_rpc", method: msg.method });
    const id = msg?.id;
    if (id === undefined) return undefined; // notification
    const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    switch (msg.method) {
      case "initialize":
        return ok({ protocolVersion: msg.params?.protocolVersion ?? PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: "pi", version: "0.1.0" } });
      case "ping":
        return ok({});
      case "tools/list":
        return ok({ tools: [AGENT_TOOL] });
      case "tools/call":
        return ok(await callTool(String(msg.params?.name ?? ""), msg.params?.arguments ?? {}, signal));
      default:
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${msg.method}` } };
    }
  }

  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization ?? "";
    const want = `Bearer ${token}`;
    if (auth.length !== want.length || !crypto.timingSafeEqual(Buffer.from(auth), Buffer.from(want))) {
      res.writeHead(401).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" }).end();
      return;
    }
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (d: string) => {
      body += d;
      if (body.length > 4_000_000) req.destroy();
    });
    req.on("end", async () => {
      const ac = new AbortController();
      res.on("close", () => {
        if (!res.writableFinished) ac.abort();
      });
      let msg: any;
      try {
        msg = JSON.parse(body);
      } catch {
        res.writeHead(400).end();
        return;
      }
      const batch = Array.isArray(msg);
      const out = (await Promise.all((batch ? msg : [msg]).map((m: any) => handle(m, ac.signal)))).filter((r) => r !== undefined);
      if (!out.length) {
        res.writeHead(202).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(batch ? out : out[0]));
    });
  });
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  server.unref();
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  const handle_: McpServerHandle & { started: Set<string> } = {
    url,
    token,
    started,
    acpEntry: () => ({ type: "http", name: "pi", url, headers: [{ name: "Authorization", value: `Bearer ${token}` }] }),
    close: () => {
      server.close();
      if (g.__piAgMcp === handle_) g.__piAgMcp = undefined;
    },
  };
  g.__piAgMcp = handle_;
  return handle_;
}
