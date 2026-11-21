// Newline-delimited JSON-RPC 2.0 over a pair of streams (ACP stdio transport).
// Handles our requests, the agent's notifications, and the agent's requests
// to us (permission prompts, file reads).
import type { Readable, Writable } from "node:stream";

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

export class AcpError extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(error: RpcError, method?: string) {
    super(`${method ? `${method}: ` : ""}${error.message}${error.code !== undefined ? ` (${error.code})` : ""}`);
    this.name = "AcpError";
    this.code = error.code;
    this.data = error.data;
  }
}

type RequestHandler = (params: any) => unknown | Promise<unknown>;
type NotificationHandler = (params: any) => void;

export class JsonRpcConnection {
  private nextId = 1;
  private buffer = "";
  private readonly pending = new Map<number, { method: string; resolve: (v: any) => void; reject: (e: Error) => void }>();
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private readonly notificationHandlers = new Map<string, NotificationHandler>();
  private closedError: Error | undefined;
  onTrace?: (direction: "in" | "out", message: any) => void;

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
  ) {
    input.setEncoding?.("utf8");
    input.on("data", (chunk: string) => this.receive(chunk));
    input.on("end", () => this.close(new Error("agent closed its output")));
    input.on("error", (e: Error) => this.close(e));
    output.on("error", (e: Error) => this.close(e));
  }

  get closed() {
    return this.closedError !== undefined;
  }

  onRequest(method: string, handler: RequestHandler) {
    this.requestHandlers.set(method, handler);
  }

  onNotification(method: string, handler: NotificationHandler) {
    this.notificationHandlers.set(method, handler);
  }

  request<T = any>(method: string, params?: unknown): Promise<T> {
    if (this.closedError) return Promise.reject(this.closedError);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params?: unknown) {
    if (this.closedError) return;
    this.send({ jsonrpc: "2.0", method, params });
  }

  close(error = new Error("connection closed")) {
    if (this.closedError) return;
    this.closedError = error;
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
  }

  private send(message: any) {
    this.onTrace?.("out", message);
    this.output.write(`${JSON.stringify(message)}\n`);
  }

  private receive(chunk: string) {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        continue; // agents may print non-JSON noise; ignore it
      }
      this.onTrace?.("in", message);
      void this.dispatch(message);
    }
  }

  private async dispatch(message: any) {
    if (message.method === undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new AcpError(message.error, pending.method));
      else pending.resolve(message.result);
      return;
    }
    if (message.id === undefined) {
      try {
        this.notificationHandlers.get(message.method)?.(message.params);
      } catch {}
      return;
    }
    const handler = this.requestHandlers.get(message.method);
    if (!handler) {
      this.send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `method not found: ${message.method}` } });
      return;
    }
    try {
      const result = await handler(message.params);
      this.send({ jsonrpc: "2.0", id: message.id, result: result ?? null });
    } catch (e) {
      const err = e as Partial<AcpError>;
      this.send({ jsonrpc: "2.0", id: message.id, error: { code: typeof err.code === "number" ? err.code : -32603, message: err.message ?? String(e) } });
    }
  }
}
