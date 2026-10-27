/**
 * Shared layout primitives — constants, types and reusable building blocks for
 * the route-map layout. All sizes are multiples of {@link GRID} so nodes and
 * group boxes always land on the snap grid.
 */

import type { Edge, Node } from '@xyflow/react';
import type { RouteGraph } from '../trace/contracts';

export const GRID = 20;
export const NODE_WIDTH = 260;
export const NODE_HEIGHT = 220;
export const GROUP_PADDING = 20;
export const GROUP_HEADER = 40;
/** Horizontal gap between depth columns. */
export const COL_GAP = 80;
/** Vertical gap between stacked nodes within a column. */
export const ROW_GAP = 20;
/** Extra vertical gap between group bands. */
export const BAND_GAP = 40;

export type Point = { x: number; y: number };

/** Static data attached to a route node (dynamic state added later by the view). */
export interface RouteNodeData extends Record<string, unknown> {
    nodeId: string;
    label: string;
    origin: string;
    /** Trace ids that visited this route */
    traceIds: string[];
    hasErrors: boolean;
}

export interface GroupNodeData extends Record<string, unknown> {
    origin: string;
    /** Common base path folded out of the child labels (may be empty) */
    base: string;
    /** Index of this group in the graph's group order (for color assignment) */
    colorIndex: number;
    /** Number of routes in the group */
    count: number;
}

export interface LayoutResult {
    nodes: Node[];
    edges: Edge[];
}


/** Build the React Flow edge list from the graph's directed transitions. */
export function buildEdges(graph: RouteGraph): Edge[] {
    return graph.edges.map(e => ({
        id: e.id,
        source: e.from,
        target: e.to,
        type: 'smoothstep',
    }));
}

/**
 * BFS distance of every node from its nearest entry point. An entry point is a
 * route with no incoming edge (in-degree 0) — which also captures isolated nodes
 * that were visited directly but never transitioned. Nodes only reachable
 * through a cycle (never from an entry) fall back to depth 0.
 */
export function computeDepths(graph: RouteGraph): Map<string, number> {
    const adj = new Map<string, string[]>();
    const indeg = new Map<string, number>();
    for (const node of graph.nodes) {
        adj.set(node.nodeId, []);
        indeg.set(node.nodeId, 0);
    }
    for (const edge of graph.edges) {
        if (edge.from === edge.to) continue;
        adj.get(edge.from)?.push(edge.to);
        indeg.set(edge.to, (indeg.get(edge.to) ?? 0) + 1);
    }

    const depth = new Map<string, number>();
    const queue: string[] = [];
    for (const node of graph.nodes) {
        if ((indeg.get(node.nodeId) ?? 0) === 0) {
            depth.set(node.nodeId, 0);
            queue.push(node.nodeId);
        }
    }
    // Plain BFS from all entry points at once → shortest hop distance.
    for (let i = 0; i < queue.length; i++) {
        const u = queue[i];
        const du = depth.get(u)!;
        for (const v of adj.get(u) ?? []) {
            if (!depth.has(v)) {
                depth.set(v, du + 1);
                queue.push(v);
            }
        }
    }
    for (const node of graph.nodes) {
        if (!depth.has(node.nodeId)) depth.set(node.nodeId, 0);
    }
    return depth;
}

export function routeData(node: RouteGraph['nodes'][number], base: string): RouteNodeData {
    // Strip the shared base prefix so the card shows just the distinguishing tail.
    let label = node.path;
    if (base && (node.path === base || node.path.startsWith(base + '/'))) {
        label = node.path.slice(base.length) || '/';
    }
    return {
        nodeId: node.nodeId,
        label,
        origin: node.origin,
        traceIds: Array.from(node.traceVisits.keys()),
        hasErrors: node.hasErrors,
    };
}
