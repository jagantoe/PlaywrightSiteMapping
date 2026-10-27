/**
 * Journey builder — transforms raw trace events into a structured URL journey.
 *
 * Responsibilities:
 *  - Merge before/input/after events by callId → Action objects
 *  - Build parent/child action tree via parentId
 *  - Detect URL navigations from frameNavigated AND navigatedWithinDocument events
 *    (the latter is the CDP event that fires on every SPA pushState / replaceState /
 *    hash change — i.e. every React Router / Vue Router / Angular Router page change)
 *  - Assign actions, console messages, screenshots, and network requests
 *    to the UrlVisit instance that was active at the time they occurred
 *
 * Input:  ParsedTrace  (output of parser.ts)
 * Output: TraceJourney (consumed by UI)
 */

import type {
    Action,
    AfterActionEvent,
    BeforeActionEvent,
    BrowserEvent,
    ConsoleEvent,
    FrameSnapshotInfo,
    HarEntry,
    InputActionEvent,
    LogEvent,
    ParsedTrace,
    RawEvent,
    ResourceSnapshotEvent,
    ScreencastFrameEvent,
    ScreenshotEntry,
    TraceJourney,
    UrlVisit,
} from './contracts';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function buildJourney(trace: ParsedTrace): TraceJourney {
    const { events, networkEvents, resources, contextInfo, frameSnapshots } = trace;

    // Build per-action snapshot info (URLs + timestamps) so mergeActionEvents
    // can annotate currentUrl, navigationTargetUrl, and actionPageTime.
    const snapshotInfoMap = buildSnapshotInfoMap(frameSnapshots);

    const flatActions = mergeActionEvents(events, snapshotInfoMap);
    const rootActions = buildActionTree(flatActions);
    const navigations = detectNavigations(events, flatActions, frameSnapshots);

    const consoleMessages = events.filter(
        (e): e is ConsoleEvent => e.type === 'console',
    );
    const screencasts = events.filter(
        (e): e is ScreencastFrameEvent => e.type === 'screencast-frame',
    );

    const visits = buildUrlVisits({
        navigations,
        rootActions,
        flatActions,
        consoleMessages,
        screencasts,
        networkEvents,
        resources,
    });

    // Global sorted screenshot list — used for action-level screenshot lookup
    // so screenshots captured just before a visit's first action are not missed.
    const allScreenshots: ScreenshotEntry[] = screencasts
        .map(f => ({ url: resources.get(f.sha1) ?? '', sha1: f.sha1, timestamp: f.timestamp }))
        .filter(s => s.url !== '')
        .sort((a, b) => a.timestamp - b.timestamp);

    const endTime = flatActions
        .filter(a => a.endTime > 0)
        .reduce((max, a) => Math.max(max, a.endTime), 0);

    return {
        visits,
        allScreenshots,
        title: contextInfo?.title,
        browserName: contextInfo?.browserName,
        sdkLanguage: contextInfo?.sdkLanguage,
        startTime: contextInfo?.monotonicTime ?? flatActions[0]?.startTime ?? 0,
        endTime: endTime || (contextInfo?.monotonicTime ?? 0),
        wallTime: contextInfo?.wallTime,
    };
}

// ---------------------------------------------------------------------------
// Snapshot info from frame snapshots (URL + timestamp per action)
// ---------------------------------------------------------------------------

/**
 * Per-action snapshot info extracted from main-frame frame-snapshot events.
 * Mirrors how Playwright associates DOM snapshots with an action by callId.
 */
interface ActionSnapshotInfo {
    beforeUrl?: string;
    beforeTime?: number;
    inputUrl?: string;
    inputTime?: number;
    afterUrl?: string;
    afterTime?: number;
}

