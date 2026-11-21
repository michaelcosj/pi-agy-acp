// Which Pi messages start an agy turn, and a budget against runaway loops.
//
// Any new user-role message can start a turn: text that you type, a Pi child
// agent's result, or a prompt from another extension. A turn that you did not
// type uses one unit of a budget; text that you type refills it. So children
// that start children cannot loop without you. Messages that agy already got
// (Pi's auto-retry) are not sent again.

const TOKEN_TTL_MS = 60 * 60_000;
/** Turns that you did not type, per typed message. 0 turns them off. */
export const AUTO_TURNS = budgetFrom(process.env.PI_ANTIGRAVITY_AUTO_TURNS);
export function budgetFrom(v: string | undefined): number {
  const n = Number(v);
  return v?.trim() && Number.isInteger(n) && n >= 0 ? n : 2;
}

export interface Token {
  text: string;
  at: number;
}

export const NO_UI = "Antigravity runs only in an interactive Pi session (Pi is its UI). Print and RPC mode are not supported.";
export const NOTHING_NEW = "Nothing new to send to Antigravity (it already has these messages).";
export const budgetUsed = (n: number) =>
  `Antigravity ran ${n} turn${n === 1 ? "" : "s"} that you did not type. Pending results stay in the conversation; type a message to continue.`;

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

type Msg = { role: string; content?: unknown; timestamp?: number; stopReason?: string };

export class TurnGate {
  private tokens: Token[] = [];
  private sent = new Set<string>();
  autoTurns = 0;

  constructor(
    private readonly now: () => number = Date.now,
    readonly budget = AUTO_TURNS,
  ) {}

  /** A message that you typed is about to start or queue a turn. */
  arm(text: string) {
    this.prune();
    this.tokens.push({ text, at: this.now() });
  }

  /**
   * The new messages for this turn: user-role messages after the last
   * finished assistant reply (error replies do not count), minus those that
   * agy already got. Returns their indexes and whether you typed one, or a
   * refusal.
   */
  decide(messages: Msg[], skip: (m: Msg) => boolean = () => false): { indexes: number[]; human: boolean } | { refuse: string } {
    const indexes: number[] = [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "assistant") {
        if (m.stopReason === "error" || m.stopReason === "aborted") continue;
        break;
      }
      if (m.role !== "user" || skip(m) || this.sent.has(keyOf(m))) continue;
      indexes.unshift(i);
    }
    if (!indexes.length) return { refuse: NOTHING_NEW };
    const human = this.takeToken(indexes.map((i) => messages[i]));
    if (!human && this.autoTurns >= this.budget) return { refuse: budgetUsed(this.autoTurns) };
    return { indexes, human };
  }

  /** The turn reached agy: mark the messages sent and count the turn. */
  commit(messages: Msg[], human: boolean) {
    for (const m of messages) this.sent.add(keyOf(m));
    if (this.sent.size > 500) this.sent = new Set([...this.sent].slice(-250));
    this.autoTurns = human ? 0 : this.autoTurns + 1;
  }

  clear() {
    this.tokens = [];
    this.sent.clear();
    this.autoTurns = 0;
  }

  get pending() {
    this.prune();
    return this.tokens.length;
  }

  /**
   * Uses a token if one matches a message. A token for `/template` or
   * `/skill:x` input matches any message, because Pi expands the text after
   * the input event.
   */
  private takeToken(candidates: Msg[]): boolean {
    this.prune();
    for (let t = 0; t < this.tokens.length; t++) {
      const want = norm(this.tokens[t].text);
      if (want.startsWith("/") || !want || candidates.some((m) => norm(textOf(m.content)).includes(want))) {
        this.tokens.splice(0, t + 1);
        return true;
      }
    }
    return false;
  }

  private prune() {
    const cutoff = this.now() - TOKEN_TTL_MS;
    this.tokens = this.tokens.filter((t) => t.at >= cutoff);
  }
}

function keyOf(m: Msg): string {
  return `${m.timestamp ?? 0}:${norm(textOf(m.content)).slice(0, 200)}`;
}

export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((c: any) => (c?.type === "text" ? c.text : "")).join("\n");
}

/** Whether an `input` event is text that you typed. */
export function isHumanInput(event: { source?: string }, hasUI: boolean): boolean {
  return event.source === "interactive" && hasUI;
}
