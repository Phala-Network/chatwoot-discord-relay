import { ConfigError } from "./config.ts";
import { within } from "./deadline.ts";
import { parseJson } from "./json.ts";

export interface ConfigEnv {
  CONFIG?: unknown;
  CONFIG_KEY?: string;
  CONFIG_STORE?: KVNamespace;
}

export function settingsLoader<Env extends ConfigEnv, Settings>(parse: (config: unknown, env: Env) => Settings) {
  const cache = new WeakMap<Env, Promise<Settings>>();
  return (env: Env): Promise<Settings> => {
    let settings = cache.get(env);
    if (!settings) {
      settings = readConfig(env).then((config) => parse(config, env));
      cache.set(env, settings);
      settings.catch(() => cache.delete(env));
    }
    return settings;
  };
}

async function readConfig(env: ConfigEnv): Promise<unknown> {
  if (env.CONFIG_KEY === undefined) return typeof env.CONFIG === "string" ? parseJson(env.CONFIG) : env.CONFIG;
  if (env.CONFIG !== undefined) throw new ConfigError("Invalid CONFIG: set either CONFIG or CONFIG_KEY");
  if (!env.CONFIG_STORE) throw new ConfigError("Invalid CONFIG_KEY: requires the CONFIG_STORE KV namespace");
  // A key names one configuration and is never rewritten, so whichever copy KV returns is current.
  const config = await within(env.CONFIG_STORE.get(env.CONFIG_KEY, "json"), AbortSignal.timeout(1500));
  if (config === null) throw new ConfigError("Invalid CONFIG_KEY: not in CONFIG_STORE");
  return config;
}
