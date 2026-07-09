# agent-hub gateway integration

This branch integrates [agent-hub](../../..)'s per-session multiprovider
routing gateway into the Claude provider. A Claude provider instance that
declares the marker variable `AGENT_HUB_GATEWAY_URL` in its per-instance
environment gets:

- the gateway's full provider×model catalog appended to its model list
  (picker slugs of the form `<provider>/<model>`, grouped by `subProvider`);
- per-thread routing: each thread's `claude` process is spawned with
  `ANTHROPIC_BASE_URL=<gateway>/s/t3-<threadId>`;
- mid-conversation provider/model switching: selecting a matrix model
  re-points the gateway route table before the prompt is queued — the
  running process picks the new upstream up on its next API request, no
  respawn, across vendors.

Instances without the marker are untouched; every integration code path is
inert for them.

## Configuration

On a Claude provider instance (Settings → Providers, or
`providerInstances.<id>` in the server settings file):

| Environment variable      | Meaning                                                                                                                                                   |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENT_HUB_GATEWAY_URL`   | Opt-in marker + gateway base URL, e.g. `http://127.0.0.1:8484`                                                                                            |
| `AGENT_HUB_GATEWAY_TOKEN` | Optional. Gateway internal-API token; falls back to `~/.agent-hub/secrets.json` (`internal_gateway_token`) since both run on the same machine             |
| `AGENT_HUB_DEFAULT_ROUTE` | Optional. `provider/model` used for the instance session (probes, text generation) and as the session-start fallback; defaults to the first catalog entry |

The instance should also set an isolated `Claude HOME path` so a cached
Anthropic login can't shadow the gateway env, and a `Binary path` to a real
`claude` executable. Run the gateway from the agent-hub repo:
`bun run packages/gateway/src/index.ts`.

## Code layout & upstream seams

All integration logic lives in **one module**:
`apps/server/src/provider/agentHubGateway.ts` (plus its unit tests in
`agentHubGateway.test.ts`). Upstream files call it only at hook lines
anchored with a `[agent-hub]` comment:

| File                               | Hooks                                                                                                                                                                                   |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider/Drivers/ClaudeDriver.ts` | import; `initAgentHubInstance` (env + default route); `agentHubGateway` adapter option; `withAgentHubGatewayModels` in the two snapshot pipes                                           |
| `provider/Layers/ClaudeAdapter.ts` | import; `agentHubGateway` field on `ClaudeAdapterLiveOptions`; `agentHubAdapterHooks` at the adapter head; `syncRouteBestEffort` + `env()` in `startSession`; `syncRoute` in `sendTurn` |

Audit the seams after any upstream sync:

```sh
grep -rn '\[agent-hub\]' apps/server/src
```

## Rebasing onto upstream t3code

1. `git fetch origin && git rebase origin/main` (this branch:
   `agent-hub-multiprovider`).
2. Conflicts can only occur on the anchored hook lines above — re-apply
   them around the moved code; the module itself never conflicts.
3. Re-verify: the grep above shows all hooks;
   `pnpm --dir apps/server run typecheck`;
   `vp test run agentHubGateway ClaudeAdapter` from `apps/server`.
4. Live smoke test: start the agent-hub gateway + `bun run dev`, open the
   picker on a gateway-flagged instance (matrix models present), send a
   message, switch to a different provider's model mid-thread, and confirm
   the route flip in agent-hub's sqlite:
   `sqlite3 ~/.agent-hub/hub.sqlite "SELECT id, current_route_provider, current_route_model FROM sessions WHERE id LIKE 't3-%';"`
