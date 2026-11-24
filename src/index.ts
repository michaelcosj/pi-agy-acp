import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isHumanInput } from "./gate.ts";
import { log, LOG_PATH } from "./log.ts";
import { PROVIDER_ID } from "./models.ts";
import { createAntigravityProvider } from "./provider.ts";
import { agyPaths, updateAgyConfig } from "./agy-config.ts";
import { BANNED } from "./ban.ts";
import { type McpServerHandle, startMcpServer } from "./mcp.ts";
import { readUsage, usageLines } from "./usage.ts";
import { registerSubagentView } from "./subagent-view.ts";
import { addChildDir, type Binding, launchFromEnv, MODE, Runtime, SESSION_ENTRY, STEER_PREFIX } from "./runtime.ts";
import { DIRS_ENTRY } from "./dirs.ts";

export default function antigravityExtension(pi: ExtensionAPI): void {
  const runtime = new Runtime();
  runtime.pi = pi as any;
  pi.registerProvider(createAntigravityProvider(runtime));
  let mcp: McpServerHandle | undefined;

  // Google's suspension notice: stop the children and all automatic turns.
  runtime.onBan = () => {
    if (mcp) {
      mcp.banned = true;
      mcp.stopAll();
    }
    runtime.ctx?.ui.notify(BANNED, "error");
    runtime.ctx?.ui.setStatus("antigravity", "agy: DISABLED by Google (TOS_VIOLATION)");
  };

  const usingAntigravity = (ctx: ExtensionContext) => ctx.model?.provider === PROVIDER_ID;

  function restore(ctx: ExtensionContext) {
    runtime.ctx = ctx as any;
    runtime.gate.clear();
    let binding: Binding | undefined;
    let dirs: string[] = [];
    for (const e of ctx.sessionManager.getBranch()) {
      if (e.type === "custom" && e.customType === SESSION_ENTRY) binding = e.data as Binding;
      if (e.type === "custom" && e.customType === DIRS_ENTRY && Array.isArray((e.data as any)?.dirs)) dirs = (e.data as any).dirs;
    }
    runtime.dirs.session = dirs.filter((d) => typeof d === "string");
    if (binding?.sessionId !== runtime.binding?.sessionId) runtime.unbind();
    runtime.binding = binding ? { ...binding } : undefined;
  }

  // Remove pi-antigravity's earlier changes to agy's config.
  const paths = agyPaths();
  function ensureAgyConfig(ctx?: ExtensionContext) {
    try {
      const changed = updateAgyConfig(paths);
      if (changed.length) ctx?.ui.notify(`pi-antigravity updated agy config:\n${changed.join("\n")}`, "info");
    } catch (e) {
      ctx?.ui.notify(`pi-antigravity could not update agy config: ${(e as Error).message}`, "error");
    }
  }

  // A local child agent's folder (often its own worktree) joins agy's workspace.
  const offs: (() => void)[] = [];
  const offChildCwd = pi.events?.on?.("agent-bridge:child-cwd", (data: any) => {
    const ctx = runtime.ctx;
    if (ctx && addChildDir(runtime, data?.cwd, runtime.binding?.cwd ?? ctx.cwd)) log({ event: "child_dir" });
  });
  if (offChildCwd) offs.push(offChildCwd);

  // agy's own subagents: read-only rows in agent-bridge's list, and a viewer.
  offs.push(registerSubagentView(pi, runtime));

  pi.on("session_start", async (_e, ctx) => {
    restore(ctx);
    ensureAgyConfig(ctx);
    // Pi's agent tool for agy, over an in-process MCP server. Not in a child pi.
    if (!process.env.PI_BRIDGE_PARENT && process.env.PI_ANTIGRAVITY_AGENT_TOOL !== "0") {
      mcp = await startMcpServer(pi as any).catch(() => undefined);
      const m = mcp;
      if (m) runtime.mcpServers = () => [m.acpEntry()];
    }
  });
  pi.on("session_tree", (_e, ctx) => restore(ctx));
  // Also on reload: Pi then loads a new copy of this extension, and this copy's
  // pi and ctx are stale. A call on them throws and ends Pi. The new copy
  // resumes the agy session from the session entries.
  pi.on("session_shutdown", () => {
    runtime.stop();
    runtime.pi = undefined;
    runtime.ctx = undefined;
    runtime.onBan = undefined;
    for (const off of offs.splice(0)) off();
  });

  // ---- input: typed text refills the gate's budget; steers go to agy now ----
  pi.on("input", (event, ctx) => {
    runtime.ctx = ctx as any;
    if (!usingAntigravity(ctx)) return { action: "continue" };
    if (!isHumanInput(event, ctx.hasUI)) {
      log({ event: "input_ignored", source: event.source });
      return { action: "continue" };
    }
    // During an Antigravity turn, a steer goes to agy now (agy reads a
    // prompt sent mid-turn as a steer). Pi would hold it until the turn ends.
    if (event.streamingBehavior === "steer" && runtime.activePrompt && runtime.process) {
      const { sessionId } = runtime.activePrompt;
      const agy = runtime.process;
      const blocks: any[] = [{ type: "text", text: event.text }];
      for (const img of event.images ?? []) blocks.push({ type: "image", data: img.data, mimeType: img.mimeType });
      void agy.prompt(sessionId, blocks).catch((err) => ctx.ui.notify(`Steer failed: ${(err as Error).message}`, "error"));
      pi.sendMessage({ customType: "antigravity-steer", content: STEER_PREFIX + event.text, display: true });
      log({ event: "steer" });
      return { action: "handled" };
    }
    runtime.gate.arm(event.text);
    return { action: "continue" };
  });

  pi.on("model_select", (e, ctx) => {
    runtime.ctx = ctx as any;
    if (e.model.provider !== PROVIDER_ID) runtime.ctx?.ui.setStatus("antigravity", undefined);
  });

  // ---- compaction: agy owns the real context ----
  pi.on("session_before_compact", async (event, ctx) => {
    if (!usingAntigravity(ctx)) return;
    if (event.reason !== "manual") {
      log({ event: "compact_cancelled", reason: event.reason });
      return { cancel: true };
    }
    // You ran /compact: run agy's own /compact in the bound session.
    const binding = runtime.binding;
    if (!binding || !runtime.commands.some((c) => c.name === "compact")) {
      ctx.ui.notify("Antigravity compacts its own context. Nothing to compact yet.", "info");
      return { cancel: true };
    }
    try {
      const agy = await runtime.ensure();
      const s = await runtime.session(ctx.cwd);
      const instructions = event.customInstructions?.trim();
      ctx.ui.setStatus("antigravity", "agy: compacting…");
      await agy.prompt(s.sessionId, [{ type: "text", text: `/compact${instructions ? ` ${instructions}` : ""}` }]);
      runtime.markSeen();
      return {
        compaction: {
          summary: "Antigravity compacted its own context (agy /compact). The Antigravity session keeps its own summary.",
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
        },
      };
    } catch (e) {
      ctx.ui.notify(`agy /compact failed: ${(e as Error).message}`, "error");
      return { cancel: true };
    } finally {
      ctx.ui.setStatus("antigravity", undefined);
    }
  });

  // agy keeps its own context, so a Pi branch summary is not useful.
  pi.on("session_before_tree", (event, ctx) => {
    if (!usingAntigravity(ctx) || !event.preparation.userWantsSummary) return;
    return { summary: { summary: "(Branch summaries are off for Antigravity. The next message starts a new Antigravity session.)" } };
  });

  // ---- commands ----
  pi.registerCommand("antigravity-status", {
    description: "Show the Antigravity CLI, sign-in, quota, session, and mode",
    handler: async (_args, ctx) => {
      runtime.ctx = ctx as any;
      try {
        const agy = await runtime.ensure();
        const probe = runtime.catalog.length ? { catalog: runtime.catalog } : await runtime.probe();
        if (probe) runtime.catalog = probe.catalog;
        const command = launchFromEnv().command;
        const usage = command.endsWith("agy_acp_server")
          ? ["  (needs the agy CLI)"]
          : await readUsage(command).then(
              (rows) => (rows.length ? usageLines(rows) : ["  (agy printed no quota)"]),
              (e) => [`  (could not read: ${(e as Error).message.split("\n")[0]})`],
            );
        const lines = [
          ...(runtime.banned ? [BANNED] : []),
          `agy ${agy.version ?? "?"}: ${probe ? "signed in" : "NOT signed in (run agy)"}${runtime.tier ? ` · ${runtime.tier}` : ""}`,
          `Session: ${runtime.binding?.sessionId ?? "none yet"} · mode: ${MODE} (fixed)`,
          `Extra folders: ${runtime.dirs.list(runtime.binding?.cwd ?? ctx.cwd).join(", ") || "none"}`,
          "Quota:",
          ...usage,
          `Models: ${runtime.catalog.map((e) => e.id).join(", ") || "?"}`,
          `Agent tool (MCP): ${runtime.mcpServers().length ? "on" : "off"}`,
          `Turns that you did not type: ${runtime.gate.budget ? `${runtime.gate.autoTurns}/${runtime.gate.budget} since your last message` : "off"}`,
          `agy subagents: ${runtime.subagents.list.length ? runtime.subagents.list.map((x) => `${x.role} [${x.status}]`).join(", ") : "none"}`,
          process.env.PI_ANTIGRAVITY_LOG === "1" ? `Log: ${LOG_PATH}` : "Log: off (PI_ANTIGRAVITY_LOG=1)",
        ];
        ctx.ui.notify(lines.join("\n"), probe ? "info" : "error");
      } catch (e) {
        ctx.ui.notify(`Antigravity is not ready: ${(e as Error).message}`, "error");
      }
    },
  });

  pi.registerCommand("agy", {
    description: "Run an Antigravity slash command, for example /agy goal <objective>",
    getArgumentCompletions: (prefix) =>
      runtime.commands
        .filter((c) => c.name.startsWith(prefix))
        .map((c) => ({ value: c.name, label: c.name, description: c.description })),
    handler: async (args, ctx) => {
      runtime.ctx = ctx as any;
      const text = args.trim();
      if (!text) {
        const list = runtime.commands.map((c) => `/${c.name}${c.description ? ` — ${c.description}` : ""}`).join("\n");
        return ctx.ui.notify(list || "No Antigravity commands yet. Send a message first.", "info");
      }
      if (!usingAntigravity(ctx)) return ctx.ui.notify("Select an antigravity/... model first.", "error");
      // You typed this command: it counts as typed input.
      runtime.gate.arm(`/${text}`);
      pi.sendUserMessage(`/${text}`, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
    },
  });
}

export { createAntigravityProvider } from "./provider.ts";
