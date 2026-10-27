# Playwright Trace URL Overview — Copilot Instructions

## What this app does

A single-page React application that lets QA engineers and developers load one or more
Playwright `.zip` trace files and explore which URLs were visited, in what order, and
with what results — as an interactive directed route graph rather than a flat timeline.

---

## Tech stack

| Concern | Library / tool |
|---------|---------------|
| UI framework | React 18 (no class components, hooks only) |
| Language | TypeScript 5 (strict), `.tsx` for components |
| Build | Vite 8 + `@vitejs/plugin-react` |
| Type-check | `tsc -b` (run before vite build in the `build` script) |
| Styling | Single global `src/App.css` with CSS custom properties (no CSS-in-JS, no modules) |
| Graph rendering | `@xyflow/react` 12 (React Flow) |
| Graph layout | Custom BFS-depth auto-layout + user-dragged positions (`dagre` is still a dependency but unused) |
| Trace zip parsing / screenshot zips | `jszip` 3 |
| DOM snapshots | Playwright service worker at `public/sw.bundle.js` — intercepts `{BASE_URL}snapshot/…` |
| Hosting | GitHub Pages, deployed by `.github/workflows/deploy.yml` |

Deep-dive on trace parsing and the snapshot service worker: `docs/playwright-traces.md`.

---

## Source layout

```
src/
  main.tsx              React entry point, mounts <App />
  App.tsx               Root component — owns all top-level state
  App.css               All styles (global, single file, CSS custom properties)

  trace/                Pure TypeScript, zero React dependency
    contracts.ts        All shared interfaces / types (no logic)
    parser.ts           Unzips .zip, parses .trace/.network JSONL → ParsedTrace
    journeyBuilder.ts   Converts ParsedTrace → TraceJourney (visits, actions, etc.)
    bundle.ts           expandTraceBundles — a .zip with no .trace files but nested .zip files is replaced
                        by those nested zips (File objects); name collisions keep the path (`/` → `_`).
                        Applied in App.addFiles before parsing.
    routeGraph.ts       Merges multiple LoadedTrace journeys → RouteGraph
    index.ts            Re-exports public trace API

  ui/                   React components and UI helpers
    TraceUpload.tsx     Drop-zone / file picker (accepts multiple .zip files, including a zip of trace zips)
    TraceSwitcher.tsx   Header dropdown: switch active trace, remove traces, "+ Add trace"
    RouteGraphView.tsx  React Flow canvas — draggable nodes/groups, grid snap, view toolbar, minimap
    RouteNodeCard.tsx   Custom React Flow node (RouteNodeCard) and group box (OriginGroupNode)
    graphLayout.ts      autoLayout / resolvePositions / buildFlowElements — RouteGraph → React Flow nodes/edges
    layoutShared.ts     Shared layout primitives (grid + size constants, types, computeDepths, buildEdges, routeData)
    TraceFlowView.tsx   Read-only React Flow canvas: the active trace's visits as one left-to-right row
    TraceStepCard.tsx   Custom React Flow node for one trace-flow step (preview + per-action filmstrip)
    flowLayout.ts       buildTraceFlowElements — LoadedTrace + RouteGraph → trace-flow nodes/edges
    viewStore.ts        Named route-map views (positions per nodeId) — localStorage, export/import JSON
    collection.ts       Screenshot collection types, localStorage persistence, React context, FocusRequest
    ScreenshotCollection.tsx  Right-side drawer listing collected screenshots + zip download
    NodeDetail.tsx      Detail pane for a selected route node (sticky header: trace dropdown, prev/next nav)
    VisitDetail.tsx     Per-visit detail column (preview: screenshots carousel / DOM snapshot, actions)
    ActionList.tsx      Recursive collapsible action tree
    ActionDetail.tsx    (unused) Call / log / network tabs for a selected action
    utils.ts            Pure helpers: URL parsing, duration formatting, color palette, downloads
```

---

## Core data model (`src/trace/contracts.ts`)

