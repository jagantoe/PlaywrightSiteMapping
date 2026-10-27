/**
 * Pure TypeScript contracts for Playwright trace data.
 * No logic — only types/interfaces.
 *
 * Layer ordering:
 *   contracts.ts  ← parser.ts  ← journeyBuilder.ts  ← UI
 */

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

export interface StackFrame {
    file: string;
    line?: number;
    column?: number;
    function?: string;
}

export interface SerializedError {
    message: string;
    name?: string;
    stack?: string;
}

export interface ActionAttachment {
    name: string;
    contentType: string;
    path?: string;
    sha1?: string;
    base64?: string;
}

// ---------------------------------------------------------------------------
// HAR types (network resources stored in .network file)
// ---------------------------------------------------------------------------

export interface HarHeader {
    name: string;
    value: string;
}

export interface HarRequest {
    method: string;
    url: string;
    httpVersion?: string;
    headers: HarHeader[];
    postData?: { mimeType: string; text?: string };
    headersSize: number;
    bodySize: number;
}

export interface HarResponse {
    status: number;
    statusText: string;
    headers: HarHeader[];
    content: { mimeType: string; text?: string; size: number; _sha1?: string };
    redirectURL?: string;
    headersSize: number;
    bodySize: number;
}

/** A single HAR network entry as stored in the Playwright .network file */
export interface HarEntry {
    startedDateTime?: string;
    time?: number;
    request: HarRequest;
    response: HarResponse;
    _resourceType?: string;
    /** Playwright-injected monotonic timestamp for ordering */
    _monotonicTime?: number;
    pageref?: string;
}

// ---------------------------------------------------------------------------
// Raw trace event types (as emitted into the .trace JSONL file)
// ---------------------------------------------------------------------------

export interface ContextCreatedEvent {
    type: 'context-options';
    version: number;
    browserName: string;
    sdkLanguage?: string;
    wallTime: number;
    monotonicTime: number;
    title?: string;
    testIdAttributeName?: string;
    contextId?: string;
}

export interface BeforeActionEvent {
    type: 'before';
    callId: string;
    startTime: number;
    title?: string;
    class: string;
    method: string;
    params: Record<string, unknown>;
    stepId?: string;
    beforeSnapshot?: string;
    stack?: StackFrame[];
    pageId?: string;
    parentId?: string;
}

export interface InputActionEvent {
    type: 'input';
    callId: string;
    inputSnapshot?: string;
    point?: { x: number; y: number };
}

export interface AfterActionEvent {
    type: 'after';
    callId: string;
    endTime: number;
    afterSnapshot?: string;
    error?: SerializedError;
    attachments?: ActionAttachment[];
    result?: unknown;
    point?: { x: number; y: number };
}

export interface LogEvent {
    type: 'log';
    callId: string;
    time: number;
    message: string;
}

/** Generic browser/page/frame lifecycle event */
export interface BrowserEvent {
    type: 'event';
    time: number;
    class: string;
    method: string;
    params: Record<string, unknown>;
    pageId?: string;
}

export interface ConsoleEvent {
    type: 'console';
    time: number;
    pageId?: string;
    messageType: string;
    text: string;
    args?: { preview: string; value: unknown }[];
    location: { url: string; lineNumber: number; columnNumber: number };
}

export interface ResourceSnapshotEvent {
    type: 'resource-snapshot';
    snapshot: HarEntry;
}

export interface ScreencastFrameEvent {
    type: 'screencast-frame';
    pageId: string;
    sha1: string;
    width: number;
    height: number;
    timestamp: number;
}

/**
 * Lightweight metadata extracted from a frame-snapshot event.
 * The full HTML snapshot is discarded — only the URL and timing are kept.
 */
