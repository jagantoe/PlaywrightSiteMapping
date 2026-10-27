/**
 * Route graph builder — merges the journeys of multiple traces into a single
 * directed graph of routes.
 *
 * Layer ordering:
 *   contracts.ts  ←  routeGraph.ts  ←  UI
 *
 * A node = one distinct route (origin + pathname, query/hash stripped).
 * Every trace that visited a route contributes its UrlVisit instances to the
 * node. Edges are directed transitions (prev route → current route) observed
 * while walking each trace's chronological visits. Consecutive visits to the
 * same route do NOT create a self-edge — they are recorded as additional
 * instances on the node.
 */

import type { LoadedTrace, RouteEdge, RouteGraph, RouteGroup, RouteNode, UrlVisit } from './contracts';

// Pure URL helpers (kept in the trace layer so it has no UI dependency).
function urlToOrigin(url: string): string {
    if (!url) return '';
    try {
        return new URL(url).origin;
    } catch {
        return '';
    }
}

function urlToRoutePath(url: string): string {
    if (!url) return '/';
    try {
        return new URL(url).pathname || '/';
    } catch {
        return url.split(/[?#]/)[0] || '/';
    }
}

function urlToRouteKey(url: string): string {
    return urlToOrigin(url) + urlToRoutePath(url);
}

/**
 * @param groupAssignments nodeId → custom group key. Routes with a key are split out
 *   of their origin's default group into a separate group per (origin, key).
 */
export function buildRouteGraph(
    traces: LoadedTrace[],
    groupAssignments: Record<string, string> = {},
): RouteGraph {
    const nodes = new Map<string, RouteNode>();
    const edges = new Map<string, RouteEdge>();
    const origins: string[] = [];
    const tracePaths = new Map<string, string[]>();

    const ensureOrigin = (origin: string) => {
        if (!origins.includes(origin)) origins.push(origin);
    };

    const ensureNode = (visit: UrlVisit): RouteNode => {
        const nodeId = urlToRouteKey(visit.url);
        let node = nodes.get(nodeId);
        if (!node) {
            const origin = urlToOrigin(visit.url);
            const path = urlToRoutePath(visit.url);
            ensureOrigin(origin);
            node = {
                nodeId,
                origin,
                path,
                label: path || '/',
                groupId: '',
                traceVisits: new Map<string, UrlVisit[]>(),
                hasErrors: false,
            };
            nodes.set(nodeId, node);
        }
        return node;
    };

    for (const trace of traces) {
        const path: string[] = [];
        let prevNodeId: string | null = null;

        for (const visit of trace.journey.visits) {
            const node = ensureNode(visit);

            // Append this visit instance for the trace
            const list = node.traceVisits.get(trace.traceId) ?? [];
            list.push(visit);
            node.traceVisits.set(trace.traceId, list);
            if (visit.hasErrors) node.hasErrors = true;

            // Record ordered path step
            path.push(node.nodeId);

            // Add a transition edge (skip self-transitions)
            if (prevNodeId && prevNodeId !== node.nodeId) {
                const edgeId = `${prevNodeId}->${node.nodeId}`;
                let edge = edges.get(edgeId);
                if (!edge) {
                    edge = { id: edgeId, from: prevNodeId, to: node.nodeId, traceIds: new Set<string>() };
                    edges.set(edgeId, edge);
                }
                edge.traceIds.add(trace.traceId);
            }

            prevNodeId = node.nodeId;
        }

        tracePaths.set(trace.traceId, path);
    }

    const allNodes = Array.from(nodes.values());
    const groups = computeGroups(allNodes, origins, groupAssignments);

    const result = {
        nodes: allNodes,
        edges: Array.from(edges.values()),
        origins,
        groups,
        tracePaths,
    };

    return result;
}

/**
 * One default {@link RouteGroup} per origin plus one per custom key assigned to
 * any of its routes. Each group is based at the longest segment prefix shared by
 * ALL its routes, so splitting a route out recalculates the remaining base.
 * Mutates `node.groupId` to point at the owning group.
 */
function computeGroups(
    nodes: RouteNode[],
    origins: string[],
    assignments: Record<string, string>,
): RouteGroup[] {
    const groups: RouteGroup[] = [];

    origins.forEach((origin, originIndex) => {
        const byKey = new Map<string, RouteNode[]>([['', []]]);
        for (const n of nodes) {
            if (n.origin !== origin) continue;
            const key = Object.prototype.hasOwnProperty.call(assignments, n.nodeId) ? assignments[n.nodeId] : '';
            const list = byKey.get(key) ?? [];
            list.push(n);
            byKey.set(key, list);
        }

        const keys = [...byKey.keys()].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)));
        for (const key of keys) {
            const members = byKey.get(key)!;
            if (members.length === 0) continue;
            const id = key ? `${origin}#${key}` : origin;
            groups.push({ id, origin, key, base: commonBase(members), originIndex });
            for (const n of members) n.groupId = id;
        }
    });

    return groups;
}

function commonBase(members: RouteNode[]): string {
    const segLists = members.map(n => n.path.split('/').filter(Boolean));
    let len = segLists[0].length;
    for (const segs of segLists) {
        let j = 0;
        while (j < len && j < segs.length && segs[j] === segLists[0][j]) j++;
        len = j;
    }
    // Keep the base strictly shorter than the deepest route so at least one
    // route keeps a distinguishing tail; a route equal to the base shows "/".
    const maxLen = Math.max(...segLists.map(s => s.length));
    len = Math.min(len, Math.max(0, maxLen - 1));
    const baseSegs = segLists[0].slice(0, len);
    return baseSegs.length > 0 ? '/' + baseSegs.join('/') : '';
}

