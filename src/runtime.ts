// The live state of pi-antigravity in one Pi process: the agy process, the
// ACP session bound to the Pi session, the gate, and the UI context.
import fs from "node:fs/promises";
import path from "node:path";
import { AgyProcess, isAuthRequired } from "./acp/agent.ts";
import type { ConfigOption, NewSessionResult, PermissionRequest, PermissionResponse, SessionNotification } from "./acp/types.ts";
import { isBanNotice } from "./ban.ts";
import { addAlways, Dirs, DIRS_ENTRY, inside, requestPaths, rootOf, tooWide } from "./dirs.ts";
import { TurnGate } from "./gate.ts";
import { isPiAgentTool, isSubagentTool } from "./agy-config.ts";
import { log } from "./log.ts";
import { catalogFromSession, type CatalogEntry } from "./models.ts";
import { type Subagent, SubagentWatcher } from "./subagents.ts";
import { Translator } from "./translate.ts";

export const SESSION_ENTRY = "antigravity-session";
/** agy runs only in auto mode in Pi. */
export const MODE = "auto";
export const WAKE_MESSAGE = "antigravity-wake";
const IDLE_STOP_MS = 15 * 60_000;
const WAKE_SETTLE_MS = 1_500;

export const SYSTEM_PROMPT_APPEND =
  "The user reads your replies in Pi, a terminal coding UI that acts as an ACP client. Format replies as Markdown. " +
  "Tool calls show to the user as one short line each, so summarize important tool results in your reply. " +
  "When you start Pi child agents with the pi agent tool, each child's final reply arrives later as a new message that starts with \"Agent <name> finished\", so you can end your turn while they run.";

export interface UiLike {
  hasUI: boolean;
  cwd: string;
  ui: {
    select(title: string, options: string[], opts?: { signal?: AbortSignal }): Promise<string | undefined>;
    confirm(title: string, message: string, opts?: { signal?: AbortSignal }): Promise<boolean>;
    notify(message: string, type?: "info" | "warning" | "error"): void;
    setStatus(key: string, text: string | undefined): void;
  };
}

export interface Binding {
  sessionId: string;
  cwd: string;
  /** Time of the last turn that agy saw. Pi messages after it are unseen. */
  seenAt?: number;
}

export interface Launch {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export function launchFromEnv(env: Record<string, string | undefined> = process.env): Launch {
  const command = env.PI_ANTIGRAVITY_COMMAND?.trim() || "agy";
  const args = env.PI_ANTIGRAVITY_ARGS?.trim() ? env.PI_ANTIGRAVITY_ARGS.trim().split(/\s+/) : command.endsWith("agy_acp_server") ? [] : ["acp"];
  // Plain `agy acp`, as T3 Code starts it. Pi's agent tool is a stdio MCP server.
  return { command, args, env: {} };
}

export class Runtime {
  readonly gate = new TurnGate();
  ctx: UiLike | undefined;
  pi: { sendMessage: (m: any, o?: any) => void; appendEntry: (t: string, d?: unknown) => void; setSessionName: (n: string) => void; getSessionName: () => string | undefined } | undefined;
  binding: Binding | undefined;
  /** Prompt-scoped state; undefined when no prompt is open. */
  activePrompt: { sessionId: string; translator: Translator } | undefined;
  commands: { name: string; description?: string }[] = [];
  catalog: CatalogEntry[] = [];
  configOptions: ConfigOption[] = [];
  tier: string | undefined;
  mode: string | undefined;
  /** Extra env for agy. */
  extraEnv: Record<string, string> = {};
  /** MCP servers for session/new and session/resume (Pi's agent tool). */
  mcpServers: () => unknown[] = () => [];
  /** Extra workspace folders: child agents' folders and folders that you allowed. */
  readonly dirs = new Dirs();
  /** The folder list that agy has for the bound session. */
  private sentDirs = "";
  /** Set when Google's suspension notice arrives. Then no more turns run. */
  banned = false;
  onBan: (() => void) | undefined;
  /** agy's own subagents of the bound session (read-only). */
  readonly subagents = new SubagentWatcher(
    () => this.binding?.sessionId,
    (list) => this.onSubagents?.(list),
  );
  onSubagents: ((list: Subagent[]) => void) | undefined;

