/**
 * User-curated screenshot collection. Items reference a screenshot by trace file
 * name + resource sha1 (both stable across reloads), so the collection is
 * persisted to localStorage and rehydrates when the same zips are loaded again.
 */

import { createContext, useContext } from 'react';

export interface CollectedShot {
    traceFileName: string;
    sha1: string;
    /** Full route path (origin stripped) the screenshot was taken on */
    routeLabel: string;
    /** 1-based visit instance of the route within the trace */
    visitNumber: number;
    /** Milliseconds since the trace started */
    offsetMs: number;
    addedAt: number;
}

const STORAGE_KEY = 'screenshotCollection';

/** Request to open a specific screenshot in the details pane. */
export interface FocusRequest {
    traceId: string;
    visitId: string;
    /** Frame to show; omitted to just open the visit */
    sha1?: string;
    /** Changes on every request so repeated clicks on the same item re-apply */
    nonce: number;
}

export const shotKey = (traceFileName: string, sha1: string) => `${traceFileName}|${sha1}`;

export function loadCollection(): CollectedShot[] {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((s): s is CollectedShot =>
            !!s
            && typeof s.traceFileName === 'string'
            && typeof s.sha1 === 'string'
            && typeof s.routeLabel === 'string'
            && typeof s.visitNumber === 'number'
            && typeof s.offsetMs === 'number',
        );
    } catch {
        return [];
    }
}

export function saveCollection(items: CollectedShot[]): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    } catch {
        // Storage unavailable — the collection just won't persist.
    }
}

export interface CollectionApi {
    isCollected: (traceFileName: string, sha1: string) => boolean;
    toggle: (shot: Omit<CollectedShot, 'addedAt'>) => void;
}

export const CollectionContext = createContext<CollectionApi>({
    isCollected: () => false,
    toggle: () => {},
});

export const useCollection = () => useContext(CollectionContext);