```
File → ParsedTrace
  events[]               Raw JSONL events (before/input/after/log/console/screencast-frame/…)
  networkEvents[]        HAR entries from .network files
  frameSnapshots[]       Lightweight snapshot metadata (URL + timestamps, HTML stripped)
  resources              Map<sha1, blobUrl>  — screenshots and other binary blobs
  contextInfo?           Browser name, SDK language, title

ParsedTrace → TraceJourney
  visits[]               Chronological UrlVisit list
  allScreenshots[]       Global sorted screencast frames
  startTime              Monotonic start

UrlVisit
  visitId                Stable unique id
  url                    Full URL
  displayPath            Pathname for display
  startTime / duration
  actions[]              Root Action nodes (recursive children)
  networkRequests[]      HAR entries scoped to this visit
  consoleMessages[]      Console events scoped to this visit
  screenshots[]          Screencast frames scoped to this visit
                         (ScreenshotEntry = { url: blob URL, sha1, timestamp }; sha1 is stable across reloads)
  hasErrors              True if any action had an error

Action
  callId                 Matches before/input/after events
  class / method / title
  params / result / error
  beforeSnapshot?        Snapshot name for the DOM state before the action
  inputSnapshot?         Snapshot name at input time
  afterSnapshot?         Snapshot name after the action
  currentUrl?            URL at action time
  navigationTargetUrl?   URL navigated to (if this was a navigation)
  children[]             Nested child actions (step grouping)

Multiple LoadedTrace → RouteGraph
  nodes[]     RouteNode — one per distinct (origin + pathname), query/hash stripped
              each carries a groupId pointing at its owning RouteGroup
  edges[]     RouteEdge — directed transition between two route nodes
  origins[]   Distinct origins in first-seen order
  groups[]    RouteGroup — one DEFAULT group per origin ({ id = origin, key = '' }) plus
              one CUSTOM group per user-assigned key ({ id = `${origin}#${key}` }).
              `base` is the longest segment prefix shared by ALL the group's routes
              (e.g. "/app/portal/main"); it is folded out of
              node labels.
  tracePaths  Map<traceId, nodeId[]>  — ordered visit sequence per trace

LoadedTrace
  traceId     "trace-0", "trace-1", …  (stable, monotonic)
  fileName    Original .zip file name
  traceUrl    blob: URL of the .zip (passed to the SW for snapshot rendering)
  color       Palette color assigned by load order
  journey     TraceJourney
```

---

## App state (in `App.tsx`)

| State | Type | Purpose |
|-------|------|---------|
| `traces` | `LoadedTrace[]` | All loaded traces in load order |
| `activeTraceId` | `string \| null` | Trace currently highlighted in the graph |
| `selectedNodeId` | `string \| null` | Route node currently open in the detail pane |
| `detailCollapsed` | `boolean` | Whether the right-side details pane is collapsed to a rail |
| `detailWidth` | `number` | Details pane width in px; persisted to `localStorage` (`'detailWidth'`) |
| `collection` | `CollectedShot[]` | Screenshot collection; persisted to `localStorage` (`'screenshotCollection'`) |
| `collectionOpen` | `boolean` | Whether the collection drawer is open |
| `focus` | `FocusRequest \| null` | Request to show a specific trace/visit/screenshot in the details pane |
| `isLoading` | `boolean` | Parsing in progress |
| `loadError` | `string \| null` | Error message from last failed parse |
| `theme` | `'dark' \| 'light'` | Active colour theme; persisted to `localStorage` |
| `viewState` | `ViewState` | Saved route-map views (positions + group assignments); persisted to `localStorage['routeViews']` |
| `mapMode` | `'routes' \| 'flow'` | Graph panel shows the Route map or the Trace flow; persisted to `localStorage['mapMode']` |

`graph` is derived with `useMemo` from `traces` + the active view's `groups`;
`traceColorMap` from `traces`. `viewState` lives in App (not `RouteGraphView`) because group
assignments change the graph; `RouteGraphView` receives it via `viewState` /
`onViewStateChange`. `assignGroup(nodeId, key | null)` updates the active view's `groups`
and drops that route's saved position so it is re-placed next to its new group.

---

## Route graph

**Node key** — `origin + pathname` (query and hash stripped). A node represents all visits
to `/login` regardless of query string variation.

**Route groups & shared base path** — `computeGroups()` in `routeGraph.ts` creates one
**default** `RouteGroup` per origin (`id = origin`) plus one **custom** group per key in the
`groupAssignments` (nodeId → key) passed to `buildRouteGraph(traces, groupAssignments)`
(`id = ${origin}#${key}`; ids are stable across reloads). Default group first, custom groups
sorted by key. `commonBase()` gives each group the longest common segment prefix of ALL its
routes, trimmed to stay strictly shorter than the **deepest** route (`maxLen - 1`) so at
least one route keeps a tail; a route equal to the base renders as `/`. Splitting a route
out therefore **recalculates** the remaining default group's base (e.g. moving
`/app/admin/main/home` out lets the rest share
`/app/portal/main`). The group box header shows the full URL
`origin + base` plus a route count; each node shows only the remaining tail via
`routeData()` in `layoutShared.ts`. No nested sub-family boxes.

