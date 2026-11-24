// API-equivalent prices for agy models, so Pi can count a cost.
//
// You pay a subscription, not per token. The cost that Pi shows is what the
// same tokens would cost through the model maker's API.
//
// Order: Pi's own model registry first (no request). If it has no price for
// the model, Pi's model catalog on pi.dev (the same request that Pi makes for
// its own catalog; nothing goes to Google). That list is saved for a day, and
// an old copy is used when pi.dev cannot be reached.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { log } from "./log.ts";

export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  tiers?: { inputTokensAbove: number; input: number; output: number; cacheRead: number; cacheWrite: number }[];
}

type Lookup = (provider: string, id: string) => Price | undefined;

const CATALOG_URL = "https://pi.dev";
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 4_000;

/** The API provider that sells an agy model, or undefined (for example GPT-OSS). */
export function sellerOf(id: string): string | undefined {
  if (id.startsWith("gemini-")) return "google";
  if (id.startsWith("claude-")) return "anthropic";
  return undefined;
}

export function cachePath(env: Record<string, string | undefined> = process.env): string {
  const dir = env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  return path.join(dir, "state", "pi-agy-acp-prices.json");
}

interface CacheFile {
  fetchedAt: number;
  providers: Record<string, Record<string, Price>>;
}

function isPrice(c: any): c is Price {
  return c && typeof c.input === "number" && typeof c.output === "number" && (c.input > 0 || c.output > 0);
}

/** The id → price map from a pi.dev catalog body (an array, `{ models }`, or an id map). */
export function pricesFromCatalog(body: unknown): Record<string, Price> {
  const list: unknown[] = Array.isArray(body)
    ? body
    : body && typeof body === "object" && Array.isArray((body as any).models)
      ? (body as any).models
      : body && typeof body === "object"
        ? Object.values(body as object)
        : [];
  const out: Record<string, Price> = {};
  for (const m of list as any[]) {
    if (typeof m?.id === "string" && isPrice(m.cost) && (m.type === undefined || m.type === "chat")) {
      out[m.id] = { cacheRead: 0, cacheWrite: 0, ...m.cost };
    }
  }
  return out;
}

export class Prices {
  private cache: CacheFile | undefined;
  private loading: Promise<void> | undefined;
  private failedAt = -Infinity;

  constructor(
    private readonly file = cachePath(),
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
    private readonly now = () => Date.now(),
  ) {}

  /** The price for an agy model id. Pi's registry first, then the pi.dev list. */
  async price(id: string, registry?: Lookup): Promise<Price | undefined> {
    const seller = sellerOf(id);
    if (!seller) return undefined;
    const local = registry?.(seller, id);
    if (isPrice(local)) return local;
    await this.load(seller);
    return this.cache?.providers[seller]?.[id];
  }

  private readFile(): CacheFile | undefined {
    try {
      const c = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return typeof c?.fetchedAt === "number" && c.providers && typeof c.providers === "object" ? c : undefined;
    } catch {
      return undefined;
    }
  }

  /** Loads the saved list, and gets a new one from pi.dev when it is old or lacks this provider. */
  private async load(seller: string): Promise<void> {
    this.cache ??= this.readFile();
    const fresh = this.cache && this.now() - this.cache.fetchedAt < MAX_AGE_MS && this.cache.providers[seller];
    // After a failure, wait an hour before the next try; use the old list.
    if (fresh || this.now() - this.failedAt < 60 * 60 * 1000) return;
    this.loading ??= this.fetchAll().finally(() => {
      this.loading = undefined;
    });
    await this.loading;
  }

  private async fetchAll(): Promise<void> {
    const providers: CacheFile["providers"] = {};
    try {
      for (const p of ["google", "anthropic"]) {
        const url = new URL(`/api/models/providers/${p}`, CATALOG_URL);
        url.searchParams.set("types", "chat,image,classifier");
        const res = await this.fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!res.ok) throw new Error(`pi.dev answered HTTP ${res.status}`);
        providers[p] = pricesFromCatalog(await res.json());
      }
    } catch (e) {
      this.failedAt = this.now();
      log({ event: "prices_failed", error: String((e as Error).message).slice(0, 120) });
      return;
    }
    this.cache = { fetchedAt: this.now(), providers };
    log({ event: "prices_fetched", count: Object.values(providers).reduce((n, p) => n + Object.keys(p).length, 0) });
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, `${JSON.stringify(this.cache)}\n`);
    } catch {}
  }
}
