// One `agy acp` child process and the ACP calls that pi-antigravity uses.
import { type ChildProcess, spawn } from "node:child_process";
import { AcpError, JsonRpcConnection } from "./rpc.ts";
import type {
  InitializeResult,
  NewSessionResult,
  PermissionRequest,
  PermissionResponse,
  PromptBlock,
  PromptResult,
  SessionNotification,
} from "./types.ts";

export const CLIENT_INFO = { name: "pi-antigravity", title: "Pi (Antigravity)", version: "0.1.0" };
export const AUTH_REQUIRED = -32000;

export interface AgyLaunch {
  command: string;
  args: string[];
  env?: Record<string, string | undefined>;
  cwd?: string;
}

export interface AgyHandlers {
  /** A `session/request_permission` from the agent. */
  permission?: (request: PermissionRequest) => Promise<PermissionResponse>;
  /** A `fs/read_text_file` from the agent. */
  readTextFile?: (params: { sessionId: string; path: string; line?: number; limit?: number }) => Promise<{ content: string }>;
  /** Method name, direction, and time; never content. */
  trace?: (entry: Record<string, unknown>) => void;
}

export function isAuthRequired(error: unknown): boolean {
  return error instanceof AcpError && (error.code === AUTH_REQUIRED || /auth/i.test(error.message));
}

export class AgyProcess {
  readonly init: InitializeResult;
  private readonly listeners = new Map<string, Set<(n: SessionNotification) => void>>();
  private readonly anyListeners = new Set<(n: SessionNotification) => void>();
  private exitListeners = new Set<(error: Error) => void>();
  private stderrTail = "";

  private constructor(
    private readonly child: ChildProcess,
    readonly rpc: JsonRpcConnection,
    init: InitializeResult,
  ) {
    this.init = init;
    rpc.onNotification("session/update", (params: SessionNotification) => {
      for (const fn of this.listeners.get(params?.sessionId) ?? []) fn(params);
      for (const fn of this.anyListeners) fn(params);
    });
  }

  static async start(launch: AgyLaunch, handlers: AgyHandlers = {}): Promise<AgyProcess> {
    const child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      env: { ...process.env, ...launch.env } as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderrTail = "";
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (d: string) => {
      stderrTail = (stderrTail + d).slice(-4000);
    });
    const rpc = new JsonRpcConnection(child.stdout!, child.stdin!);
    if (handlers.trace) {
      rpc.onTrace = (direction, m) =>
        handlers.trace!({
          t: Date.now(),
          dir: direction,
          method: m.method,
          id: m.id,
          update: m.params?.update?.sessionUpdate,
          error: m.error ? { code: m.error.code, message: String(m.error.message).slice(0, 200) } : undefined,
          stopReason: m.result?.stopReason,
        });
    }
    const spawnError = new Promise<never>((_, reject) => {
      child.once("error", (e) => {
        rpc.close(e);
        reject(new Error(`could not start ${launch.command}: ${e.message}`));
      });
    });
    child.once("exit", (code, signal) => {
      rpc.close(new Error(`agy exited (${signal ?? code})${stderrTail ? `: ${stderrTail.trim().split("\n").slice(-3).join(" | ")}` : ""}`));
    });
    rpc.onRequest("session/request_permission", async (params: PermissionRequest) => {
      if (!handlers.permission) return { outcome: { outcome: "cancelled" } };
      return handlers.permission(params);
    });
    rpc.onRequest("fs/read_text_file", async (params: any) => {
      if (!handlers.readTextFile) throw new AcpError({ code: -32601, message: "fs/read_text_file is not supported" });
      return handlers.readTextFile(params);
    });
    const init = await Promise.race([
      rpc.request<InitializeResult>("initialize", {
        protocolVersion: 1,
        clientInfo: CLIENT_INFO,
        clientCapabilities: { fs: { readTextFile: !!handlers.readTextFile, writeTextFile: false }, terminal: false },
      }),
      spawnError,
    ]);
    const agy = new AgyProcess(child, rpc, init);
    agy.stderrTail = stderrTail;
    child.once("exit", () => {
      const error = new Error(`agy exited${stderrTail ? `: ${stderrTail.trim().split("\n").slice(-3).join(" | ")}` : ""}`);
      for (const fn of agy.exitListeners) fn(error);
    });
    return agy;
  }

  get alive() {
    return !this.rpc.closed && this.child.exitCode === null;
  }

  get version(): string | undefined {
    return this.init.agentInfo?.version;
  }

  get canAppendSystemPrompt(): boolean {
    return this.init.agentCapabilities?._meta?.antigravity?.systemPrompt?.append === true;
  }

  onExit(fn: (error: Error) => void) {
    this.exitListeners.add(fn);
    return () => this.exitListeners.delete(fn);
  }

  /** Updates for one session. Returns an unsubscribe function. */
  subscribe(sessionId: string, fn: (n: SessionNotification) => void) {
    let set = this.listeners.get(sessionId);
    if (!set) this.listeners.set(sessionId, (set = new Set()));
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (!set!.size) this.listeners.delete(sessionId);
    };
  }

  newSession(cwd: string, opts: { mcpServers?: unknown[]; systemPromptAppend?: string } = {}) {
    const params: Record<string, unknown> = { cwd, mcpServers: opts.mcpServers ?? [] };
    if (opts.systemPromptAppend && this.canAppendSystemPrompt) {
      params._meta = { antigravity: { systemPrompt: { append: opts.systemPromptAppend } } };
    }
    return this.rpc.request<NewSessionResult>("session/new", params);
  }

  resumeSession(sessionId: string, cwd: string, opts: { mcpServers?: unknown[] } = {}) {
    return this.rpc.request<Partial<NewSessionResult>>("session/resume", { sessionId, cwd, mcpServers: opts.mcpServers ?? [] });
  }

  closeSession(sessionId: string) {
    return this.rpc.request("session/close", { sessionId }).catch(() => undefined);
  }

  prompt(sessionId: string, prompt: PromptBlock[]) {
    return this.rpc.request<PromptResult>("session/prompt", { sessionId, prompt });
  }

  cancel(sessionId: string) {
    this.rpc.notify("session/cancel", { sessionId });
  }

  setConfigOption(sessionId: string, configId: string, value: string) {
    return this.rpc.request("session/set_config_option", { sessionId, configId, value });
  }

  kill() {
    this.rpc.close(new Error("agy stopped"));
    if (this.child.exitCode === null) this.child.kill("SIGTERM");
  }
}
