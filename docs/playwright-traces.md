# Working with Playwright traces — technical reference

This document explains how this app reads Playwright `.zip` trace files and how the
DOM snapshot viewer renders pixel-exact page state. Read this before touching any code
under `src/trace/`, `src/ui/VisitDetail.tsx`, `src/main.tsx`, or `public/sw.bundle.js`.

There are **two independent subsystems**:

1. **Trace parsing** — turns the raw `.zip` into typed data the UI can render
   (`src/trace/*`).
2. **DOM snapshot viewer** — renders an exact HTML reproduction of a page at a given
   action, via a service worker (`public/sw.bundle.js` + the `/snapshot/…` iframe
   contract).

They only share one piece of state: the trace's blob URL (`LoadedTrace.traceUrl`).

---

## 1. Anatomy of a Playwright trace `.zip`

A trace recorded by `context.tracing.start/stop` (or Playwright Test's `trace: 'on'`)
is a zip archive containing:

| Entry | Contents |
|---|---|
| `trace.trace`, `trace-chunk1.trace`, … | JSONL files, one JSON event per line. Multiple chunks occur for long tests; `parser.ts` sorts them with `compareTraceChunkOrder` (base chunk first, then `-chunk{N}` ascending). |
| `trace.network`, … | JSONL files of `resource-snapshot` events wrapping HAR entries (network requests/responses). |
| `resources/<sha1>` | Binary blobs referenced by hash — screenshots (JPEG/PNG), snapshot resources, etc. |

**Never assume a single `.trace` file** — always merge all chunks in order before
processing events; call ordering matters (before/after pairing, action tree parenting).

### Event types (in `.trace` files)

All raw event shapes are declared in [src/trace/contracts.ts](../src/trace/contracts.ts).
The ones that matter for feature work:

- `context-options` — one per trace, has `browserName`, `sdkLanguage`, `wallTime`,
  `monotonicTime`, `title`. Stripped out of the event stream after extraction (it's
  metadata, not a UI action).
- `before` / `input` / `after` — the three-phase lifecycle of one action, joined by
  `callId`. `before.beforeSnapshot`, `input.inputSnapshot`, `after.afterSnapshot` are
  **snapshot names** (strings), not payloads — see §3.
- `log` — free-text log lines attached to a `callId`.
- `event` — generic page/frame lifecycle event (`class`/`method`/`params`), used to
  detect navigations (e.g. `Page.navigatedWithinDocument` for SPA route changes).
- `console` — console messages, scoped to the visit active at `time`.
- `screencast-frame` — a screenshot JPEG identified by `sha1` (resolved via
  `resources/<sha1>` → blob URL). Used as a fallback when no DOM snapshot exists for
  an action.
- `frame-snapshot` — **large payload, HTML stripped during parsing**. Only
  `callId`, `phase` (`before`/`input`/`after`), `frameUrl`, `frameId`, `pageId`,
  `isMainFrame`, `timestamp` are kept (`FrameSnapshotInfo`). The actual HTML is later
  re-read from the zip by the service worker, not by the app.

### Snapshot names

A snapshot name looks like `before@<callId>`, `input@<callId>`, `after@<callId>` (see
`parseSnapshotPhase` in [src/trace/parser.ts](../src/trace/parser.ts)). The app never
parses the HTML itself — it just needs to know *which name* to ask the service worker
for.

---

## 2. Parsing pipeline (strict layers, no circular deps)

```
File (.zip)
  → parser.ts        parseTraceFile(file): Promise<ParsedTrace>
  → journeyBuilder.ts buildJourney(parsed): TraceJourney
  → routeGraph.ts     buildRouteGraph(traces: LoadedTrace[]): RouteGraph   (multi-trace merge)
  → UI components
```

- **`src/trace/parser.ts`** — unzips with JSZip, parses all `.trace`/`.network` JSONL
  files, extracts `resources/*` as blob URLs, separates out `context-options` and
  frame-snapshot metadata. Has **zero knowledge of URL visits** — output is just typed
  raw events (`ParsedTrace`).
- **`src/trace/journeyBuilder.ts`** — the real logic:
  - `mergeActionEvents` joins `before`/`input`/`after`/`log` by `callId` into `Action`
    objects, using `buildSnapshotInfoMap` (built from main-frame `frame-snapshot`
    events only — `isMainFrame` filters out iframes) to attach `currentUrl`,
    `navigationTargetUrl`, and `actionPageTime` (the pre-navigation timestamp — prefers
    `inputTime`, falls back to `beforeTime`; this is what fixed the
    screenshot/action mismatch).
  - `buildActionTree` nests actions by `parentId` (step grouping).
  - `detectNavigations` scans `event` records for frame navigations (including SPA
    `navigatedWithinDocument`) to split the trace into `UrlVisit`s.
  - Console messages, screencasts, and network entries are each assigned to the
    `UrlVisit` that was active at their timestamp.
- **`src/trace/routeGraph.ts`** — has no knowledge of individual events; only consumes
  `LoadedTrace[]` (already-built journeys) to merge multiple traces into one graph of
  routes (nodes keyed by `origin + pathname`).

**Rule:** if you're fixing something about *what an action means* or *how visits are
split*, the fix belongs in `journeyBuilder.ts`. If it's about *raw zip/JSONL reading*,
it belongs in `parser.ts`. Never let `parser.ts` reach into visit/action semantics, and
never let `routeGraph.ts` reach into raw events.

---

## 3. DOM snapshot viewer

### Why it exists

Screencast frames (`screencast-frame` events) are lossy JPEG approximations sampled at
an interval — they don't line up exactly with a given action and don't reflect DOM
state precisely. Playwright trace zips also embed **exact DOM snapshots** (serialized
HTML + inlined resource references) for the `before`/`input`/`after` phase of actions
that were snapshotted. Rendering those exactly (instead of re-deriving screenshots) is
what `public/sw.bundle.js` is for — it's Playwright's own snapshot renderer, the same
code that powers `npx playwright show-trace`.

### `public/sw.bundle.js` — do not edit, do not inline

- This is a **third-party bundled artifact** (Apache-2.0, from Playwright's trace
  viewer). It is minified and should be treated as a black box — **never copy its
  contents into another file or hand-edit it**. If it needs to be updated, replace the
  whole file with a newer build from the `playwright-core` package.
- It is registered once, at app startup, in
  [src/main.tsx](../src/main.tsx):
  ```
  navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.bundle.js`)
  ```
  This gives it scope over the app's base path (`/` locally, `/<repo>/` on GitHub
  Pages), which is required because it intercepts `{BASE_URL}snapshot/…` requests
  issued by the app's own iframes. The SW strips its own scope path before matching,
  so it works under any base path — but never use root-absolute URLs (`/snapshot/…`).

### The `/snapshot/…` contract

The only integration surface between the app and the service worker is this URL,
built in [src/ui/VisitDetail.tsx](../src/ui/VisitDetail.tsx) (`snapshotIframeUrl`):

```
{BASE_URL}snapshot/{pageId}?name={encodeURIComponent(snapshotName)}&trace={encodeURIComponent(traceUrl)}
```

- **`pageId`** — `Action.pageId`, identifies which page/tab within the trace context
  the snapshot belongs to.
- **`name`** — the snapshot name string (`before@callId` / `input@callId` /
  `after@callId`), picked based on the active phase tab:
  - Before → `beforeSnapshot`
  - Action → `inputSnapshot ?? beforeSnapshot`
  - After → `afterSnapshot ?? inputSnapshot ?? beforeSnapshot`
- **`trace`** — the trace's blob URL (`LoadedTrace.traceUrl`, created once via
  `URL.createObjectURL(file)` when the zip was first loaded in
  [src/App.tsx](../src/App.tsx) `addFiles`). The SW re-fetches and re-unzips the trace
  itself from this blob URL — it does **not** receive parsed data from the app.

Internally (reverse-engineered from the minified bundle, for context only — do not
rely on internals beyond this contract): the SW's `fetch` handler recognizes any path
starting with `/snapshot/`, reads the `trace` query param, loads+caches that zip
in-memory keyed by the blob URL (so repeat requests for the same trace don't re-unzip),
extracts the `pageId` from the path remainder, and calls its own
`snapshotServer.serveSnapshot(pageId, name, url)` to render the stored `frame-snapshot`
HTML (with resources rewritten to `/snapshot/…` resource-loader requests) into a
`Response`.

**Implication:** because the blob URL is the cache key, keeping `LoadedTrace.traceUrl`
stable for the trace's lifetime is required — the blob must stay alive (don't revoke it
until the trace is removed) and must not change identity while the trace is loaded.
`App.tsx` only calls `URL.revokeObjectURL` in `removeTrace`/`handleReset`.

### Iframe wiring

```tsx
<iframe
    key={snapshotIframeUrl + (swReady ? '-r' : '-i')}
    src={snapshotIframeUrl}
    sandbox="allow-scripts allow-same-origin"
    className="action-snapshot-iframe"