  private agy: AgyProcess | undefined;
  private starting: Promise<AgyProcess> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private unsubscribe: (() => void) | undefined;
  private wake: { translator: Translator; output: any; timer?: ReturnType<typeof setTimeout> } | undefined;
  private applied = new Map<string, string>();

  constructor(private readonly launch: () => Launch = () => launchFromEnv()) {}

  get process(): AgyProcess | undefined {
    return this.agy?.alive ? this.agy : undefined;
  }

  async ensure(): Promise<AgyProcess> {
    this.touch();
    if (this.agy?.alive) return this.agy;
    if (this.starting) return this.starting;
    const l = this.launch();
    this.starting = AgyProcess.start(
      { command: l.command, args: l.args, env: { ...l.env, ...this.extraEnv } },
      {
        permission: (r) => this.permission(r),
        readTextFile: (p) => this.readTextFile(p),
        trace: (e) => log(e),
      },
    )
      .then((agy) => {
        this.agy = agy;
        this.applied.clear();
        this.unsubscribe?.();
        this.unsubscribe = undefined;
        agy.onExit(() => {
          if (this.agy === agy) {
            this.agy = undefined;
            this.unsubscribe?.();
            this.unsubscribe = undefined;
          }
        });
        return agy;
      })
      .finally(() => {
        this.starting = undefined;
      });
    return this.starting;
  }

  stop() {
    clearTimeout(this.idleTimer);
    this.subagents.stop();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.agy?.kill();
    this.agy = undefined;
  }

