import assert from "node:assert/strict";
import { test } from "node:test";
import { checkCall } from "../src/mcp.ts";
import { isPiAgentTool, isSubagentTool, updateAgyConfig } from "../src/agy-config.ts";
import { readSubagents, readTranscript, transcriptLines } from "../src/subagents.ts";
import { rosterRows, rowNames } from "../src/subagent-view.ts";
import { isBanNotice } from "../src/ban.ts";
import { budgetFrom } from "../src/gate.ts";
import { parseUsage } from "../src/usage.ts";
import { TurnGate } from "../src/gate.ts";
import { agyLevelFor, catalogFromModelsOutput, catalogFromSession, toPiModel } from "../src/models.ts";
import { describePermission, launchFromEnv } from "../src/runtime.ts";
import { stopReason, usageFrom } from "../src/translate.ts";

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });

const asst = (stopReason = "stop") => ({ role: "assistant", content: [{ type: "text", text: "ok" }], stopReason });
const userAt = (text: string, timestamp: number) => ({ role: "user", content: [{ type: "text", text }], timestamp });

test("gate: typed text is human and refills the budget", () => {
  const g = new TurnGate(Date.now, 2);
  g.arm("fix the bug");
  const d = g.decide([userAt("old", 1), asst(), userAt("fix the bug", 2)]);
  assert.deepEqual(d, { indexes: [2], human: true });
});

test("gate: a child result is automatic and uses the budget", () => {
  const g = new TurnGate(Date.now, 2);
  const msgs: any[] = [userAt("go", 1), asst()];
  for (let i = 0; i < 2; i++) {
    msgs.push(userAt(`Agent a finished: ${i}`, 10 + i));
    const d = g.decide(msgs) as any;
    assert.equal(d.human, false);
    g.commit(d.indexes.map((x: number) => msgs[x]), false);
    msgs.push(asst());
  }
  msgs.push(userAt("Agent b finished", 20));
  assert.match((g.decide(msgs) as any).refuse, /did not type/);
  g.arm("continue");
  msgs.push(userAt("continue", 21));
  const d = g.decide(msgs) as any;
  assert.deepEqual(d, { indexes: [msgs.length - 2, msgs.length - 1], human: true });
  g.commit([], true);
  assert.equal(g.autoTurns, 0);
});

test("gate: messages that agy got are not sent again (retry)", () => {
  const g = new TurnGate();
  g.arm("hi");
  const msgs: any[] = [userAt("hi", 1)];
  const d = g.decide(msgs) as any;
  g.commit([msgs[0]], d.human);
  msgs.push(asst("error"));
  assert.match((g.decide(msgs) as any).refuse, /Nothing new/);
});

test("gate: a /template token matches the expanded text", () => {
  const g = new TurnGate();
  g.arm("/review src");
  assert.equal((g.decide([userAt("Expanded template text", 1)]) as any).human, true);
});

test("gate: tokens expire", () => {
  let now = 0;
  const g = new TurnGate(() => now);
  g.arm("x");
  now = 61 * 60_000;
  assert.equal((g.decide([userAt("x", 1)]) as any).human, false);
});

test("catalog from session/new", () => {
  const c = catalogFromSession({
    models: { availableModels: ["a-low", "a-high", "b"].map((modelId) => ({ modelId, name: modelId })) },
    configOptions: [{ id: "model", name: "Model", type: "select", currentValue: "a", options: [{ value: "a", name: "A" }, { value: "b", name: "B" }] }],
  });
  assert.deepEqual(c, [
    { id: "a", name: "A", levels: ["low", "high"] },
    { id: "b", name: "B", levels: [] },
  ]);
  assert.equal(toPiModel(c[1]).reasoning, false);
});

test("catalog from agy models output", () => {
  const out = "Fetching available models...\ngemini-4-neon-high\tGemini 4 Neon (High)\ngemini-4-neon-low\tGemini 4 Neon (Low)\ngpt-oss-120b-medium\tGPT-OSS 120B (Medium)\n";
  const c = catalogFromModelsOutput(out)!;
  assert.deepEqual(c[0], { id: "gemini-4-neon", name: "Gemini 4 Neon", levels: ["low", "high"] });
  assert.equal(c[1].id, "gpt-oss-120b");
  assert.equal(catalogFromModelsOutput("Please sign in to view available models"), undefined);
});

