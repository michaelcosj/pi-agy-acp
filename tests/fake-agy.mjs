#!/usr/bin/env node
// A fake `agy acp` for tests. Behaviour by prompt text:
//   "hello"       → thought, text, end_turn
//   "tool"        → a tool call that asks permission, then text with the outcome
//   "slow"        → streams until session/cancel, then cancelled
//   "wake"        → end_turn at once, then an update 200 ms later with no prompt open
//   anything else → echoes the prompt text
// FAKE_AGY_AUTH=0 makes session/new fail with -32000.
import readline from "node:readline";
import { spawn } from "node:child_process";

const rl = readline.createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
const update = (sessionId, u) => send({ method: "session/update", params: { sessionId, update: u } });
let nextId = 1000;
const waiting = new Map();
const cancelled = new Set();
const dirs = new Map();
const mcpEntries = new Map();
let lastMcpAnswer = "(none)";
let pendingAnswer = Promise.resolve();

/** Starts the stdio MCP server from a session's mcpServers (as agy does) and returns an rpc function. */
function mcpClient(sid) {
  const e = mcpEntries.get(sid)?.[0];
  if (!e) return undefined;
  const env = { ...process.env };
  for (const v of e.env ?? []) env[v.name] = v.value;
  const child = spawn(e.command, e.args ?? [], { env, stdio: ["pipe", "pipe", "ignore"] });
  let buf = "";
  let id = 0;
  const wait = new Map();
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && wait.has(msg.id)) {
          wait.get(msg.id)(msg);
          wait.delete(msg.id);
        }
      } catch {}
    }
  });
  const rpc = (method, params) =>
    new Promise((res) => {
      const n = ++id;
      wait.set(n, res);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: n, method, params })}\n`);
    });
  return { rpc, close: () => child.kill() };
}
const sessions = new Set();
const request = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    send({ id, method, params });
  });

const sessionResult = (sessionId) => ({
  sessionId,
  models: { availableModels: [{ modelId: "gemini-4-neon-high", name: "Gemini 4 Neon (High)" }, { modelId: "gemini-4-neon-low", name: "Gemini 4 Neon (Low)" }], currentModelId: "gemini-4-neon-high" },
  configOptions: [
    { id: "model", name: "Model", category: "model", type: "select", currentValue: "gemini-4-neon", options: [{ value: "gemini-4-neon", name: "Gemini 4 Neon" }] },
    { id: "thought_level", name: "Thinking Level", type: "select", currentValue: "high", options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] },
  ],
  _meta: { antigravity: { tier: { name: "Google AI Pro" } } },
});

rl.on("line", async (line) => {
  const m = JSON.parse(line);
  if (m.method === undefined) {
    waiting.get(m.id)?.(m.result);
    waiting.delete(m.id);
    return;
  }
  const p = m.params ?? {};
  switch (m.method) {
    case "initialize":
      return send({ id: m.id, result: { protocolVersion: 1, agentInfo: { name: "fake", version: "9.9.9" }, agentCapabilities: { sessionCapabilities: { additionalDirectories: {} }, _meta: { antigravity: { systemPrompt: { append: true } } } } } });
    case "session/new": {
      if (process.env.FAKE_AGY_AUTH === "0") return send({ id: m.id, error: { code: -32000, message: "Authentication required" } });
      const id = `s${sessions.size + 1}`;
      sessions.add(id);
      process.stderr.write(`new ${JSON.stringify(p._meta ?? null)}\n`);
      dirs.set(id, p.additionalDirectories ?? []);
      mcpEntries.set(id, p.mcpServers ?? []);
      return send({ id: m.id, result: sessionResult(id) });
    }
    case "session/resume":
      if (!sessions.has(p.sessionId)) return send({ id: m.id, error: { code: -32602, message: "unknown session" } });
      dirs.set(p.sessionId, p.additionalDirectories ?? []);
      mcpEntries.set(p.sessionId, p.mcpServers ?? []);
      return send({ id: m.id, result: {} });
    case "session/close":
      return send({ id: m.id, result: {} });
    case "session/set_config_option":
      if (p.configId === "mode") process.stderr.write(`mode ${p.value}\n`);
      if (p.configId === "mode" && process.env.FAKE_AGY_NO_AUTO === "1") return send({ id: m.id, error: { code: -32602, message: "auto not available" } });
      return send({ id: m.id, result: {} });
    case "session/cancel":
      cancelled.add(p.sessionId);
      return;
    case "session/prompt": {
      const text = (p.prompt ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
      const sid = p.sessionId;
      if (/\bhello\b/.test(text)) {
        update(sid, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking…" } });
        update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hi " } });
        update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "there" } });
        update(sid, { sessionUpdate: "session_info_update", title: "Greeting" });
        return send({ id: m.id, result: { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } });
      }
      if (/\btool\b/.test(text) && !/pi-tool|Result of /.test(text)) {
        update(sid, { sessionUpdate: "tool_call", toolCallId: "t1", title: "Run npm test", kind: "execute", status: "pending", rawInput: { command: "npm test" } });
        const r = await request("session/request_permission", {
          sessionId: sid,
          toolCall: { toolCallId: "t1", title: "Run npm test", kind: "execute", rawInput: { command: "npm test" } },
          options: [
            { optionId: "a", name: "Allow once", kind: "allow_once" },
            { optionId: "r", name: "Reject", kind: "reject_once" },
          ],
        });
        const ok = r?.outcome?.optionId === "a";
        update(sid, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: ok ? "completed" : "failed" });
        update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: ok ? "allowed" : "rejected" } });
        return send({ id: m.id, result: { stopReason: "end_turn" } });
      }
      if (/\bslow\b/.test(text)) {
        cancelled.delete(sid);
        for (let i = 0; i < 100 && !cancelled.has(sid); i++) {
          update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "." } });
          await new Promise((r) => setTimeout(r, 20));
        }
        return send({ id: m.id, result: { stopReason: cancelled.has(sid) ? "cancelled" : "end_turn" } });
      }
      if (/^banned$/.test(text.trim())) {
        update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "[warning] This service has been disabled in this account for violation of Terms of Service. Please submit an appeal to continue using this product." } });
        return send({ id: m.id, result: { stopReason: "end_turn" } });
      }
      // "pi-tools" → lists Pi's MCP tools. "pi-tool <name>" → calls it, waits for session/cancel.
      if (/^pi-tools$/.test(text.trim())) {
        const c = mcpClient(sid);
        await c.rpc("initialize", { protocolVersion: "2025-06-18" });
        const list = await c.rpc("tools/list", {});
        c.close();
        update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `tools ${list.result.tools.map((t) => t.name).join(",")}` } });
        return send({ id: m.id, result: { stopReason: "end_turn" } });
      }
      const call = /^pi-tool (\S+)$/.exec(text.trim());
      if (call) {
        cancelled.delete(sid);
        const c = mcpClient(sid);
        await c.rpc("initialize", { protocolVersion: "2025-06-18" });
        update(sid, { sessionUpdate: "tool_call", toolCallId: "pt", title: `Run mcp_pi_${call[1]}`, kind: "other", status: "in_progress" });
        const answered = (pendingAnswer = c.rpc("tools/call", { name: call[1], arguments: { q: "pick one" } }).then((r) => {
          lastMcpAnswer = r.result?.content?.[0]?.text ?? JSON.stringify(r.error);
          c.close();
        }));
        for (let i = 0; i < 1000 && !cancelled.has(sid); i++) await new Promise((res) => setTimeout(res, 10));
        send({ id: m.id, result: { stopReason: cancelled.has(sid) ? "cancelled" : "end_turn" } });
        await answered;
        return;
      }
      if (/^mcp-answer$/.test(text.trim()) || /Result of /.test(text)) {
        await pendingAnswer;
        update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `answer ${lastMcpAnswer} | prompt ${text.replace(/\n/g, " ")}` } });
        return send({ id: m.id, result: { stopReason: "end_turn" } });
      }
      if (/^pi-agent$/.test(text.trim())) {
        const r = await request("session/request_permission", {
          sessionId: sid,
          toolCall: { toolCallId: "pa", title: "Run mcp_pi_agent", kind: "other" },
          options: [{ optionId: "a", name: "Allow", kind: "allow_once" }, { optionId: "r", name: "Deny", kind: "reject_once" }],
        });
        update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `outcome ${r?.outcome?.optionId}` } });
        return send({ id: m.id, result: { stopReason: "end_turn" } });
      }
      // "outside <path>" → asks twice to read the path, then prints the outcomes and the folders it has.
      const out = /^outside (\S+)$/.exec(text.trim());
      if (out) {
        const ask = () =>
          request("session/request_permission", {
            sessionId: sid,
            toolCall: { toolCallId: "f", title: `File ${out[1]}`, kind: "read", locations: [{ path: out[1] }] },
            options: [{ optionId: "a", name: "Allow", kind: "allow_once" }, { optionId: "r", name: "Deny", kind: "reject_once" }],
          });
        const a = await ask();
        const b = await ask();
        update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `outcomes ${a?.outcome?.optionId} ${b?.outcome?.optionId} dirs ${JSON.stringify(dirs.get(sid))}` } });
        return send({ id: m.id, result: { stopReason: "end_turn" } });
      }
      if (/^\/compact\b/.test(text.trim())) {
        update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Compacting.\n<summary>1. **Task Overview**\n- fix the bug</summary>" } });
        return send({ id: m.id, result: { stopReason: "end_turn" } });
      }
      if (/^dirs$/.test(text.trim())) {
        update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `dirs ${JSON.stringify(dirs.get(sid))}` } });
        return send({ id: m.id, result: { stopReason: "end_turn" } });
      }
      if (/^subagent$/.test(text.trim())) {
        update(sid, { sessionUpdate: "tool_call", toolCallId: "sa", title: "Run invoke_subagent", kind: "other", status: "in_progress", rawInput: { Role: "counter", Prompt: "x" } });
        update(sid, { sessionUpdate: "tool_call_update", toolCallId: "sa", title: "Run invoke_subagent", kind: "other", status: "completed" });
        return send({ id: m.id, result: { stopReason: "end_turn" } });
      }
      if (/\bwake\b/.test(text)) {
        update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "started in background" } });
        send({ id: m.id, result: { stopReason: "end_turn" } });
        setTimeout(() => {
          update(sid, { sessionUpdate: "tool_call", toolCallId: "bg", title: "Background task finished", status: "completed" });
          update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Background work done." } });
        }, 200);
        return;
      }
      update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `echo: ${text}` } });
      return send({ id: m.id, result: { stopReason: "end_turn" } });
    }
    default:
      return send({ id: m.id, error: { code: -32601, message: `no ${m.method}` } });
  }
});
