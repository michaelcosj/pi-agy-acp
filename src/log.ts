// Relay log: ACP method names, timings, stop reasons, and error codes.
// Never prompt or reply text. Off unless PI_ANTIGRAVITY_LOG=1.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const LOG_PATH = path.join(os.tmpdir(), `pi-antigravity-${process.pid}.jsonl`);
let fd: number | undefined;

export function log(entry: Record<string, unknown>) {
  if (process.env.PI_ANTIGRAVITY_LOG !== "1") return;
  try {
    fd ??= fs.openSync(LOG_PATH, "a", 0o600);
    fs.writeSync(fd, `${JSON.stringify({ t: Date.now(), ...entry })}\n`);
  } catch {}
}
