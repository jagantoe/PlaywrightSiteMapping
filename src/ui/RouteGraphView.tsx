import {
    Background,
    BackgroundVariant,
    Controls,
    type Edge,
    MarkerType,
    MiniMap,
    type Node,
    type NodeChange,
    type NodeMouseHandler,
    ReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
    type ChangeEvent,
    type Dispatch,
    type KeyboardEvent,
    type SetStateAction,
    useCallback,
    useMemo,
    useRef,
    useState,
} from 'react';
import type { RouteGraph } from '../trace/contracts';
import {
    GRID,
    GROUP_HEADER,
    GROUP_NODE_PREFIX,
    GROUP_PADDING,
    type Point,
    buildFlowElements,
    resolvePositions,
} from './graphLayout';
import { OriginGroupNode, RouteNodeCard, type RouteNodeRenderData } from './RouteNodeCard';
import { lastRouteScreenshot } from './utils';
import {
    type RouteView,
    type SavedPositions,
    type ViewState,
    createView,
    exportView,
    parseViewFile,
    uniqueViewName,
} from './viewStore';

interface Props {
    graph: RouteGraph;
    /** Currently highlighted trace */
    activeTraceId: string | null;
    /** Color for the active trace's path/edges */
    activeColor: string;
    /** traceId → palette color */
    traceColorMap: Record<string, string>;
    selectedNodeId: string | null;
    onSelectNode: (nodeId: string) => void;
    /** Saved views (owned by App because group assignments affect the graph) */
    viewState: ViewState;
    onViewStateChange: Dispatch<SetStateAction<ViewState>>;
}

const nodeTypes = {
    routeNode: RouteNodeCard,
    originGroup: OriginGroupNode,
};