test("thinking level mapping picks the nearest level", () => {
  assert.equal(agyLevelFor({ levels: ["low", "medium", "high"] }, "xhigh"), "high");
  assert.equal(agyLevelFor({ levels: ["low", "medium", "high", "xhigh"] }, "max"), "xhigh");
  assert.equal(agyLevelFor({ levels: ["low", "high"] }, "minimal"), "low");
  assert.equal(agyLevelFor({ levels: [] }, "high"), undefined);
});

test("stop reasons and usage", () => {
  assert.equal(stopReason("end_turn"), "stop");
  assert.equal(stopReason("max_tokens"), "length");
  assert.equal(stopReason("cancelled"), "aborted");
  assert.equal(usageFrom({ inputTokens: 3, outputTokens: 4 })?.totalTokens, 7);
  assert.equal(usageFrom({}), undefined);
});

test("agent tool policy", () => {
  const s = new Set<string>();
  assert.match(checkCall({ action: "start", name: "a", model: "antigravity/gemini-4-neon", task: "x" }, s)!, /may not run on antigravity/);
  assert.match(checkCall({ action: "start", name: "a", task: "x" }, s)!, /needs model/);
  assert.match(checkCall({ action: "status" }, s, true)!, /disabled/);
  assert.match(checkCall({ action: "start", name: "a", task: "x", host: "h" }, s)!, /remote hosts/);
  assert.equal(checkCall({ action: "start", name: "a", model: "claude-code/claude-opus-5-5", task: "x" }, s), undefined);
  assert.match(checkCall({ action: "send", name: "other", text: "x" }, s)!, /no child other/);
  s.add("a");
  assert.equal(checkCall({ action: "wait", name: "a" }, s), undefined);
  assert.equal(checkCall({ action: "wait" }, s), undefined);
  assert.match(checkCall({ action: "hosts" }, s)!, /unknown action/);
});

test("launch from env", () => {
  assert.deepEqual(launchFromEnv({}), { command: "agy", args: ["acp"], env: {} });
  assert.deepEqual(launchFromEnv({ PI_ANTIGRAVITY_COMMAND: "/x/agy_acp_server" }).args, []);
  assert.deepEqual(launchFromEnv({ PI_ANTIGRAVITY_ARGS: "acp --agent reviewer" }).args, ["acp", "--agent", "reviewer"]);
});

test("permission title", () => {
  const t = describePermission({
    sessionId: "s",
    toolCall: { toolCallId: "1", title: "Run command", rawInput: { command: "rm -rf build" }, content: [{ type: "diff", path: "a.ts", oldText: "x", newText: "y\nz" }] },
    options: [],
  });
  assert.match(t, /Run command/);
  assert.match(t, /\$ rm -rf build/);
  assert.match(t, /a\.ts \(\+2 −1\)/);
});

test("subagent tool calls are recognized", () => {
  assert.ok(isSubagentTool({ title: "Run invoke_subagent" }));
  assert.ok(isSubagentTool({ title: "Running start_subagent" }));
  assert.ok(!isSubagentTool({ title: "Run npm test" }));
});

test("Pi's agent tool title", () => {
  assert.ok(isPiAgentTool({ title: "Run mcp_pi_agent" }));
  assert.ok(isPiAgentTool({ title: "Running mcp_pi_agent" }));
  assert.ok(!isPiAgentTool({ title: "Run mcp_other_agent" }));
  assert.ok(!isPiAgentTool({ title: "Run mcp_pi_agent_x" }));
});

test("updateAgyConfig removes the old allow rule and hook, keeping the rest", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agycfg-"));
  const p = { settingsJson: path.join(dir, "settings.json"), hooksJson: path.join(dir, "hooks.json"), oldStateDir: path.join(dir, "state") };
  fs.writeFileSync(p.settingsJson, JSON.stringify({ trustedWorkspaces: ["/x"], permissions: { allow: ["command(git)", "mcp(pi/*)"] } }));
  fs.writeFileSync(p.hooksJson, JSON.stringify({ mine: { PreToolUse: [] }, "pi-antigravity-guard": { enabled: true } }));
  assert.equal(updateAgyConfig(p).length, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(p.settingsJson, "utf8")), { trustedWorkspaces: ["/x"], permissions: { allow: ["command(git)"] } });
  assert.deepEqual(JSON.parse(fs.readFileSync(p.hooksJson, "utf8")), { mine: { PreToolUse: [] } });
  assert.deepEqual(updateAgyConfig(p), []);
  fs.writeFileSync(p.settingsJson, JSON.stringify({ trustedWorkspaces: ["/x"], permissions: { allow: ["mcp(pi/*)"] } }));
  updateAgyConfig(p);
  assert.deepEqual(JSON.parse(fs.readFileSync(p.settingsJson, "utf8")), { trustedWorkspaces: ["/x"] });
  fs.rmSync(dir, { recursive: true });
});

