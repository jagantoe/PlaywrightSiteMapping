import {
    Background,
    BackgroundVariant,
    Controls,
    type Edge,
    MarkerType,
    MiniMap,
    type Node,
    type NodeMouseHandler,
    ReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCallback, useMemo } from 'react';
import type { LoadedTrace, RouteGraph } from '../trace/contracts';
import { type TraceStepData, buildTraceFlowElements } from './flowLayout';
import { GRID } from './layoutShared';
import { TraceStepCard, type TraceStepRenderData } from './TraceStepCard';

interface Props {
    trace: LoadedTrace;
    graph: RouteGraph;
    selectedNodeId: string | null;
    /** Open a visit (optionally on a specific frame) in the details pane */
    onOpen: (nodeId: string, traceId: string, visitId: string, sha1?: string) => void;
}

const nodeTypes = { traceStep: TraceStepCard };

/** Initial fit covers only the first steps so long traces open at a readable zoom. */
const FIT_STEPS = 4;

export default function TraceFlowView({ trace, graph, selectedNodeId, onOpen }: Props) {
    const layout = useMemo(() => buildTraceFlowElements(trace, graph), [trace, graph]);

    const openShot = useCallback(
        (d: TraceStepData, sha1: string) => onOpen(d.nodeId, trace.traceId, d.visit.visitId, sha1),
        [onOpen, trace.traceId],
    );

    const nodes: Node[] = useMemo(
        () =>
            layout.nodes.map(n => {
                const d = n.data as TraceStepData;
                const renderData: TraceStepRenderData = {
                    ...d,
                    isSelected: d.nodeId === selectedNodeId,
                    onOpenShot: openShot,
                };
                return { ...n, data: renderData };
            }),
        [layout.nodes, selectedNodeId, openShot],
    );

    const edges: Edge[] = useMemo(
        () =>
            layout.edges.map(e => ({
                ...e,
                animated: true,
                style: { stroke: trace.color, strokeWidth: 2.5 },
                markerEnd: { type: MarkerType.ArrowClosed, color: trace.color, width: 16, height: 16 },
            })),
        [layout.edges, trace.color],
    );

    const fitNodes = useMemo(() => layout.nodes.slice(0, FIT_STEPS).map(n => ({ id: n.id })), [layout.nodes]);

    const handleNodeClick: NodeMouseHandler = (_evt, node) => {
        const d = node.data as TraceStepData;
        onOpen(d.nodeId, trace.traceId, d.visit.visitId);
    };

    return (
        <div className="route-graph trace-flow">
            <ReactFlow
                key={trace.traceId}
                nodes={nodes}
                edges={edges}
                nodeTypes={nodeTypes}
                onNodeClick={handleNodeClick}
                nodesDraggable={false}
                nodesConnectable={false}
                elementsSelectable={false}
                fitView
                fitViewOptions={{ nodes: fitNodes, padding: 0.1 }}
                minZoom={0.1}
                maxZoom={2}
                proOptions={{ hideAttribution: true }}
            >
                <Background variant={BackgroundVariant.Dots} gap={GRID} size={1.5} color="var(--border)" />
                <Controls showInteractive={false} />
                <MiniMap
                    pannable
                    zoomable
                    maskColor="var(--minimap-mask, rgba(13, 17, 23, 0.72))"
                    maskStrokeColor="var(--border)"
                    nodeColor="var(--text-muted)"
                    nodeStrokeColor="var(--text-secondary)"
                    nodeStrokeWidth={3}
                    nodeBorderRadius={3}
                    style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}
                />
            </ReactFlow>
        </div>
    );
}
