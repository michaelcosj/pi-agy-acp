// The `pi-agent` bridge: a Unix socket that lets agy start Pi child agents
// from its own terminal. agy runs `pi-agent wait NAME` as a background
// command; when it exits, agy's own background-task wake continues the
// turn. Pi never sends a prompt to agy for this.
//
// Calls go to agent-bridge over the Pi event bus ("agent-bridge:call").
// Rules: children never run on antigravity/* models (that would be another
// agent driving agy), and their results never post to this Pi session.
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { log } from "./log.ts";

export const BRIDGE_ENV = "PI_AG_BRIDGE";
export const TOKEN_ENV = "PI_AG_TOKEN";
const MAX_CHILDREN = Number(process.env.PI_AG_MAX_CHILDREN) || 6;
const ACTIONS = new Set(["start", "send", "wait", "status", "stop"]);

type Events = { emit(name: string, data: unknown): void; on?(name: string, fn: (d: any) => void): unknown };

const g = globalThis as { __piAgBridge?: { server: net.Server; socketPath: string; token: string; started: Set<string> } };

/** Rejects calls that the policy does not allow. Returns an error message, or undefined. */
export function checkCall(params: Record<string, unknown>, started: Set<string>): string | undefined {
  const action = String(params.action ?? "");
  if (!ACTIONS.has(action)) return `unknown action ${action || "(none)"}; use start, send, wait, status, stop`;
  if (action === "start") {
    const model = typeof params.model === "string" ? params.model.trim() : "";
    if (!model) return "start needs --model, for example claude-code/claude-opus-5-5 (children may not inherit an Antigravity model)";
    if (/^antigravity\//i.test(model) || /^agy\b/i.test(model))
      return "children may not run on antigravity/* models (another agent may not drive agy on a subscription). Use agy's own invoke_subagent for Gemini workers.";
    if (params.host) return "remote hosts are not supported from pi-agent";
    if (started.size >= MAX_CHILDREN) return `at most ${MAX_CHILDREN} children from pi-agent at once; stop one first`;
  }
  // Only children that this bridge started.
  if ((action === "send" || action === "stop") && (typeof params.name !== "string" || !started.has(params.name)))
    return `no pi-agent child ${String(params.name ?? "")}`;
  if (action === "wait" && typeof params.name === "string" && !started.has(params.name)) return `no pi-agent child ${params.name}`;
  return undefined;
}

export async function startBridge(pi: { events?: Events }, _ctx: () => unknown): Promise<Record<string, string>> {
  if (process.env.PI_BRIDGE_PARENT) return {}; // a child pi: no bridge
  if (!pi.events) return {};
  const existing = g.__piAgBridge;
  if (existing?.server.listening) return { [BRIDGE_ENV]: existing.socketPath, [TOKEN_ENV]: existing.token };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ag-"));
  fs.chmodSync(dir, 0o700);
  const socketPath = path.join(dir, "bridge.sock");
  const token = crypto.randomBytes(24).toString("hex");
  const started = new Set<string>();

  const call = (params: Record<string, unknown>, signal: AbortSignal) =>
    new Promise<{ text?: string; error?: string }>((resolve) => {
      let answered = false;
      const reply = (r: { text?: string; error?: string }) => {
        if (answered) return;
        answered = true;
        resolve(r);
      };
      let accepted = false;
      // Pi's event bus calls listeners synchronously; agent-bridge sets accepted.
      pi.events!.emit("agent-bridge:call", { params, signal, reply, accept: () => (accepted = true) });
      if (!accepted) reply({ error: "agent-bridge is not loaded in this Pi (it needs Rex)" });
    });

  const server = net.createServer((socket) => {
    let buf = "";
    let authed = false;
    const ac = new AbortController();
    socket.on("close", () => ac.abort());
    socket.on("error", () => ac.abort());
    socket.setEncoding("utf8");
    socket.on("data", async (d: string) => {
      buf += d;
      if (buf.length > 1_000_000) return socket.destroy();
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          return socket.destroy();
        }
        if (!authed) {
          if (typeof msg.token !== "string" || msg.token.length !== token.length || !crypto.timingSafeEqual(Buffer.from(msg.token), Buffer.from(token))) {
            socket.end(`${JSON.stringify({ error: "authentication failed" })}\n`);
            return;
          }
          authed = true;
        }
        const params = (msg.params ?? {}) as Record<string, unknown>;
        const denied = checkCall(params, started);
        if (denied) {
          log({ event: "bridge_denied", action: params.action });
          socket.end(`${JSON.stringify({ error: denied })}\n`);
          return;
        }
        log({ event: "bridge_call", action: params.action });
        const r = await call(params, ac.signal);
        if (!r.error && params.action === "start" && typeof params.name === "string") started.add(params.name);
        if (!r.error && params.action === "stop" && typeof params.name === "string") started.delete(params.name);
        if (!socket.destroyed) socket.end(`${JSON.stringify(r)}\n`);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  fs.chmodSync(socketPath, 0o600);
  server.unref();
  g.__piAgBridge = { server, socketPath, token, started };
  const cleanup = () => {
    try {
      server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  };
  process.once("exit", cleanup);
  return { [BRIDGE_ENV]: socketPath, [TOKEN_ENV]: token };
}
