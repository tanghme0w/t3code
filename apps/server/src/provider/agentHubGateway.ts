/**
 * agentHubGateway — integration with agent-hub's per-session routing gateway.
 *
 * agent-hub (the repo this checkout lives in) runs a local reverse proxy on
 * 127.0.0.1:8484 that routes Anthropic-protocol requests per session id: a
 * `claude` process spawned with `ANTHROPIC_BASE_URL=<gw>/s/<sessionKey>` has
 * every API call re-routed to whatever provider/model the gateway's route
 * table currently holds for that key — switching the route mid-conversation
 * requires no respawn and is invisible to the process. Providers are
 * declared in agent-hub's providers/*.jsonc; the gateway rewrites
 * `body.model` upstream, so the model string the SDK sends is irrelevant.
 *
 * A Claude provider instance opts in by declaring the marker variable
 * `AGENT_HUB_GATEWAY_URL` in its per-instance environment. Everything else
 * is derived in ClaudeDriver/ClaudeAdapter:
 *   - the instance model list is extended with the gateway's full
 *     provider×model catalog, as slugs of the form `<provider>/<model>`
 *   - ClaudeAdapter points each thread's process at `/s/t3-<threadId>` and
 *     syncs the route table from the turn's model selection
 *   - the static (non-thread) env for capability probes and text
 *     generation points at a per-instance session key instead.
 *
 * The gateway's internal API is authenticated with a shared token, read
 * from `AGENT_HUB_GATEWAY_TOKEN` or, since both processes run on the same
 * machine, from agent-hub's own `~/.agent-hub/secrets.json`.
 */
import * as NodeOS from "node:os";

import type { ModelCapabilities, ServerProviderModel } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { HttpBody, HttpClient, HttpClientRequest } from "effect/unstable/http";

export const AGENT_HUB_GATEWAY_URL_ENV = "AGENT_HUB_GATEWAY_URL";
export const AGENT_HUB_GATEWAY_TOKEN_ENV = "AGENT_HUB_GATEWAY_TOKEN";
export const AGENT_HUB_DEFAULT_ROUTE_ENV = "AGENT_HUB_DEFAULT_ROUTE";

const CATALOG_TTL_MS = 60_000;
const GATEWAY_REQUEST_TIMEOUT_MS = 10_000;

export interface AgentHubRoute {
  readonly provider: string;
  readonly model: string;
}

export interface AgentHubGatewayConfig {
  readonly url: string;
  readonly token: string;
  readonly defaultRoute?: AgentHubRoute;
}

export interface AgentHubCatalogModel {
  readonly id: string;
  readonly displayName?: string;
}

export interface AgentHubCatalogProvider {
  readonly id: string;
  readonly display?: string;
  readonly models: ReadonlyArray<AgentHubCatalogModel>;
}

export class AgentHubGatewayError extends Schema.TaggedErrorClass<AgentHubGatewayError>()(
  "AgentHubGatewayError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

const decodeJsonString = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);

/** `provider/model`, split at the first slash (model ids may contain slashes). */
export function parseAgentHubRouteString(value: string): AgentHubRoute | undefined {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return undefined;
  return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
}

let cachedFallbackToken: string | null | undefined;

const readFallbackToken = Effect.fn("readFallbackToken")(function* () {
  if (cachedFallbackToken !== undefined) return cachedFallbackToken ?? undefined;
  const fileSystem = yield* FileSystem.FileSystem;
  const token = yield* fileSystem
    .readFileString(`${NodeOS.homedir()}/.agent-hub/secrets.json`)
    .pipe(
      Effect.flatMap((text) => decodeJsonString(text)),
      Effect.map((parsed) =>
        parsed && typeof parsed === "object"
          ? (parsed as Record<string, unknown>).internal_gateway_token
          : undefined,
      ),
      Effect.orElseSucceed(() => undefined),
    );
  cachedFallbackToken = typeof token === "string" && token.length > 0 ? token : null;
  return cachedFallbackToken ?? undefined;
});