test("agy subagents from its records", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const brain = fs.mkdtempSync(path.join(os.tmpdir(), "brain-"));
  const parent = "395cab90-24ad-40ce-8663-cda27baf6ede";
  const a = "faa81dcb-1094-418e-b96d-ac0a0fcc6a0d";
  const b = "0b0b0b0b-1094-418e-b96d-ac0a0fcc6a0d";
  const sg = path.join(brain, parent, ".system_generated");
  fs.mkdirSync(path.join(sg, "subagents"), { recursive: true });
  fs.mkdirSync(path.join(sg, "messages"), { recursive: true });
  fs.writeFileSync(path.join(sg, "subagents", `${a}.json`), JSON.stringify({ conversationId: a, subagentDescriptor: { typeName: "self", role: "counter" }, state: "SUBAGENT_STATE_ALIVE" }));
  fs.writeFileSync(path.join(sg, "subagents", `${b}.json`), JSON.stringify({ conversationId: b, subagentDescriptor: { role: "Tester" }, state: "SUBAGENT_STATE_ALIVE" }));
  fs.writeFileSync(path.join(sg, "messages", "m1.json"), JSON.stringify({ sender: "system", timestamp: new Date(Date.now() + 60_000).toISOString(), content: `Subagent ${a} has gone idle. This was the subagent's most recent response: seven` }));
  fs.writeFileSync(path.join(sg, "messages", "read.json"), "{}");
  const logs = path.join(brain, a, ".system_generated", "logs");
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(
    path.join(logs, "transcript.jsonl"),
    [
      { step_index: 0, type: "SYSTEM_MESSAGE", status: "DONE", content: "x\n<SYSTEM_MESSAGE>\n[Message] sender=p content=Reply seven.\n</SYSTEM_MESSAGE>" },
      { step_index: 1, type: "PLANNER_RESPONSE", status: "DONE", content: "seven", tool_calls: [{ name: "view_file" }] },
    ].map((x) => JSON.stringify(x)).join("\n"),
  );
  const list = readSubagents(parent, brain);
  const byRole = Object.fromEntries(list.map((s) => [s.role, s]));
  assert.equal(byRole.counter.status, "idle");
  assert.equal(byRole.counter.lastReply, "seven");
  assert.equal(byRole.Tester.status, "working");
  assert.deepEqual(transcriptLines(readTranscript(a, brain)), ["message: Reply seven.", "▸ view_file", "reply: seven"]);
  const rows = rosterRows(list);
  assert.deepEqual(rows.map((r) => [r.name, r.status]).sort(), [["agy-counter", "idle"], ["agy-tester", "working"]]);
  assert.deepEqual([...rowNames([{ ...list[0], role: "x" }, { ...list[1], role: "x" }]).values()], ["agy-x", "agy-x-2"]);
  assert.deepEqual(readSubagents("not-an-id", brain), []);
  fs.rmSync(brain, { recursive: true });
});

test("ban notice", () => {
  assert.ok(isBanNotice("This service has been disabled in this account for violation of Terms of Service. Please submit an appeal to continue using this product."));
  assert.ok(isBanNotice('{"error":{"code":403,"details":[{"reason":"TOS_VIOLATION"}]}}'));
  assert.ok(!isBanNotice("All tests pass."));
  assert.ok(!isBanNotice(`${"x".repeat(3000)} TOS_VIOLATION`));
});

test("budget from env", () => {
  assert.equal(budgetFrom(undefined), 2);
  assert.equal(budgetFrom("0"), 0);
  assert.equal(budgetFrom("4"), 4);
  assert.equal(budgetFrom("x"), 2);
});

