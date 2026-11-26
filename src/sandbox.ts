// Runs agy inside bubblewrap (bwrap), so agy and every command that it runs
// see only what they need:
// - read-only: /usr, /etc, /nix, /sys, your PATH folders under $HOME, git
//   config, and folders that you list in the config;
// - read-write: the workspace (cwd and extra folders, and their git common
//   dirs for worktrees), ~/.gemini, and agy's config and cache folders;
// - not there: the rest of $HOME (~/.ssh, ~/.pi/agent/auth.json, other
//   projects), /tmp of the host, and other runtime sockets.
// The network is shared, so agy's own TLS traffic to Google does not change.
// agy keeps its sign-in in the desktop keyring, so a filtered D-Bus proxy
// (xdg-dbus-proxy) lets it talk only to org.freedesktop.secrets.
// agy's own terminal sandbox ("exebox") cannot start on a Nix-built agy
// without /nix, and bwrap already contains every agy process, so inside
// bwrap agy gets a copy of its settings with enableTerminalSandbox: false.
// The host agy and its settings do not change.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configPath, expandPath } from "./dirs.ts";
import { log } from "./log.ts";
import { BRIDGE } from "./mcp.ts";

export interface SandboxConfig {
  mode: "off" | "bwrap";
  /** Extra read-only folders, for example ~/.vite-plus. */
  readOnly: string[];
  /** Extra read-write folders. */
  readWrite: string[];
}

export interface Workspace {
  cwd: string;
  dirs: string[];
}

const SECRETS_BUS = "org.freedesktop.secrets";
/** Env vars that agy does not need and that may hold keys. */
const SECRET_ENV = /(API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i;

const inside = (p: string, dir: string) => p === dir || p.startsWith(`${dir}/`);

/** Folders in $HOME that are never mounted whole: they hold keys or other data. */
const PRIVATE = new Set([".pi", ".ssh", ".gnupg", ".local", ".config", ".cache", ".aws", ".kube", ".docker", ".password-store", ".mozilla", ".gemini"]);

/**
 * Read-only mounts for paths in $HOME. A symlink becomes a symlink in the
 * sandbox, and its target is mounted. For a PATH folder, the install folders
 * of its links (for example ~/.vite-plus for ~/.vite-plus/bin/node) are mounted too.
 */
export function homeMounts(paths: string[], home: string, pathDirs: Set<string>): { binds: string[]; links: [string, string][] } {
  const binds = new Set<string>();
  const links = new Map<string, string>();
  // A tool install folder (~/.vite-plus) is mounted whole, since the tool
  // needs its other files. A private folder or a git repo (~/.dotfiles) is
  // not: only the folder of the linked file.
  const installRoot = (t: string) => {
    const top = path.join(home, path.relative(home, t).split("/")[0]);
    return PRIVATE.has(path.basename(top)) || fs.existsSync(path.join(top, ".git")) ? path.dirname(t) : top;
  };
  const plan = (p: string, depth = 0) => {
    if (depth > 8 || !inside(p, home) || p === home) return;
    // A path through a symlink (~/.nix-profile/bin): plan the symlink itself.
    const parts = path.relative(home, p).split("/");
    for (let i = 1; i < parts.length; i++) {
      const prefix = path.join(home, ...parts.slice(0, i));
      try {
        if (fs.lstatSync(prefix).isSymbolicLink()) return plan(prefix, depth + 1);
      } catch {
        return;
      }
    }
    let st: fs.Stats;
    try {
      st = fs.lstatSync(p);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) {
      // Follow one link at a time, so each link in a chain is recreated
      // (~/.nix-profile → ~/.local/state/nix/profiles/profile → profile-N-link → /nix/store/…).
      const target = fs.readlinkSync(p);
      links.set(p, target);
      plan(path.resolve(path.dirname(p), target), depth + 1);
      return;
    }
    binds.add(p);
    if (!pathDirs.has(p) || !st.isDirectory()) return;
    for (const name of fs.readdirSync(p)) {
      const entry = path.join(p, name);
      try {
        if (!fs.lstatSync(entry).isSymbolicLink()) continue;
        const real = fs.realpathSync(entry);
        if (inside(real, home) && !inside(real, p)) plan(installRoot(real), depth + 1);
      } catch {}
    }
  };
  for (const p of paths) plan(path.resolve(p));
  return { binds: [...binds], links: [...links].map(([p, t]) => [t, p]) };
}

/** The extra sandbox folders of a project config (no mode: a project cannot turn the sandbox off). */
export function projectSandbox(file: string, base: string, home = os.homedir()): { readOnly: string[]; readWrite: string[] } {
  let data: any = {};
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8")) ?? {};
  } catch {}
  const list = (x: unknown) => (Array.isArray(x) ? x.flatMap((d) => (typeof d === "string" ? (expandPath(d, home, base) ?? []) : [])) : []);
  return { readOnly: list(data.sandboxReadOnly), readWrite: list(data.sandboxReadWrite) };
}

