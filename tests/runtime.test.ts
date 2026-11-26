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
  // Tests do not read the user's pi-agy-acp.json: no sandbox.
  runtime.sandbox = { mode: "off", readOnly: [], readWrite: [] };
  // ... nor the user's MCP config files.
  const none = path.join(process.cwd(), "tests", ".no-such-dir");
  runtime.mcpPaths = () => ({ agyServers: path.join(none, "a.json"), agySettings: path.join(none, "s.json"), agyToolCache: none, piConfigs: [] });
  live.push(runtime);
  runtime.pi = {
    sendMessage: (m, o) => calls.sent.push({ ...m, options: o }),
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
  // agy's usage_update gives the context size: Pi's context meter uses it, not the turn's sum.
  runtime.gate.arm("hello ctx");
  const two = await run(runtime, [user("hello"), result, user("hello ctx")]);
  assert.equal(two.result.usage.totalTokens, 9);
  assert.equal(two.result.usage.input, 10);
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
  // Display only: Pi must not start or steer a model call with it.
  assert.equal(m.options?.triggerTurn, false);
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

test("Pi's MCP tools are approved without a dialog", async () => {
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

test("outside the workspace: allow the folder for this session", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-ag-wt-")));
  const file = path.join(dir, "a.md");
  fs.writeFileSync(file, "x");
  const { runtime, calls } = setup({ select: `Allow ${dir} for this session` });
  // Turn 1: one dialog; Pi approves the second request itself.
  runtime.gate.arm("x");
  const one = await run(runtime, [user(`outside ${file}`)]);
  assert.match(one.result.content.map((b: any) => b.text ?? "").join(""), /outcomes a a dirs \[\]/);
  assert.equal(calls.select.length, 1);
  assert.ok(calls.entries.some((e) => e.t === "antigravity-dirs" && e.d.dirs[0] === dir));
  // Turn 2: agy gets the folder through session/resume.
  runtime.gate.arm("dirs");
  const two = await run(runtime, [user(`outside ${file}`), one.result, user("dirs")]);
  assert.match(two.result.content.map((b: any) => b.text ?? "").join(""), new RegExp(`dirs \\["${dir}"\\]`));
  runtime.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a child agent's folder joins the workspace at the next turn", async () => {
  const { addChildDir } = await import("../src/runtime.ts");
  const { runtime } = setup();
  runtime.gate.arm("dirs");
  const one = await run(runtime, [user("dirs")]);
  assert.match(one.result.content.map((b: any) => b.text ?? "").join(""), /dirs \[\]/);
  assert.ok(addChildDir(runtime, "/tmp/child-wt", process.cwd()));
  assert.ok(!addChildDir(runtime, path.join(process.cwd(), "sub"), process.cwd()));
  runtime.gate.arm("dirs");
  const two = await run(runtime, [user("dirs"), one.result, user("dirs")]);
  assert.match(two.result.content.map((b: any) => b.text ?? "").join(""), /dirs \["\/tmp\/child-wt"\]/);
  runtime.stop();
});

test("cost: the API price of the model counts the turn's tokens", async () => {
  const { runtime } = setup();
  (runtime.ctx as any).modelRegistry = { find: (p: string, id: string) => (p === "google" && id === model.id ? { cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 } } : undefined) };
  runtime.gate.arm("hello");
  const { result } = await run(runtime, [user("hello")]);
  // fake agy: 10 input and 5 output tokens.
  assert.equal(result.usage.cost.total, (10 * 2 + 5 * 10) / 1e6);
  runtime.stop();
});

test("/compact: agy's summary comes back as text", async () => {
  const { compactSummary } = await import("../src/index.ts");
  const { runtime } = setup();
  runtime.gate.arm("hello");
  await run(runtime, [user("hello")]);
  const s = await runtime.session(process.cwd());
  const text = await runtime.runCommand(s.sessionId, "/compact keep the plan");
  assert.match(text, /<summary>/);
  const summary = compactSummary(text);
  assert.match(summary, /^Antigravity compacted its own context/);
  assert.match(summary, /\*\*Task Overview\*\*\n- fix the bug$/);
  assert.doesNotMatch(summary, /Compacting\.|<summary>/);
  assert.match(compactSummary(""), /agy printed no summary/);
  runtime.stop();
});

test("a Pi tool call: agy's turn is cancelled and Pi's turn ends with the call", async () => {
  const { startMcpServer } = await import("../src/mcp.ts");
  const mcp = await startMcpServer();
  const { runtime } = setup();
  runtime.mcp = mcp;
  runtime.mcpServers = () => [mcp.acpEntry()];
  const tools = [{ name: "questionnaire", description: "Ask the user", parameters: { type: "object", properties: { q: { type: "string" } } } }];
  const go = async (messages: any[]) => {
    const s = streamAntigravity(runtime, model, { messages, tools } as any, {});
    const events: any[] = [];
    for await (const e of s) events.push(e);
    return { events, result: await s.result() };
  };
  runtime.gate.arm("pi-tools");
  const listed = await go([user("pi-tools")]);
  assert.match(listed.result.content.map((b: any) => b.text ?? "").join(""), /tools questionnaire/);

  runtime.gate.arm("pi-tool questionnaire");
  const one = await go([user("pi-tools"), listed.result, user("pi-tool questionnaire")]);
  assert.equal(one.result.stopReason, "toolUse");
  const call = one.result.content.find((b: any) => b.type === "toolCall") as any;
  assert.equal(call.name, "questionnaire");
  assert.deepEqual(call.arguments, { q: "pick one" });
  assert.ok(call.id.startsWith("agy_"));
  assert.ok(one.events.some((e) => e.type === "toolcall_end"));
  // agy's own line for the Pi tool is hidden (Pi shows the call).
  assert.doesNotMatch(one.result.content.map((b: any) => b.text ?? "").join(""), /mcp_pi_questionnaire/);

  // Pi ran the tool; its result goes to agy as the next prompt, not as an automatic turn.
  const before = runtime.gate.autoTurns;
  const toolResult = { role: "toolResult", toolCallId: call.id, toolName: "questionnaire", content: [{ type: "text", text: "B" }], isError: false, timestamp: Date.now() };
  const two = await go([user("pi-tools"), listed.result, user("pi-tool questionnaire"), one.result, toolResult]);
  const text = two.result.content.map((b: any) => b.text ?? "").join("");
  assert.match(text, /answer Running questionnaire; result arrives in next message\./);
  assert.match(text, /prompt Result of questionnaire: B/);
  assert.equal(runtime.gate.autoTurns, before);
  runtime.stop();
  mcp.close();
});

test("agy's own MCP tools: agy's mcp(server/tool) allow rules apply, others ask", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ag-rules-"));
  const settings = path.join(dir, "settings.json");
  fs.writeFileSync(settings, JSON.stringify({ permissions: { allow: ["mcp(doop/*)", "mcp(other/read)"], deny: ["mcp(doop/delete_frame)"] } }));
  const { runtime, calls } = setup({ select: "Deny" });
  runtime.mcpPaths = () => ({ agyServers: path.join(dir, "none.json"), agySettings: settings, agyToolCache: dir, piConfigs: [] });
  const ask = async (prompt: string) => {
    runtime.gate.arm(prompt);
    return (await run(runtime, [user(prompt)])).result.content.map((b: any) => b.text ?? "").join("");
  };
  assert.match(await ask("agy-mcp doop get_canvas"), /outcome a/);
  assert.match(await ask("agy-mcp other read"), /outcome a/);
  assert.equal(calls.select.length, 0);
  assert.match(await ask("agy-mcp other write"), /outcome r/);
  assert.match(await ask("agy-mcp doop delete_frame"), /outcome r/);
  assert.equal(calls.select.length, 2);
  runtime.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Pi's tools for agy: fixed for one agy process, without servers that agy has", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ag-dup-"));
  fs.writeFileSync(path.join(dir, "agy.json"), JSON.stringify({ mcpServers: { doop: { serverUrl: "https://d.example/mcp" } } }));
  fs.writeFileSync(path.join(dir, "pi.json"), JSON.stringify({ mcpServers: { doop: { url: "https://d.example/mcp/" }, docs: { url: "https://other.example/mcp" } } }));
  const { startMcpServer } = await import("../src/mcp.ts");
  const mcp = await startMcpServer();
  const { runtime } = setup();
  runtime.mcpPaths = () => ({ agyServers: path.join(dir, "agy.json"), agySettings: path.join(dir, "s.json"), agyToolCache: dir, piConfigs: [path.join(dir, "pi.json")] });
  runtime.mcp = mcp;
  runtime.mcpServers = () => [mcp.acpEntry()];
  const t = (name: string) => ({ name, description: name, parameters: { type: "object", properties: {} } });
  const go = async (messages: any[], tools: any[]) => {
    const s = streamAntigravity(runtime, model, { messages, tools } as any, {});
    for await (const _ of s);
    return s.result();
  };
  const text = (r: any) => r.content.map((b: any) => b.text ?? "").join("");
  runtime.gate.arm("pi-tools");
  const one = await go([user("pi-tools")], [t("questionnaire"), t("mcp__doop__get_canvas"), t("mcp__docs__search"), t("tool_search")]);
  assert.match(text(one), /tools questionnaire,mcp__docs__search$/);
  // A new tool (for example from tool_search) waits for the next agy process.
  runtime.gate.arm("pi-tools");
  const msgs = [user("pi-tools"), one, user("pi-tools")];
  const two = await go(msgs, [t("questionnaire"), t("mcp__docs__search"), t("web_search")]);
  assert.match(text(two), /tools questionnaire,mcp__docs__search$/);
  runtime.stop();
  runtime.gate.arm("pi-tools");
  const three = await go([...msgs, two, user("pi-tools")], [t("questionnaire"), t("mcp__docs__search"), t("web_search")]);
  assert.match(text(three), /tools questionnaire,mcp__docs__search,web_search$/);
  runtime.stop();
  mcp.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