export interface FrameSnapshotInfo {
    callId: string;
    /** Which snapshot phase this belongs to */
    phase: 'before' | 'input' | 'after';
    /** The URL of this frame at snapshot time */
    frameUrl: string;
    frameId: string;
    pageId: string;
    /** True when this is the top-level page frame (not an iframe) */
    isMainFrame: boolean;
    /** Monotonic timestamp in milliseconds — comparable to Action.startTime */
    timestamp: number;
}

/** Union of all raw event types the parser may encounter */
export type RawEvent =
    | ContextCreatedEvent
    | BeforeActionEvent
    | InputActionEvent
    | AfterActionEvent
    | LogEvent
    | BrowserEvent
    | ConsoleEvent
    | ResourceSnapshotEvent
    | ScreencastFrameEvent
    | { type: string;[key: string]: unknown };

// ---------------------------------------------------------------------------
// Enriched model types produced by the journey builder
// ---------------------------------------------------------------------------

/**
 * A single user action — result of merging the before / input / after events
 * that share a callId, plus any log entries and nested child actions.
 */
export interface Action {
    callId: string;
    /** Human-readable label (trace title field or "Class.method") */
    title: string;
    class: string;
    method: string;
    params: Record<string, unknown>;
    startTime: number;
    endTime: number;
    /** endTime - startTime in milliseconds */
    duration: number;
    pageId?: string;
    parentId?: string;
    stepId?: string;
    stack?: StackFrame[];
    error?: SerializedError;
    result?: unknown;
    point?: { x: number; y: number };
    beforeSnapshot?: string;
    inputSnapshot?: string;
    afterSnapshot?: string;
    logs: string[];
    attachments: ActionAttachment[];
    /** Nested child actions (e.g. steps inside a test-step group) */
    children: Action[];
    /** URL of the main frame when this action started (from before/input snapshot) */
    currentUrl?: string;
    /** URL the main frame landed on after this action — only set when it differs from currentUrl */
    navigationTargetUrl?: string;
    /**
     * Monotonic timestamp of the DOM snapshot that represents the page state the
     * action was performed ON (input snapshot preferred, else before snapshot).
     * This is captured BEFORE any navigation the action triggers — making it the
     * correct reference for matching a screencast frame to the action's page,
     * mirroring how Playwright ties its preview to the action's `input` snapshot.
     */
    actionPageTime?: number;
}

/** A screenshot captured by Playwright's screencast recording */
export interface ScreenshotEntry {
    /** blob: URL for display in <img> */
    url: string;
    /** sha1 of the resource inside the trace zip — stable across reloads */
    sha1: string;
    /** monotonicTime timestamp — aligns with Action.startTime / endTime */
    timestamp: number;
}

/**
 * One contiguous visit to a specific URL.
 * If the user navigates away and comes back, that is a NEW UrlVisit instance.
 */
export interface UrlVisit {
    /** Unique across the journey (e.g. "visit-0", "visit-3") */
    visitId: string;
    /** Full URL */
    url: string;
    /** Path + search + hash only (no scheme/host) — used for display */
    displayPath: string;
    startTime: number;
    endTime: number;
    duration: number;
    /** Top-level actions performed during this visit (children nested inside) */
    actions: Action[];
    screenshots: ScreenshotEntry[];
    networkRequests: HarEntry[];
    consoleMessages: ConsoleEvent[];
    hasErrors: boolean;
}

/** The full chronological URL journey extracted from a trace file */
export interface TraceJourney {
    visits: UrlVisit[];
    /**
     * ALL screenshots from the trace in ascending timestamp order.
     * Used for action-level screenshot lookup — visit.screenshots is only
     * used for the filmstrip because screenshots captured just before a
     * visit's first action would otherwise be missed.
     */
    allScreenshots: ScreenshotEntry[];
    title?: string;
    browserName?: string;
    sdkLanguage?: string;
    /** monotonicTime of the first event */
    startTime: number;
    /** monotonicTime of the last event */
    endTime: number;
    wallTime?: number;
}

