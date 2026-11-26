#!/usr/bin/env node
// Follows one agy subagent's transcript in a terminal (a Rex floating pane).
// Usage: agy-subagent-view.mjs <brain dir> <parent id> <child id>
// Prints each step once, then new steps as agy writes them. q, Esc or Ctrl-C closes.
import fs from "node:fs";
import path from "node:path";

const [brain, parent, id] = process.argv.slice(2);
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
if (!brain || !ID.test(parent ?? "") || !ID.test(id ?? "")) {
  console.error("usage: agy-subagent-view.mjs <brain dir> <parent id> <child id>");
  process.exit(2);
}
const transcript = path.join(brain, id, ".system_generated", "logs", "transcript.jsonl");
const record = path.join(brain, parent, ".system_generated", "subagents", `${id}.json`);

const c = (code) => (s) => `\x1b[${code}m${s}\x1b[0m`;
const bold = c("1");
const dim = c("2");
const italic = c("2;3");
const cyan = c("36");
const red = c("31");
const yellow = c("33");
const MAX = 6000;

const cut = (s) => (s.length > MAX ? `${s.slice(0, MAX)}…` : s);
const unquote = (v) => (typeof v === "string" ? v.replace(/^"|"$/g, "").replace(/\\n/g, " ") : JSON.stringify(v));

function readRecord() {
  try {
    return JSON.parse(fs.readFileSync(record, "utf8"));
  } catch {
    return undefined;
  }
}

/** One step as terminal text, or "" for nothing to show. */
function step(d) {
  const out = [];
  let body = typeof d.content === "string" ? d.content : "";
  // agy wraps messages in a SYSTEM_MESSAGE envelope.
  const env = /<SYSTEM_MESSAGE>[\s\S]*?\bsender=(\S+)[\s\S]*?content=([\s\S]*?)\n<\/SYSTEM_MESSAGE>/.exec(body);
  // Tool results start with agy's timing lines.
  body = body.replace(/^(?:(?:Created|Completed) At: .*\n?)+/gm, "").trim();
  switch (d.type) {
    case "SYSTEM_MESSAGE":
      out.push(yellow(`◆ message${env ? ` from ${env[1] === parent ? "parent" : env[1].slice(0, 8)}` : ""}`));
      out.push(cut((env ? env[2] : body).trim()));
      break;
    case "USER_INPUT":
      out.push(yellow("◆ input"), cut(body));
      break;
    case "PLANNER_RESPONSE":
      if (typeof d.thinking === "string" && d.thinking.trim()) out.push(italic(cut(d.thinking.trim())));
      if (body) out.push(cut(body));
      for (const t of Array.isArray(d.tool_calls) ? d.tool_calls : []) {
        const args = Object.entries(t?.args ?? {})
          .filter(([k]) => k !== "toolSummary")
          .map(([k, v]) => `${k}=${unquote(v)}`)
          .join(" ");
        out.push(cyan(`▸ ${t?.name ?? "?"}`) + (args ? dim(` ${args.length > 300 ? `${args.slice(0, 300)}…` : args}`) : ""));
      }
      break;
    default:
      if (typeof d.error === "string" && d.error) out.push(red(`✗ ${cut(d.error)}`));
      else if (body) out.push(dim(cut(body.length > 800 ? `${body.slice(0, 800)}…` : body)));
  }
  return out.filter(Boolean).join("\n");
}

let offset = 0;
let rest = "";
let lastState = "";

function poll() {
  const rec = readRecord();
  const state = String(rec?.state ?? "");
  try {
    const fd = fs.openSync(transcript, "r");
    try {
      const size = fs.fstatSync(fd).size;
      if (size < offset) offset = 0; // rewritten
      if (size > offset) {
        const buf = Buffer.alloc(size - offset);
        fs.readSync(fd, buf, 0, buf.length, offset);
        offset = size;
        const text = rest + buf.toString("utf8");
        const lines = text.split("\n");
        rest = lines.pop() ?? "";
        for (const line of lines) {
          let d;
          try {
            d = JSON.parse(line);
          } catch {
            continue;
          }
          const s = step(d);
          if (s) process.stdout.write(`${s}\n\n`);
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {}
  if (state !== lastState) {
    if (lastState && state === "SUBAGENT_STATE_KILLED") process.stdout.write(dim("── agy stopped this subagent ──\n\n"));
    lastState = state;
  }
}

const rec = readRecord();
const role = rec?.subagentDescriptor?.role ?? "subagent";
process.stdout.write(`\x1b]2;agy: ${role}\x07`);
process.stdout.write(`${bold(role)} ${dim(`· agy subagent · ${id}`)}\n${dim("Read-only: agy owns this subagent. q or Esc closes.")}\n\n`);
poll();
setInterval(poll, 1000);

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", (b) => {
    const k = b.toString();
    if (k === "q" || k === "\x1b" || k === "\x03") process.exit(0);
  });
}