/**
 * Reads the gateway opt-in from a provider instance's merged environment.
 * Returns undefined when the marker variable is absent (the common case: a
 * normal Claude instance) or when no internal token can be resolved.
 */
export const readAgentHubGatewayConfig = Effect.fn("readAgentHubGatewayConfig")(function* (
  env: NodeJS.ProcessEnv | undefined,
) {
  const rawUrl = env?.[AGENT_HUB_GATEWAY_URL_ENV]?.trim();
  if (!rawUrl) return undefined;
  const token = env?.[AGENT_HUB_GATEWAY_TOKEN_ENV]?.trim() || (yield* readFallbackToken());
  if (!token) {
    yield* Effect.logWarning("agent-hub gateway marker present but no internal token found", {
      url: rawUrl,
    });
    return undefined;
  }
  const rawDefault = env?.[AGENT_HUB_DEFAULT_ROUTE_ENV]?.trim();
  const defaultRoute = rawDefault ? parseAgentHubRouteString(rawDefault) : undefined;
  return {
    url: rawUrl.replace(/\/+$/, ""),
    token,
    ...(defaultRoute ? { defaultRoute } : {}),
  } satisfies AgentHubGatewayConfig;
});

/** Session keys namespaced so they can never collide with agent-hub's own UUIDs. */
export function agentHubThreadSessionKey(threadId: string): string {
  return `t3-${threadId}`;
}

export function agentHubInstanceSessionKey(instanceId: string): string {
  return `t3-instance-${instanceId}`;
}

/**
 * Env overrides pointing a spawned `claude` at the gateway. The auth token
 * is a placeholder — the gateway strips it and substitutes the real
 * upstream key; it only exists so the CLI has a credential to send and
 * skips its interactive-login path. ANTHROPIC_API_KEY is emptied so a
 * cached Anthropic login can't win over the gateway.
 */
export function agentHubSessionEnv(
  config: AgentHubGatewayConfig,
  sessionKey: string,
): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: `${config.url}/s/${sessionKey}`,
    ANTHROPIC_AUTH_TOKEN: "agent-hub-gateway",
    ANTHROPIC_API_KEY: "",
  };
}

interface CatalogCacheEntry {
  readonly expiresAt: number;
  readonly providers: ReadonlyArray<AgentHubCatalogProvider>;
}

const catalogCache = new Map<string, CatalogCacheEntry>();

interface GatewayCatalogWire {
  providers?: Array<{
    provider?: { id?: string; display?: string };
    models?: Array<{ id?: string; displayName?: string }> | null;
  }>;
}

const executeGatewayRequest = Effect.fn("executeGatewayRequest")(function* (
  client: HttpClient.HttpClient,
  config: AgentHubGatewayConfig,
  request: HttpClientRequest.HttpClientRequest,
  detail: string,
) {
  const response = yield* client
    .execute(request.pipe(HttpClientRequest.setHeader("x-internal-token", config.token)))
    .pipe(
      Effect.timeout(GATEWAY_REQUEST_TIMEOUT_MS),
      Effect.mapError(
        (cause) =>
          new AgentHubGatewayError({
            detail: `${detail} (${config.url}): ${cause instanceof Error ? cause.message : String(cause)}`,
            cause,
          }),
      ),
    );
  if (response.status < 200 || response.status >= 300) {
    return yield* new AgentHubGatewayError({
      detail: `${detail} (${config.url}): gateway responded ${response.status}`,
    });
  }
  return response;
});

