/**
 * Trace flow layout — one step per visit of a single trace, laid out in one
 * left-to-right row (revisits get a new step instead of looping back).
 */

import type { Edge, Node } from '@xyflow/react';
import type { LoadedTrace, RouteGraph, UrlVisit } from '../trace/contracts';
import { GRID, routeData } from './layoutShared';
import { type StepFrame, stepScreenshots } from './utils';

export const FLOW_NODE_WIDTH = 16 * GRID;
export const FLOW_NODE_HEIGHT = 18 * GRID;
export const FLOW_GAP = 4 * GRID;

export interface TraceStepData extends Record<string, unknown> {
    /** 0-based position in the trace */
    index: number;
    visit: UrlVisit;
    /** Route node the visit belongs to */
    nodeId: string;
    label: string;
    colorIndex: number;
    frames: StepFrame[];
}

export function buildTraceFlowElements(trace: LoadedTrace, graph: RouteGraph): { nodes: Node[]; edges: Edge[] } {
    const path = graph.tracePaths.get(trace.traceId) ?? [];
    const nodeById = new Map(graph.nodes.map(n => [n.nodeId, n]));
    const groupIndex = new Map(graph.groups.map((g, i) => [g.id, i]));
    const { allScreenshots } = trace.journey;

    const nodes: Node[] = trace.journey.visits.map((visit, i) => {
        const route = nodeById.get(path[i]);
        const group = route ? graph.groups[groupIndex.get(route.groupId) ?? -1] : undefined;
        const data: TraceStepData = {
            index: i,
            visit,
            nodeId: path[i] ?? '',
            label: route ? routeData(route, group?.base ?? '').label : visit.displayPath,
            colorIndex: route ? (groupIndex.get(route.groupId) ?? 0) : 0,
            frames: stepScreenshots(visit, allScreenshots),
        };
        return {
            id: `step-${i}`,
            type: 'traceStep',
            position: { x: i * (FLOW_NODE_WIDTH + FLOW_GAP), y: 0 },
            width: FLOW_NODE_WIDTH,
            height: FLOW_NODE_HEIGHT,
            measured: { width: FLOW_NODE_WIDTH, height: FLOW_NODE_HEIGHT },
            data,
        };
    });

    const edges: Edge[] = nodes.slice(1).map((n, i) => ({
        id: `step-edge-${i}`,
        source: nodes[i].id,
        target: n.id,
        type: 'straight',
    }));

    return { nodes, edges };
}
