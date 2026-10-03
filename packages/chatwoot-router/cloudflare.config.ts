import { bindings, defineConfig, defineWorker, exports, triggers } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

const router = defineWorker({
  name: "chatwoot-router",
  entrypoint,
  compatibilityDate: "2026-08-15",
  exports: {
    Router: exports.durableObject({ storage: "sqlite" }),
    Coordinator: exports.durableObject({ storage: "sqlite" }),
  },
});

export default defineConfig({
  worker: {
    ...router,
    observability: { enabled: true },
    triggers: [triggers.scheduled({ schedule: "*/5 * * * *" })],
    env: {
      COORDINATOR: bindings.durableObject({ worker: router, exportName: "Coordinator" as const }),
      ROUTER: bindings.durableObject({ worker: router, exportName: "Router" as const }),
      CHATWOOT_TOKEN: bindings.secret(),
      CHATWOOT_AGENT_BOT_SECRETS: bindings.secret(),
      TYPESAFE_API_KEY: bindings.secret(),
      CHATWOOT_AGENT_BOT_TOKENS: bindings.secret(),
      CONFIG: bindings.json({
        chatwoot: { baseUrl: "https://chatwoot.example.com" },
        routing: {
          botIds: { "1": 1 },
          accounts: { "1": { support: { assignee: 6, covers: "Product support and billing." } } },
        },
      }),
    },
  },
});
