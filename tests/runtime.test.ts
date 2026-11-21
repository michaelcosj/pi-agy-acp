import assert from "node:assert/strict";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { FALLBACK_CATALOG, toPiModel } from "../src/models.ts";
import { Runtime, type UiLike, WAKE_PREFIX } from "../src/runtime.ts";
import { streamAntigravity } from "../src/stream.ts";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-agy.mjs");

const live: Runtime[] = [];
after(() => {
  for (const r of live) r.stop();
});

function setup(opts: { select?: string; confirm?: boolean; hasUI?: boolean; auth?: boolean; env?: Record<string, string> } = {}) {
  const runtime = new Runtime(() => ({ command: process.execPath, args: [FAKE], env: { ...(opts.auth === false ? { FAKE_AGY_AUTH: "0" } : {}), ...opts.env } as Record<string, string> }));
  const calls = { select: [] as string[], confirm: 0, sent: [] as any[], entries: [] as any[], name: undefined as string | undefined, status: [] as (string | undefined)[] };
  const ctx: UiLike = {
    hasUI: opts.hasUI ?? true,
    cwd: process.cwd(),
    ui: {
      select: async (title) => {
        calls.select.push(title);
        return opts.select;
      },
      confirm: async () => {
        calls.confirm++;
        return opts.confirm ?? false;
      },
      notify: () => {},
      setStatus: (_k, t) => calls.status.push(t),
    },
  };
  runtime.ctx = ctx;
  live.push(runtime);
  runtime.pi = {
    sendMessage: (m) => calls.sent.push(m),
    appendEntry: (t, d) => calls.entries.push({ t, d: structuredClone(d) }),
    setSessionName: (n) => (calls.name = n),
    getSessionName: () => calls.name,
  };
  return { runtime, calls };
}

const model = toPiModel(FALLBACK_CATALOG[0]);
const user = (text: string, timestamp = Date.now()) => ({ role: "user", content: [{ type: "text", text }], timestamp });

async function run(runtime: Runtime, messages: any[], options: any = {}) {
  const s = streamAntigravity(runtime, model, { messages }, options);
  const events: any[] = [];
  for await (const e of s) events.push(e);
  return { events, result: await s.result() };
}

test("a message that you did not type runs as an automatic turn", async () => {
  const { runtime } = setup();
  const { result } = await run(runtime, [user("Agent a finished:\nhello")]);
  assert.equal(result.stopReason, "stop");
  assert.equal(runtime.gate.autoTurns, 1);
  runtime.stop();
});

test("the automatic-turn budget stops a loop until you type", async () => {
  const { runtime } = setup();
  const msgs: any[] = [];
  for (let i = 0; i < runtime.gate.budget; i++) {
    msgs.push(user(`Agent a finished: ${i}`, 100 + i));
    const r = await run(runtime, msgs);
    assert.equal(r.result.stopReason, "stop");
    msgs.push(r.result);
  }
  msgs.push(user("Agent b finished", 200));
  const refused = await run(runtime, msgs);
  assert.match(refused.result.errorMessage!, /did not type/);
  msgs.push(refused.result);
  runtime.gate.arm("go on");
  msgs.push(user("go on", 201));
  const r = await run(runtime, msgs);
  assert.equal(r.result.stopReason, "stop");
  // Both new messages went in one prompt.
  assert.match((r.result.content[0] as any).text, /Agent b finished[\s\S]*go on/);
  assert.equal(runtime.gate.autoTurns, 0);
  runtime.stop();
});

test("refuses when there is no UI", async () => {
  const { runtime } = setup({ hasUI: false });
  runtime.gate.arm("hello");
  const { result } = await run(runtime, [user("hello")]);
  assert.equal(result.stopReason, "error");
  runtime.stop();
});

test("a retry of a turn that agy got is not sent again", async () => {
  const { runtime } = setup();
  runtime.gate.arm("hello");
  const msg = user("hello");
  const first = await run(runtime, [msg]);
  assert.equal(first.result.stopReason, "stop");
  const retry = await run(runtime, [msg, { ...first.result, stopReason: "error" }]);
  assert.match(retry.result.errorMessage!, /Nothing new/);
  runtime.stop();
});

test("streams thinking and text, sets the title, reads usage", async () => {
  const { runtime, calls } = setup();
  runtime.gate.arm("hello");
  const { events, result } = await run(runtime, [user("hello")]);
  assert.equal(result.stopReason, "stop");
  assert.deepEqual(
    result.content.map((b: any) => b.type),
    ["thinking", "text"],
  );
  assert.equal((result.content[1] as any).text, "Hi there");
  assert.equal(result.usage.totalTokens, 15);
  assert.equal(calls.name, "Greeting");
  assert.ok(events.some((e) => e.type === "thinking_delta"));
  assert.equal(runtime.binding?.sessionId, "s1");
  assert.ok(calls.entries.some((e) => e.t === "antigravity-session" && e.d.sessionId === "s1"));
  runtime.stop();
});

