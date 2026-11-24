import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { startMcpServer } from "../src/mcp.ts";

const TOOL = { name: "questionnaire", description: "Ask", inputSchema: { type: "object", properties: {} } };

async function post(mcp: { url: string; token: string }, body: unknown, auth = `Bearer ${mcp.token}`) {
  return fetch(mcp.url, { method: "POST", headers: { "content-type": "application/json", authorization: auth }, body: JSON.stringify(body) });
}

test("MCP server: auth, tools/list, a call waits for its answer", async () => {
  const mcp = await startMcpServer();
  mcp.setTools([TOOL]);
  assert.equal((await post(mcp, { jsonrpc: "2.0", id: 1, method: "tools/list" }, "Bearer nope")).status, 401);
  assert.equal((await post(mcp, { jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
  const rpc = async (method: string, params?: unknown) => (await (await post(mcp, { jsonrpc: "2.0", id: 1, method, params })).json()) as any;

  const init = await rpc("initialize", { protocolVersion: "2025-11-25" });
  assert.equal(init.result.protocolVersion, "2025-11-25");
  assert.equal(init.result.capabilities.tools.listChanged, true);
  assert.deepEqual((await rpc("tools/list")).result.tools.map((t: any) => t.name), ["questionnaire"]);

  // No open turn: the call fails at once.
  assert.match((await rpc("tools/call", { name: "questionnaire", arguments: {} })).result.content[0].text, /no Pi turn/);
  assert.match((await rpc("tools/call", { name: "nope", arguments: {} })).result.content[0].text, /unknown tool/);

  // An open turn: the call is recorded and waits for its answer.
  const seen: any[] = [];
  mcp.onCall = (c) => {
    seen.push(c);
    setTimeout(() => c.answer("Running questionnaire; result arrives in next message."), 20);
  };
  const r = await rpc("tools/call", { name: "questionnaire", arguments: { q: "x" } });
  assert.equal(seen[0].name, "questionnaire");
  assert.deepEqual(seen[0].args, { q: "x" });
  assert.match(r.result.content[0].text, /^Running questionnaire;/);

  mcp.banned = true;
  assert.match((await rpc("tools/call", { name: "questionnaire", arguments: {} })).result.content[0].text, /disabled/);
  mcp.close();
});

test("stdio bridge: lines reach Pi's server, and tools/list_changed reaches agy", async () => {
  const mcp = await startMcpServer();
  mcp.setTools([TOOL]);
  const e = mcp.acpEntry();
  const child = spawn(e.command, e.args, { env: { ...process.env, ...Object.fromEntries(e.env.map((x) => [x.name, x.value])) } });
  const lines: any[] = [];
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d;
    for (let i; (i = buf.indexOf("\n")) >= 0; buf = buf.slice(i + 1)) lines.push(JSON.parse(buf.slice(0, i)));
  });
  const send = (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`);
  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 150 && !ok(); i++) await new Promise((r) => setTimeout(r, 20));
  };
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  await until(() => lines.length >= 2);
  assert.equal(lines.find((l) => l.id === 1).result.serverInfo.name, "pi");
  assert.deepEqual(lines.find((l) => l.id === 2).result.tools.map((t: any) => t.name), ["questionnaire"]);
  // Give the bridge time to open its event stream, then change the tools.
  await new Promise((r) => setTimeout(r, 300));
  mcp.setTools([TOOL, { ...TOOL, name: "web_search" }]);
  await until(() => lines.some((l) => l.method === "notifications/tools/list_changed"));
  assert.ok(lines.some((l) => l.method === "notifications/tools/list_changed"));
  child.kill();
  mcp.close();
});
