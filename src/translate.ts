// ACP session/update → Pi assistant message events.
import type { AssistantMessage, AssistantMessageEventStream, TextContent, ThinkingContent } from "@earendil-works/pi-ai";
import type { SessionUpdate, ToolCallFields } from "./acp/types.ts";

type Block = TextContent | ThinkingContent;

export interface TurnSink {
  /** Called when a tool starts or ends, for a status line. */
  onToolStatus?: (running: string[]) => void;
  /** Called when the agent sets a session title. */
  onTitle?: (title: string) => void;
  onCommands?: (commands: { name: string; description?: string }[]) => void;
  onMode?: (modeId: string) => void;
}

const TOOL_ICON: Record<string, string> = { completed: "✓", failed: "✗" };

export function toolLine(tool: ToolCallFields): string {
  const title = (tool.title ?? tool.kind ?? "tool").replace(/\s+/g, " ").trim();
  const icon = TOOL_ICON[tool.status ?? ""] ?? "…";
  const short = title.length > 160 ? `${title.slice(0, 157)}…` : title;
  return `▸ ${short} ${icon}`;
}

function planText(entries: { content: string; status?: string }[]): string {
  const mark = (s?: string) => (s === "completed" ? "[x]" : s === "in_progress" ? "[~]" : "[ ]");
  return entries.map((e) => `- ${mark(e.status)} ${e.content}`).join("\n");
}

/**
 * Builds one Pi assistant message from agy updates. Text and thoughts stream
 * as they arrive. Tool calls become one text line when they end, because a
 * Pi `toolCall` block would make Pi run the tool itself.
 */
export class Translator {
  private current: { kind: "text" | "thinking"; index: number } | undefined;
  private readonly tools = new Map<string, ToolCallFields>();
  private readonly reported = new Set<string>();
  private plan: { content: string; status?: string }[] | undefined;
  private planShown = "";

  constructor(
    private readonly output: AssistantMessage,
    private readonly stream: AssistantMessageEventStream | undefined,
    private readonly sink: TurnSink = {},
  ) {}

  /** All text so far (used for wakes and /compact). */
  get text(): string {
    return this.output.content
      .filter((b): b is TextContent => b.type === "text")
      .map((b) => b.text)
      .join("");
  }

  update(u: SessionUpdate) {
    switch (u.sessionUpdate) {
      case "agent_message_chunk": {
        const c = (u as any).content;
        if (c?.type === "text" && c.text) this.append("text", c.text);
        else if (c?.type === "image") this.append("text", "[image]\n");
        break;
      }
      case "agent_thought_chunk": {
        const c = (u as any).content;
        if (c?.type === "text" && c.text) this.append("thinking", c.text);
        break;
      }
      case "tool_call":
      case "tool_call_update": {
        const f = u as ToolCallFields & { sessionUpdate: string };
        const prev = this.tools.get(f.toolCallId) ?? { toolCallId: f.toolCallId };
        const merged: ToolCallFields = { ...prev };
        for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== null && k !== "sessionUpdate") (merged as any)[k] = v;
        this.tools.set(f.toolCallId, merged);
        if ((merged.status === "completed" || merged.status === "failed") && !this.reported.has(merged.toolCallId)) {
          this.reported.add(merged.toolCallId);
          this.line(toolLine(merged));
        }
        this.sink.onToolStatus?.(this.running());
        break;
      }
      case "plan": {
        this.plan = (u as any).entries ?? [];
        break;
      }
      case "available_commands_update":
        this.sink.onCommands?.((u as any).availableCommands ?? []);
        break;
      case "current_mode_update":
        this.sink.onMode?.((u as any).currentModeId);
        break;
      case "session_info_update": {
        const t = (u as any).title;
        if (typeof t === "string" && t.trim()) this.sink.onTitle?.(t.trim());
        break;
      }
    }
  }

  running(): string[] {
    return [...this.tools.values()]
      .filter((t) => t.status !== "completed" && t.status !== "failed")
      .map((t) => t.title ?? t.kind ?? "tool");
  }

  /** Ends open blocks, reports tools that never ended, shows the last plan. */
  finish(cancelled = false) {
    for (const t of this.tools.values()) {
      if (this.reported.has(t.toolCallId)) continue;
      this.reported.add(t.toolCallId);
      this.line(toolLine({ ...t, status: cancelled ? "failed" : t.status }));
    }
    if (this.plan?.length) {
      const text = planText(this.plan);
      if (text !== this.planShown) {
        this.planShown = text;
        this.line(`\nPlan:\n${text}`);
      }
    }
    this.close();
    this.sink.onToolStatus?.([]);
  }

  private line(text: string) {
    const last = this.current?.kind === "text" ? (this.output.content[this.current.index] as TextContent).text : undefined;
    const prefix = last === undefined || last === "" || last.endsWith("\n") ? "" : "\n";
    this.append("text", `${prefix}${text}\n`);
  }

  private append(kind: "text" | "thinking", delta: string) {
    if (this.current?.kind !== kind) {
      this.close();
      const block: Block = kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" };
      this.output.content.push(block);
      const index = this.output.content.length - 1;
      this.current = { kind, index };
      this.stream?.push({ type: kind === "text" ? "text_start" : "thinking_start", contentIndex: index, partial: this.output });
    }
    const index = this.current.index;
    const block = this.output.content[index] as Block;
    if (block.type === "text") {
      block.text += delta;
      this.stream?.push({ type: "text_delta", contentIndex: index, delta, partial: this.output });
    } else {
      block.thinking += delta;
      this.stream?.push({ type: "thinking_delta", contentIndex: index, delta, partial: this.output });
    }
  }

  private close() {
    if (!this.current) return;
    const { index } = this.current;
    const block = this.output.content[index] as Block;
    if (block.type === "text") this.stream?.push({ type: "text_end", contentIndex: index, content: block.text, partial: this.output });
    else this.stream?.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: this.output });
    this.current = undefined;
  }
}

/** ACP stop reason → Pi stop reason. */
export function stopReason(reason: string | undefined): AssistantMessage["stopReason"] {
  switch (reason) {
    case "end_turn":
    case "max_turn_requests":
      return "stop";
    case "max_tokens":
      return "length";
    case "cancelled":
      return "aborted";
    case "refusal":
      return "error";
    default:
      return "stop";
  }
}

/** Reads token counts from agy's prompt result, whatever the field names. */
export function usageFrom(raw: Record<string, unknown> | undefined): AssistantMessage["usage"] | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const n = (...keys: string[]) => {
    for (const k of keys) {
      const v = raw[k];
      if (typeof v === "number" && Number.isFinite(v)) return v;
    }
    return 0;
  };
  const input = n("inputTokens", "input_tokens", "promptTokens", "prompt_tokens");
  const output = n("outputTokens", "output_tokens", "completionTokens", "candidatesTokens");
  const cacheRead = n("cachedReadTokens", "cacheReadTokens", "cachedTokens", "cache_read_input_tokens");
  const cacheWrite = n("cachedWriteTokens", "cacheWriteTokens", "cache_creation_input_tokens");
  const reasoning = n("thoughtTokens", "reasoningTokens", "thoughtsTokens");
  const total = n("totalTokens", "total_tokens") || input + output + cacheRead + cacheWrite;
  if (!total) return undefined;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    ...(reasoning ? { reasoning } : {}),
    totalTokens: total,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}