/>
```

- `sandbox="allow-scripts allow-same-origin"` — snapshots may contain inline scripts
  from the recorded page; both flags are required for the SW-served document to render
  correctly (same-origin lets it fetch its own `/snapshot/…` sub-resources).
- If `snapshotIframeUrl` is `null` (no snapshot name for the current phase/action),
  the UI falls back to a screencast frame (`findScreenshotForAction`) or shows
  "No preview available".

### Service-worker readiness race condition

On first page load, the browser can finish activating the SW and fire
`controllerchange` **before** `VisitDetail` mounts and its `useEffect` runs — if you
only listen inside the effect, you can miss the event and the very first snapshot
iframe renders unstyled/broken (served without the SW intercepting it).

Fix, in [src/ui/VisitDetail.tsx](../src/ui/VisitDetail.tsx): a **module-level** promise
(`_swReadyPromise` / `swReadyPromise()`) is created outside the component so it starts
listening for `controllerchange` immediately when the module is evaluated, regardless
of when/if any component instance has mounted yet. `swReady` state is initialized from
`navigator.serviceWorker.controller` and flipped to `true` once the promise resolves.
The iframe's `key` includes a `-r`/`-i` suffix tied to `swReady` so React force-remounts
the iframe exactly once the SW takes control — guaranteeing the retried request goes
through the SW.

**If you touch this logic:** keep the promise module-level (not component state), and
keep the key-suffix remount trick — removing either reintroduces the first-load bug.

---

## 4. Checklist — working with traces / snapshots

- **Reading a new raw event type from the trace?** → add the type to
  [src/trace/contracts.ts](../src/trace/contracts.ts), parse it in
  [src/trace/parser.ts](../src/trace/parser.ts) (or filter in `journeyBuilder.ts` if it's
  already part of `events[]`).
- **Changing how actions/visits are derived?** → `src/trace/journeyBuilder.ts` only.
- **Need the exact DOM state for something new?** → don't re-derive it; reuse the
  `/snapshot/{pageId}?name=…&trace=…` contract with the appropriate `Action.*Snapshot`
  name — do not attempt to parse `frame-snapshot` HTML in the app.
- **Debugging a blank/broken snapshot iframe:**
  1. Confirm `navigator.serviceWorker.controller` is set (SW race — see §3).
  2. Confirm the action actually has a snapshot name for the selected phase
     (`beforeSnapshot`/`inputSnapshot`/`afterSnapshot` — tabs are disabled when absent).
  3. Confirm `traceUrl` (blob URL) hasn't been revoked (trace still in `traces[]`).
  4. Confirm `pageId` is present on the action (missing `pageId` → no iframe).
- **Never**: hand-edit or paste `public/sw.bundle.js` contents elsewhere; assume a
  single `.trace` chunk; parse `frame-snapshot` HTML yourself; revoke a trace's blob
  URL while it's still in `traces[]`.
