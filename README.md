# Playwright Trace URL Overview

Load one or more [Playwright](https://playwright.dev) trace `.zip` files and see **which URLs
were visited, in what order, and with what result** — as an interactive route map instead of
a flat timeline.

**Live app:** `https://<user>.github.io/<repo>/` <!-- replace after first deploy -->

> **Privacy:** traces are parsed entirely in your browser. Nothing is uploaded to any server.
> Preferences, saved views and the screenshot collection are stored in `localStorage`.

## Features

- **Route map** — every distinct `origin + path` becomes a node; transitions between them become
  edges. Multiple traces are merged into one graph, each with its own color, and the active
  trace's path is highlighted with step numbers.
- **Route groups** — routes are boxed per origin with their shared base path folded out of the
  labels. Split any route into its own group from the details pane.
- **Drag, snap & save views** — rearrange nodes and groups on a grid, lock the map, and keep
  multiple named layouts. Views can be exported/imported as JSON.
- **Trace flow** — the active trace as a left-to-right sequence of visits, each with a preview
  and a per-action screenshot strip.
- **Visit details** — screenshot carousel, exact DOM snapshots (Before / Action / After) rendered
  by Playwright's own snapshot service worker, and a collapsible action tree.
- **Screenshot collection** — collect frames across traces and download them as a single zip.
- Dark and light theme.

## Recording a trace

In `playwright.config.ts`:

```ts
export default defineConfig({
  use: { trace: 'on' }, // or 'retain-on-failure'
});
```

Traces are written to `test-results/**/trace.zip`. Drop one or more of them on the app.
Screencast frames and DOM snapshots are included by default.

## Development

Requires Node.js 20+.

```bash
npm ci
npm run dev      # start dev server
npm run build    # type-check (tsc -b) + production build to dist/
npm run preview  # serve dist/ locally
```

To test a build under a sub-path like GitHub Pages:

```bash
# bash
BASE_PATH=/playwright-trace-url-overview/ npm run build && npm run preview
# PowerShell
$env:BASE_PATH='/playwright-trace-url-overview/'; npm run build; npm run preview
```

## Deployment

[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) builds and publishes the site on every
push to `main`. The base path is derived from the repository name, so forks work without changes.

To enable it on a new repository: **Settings → Pages → Build and deployment → Source: GitHub Actions**.

## Tech stack

React 18 · TypeScript · Vite · [React Flow](https://reactflow.dev) (`@xyflow/react`) · JSZip

Technical notes on how traces are parsed and how DOM snapshots are rendered:
[docs/playwright-traces.md](docs/playwright-traces.md).

## License

[MIT](LICENSE). `public/sw.bundle.js` is Playwright's trace viewer service worker
(© Microsoft Corporation, [Apache-2.0](https://github.com/microsoft/playwright/blob/main/LICENSE)).
