// In-process MCP server (streamable HTTP on 127.0.0.1) that gives agy Pi's
// tools. agy starts bin/mcp-bridge.mjs (a stdio MCP server from
// `session/new.mcpServers`), which forwards to this server, as T3 Code's
// `acp-mcp-bridge` does.
//
// A tool call does not run here. The server records it and keeps the MCP
// request open; the runtime then cancels agy's turn (session/cancel) and ends
// Pi's model turn with the same call, so Pi runs the tool itself (its UI,
// hooks, and permission checks). The result goes to agy in the next prompt.
// The open MCP request gets "Running <tool>; result arrives in next message."
// after the cancel, so agy makes no more model requests in that turn.
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { log } from "./log.ts";
import type { PiToolDef } from "./tools.ts";

const PROTOCOL = "2025-06-18";

/** The stdio MCP bridge that agy starts. */
export const BRIDGE = fileURLToPath(new URL("../bin/mcp-bridge.mjs", import.meta.url));

export interface PendingCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** Answers agy's MCP request. */
  answer(text: string, isError?: boolean): void;
}

export interface McpServerHandle {
  url: string;
  token: string;
  /** The `mcpServers` entry for ACP session/new and session/resume: a stdio bridge to this server. */
  acpEntry(): { name: string; command: string; args: string[]; env: { name: string; value: string }[] };
  /** Sets the tools that agy sees. Sends tools/list_changed when they change. */
  setTools(tools: PiToolDef[]): void;
  /** Called for each tool call from agy. */
  onCall: ((call: PendingCall) => void) | undefined;
  /** After a ban: refuse all calls. */
  banned: boolean;
  close(): void;
}

type Shared = McpServerHandle;
const g = globalThis as { __piAgMcp?: Shared };

/** One server per process, kept across reloads and session changes. */
export async function startMcpServer(): Promise<McpServerHandle> {
  if (g.__piAgMcp) return g.__piAgMcp;
  const token = crypto.randomBytes(24).toString("hex");
  let tools: PiToolDef[] = [];
  let toolsKey = "[]";
  /** Open GET streams for server-to-client notifications (tools/list_changed). */
  const streams = new Set<http.ServerResponse>();

  async function callTool(name: string, args: Record<string, unknown>, signal: AbortSignal) {
    if (handle_.banned) return { isError: true, content: [{ type: "text", text: "Antigravity is disabled on this account; tools are off" }] };
    if (!tools.some((t) => t.name === name)) return { isError: true, content: [{ type: "text", text: `unknown tool ${name}` }] };
    const onCall = handle_.onCall;
    if (!onCall) return { isError: true, content: [{ type: "text", text: "no Pi turn is open; try again" }] };
    log({ event: "mcp_call", tool: name });
    return new Promise<{ isError?: boolean; content: { type: "text"; text: string }[] }>((resolve) => {
      let done = false;
      const answer = (text: string, isError = false) => {
        if (done) return;
        done = true;
        resolve({ ...(isError ? { isError: true } : {}), content: [{ type: "text", text }] });
      };
      signal.addEventListener("abort", () => answer("cancelled", true), { once: true });
      onCall({ id: `agy_${crypto.randomBytes(6).toString("hex")}`, name, args, answer });
    });
  }

  async function handle(msg: any, signal: AbortSignal): Promise<unknown | undefined> {
    if (msg?.method) log({ event: "mcp_rpc", method: msg.method });
    const id = msg?.id;
    if (id === undefined) return undefined; // notification
    const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    switch (msg.method) {
      case "initialize":
        return ok({ protocolVersion: msg.params?.protocolVersion ?? PROTOCOL, capabilities: { tools: { listChanged: true } }, serverInfo: { name: "pi", version: "0.2.0" } });
      case "ping":
        return ok({});
      case "tools/list":
        return ok({ tools });
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
    // A GET opens a stream for notifications (MCP streamable HTTP).
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.flushHeaders();
      streams.add(res);
      res.on("close", () => streams.delete(res));
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "GET, POST" }).end();
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
      // An error here must not end Pi: answer it as a JSON-RPC error.
      const safe = (m: any) =>
        handle(m, ac.signal).catch((e) => (m?.id === undefined ? undefined : { jsonrpc: "2.0", id: m.id, error: { code: -32603, message: (e as Error).message.split("\n")[0] } }));
      const out = (await Promise.all((batch ? msg : [msg]).map(safe))).filter((r) => r !== undefined);
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
  const handle_: Shared = {
    url,
    token,
    banned: false,
    onCall: undefined,
    setTools(next) {
      const key = JSON.stringify(next);
      if (key === toolsKey) return;
      tools = next;
      toolsKey = key;
      log({ event: "mcp_tools", count: next.length });
      const note = `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n\n`;
      for (const s of streams) s.write(note);
    },
    acpEntry: () => ({
      name: "pi",
      command: process.execPath,
      args: [BRIDGE],
      env: [
        { name: "PI_AG_MCP_URL", value: url },
        { name: "PI_AG_MCP_AUTH", value: `Bearer ${token}` },
      ],
    }),
    close: () => {
      for (const s of streams) s.end();
      server.close();
      if (g.__piAgMcp === handle_) g.__piAgMcp = undefined;
    },
  };
  g.__piAgMcp = handle_;
  return handle_;
}
