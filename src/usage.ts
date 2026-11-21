// Quota from agy's own read-only `/usage` command (`agy -p "/usage"`). It
// prints one tab-separated record per line and sends no model request.
import { execFile } from "node:child_process";

export interface UsageRow {
  group: string;
  window: string;
  remaining: string;
  resets?: string;
}

export function parseUsage(out: string): UsageRow[] {
  const rows: UsageRow[] = [];
  for (const line of out.split("\n")) {
    const [group, window, remaining, resets] = line.split("\t").map((x) => x?.trim());
    if (!group || !window || !/%$/.test(remaining ?? "")) continue;
    // agy prints 1970-01-01 for a window that has not started.
    rows.push({ group, window, remaining, resets: resets && !resets.startsWith("1970") ? resets : undefined });
  }
  return rows;
}

export function usageLines(rows: UsageRow[]): string[] {
  return rows.map((r) => `  ${r.group} · ${r.window}: ${r.remaining}${r.resets ? ` (resets ${new Date(r.resets).toLocaleString()})` : ""}`);
}

export function readUsage(command: string, timeoutMs = 20_000): Promise<UsageRow[]> {
  return new Promise((resolve, reject) => {
    execFile(command, ["-p", "/usage"], { timeout: timeoutMs, env: { ...process.env, NO_COLOR: "1" } }, (err, stdout) => {
      if (err) return reject(err);
      resolve(parseUsage(stdout));
    });
  });
}
