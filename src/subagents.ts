// agy's own subagents and swarm members, read-only. ACP reports a subagent
// only as an `invoke_subagent` tool call with no child id, so their state
// comes from agy's records (the same files that T3 Code reads):
//   brain/<parent>/.system_generated/subagents/<child>.json   role, state
//   brain/<parent>/.system_generated/messages/*.json          "Subagent <child> has gone idle. …"
//   brain/<child>/.system_generated/logs/transcript.jsonl     the child's steps
// agy owns these children: Pi shows them and cannot message or stop them.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_FILE = 1024 * 1024;
const MAX_CHILDREN = 64;
const TRANSCRIPT_TAIL = 256 * 1024;

export type SubagentStatus = "working" | "idle" | "killed";

export interface Subagent {
  id: string;
  role: string;
  type?: string;
  status: SubagentStatus;
  /** the last reply, from agy's idle message */
  lastReply?: string;
  /** started (file time) */
  startedAt: number;
  /** last activity (transcript time) */
  updatedAt: number;
}

export interface TranscriptStep {
  index: number;
  type: string;
  status?: string;
  text?: string;
  tools?: string[];
}

export function brainDir(home = os.homedir()) {
  return path.join(home, ".gemini", "antigravity-cli", "brain");
}

function readJson(file: string): any {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_FILE) return undefined;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

const mtime = (file: string) => {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
};

/** Replies that agy put in the parent's inbox, by child id, with their time. */
function idleReplies(brain: string, parent: string): Map<string, { text: string; at: number }> {
  const dir = path.join(brain, parent, ".system_generated", "messages");
  const out = new Map<string, { text: string; at: number }>();
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".json") && n !== "read.json");
  } catch {
    return out;
  }
  const rows = names
    .slice(-256)
    .map((n) => readJson(path.join(dir, n)))
    .filter((m) => m && typeof m.content === "string")
    .sort((a, b) => String(a.timestamp ?? "").localeCompare(String(b.timestamp ?? "")));
  for (const m of rows) {
    const hit = /^Subagent ([0-9a-f-]{36}) has gone idle\.(?: This was the subagent's most recent response: ([\s\S]*))?/.exec(m.content);
    const at = Date.parse(m.timestamp ?? "") || 0;
    if (hit) out.set(hit[1], { text: (hit[2] ?? "").trim(), at });
    else if (ID.test(m.sender ?? "")) out.set(m.sender, { text: m.content.trim(), at });
  }
  return out;
}

/** The subagents of agy session `parent`, oldest first. */
export function readSubagents(parent: string, brain = brainDir()): Subagent[] {
  if (!ID.test(parent)) return [];
  const dir = path.join(brain, parent, ".system_generated", "subagents");
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".json") && ID.test(n.slice(0, -5)));
  } catch {
    return [];
  }
  if (names.length > MAX_CHILDREN) names = names.slice(-MAX_CHILDREN);
  const replies = idleReplies(brain, parent);
  const list: Subagent[] = [];
  for (const n of names) {
    const id = n.slice(0, -5);
    const rec = readJson(path.join(dir, n));
    if (!rec || (rec.conversationId && rec.conversationId !== id)) continue;
    const transcript = path.join(brain, id, ".system_generated", "logs", "transcript.jsonl");
    const killed = rec.state === "SUBAGENT_STATE_KILLED";
    const reply = replies.get(id);
    const updatedAt = Math.max(mtime(transcript), mtime(path.join(dir, n)));
    // A reply in the inbox means idle, unless the child worked after it (agy sent it more work).
    const idle = !!reply && mtime(transcript) <= reply.at + 5000;
    list.push({
      id,
      role: String(rec.subagentDescriptor?.role ?? "subagent"),
      type: rec.subagentDescriptor?.typeName,
      status: killed ? "killed" : idle ? "idle" : "working",
      lastReply: reply?.text || undefined,
      startedAt: mtime(path.join(dir, n)),
      updatedAt,
    });
  }
  return list.sort((a, b) => a.startedAt - b.startedAt);
}

/** The last steps of a subagent's transcript. */
export function readTranscript(id: string, brain = brainDir(), max = 40): TranscriptStep[] {
  if (!ID.test(id)) return [];
  const file = path.join(brain, id, ".system_generated", "logs", "transcript.jsonl");
  let text = "";
  try {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, TRANSCRIPT_TAIL);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      text = buf.toString("utf8");
      if (size > len) text = text.slice(text.indexOf("\n") + 1);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
  const steps: TranscriptStep[] = [];
  for (const line of text.split("\n")) {
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof d?.step_index !== "number" || typeof d.type !== "string") continue;
    let body: string | undefined = typeof d.content === "string" ? d.content : typeof d.error === "string" ? d.error : undefined;
    // agy wraps the launch prompt in a SYSTEM_MESSAGE envelope.
    const env = body && /<SYSTEM_MESSAGE>[\s\S]*?content=([\s\S]*?)\n<\/SYSTEM_MESSAGE>/.exec(body);
    if (env) body = env[1];
    steps.push({
      index: d.step_index,
      type: d.type,
      status: d.status,
      text: body ? (body.length > 2000 ? `${body.slice(0, 2000)}…` : body) : undefined,
      tools: Array.isArray(d.tool_calls) ? d.tool_calls.map((c: any) => String(c?.name ?? "?")) : undefined,
    });
  }
  return steps.slice(-max);
}

/** Readable lines for one subagent: its steps, newest last. */
export function transcriptLines(steps: TranscriptStep[]): string[] {
  const out: string[] = [];
  for (const s of steps) {
    const label =
      s.type === "SYSTEM_MESSAGE" ? "message" : s.type === "PLANNER_RESPONSE" ? "reply" : s.type === "USER_INPUT" ? "input" : s.type.toLowerCase();
    if (s.tools?.length) out.push(`▸ ${s.tools.join(", ")}`);
    if (s.text?.trim()) out.push(`${label}: ${s.text.trim()}`);
    else if (!s.tools?.length) out.push(`${label}${s.status ? ` (${s.status.toLowerCase()})` : ""}`);
  }
  return out;
}

/**
 * Watches the subagents of the bound agy session. Polls while any works, or
 * for a while after an invoke_subagent call, and calls `onChange` on a change.
 */
export class SubagentWatcher {
  list: Subagent[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private until = 0;
  private sig = "";

  constructor(
    private readonly session: () => string | undefined,
    private readonly onChange: (list: Subagent[]) => void,
    private readonly brain = brainDir(),
    private readonly everyMs = 2000,
  ) {}

  /** Poll for `ms` more (after a subagent call, or at bind time). */
  kick(ms = 10 * 60_000) {
    this.until = Math.max(this.until, Date.now() + ms);
    this.refresh();
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.refresh();
      if (Date.now() > this.until && !this.list.some((s) => s.status === "working")) this.stop();
    }, this.everyMs);
    this.timer.unref?.();
  }

  refresh() {
    const sid = this.session();
    const list = sid ? readSubagents(sid, this.brain) : [];
    const sig = JSON.stringify(list.map((s) => [s.id, s.status, s.lastReply?.length]));
    this.list = list;
    if (sig !== this.sig) {
      this.sig = sig;
      this.onChange(list);
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
