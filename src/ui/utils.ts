import type { Action, RouteNode, ScreenshotEntry, UrlVisit } from '../trace/contracts';

// ---------------------------------------------------------------------------
// Duration / time formatting
// ---------------------------------------------------------------------------

export function formatDuration(ms: number): string {
    if (ms < 1) return '<1ms';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
}

export function formatRelativeTime(monotonicMs: number, traceStartMs: number): string {
    const offset = monotonicMs - traceStartMs;
    return `+${formatDuration(Math.max(0, offset))}`;
}

// ---------------------------------------------------------------------------
// Trace color palette (assigned by load order)
// ---------------------------------------------------------------------------

/** Distinct, accessible colors for traces, assigned by load index (wraps around). */
export const TRACE_COLORS = [
    '#4f9dff', // blue
    '#ff8c42', // orange
    '#42d97f', // green
    '#c678dd', // purple
    '#ffd23f', // yellow
    '#ff6b9d', // pink
    '#2dd4bf', // teal
    '#f87171', // red
];

/** Returns the palette color for a trace at the given load index. */
export function traceColor(index: number): string {
    return TRACE_COLORS[index % TRACE_COLORS.length];
}

/**
 * Distinct accent colors for origin (domain) group tiles, assigned by origin
 * index (wraps around). Chosen to read well as borders/tints in both themes.
 */
export const GROUP_COLORS = [
    '#3b82f6', // blue
    '#10b981', // emerald
    '#f59e0b', // amber
    '#a855f7', // violet
    '#ec4899', // pink
    '#14b8a6', // teal
    '#ef4444', // red
    '#6366f1', // indigo
];

/** Returns the palette color for an origin group at the given index. */
export function groupColor(index: number): string {
    return GROUP_COLORS[index % GROUP_COLORS.length];
}

// ---------------------------------------------------------------------------
// Action appearance
// ---------------------------------------------------------------------------

export type ActionCategory =
    | 'navigation'
    | 'interaction'
    | 'input'
    | 'assertion'
    | 'wait'
    | 'script'
    | 'step'
    | 'other';

export function getActionCategory(method: string, cls: string): ActionCategory {
    const m = method.toLowerCase();
    if (['goto', 'navigate', 'reload', 'goback', 'goforward'].includes(m)) return 'navigation';
    if (['click', 'dblclick', 'hover', 'focus', 'blur', 'tap'].includes(m)) return 'interaction';
    if (['fill', 'type', 'press', 'selectoption', 'check', 'uncheck', 'setinputfiles'].includes(m)) return 'input';
    if (m.startsWith('expect') || m.startsWith('assert') || cls === 'Expect') return 'assertion';
    if (m.startsWith('waitfor') || m === 'wait') return 'wait';
    if (['evaluate', 'evaluatehandle', 'addscripttag', 'addstylesheet'].includes(m)) return 'script';
    if (cls === 'Tracing' || m === 'tracinggroup') return 'step';
    return 'other';
}

export function getActionIcon(method: string, cls: string): string {
    const m = method.toLowerCase();
    if (m === 'goto' || m === 'navigate') return '↗';
    if (m === 'reload') return '↺';
    if (m === 'goback') return '←';
    if (m === 'goforward') return '→';
    if (m === 'click' || m === 'dblclick' || m === 'tap') return '●';
    if (m === 'hover') return '◎';
    if (m === 'fill' || m === 'type') return '▍';
    if (m === 'press') return '⌨';
    if (m === 'check') return '✓';
    if (m === 'uncheck') return '✕';
    if (m === 'selectoption') return '▾';
    if (m === 'screenshot') return '⬛';
    if (m.startsWith('waitfor') || m === 'wait') return '◷';
    if (m.startsWith('expect') || m.startsWith('assert') || cls === 'Expect') return '◈';
    if (m === 'evaluate' || m === 'evaluatehandle') return '⚙';
    if (m === 'focus') return '◉';
    return '▶';
}

