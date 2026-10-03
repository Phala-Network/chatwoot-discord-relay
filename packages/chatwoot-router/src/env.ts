import type { ConfigEnv } from "../../../shared/settings.ts";
import type { Coordinator } from "./coordinator.ts";
import type { Router } from "./router.ts";

export interface Env extends ConfigEnv {
  COORDINATOR: DurableObjectNamespace<Coordinator>;
  ROUTER: DurableObjectNamespace<Router>;
  CHATWOOT_TOKEN: string;
  CHATWOOT_AGENT_BOT_SECRETS: string;
  TYPESAFE_API_KEY: string;
  CHATWOOT_AGENT_BOT_TOKENS: string;
}