test("permission: the choice in Pi goes back to agy", async () => {
  for (const [choice, word] of [
    ["Allow once", "allowed"],
    [undefined, "rejected"],
  ] as const) {
    const { runtime, calls } = setup({ select: choice });
    runtime.gate.arm("tool");
    const { result } = await run(runtime, [user("tool")]);
    const text = result.content.map((b: any) => b.text ?? "").join("");
    assert.match(text, new RegExp(word));
    assert.match(text, /▸ Run npm test/);
    assert.match(calls.select[0], /npm test/);
    runtime.stop();
  }
});

test("abort sends session/cancel", async () => {
  const { runtime } = setup();
  runtime.gate.arm("slow");
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);
  const { result } = await run(runtime, [user("slow")], { signal: ac.signal });
  assert.equal(result.stopReason, "aborted");
  runtime.stop();
});

test("history: a new session asks before sending earlier messages", async () => {
  const { runtime, calls } = setup({ confirm: true });
  runtime.gate.arm("now");
  const earlier = [user("first question", 1), { role: "assistant", content: [{ type: "text", text: "first answer" }], provider: "openai", timestamp: 2 }];
  const { result } = await run(runtime, [...earlier, user("now")]);
  const text = (result.content[0] as any).text as string;
  assert.equal(calls.confirm, 1);
  assert.match(text, /earlier_conversation/);
  assert.match(text, /first answer/);
  runtime.stop();
});

test("linear continuation: no history question", async () => {
  const { runtime, calls } = setup({ confirm: true });
  runtime.gate.arm("hello");
  const first = await run(runtime, [user("hello")]);
  runtime.gate.arm("again");
  const { result } = await run(runtime, [user("hello"), first.result, user("again")]);
  assert.equal(calls.confirm, 0);
  assert.equal((result.content[0] as any).text, "echo: again");
  runtime.stop();
});

test("wake: updates with no prompt open become one display message, no turn", async () => {
  const { runtime, calls } = setup();
  runtime.gate.arm("wake");
  await run(runtime, [user("wake")]);
  await new Promise((r) => setTimeout(r, 2200));
  assert.equal(calls.sent.length, 1);
  const m = calls.sent[0];
  assert.equal(m.customType, "antigravity-wake");
  assert.ok(m.content.startsWith(WAKE_PREFIX));
  assert.match(m.content, /Background work done/);
  runtime.stop();
});

test("not signed in: probe returns undefined", async () => {
  const { runtime } = setup({ auth: false });
  assert.equal(await runtime.probe(), undefined);
  runtime.stop();
});

test("system prompt append is sent on session/new", async () => {
  const { runtime } = setup();
  runtime.gate.arm("hello");
  await run(runtime, [user("hello")]);
  assert.ok(runtime.process?.canAppendSystemPrompt);
  runtime.stop();
});

test("auto only: a session that cannot switch to auto does not run", async () => {
  const { runtime } = setup({ env: { FAKE_AGY_NO_AUTO: "1" } });
  runtime.gate.arm("hello");
  const { result } = await run(runtime, [user("hello")]);
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage!, /would not switch to auto/);
});

test("auto only: the session is set to auto", async () => {
  const { runtime } = setup();
  runtime.gate.arm("hello");
  await run(runtime, [user("hello")]);
  assert.equal(runtime.mode, "auto");
});

test("an agy subagent call runs and starts the subagent watch", async () => {
  const { runtime } = setup();
  runtime.gate.arm("subagent");
  const { result } = await run(runtime, [user("subagent")]);
  assert.equal(result.stopReason, "stop");
  assert.match(result.content.map((b: any) => b.text ?? "").join(""), /invoke_subagent/);
  runtime.stop();
});

test("Pi's own agent tool is approved without a dialog", async () => {
  const { runtime, calls } = setup({ select: "Deny" });
  runtime.gate.arm("pi-agent");
  const { result } = await run(runtime, [user("pi-agent")]);
  assert.match(result.content.map((b: any) => b.text ?? "").join(""), /outcome a/);
  assert.equal(calls.select.length, 0);
  runtime.stop();
});

test("ban: the suspension notice stops all later turns", async () => {
  const { runtime } = setup();
  let banned = 0;
  runtime.onBan = () => banned++;
  runtime.gate.arm("banned");
  const { result } = await run(runtime, [user("banned")]);
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage!, /TOS_VIOLATION/);
  assert.equal(banned, 1);
  runtime.gate.arm("hello");
  const next = await run(runtime, [user("banned"), result, user("hello")]);
  assert.match(next.result.errorMessage!, /disabled Antigravity/);
  runtime.stop();
});
