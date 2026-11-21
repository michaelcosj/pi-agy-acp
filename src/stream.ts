// One Pi model call → one ACP `session/prompt`.
import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { isAuthRequired } from "./acp/agent.ts";
import type { PromptBlock } from "./acp/types.ts";
import { REFUSAL } from "./gate.ts";
import { deniedCommand } from "./guard.ts";
import { log } from "./log.ts";
import { agyLevelFor, FALLBACK_CATALOG } from "./models.ts";
import type { Runtime } from "./runtime.ts";
import { stopReason, Translator, usageFrom } from "./translate.ts";

export const LOGIN_HINT = "Antigravity is not signed in. Run `agy` once in a terminal and sign in with Google, then try again.";

type Msg = { role: string; content: any; timestamp?: number; customType?: string };

function emptyUsage(): AssistantMessage["usage"] {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function textOf(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c: any) => (c.type === "text" ? c.text : c.type === "thinking" ? "" : c.type === "image" ? "[image]" : c.type === "toolCall" ? `[tool call ${c.name}]` : ""))
    .filter(Boolean)
    .join("\n");
}

/** User message → ACP prompt blocks. */
export function promptBlocks(message: Msg, prefix?: string): PromptBlock[] {
  const blocks: PromptBlock[] = [];
  if (prefix) blocks.push({ type: "text", text: prefix });
  if (typeof message.content === "string") blocks.push({ type: "text", text: message.content });
  else
    for (const c of message.content ?? []) {
      if (c.type === "text" && c.text) blocks.push({ type: "text", text: c.text });
      else if (c.type === "image") blocks.push({ type: "image", data: c.data, mimeType: c.mimeType });
    }
  return blocks;
}

/** Earlier Pi messages that agy has not seen, as one text block. */
export function historyText(messages: Msg[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    const t = textOf(m.content).trim();
    if (!t) continue;
    const who = m.role === "assistant" ? "Assistant" : m.role === "toolResult" ? "Tool result" : "User";
    lines.push(`### ${who}\n${t}`);
  }
  if (!lines.length) return "";
  return `<earlier_conversation note="Shown in Pi before this Antigravity session started. Context only.">\n${lines.join("\n\n")}\n</earlier_conversation>\n\n`;
}

export function streamAntigravity(runtime: Runtime, model: Model<any>, context: { messages: Msg[] }, options?: SimpleStreamOptions): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const output: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: "pending",
    timestamp: Date.now(),
  };

  const fail = (message: string, reason: "error" | "aborted" = "error") => {
    output.stopReason = reason;
    output.errorMessage = message;
    stream.push({ type: "error", reason, error: output });
    stream.end();
  };

  void (async () => {
    let sessionId: string | undefined;
    let abort: (() => void) | undefined;
    try {
      const messages = context.messages.filter((m) => m.role !== "system");
      // Gate: a human-typed message must be the reason for this call. Only
      // that message is sent; text that other extensions add is not.
      if (!runtime.ctx?.hasUI) return fail(REFUSAL);
      const index = runtime.gate.take(messages);
      if (index < 0) {
        log({ event: "refused", reason: "no token" });
        return fail(REFUSAL);
      }
      const last = messages[index];
      const denied = deniedCommand(textOf(last.content));
      if (denied) return fail(`/${denied} is turned off in Pi (subagents and swarms are denied).`);

      const cwd = runtime.ctx.cwd;
      const s = await runtime.session(cwd);
      sessionId = s.sessionId;

      // Model and thinking level for this turn.
      const entry = runtime.catalog.find((e) => e.id === model.id) ??
        FALLBACK_CATALOG.find((e) => e.id === model.id) ?? { levels: ["low", "medium", "high"] as ("low" | "medium" | "high")[] };
      await runtime.setOption(sessionId, "model", model.id);
      const level = model.reasoning ? agyLevelFor(entry, options?.reasoning) : undefined;
      if (level) await runtime.setOption(sessionId, "thought_level", level).catch(() => {});

      // Messages that agy has not seen (a new session, or turns on another model).
      const unseen = runtime.unseen(messages.slice(0, index), s.fresh);
      let prefix: string | undefined;
      if (unseen.length) {
        const send = await runtime.ctx.ui.confirm(
          "Antigravity",
          `${unseen.length} earlier message${unseen.length === 1 ? " is" : "s are"} not in the Antigravity session. Send ${unseen.length === 1 ? "it" : "them"} as context with your message?`,
        );
        if (send) prefix = historyText(unseen);
      }

      const translator = new Translator(output, stream, {
        onToolStatus: (running) => runtime.ctx?.ui.setStatus("antigravity", running.length ? `agy: ${running[running.length - 1]}` : undefined),
        onTitle: (title) => {
          if (!runtime.pi?.getSessionName()) runtime.pi?.setSessionName(title);
        },
        onCommands: (c) => {
          runtime.commands = c;
        },
        onMode: (m) => {
          runtime.mode = m;
        },
      });
      stream.push({ type: "start", partial: output });
      runtime.violation = undefined;
      runtime.beginPrompt(sessionId, translator);

      const sid = sessionId;
      abort = () => s.agy.cancel(sid);
      if (options?.signal?.aborted) abort();
      options?.signal?.addEventListener("abort", abort, { once: true });

      log({ event: "prompt", model: model.id, level, history: unseen.length, prefix: !!prefix });
      const result = await s.agy.prompt(sessionId, promptBlocks(last, prefix));
      const cancelled = result.stopReason === "cancelled" || !!options?.signal?.aborted;
      translator.finish(cancelled);
      runtime.markSeen();
      output.stopReason = cancelled ? "aborted" : stopReason(result.stopReason);
      output.rawStopReason = result.stopReason;
      const usage = usageFrom(result.usage ?? (result._meta as any)?.usage);
      if (usage) output.usage = usage;
      output.providerThinkingLevel = level;
      log({ event: "prompt_end", stopReason: result.stopReason });
      if (runtime.violation) return fail(`Antigravity ran ${runtime.violation}, which is denied in Pi. The turn was cancelled.`);
      if (output.stopReason === "aborted") return fail("Cancelled", "aborted");
      if (output.stopReason === "error") return fail(`Antigravity refused the request (${result.stopReason}).`);
      stream.push({ type: "done", reason: output.stopReason as "stop" | "length", message: output });
      stream.end();
    } catch (e) {
      const message = isAuthRequired(e) ? LOGIN_HINT : (e as Error).message;
      log({ event: "prompt_error", error: String(message).slice(0, 200) });
      if (/exited|closed|stopped/i.test(message)) runtime.unbind();
      fail(message, options?.signal?.aborted ? "aborted" : "error");
    } finally {
      if (abort) options?.signal?.removeEventListener("abort", abort);
      runtime.endPrompt();
      runtime.ctx?.ui.setStatus("antigravity", undefined);
    }
  })();
  return stream;
}
