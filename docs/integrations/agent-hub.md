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

## Running & packaging (this network / machine)

Dev stack (server :13773 + web :5733; pair via the URL the server logs):

```sh
# once: deps — the default npm registry here (mirrors.tencent.com) is
# flaky for some tarballs; pin the official one
ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --registry=https://registry.npmjs.org/

# every session: the gateway first, from the agent-hub repo root
bun run packages/gateway/src/index.ts

bun run dev
```

Desktop app (arm64 dmg). electron-builder downloads a 116 MB electron zip
plus a dmg-builder bundle at build time; from this network both direct
GitHub and npmmirror's CDN abort on the multi-part download, so serve them
from a local one-shot mirror (the layout electron-builder expects is
`{mirror}/v<ver>/<zip>` and `{mirror}/dmg-builder@<ver>/<bundle>`):

```sh
# once: electron runtime for apps/desktop (skipped at install time);
# install.js's single-stream download DOES survive npmmirror
cd apps/desktop/node_modules/electron && \
  ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" node install.js

# once: stage a local mirror from the cache install.js just filled
MIR=/tmp/electron-mirror
mkdir -p "$MIR/v41.5.0" "$MIR/dmg-builder@1.2.0"
cp ~/Library/Caches/electron/*/electron-v41.5.0-darwin-arm64.zip "$MIR/v41.5.0/"
curl -sL -o "$MIR/dmg-builder@1.2.0/dmgbuild-bundle-arm64-75c8a6c.tar.gz" \
  "https://npmmirror.com/mirrors/electron-builder-binaries/dmg-builder@1.2.0/dmgbuild-bundle-arm64-75c8a6c.tar.gz"
(cd "$MIR" && python3 -m http.server 8099 --bind 127.0.0.1 &)

ELECTRON_MIRROR="http://127.0.0.1:8099/" bun run dist:desktop:dmg:arm64
```

The packaged app runs its own server against the _default_ `~/.t3`
userdata (not the dev state in `~/.t3/dev`), so the gateway-flagged
provider instance must be configured there too, and the agent-hub gateway
must be running before threads use gateway models.

## Desktop identity on this branch

This branch's desktop build is rebranded **Agent Hub Code** so it installs
and runs alongside the official T3 Code (Alpha) without colliding on
Launch Services, the Electron single-instance lock, or
`~/Library/Application Support` (all keyed off the product name / appId):

- `apps/desktop/package.json` `productName: "Agent Hub Code"`
- `scripts/build-desktop-artifact.ts` `DESKTOP_APP_ID: com.agenthub.code`,
  artifact `Agent-Hub-Code-<version>-<arch>.dmg`
- `apps/desktop/src/app/DesktopEnvironment.ts` `APP_BASE_NAME` (in-app name)
- `scripts/lib/brand-assets.ts` `productionMacIconPng` →
  `assets/prod/agent-hub-macos-1024.png` — the minimalist hub mark (ink
  squircle, white hub-and-spokes, one accent-blue node)

All hooks carry the `[agent-hub] rebrand` anchor.

### App icon: change the right file

The mac icon has **one** real source: the 1024×1024 PNG named by
`brand-assets.ts` `productionMacIconPng`. At build time
`scripts/build-desktop-artifact.ts` (`stageMacIcons`) turns it into **both**
the bundle `icon.icns` **and** the asar's `resources/icon.png`. Editing
`apps/desktop/resources/icon.{icns,png}` in the repo does nothing — those are
regenerated into the build stage and overwritten. Regenerate the master with
`assets/prod/agent-hub-icon.gen.swift` instead (it renders an iconset; its
`icon_512x512@2x.png` is the committed 1024 master).

The runtime gotcha behind that: on macOS `DesktopAppIdentity.configure`
calls `app.dock.setIcon(iconPaths.png)`, resolving `icon.png` from
`resolveResourcePathCandidates` — first hit is **inside the asar**
(`app.asar/resources/icon.png`), which overrides the bundle `.icns` a
moment after launch. So a bundle-icns-only change makes the correct icon
flash and then revert to whatever PNG is packed in the asar. Both must come
from the same brand PNG, which is why the single-source pipeline matters.

Install: build the app (a plain `--target dir --keep-stage` build is enough;
the `.app` lands in the kept temp stage under
`$TMPDIR/t3code-desktop-mac-stage-*/app/dist/mac-arm64/`) and `ditto` it into
/Applications (no quarantine attr on a local build). A full dmg is only
needed for distribution.

One caveat both apps share: the **server** state dir is `~/.t3` regardless
of the Electron identity, so threads/projects/settings are common. Don't
run both apps at the same time, and note the official build shows a
gateway-flagged Claude instance as a plain erroring one (it lacks the
integration code).