test("usage from agy -p /usage", () => {
  const rows = parseUsage("Gemini Models\tWeekly Limit Remaining\t100%\t2026-11-28T13:24:16Z\nClaude and GPT models\tFive Hour Limit Remaining\t80%\t1970-01-01T00:00:00Z\nnoise\n");
  assert.deepEqual(rows, [
    { group: "Gemini Models", window: "Weekly Limit Remaining", remaining: "100%", resets: "2026-11-28T13:24:16Z" },
    { group: "Claude and GPT models", window: "Five Hour Limit Remaining", remaining: "80%", resets: undefined },
  ]);
});

test("a blank line separates tool lines from the next thinking block", async () => {
  const { Translator, GAP } = await import("../src/translate.ts");
  const output: any = { content: [] };
  const t = new Translator(output, undefined);
  t.update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "plan" } } as any);
  t.update({ sessionUpdate: "tool_call", toolCallId: "1", title: "File a", status: "completed" } as any);
  t.update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "next" } } as any);
  t.finish();
  assert.equal(output.content[1].text, `▸ File a ✓${GAP}`);
  assert.ok(output.content[1].text.trim().endsWith("\u200b"));
  assert.equal(t.text, "▸ File a ✓");
});

test("dirs: inside, too wide, covers, nested folders", async () => {
  const { Dirs, inside, tooWide, requestPaths, readAlways, addAlways } = await import("../src/dirs.ts");
  assert.ok(inside("/a/b/c", "/a/b") && inside("/a/b", "/a/b") && !inside("/a/bc", "/a/b"));
  assert.ok(tooWide("/home/m", "/home/m") && tooWide("/home", "/home/m") && tooWide("/", "/home/m"));
  assert.ok(!tooWide("/home/m/.local/share/worktrees/kojama", "/home/m"));
  const d = new Dirs(() => ["/w/kojama"]);
  assert.ok(!d.add("/w/kojama/phone-page", "/p"));
  assert.ok(d.add("/x/y", "/p") && !d.add("/x/y/z", "/p") && !d.add("/p/sub", "/p"));
  assert.deepEqual(d.list("/p"), ["/w/kojama", "/x/y"]);
  assert.ok(d.covers(["/x/y/f"], "/p") && !d.covers(["/p/f"], "/p") && !d.covers([], "/p") && !d.covers(["/x/y/f", "/z"], "/p"));
  assert.deepEqual(requestPaths({ toolCall: { locations: [{ path: "a.md" }], rawInput: { AbsolutePath: "/b" } } }, "/p"), ["/p/a.md", "/b"]);
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pi-ag-cfg-")), "c.json");
  assert.deepEqual(readAlways(file), []);
  addAlways("/w/a", file);
  addAlways("/w/a", file);
  assert.deepEqual(readAlways(file), ["/w/a"]);
});

test("prices: Pi's registry first, then the pi.dev list (saved for a day)", async () => {
  const { Prices, pricesFromCatalog, sellerOf } = await import("../src/prices.ts");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  assert.equal(sellerOf("gemini-4-neon"), "google");
  assert.equal(sellerOf("claude-opus-5-5"), "anthropic");
  assert.equal(sellerOf("gpt-oss-120b"), undefined);
  assert.deepEqual(Object.keys(pricesFromCatalog({ "a": { id: "a", cost: { input: 1, output: 2 } }, "free": { id: "free", cost: { input: 0, output: 0 } } })), ["a"]);

  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pi-ag-prices-")), "p.json");
  let now = 1_000_000;
  const urls: string[] = [];
  let down = false;
  const fake = (async (url: URL) => {
    urls.push(url.pathname);
    if (down) throw new Error("offline");
    const p = url.pathname.split("/").pop();
    const body = p === "google" ? [{ id: "gemini-4-neon", cost: { input: 3, output: 15, cacheRead: 0.15, cacheWrite: 0 } }] : [{ id: "claude-opus-5-5", cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 } }];
    return new Response(JSON.stringify(body), { status: 200 });
  }) as any;
  const prices = new Prices(file, fake, () => now);
  const registry = (p: string, id: string) => (p === "google" && id === "gemini-4-argon" ? { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 } : undefined);

  // In Pi's registry: no request.
  assert.equal((await prices.price("gemini-4-argon", registry))?.input, 2);
  assert.equal(urls.length, 0);
  // Not in the registry: one fetch of both lists, then from memory.
  assert.equal((await prices.price("gemini-4-neon", registry))?.input, 3);
  assert.equal((await prices.price("claude-opus-5-5", registry))?.output, 20);
  assert.equal(urls.length, 2);
  // No seller: no price, no request.
  assert.equal(await prices.price("gpt-oss-120b", registry), undefined);
  assert.equal(urls.length, 2);
  // A new process reads the saved file.
  const again = new Prices(file, fake, () => now);
  assert.equal((await again.price("gemini-4-neon"))?.input, 3);
  assert.equal(urls.length, 2);
  // After a day it tries again; offline, it keeps the old list.
  now += 25 * 60 * 60 * 1000;
  down = true;
  assert.equal((await again.price("gemini-4-neon"))?.input, 3);
  assert.equal(urls.length, 3);
  // No new try within an hour of a failure.
  assert.equal((await again.price("gemini-4-neon"))?.input, 3);
  assert.equal(urls.length, 3);
});

