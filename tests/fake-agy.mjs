#!/usr/bin/env node
// A fake `agy acp` for tests. Behaviour by prompt text:
//   "hello"       → thought, text, end_turn
//   "tool"        → a tool call that asks permission, then text with the outcome
//   "slow"        → streams until session/cancel, then cancelled
//   "wake"        → end_turn at once, then an update 200 ms later with no prompt open
//   anything else → echoes the prompt text
// FAKE_AGY_AUTH=0 makes session/new fail with -32000.
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
const update = (sessionId, u) => send({ method: "session/update", params: { sessionId, update: u } });
let nextId = 1000;
const waiting = new Map();
const cancelled = new Set();
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
      return send({ id: m.id, result: { protocolVersion: 1, agentInfo: { name: "fake", version: "9.9.9" }, agentCapabilities: { _meta: { antigravity: { systemPrompt: { append: true } } } } } });
    case "session/new": {
      if (process.env.FAKE_AGY_AUTH === "0") return send({ id: m.id, error: { code: -32000, message: "Authentication required" } });
      const id = `s${sessions.size + 1}`;
      sessions.add(id);
      process.stderr.write(`new ${JSON.stringify(p._meta ?? null)}\n`);
      return send({ id: m.id, result: sessionResult(id) });
    }
    case "session/resume":
      if (!sessions.has(p.sessionId)) return send({ id: m.id, error: { code: -32602, message: "unknown session" } });
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
      if (/\btool\b/.test(text)) {
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
      if (/^pi-agent$/.test(text.trim())) {
        const r = await request("session/request_permission", {
          sessionId: sid,
          toolCall: { toolCallId: "pa", title: "Run mcp_pi_agent", kind: "other" },
          options: [{ optionId: "a", name: "Allow", kind: "allow_once" }, { optionId: "r", name: "Deny", kind: "reject_once" }],
        });
        update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `outcome ${r?.outcome?.optionId}` } });
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