**Splitting routes into their own group** — `NodeDetail`'s sticky header has a **Group**
`<select>` listing the groups of the route's origin (`Shared · <base>` for the default, then
custom groups, each with a member count) plus **+ New group from this route** (key = the
route's path; hidden when that group already exists). Picking a custom group joins it (so
other routes of the same app can be added to it); picking the shared group moves it back.
Assignments are stored per view in `RouteView.groups` and included in export/import.

**Auto-layout** — `autoLayout(graph, onlyGroups?, top?)` in `graphLayout.ts` assigns each
node a **column by BFS distance from an entry point** (a route with in-degree 0, which also
covers isolated nodes). `computeDepths()` does a plain BFS from all entry points at once;
nodes only reachable through a cycle fall back to depth 0. Each origin is a **horizontal
band** stacked top-to-bottom; the global depth is used for columns so they line up across
bands; within a band nodes are sorted alphabetically by path and compact-stacked per
column. This is only the **starting arrangement** — the user can rearrange everything.

**Grid & sizes** — all constants in `layoutShared.ts` are multiples of `GRID = 20`
(`NODE_WIDTH` 260, `NODE_HEIGHT` 220, `GROUP_PADDING` 20, `GROUP_HEADER` 40, gaps). The
`.route-node` CSS width/height MUST match `NODE_WIDTH` / `NODE_HEIGHT`. React Flow runs with
`snapToGrid`, `snapGrid={[GRID, GRID]}` and a dotted `Background` with `gap={GRID}`. Route
labels wrap to at most 2 lines; the tooltip shows the full URL.

**Screenshot previews** — each route card shows a 140 px `.route-node-preview` thumbnail
(top of the page, `object-fit: cover`) above the label. `RouteGraphView` computes
`previewByNode` with `lastRouteScreenshot(node, activeTraceId)` (`utils.ts`): the **last**
screenshot of the **last** visit that has any (page fully loaded by then), preferring the
active trace, then other traces in load order. Passed as `previewUrl` in
`RouteNodeRenderData`; routes without frames show "No screenshot".

