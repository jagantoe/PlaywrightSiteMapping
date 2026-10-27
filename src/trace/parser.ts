/**
 * Trace parser — reads a Playwright .zip trace file and returns raw event data.
 *
 * Responsibilities:
 *  - Unzip the archive
 *  - Parse all .trace and .network JSONL files
 *  - Extract binary resources (screenshots) as blob: URLs
 *
 * This layer has NO knowledge of URL visits or action merging.
 * Output: ParsedTrace (consumed by journeyBuilder.ts)
 */

import JSZip from 'jszip';
import type {
    ContextCreatedEvent,
    FrameSnapshotInfo,
    ParsedTrace,
    RawEvent,
    ResourceSnapshotEvent,
} from './contracts';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function parseTraceFile(file: File): Promise<ParsedTrace> {
    const zip = await JSZip.loadAsync(file);
    const fileNames = Object.keys(zip.files);

    const traceFileNames = fileNames
        .filter(name => name.endsWith('.trace') && !zip.files[name].dir)
        .sort(compareTraceChunkOrder);

    const networkFileNames = fileNames
        .filter(name => name.endsWith('.network') && !zip.files[name].dir)
        .sort();

    // Parse all .trace event files (multiple chunks are common)
    const allEvents: RawEvent[] = [];
    const frameSnapshots: FrameSnapshotInfo[] = [];
    for (const name of traceFileNames) {
        const text = await zip.files[name].async('text');
        for (const raw of parseJsonLines<Record<string, unknown>>(text)) {
            if (raw.type === 'frame-snapshot') {
                // Extract URL metadata only — discard the large HTML payload
                const info = extractFrameSnapshotInfo(raw);
                if (info) frameSnapshots.push(info);
            } else {
                allEvents.push(raw as RawEvent);
            }
        }
    }

    // Parse .network files (HAR entries wrapped in resource-snapshot events)
    const networkEvents: ResourceSnapshotEvent[] = [];
    for (const name of networkFileNames) {
        const text = await zip.files[name].async('text');
        for (const event of parseJsonLines<RawEvent>(text)) {
            if (event.type === 'resource-snapshot') {
                networkEvents.push(event as ResourceSnapshotEvent);
            }
        }
    }

    // Extract binary resources as blob: URLs (screenshots are JPEG)
    const resources = new Map<string, string>();
    const resourcePrefix = 'resources/';
    for (const [name, entry] of Object.entries(zip.files)) {
        if (name.startsWith(resourcePrefix) && !entry.dir) {
            const sha1 = name.slice(resourcePrefix.length);
            const buffer = await entry.async('arraybuffer');
            const blob = new Blob([buffer], { type: guessContentType(name) });
            resources.set(sha1, URL.createObjectURL(blob));
        }
    }

    // Extract the context-options header event for metadata
    const contextInfo = allEvents.find(
        (e): e is ContextCreatedEvent => e.type === 'context-options',
    );

    // Strip context-options from the event stream — it is metadata, not an action
    const events = allEvents.filter(e => e.type !== 'context-options');

    return { events, networkEvents, frameSnapshots, resources, contextInfo };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function parseJsonLines<T>(content: string): T[] {
    const results: T[] = [];
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            results.push(JSON.parse(trimmed) as T);
        } catch {
            // Silently skip malformed lines (can occur in live/incomplete traces)
        }
    }
    return results;
}

// ---------------------------------------------------------------------------
// Frame snapshot extraction
// ---------------------------------------------------------------------------

function extractFrameSnapshotInfo(
    raw: Record<string, unknown>,
): FrameSnapshotInfo | null {
    const snap = raw.snapshot as Record<string, unknown> | undefined;
    if (!snap) return null;

    const callId = String(snap.callId ?? '');
    const frameUrl = String(snap.frameUrl ?? '');
    const snapshotName = String(snap.snapshotName ?? '');
    if (!callId || !frameUrl) return null;

    const phase = parseSnapshotPhase(snapshotName);
    if (!phase) return null;

    return {
        callId,
        phase,
        frameUrl,
        frameId: String(snap.frameId ?? ''),
        pageId: String(snap.pageId ?? ''),
        isMainFrame: snap.isMainFrame === true,
        timestamp: Number(snap.timestamp ?? 0),
    };
}

function parseSnapshotPhase(
    snapshotName: string,
): 'before' | 'input' | 'after' | null {
    if (snapshotName.startsWith('before@')) return 'before';
    if (snapshotName.startsWith('input@')) return 'input';
    if (snapshotName.startsWith('after@')) return 'after';
    return null;
}

/**
 * Sorts trace chunk filenames so the base chunk comes first and numbered
 * chunks follow in ascending order.
 *
 * Examples:
 *   "trace.trace"         → key -1  (base)
 *   "trace-chunk1.trace"  → key  1
 *   "trace-chunk2.trace"  → key  2
 */
function compareTraceChunkOrder(a: string, b: string): number {
    const chunkIndex = (name: string): number => {
        const m = name.match(/-chunk(\d+)\.trace$/);
        return m ? parseInt(m[1], 10) : -1;
    };
    return chunkIndex(a) - chunkIndex(b);
}

function guessContentType(filename: string): string {
    if (filename.endsWith('.jpeg') || filename.endsWith('.jpg')) return 'image/jpeg';
    if (filename.endsWith('.png')) return 'image/png';
    if (filename.endsWith('.webp')) return 'image/webp';
    return 'application/octet-stream';
}