/** Provider×model catalog from the gateway, cached briefly per gateway URL. */
export const fetchAgentHubCatalog = Effect.fn("fetchAgentHubCatalog")(function* (
  client: HttpClient.HttpClient,
  config: AgentHubGatewayConfig,
) {
  const now = yield* Clock.currentTimeMillis;
  const cached = catalogCache.get(config.url);
  if (cached && cached.expiresAt > now) return cached.providers;

  const response = yield* executeGatewayRequest(
    client,
    config,
    HttpClientRequest.get(`${config.url}/internal/providers`),
    "Failed to fetch agent-hub provider catalog",
  );
  const raw = (yield* response.json.pipe(
    Effect.mapError(
      (cause) =>
        new AgentHubGatewayError({
          detail: `Failed to parse agent-hub provider catalog (${config.url})`,
          cause,
        }),
    ),
  )) as GatewayCatalogWire;

  const providers: AgentHubCatalogProvider[] = [];
  for (const entry of raw.providers ?? []) {
    const id = entry.provider?.id;
    if (!id) continue;
    const models: AgentHubCatalogModel[] = [];
    for (const model of entry.models ?? []) {
      if (!model?.id) continue;
      models.push({
        id: model.id,
        ...(model.displayName && model.displayName !== model.id
          ? { displayName: model.displayName }
          : {}),
      });
    }
    providers.push({
      id,
      ...(entry.provider?.display ? { display: entry.provider.display } : {}),
      models,
    });
  }

  catalogCache.set(config.url, { expiresAt: now + CATALOG_TTL_MS, providers });
  return providers as ReadonlyArray<AgentHubCatalogProvider>;
});

/** Strict parse: `<provider>/<model>` must exist in the catalog. */
export function resolveAgentHubRouteForModel(
  model: string,
  providers: ReadonlyArray<AgentHubCatalogProvider>,
): AgentHubRoute | undefined {
  const parsed = parseAgentHubRouteString(model);
  if (!parsed) return undefined;
  const provider = providers.find((p) => p.id === parsed.provider);
  if (!provider) return undefined;
  if (!provider.models.some((m) => m.id === parsed.model)) return undefined;
  return parsed;
}

export function resolveAgentHubDefaultRoute(
  config: AgentHubGatewayConfig,
  providers: ReadonlyArray<AgentHubCatalogProvider>,
): AgentHubRoute | undefined {
  if (config.defaultRoute) return config.defaultRoute;
  const first = providers.find((p) => p.models.length > 0);
  const firstModel = first?.models[0];
  return first && firstModel ? { provider: first.id, model: firstModel.id } : undefined;
}

/**
 * Idempotent route upsert. `ensure` makes the gateway create the sessions
 * row when the key is new (t3code owns its own thread lifecycle, so the
 * gateway has never seen these ids).
 */
export const ensureAgentHubRoute = Effect.fn("ensureAgentHubRoute")(function* (
  client: HttpClient.HttpClient,
  config: AgentHubGatewayConfig,
  sessionKey: string,
  route: AgentHubRoute,
  meta?: { readonly workspacePath?: string },
) {
  yield* executeGatewayRequest(
    client,
    config,
    HttpClientRequest.put(`${config.url}/internal/routes/${encodeURIComponent(sessionKey)}`).pipe(
      HttpClientRequest.setBody(
        HttpBody.jsonUnsafe({
          provider: route.provider,
          model: route.model,
          ensure: {
            engine: "claude-code",
            workspace_path: meta?.workspacePath ?? "",
            claude_config_dir: "",
          },
        }),
      ),
    ),
    `Failed to set agent-hub route for ${sessionKey}`,
  );
});

/** Picker entries for the gateway matrix: slug `<provider>/<model>`. */
export function agentHubGatewayModels(
  providers: ReadonlyArray<AgentHubCatalogProvider>,
  capabilities: ModelCapabilities,
): ReadonlyArray<ServerProviderModel> {
  const models: ServerProviderModel[] = [];
  for (const provider of providers) {
    for (const model of provider.models) {
      models.push({
        slug: `${provider.id}/${model.id}`,
        name: model.displayName ?? model.id,
        subProvider: provider.display ?? provider.id,
        isCustom: true,
        capabilities,
      });
    }
  }
  return models;
}