**Dragging & derived group boxes** — group boxes are NOT React Flow parents.
`buildFlowElements(graph, positions)` emits route nodes at absolute positions (with explicit
`width`/`height` **and `measured`** — the map is a controlled React Flow that rebuilds node
objects on every move, and without `measured` React Flow 12 drops the handle bounds so edges
vanish and drags log error 015) and derives one `originGroup` node per origin from its members' bounding
box + padding + header (`zIndex: -1` so edges stay visible on top; `dragHandle:
'.origin-group-label'`). The group wrapper has `pointer-events: none` (CSS `!important`
overrides React Flow's inline style) so panning/clicking passes through the box; only the
header label is draggable. In `RouteGraphView`, `handleNodesChange` handles `position`
changes: a route change updates that route; a group change (`id` prefixed with
`GROUP_NODE_PREFIX`) computes the delta from the derived box position and shifts all
members. Live positions are kept in an `overrides` map (+ ref) and committed to the active
view on `onNodeDragStop`. Because boxes are derived, a route can never leave its box and the
box grows/shrinks with its routes. Element selection is disabled (`elementsSelectable={false}`);
selection is `selectedNodeId` via `onNodeClick`.

**Lock** — a padlock `.map-lock-btn` in the top-right of the map toggles `locked` in
`RouteGraphView` (persisted to `localStorage['mapLocked']`). When locked, React Flow gets
`nodesDraggable={false}` (routes and group boxes can't move); clicking, panning and zooming
still work. The view toolbar's `max-width` leaves room for the button.

**Views (saved configurations)** — `viewStore.ts` stores `{ version, activeViewId, views:
[{ id, name, updatedAt, nodes: { [nodeId]: {x, y} }, groups: { [nodeId]: key } }] }` in
`localStorage['routeViews']`
(positions are tiny, so IndexedDB is not needed). Positions are keyed by `nodeId`
(origin + pathname), so loading the same zips again restores the arrangement; positions of
routes not in the current graph are kept. `resolvePositions(graph, saved)` uses saved
positions as-is, appends unknown routes of a partially saved group in a 4-column grid below
that group's routes, and auto-lays-out groups with no saved routes below all existing
content. On drag stop ALL current graph positions are committed (so the arrangement freezes).
The `.view-toolbar` overlay (top-left of the map) has: view `<select>`, **New** (empty →
auto-layout), **Duplicate**, **Rename** (inline input), **Delete** (confirm; last view can't be
deleted), **Reset layout** (drops the loaded routes' positions from the view), **Export**
(`route-view-<name>.json`: `{ version: 1, name, exportedAt, nodes, groups }`) and **Import** (validated
by `parseViewFile`: 5 MB cap, version check, finite numbers / non-empty string keys only, `__proto__` keys skipped;
added as a new view with a unique name). `<ReactFlow key={`${viewId}-${fitNonce}`}>` remounts
on view switch / reset so `fitView` re-runs.

**Group colors** — each group box is given a distinct accent color by its index in
`graph.groups` (so split-off groups stand out from their origin's default group).
`GROUP_COLORS` / `groupColor()` in `src/ui/utils.ts` provides the palette (wraps with
modulo). `buildFlowElements` sets `colorIndex` on `GroupNodeData`; `OriginGroupNode` (in
`RouteNodeCard.tsx`) sets it as the inline
`--group-color` CSS variable. `.origin-group` styles in `App.css` derive the border,
tinted background, and label colors from `--group-color` via `color-mix()`, so the tiles
stay clearly visible and color-coded in both dark and light themes.

**Labels in graph layout** — `routeData()` strips the group base from each node's path
before passing it to React Flow, so the tail after the shared base is what appears on the card.

**Active trace highlighting** — `RouteGraphView.tsx` applies per-render:
- Nodes not on the active trace path get `opacity: 0.45` (`.route-node--dim`)
- Nodes on the path get `border-color: accent` (`.route-node--active`)
- Active-path edges are `animated`, colored, and given a higher `zIndex`
- Each node on the active path shows step-number badge(s) (multiple if back-jumped)
- Dots on each node represent visiting traces (capped at 8, overflow shows `+N`)

---

## Trace flow view

The graph panel header has a segmented **Route map | Trace flow** toggle (`.map-mode-toggle`,
`mapMode` in App). Trace flow (`TraceFlowView.tsx`) shows the **active trace** (header switcher)
as one left-to-right row: one step per `UrlVisit` in chronological order — revisits and
consecutive same-route visits get their own step, nothing loops back.

- `buildTraceFlowElements(trace, graph)` in `flowLayout.ts` maps `journey.visits[i]` to its route
  via `graph.tracePaths.get(traceId)[i]` (one path entry per visit). Node ids are `step-${i}`,
  sizes `FLOW_NODE_WIDTH` 320 × `FLOW_NODE_HEIGHT` 360 (multiples of `GRID`; must match
  `.trace-step` CSS) and every node carries `measured`. Edges are straight, animated, in the
  trace color.
- `TraceStepCard` shows the step number, the route label (group base stripped via `routeData`),
  duration, error dot, a group-color top border, the visit's last frame as preview and a
  `nodrag nowheel` thumbnail grid from `stepScreenshots()` (`utils.ts`): one frame per root
  action (`findScreenshotForAction`), deduped by sha1 and limited to the visit's own frames,
  falling back to the last frame. Clicking a thumbnail also swaps the card's preview to it
  (local `pickedSha1` state, marked `.trace-step-frame--active`). Steps of the selected route get `.trace-step--selected`.
- Clicking a step calls `openVisit` in App (selects the route, expands Details, sets a
  `FocusRequest` without `sha1`); clicking a thumbnail passes its `sha1` so `VisitDetail`
  opens the Screenshots tab on that frame. `FocusRequest.sha1` is optional.
- Read-only: no dragging, no saved views. `<ReactFlow key={traceId}>` re-fits on trace switch;
  the initial `fitView` only covers the first 4 steps so long traces open readable.

---

## DOM snapshot viewer

Playwright embeds DOM snapshots in the trace zip. The service worker at
`public/sw.bundle.js` intercepts requests to `{BASE_URL}snapshot/{pageId}?name=…&trace=…` and
serves the snapshot HTML with all resources inlined.

**SW readiness race condition** — On first page load, `controllerchange` can fire between
the component's first render and when `useEffect` runs. `VisitDetail.tsx` uses a
**module-level promise** (`_swReadyPromise`) to capture the `controllerchange` event
regardless of when the component mounts. The iframe `key` prop includes a `-r` / `-i`
suffix (`swReady ? '-r' : '-i'`) so the iframe remounts exactly once when the SW takes
control, guaranteeing correct rendering.

Snapshot phases: **Before** (`beforeSnapshot`), **Action** (`inputSnapshot ?? before`),
**After** (`afterSnapshot ?? input ?? before`). Phase tabs are disabled when a snapshot
for that phase is absent.

The snapshot viewer tab bar (`ViewerTab` = `'before' | 'action' | 'after' | 'screenshots'`)
starts with a **Screenshots** tab when the visit has screencast frames
(`visit.screenshots`). Selecting it swaps the iframe/screencast area for a
`ScreenshotCarousel` — one frame at a time with prev/next `‹`/`›` buttons (disabled at the
ends), an `n / total` counter, **Download** / **+ Collect** buttons, and click-to-enlarge into
the lightbox. The carousel index (`shotIndex`) is controlled by `VisitDetail`; on visit change
it opens the Screenshots tab on the **last** frame (falls back to `'action'` when the visit has
no frames). Clicking an action while on the Screenshots tab jumps the carousel to that
action's frame (`findScreenshotForAction`, matched by sha1). The lightbox (holds a
`ScreenshotEntry`) and the screencast fallback also show Download / Collect buttons
(`ScreenshotActions`). Downloads use `downloadScreenshot()` in `utils.ts`
(`<trace>_<route>_<offset>ms.<ext>`).

---

## Theming (dark / light mode)

The app supports a **dark** (default) and **light** colour theme, toggled via a button in
the app header (and a floating button on the upload screen).

- All colours are driven by CSS custom properties on `:root` in `App.css`. Light mode is a
  full override block `:root[data-theme='light'] { … }` that redefines the same tokens.
- `App.tsx` holds `theme` state, initialised from `localStorage` (`'theme'` key, default
  `'dark'`). A `useEffect` writes `document.documentElement.dataset.theme` and persists the
  value, so the choice survives reloads.
- `toggleTheme` flips between the two themes; the header button shows ☀ (in dark mode) or
  ☾ (in light mode) and is styled via `.app-theme-btn` (`.app-theme-btn--floating` for the
  upload screen variant).
- **React Flow** elements that take colours as props (the `MiniMap` mask / node fills /
  background, and the `Background` dot colour in `RouteGraphView.tsx`) use `var(--token)`
  values rather than hardcoded hex so they adapt to the active theme. The minimap mask uses
  a dedicated `--minimap-mask` token (dark/light variants).
- When adding new styles, always reference existing tokens (never hardcode hex/rgba colours
  in components or CSS) so both themes stay consistent.

---

## Layout: route map | details pane

`.app-main` is a horizontal flex row: the **Route map** (`.graph-section`, `flex: 1`), a
`.panel-splitter`, and the **Details** pane (`.detail-section`) on the right. The splitter
uses pointer capture (`startResize` in `App.tsx`); width is clamped to 360 px … 70 % of the
window and persisted to `localStorage['detailWidth']` on release. The details header has a
`›` collapse button; collapsed, the pane becomes a 32 px `.detail-rail` button that expands
it again. The route map is not collapsible.

The details pane body (`.detail-scroll`) scrolls as **one column**. The pane header shows only
"Details" + the collapse button. `NodeDetail`'s compact header is `position: sticky` with rows:
the route label (tooltip = visit URL) + visit duration / Errors badge (`.node-detail-stats`),
then **Trace** `‹` full-width trace dropdown `›` (`.node-detail-trace-row`; menu spans the
dropdown width), then the visit instances (only when > 1), then the **Group** select. Row
labels share a fixed width so the selectors line up. `VisitDetail`
renders collapsible `VisitSection`s: **Preview** (open) and **Actions** (open). Action detail,
network and console panels were removed. Sections do not scroll individually.

---

## Header trace switcher

`TraceSwitcher.tsx` (in the app header) replaces the old legend bar. The trigger shows the
active trace's chip + file name + trace count. The menu lists each trace as a pill: the main
button sets it active (`onSetActive`), `×` removes it; the footer has **+ Add trace** (clicks
the hidden file input in App). Closes on outside `mousedown` / `Escape`.

---

## Screenshot collection

Users build their own list of screenshots. `collection.ts` defines `CollectedShot`
(`{ traceFileName, sha1, routeLabel, visitNumber, offsetMs, addedAt }`), persistence in
`localStorage['screenshotCollection']`, and `CollectionContext` (`isCollected`, `toggle`)
provided by App and consumed by `ScreenshotActions` in `VisitDetail`. Items reference
screenshots by **trace file name + sha1**, so the collection rehydrates when the same zips
are loaded again; items whose trace isn't loaded show as "not loaded", stay removable and
are skipped in the zip.

The header **Collection** button (count badge) opens `ScreenshotCollection.tsx`, a drawer
over the right side of `.app-main`, grouped by trace then route (thumbnail, visit #,
+time, `×`). **Download zip** builds `screenshots.zip` with `jszip` (one folder per trace,
files `NNN_<route>_visit<n>_<offset>ms.<ext>`); **Clear** empties it after confirm. Clicking
an item calls `navigateToShot` in App: it finds the visit containing the sha1, selects its
node, expands the details pane, closes the drawer and sets a `FocusRequest { traceId,
visitId, sha1, nonce }`. `NodeDetail` applies it (selects trace + visit instance) in an
effect declared after its node-change effect; `VisitDetail` switches to the Screenshots tab
and jumps to the frame. Both track the handled `nonce` in a ref so a request applies once.

---

## Trace selector dropdown (in NodeDetail)

- A single compact trigger button shows the selected trace's color chip, file name, and
  a count badge of how many traces visited this route.
- The dropdown menu is a `position: absolute` overlay, max-height 360 px, scrollable.
- Closing: outside `mousedown` or `Escape` key via `document` listeners in `useEffect`.
- Each row in the menu = a pill with a **select** button (chip + name, updates the visit
  view) and a **Highlight / Active** toggle (calls `onSetActive` to change the map's
  active trace).

---

## Prev/next route navigation

In `NodeDetail`, the `‹` and `›` buttons are positioned flanking the trace selector
dropdown (not the route label). They navigate within the **selected trace's path**:

- `uniquePath` = the trace path with consecutive duplicates removed.
- `currentIdx = uniquePath.indexOf(node.nodeId)`
- `prevNode` / `nextNode` looked up from a `Map<nodeId, RouteNode>` built from `graphNodes`.
- Navigating calls `onSelectNode(nodeId)` (which sets `selectedNodeId` in App).
- On node change, `selectedTraceIdRef` preserves the previously selected trace so the
  same trace stays selected after navigating (falls back to active trace then first trace).

---

## CSS conventions

- All design tokens are CSS custom properties on `:root` in `App.css`.
- No scoped/modular CSS — class names use BEM-like naming (e.g. `.route-node--active`).
- Key tokens: `--bg-base`, `--bg-elevated`, `--bg-overlay`, `--bg-hover`, `--border`,
  `--text-primary`, `--text-secondary`, `--text-muted`, `--color-accent`,
  `--color-error`, `--color-success`, `--color-warning`, `--color-purple`,
  `--font-sans`, `--font-mono`, `--radius`, `--radius-sm`.
- The color palette for trace dots/chips is defined in `src/ui/utils.ts` as
  `TRACE_COLORS` (8 colors, wraps with modulo).
- React Flow internals are overridden with scoped selectors:
  `.route-graph .react-flow__controls-button`, `.route-graph .react-flow__minimap`, etc.

---

## Deployment (GitHub Pages)

The app is a static site hosted as a GitHub Pages **project site** (`https://<user>.github.io/<repo>/`).
`.github/workflows/deploy.yml` runs on push to `main` (and manually): `npm ci`,
`npm audit --audit-level=high`, `npm run build` with `BASE_PATH=/<repo>/`, then uploads `dist/`
with the official Pages actions. Pages source must be set to **GitHub Actions**.

- `vite.config.ts` sets `base` from `process.env.BASE_PATH` (default `/` for local dev).
- Runtime URLs MUST be prefixed with `import.meta.env.BASE_URL` — never root-absolute.
  This applies to the SW registration in `main.tsx` and the snapshot iframe URL in
  `VisitDetail.tsx`. The SW strips its registration scope path before matching `snapshot/`.
- `package-lock.json` is committed (required by `npm ci`).
- `localStorage` is shared with every other project site on the same `github.io` origin.

---

## Adding a new feature — checklist

1. **New contract type?** → add to `src/trace/contracts.ts` only; export from `src/trace/index.ts`.
2. **Parsing change?** → edit `src/trace/parser.ts` (no React).
3. **Journey/visit logic?** → edit `src/trace/journeyBuilder.ts` (no React).
4. **Graph structure?** → edit `src/trace/routeGraph.ts` (no React, no UI imports).
5. **Layout?** → edit `src/ui/graphLayout.ts` / `src/ui/layoutShared.ts` (keep sizes multiples of `GRID`).
6. **New component?** → add to `src/ui/`, import in the appropriate parent.
7. **New styles?** → append to `src/App.css`; use existing CSS custom properties.
8. **State that must survive across traces?** → lift to `App.tsx`.
9. **Run `npm run build`** (runs `tsc -b` + vite) before considering a change complete.
10. **After any `package.json` change**: run `npm ci --ignore-scripts` then `npm audit`.
11. **New URL/asset fetched at runtime?** → prefix with `import.meta.env.BASE_URL`.

## Making changes
When making any changes to the application make sure to update this document with new features so that everything is documented.
