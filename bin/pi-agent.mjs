#!/usr/bin/env node
// pi-agent: start and wait for Pi child agents from agy's terminal.
// Talks to the parent Pi over PI_AG_BRIDGE (a Unix socket) with PI_AG_TOKEN.
//
//   pi-agent start NAME --model PROVIDER/MODEL [--title T] [--thinking L] [--cwd D] [--worktree [W]] (--task TEXT | --task-file FILE | stdin)
//   pi-agent send NAME TEXT            message a running child (a steer if busy)
//   pi-agent wait [NAME] [--timeout S] block until a child settles; prints its reply
//   pi-agent status [NAME]
//   pi-agent stop NAME
//
// Run `wait` as a background command; agy continues when it exits.
// Exit codes: 0 ok, 1 error, 2 usage, 3 wait timed out (children still running).
import fs from "node:fs";
import net from "node:net";

const USAGE = fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 13).map((l) => l.replace(/^\/\/ ?/, "")).join("\n");

function fail(message, code = 1) {
  process.stderr.write(`pi-agent: ${message}\n`);
  process.exit(code);
}

const argv = process.argv.slice(2);
const action = argv.shift();
if (!action || action === "-h" || action === "--help") {
  process.stdout.write(`${USAGE}\n`);
  process.exit(action ? 0 : 2);
}

const params = { action };
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const next = () => {
    if (i + 1 >= argv.length) fail(`${a} needs a value`, 2);
    return argv[++i];
  };
  switch (a) {
    case "--model": params.model = next(); break;
    case "--title": params.title = next(); break;
    case "--thinking": params.thinking = next(); break;
    case "--cwd": params.cwd = next(); break;
    case "--task": params.task = next(); break;
    case "--task-file": params.task = fs.readFileSync(next(), "utf8"); break;
    case "--timeout": params.timeout = Number(next()); break;
    case "--worktree":
      params.worktree = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
      break;
    default:
      if (a.startsWith("--")) fail(`unknown option ${a}`, 2);
      positional.push(a);
  }
}
if (positional[0]) params.name = positional[0];
if (action === "send") params.text = positional.slice(1).join(" ") || (process.stdin.isTTY ? "" : fs.readFileSync(0, "utf8"));
if (action === "start" && params.task === undefined && !process.stdin.isTTY) params.task = fs.readFileSync(0, "utf8");
if (action === "start" && !params.task?.trim()) fail("start needs --task, --task-file, or the task on stdin", 2);
if (action === "wait" && params.timeout === undefined) params.timeout = 3600;

const socketPath = process.env.PI_AG_BRIDGE;
const token = process.env.PI_AG_TOKEN;
if (!socketPath || !token) fail("PI_AG_BRIDGE is not set. Run this from an Antigravity session in Pi (pi-antigravity).");

const socket = net.connect(socketPath);
let buf = "";
socket.setEncoding("utf8");
socket.on("connect", () => socket.write(`${JSON.stringify({ token, params })}\n`));
socket.on("error", (e) => fail(`cannot reach Pi: ${e.message}`));
socket.on("data", (d) => {
  buf += d;
});
socket.on("end", () => {
  let r;
  try {
    r = JSON.parse(buf.trim().split("\n").pop() || "{}");
  } catch {
    fail("bad reply from Pi");
  }
  if (r.error) fail(r.error);
  const text = r.text ?? "";
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  if (action === "wait" && /^No agent settled within/.test(text)) process.exit(3);
  process.exit(0);
});