  touch() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.activePrompt && !this.wake) this.stop();
      else this.touch();
    }, IDLE_STOP_MS);
    this.idleTimer.unref?.();
  }

  /** The ACP session for the bound Pi session: resumed, or new. */
  async session(cwd: string): Promise<{ agy: AgyProcess; sessionId: string; fresh: boolean }> {
    const additionalDirectories = this.dirs.list(cwd);
    const dirsKey = additionalDirectories.join("\n");
    // agy gets the folder list only when it opens a session, so a changed list
    // restarts agy and resumes the session, as T3 Code does. Between turns only.
    if (this.binding?.cwd === cwd && this.unsubscribe && dirsKey !== this.sentDirs && !this.activePrompt) {
      log({ event: "dirs_restart", count: additionalDirectories.length });
      this.restartAgy();
    }
    const agy = await this.ensure();
    if (this.binding && this.binding.cwd === cwd && this.unsubscribe) {
      await this.setMode(this.binding.sessionId);
      return { agy, sessionId: this.binding.sessionId, fresh: false };
    }
    let fresh = false;
    let sessionId: string | undefined;
    if (this.binding && this.binding.cwd === cwd) {
      try {
        const r = await agy.resumeSession(this.binding.sessionId, cwd, { mcpServers: this.mcpServers(), additionalDirectories });
        log({ event: "dirs", count: additionalDirectories.length });
        sessionId = this.binding.sessionId;
        this.absorb(r);
      } catch (e) {
        if (isAuthRequired(e)) throw e;
        log({ event: "resume_failed", error: String((e as Error).message).slice(0, 200) });
      }
    }
    if (!sessionId) {
      const r = await agy.newSession(cwd, { systemPromptAppend: SYSTEM_PROMPT_APPEND, mcpServers: this.mcpServers(), additionalDirectories });
      this.absorb(r);
      sessionId = r.sessionId;
      fresh = true;
      this.binding = { sessionId, cwd };
      this.pi?.appendEntry(SESSION_ENTRY, this.binding);
    }
    this.sentDirs = dirsKey;
    this.applied.clear();
    this.unsubscribe?.();
    this.unsubscribe = agy.subscribe(sessionId, (n) => this.onUpdate(n));
    this.subagents.kick(30_000);
    await this.setMode(sessionId);
    return { agy, sessionId, fresh };
  }

  /** Auto only, set at the start of each turn. A session that cannot switch to auto does not run.
   *  No request when agy is already in auto mode. */
  private async setMode(sessionId: string) {
    try {
      await this.setOption(sessionId, "mode", MODE);
    } catch (e) {
      throw new Error(`agy would not switch to ${MODE} mode: ${(e as Error).message}`);
    }
    this.mode = MODE;
  }

  /** Stops the agy process but keeps the binding, so the next turn resumes the session. */
  private restartAgy() {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.agy?.kill();
    this.agy = undefined;
    this.applied.clear();
  }

  /**
   * Earlier Pi messages that agy has not seen: all of them for a new session,
   * else those after the last Antigravity turn (for example turns on another
   * model). Wake messages came from agy, so they are seen.
   */
  unseen<T extends { role: string; content?: unknown; timestamp?: number; customType?: string; provider?: string }>(messages: T[], fresh: boolean): T[] {
    const since = fresh ? -Infinity : (this.binding?.seenAt ?? -Infinity);
    const fromAgy = (m: T | undefined) => m?.role === "assistant" && m.provider === "antigravity";
    return messages.filter((m, i) => {
      if (typeof m.customType === "string" && m.customType.startsWith("antigravity-")) return false;
      if (m.role === "user" && isOwnText(m)) return false;
      if (!fresh) {
        // agy saw its own replies and the prompts that it answered.
        if (fromAgy(m)) return false;
        if (m.role === "user" && fromAgy(messages[i + 1])) return false;
      }
      return (m.timestamp ?? 0) > since;
    });
  }

  /** Messages that Pi shows but agy must not get as a prompt. */
  isDisplayOnly(m: { role: string; content?: unknown; customType?: string }): boolean {
    if (typeof m.customType === "string" && m.customType.startsWith("antigravity-")) return true;
    return m.role === "user" && isOwnText(m);
  }

  /** Google's suspension notice arrived: stop all automatic work. */
  ban() {
    if (this.banned) return;
    this.banned = true;
    log({ event: "banned" });
    this.onBan?.();
  }

  /** Checks text from agy for the suspension notice. */
  checkBan(text: string | undefined): boolean {
    if (isBanNotice(text)) this.ban();
    return this.banned;
  }

  markSeen() {
    if (!this.binding) return;
    this.binding.seenAt = Date.now();
    this.pi?.appendEntry(SESSION_ENTRY, this.binding);
  }

  /** Forget the bound session, so the next turn starts a new one. */
  unbind() {
    this.binding = undefined;
    this.sentDirs = "";
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  async setOption(sessionId: string, configId: string, value: string) {
    if (this.applied.get(configId) === value) return;
    const agy = await this.ensure();
    await agy.setConfigOption(sessionId, configId, value);
    this.applied.set(configId, value);
  }

  /** A scratch session to read the catalog and check sign-in. */
  async probe(): Promise<{ catalog: CatalogEntry[]; tier?: string } | undefined> {
    const agy = await this.ensure();
    const dir = await fs.mkdtemp(path.join((await import("node:os")).tmpdir(), "pi-antigravity-"));
    try {
      const r = await agy.newSession(dir);
      this.absorb(r, { modeAndOptionsOnly: true });
      void agy.closeSession(r.sessionId);
      return { catalog: catalogFromSession(r), tier: this.tier };
    } catch (e) {
      if (isAuthRequired(e)) return undefined;
      throw e;
    } finally {
      void fs.rm(dir, { recursive: true, force: true });
    }
  }

  private absorb(r: Partial<NewSessionResult>, _opts: { modeAndOptionsOnly?: boolean } = {}) {
    if (r.configOptions) this.configOptions = r.configOptions;
    const tier = r._meta?.antigravity?.tier?.name;
    if (tier) this.tier = tier;
  }

  // ---- updates ----

  private onUpdate(n: SessionNotification) {
    this.touch();
    this.police(n);
    if (this.activePrompt && this.activePrompt.sessionId === n.sessionId) {
      this.activePrompt.translator.update(n.update);
      return;
    }
    this.onWakeUpdate(n);
  }

  /**
   * agy can continue by itself with no prompt open: a background command,
   * subagent, or timer finished (agy's own wake). Show that work in Pi as
   * one message. It does not start a Pi turn and is not sent anywhere.
   */
  private onWakeUpdate(n: SessionNotification) {
    const kind = n.update.sessionUpdate;
    if (kind === "available_commands_update") {
      this.commands = (n.update as any).availableCommands ?? [];
      return;
    }
    if (kind === "current_mode_update") return;
    if (kind === "session_info_update" || kind === "config_option_update" || kind === "usage_update" || kind === "user_message_chunk") return;
    if (!this.wake) {
      const output = { content: [] as any[] };
      this.wake = { output, translator: new Translator(output as any, undefined) };
      this.ctx?.ui.setStatus("antigravity", "Antigravity is working (background wake)…");
      log({ event: "wake_start" });
    }
    this.wake.translator.update(n.update);
    clearTimeout(this.wake.timer);
    this.wake.timer = setTimeout(() => this.flushWake(), WAKE_SETTLE_MS);
  }

  private flushWake() {
    const w = this.wake;
    if (!w) return;
    // Wait while agy still runs tools in the wake.
    if (w.translator.running().length) {
      w.timer = setTimeout(() => this.flushWake(), WAKE_SETTLE_MS);
      return;
    }
    this.wake = undefined;
    w.translator.finish();
    const text = w.translator.text.trim();
    this.ctx?.ui.setStatus("antigravity", undefined);
    this.checkBan(text);
    log({ event: "wake_end", chars: text.length });
    if (!text) return;
    // display only: no triggerTurn, so Pi starts no model call.
    this.pi?.sendMessage({ customType: WAKE_MESSAGE, content: WAKE_PREFIX + text, display: true, details: { sessionId: this.binding?.sessionId } });
    // agy wrote this itself, so it is not "unseen" history.
    this.markSeen();
  }

  /** Called when a prompt opens, so wake output in flight is flushed first. */
  beginPrompt(sessionId: string, translator: Translator) {
    if (this.wake) {
      clearTimeout(this.wake.timer);
      const w = this.wake;
      this.wake = undefined;
      w.translator.finish();
      const text = w.translator.text.trim();
      if (text) this.pi?.sendMessage({ customType: WAKE_MESSAGE, content: WAKE_PREFIX + text, display: true });
      this.ctx?.ui.setStatus("antigravity", undefined);
      this.markSeen();
    }
    this.activePrompt = { sessionId, translator };
  }

  endPrompt() {
    this.activePrompt = undefined;
    this.touch();
  }

  /** Auto mode only; an agy subagent call starts the subagent watch. */
  private police(n: SessionNotification) {
    const u = n.update as any;
    if (u.sessionUpdate === "current_mode_update" && u.currentModeId !== MODE) {
      log({ event: "mode_changed", to: u.currentModeId });
      // Pi sets auto again at the start of the next turn (setMode), as each turn's config.
      this.applied.delete("mode");
      this.mode = u.currentModeId;
      this.ctx?.ui.notify(`Antigravity left ${MODE} mode (${u.currentModeId}). Pi sets ${MODE} again at the next turn.`, "warning");
      return;
    }
    if ((u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") && isSubagentTool(u)) this.subagents.kick();
  }

  // ---- agent → client requests ----

  private async permission(r: PermissionRequest): Promise<PermissionResponse> {
    const ctx = this.ctx;
    // Pi's own agent tool: approve it here. agy asks for MCP tools even in
    // auto mode, and its settings.json allow rules do not apply over ACP.
    if (isPiAgentTool(r.toolCall ?? {})) {
      const allow = r.options?.find((o) => o.kind === "allow_once") ?? r.options?.find((o) => o.kind === "allow_always");
      if (allow) {
        log({ event: "permission_auto", tool: "mcp_pi_agent" });
        return { outcome: { outcome: "selected", optionId: allow.optionId } };
      }
    }
    const allowOnce = r.options?.find((o) => o.kind === "allow_once") ?? r.options?.find((o) => o.kind === "allow_always");
    const cwd = this.binding?.cwd ?? ctx?.cwd ?? process.cwd();
    const paths = requestPaths(r, cwd);
    // A folder that you allowed, which agy gets only at the next turn.
    if (allowOnce && this.dirs.covers(paths, cwd)) {
      log({ event: "permission_auto", tool: "allowed_dir" });
      return { outcome: { outcome: "selected", optionId: allowOnce.optionId } };
    }
    if (!ctx?.hasUI || !r.options?.length) {
      const reject = r.options?.find((o) => o.kind === "reject_once");
      return reject ? { outcome: { outcome: "selected", optionId: reject.optionId } } : { outcome: { outcome: "cancelled" } };
    }
    const title = describePermission(r);
    const labels = r.options.map((o) => o.name);
    // Paths outside the workspace: also allow their folder for this session, or always.
    const outside = paths.filter((p) => !inside(p, cwd) && !this.dirs.covers([p], cwd));
    const root = allowOnce && outside.length ? await rootOf(outside[0]) : undefined;
    const same = root && outside.every((p) => inside(p, root));
    const parent = root && path.dirname(root);
    const sessionLabel = same && !tooWide(root!) ? `Allow ${tilde(root!)} for this session` : undefined;
    const alwaysLabel = same && parent && !tooWide(parent) ? `Always allow ${tilde(parent)} (all sessions)` : undefined;
    const extra = [sessionLabel, alwaysLabel].filter((x): x is string => !!x);
    if (extra.length) labels.splice(labels.indexOf(allowOnce!.name) + 1, 0, ...extra);
    log({ event: "permission", kind: r.toolCall?.kind, options: r.options.map((o) => o.kind), dirChoices: extra.length });
    const choice = await ctx.ui.select(title, labels);
    if (choice && (choice === sessionLabel || choice === alwaysLabel)) {
      if (choice === alwaysLabel) {
        try {
          addAlways(parent!);
        } catch (e) {
          ctx.ui.notify(`Could not save ${parent}: ${(e as Error).message}`, "error");
        }
      } else if (this.dirs.add(root!, cwd)) this.pi?.appendEntry(DIRS_ENTRY, { dirs: this.dirs.session });
      return { outcome: { outcome: "selected", optionId: allowOnce!.optionId } };
    }
    const option = r.options.find((o) => o.name === choice);
    if (!option) {
      const reject = r.options.find((o) => o.kind === "reject_once");
      return reject ? { outcome: { outcome: "selected", optionId: reject.optionId } } : { outcome: { outcome: "cancelled" } };
    }
    return { outcome: { outcome: "selected", optionId: option.optionId } };
  }

  private async readTextFile(p: { path: string; line?: number; limit?: number }): Promise<{ content: string }> {
    const root = this.binding?.cwd ?? this.ctx?.cwd ?? process.cwd();
    const file = path.resolve(root, p.path);
    const rel = path.relative(root, file);
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw Object.assign(new Error(`outside the workspace: ${p.path}`), { code: -32602 });
    const text = await fs.readFile(file, "utf8");
    if (!p.line && !p.limit) return { content: text };
    const lines = text.split("\n");
    const start = Math.max(0, (p.line ?? 1) - 1);
    return { content: lines.slice(start, p.limit ? start + p.limit : undefined).join("\n") };
  }
}

/** Wake and steer messages reach the provider as plain user messages; they start with these markers. */
export const WAKE_PREFIX = "↻ Antigravity continued by itself:\n\n";
export const STEER_PREFIX = "↳ Sent to Antigravity during its turn:\n\n";

function isOwnText(m: { content?: unknown }): boolean {
  const c = m.content;
  const first = typeof c === "string" ? c : Array.isArray(c) ? (c[0] as any)?.text : undefined;
  return typeof first === "string" && (first.startsWith(WAKE_PREFIX) || first.startsWith(STEER_PREFIX));
}

function tilde(p: string): string {
  const home = (process.env.HOME ?? "").replace(/\/+$/, "");
  return home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p;
}

/** A child agent's folder joins agy's workspace at the next turn. */
export function addChildDir(runtime: Runtime, dir: unknown, cwd: string): boolean {
  if (typeof dir !== "string" || !path.isAbsolute(dir) || !runtime.dirs.add(dir, cwd)) return false;
  runtime.pi?.appendEntry(DIRS_ENTRY, { dirs: runtime.dirs.session });
  return true;
}

export function describePermission(r: PermissionRequest): string {
  const t = r.toolCall ?? ({} as PermissionRequest["toolCall"]);
  const parts = [`Antigravity: ${t.title ?? t.kind ?? "tool call"}`];
  const loc = t.locations?.map((l) => l.path).filter(Boolean);
  if (loc?.length) parts.push(loc.slice(0, 3).join(", "));
  const raw = t.rawInput as any;
  const cmd = raw?.command ?? raw?.CommandLine ?? raw?.commandLine;
  if (typeof cmd === "string" && !parts[0].includes(cmd)) parts.push(`$ ${cmd.length > 300 ? `${cmd.slice(0, 297)}…` : cmd}`);
  for (const c of t.content ?? []) {
    if (c.type === "diff" && c.path) {
      const added = (c.newText ?? "").split("\n").length;
      const removed = c.oldText ? c.oldText.split("\n").length : 0;
      parts.push(`${c.path} (+${added} −${removed})`);
    }
  }
  return parts.join("\n");
}
