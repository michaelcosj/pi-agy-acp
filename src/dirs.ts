// Extra workspace folders for agy (ACP `additionalDirectories`).
//
// agy's auto mode acts without asking only in its workspace: the session cwd
// plus these folders. Outside them it asks for every file. Folders come from:
// - child agents: agent-bridge reports each local child's cwd (often a worktree);
// - the permission dialog: "for this session" (saved in the Pi session) or
//   "always" (saved in ~/.pi/agent/pi-agy-acp.json, for every session).
// A change goes to agy with the next session/resume, between turns. During a
// turn, Pi itself approves requests inside the folders that you allowed.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DIRS_ENTRY = "antigravity-dirs";

export function configPath(env: Record<string, string | undefined> = process.env): string {
  return env.PI_ANTIGRAVITY_CONFIG || path.join(env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"), "pi-agy-acp.json");
}

/** The "always" folders from the config file. A bad file gives none. */
export function readAlways(file = configPath()): string[] {
  try {
    const dirs = JSON.parse(fs.readFileSync(file, "utf8"))?.additionalDirectories;
    return Array.isArray(dirs) ? dirs.filter((d): d is string => typeof d === "string" && path.isAbsolute(d)) : [];
  } catch {
    return [];
  }
}

export function addAlways(dir: string, file = configPath()) {
  let data: any = {};
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8")) ?? {};
  } catch {}
  const dirs = new Set(Array.isArray(data.additionalDirectories) ? data.additionalDirectories : []);
  dirs.add(dir);
  data.additionalDirectories = [...dirs];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

/** True when `file` is `dir` or inside it. */
export function inside(file: string, dir: string): boolean {
  const rel = path.relative(dir, file);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** "Always" is refused for the home folder, anything above it, and the file system root. */
export function tooWide(dir: string, home = os.homedir()): boolean {
  const d = path.resolve(dir);
  return d === path.parse(d).root || inside(home, d);
}

/** The git root of `file`'s folder, or the folder itself outside a repo. */
export function rootOf(file: string): Promise<string> {
  const dir = fs.statSync(file, { throwIfNoEntry: false })?.isDirectory() ? file : path.dirname(file);
  return new Promise((resolve) => {
    execFile("git", ["-C", dir, "rev-parse", "--show-toplevel"], { timeout: 5_000 }, (err, out) => {
      const top = out?.trim();
      resolve(!err && top ? top : dir);
    });
  });
}

/** Absolute paths that a permission request names. */
export function requestPaths(r: { toolCall?: { locations?: { path?: string }[]; content?: { path?: string }[]; rawInput?: unknown } }, cwd: string): string[] {
  const t = r.toolCall ?? {};
  const raw = (t.rawInput ?? {}) as Record<string, unknown>;
  const out = [
    ...(t.locations ?? []).map((l) => l.path),
    ...(t.content ?? []).map((c) => c.path),
    ...["path", "file_path", "filePath", "AbsolutePath", "TargetFile"].map((k) => raw[k]),
  ];
  return [...new Set(out.filter((p): p is string => typeof p === "string" && p.length > 0).map((p) => path.resolve(cwd, p)))];
}

/** The session's folders and the "always" folders, without duplicates. */
export class Dirs {
  /** Folders for this Pi session. */
  session: string[] = [];

  constructor(private readonly always: () => string[] = () => readAlways()) {}

  /** All extra folders, without the cwd and without folders inside another one. */
  list(cwd: string): string[] {
    const all = [...new Set([...this.always(), ...this.session].map((d) => path.resolve(d)))];
    return all.filter((d) => !inside(d, cwd) && !all.some((o) => o !== d && inside(d, o))).sort();
  }

  /** Adds a session folder. Returns false when it was already covered. */
  add(dir: string, cwd: string): boolean {
    const d = path.resolve(dir);
    if (inside(d, cwd) || this.list(cwd).some((o) => inside(d, o))) return false;
    this.session.push(d);
    return true;
  }

  /** True when every path is in an extra folder. Paths in the cwd do not count:
   *  agy decides about those, and Pi shows its dialog. */
  covers(paths: string[], cwd: string): boolean {
    const roots = this.list(cwd);
    return paths.length > 0 && paths.every((p) => roots.some((r) => inside(p, r)));
  }
}