test("sandbox: config and bwrap arguments", async () => {
  const { bwrapArgs, sandboxConfig } = await import("../src/sandbox.ts");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pi-ag-sb-")), "c.json");
  assert.equal(sandboxConfig({}, file).mode, "off");
  assert.equal(sandboxConfig({ PI_ANTIGRAVITY_SANDBOX: "bwrap" }, file).mode, "bwrap");
  fs.writeFileSync(file, JSON.stringify({ sandbox: "bwrap", sandboxReadOnly: ["~/.vite-plus"], sandboxReadWrite: ["/data"] }));
  const cfg = sandboxConfig({}, file, "/home/u");
  assert.deepEqual(cfg, { mode: "bwrap", readOnly: ["/home/u/.vite-plus"], readWrite: ["/data"] });
  assert.equal(sandboxConfig({ PI_ANTIGRAVITY_SANDBOX: "off" }, file).mode, "off");

  const a = bwrapArgs({
    home: "/home/u",
    uid: 1000,
    workspace: ["/home/u/p", "/home/u/wt/a", "/home/u/p/.git"],
    readOnly: ["/home/u/.nix-profile", "/home/u/p"],
    readWrite: ["/home/u/.gemini"],
    settingsFile: "/run/x/settings.json",
    busSocket: "/run/x/bus",
    rootLinks: { "/bin": "usr/bin", "/lib64": "usr/lib64" },
    unsetEnv: ["OPENAI_API_KEY"],
    command: ["/nix/store/x/bin/agy", "acp"],
  });
  const s = a.join(" ");
  // home is empty; only the listed folders come back.
  assert.ok(s.includes("--tmpfs /home/u"));
  assert.ok(s.indexOf("--tmpfs /home/u") < s.indexOf("--bind /home/u/p /home/u/p"));
  // the cwd is read-write even if also listed read-only, and must exist.
  assert.ok(s.includes("--bind /home/u/p /home/u/p") && !s.includes("--ro-bind-try /home/u/p /home/u/p"));
  // parents before children: the git dir comes after its project.
  assert.ok(s.indexOf("--bind /home/u/p /home/u/p") < s.indexOf("--bind-try /home/u/p/.git"));
  assert.ok(s.includes("--symlink usr/bin /bin") && s.includes("--ro-bind-try /sbin /sbin"));
  assert.ok(s.includes("--ro-bind /run/x/settings.json /home/u/.gemini/antigravity-cli/settings.json"));
  assert.ok(s.indexOf("--bind-try /home/u/.gemini") < s.indexOf("/home/u/.gemini/antigravity-cli/settings.json"));
  assert.ok(s.includes("--ro-bind /run/x/bus /run/user/1000/bus"));
  assert.ok(s.includes("--unsetenv OPENAI_API_KEY") && s.includes("--unsetenv SSH_AUTH_SOCK"));
  assert.ok(s.includes("--chdir /home/u/p"));
  assert.deepEqual(a.slice(-3), ["--", "/nix/store/x/bin/agy", "acp"]);
  // no D-Bus proxy: the host bus is not passed in.
  const b = bwrapArgs({ home: "/h", uid: 1, workspace: ["/w"], readOnly: [], readWrite: [], rootLinks: {}, unsetEnv: [], command: ["agy"] });
  assert.ok(b.join(" ").includes("--unsetenv DBUS_SESSION_BUS_ADDRESS"));
});
