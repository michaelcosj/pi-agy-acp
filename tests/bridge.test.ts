import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { startBridge } from "../src/bridge.ts";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "../bin/pi-agent.mjs");

function cli(args: string[], env: Record<string, string>) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: { ...process.env, ...env } }, (err, stdout, stderr) =>
      resolve({ code: err ? ((err as any).code ?? 1) : 0, stdout, stderr }),
    );
  });
}

test("pi-agent → socket → agent-bridge:call, with the policy applied", async () => {
  const calls: any[] = [];
  const events = {
    emit(name: string, d: any) {
      if (name !== "agent-bridge:call") return;
      d.accept();
      calls.push(d.params);
      const p = d.params;
      if (p.action === "start") d.reply({ text: `Started agent ${p.name}.` });
      else if (p.action === "wait") setTimeout(() => d.reply({ text: `Agent ${p.name} finished (1s):\nall green` }), 50);
      else d.reply({ text: "ok" });
    },
  };
  const env = await startBridge({ events }, () => undefined);
  assert.ok(env.PI_AG_BRIDGE && env.PI_AG_TOKEN);

  const denied = await cli(["start", "w", "--model", "antigravity/gemini-4-neon", "--task", "x"], env);
  assert.equal(denied.code, 1);
  assert.match(denied.stderr, /may not run on antigravity/);

  const started = await cli(["start", "w", "--model", "claude-code/claude-opus-5-5", "--task", "run the tests"], env);
  assert.equal(started.code, 0, started.stderr);
  assert.match(started.stdout, /Started agent w/);
  assert.equal(calls[0].task, "run the tests");

  const waited = await cli(["wait", "w"], env);
  assert.equal(waited.code, 0);
  assert.match(waited.stdout, /all green/);
  assert.equal(calls[1].timeout, 3600);

  const bad = await cli(["status"], { ...env, PI_AG_TOKEN: "x".repeat(48) });
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /authentication failed/);

  const unknown = await cli(["send", "nobody", "hi"], env);
  assert.match(unknown.stderr, /no pi-agent child nobody/);
});

test("pi-agent with no bridge env explains itself", async () => {
  const r = await cli(["status"], { PI_AG_BRIDGE: "", PI_AG_TOKEN: "" });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /PI_AG_BRIDGE is not set/);
});