/** From PI_ANTIGRAVITY_SANDBOX (bwrap|off) and the pi-agy-acp config file. Off by default. */
export function sandboxConfig(env: Record<string, string | undefined> = process.env, file = configPath(env), home = os.homedir()): SandboxConfig {
  let data: any = {};
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8")) ?? {};
  } catch {}
  const raw = (env.PI_ANTIGRAVITY_SANDBOX ?? data.sandbox ?? "off").toString().trim().toLowerCase();
  const list = (x: unknown) => (Array.isArray(x) ? x.flatMap((d) => (typeof d === "string" ? (expandPath(d, home) ?? []) : [])) : []);
  return {
    mode: raw === "bwrap" ? "bwrap" : "off",
    readOnly: list(data.sandboxReadOnly),
    readWrite: list(data.sandboxReadWrite),
  };
}

/** The folder of git's shared data for a worktree, when it is outside `dir`. */
function gitCommonDir(dir: string): string | undefined {
  try {
    const out = execFileSync("git", ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"], { timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    if (!out || !path.isAbsolute(out)) return undefined;
    const rel = path.relative(dir, out);
    return rel.startsWith("..") || path.isAbsolute(rel) ? out : undefined;
  } catch {
    return undefined;
  }
}

/** Absolute path of a command, with symlinks resolved. */
export function resolveCommand(command: string, envPath = process.env.PATH ?? ""): string {
  const candidates = command.includes("/") ? [command] : envPath.split(":").filter(Boolean).map((d) => path.join(d, command));
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return fs.realpathSync(c);
    } catch {}
  }
  throw new Error(`${command} not found in PATH`);
}

export interface BwrapInput {
  home: string;
  uid: number;
  workspace: string[];
  readOnly: string[];
  readWrite: string[];
  /** The settings copy with enableTerminalSandbox: false. */
  settingsFile?: string;
  /** The filtered D-Bus socket. */
  busSocket?: string;
  /** Symlinks to recreate, as [target, path], for example ~/.nix-profile. */
  links?: [string, string][];
  /** Root folder links of the host, for example { "/bin": "usr/bin" }. */
  rootLinks: Record<string, string | undefined>;
  unsetEnv: string[];
  command: string[];
}

/** The bwrap arguments. Mount order matters: parents before children. */
export function bwrapArgs(o: BwrapInput): string[] {
  const a = ["--die-with-parent", "--new-session", "--unshare-pid", "--unshare-ipc", "--unshare-uts"];
  a.push("--ro-bind", "/usr", "/usr");
  for (const dir of ["/bin", "/sbin", "/lib", "/lib64"]) {
    const link = o.rootLinks[dir];
    if (link) a.push("--symlink", link, dir);
    else a.push("--ro-bind-try", dir, dir);
  }
  a.push("--ro-bind", "/etc", "/etc", "--ro-bind-try", "/nix", "/nix", "--ro-bind-try", "/opt", "/opt", "--ro-bind", "/sys", "/sys");
  a.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--tmpfs", "/var/tmp");
  a.push("--ro-bind-try", "/run/systemd/resolve", "/run/systemd/resolve");
  a.push("--tmpfs", o.home);
  // One list, parents first, so a child mount is not hidden by its parent.
  // Read-write wins over read-only for the same path. Only the cwd must exist.
  const mounts = new Map<string, string>();
  for (const p of o.readOnly) mounts.set(path.resolve(p), "--ro-bind-try");
  for (const p of [...o.readWrite, ...o.workspace.slice(1)]) mounts.set(path.resolve(p), "--bind-try");
  mounts.set(path.resolve(o.workspace[0]), "--bind");
  const depth = (p: string) => p.split("/").length;
  const done: [string, string][] = [];
  for (const [p, flag] of [...mounts].sort(([x], [y]) => depth(x) - depth(y) || x.localeCompare(y))) {
    // A read-only folder inside another mount is already there (and may be a symlink).
    if (flag === "--ro-bind-try" && done.some(([d]) => inside(p, d))) continue;
    a.push(flag, p, p);
    done.push([p, flag]);
  }
  for (const [target, p] of o.links ?? []) if (!done.some(([d]) => inside(p, d))) a.push("--symlink", target, p);
  if (o.settingsFile) {
    const target = path.join(o.home, ".gemini", "antigravity-cli", "settings.json");
    a.push("--ro-bind", o.settingsFile, target);
  }
  const run = `/run/user/${o.uid}`;
  a.push("--dir", run, "--setenv", "XDG_RUNTIME_DIR", run);
  if (o.busSocket) a.push("--ro-bind", o.busSocket, `${run}/bus`, "--setenv", "DBUS_SESSION_BUS_ADDRESS", `unix:path=${run}/bus`);
  else a.push("--unsetenv", "DBUS_SESSION_BUS_ADDRESS");
  for (const name of o.unsetEnv) a.push("--unsetenv", name);
  a.push("--unsetenv", "SSH_AUTH_SOCK", "--chdir", o.workspace[0]);
  return [...a, "--", ...o.command];
}

