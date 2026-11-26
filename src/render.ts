// How Pi shows pi-agy-acp's display-only messages. Pi's default draws a
// "[customType]" label in a purple box; these show as normal transcript text.
// The message content keeps its prefix (other models see it as context).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { STEER_PREFIX, WAKE_MESSAGE, WAKE_PREFIX } from "./runtime.ts";

export const STEER_MESSAGE = "antigravity-steer";

const textOf = (content: unknown) =>
  typeof content === "string" ? content : Array.isArray(content) ? content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n") : "";

const strip = (text: string, prefix: string) => (text.startsWith(prefix) ? text.slice(prefix.length) : text);

export function registerRenderers(pi: ExtensionAPI) {
  // agy's own continuation: like assistant text.
  pi.registerMessageRenderer(WAKE_MESSAGE, (message, { outputPad }) => new Markdown(strip(textOf(message.content), WAKE_PREFIX), outputPad, 0, getMarkdownTheme()));
  // A message sent to agy during its turn: like a user message.
  pi.registerMessageRenderer(STEER_MESSAGE, (message, { outputPad }, theme) =>
    new Markdown(strip(textOf(message.content), STEER_PREFIX), outputPad, 1, getMarkdownTheme(), {
      color: (t) => theme.fg("userMessageText", t),
      bgColor: (t) => theme.bg("userMessageBg", t),
    }),
  );
}
