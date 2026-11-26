// Rex floating panes, for the agy subagent viewer. Works only when Pi runs in
// a Rex pane (REX_BLOCK set and `rex` on PATH). Newer Rex builds set only
// REX_BLOCK, so the session comes from the block when REX_SESSION is missing.
import { execFile } from "node:child_process";

const FLAVOR = "com.superlogical.terminal.shell";

function rex(args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile("rex", ["--autostart=false", ...args], { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 }, (err, out, stderr) =>
      err ? reject(new Error((stderr || err.message).trim())) : resolve(out),
    ),
  );
}

const call = async (method: string, params: Record<string, unknown>) => {
  const out = await rex(["api", "call", method, JSON.stringify(params)]);
  return out.trim() ? JSON.parse(out) : undefined;
};

export const inRexPane = () => !!process.env.REX_BLOCK;

let session: string | undefined = process.env.REX_SESSION;
async function rexSession(): Promise<string | undefined> {
  const block = process.env.REX_BLOCK;
  if (session || !block) return session;
  const info = JSON.parse(await rex(["block", "inspect", block, "--json"]));
  session = typeof info?.session_id === "string" ? info.session_id : undefined;
  return session;
}

/**
 * Shows the floating pane labelled `label` in Pi's window: raises it when it
 * exists, else starts `command` in a new one. Throws when Rex fails.
 */
export async function openFloat(label: string, command: string[], cwd: string): Promise<void> {
  const sid = await rexSession();
  const block = process.env.REX_BLOCK;
  if (!sid || !block) throw new Error("not in a Rex pane");
  const view = await call("session.view", { session_id: sid });
  let windowId: string | undefined = view?.active_window_id;
  let existing: string | undefined;
  for (const w of view?.windows ?? []) {
    for (const layer of w.layers ?? []) {
      for (const b of layer.blocks ?? []) {
        if (b.block_id === block) windowId = w.window_id;
        if (layer.kind !== "tiled" && b.label === label) existing = layer.layer_id;
      }
    }
  }
  if (existing) {
    await call("session.set_layer_state", { session_id: sid, layer_id: existing, state: "normal", focus: true });
    return;
  }
  await call("session.new_layer", {
    session_id: sid,
    window_id: windowId,
    bounds: [0.08, 0.06, 0.84, 0.88],
    focus: true,
    layout: { block: { flavor: FLAVOR, label, options: { command, cwd } } },
  });
}
