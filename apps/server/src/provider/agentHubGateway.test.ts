import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  agentHubAdapterHooks,
  agentHubGatewayModels,
  agentHubInstanceSessionKey,
  agentHubSessionEnv,
  agentHubThreadSessionKey,
  parseAgentHubRouteString,
  readAgentHubGatewayConfig,
  resolveAgentHubDefaultRoute,
  resolveAgentHubRouteForModel,
  type AgentHubCatalogProvider,
} from "./agentHubGateway.ts";
import { getClaudeModelCapabilities } from "./Layers/ClaudeProvider.ts";

const CATALOG: ReadonlyArray<AgentHubCatalogProvider> = [
  { id: "empty", display: "Empty", models: [] },
  {
    id: "zenmux",
    display: "ZenMux",
    models: [
      { id: "anthropic/claude-fable-5-free", displayName: "Claude Fable 5 (Free)" },
      { id: "anthropic/claude-sonnet-5" },
    ],
  },
  { id: "zcode", models: [{ id: "glm-4.7" }] },
];

describe("parseAgentHubRouteString", () => {
  it("splits provider/model at the first slash, keeping slashes in the model id", () => {
    expect(parseAgentHubRouteString("zenmux/anthropic/claude-sonnet-5")).toEqual({
      provider: "zenmux",
      model: "anthropic/claude-sonnet-5",
    });
    expect(parseAgentHubRouteString("zcode/glm-4.7")).toEqual({
      provider: "zcode",
      model: "glm-4.7",
    });
  });

  it("rejects slugs without both halves", () => {
    expect(parseAgentHubRouteString("claude-sonnet-5")).toBeUndefined();
    expect(parseAgentHubRouteString("/glm-4.7")).toBeUndefined();
    expect(parseAgentHubRouteString("zcode/")).toBeUndefined();
  });
});

describe("resolveAgentHubRouteForModel", () => {
  it("resolves only slugs present in the catalog", () => {
    expect(resolveAgentHubRouteForModel("zcode/glm-4.7", CATALOG)).toEqual({
      provider: "zcode",
      model: "glm-4.7",
    });
    expect(resolveAgentHubRouteForModel("zcode/glm-999", CATALOG)).toBeUndefined();
    expect(resolveAgentHubRouteForModel("nope/glm-4.7", CATALOG)).toBeUndefined();
    // Built-in Claude model slugs are not matrix slugs and must not route.
    expect(resolveAgentHubRouteForModel("claude-sonnet-5", CATALOG)).toBeUndefined();
  });
});

describe("resolveAgentHubDefaultRoute", () => {
  const config = { url: "http://127.0.0.1:8484", token: "t" };

  it("prefers the configured default route", () => {
    expect(
      resolveAgentHubDefaultRoute(
        { ...config, defaultRoute: { provider: "zcode", model: "glm-4.7" } },
        CATALOG,
      ),
    ).toEqual({ provider: "zcode", model: "glm-4.7" });
  });

  it("falls back to the first provider that has models", () => {
    expect(resolveAgentHubDefaultRoute(config, CATALOG)).toEqual({
      provider: "zenmux",
      model: "anthropic/claude-fable-5-free",
    });
    expect(resolveAgentHubDefaultRoute(config, [])).toBeUndefined();
  });
});

describe("agentHubGatewayModels", () => {
  it("maps the catalog to picker models with provider-prefixed slugs", () => {
    const models = agentHubGatewayModels(CATALOG, getClaudeModelCapabilities(undefined));
    expect(models.map((m) => m.slug)).toEqual([
      "zenmux/anthropic/claude-fable-5-free",
      "zenmux/anthropic/claude-sonnet-5",
      "zcode/glm-4.7",
    ]);
    const fable = models[0]!;
    expect(fable.name).toBe("Claude Fable 5 (Free)");
    expect(fable.subProvider).toBe("ZenMux");
    expect(fable.isCustom).toBe(true);
    // Providers without a display name fall back to the id for grouping.
    expect(models[2]!.subProvider).toBe("zcode");
    // Models without a displayName keep the raw id as their name.
    expect(models[1]!.name).toBe("anthropic/claude-sonnet-5");
  });
});

describe("session env + keys", () => {
  it("namespaces session keys and overrides the Anthropic env triple", () => {
    expect(agentHubThreadSessionKey("abc")).toBe("t3-abc");
    expect(agentHubInstanceSessionKey("claude_hub")).toBe("t3-instance-claude_hub");
    expect(agentHubSessionEnv({ url: "http://gw:1", token: "t" }, "t3-abc")).toEqual({
      ANTHROPIC_BASE_URL: "http://gw:1/s/t3-abc",
      ANTHROPIC_AUTH_TOKEN: "agent-hub-gateway",
      ANTHROPIC_API_KEY: "",
    });
  });
});

describe("agentHubAdapterHooks without opt-in", () => {
  it("is fully inert", () => {
    const hooks = agentHubAdapterHooks(undefined);
    const base = { HOME: "/tmp/x" };
    expect(hooks.env("thread-1", base)).toBe(base);
  });
});

it.layer(NodeServices.layer)("readAgentHubGatewayConfig", (it) => {
  it.effect("returns undefined without the marker variable", () =>
    Effect.gen(function* () {
      expect(yield* readAgentHubGatewayConfig({})).toBeUndefined();
      expect(yield* readAgentHubGatewayConfig(undefined)).toBeUndefined();
    }),
  );

  it.effect("builds config from marker + explicit token, trimming and parsing extras", () =>
    Effect.gen(function* () {
      const config = yield* readAgentHubGatewayConfig({
        AGENT_HUB_GATEWAY_URL: "http://127.0.0.1:8484/",
        AGENT_HUB_GATEWAY_TOKEN: "secret",
        AGENT_HUB_DEFAULT_ROUTE: "zcode/glm-4.7",
      });
      expect(config).toEqual({
        url: "http://127.0.0.1:8484",
        token: "secret",
        defaultRoute: { provider: "zcode", model: "glm-4.7" },
      });
    }),
  );
});