function buildSnapshotInfoMap(
    frameSnapshots: FrameSnapshotInfo[],
): Map<string, ActionSnapshotInfo> {
    const map = new Map<string, ActionSnapshotInfo>();

    for (const snap of frameSnapshots) {
        if (!snap.isMainFrame) continue;
        if (!snap.frameUrl || snap.frameUrl.startsWith('about:')) continue;

        const info = map.get(snap.callId) ?? {};
        if (snap.phase === 'before') {
            // First before-snapshot wins (there can be several across frames)
            if (info.beforeUrl === undefined) {
                info.beforeUrl = snap.frameUrl;
                info.beforeTime = snap.timestamp;
            }
        } else if (snap.phase === 'input') {
            if (info.inputUrl === undefined) {
                info.inputUrl = snap.frameUrl;
                info.inputTime = snap.timestamp;
            }
        } else if (snap.phase === 'after') {
            // Last after-snapshot wins (closest to the final state)
            info.afterUrl = snap.frameUrl;
            info.afterTime = snap.timestamp;
        }
        map.set(snap.callId, info);
    }

    return map;
}

// ---------------------------------------------------------------------------
// Step 1: Merge before / input / after events into Action objects
// ---------------------------------------------------------------------------

function mergeActionEvents(
    events: RawEvent[],
    snapshotInfoMap: Map<string, ActionSnapshotInfo>,
): Action[] {
    const beforeMap = new Map<string, BeforeActionEvent>();
    const afterMap = new Map<string, AfterActionEvent>();
    const inputMap = new Map<string, InputActionEvent>();
    const logMap = new Map<string, string[]>();

    for (const event of events) {
        switch (event.type) {
            case 'before':
                beforeMap.set(
                    (event as BeforeActionEvent).callId,
                    event as BeforeActionEvent,
                );
                break;
            case 'after':
                afterMap.set(
                    (event as AfterActionEvent).callId,
                    event as AfterActionEvent,
                );
                break;
            case 'input':
                inputMap.set(
                    (event as InputActionEvent).callId,
                    event as InputActionEvent,
                );
                break;
            case 'log': {
                const log = event as LogEvent;
                const arr = logMap.get(log.callId) ?? [];
                arr.push(log.message);
                logMap.set(log.callId, arr);
                break;
            }
        }
    }

    return Array.from(beforeMap.entries()).map(([callId, before]) => {
        const after = afterMap.get(callId);
        const input = inputMap.get(callId);
        const endTime = after?.endTime ?? before.startTime;

        const snap = snapshotInfoMap.get(callId);
        // URL the action ran on: before snapshot preferred, then input, then after
        const currentUrl = snap?.beforeUrl ?? snap?.inputUrl ?? snap?.afterUrl;
        // URL after the action — a navigation occurred if it differs from currentUrl
        const afterUrl = snap?.afterUrl;
        const navigationTargetUrl =
            afterUrl && afterUrl !== currentUrl ? afterUrl : undefined;
        // Timestamp of the page state the action was performed on (pre-navigation):
        // input snapshot preferred (exact interaction moment), else before snapshot.
        const actionPageTime = snap?.inputTime ?? snap?.beforeTime;

        return {
            callId,
            title: before.title ?? `${before.class}.${before.method}`,
            class: before.class,
            method: before.method,
            params: before.params ?? {},
            startTime: before.startTime,
            endTime,
            duration: Math.max(0, endTime - before.startTime),
            pageId: before.pageId,
            parentId: before.parentId,
            stepId: before.stepId,
            stack: before.stack,
            error: after?.error,
            result: after?.result,
            point: after?.point ?? input?.point,
            beforeSnapshot: before.beforeSnapshot,
            inputSnapshot: input?.inputSnapshot,
            afterSnapshot: after?.afterSnapshot,
            logs: logMap.get(callId) ?? [],
            attachments: after?.attachments ?? [],
            children: [],
            currentUrl,
            navigationTargetUrl,
            actionPageTime,
        } satisfies Action;
    });
}

// ---------------------------------------------------------------------------
// Step 2: Build parent → child tree via parentId
// ---------------------------------------------------------------------------

function buildActionTree(actions: Action[]): Action[] {
    const byCallId = new Map(actions.map(a => [a.callId, a]));
    const roots: Action[] = [];

    for (const action of actions) {
        if (action.parentId) {
            const parent = byCallId.get(action.parentId);
            if (parent) {
                parent.children.push(action);
                continue;
            }
        }
        roots.push(action);
    }

    // Sort children (and roots) chronologically
    const sort = (arr: Action[]) => arr.sort((a, b) => a.startTime - b.startTime);
    for (const action of actions) sort(action.children);
    return sort(roots);
}

