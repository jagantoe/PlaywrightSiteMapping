/**
 * Persistence for route-map "views": named sets of node positions keyed by
 * nodeId (origin + pathname). Because the key comes from the URL, loading the
 * same trace zips again restores the arrangement. Stored in localStorage —
 * positions are tiny (~100 bytes per route), so IndexedDB is not needed.
 */

import type { Point } from './layoutShared';
import { downloadBlob, toFileSlug } from './utils';

export type SavedPositions = Record<string, Point>;
/** nodeId → custom group key (routes split out of their origin's default group) */
export type GroupAssignments = Record<string, string>;

export interface RouteView {
    id: string;
    name: string;
    updatedAt: number;
    nodes: SavedPositions;
    groups: GroupAssignments;
}

export interface ViewState {
    activeViewId: string;
    views: RouteView[];
}

const STORAGE_KEY = 'routeViews';
const EXPORT_VERSION = 1;
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const MAX_NAME_LENGTH = 100;
const MAX_GROUP_KEY_LENGTH = 500;

function newId(): string {
    return `view-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createView(name: string, nodes: SavedPositions = {}, groups: GroupAssignments = {}): RouteView {
    return { id: newId(), name, updatedAt: Date.now(), nodes, groups };
}

function isPoint(value: unknown): value is Point {
    if (!value || typeof value !== 'object') return false;
    const p = value as Record<string, unknown>;
    return typeof p.x === 'number' && Number.isFinite(p.x)
        && typeof p.y === 'number' && Number.isFinite(p.y);
}

function sanitizePositions(value: unknown): SavedPositions {
    const out: SavedPositions = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
    for (const [key, p] of Object.entries(value as Record<string, unknown>)) {
        if (key !== '__proto__' && isPoint(p)) out[key] = { x: p.x, y: p.y };
    }
    return out;
}

function sanitizeGroups(value: unknown): GroupAssignments {
    const out: GroupAssignments = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
    for (const [nodeId, key] of Object.entries(value as Record<string, unknown>)) {
        if (nodeId !== '__proto__' && typeof key === 'string' && key && key.length <= MAX_GROUP_KEY_LENGTH) {
            out[nodeId] = key;
        }
    }
    return out;
}

function sanitizeName(value: unknown, fallback: string): string {
    if (typeof value !== 'string') return fallback;
    const name = value.trim().slice(0, MAX_NAME_LENGTH);
    return name || fallback;
}

export function loadViewState(): ViewState {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw) as Partial<ViewState>;
            const views = Array.isArray(parsed.views)
                ? parsed.views
                    .filter(v => v && typeof v.id === 'string')
                    .map(v => ({
                        id: v.id,
                        name: sanitizeName(v.name, 'Untitled view'),
                        updatedAt: typeof v.updatedAt === 'number' ? v.updatedAt : 0,
                        nodes: sanitizePositions(v.nodes),
                        groups: sanitizeGroups(v.groups),
                    }))
                : [];
            if (views.length > 0) {
                const activeViewId = views.some(v => v.id === parsed.activeViewId)
                    ? (parsed.activeViewId as string)
                    : views[0].id;
                return { activeViewId, views };
            }
        }
    } catch {
        // Corrupt storage — fall through to a fresh default view.
    }
    const view = createView('Default');
    return { activeViewId: view.id, views: [view] };
}

export function saveViewState(state: ViewState): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
        // Quota exceeded or storage disabled — positions just won't persist.
    }
}

/** Pick a name not already used by another view ("Name", "Name (2)", …). */
export function uniqueViewName(name: string, views: RouteView[]): string {
    const taken = new Set(views.map(v => v.name));
    if (!taken.has(name)) return name;
    for (let i = 2; ; i++) {
        const candidate = `${name} (${i})`;
        if (!taken.has(candidate)) return candidate;
    }
}

export function exportView(view: RouteView): void {
    const payload = {
        version: EXPORT_VERSION,
        name: view.name,
        exportedAt: new Date().toISOString(),
        nodes: view.nodes,
        groups: view.groups,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    downloadBlob(blob, `route-view-${toFileSlug(view.name, 'view')}.json`);
}

/** Parse an exported view file. Throws an Error with a user-facing message. */
export async function parseViewFile(
    file: File,
): Promise<{ name: string; nodes: SavedPositions; groups: GroupAssignments }> {
    if (file.size > MAX_IMPORT_BYTES) throw new Error('View file is too large.');
    let parsed: unknown;
    try {
        parsed = JSON.parse(await file.text());
    } catch {
        throw new Error('View file is not valid JSON.');
    }
    if (!parsed || typeof parsed !== 'object') throw new Error('View file has an unexpected format.');
    const data = parsed as Record<string, unknown>;
    if (data.version !== EXPORT_VERSION) throw new Error('Unsupported view file version.');
    const nodes = sanitizePositions(data.nodes);
    const groups = sanitizeGroups(data.groups);
    if (Object.keys(nodes).length === 0 && Object.keys(groups).length === 0) {
        throw new Error('View file contains no node positions or groups.');
    }
    return { name: sanitizeName(data.name, file.name.replace(/\.json$/i, '')), nodes, groups };
}