// ---- the D-Bus proxy: one per Pi process ----

let proxy: { child: ChildProcess; socket: string } | undefined;

async function startProxy(dir: string): Promise<string | undefined> {
  if (proxy && proxy.child.exitCode === null) return proxy.socket;
  const address = process.env.DBUS_SESSION_BUS_ADDRESS;
  if (!address) return undefined;
  const socket = path.join(dir, "bus");
  fs.rmSync(socket, { force: true });
  let child: ChildProcess;
  try {
    // --fd=3: the proxy stops when Pi's end of the pipe closes, also on a crash.
    child = spawn("xdg-dbus-proxy", ["--fd=3", address, socket, "--filter", `--talk=${SECRETS_BUS}`], { stdio: ["ignore", "ignore", "ignore", "pipe"] });
  } catch {
    return undefined;
  }
  const failed = new Promise<undefined>((resolve) => {
    child.once("error", () => resolve(undefined));
    child.once("exit", () => resolve(undefined));
  });
  child.unref();
  (child.stdio[3] as any)?.unref?.();
  const ready = (async () => {
    for (let i = 0; i < 60; i++) {
      if (fs.existsSync(socket)) return socket;
      await new Promise((r) => setTimeout(r, 50));
    }
    return undefined;
  })();
  const result = await Promise.race([ready, failed]);
  if (!result) {
    child.kill();
    log({ event: "sandbox_dbus_failed" });
    return undefined;
  }
  proxy = { child, socket };
  return socket;
}

export function stopSandbox() {
  proxy?.child.kill();
  proxy = undefined;
  fs.rmSync(path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), `pi-agy-acp-${process.pid}`), { recursive: true, force: true });
}

/** A folder for this Pi process: the bus socket, the settings copy, scratch sessions. */
export function stateDir(): string {
  const base = process.env.XDG_RUNTIME_DIR || os.tmpdir();
  const dir = path.join(base, `pi-agy-acp-${process.pid}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function settingsCopy(home: string, dir: string): string {
  let data: any = {};
  try {
    data = JSON.parse(fs.readFileSync(path.join(home, ".gemini", "antigravity-cli", "settings.json"), "utf8")) ?? {};
  } catch {}
  data.enableTerminalSandbox = false;
  const file = path.join(dir, "settings.json");
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  return file;
}

function rootLinks(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const dir of ["/bin", "/sbin", "/lib", "/lib64"]) {
    try {
      out[dir] = fs.lstatSync(dir).isSymbolicLink() ? fs.readlinkSync(dir) : undefined;
    } catch {}
  }
  return out;
}

/** The bwrap command that runs `command args` for this workspace. */
export async function sandboxLaunch(
  ws: Workspace,
  cfg: SandboxConfig,
  command: string,
  args: string[],
): Promise<{ command: string; args: string[]; scratch: string }> {
  const home = os.homedir();
  const dir = stateDir();
  const scratch = path.join(dir, "scratch");
  fs.mkdirSync(scratch, { recursive: true });
  const workspace = [ws.cwd, ...ws.dirs];
  for (const d of [...workspace]) {
    const common = gitCommonDir(d);
    if (common) workspace.push(common);
  }
  const pathDirs = (process.env.PATH ?? "").split(":").filter((d) => d.startsWith(`${home}/`));
  const wanted = [
    ...pathDirs,
    path.join(home, ".nix-profile"),
    path.join(home, ".config", "git"),
    path.join(home, ".gitconfig"),
    path.dirname(path.dirname(BRIDGE)),
    ...cfg.readOnly,
  ].filter((p) => p.startsWith("/"));
  const home_ = homeMounts(wanted, home, new Set(pathDirs));
  // Paths outside $HOME (for example /opt/x) are mounted as they are.
  const readOnly = [...home_.binds, ...wanted.filter((p) => !inside(p, home))];
  const readWrite = [path.join(home, ".gemini"), path.join(home, ".config", "antigravity"), path.join(home, ".cache", "antigravity"), scratch, ...cfg.readWrite];
  const busSocket = await startProxy(dir);
  if (!busSocket) log({ event: "sandbox_no_dbus" });
  const out = bwrapArgs({
    home,
    uid: process.getuid?.() ?? 1000,
    workspace,
    readOnly,
    readWrite,
    settingsFile: settingsCopy(home, dir),
    links: home_.links,
    busSocket,
    rootLinks: rootLinks(),
    unsetEnv: Object.keys(process.env).filter((k) => SECRET_ENV.test(k)),
    command: [resolveCommand(command), ...args],
  });
  log({ event: "sandbox_launch", mounts: workspace.length, dbus: !!busSocket });
  return { command: "bwrap", args: out, scratch };
}