// ---------------------------------------------------------------------------
// Step 3: Detect URL navigations (hard loads + SPA route changes)
// ---------------------------------------------------------------------------

interface NavigationMark {
    time: number;
    url: string;
    pageId: string;
}

/**
 * Detect navigations. Three sources are combined, all using ACTION start times
 * as the boundary — never snapshot capture times.
 *
 * The critical insight from SPA traces (Angular / React / Vue Router):
 *   Playwright records the URL in frame-snapshot.frameUrl, NOT in a dedicated
 *   navigation event. But the snapshot capture happens a few milliseconds AFTER
 *   the action's `before` event fires. If we use the snapshot timestamp as the
 *   visit boundary, actions whose startTime falls in that gap end up in the
 *   WRONG (previous) visit.
 *
 *   Fix: frame snapshots tell us WHICH URL an action ran on (→ action.currentUrl),
 *   but the visit boundary time is set to action.startTime, not the snapshot time.
 *
 * Source priority:
 *   1. PRIMARY  — action.currentUrl changes (action.startTime as boundary)
 *   2. SECONDARY — CDP nav events, as a safety-net for hard navigations
 *   3. FALLBACK — explicit page.goto / page.navigate params
 */
function detectNavigations(
    events: RawEvent[],
    actions: Action[],
    frameSnapshots: FrameSnapshotInfo[],
): NavigationMark[] {
    const marks: NavigationMark[] = [];

    // ── 1. Seed with the very first URL visible in the trace ──────────────────
    // Use the earliest main-frame snapshot so the initial page gets a visit even
    // if the first action runs on a different URL (e.g. page already loaded).
    const firstMainFrameSnap = frameSnapshots
        .filter(s => s.isMainFrame && s.frameUrl && !s.frameUrl.startsWith('about:'))
        .sort((a, b) => a.timestamp - b.timestamp)[0];

    if (firstMainFrameSnap) {
        marks.push({
            time: firstMainFrameSnap.timestamp,
            url: firstMainFrameSnap.frameUrl,
            pageId: firstMainFrameSnap.pageId,
        });
    }

    // ── 2. PRIMARY: action URL changes, timed at action.startTime/endTime ─────
    // Walk every action chronologically and emit two kinds of marks:
    //   a) currentUrl  changed  → mark at action.startTime  (action ran on a new page)
    //   b) navigationTargetUrl is set → mark at action.endTime  (navigation completed
    //      during this action; all subsequent actions belong to the new page)
    //
    // Using endTime for (b) is critical for "Wait for navigation" actions:
    // their before-snapshot is taken while still on the old page, so currentUrl
    // = old URL. But the click/action that triggered the navigation has
    // navigationTargetUrl set. Emitting at endTime places the boundary BEFORE
    // the WaitForNavigation action starts.
    {
        const sortedActions = [...actions].sort((a, b) => a.startTime - b.startTime);
        let lastSeenUrl = firstMainFrameSnap?.frameUrl ?? '';

        for (const action of sortedActions) {
            // (a) currentUrl change at startTime
            const startUrl = action.currentUrl;
            if (startUrl && !startUrl.startsWith('about:') && startUrl !== lastSeenUrl) {
                marks.push({ time: action.startTime, url: startUrl, pageId: action.pageId ?? '' });
                lastSeenUrl = startUrl;
            }

            // (b) navigation completed during this action → boundary at endTime
            const targetUrl = action.navigationTargetUrl;
            if (targetUrl && !targetUrl.startsWith('about:') && targetUrl !== lastSeenUrl) {
                marks.push({ time: action.endTime, url: targetUrl, pageId: action.pageId ?? '' });
                lastSeenUrl = targetUrl;
            }
        }
    }

    // ── 3. SECONDARY: CDP navigation events ───────────────────────────────────
    // Keeps hard navigations (full page loads) working even when no snapshot
    // was recorded. These are added as extra data points; deduplication removes
    // conflicts with source 2.
    const navMethods = new Set([
        'frameNavigated',
        'navigated',
        'navigatedWithinDocument',
        'sameDocumentNavigation',
    ]);

    for (const event of events) {
        if (event.type !== 'event') continue;
        const e = event as BrowserEvent;
        if (!navMethods.has(e.method)) continue;
        if (e.params?.isMainFrame === false) continue;
        const url = extractUrlFromEventParams(e);
        if (!url || url.startsWith('about:')) continue;
        marks.push({
            time: e.time,
            url,
            pageId: e.pageId ?? String(e.params?.pageId ?? e.params?.frameId ?? ''),
        });
    }

    // ── 4. FALLBACK: explicit goto / navigate params ───────────────────────────
    for (const action of actions) {
        if (
            (action.method === 'goto' || action.method === 'navigate') &&
            action.params.url
        ) {
            marks.push({
                time: action.startTime,
                url: String(action.params.url),
                pageId: action.pageId ?? '',
            });
        }
    }

    marks.sort((a, b) => a.time - b.time);
    return deduplicateNavigation(marks);
}

