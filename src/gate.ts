// The human-driven turn gate. Google permits agy on a consumer sign-in only
// when a human drives the session, so every prompt that pi-antigravity sends
// must come from text that you typed. The `input` handler arms one token per
// typed message; each model call uses one. Auto-retry, compaction and branch
// summaries, and prompts from extensions or RPC find no token and are refused.

const TOKEN_TTL_MS = 60 * 60_000;

export interface Token {
  text: string;
  at: number;
}

export const REFUSAL =
  "Antigravity accepts only prompts that you type in Pi. Retries, automatic summaries, and prompts from extensions, RPC, or print mode are not sent (Google permits only human-driven sessions on a subscription).";

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

export class TurnGate {
  private tokens: Token[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  /** A message that you typed is about to start or queue a turn. */
  arm(text: string) {
    this.prune();
    this.tokens.push({ text, at: this.now() });
  }

  /**
   * Finds the user message that a token authorizes, newest first, and uses
   * the token. A token for `/template` or `/skill:x` input matches the newest
   * user message, because Pi expands the text after the input event.
   * Returns the index of the authorized message, or -1 to refuse.
   */
  take(messages: { role: string; content: unknown }[]): number {
    this.prune();
    if (!this.tokens.length) return -1;
    // Only the newest few user messages can be the typed one.
    const recent: number[] = [];
    for (let i = messages.length - 1; i >= 0 && recent.length < 4; i--) if (messages[i].role === "user") recent.push(i);
    for (let t = 0; t < this.tokens.length; t++) {
      const want = norm(this.tokens[t].text);
      for (const i of recent) {
        const text = norm(textOf(messages[i].content));
        if (want.startsWith("/") ? i === recent[0] : want ? text.includes(want) : i === recent[0]) {
          // Use this token; older ones were for turns that never reached agy.
          this.tokens.splice(0, t + 1);
          return i;
        }
      }
    }
    return -1;
  }

  clear() {
    this.tokens = [];
  }

  get pending() {
    this.prune();
    return this.tokens.length;
  }

  private prune() {
    const cutoff = this.now() - TOKEN_TTL_MS;
    this.tokens = this.tokens.filter((t) => t.at >= cutoff);
  }
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((c: any) => (c?.type === "text" ? c.text : "")).join("\n");
}

/** Whether an `input` event may arm a token. */
export function isHumanInput(event: { source?: string }, hasUI: boolean): boolean {
  return event.source === "interactive" && hasUI;
}
