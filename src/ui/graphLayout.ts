/**
 * Route-map layout.
 *
 * `autoLayout` produces the starting arrangement: columns by BFS distance from
 * an entry point (a route with no incoming edge), one horizontal band per origin
 * stacked top-to-bottom, routes sorted alphabetically within a column. All
 * positions land on the {@link GRID}.
 *
 * `resolvePositions` merges a saved view with the auto-layout for routes the view
 * does not know about yet, and `buildFlowElements` turns absolute node positions
 * into React Flow nodes. Group boxes are NOT React Flow parents — they are derived
 * from the bounding box of their member routes on every render, so a route can
 * never leave its box and the box always hugs its routes.
 *
 * Highlight state (active trace path, selection, sequence numbers) is merged in
 * by RouteGraphView on each render.
 */

import type { Node } from '@xyflow/react';
import type { RouteGraph, RouteNode } from '../trace/contracts';
import {
    BAND_GAP,
    COL_GAP,
    GROUP_HEADER,
    GROUP_PADDING,
    NODE_HEIGHT,
    NODE_WIDTH,
    ROW_GAP,
    buildEdges,
    computeDepths,
    routeData,
    type GroupNodeData,
    type LayoutResult,
    type Point,
} from './layoutShared';

export * from './layoutShared';

export const GROUP_NODE_PREFIX = 'group:';

const COL_STRIDE = NODE_WIDTH + COL_GAP;
const ROW_STRIDE = NODE_HEIGHT + ROW_GAP;
/** Columns used when appending routes a saved view does not know about yet. */
const APPEND_COLS = 4;

function nodesByGroup(graph: RouteGraph): Map<string, RouteNode[]> {
    const map = new Map<string, RouteNode[]>();
    for (const node of graph.nodes) {
        const list = map.get(node.groupId) ?? [];
        list.push(node);
        map.set(node.groupId, list);
    }
    return map;
}

/**
 * Auto-arranged positions for the given groups (all groups when omitted). The
 * first group box's top edge sits at `top`.
 */
export function autoLayout(graph: RouteGraph, onlyGroups?: Set<string>, top = 0): Map<string, Point> {
    const depth = computeDepths(graph);
    const byGroup = nodesByGroup(graph);
    const abs = new Map<string, Point>();

    let bandTop = top + GROUP_PADDING + GROUP_HEADER;
    for (const group of graph.groups) {
        if (onlyGroups && !onlyGroups.has(group.id)) continue;
        const gnodes = (byGroup.get(group.id) ?? []).slice().sort((a, b) => a.path.localeCompare(b.path));
        if (gnodes.length === 0) continue;

        let maxRow = 0;
        const rowByCol = new Map<number, number>();
        for (const node of gnodes) {
            const col = depth.get(node.nodeId) ?? 0;
            const row = rowByCol.get(col) ?? 0;
            rowByCol.set(col, row + 1);
            if (row > maxRow) maxRow = row;
            abs.set(node.nodeId, { x: col * COL_STRIDE, y: bandTop + row * ROW_STRIDE });
        }

        const bandBottom = bandTop + maxRow * ROW_STRIDE + NODE_HEIGHT;
        bandTop = bandBottom + GROUP_PADDING * 2 + GROUP_HEADER + BAND_GAP;
    }
    return abs;
}

/**
 * Positions for every route in the graph: saved ones as-is, unknown routes of a
 * partially saved group appended below that group's routes, and groups without
 * any saved route auto-laid-out below all existing content.
 */
export function resolvePositions(graph: RouteGraph, saved: Record<string, Point>): Map<string, Point> {
    const byGroup = nodesByGroup(graph);
    const result = new Map<string, Point>();
    const unsavedGroups = new Set<string>();

    for (const group of graph.groups) {
        const members = byGroup.get(group.id) ?? [];
        const known = members.filter(n => saved[n.nodeId]);
        if (known.length === 0) {
            unsavedGroups.add(group.id);
            continue;
        }
        for (const n of known) result.set(n.nodeId, { ...saved[n.nodeId] });

        const unknown = members.filter(n => !saved[n.nodeId]).sort((a, b) => a.path.localeCompare(b.path));
        if (unknown.length === 0) continue;
        const minX = Math.min(...known.map(n => saved[n.nodeId].x));
        const maxY = Math.max(...known.map(n => saved[n.nodeId].y)) + NODE_HEIGHT;
        unknown.forEach((n, i) => {
            result.set(n.nodeId, {
                x: minX + (i % APPEND_COLS) * COL_STRIDE,
                y: maxY + ROW_GAP + Math.floor(i / APPEND_COLS) * ROW_STRIDE,
            });
        });
    }

    if (unsavedGroups.size > 0) {
        let top = 0;
        if (result.size > 0) {
            const bottom = Math.max(...[...result.values()].map(p => p.y + NODE_HEIGHT));
            top = bottom + GROUP_PADDING + BAND_GAP;
        }
        for (const [id, p] of autoLayout(graph, unsavedGroups, top)) result.set(id, p);
    }
    return result;
}

/** Build React Flow nodes (derived group boxes first, then routes) and edges. */
export function buildFlowElements(graph: RouteGraph, positions: Map<string, Point>): LayoutResult {
    const byGroup = nodesByGroup(graph);
    const nodes: Node[] = [];
    const routeNodes: Node[] = [];

    graph.groups.forEach((group, groupIndex) => {
        const members = byGroup.get(group.id) ?? [];
        if (members.length === 0) return;

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const n of members) {
            const p = positions.get(n.nodeId)!;
            minX = Math.min(minX, p.x);
            minY = Math.min(minY, p.y);
            maxX = Math.max(maxX, p.x + NODE_WIDTH);
            maxY = Math.max(maxY, p.y + NODE_HEIGHT);
            routeNodes.push({
                id: n.nodeId,
                type: 'routeNode',
                position: p,
                width: NODE_WIDTH,
                height: NODE_HEIGHT,
                // Without `measured`, React Flow drops handle bounds on every rebuild (edges vanish, error 015).
                measured: { width: NODE_WIDTH, height: NODE_HEIGHT },
                data: routeData(n, group.base),
            });
        }

        const width = maxX - minX + GROUP_PADDING * 2;
        const height = maxY - minY + GROUP_PADDING * 2 + GROUP_HEADER;
        nodes.push({
            id: GROUP_NODE_PREFIX + group.id,
            type: 'originGroup',
            position: { x: minX - GROUP_PADDING, y: minY - GROUP_PADDING - GROUP_HEADER },
            width,
            height,
            measured: { width, height },
            // Below edges (zIndex 0) so transitions stay visible across the box.
            zIndex: -1,
            selectable: false,
            dragHandle: '.origin-group-label',
            data: {
                origin: group.origin,
                base: group.base,
                colorIndex: groupIndex,
                count: members.length,
            } as GroupNodeData,
        });
    });

    return { nodes: [...nodes, ...routeNodes], edges: buildEdges(graph) };
}