export function getCategoryColor(category: ActionCategory): string {
    switch (category) {
        case 'navigation': return 'var(--color-accent)';
        case 'interaction': return 'var(--color-success)';
        case 'input': return 'var(--color-purple)';
        case 'assertion': return '#7ee787';
        case 'wait': return 'var(--color-warning)';
        case 'script': return '#d2a8ff';
        case 'step': return 'var(--text-secondary)';
        default: return 'var(--text-muted)';
    }
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

/** Trigger a browser download of a blob:/object URL. */
export function downloadUrl(url: string, fileName: string): void {
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
}

/** Trigger a browser download of an in-memory Blob. */
export function downloadBlob(blob: Blob, fileName: string): void {
    const url = URL.createObjectURL(blob);
    downloadUrl(url, fileName);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Make a string safe to use as (part of) a file name. */
export function toFileSlug(value: string, fallback = 'item'): string {
    const slug = value
        .replace(/\.zip$/i, '')
        .replace(/[^a-z0-9._-]+/gi, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);
    return slug || fallback;
}

/** File extension for an image MIME type. */
export function imageExtension(mimeType: string): string {
    if (mimeType.includes('png')) return 'png';
    if (mimeType.includes('webp')) return 'webp';
    return 'jpg';
}

/** Download one screenshot with a descriptive file name. */
export async function downloadScreenshot(
    shot: ScreenshotEntry,
    traceFileName: string,
    routeLabel: string,
    offsetMs: number,
): Promise<void> {
    const blob = await (await fetch(shot.url)).blob();
    const name = `${toFileSlug(traceFileName, 'trace')}_${toFileSlug(routeLabel, 'route')}_${Math.round(offsetMs)}ms.${imageExtension(blob.type)}`;
    downloadBlob(blob, name);
}

// ---------------------------------------------------------------------------
// Screenshot helpers
// ---------------------------------------------------------------------------

/**
 * Finds the most relevant screenshot (screencast frame) for an action.
 *
 * Playwright ties an action's preview to the DOM snapshot taken at the moment
 * the action interacted with the page (its `input`/`before` snapshot), which is
 * captured BEFORE any navigation the action triggers. We mirror that: the
 * reference time is `action.actionPageTime` (the input/before snapshot time)
 * when available, NOT `action.endTime` — otherwise a click that navigates would
 * match a frame from the page it navigated TO, not the page it ran ON.
 *
 *   1. Prefer a screencast frame ≤ referenceTime AND ≥ max(startTime, visitStartTime).
 *   2. Fall back to the latest frame ≤ referenceTime AND ≥ visitStartTime.
 *   3. Fall back to the latest frame ≤ endTime AND ≥ visitStartTime.
 *   4. Last resort: latest frame ≤ endTime (ignores page boundary).
 *
 * @param visitStartTime  monotonic start time of the owning visit — acts as a
 *                        lower bound to avoid showing screenshots from previous pages.
 */
export function findScreenshotForAction(
    allScreenshots: ScreenshotEntry[],
    action: Action,
    visitStartTime = 0,
): ScreenshotEntry | undefined {
    // Reference time = the moment the action ran on its page (pre-navigation).
    const referenceTime = action.actionPageTime ?? action.endTime;

    // Pass 1: latest frame within the action's window on the page it ran on.
    let best: ScreenshotEntry | undefined;
    for (const ss of allScreenshots) {
        if (ss.timestamp > referenceTime) break;
        if (ss.timestamp >= Math.max(action.startTime, visitStartTime)) best = ss;
    }
    if (best) return best;

    // Pass 2: any frame at or after visitStartTime and ≤ referenceTime.
    for (const ss of allScreenshots) {
        if (ss.timestamp > referenceTime) break;
        if (ss.timestamp >= visitStartTime) best = ss;
    }
    if (best) return best;

    // Pass 3: widen the window to endTime but stay within this visit.
    for (const ss of allScreenshots) {
        if (ss.timestamp > action.endTime) break;
        if (ss.timestamp >= visitStartTime) best = ss;
    }
    if (best) return best;

    // Pass 4: bare fallback — latest frame ≤ endTime (cross-visit).
    for (const ss of allScreenshots) {
        if (ss.timestamp <= action.endTime) best = ss;
        else break;
    }
    return best;
}

export interface StepFrame {
    shot: ScreenshotEntry;
    /** Title of the root action the frame belongs to */
    title: string;
}

/**
 * One frame per root action of a visit (deduped), limited to the visit's own
 * frames so they can be focused in the details pane. Falls back to the last frame.
 */
export function stepScreenshots(visit: UrlVisit, allScreenshots: ScreenshotEntry[]): StepFrame[] {
    const own = new Set(visit.screenshots.map(s => s.sha1));
    const seen = new Set<string>();
    const frames: StepFrame[] = [];
    for (const action of visit.actions) {
        const shot = findScreenshotForAction(allScreenshots, action, visit.startTime);
        if (!shot || !own.has(shot.sha1) || seen.has(shot.sha1)) continue;
        seen.add(shot.sha1);
        frames.push({ shot, title: action.title });
    }
    const last = visit.screenshots[visit.screenshots.length - 1];
    if (frames.length === 0 && last) frames.push({ shot: last, title: 'Last frame' });
    return frames;
}

/**
 * Last screenshot of the last visit to a route that has any (the page is fully
 * loaded by then). Prefers the given trace, then other traces in load order.
 */
export function lastRouteScreenshot(node: RouteNode, preferredTraceId: string | null): ScreenshotEntry | undefined {
    const preferred = preferredTraceId ? node.traceVisits.get(preferredTraceId) : undefined;
    const candidates = preferred ? [preferred, ...node.traceVisits.values()] : [...node.traceVisits.values()];
    for (const visits of candidates) {
        for (let i = visits.length - 1; i >= 0; i--) {
            const shots = visits[i].screenshots;
            if (shots.length > 0) return shots[shots.length - 1];
        }
    }
    return undefined;
}

/**
 * Depth-first search through an action tree to find the first leaf (or group)
 * action that has a screenshot available in allScreenshots at or after
 * visitStartTime (i.e. a screenshot that belongs to this visit's page).
 */
export function findFirstCallIdWithScreenshot(
    actions: Action[],
    allScreenshots: ScreenshotEntry[],
    visitStartTime = 0,
): string | null {
    for (const action of actions) {
        if (action.children.length > 0) {
            const child = findFirstCallIdWithScreenshot(action.children, allScreenshots, visitStartTime);
            if (child) return child;
        }
        if (findScreenshotForAction(allScreenshots, action, visitStartTime)) {
            return action.callId;
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Param / value formatting
// ---------------------------------------------------------------------------

export function formatParamValue(value: unknown, maxLength = 120): string {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value === 'string') {
        const truncated = value.length > maxLength
            ? value.slice(0, maxLength) + '…'
            : value;
        return `"${truncated}"`;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }
    try {
        const json = JSON.stringify(value, null, 2);
        return json.length > maxLength * 2 ? json.slice(0, maxLength * 2) + '…' : json;
    } catch {
        return String(value);
    }
}

// ---------------------------------------------------------------------------
// Nested action search
// ---------------------------------------------------------------------------

export function findActionByCallId(
    actions: Action[],
    callId: string,
): Action | undefined {
    for (const action of actions) {
        if (action.callId === callId) return action;
        const found = findActionByCallId(action.children, callId);
        if (found) return found;
    }
    return undefined;
}

// ---------------------------------------------------------------------------
// Compute visit index within same URL (for disambiguation in JourneyMap)
// ---------------------------------------------------------------------------

export function computeVisitOrdinals(
    displayPaths: string[],
): number[] {
    const seen = new Map<string, number>();
    return displayPaths.map(path => {
        const count = seen.get(path) ?? 0;
        seen.set(path, count + 1);
        return count; // 0-based ordinal within this URL
    });
}

// ---------------------------------------------------------------------------
// URL display helpers
// ---------------------------------------------------------------------------

/** Returns pathname + search + hash with no scheme/host, e.g. "/login/recovery?lang=en" */
export function urlToPath(url: string): string {
    if (!url) return '';
    try {
        const { pathname, search, hash } = new URL(url);
        return pathname + (search || '') + (hash || '') || '/';
    } catch {
        return url;
    }
}

/** Returns the origin of a URL (scheme + host), e.g. "https://app.example.com". Empty string if unparseable. */
export function urlToOrigin(url: string): string {
    if (!url) return '';
    try {
        return new URL(url).origin;
    } catch {
        return '';
    }
}

/** Returns pathname only (query + hash stripped), e.g. "/login/recovery". Defaults to "/". */
export function urlToRoutePath(url: string): string {
    if (!url) return '/';
    try {
        return new URL(url).pathname || '/';
    } catch {
        // Best-effort: strip query/hash from a raw path
        return url.split(/[?#]/)[0] || '/';
    }
}

/** Stable route node key: origin + pathname (query/hash stripped), e.g. "https://app.example.com/login". */
export function urlToRouteKey(url: string): string {
    const origin = urlToOrigin(url);
    const path = urlToRoutePath(url);
    return origin + path;
}
