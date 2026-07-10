# agent-hub fork notes

This branch (`agent-hub-multiprovider`) is agent-hub's t3code fork. Since
2026-07-10 it carries exactly **two** deltas over upstream:

1. **Thread fork / edit-and-resend** — event-sourced thread forking that
   also forks the Claude provider session (the agent's memory), plus an
   "edit & resend" action. User guide: [thread-history](../user/thread-history.md).
2. **A separate desktop identity** — the packaged app is "Agent Hub Code"
   and shares no state with a canonical t3code install (details below).

The original reason for the fork — the agent-hub **gateway multiprovider
integration** — was removed on 2026-07-10: canonical t3code now handles
multi-vendor models natively, so the per-session routing gateway is no
longer needed here. The full wiring survives in git history if it is ever
wanted again: added in `ee0333a40`, decoupled behind seams in `14086c975`,
removed in the commit that rewrote this file. The agent-hub repo still
ships the gateway itself (route A); this branch just no longer uses it.

## Code layout & upstream seams

Every fork change is anchored so upstream rebases stay mechanical:

| Anchor          | Scope                                                                                                                                                                                                                                                                              |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[thread-fork]` | Fork/edit feature. Hook lines in `apps/server/src/server.ts`, `provider/Layers/ClaudeAdapter.ts` (resume cursor: `forkSession`, `turnAnchors`), `packages/client-runtime` (command plumbing), `apps/web/src/components/ChatView.tsx` + `chat/MessagesTimeline.tsx` (hover actions) |
| `[agent-hub]`   | Desktop identity fork only (rebrand + state decoupling) — `apps/desktop/*`, `scripts/build-desktop-artifact.ts`, `scripts/lib/brand-assets.ts`                                                                                                                                     |

Wholly new files (never conflict): `orchestration/Layers/ThreadForkProjection.ts`,
`orchestration/Layers/ThreadForkReactor.ts`, `orchestration/Services/ThreadForkReactor.ts`,
plus additive command/event entries in `packages/contracts/src/orchestration.ts`
and a `thread.fork` case in `orchestration/decider.ts`.

Audit after any upstream sync:

```sh
grep -rn '\[thread-fork\]' apps packages
grep -rn '\[agent-hub\]' apps scripts
```

## Rebasing onto upstream t3code

1. `git fetch origin && git rebase origin/main`.
2. Conflicts can only occur on the anchored hook lines — re-apply them
   around the moved code; the new files never conflict.
3. Re-verify: the greps above; `pnpm --dir apps/server run typecheck`;
   `vp test run ClaudeAdapter ThreadFork OrchestrationReactor` from
   `apps/server`; fork a thread in the UI and check the new thread replays
   history and remembers pre-fork context.

## Running & packaging (this network / machine)

Dev stack (server :13773 + web :5733; pair via the URL the server logs):

```sh
# once: deps — the default npm registry here (mirrors.tencent.com) is
# flaky for some tarballs; pin the official one
ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --registry=https://registry.npmjs.org/

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

Build via `bun run` / pnpm scripts, not bare `node` — the artifact script
shells out to `vp`, which only resolves from `node_modules/.bin`
(`spawn vp ENOENT` otherwise).

## Desktop identity on this branch

This branch's desktop build is rebranded **Agent Hub Code** and is fully
state-decoupled from a canonical t3code install — both apps can be
installed and **run at the same time** without touching each other:

| Surface                  | canonical t3code               | this fork                              |
| ------------------------ | ------------------------------ | -------------------------------------- |
| Bundle / Launch Services | `com.t3tools.t3code`           | `com.agenthub.code`                    |
| Server state root        | `~/.t3` (`T3CODE_HOME`)        | `~/.agent-hub-code`                    |
| Electron userData        | `…/Application Support/t3code` | `…/Application Support/agent-hub-code` |
| Keychain item            | "t3code Safe Storage"          | "Agent Hub Code Safe Storage"          |
| OS URL scheme            | `t3code://`                    | `agent-hub-code://`                    |
| Backend port             | scans up from 3773             | same scan — first free port wins       |

Where each knob lives (all hooks carry the `[agent-hub]` anchor):

- `apps/desktop/package.json` `productName: "Agent Hub Code"`
- `scripts/build-desktop-artifact.ts` `DESKTOP_APP_ID: com.agenthub.code`,
  artifact `Agent-Hub-Code-<version>-<arch>.dmg`, stage `package.json`
  `name`/`productName` (Electron `app.name` — this names the Chromium
  keychain item), `protocols` (the OS scheme claim)
- `apps/desktop/src/app/DesktopEnvironment.ts` `APP_BASE_NAME` (in-app
  name), `FORK_STATE_DIR_NAME` (server state root fallback),
  `FORK_USER_DATA_DIR_NAME` (Chromium profile dir)
- `scripts/lib/brand-assets.ts` `productionMacIconPng` →
  `assets/prod/agent-hub-macos-1024.png` — the minimalist hub mark (ink
  squircle, white hub-and-spokes, one accent-blue node)

The dev stack is deliberately **not** moved: dev-runner exports
`T3CODE_HOME=~/.t3`, so dev state stays in `~/.t3/dev`; only the packaged
fork reaches the `~/.agent-hub-code` fallback. The in-process renderer
scheme (`t3code://app`) is per-app and unchanged — only the OS-level
registration is forked, and nothing handles `open-url` today.

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

Keychain note: the fork creates its own "Agent Hub Code Safe Storage" item
silently on first launch, but ad-hoc signed builds get a new code signature
every rebuild, so macOS re-prompts keychain access after each reinstall
unless you pick "Always Allow".
