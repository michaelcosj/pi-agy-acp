// agy's own subagents in Pi, read-only:
// - rows in agent-bridge's agent list (↓ on an empty prompt, /agents), sent
//   over the event bus as "agent-bridge:external" with source "agy";
// - Enter on a row (or /agy-subagents) opens a viewer with the subagent's
//   role, state, last reply, and recent steps from agy's records.
// agy owns these children. Pi cannot message, steer, or stop them.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Runtime } from "./runtime.ts";
import { readTranscript, type Subagent, transcriptLines } from "./subagents.ts";

export const SOURCE = "agy";

/** A short unique row name: agy-<role>, with -2, -3 for repeats. */
export function rowNames(list: Subagent[]): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Map<string, number>();
  for (const s of list) {
    const base = `agy-${s.role.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "subagent"}`;
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    out.set(s.id, n === 1 ? base : `${base}-${n}`);
  }
  return out;
}

export function rosterRows(list: Subagent[]) {
  const names = rowNames(list);
  return list.map((s) => ({
    name: names.get(s.id)!,
    title: `${s.role} (agy subagent)`,
    status: s.status === "working" ? "working" : s.status === "killed" ? "crashed" : "idle",
    message: s.status === "killed" ? "killed" : undefined,
    runStartedAt: s.status === "working" ? s.startedAt : undefined,
    runMs: s.status === "working" ? undefined : Math.max(0, s.updatedAt - s.startedAt),
  }));
}

export function registerSubagentView(pi: ExtensionAPI, runtime: Runtime) {
  let ctxRef: any;
  const events = (pi as any).events;

  runtime.onSubagents = (list) => {
    events?.emit?.("agent-bridge:external", { source: SOURCE, agents: rosterRows(list) });
  };

  async function show(id: string) {
    const ctx = ctxRef;
    if (!ctx?.hasUI) return;
    const lines = () => {
      const s = runtime.subagents.list.find((x) => x.id === id);
      const head = s
        ? [`${s.role} — agy subagent (${s.status}) · read-only`, `id ${s.id}`, ""]
        : [`agy subagent ${id} (no longer listed)`, ""];
      const body = transcriptLines(readTranscript(id));
      if (s?.lastReply) body.push("", `last reply: ${s.lastReply}`);
      return [...head, ...(body.length ? body : ["(no steps yet)"])];
    };
    await ctx.ui.custom((tui: any, theme: any, _kb: any, done: (v: void) => void) => {
      let scroll = 0;
      const timer = setInterval(() => {
        runtime.subagents.refresh();
        tui.requestRender?.();
      }, 2000);
      timer.unref?.();
      const close = () => {
        clearInterval(timer);
        done();
      };
      return {
        render(width: number) {
          const w = Math.max(20, width - 2);
          const wrapped = lines().flatMap((l, i) => (i === 0 ? [theme.bold(l)] : wrapTextWithAnsi(l, w)));
          const height = Math.max(8, (tui.terminal?.rows ?? 30) - 8);
          const max = Math.max(0, wrapped.length - height);
          if (scroll > max) scroll = max;
          // Newest steps last: scroll counts up from the bottom.
          const start = Math.max(0, wrapped.length - height - scroll);
          const view = wrapped.slice(start, start + height).map((l) => truncateToWidth(` ${l}`, width));
          view.push(theme.fg("dim", truncateToWidth(" ↑↓ scroll · esc close · agy owns this subagent; Pi cannot message or stop it", width)));
          return view;
        },
        handleInput(data: string) {
          if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "enter")) return close();
          if (matchesKey(data, "up")) scroll++;
          else if (matchesKey(data, "down")) scroll = Math.max(0, scroll - 1);
          else if (matchesKey(data, "pageUp")) scroll += 10;
          else if (matchesKey(data, "pageDown")) scroll = Math.max(0, scroll - 10);
          tui.requestRender?.();
        },
        invalidate() {},
      };
    });
  }

  events?.on?.("agent-bridge:external-open", (d: any) => {
    if (d?.source !== SOURCE) return;
    const names = rowNames(runtime.subagents.list);
    const id = [...names].find(([, n]) => n === d.name)?.[0];
    if (id) void show(id);
  });

  pi.on("session_start", (_e, ctx) => {
    ctxRef = ctx;
    runtime.subagents.kick(30_000);
  });
  pi.on("session_tree", (_e, ctx) => {
    ctxRef = ctx;
    runtime.subagents.refresh();
  });

  pi.registerCommand("agy-subagents", {
    description: "Show Antigravity's own subagents (read-only)",
    handler: async (_args, ctx) => {
      ctxRef = ctx;
      runtime.subagents.refresh();
      const list = runtime.subagents.list;
      if (!list.length) return ctx.ui.notify("No Antigravity subagents in this session.", "info");
      const names = rowNames(list);
      const labels = list.map((s) => `${names.get(s.id)} — ${s.role} [${s.status}]${s.lastReply ? `: ${s.lastReply.slice(0, 60)}` : ""}`);
      const pick = await ctx.ui.select("Antigravity subagents (read-only)", labels);
      const i = pick === undefined ? -1 : labels.indexOf(pick);
      if (i >= 0) await show(list[i].id);
    },
  });
}
