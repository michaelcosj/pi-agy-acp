#!/usr/bin/env node
// stdio MCP server for agy: forwards each JSON-RPC line to Pi's local MCP
// server over HTTP and writes the reply back. agy starts this program, as
// T3 Code's agy sessions start `t3 acp-mcp-bridge`. Then `agy acp` needs no
// --process-per-session flag for HTTP MCP.
// Env: PI_AG_MCP_URL (http://127.0.0.1:<port>/mcp), PI_AG_MCP_AUTH ("Bearer …").
import readline from "node:readline";

const url = process.env.PI_AG_MCP_URL;
const auth = process.env.PI_AG_MCP_AUTH ?? "";
if (!url) {
  process.stderr.write("mcp-bridge: PI_AG_MCP_URL is not set\n");
  process.exit(2);
}

const write = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);

async function forward(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
  }
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: auth }, body: line });
    if (res.status === 202) return;
    if (!res.ok) throw new Error(`Pi answered HTTP ${res.status}`);
    write(await res.json());
  } catch (e) {
    if (msg?.id !== undefined) write({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: `Pi is not reachable: ${e.message}` } });
  }
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (line.trim()) void forward(line);
});