/**
 * Extract URL from a CDP navigation event, handling both flat and nested shapes:
 *   flat:   { url: "http://..." }
 *   nested: { frame: { url: "http://..." } }  (CDP Page.frameNavigated)
 */
function extractUrlFromEventParams(e: BrowserEvent): string | undefined {
    const p = e.params as Record<string, unknown> | undefined;
    if (!p) return undefined;
    if (typeof p.url === 'string') return p.url;
    const frame = p.frame as Record<string, unknown> | undefined;
    if (frame && typeof frame.url === 'string') return frame.url;
    return undefined;
}

/**
 * Remove near-duplicate marks that would create spurious visits:
 * - Exact same URL within 150 ms (multiple sources fired for same event)
 * - Same path+hash (ignoring query) within 200 ms (query-param-only changes)
 */
function deduplicateNavigation(marks: NavigationMark[]): NavigationMark[] {
    const out: NavigationMark[] = [];
    for (const mark of marks) {
        const prev = out[out.length - 1];
        if (!prev) { out.push(mark); continue; }

        const dt = mark.time - prev.time;
        if (prev.url === mark.url && dt < 150) continue;
        if (urlPathAndHash(prev.url) === urlPathAndHash(mark.url) && dt < 200) continue;

        out.push(mark);
    }
    return out;
}

/** Returns pathname + hash (strips scheme, host, and query string). */
function urlPathAndHash(url: string): string {
    try {
        const { pathname, hash } = new URL(url);
        return pathname + hash;
    } catch {
        return url;
    }
}

// ---------------------------------------------------------------------------
// Step 4: Build UrlVisit instances and assign events to them
// ---------------------------------------------------------------------------

interface BuildVisitsInput {
    navigations: NavigationMark[];
    rootActions: Action[];
    flatActions: Action[];
    consoleMessages: ConsoleEvent[];
    screencasts: ScreencastFrameEvent[];
    networkEvents: ResourceSnapshotEvent[];
    resources: Map<string, string>;
}

function buildUrlVisits(input: BuildVisitsInput): UrlVisit[] {
    const {
        navigations,
        rootActions,
        flatActions,
        consoleMessages,
        screencasts,
        networkEvents,
        resources,
    } = input;

    // No navigations detected → put everything into a single fallback visit
    if (navigations.length === 0) {
        return [buildFallbackVisit(rootActions, consoleMessages, screencasts, networkEvents, resources)];
    }

    // Build one visit slot per navigation mark
    const visits: UrlVisit[] = navigations.map((nav, i) => ({
        visitId: `visit-${i}`,
        url: nav.url,
        displayPath: urlToDisplayPath(nav.url),
        startTime: nav.time,
        endTime: navigations[i + 1]?.time ?? Infinity,
        duration: 0,
        actions: [],
        screenshots: [],
        networkRequests: [],
        consoleMessages: [],
        hasErrors: false,
    }));

    // Resolve Infinity endTimes to the last action's endTime
    const latestEndTime = flatActions
        .filter(a => a.endTime > 0)
        .reduce((max, a) => Math.max(max, a.endTime), 0);

    for (const visit of visits) {
        if (!isFinite(visit.endTime)) visit.endTime = latestEndTime;
        visit.duration = Math.max(0, visit.endTime - visit.startTime);
    }

    // Assign events to their active visit by timestamp
    assignByTime(visits, rootActions, (v, item) => v.actions.push(item), a => a.startTime);
    assignByTime(visits, consoleMessages, (v, item) => v.consoleMessages.push(item), m => m.time);
    assignScreenshots(visits, screencasts, resources);
    assignNetwork(visits, networkEvents);

    // Derive hasErrors and sort action lists
    for (const visit of visits) {
        visit.actions.sort((a, b) => a.startTime - b.startTime);
        visit.hasErrors = visit.actions.some(actionHasAnyError);
    }

    return visits;
}

