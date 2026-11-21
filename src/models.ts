// The Antigravity model catalog, from agy's `session/new` result.
import type { Model, ThinkingLevel } from "@earendil-works/pi-ai";
import type { NewSessionResult } from "./acp/types.ts";

export const PROVIDER_ID = "antigravity";
export const API_ID = "antigravity-acp";
export const BASE_URL = "process://agy-acp";

export type AntigravityModel = Model<typeof API_ID>;

const AGY_LEVELS = ["low", "medium", "high", "xhigh"] as const;
type AgyLevel = (typeof AGY_LEVELS)[number];

/** Pi thinking level → agy `thought_level` value, nearest supported. */
const PI_TO_AGY: Record<ThinkingLevel, AgyLevel[]> = {
  minimal: ["low", "medium"],
  low: ["low", "medium"],
  medium: ["medium", "high", "low"],
  high: ["high", "medium", "xhigh"],
  xhigh: ["xhigh", "high"],
  max: ["xhigh", "high"],
};

export interface CatalogEntry {
  id: string;
  name: string;
  levels: AgyLevel[];
}

/** Base models with the thinking levels that agy lists for each. */
export function catalogFromSession(result: Pick<NewSessionResult, "configOptions" | "models">): CatalogEntry[] {
  const modelOption = result.configOptions?.find((o) => o.id === "model" || o.category === "model");
  const ids = result.models?.availableModels.map((m) => m.modelId) ?? [];
  const bases = modelOption?.options ?? [];
  return bases.map((b) => {
    const levels = AGY_LEVELS.filter((l) => ids.includes(`${b.value}-${l}`));
    return { id: b.value, name: b.name, levels };
  });
}

export function agyLevelFor(entry: Pick<CatalogEntry, "levels">, level: ThinkingLevel | undefined): AgyLevel | undefined {
  if (!entry.levels.length) return undefined;
  if (!level) return undefined;
  return PI_TO_AGY[level].find((l) => entry.levels.includes(l)) ?? entry.levels[entry.levels.length - 1];
}

export function toPiModel(entry: CatalogEntry): AntigravityModel {
  const thinkingLevelMap = entry.levels.length
    ? (Object.fromEntries(
        (Object.keys(PI_TO_AGY) as ThinkingLevel[]).map((pi) => {
          const agy = PI_TO_AGY[pi].find((l) => entry.levels.includes(l));
          return [pi, agy ?? null];
        }),
      ) as AntigravityModel["thinkingLevelMap"])
    : undefined;
  return {
    id: entry.id,
    name: `${entry.name} (Antigravity)`,
    api: API_ID,
    provider: PROVIDER_ID,
    baseUrl: BASE_URL,
    reasoning: entry.levels.length > 0,
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    input: ["text", "image"],
    // Subscription: Pi shows no per-token cost.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    // agy manages its own context; a large window keeps Pi's compaction quiet.
    contextWindow: 1_000_000,
    maxTokens: 64_000,
  };
}

/**
 * Parses `agy models` output ("<id>\t<Name (Level)>" per line) into base
 * models. Returns undefined when agy asks to sign in.
 */
export function catalogFromModelsOutput(stdout: string): CatalogEntry[] | undefined {
  if (/sign in/i.test(stdout) && !/\t/.test(stdout)) return undefined;
  const byId = new Map<string, CatalogEntry>();
  for (const line of stdout.split("\n")) {
    const [id, name] = line.split("\t").map((s) => s?.trim());
    if (!id || !name) continue;
    const m = /^(.*)-(low|medium|high|xhigh)$/.exec(id);
    const base = m ? m[1] : id;
    const level = m?.[2] as AgyLevel | undefined;
    const entry = byId.get(base) ?? { id: base, name: name.replace(/\s*\((Low|Medium|High|XHigh|Extra)\)$/i, ""), levels: [] };
    if (level && !entry.levels.includes(level)) entry.levels.push(level);
    byId.set(base, entry);
  }
  for (const e of byId.values()) e.levels.sort((a, b) => AGY_LEVELS.indexOf(a) - AGY_LEVELS.indexOf(b));
  return byId.size ? [...byId.values()] : undefined;
}

/** Shown before the first discovery, so `--model antigravity/...` resolves. */
export const FALLBACK_CATALOG: CatalogEntry[] = [
  { id: "gemini-4-neon", name: "Gemini 4 Neon", levels: ["low", "medium", "high", "xhigh"] },
  { id: "gemini-4-argon", name: "Gemini 4 Argon", levels: ["low", "medium", "high"] },
  { id: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen", levels: ["low", "medium", "high", "xhigh"] },
  { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", levels: ["low", "medium", "high"] },
];