export default function RouteGraphView({
    graph,
    activeTraceId,
    activeColor,
    traceColorMap,
    selectedNodeId,
    onSelectNode,
    viewState,
    onViewStateChange: setViewState,
}: Props) {
    const activeView = viewState.views.find(v => v.id === viewState.activeViewId) ?? viewState.views[0];

    // Bumped to remount React Flow so fitView re-runs (view switch / reset).
    const [fitNonce, setFitNonce] = useState(0);
    const [renaming, setRenaming] = useState<string | null>(null);
    const [viewError, setViewError] = useState<string | null>(null);
    const [locked, setLocked] = useState(() => localStorage.getItem('mapLocked') === 'true');
    const importInputRef = useRef<HTMLInputElement>(null);

    const toggleLocked = () => {
        const next = !locked;
        setLocked(next);
        localStorage.setItem('mapLocked', String(next));
    };

    const resolved = useMemo(() => resolvePositions(graph, activeView.nodes), [graph, activeView.nodes]);

    // Live positions while dragging; committed to the view on drag stop.
    const [overrides, setOverrides] = useState<Map<string, Point>>(() => new Map());
    const overridesRef = useRef(overrides);
    const updateOverrides = (next: Map<string, Point>) => {
        overridesRef.current = next;
        setOverrides(next);
    };

    const positions = useMemo(() => {
        if (overrides.size === 0) return resolved;
        const merged = new Map(resolved);
        for (const [id, p] of overrides) merged.set(id, p);
        return merged;
    }, [resolved, overrides]);

    const layout = useMemo(() => buildFlowElements(graph, positions), [graph, positions]);

    const updateActiveView = useCallback((update: (view: RouteView) => RouteView) => {
        setViewState(s => ({
            ...s,
            views: s.views.map(v => (v.id === s.activeViewId ? { ...update(v), updatedAt: Date.now() } : v)),
        }));
    }, [setViewState]);

    const currentPositionsObject = (): SavedPositions => Object.fromEntries(positions);

    // The active trace's ordered path, and the step numbers per node.
    const { activePathSet, sequenceByNode } = useMemo(() => {
        const set = new Set<string>();
        const seq = new Map<string, number[]>();
        const path = activeTraceId ? graph.tracePaths.get(activeTraceId) : undefined;
        if (path) {
            path.forEach((nodeId, i) => {
                set.add(nodeId);
                const arr = seq.get(nodeId) ?? [];
                arr.push(i + 1);
                seq.set(nodeId, arr);
            });
        }
        return { activePathSet: set, sequenceByNode: seq };
    }, [graph, activeTraceId]);

    // Which edges the active trace traversed.
    const activeEdgeIds = useMemo(() => {
        const set = new Set<string>();
        if (activeTraceId) {
            for (const e of graph.edges) {
                if (e.traceIds.has(activeTraceId)) set.add(e.id);
            }
        }
        return set;
    }, [graph, activeTraceId]);

    const previewByNode = useMemo(() => {
        const map = new Map<string, string>();
        for (const node of graph.nodes) {
            const shot = lastRouteScreenshot(node, activeTraceId);
            if (shot) map.set(node.nodeId, shot.url);
        }
        return map;
    }, [graph, activeTraceId]);

    const nodes: Node[] = useMemo(
        () =>
            layout.nodes.map(n => {
                if (n.type !== 'routeNode') return n;
                const renderData: RouteNodeRenderData = {
                    ...(n.data as RouteNodeRenderData),
                    traceColorMap,
                    sequence: sequenceByNode.get(n.id) ?? [],
                    onActivePath: activePathSet.has(n.id),
                    isSelected: n.id === selectedNodeId,
                    previewUrl: previewByNode.get(n.id),
                };
                return { ...n, data: renderData };
            }),
        [layout.nodes, activePathSet, sequenceByNode, traceColorMap, selectedNodeId, previewByNode],
    );

    const edges: Edge[] = useMemo(
        () =>
            layout.edges.map(e => {
                const active = activeEdgeIds.has(e.id);
                return {
                    ...e,
                    animated: active,
                    style: {
                        stroke: active ? activeColor : 'var(--border)',
                        strokeWidth: active ? 2.5 : 1,
                        opacity: active ? 1 : 0.35,
                    },
                    markerEnd: {
                        type: MarkerType.ArrowClosed,
                        color: active ? activeColor : 'var(--border)',
                        width: 16,
                        height: 16,
                    },
                    zIndex: active ? 10 : 0,
                };
            }),
        [layout.edges, activeEdgeIds, activeColor],
    );

    const handleNodesChange = (changes: NodeChange[]) => {
        let next: Map<string, Point> | null = null;
        const current = (id: string) => next?.get(id) ?? overridesRef.current.get(id) ?? resolved.get(id);

        for (const change of changes) {
            if (change.type !== 'position' || !change.position) continue;
            next ??= new Map(overridesRef.current);

            if (change.id.startsWith(GROUP_NODE_PREFIX)) {
                // Group boxes are derived from their routes, so moving a box moves its routes.
                const groupId = change.id.slice(GROUP_NODE_PREFIX.length);
                const members = graph.nodes.filter(n => n.groupId === groupId);
                const pts = members.map(n => current(n.nodeId)).filter((p): p is Point => !!p);
                if (pts.length === 0) continue;
                const boxX = Math.min(...pts.map(p => p.x)) - GROUP_PADDING;
                const boxY = Math.min(...pts.map(p => p.y)) - GROUP_PADDING - GROUP_HEADER;
                const dx = change.position.x - boxX;
                const dy = change.position.y - boxY;
                if (dx === 0 && dy === 0) continue;
                for (const n of members) {
                    const p = current(n.nodeId);
                    if (p) next.set(n.nodeId, { x: p.x + dx, y: p.y + dy });
                }
            } else {
                next.set(change.id, { x: change.position.x, y: change.position.y });
            }
        }
        if (next) updateOverrides(next);
    };

    const handleNodeDragStop = () => {
        if (overridesRef.current.size === 0) return;
        const committed: SavedPositions = Object.fromEntries(resolved);
        for (const [id, p] of overridesRef.current) committed[id] = p;
        updateActiveView(v => ({ ...v, nodes: { ...v.nodes, ...committed } }));
        updateOverrides(new Map());
    };

    const handleNodeClick: NodeMouseHandler = (_evt, node) => {
        if (node.type === 'routeNode') onSelectNode(node.id);
    };

    // ── View management ────────────────────────────────────────────────
    const switchView = (id: string) => {
        updateOverrides(new Map());
        setViewState(s => ({ ...s, activeViewId: id }));
        setFitNonce(n => n + 1);
    };

    const addView = (view: RouteView) => {
        updateOverrides(new Map());
        setViewState(s => ({ activeViewId: view.id, views: [...s.views, view] }));
        setFitNonce(n => n + 1);
    };

    const handleNew = () => addView(createView(uniqueViewName('New view', viewState.views)));

    const handleDuplicate = () =>
        addView(createView(
            uniqueViewName(`${activeView.name} copy`, viewState.views),
            { ...activeView.nodes, ...currentPositionsObject() },
            { ...activeView.groups },
        ));

    const handleDelete = () => {
        if (viewState.views.length <= 1) return;
        if (!window.confirm(`Delete view "${activeView.name}"?`)) return;
        updateOverrides(new Map());
        setViewState(s => {
            const views = s.views.filter(v => v.id !== s.activeViewId);
            return { activeViewId: views[0].id, views };
        });
        setFitNonce(n => n + 1);
    };

    const handleReset = () => {
        updateOverrides(new Map());
        updateActiveView(v => {
            const nodesLeft = { ...v.nodes };
            for (const n of graph.nodes) delete nodesLeft[n.nodeId];
            return { ...v, nodes: nodesLeft };
        });
        setFitNonce(n => n + 1);
    };

    const commitRename = () => {
        if (renaming === null) return;
        const name = renaming.trim().slice(0, 100);
        if (name && name !== activeView.name) {
            const others = viewState.views.filter(v => v.id !== activeView.id);
            updateActiveView(v => ({ ...v, name: uniqueViewName(name, others) }));
        }
        setRenaming(null);
    };

    const handleRenameKey = (e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') commitRename();
        else if (e.key === 'Escape') setRenaming(null);
    };

    const handleExport = () =>
        exportView({ ...activeView, nodes: { ...activeView.nodes, ...currentPositionsObject() } });

    const handleImport = async (e: ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        try {
            const { name, nodes: imported, groups } = await parseViewFile(file);
            setViewError(null);
            addView(createView(uniqueViewName(name, viewState.views), imported, groups));
        } catch (err) {
            setViewError(err instanceof Error ? err.message : 'Could not import view.');
        }
    };

    return (
        <div className={`route-graph${locked ? ' route-graph--locked' : ''}`}>
            <button
                type="button"
                className={`map-lock-btn${locked ? ' map-lock-btn--on' : ''}`}
                onClick={toggleLocked}
                aria-pressed={locked}
                aria-label={locked ? 'Unlock route map' : 'Lock route map'}
                title={locked ? 'Locked — click to allow dragging' : 'Unlocked — click to prevent dragging'}
            >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                    <rect x="3" y="7" width="10" height="7" rx="1.5" />
                    <path d={locked ? 'M5 7V5a3 3 0 0 1 6 0v2' : 'M5 7V5a3 3 0 0 1 5.8-1'} strokeLinecap="round" />
                </svg>
            </button>
            <div className="view-toolbar" role="toolbar" aria-label="Route map views">
                {renaming !== null ? (
                    <input
                        className="view-toolbar-input"
                        value={renaming}
                        autoFocus
                        maxLength={100}
                        aria-label="View name"
                        onChange={e => setRenaming(e.target.value)}
                        onBlur={commitRename}
                        onKeyDown={handleRenameKey}
                    />
                ) : (
                    <select
                        className="view-toolbar-select"
                        value={activeView.id}
                        aria-label="Active view"
                        onChange={e => switchView(e.target.value)}
                    >
                        {viewState.views.map(v => (
                            <option key={v.id} value={v.id}>{v.name}</option>
                        ))}
                    </select>
                )}
                <button type="button" className="view-toolbar-btn" onClick={handleNew} title="New view starting from the auto-layout">
                    New
                </button>
                <button type="button" className="view-toolbar-btn" onClick={handleDuplicate} title="Duplicate this view">
                    Duplicate
                </button>
                <button type="button" className="view-toolbar-btn" onClick={() => setRenaming(activeView.name)} title="Rename this view">
                    Rename
                </button>
                <button
                    type="button"
                    className="view-toolbar-btn"
                    onClick={handleDelete}
                    disabled={viewState.views.length <= 1}
                    title="Delete this view"
                >
                    Delete
                </button>
                <span className="view-toolbar-sep" />
                <button type="button" className="view-toolbar-btn" onClick={handleReset} title="Reset the loaded routes to the auto-layout">
                    Reset layout
                </button>
                <button type="button" className="view-toolbar-btn" onClick={handleExport} title="Export this view as JSON">
                    Export
                </button>
                <button type="button" className="view-toolbar-btn" onClick={() => importInputRef.current?.click()} title="Import a view from JSON">
                    Import
                </button>
                <input
                    ref={importInputRef}
                    type="file"
                    accept=".json,application/json"
                    style={{ display: 'none' }}
                    onChange={handleImport}
                />
            </div>
            {viewError && (
                <div className="view-toolbar-error" role="alert">
                    {viewError}
                    <button type="button" onClick={() => setViewError(null)} aria-label="Dismiss">×</button>
                </div>
            )}
            <ReactFlow
                key={`${activeView.id}-${fitNonce}`}
                nodes={nodes}
                edges={edges}
                nodeTypes={nodeTypes}
                onNodesChange={handleNodesChange}
                onNodeDragStop={handleNodeDragStop}
                onNodeClick={handleNodeClick}
                nodesDraggable={!locked}
                nodesConnectable={false}
                elementsSelectable={false}
                snapToGrid
                snapGrid={[GRID, GRID]}
                fitView
                minZoom={0.2}
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
                    nodeColor={n =>
                        n.type === 'originGroup' ? 'var(--color-accent-subtle)' : 'var(--text-muted)'
                    }
                    nodeStrokeColor={n =>
                        n.type === 'originGroup' ? 'var(--border)' : 'var(--text-secondary)'
                    }
                    nodeStrokeWidth={3}
                    nodeBorderRadius={3}
                    style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}
                />
            </ReactFlow>
        </div>
    );
}