function buildFallbackVisit(
    rootActions: Action[],
    consoleMessages: ConsoleEvent[],
    screencasts: ScreencastFrameEvent[],
    networkEvents: ResourceSnapshotEvent[],
    resources: Map<string, string>,
): UrlVisit {
    const endTime = rootActions
        .filter(a => a.endTime > 0)
        .reduce((max, a) => Math.max(max, a.endTime), 0);
    const startTime = rootActions[0]?.startTime ?? 0;
    return {
        visitId: 'visit-0',
        url: '',
        displayPath: '(unknown)',
        startTime,
        endTime,
        duration: Math.max(0, endTime - startTime),
        actions: [...rootActions],
        screenshots: screencasts
            .map(f => ({ url: resources.get(f.sha1) ?? '', sha1: f.sha1, timestamp: f.timestamp }))
            .filter(s => s.url !== ''),
        networkRequests: networkEvents.map(e => e.snapshot),
        consoleMessages,
        hasErrors: rootActions.some(actionHasAnyError),
    };
}

// ---------------------------------------------------------------------------
// Assignment helpers
// ---------------------------------------------------------------------------

function assignByTime<T>(
    visits: UrlVisit[],
    items: T[],
    assign: (visit: UrlVisit, item: T) => void,
    getTime: (item: T) => number,
): void {
    for (const item of items) {
        const visit = findActiveVisit(visits, getTime(item));
        if (visit) assign(visit, item);
    }
}

function assignScreenshots(
    visits: UrlVisit[],
    screencasts: ScreencastFrameEvent[],
    resources: Map<string, string>,
): void {
    for (const frame of screencasts) {
        const blobUrl = resources.get(frame.sha1);
        if (!blobUrl) continue;
        const entry: ScreenshotEntry = { url: blobUrl, sha1: frame.sha1, timestamp: frame.timestamp };
        const visit = findActiveVisit(visits, frame.timestamp);
        if (visit) visit.screenshots.push(entry);
    }
}

function assignNetwork(
    visits: UrlVisit[],
    networkEvents: ResourceSnapshotEvent[],
): void {
    for (const event of networkEvents) {
        const entry: HarEntry = event.snapshot;
        // _monotonicTime is set by Playwright; fall back to first visit if absent
        const time = entry._monotonicTime ?? 0;
        const visit =
            time > 0 ? findActiveVisit(visits, time) : visits[0];
        if (visit) visit.networkRequests.push(entry);
    }
}

/**
 * Finds the last visit whose startTime is ≤ the given time.
 * Since visits are in chronological order, this is the "active" visit.
 */
function findActiveVisit(visits: UrlVisit[], time: number): UrlVisit | undefined {
    let result: UrlVisit | undefined = visits[0];
    for (const visit of visits) {
        if (visit.startTime <= time) result = visit;
        else break;
    }
    return result;
}

function actionHasAnyError(action: Action): boolean {
    if (action.error) return true;
    return action.children.some(actionHasAnyError);
}

function urlToDisplayPath(url: string): string {
    try {
        const parsed = new URL(url);
        return parsed.pathname + (parsed.search || '') + (parsed.hash || '') || '/';
    } catch {
        return url;
    }
}
