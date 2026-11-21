import { createProvider } from "@earendil-works/pi-ai";
import { execFile } from "node:child_process";
import { API_ID, BASE_URL, catalogFromModelsOutput, FALLBACK_CATALOG, PROVIDER_ID, toPiModel, type CatalogEntry } from "./models.ts";
import { launchFromEnv, type Runtime } from "./runtime.ts";
import { LOGIN_HINT, streamAntigravity } from "./stream.ts";

/** `agy models`: a sign-in check and the catalog, with no ACP session. */
export function agyModels(signal?: AbortSignal): Promise<CatalogEntry[] | undefined> {
  const { command } = launchFromEnv();
  const bin = command.endsWith("agy_acp_server") ? "agy" : command;
  return new Promise((resolve) => {
    execFile(bin, ["models"], { timeout: 30_000, signal, env: process.env }, (err, stdout) => {
      if (err && !stdout) return resolve(undefined);
      resolve(catalogFromModelsOutput(String(stdout)));
    });
  });
}

export function createAntigravityProvider(runtime: Runtime) {
  let discovered: Set<string> | undefined;
  let signedIn: { at: number; ok: boolean; catalog?: CatalogEntry[] } | undefined;

  async function status(signal: AbortSignal) {
    if (signedIn && Date.now() - signedIn.at < 5 * 60_000) return signedIn;
    const catalog = await agyModels(signal);
    signedIn = { at: Date.now(), ok: !!catalog, catalog };
    return signedIn;
  }

  const marker = () => ({ type: "oauth" as const, access: "agy-external", refresh: "agy-external", expires: Date.now() + 365 * 86_400_000 });

  return createProvider({
    id: PROVIDER_ID,
    name: "Antigravity (Google AI subscription)",
    baseUrl: BASE_URL,
    auth: {
      apiKey: {
        name: "Antigravity CLI sign-in",
        async check({ signal }) {
          const s = await status(signal);
          if (!s.ok) return undefined;
          return { type: "oauth", source: runtime.tier ? `Antigravity ${runtime.tier}` : "Antigravity subscription" };
        },
        async resolve({ signal }) {
          signal.throwIfAborted();
          return { auth: { apiKey: "agy-external" }, source: "Antigravity CLI" };
        },
      },
      // Metadata for Pi's subscription UI only. agy owns its Google sign-in;
      // pi-antigravity never reads or stores Google credentials.
      oauth: {
        name: "Antigravity subscription (managed by agy)",
        isSubscription: true,
        async login() {
          throw new Error(`${LOGIN_HINT} This provider uses the agy sign-in automatically.`);
        },
        async refresh(_c, signal) {
          const s = await status(signal);
          if (!s.ok) throw new Error(LOGIN_HINT);
          return marker();
        },
        async toAuth() {
          return { apiKey: "agy-external" };
        },
      },
    },
    models: FALLBACK_CATALOG.map(toPiModel),
    async fetchModels({ signal }) {
      const s = await status(signal);
      const catalog = s.catalog?.length ? s.catalog : FALLBACK_CATALOG;
      discovered = new Set(catalog.map((e) => e.id));
      return catalog.map(toPiModel);
    },
    filterModels(models) {
      return discovered ? models.filter((m) => discovered!.has(m.id)) : models;
    },
    api: {
      stream: (model, context, options) => streamAntigravity(runtime, model, context as any, options as any),
      streamSimple: (model, context, options) => streamAntigravity(runtime, model, context as any, options),
    },
  });
}

export { API_ID, PROVIDER_ID };
