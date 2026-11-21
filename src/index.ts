import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isHumanInput } from "./gate.ts";
import { log, LOG_PATH } from "./log.ts";
import { PROVIDER_ID } from "./models.ts";
import { createAntigravityProvider } from "./provider.ts";
import { deniedCommand, guardPaths, guardStatus, installGuard } from "./guard.ts";
import { startMcpServer } from "./mcp.ts";
import { type Binding, MODE, Runtime, SESSION_ENTRY, STEER_PREFIX } from "./runtime.ts";

export default function antigravityExtension(pi: ExtensionAPI): void {
  const runtime = new Runtime();
  runtime.pi = pi as any;
  pi.registerProvider(createAntigravityProvider(runtime));

  const usingAntigravity = (ctx: ExtensionContext) => ctx.model?.provider === PROVIDER_ID;

  function restore(ctx: ExtensionContext) {
    runtime.ctx = ctx as any;
    runtime.gate.clear();
    let binding: Binding | undefined;
    for (const e of ctx.sessionManager.getBranch()) {
      if (e.type === "custom" && e.customType === SESSION_ENTRY) binding = e.data as Binding;
    }
    if (binding?.sessionId !== runtime.binding?.sessionId) runtime.unbind();
    runtime.binding = binding ? { ...binding } : undefined;
  }

  // The subagent/swarm deny hook and the allow rule for Pi's agent tool live
  // in agy's own config. Install or repair them before agy starts.
  const paths = guardPaths();
  function ensureGuard(ctx?: ExtensionContext) {
    try {
      const changed = installGuard(paths);
      if (changed.length) ctx?.ui.notify(`pi-antigravity updated agy config:\n${changed.join("\n")}`, "info");
    } catch (e) {
      ctx?.ui.notify(`pi-antigravity could not install its agy hook: ${(e as Error).message}`, "error");
    }
  }

  pi.on("session_start", async (_e, ctx) => {
    restore(ctx);
    ensureGuard(ctx);
    // Pi's agent tool for agy, over an in-process MCP server. Not in a child pi.
    if (!process.env.PI_BRIDGE_PARENT && process.env.PI_ANTIGRAVITY_AGENT_TOOL !== "0") {
      const mcp = await startMcpServer(pi as any).catch(() => undefined);
      if (mcp) runtime.mcpServers = () => [mcp.acpEntry()];
    }
  });
  pi.on("session_tree", (_e, ctx) => restore(ctx));
  pi.on("session_shutdown", (e) => {
    if (e.reason === "reload") return;
    runtime.stop();
  });

  // ---- the gate: only text that you type reaches agy ----
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

  // A branch summary would be a prompt that no human typed.
  pi.on("session_before_tree", (event, ctx) => {
    if (!usingAntigravity(ctx) || !event.preparation.userWantsSummary) return;
    return { summary: { summary: "(Branch summaries are off for Antigravity. The next message starts a new Antigravity session.)" } };
  });

  // ---- commands ----
  pi.registerCommand("antigravity-status", {
    description: "Show the Antigravity CLI, sign-in, session, and mode",
    handler: async (_args, ctx) => {
      runtime.ctx = ctx as any;
      try {
        const agy = await runtime.ensure();
        const probe = runtime.catalog.length ? { catalog: runtime.catalog } : await runtime.probe();
        if (probe) runtime.catalog = probe.catalog;
        const lines = [
          `agy ${agy.version ?? "?"}: ${probe ? "signed in" : "NOT signed in (run agy)"}${runtime.tier ? ` · ${runtime.tier}` : ""}`,
          `Session: ${runtime.binding?.sessionId ?? "none yet"} · mode: ${MODE} (fixed)`,
          `Models: ${runtime.catalog.map((e) => e.id).join(", ") || "?"}`,
          `Agent tool (MCP): ${runtime.mcpServers().length ? "on" : "off"}`,
          (() => {
            const g = guardStatus(paths);
            return `Subagent/swarm deny hook: ${g.hook && g.script ? "installed" : "MISSING"} · ${g.mcpAllow ? "mcp(pi/*) allowed" : "mcp(pi/*) NOT allowed"}`;
          })(),
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
        .filter((c) => c.name.startsWith(prefix) && !deniedCommand(`/${c.name}`))
        .map((c) => ({ value: c.name, label: c.name, description: c.description })),
    handler: async (args, ctx) => {
      runtime.ctx = ctx as any;
      const text = args.trim();
      if (!text) {
        const list = runtime.commands.map((c) => `/${c.name}${c.description ? ` — ${c.description}` : ""}`).join("\n");
        return ctx.ui.notify(list || "No Antigravity commands yet. Send a message first.", "info");
      }
      if (!usingAntigravity(ctx)) return ctx.ui.notify("Select an antigravity/... model first.", "error");
      const denied = deniedCommand(`/${text}`);
      if (denied) return ctx.ui.notify(`/${denied} is turned off in Pi (subagents and swarms are denied).`, "error");
      // You typed this command: arm the gate and send it as a user message.
      runtime.gate.arm(`/${text}`);
      pi.sendUserMessage(`/${text}`, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
    },
  });
}

export { createAntigravityProvider } from "./provider.ts";
