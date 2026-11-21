import assert from "node:assert/strict";
import { test } from "node:test";
import { startMcpServer } from "../src/mcp.ts";

test("MCP server: auth, tools/list, tools/call through agent-bridge:call", async () => {
  const calls: any[] = [];
  const events = {
    emit(name: string, d: any) {
      if (name !== "agent-bridge:call") return;
      d.accept();
      calls.push({ ...d.params, notify: d.notify });
      const p = d.params;
      if (p.action === "start") d.reply({ text: `Started agent ${p.name}.` });
      else if (p.action === "wait") setTimeout(() => d.reply({ text: `Agent ${p.name} finished:\nall green` }), 20);
      else d.reply({ text: "ok" });
    },
  };
  const mcp = (await startMcpServer({ events }))!;
  const entry = mcp.acpEntry();
  assert.equal(entry.type, "http");
  assert.equal(entry.name, "pi");
  const post = (body: unknown, auth = entry.headers[0].value) =>
    fetch(mcp.url, { method: "POST", headers: { "content-type": "application/json", authorization: auth }, body: JSON.stringify(body) });
  const rpc = async (method: string, params?: unknown) => (await (await post({ jsonrpc: "2.0", id: 1, method, params })).json()) as any;

  assert.equal((await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "Bearer nope")).status, 401);
  assert.equal((await post({ jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);

  const init = await rpc("initialize", { protocolVersion: "2025-11-25" });
  assert.equal(init.result.protocolVersion, "2025-11-25");
  const list = await rpc("tools/list");
  assert.deepEqual(list.result.tools.map((t: any) => t.name), ["agent"]);

  const call = (args: unknown) => rpc("tools/call", { name: "agent", arguments: args });
  const denied = await call({ action: "hosts" });
  assert.equal(denied.result.isError, true);
  assert.match(denied.result.content[0].text, /unknown action/);

  const started = await call({ action: "start", name: "w", model: "claude-code/claude-opus-5-5", task: "run the tests" });
  assert.equal(started.result.isError, undefined);
  assert.match(started.result.content[0].text, /Started agent w/);
  assert.equal(calls.at(-1).notify, true);

  const waited = await call({ action: "wait", name: "w", timeout: 99999 });
  assert.match(waited.result.content[0].text, /all green/);
  assert.equal(calls.at(-1).timeout, 240);

  const unknown = await call({ action: "send", name: "nobody", text: "hi" });
  assert.match(unknown.result.content[0].text, /no child nobody/);
  mcp.close();
});

test("MCP server: no agent-bridge gives a clear error", async () => {
  const mcp = (await startMcpServer({ events: { emit() {} } }))!;
  const r = await fetch(mcp.url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: mcp.acpEntry().headers[0].value },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "agent", arguments: { action: "status" } } }),
  });
  const j = (await r.json()) as any;
  assert.match(j.result.content[0].text, /agent-bridge is not loaded/);
  mcp.close();
});