// ---------------------------------------------------------------------------
// Intermediate type — output of the parser, input to the journey builder
// ---------------------------------------------------------------------------

/** Raw data extracted from the .zip — no grouping or merging yet */
export interface ParsedTrace {
    events: RawEvent[];
    networkEvents: ResourceSnapshotEvent[];
    /** Lightweight metadata from all frame-snapshot events (HTML stripped) */
    frameSnapshots: FrameSnapshotInfo[];
    /** Maps sha1 hash → blob: URL for binary resources (screenshots etc.) */
    resources: Map<string, string>;
    contextInfo?: ContextCreatedEvent;
}

// ---------------------------------------------------------------------------
// Multi-trace route graph
// ---------------------------------------------------------------------------

/** A single uploaded + parsed trace, tracked alongside others */
export interface LoadedTrace {
    /** Stable unique id assigned on load (e.g. "trace-0") */
    traceId: string;
    /** Original file name, for display */
    fileName: string;
    /** blob: URL of the trace zip — passed to the service worker for snapshots */
    traceUrl: string;
    /** Palette color assigned by load order — used in the graph + legend */
    color: string;
    /** The built journey for this trace */
    journey: TraceJourney;
}

/**
 * One node in the route graph: a distinct route (origin + pathname, query/hash
 * stripped). Shared across traces — every trace that visited this route adds
 * its UrlVisit instances here.
 */
export interface RouteNode {
    /** Unique key: origin + pathname (e.g. "https://app.example.com/login/recovery") */
    nodeId: string;
    /** Origin only (e.g. "https://app.example.com") — used for grouping */
    origin: string;
    /** Pathname only (e.g. "/login/recovery") — used as the node label */
    path: string;
    /** Display label (the path, or "/" for root) */
    label: string;
    /** Id of the {@link RouteGroup} this route belongs to. */
    groupId: string;
    /** Per-trace visit instances at this route, in chronological order */
    traceVisits: Map<string, UrlVisit[]>;
    /** True if any visit (in any trace) had errors */
    hasErrors: boolean;
}

/**
 * A box of routes within one origin. Every origin has a default group; routes the
 * user split off live in custom groups. The base is folded out of the child node
 * labels so cards show just the distinguishing tail.
 */
export interface RouteGroup {
    /** Origin for the default group, `${origin}#${key}` for custom groups — stable across reloads */
    id: string;
    /** Origin shared by every route in the group */
    origin: string;
    /** User-defined group key; '' for the origin's default group */
    key: string;
    /**
     * Longest common path prefix shared by ALL the group's routes, e.g.
     * "/app/portal/main". Empty when there is no shared
     * base beyond the origin.
     */
    base: string;
    /** Index of the group's origin in {@link RouteGraph.origins} — used for color */
    originIndex: number;
}

/** A directed transition between two routes, observed in one or more traces */
export interface RouteEdge {
    /** Unique id: `${from}->${to}` */
    id: string;
    /** Source nodeId */
    from: string;
    /** Target nodeId */
    to: string;
    /** Trace ids that made this transition */
    traceIds: Set<string>;
}

/** The merged route graph across all loaded traces */
export interface RouteGraph {
    nodes: RouteNode[];
    edges: RouteEdge[];
    /** Distinct origins present, in first-seen order — used for grouping */
    origins: string[];
    /**
     * Route clusters that share a common base path. Each {@link RouteNode}
     * references its group via {@link RouteNode.groupId}. One origin can produce
     * several groups when its routes split into distinct path families, so the
     * deepest common base is recovered per family (e.g.
     * "/app/portal/main") rather than collapsing to the
     * origin-wide prefix (e.g. "/app").
     */
    groups: RouteGroup[];
    /**
     * Per-trace ordered list of nodeIds visited (with consecutive duplicates
     * preserved as separate steps for sequence numbering, but the path itself
     * is the ordered node sequence). Used to highlight a trace's route.
     */
    tracePaths: Map<string, string[]>;
}
