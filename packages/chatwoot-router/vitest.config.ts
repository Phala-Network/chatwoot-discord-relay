import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { silent: "passed-only", setupFiles: ["./test/setup.ts"] },
  plugins: [
    cloudflareTest({
      main: "./src/index.ts",
      miniflare: {
        compatibilityDate: "2026-08-15",
        compatibilityFlags: ["nodejs_compat"],
        durableObjects: {
          ROUTER: { className: "Router", useSQLite: true },
          COORDINATOR: { className: "Coordinator", useSQLite: true },
        },
        kvNamespaces: ["CONFIG_STORE"],
        bindings: {
          CONFIG: {
            chatwoot: { baseUrl: "https://chatwoot.example.com" },
            routing: {
              botIds: { "1": 1, "2": 2 },
              kinds: {
                "1": {
                  spam: { covers: "Unsolicited advertising.", status: "resolved" },
                  newsletter: { covers: "A newsletter.", status: "snoozed" },
                  "startup-program": { covers: "A startup application.", cannedResponse: "startup" },
                },
              },
              accounts: {
                "1": { cloud: { assignee: 6, covers: "Cloud support." } },
                "2": { cloud: { assignee: 7, covers: "Cloud support." } },
              },
            },
          },
          CHATWOOT_TOKEN: "agent-token",
          CHATWOOT_AGENT_BOT_SECRETS: JSON.stringify({ "1": "secret-acme", "2": "secret-globex" }),
          TYPESAFE_API_KEY: "ts-key",
          CHATWOOT_AGENT_BOT_TOKENS: JSON.stringify({ "1": "bot-token", "2": "other-bot-token" }),
        },
      },
    }),
  ],
});
