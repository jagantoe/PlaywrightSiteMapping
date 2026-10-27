import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import type { LoadedTrace } from './trace/contracts';
import { buildJourney } from './trace/journeyBuilder';
import { parseTraceFile } from './trace/parser';
import { expandTraceBundles } from './trace/bundle';
import { buildRouteGraph } from './trace/routeGraph';
import {
    type CollectedShot,
    type CollectionApi,
    CollectionContext,
    type FocusRequest,
    loadCollection,
    saveCollection,
    shotKey,
} from './ui/collection';
import NodeDetail from './ui/NodeDetail';
import RouteGraphView from './ui/RouteGraphView';
import ScreenshotCollection from './ui/ScreenshotCollection';
import TraceFlowView from './ui/TraceFlowView';
import TraceSwitcher from './ui/TraceSwitcher';
import TraceUpload from './ui/TraceUpload';
import { traceColor } from './ui/utils';
import { loadViewState, saveViewState } from './ui/viewStore';

type Theme = 'dark' | 'light';
type MapMode = 'routes' | 'flow';

const MIN_DETAIL_WIDTH = 360;
const MAX_DETAIL_RATIO = 0.7;
const DEFAULT_DETAIL_WIDTH = 560;

function clampDetailWidth(width: number): number {
    return Math.round(Math.max(MIN_DETAIL_WIDTH, Math.min(window.innerWidth * MAX_DETAIL_RATIO, width)));
}

export default function App() {
    const [traces, setTraces] = useState<LoadedTrace[]>([]);
    const [activeTraceId, setActiveTraceId] = useState<string | null>(null);
    const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [detailCollapsed, setDetailCollapsed] = useState(false);
    const [detailWidth, setDetailWidth] = useState(() => {
        const saved = Number(localStorage.getItem('detailWidth'));
        return Number.isFinite(saved) && saved > 0 ? clampDetailWidth(saved) : DEFAULT_DETAIL_WIDTH;
    });
    const [collection, setCollection] = useState<CollectedShot[]>(loadCollection);
    const [collectionOpen, setCollectionOpen] = useState(false);
    const [focus, setFocus] = useState<FocusRequest | null>(null);
    const [viewState, setViewState] = useState(loadViewState);
    const [mapMode, setMapMode] = useState<MapMode>(
        () => (localStorage.getItem('mapMode') === 'flow' ? 'flow' : 'routes'),
    );
    const [theme, setTheme] = useState<Theme>(
        () => (localStorage.getItem('theme') as Theme | null) ?? 'dark',
    );

    useEffect(() => saveViewState(viewState), [viewState]);
    useEffect(() => localStorage.setItem('mapMode', mapMode), [mapMode]);

    const activeView = viewState.views.find(v => v.id === viewState.activeViewId) ?? viewState.views[0];

    // Move a route into a custom group (key) or back to its origin's default group (null).
    // Its saved position is dropped so it is re-placed next to its new group.
    const assignGroup = useCallback((nodeId: string, key: string | null) => {
        setViewState(s => ({
            ...s,
            views: s.views.map(v => {
                if (v.id !== s.activeViewId) return v;
                const groups = { ...v.groups };
                if (key) groups[nodeId] = key;
                else delete groups[nodeId];
                const nodes = { ...v.nodes };
                delete nodes[nodeId];
                return { ...v, groups, nodes, updatedAt: Date.now() };
            }),
        }));
    }, []);

    // Apply the selected theme to <html> and persist it.
    useEffect(() => {
        document.documentElement.dataset.theme = theme;
        localStorage.setItem('theme', theme);
    }, [theme]);

    const toggleTheme = useCallback(
        () => setTheme(t => (t === 'dark' ? 'light' : 'dark')),
        [],
    );

    useEffect(() => saveCollection(collection), [collection]);

    const collectionApi = useMemo<CollectionApi>(() => {
        const keys = new Set(collection.map(s => shotKey(s.traceFileName, s.sha1)));
        return {
            isCollected: (traceFileName, sha1) => keys.has(shotKey(traceFileName, sha1)),
            toggle: shot => {
                const key = shotKey(shot.traceFileName, shot.sha1);
                setCollection(prev =>
                    prev.some(s => shotKey(s.traceFileName, s.sha1) === key)
                        ? prev.filter(s => shotKey(s.traceFileName, s.sha1) !== key)
                        : [...prev, { ...shot, addedAt: Date.now() }],
                );
            },
        };
    }, [collection]);

    const removeFromCollection = useCallback(
        (key: string) => setCollection(prev => prev.filter(s => shotKey(s.traceFileName, s.sha1) !== key)),
        [],
    );
    const clearCollection = useCallback(() => setCollection([]), []);
    const closeCollection = useCallback(() => setCollectionOpen(false), []);

    // Drag the splitter between the route map and the details pane.
    const startResize = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
        e.preventDefault();
        const target = e.currentTarget;
        target.setPointerCapture(e.pointerId);
        let latest = 0;
        const onMove = (ev: PointerEvent) => {
            latest = clampDetailWidth(window.innerWidth - ev.clientX);
            setDetailWidth(latest);
        };
        // Fires on pointerup and pointercancel once capture is released.
        const onEnd = () => {
            target.removeEventListener('pointermove', onMove);
            target.removeEventListener('lostpointercapture', onEnd);
            if (latest) localStorage.setItem('detailWidth', String(latest));
        };
        target.addEventListener('pointermove', onMove);
        target.addEventListener('lostpointercapture', onEnd);
    }, []);

    // Monotonic counter so trace ids/colors stay stable across add/remove.
    const nextIndexRef = useRef(0);
    // Hidden input used by the "Add trace" button in the legend.
    const addInputRef = useRef<HTMLInputElement>(null);

    const addFiles = useCallback(async (files: File[]) => {
        setIsLoading(true);
        setLoadError(null);
        const loaded: LoadedTrace[] = [];
        const errors: string[] = [];
        try {
            files = await expandTraceBundles(files);
        } catch (err) {
            errors.push(err instanceof Error ? err.message : 'Failed to read zip');
        }
        for (const file of files) {
            const blobUrl = URL.createObjectURL(file);
            try {
                const parsed = await parseTraceFile(file);
                const journey = buildJourney(parsed);
                const index = nextIndexRef.current++;
                loaded.push({
                    traceId: `trace-${index}`,
                    fileName: file.name,
                    traceUrl: blobUrl,
                    color: traceColor(index),
                    journey,
                });
            } catch (err) {
                URL.revokeObjectURL(blobUrl);
                errors.push(`${file.name}: ${err instanceof Error ? err.message : 'parse failed'}`);
            }
        }
        if (loaded.length > 0) {
            setTraces(prev => [...prev, ...loaded]);
            setActiveTraceId(curr => curr ?? loaded[0].traceId);
        }
        if (errors.length > 0) setLoadError(errors.join('\n'));
        setIsLoading(false);
    }, []);

    const removeTrace = useCallback((traceId: string) => {
        setTraces(prev => {
            const target = prev.find(t => t.traceId === traceId);
            if (target) URL.revokeObjectURL(target.traceUrl);
            const next = prev.filter(t => t.traceId !== traceId);
            setActiveTraceId(curr => (curr === traceId ? (next[0]?.traceId ?? null) : curr));
            return next;
        });
        setSelectedNodeId(null);
    }, []);

    const handleReset = useCallback(() => {
        traces.forEach(t => URL.revokeObjectURL(t.traceUrl));
        setTraces([]);
        setActiveTraceId(null);
        setSelectedNodeId(null);
        setLoadError(null);
    }, [traces]);

    const triggerAdd = useCallback(() => addInputRef.current?.click(), []);

    const onAddInputChange = useCallback(
        (e: React.ChangeEvent<HTMLInputElement>) => {
            const zips = Array.from(e.target.files ?? []).filter(f => f.name.endsWith('.zip'));
            if (zips.length > 0) void addFiles(zips);
            e.target.value = '';
        },
        [addFiles],
    );

    const graph = useMemo(() => buildRouteGraph(traces, activeView.groups), [traces, activeView.groups]);

    const traceColorMap = useMemo(() => {
        const map: Record<string, string> = {};
        for (const t of traces) map[t.traceId] = t.color;
        return map;
    }, [traces]);

    const activeColor =
        traces.find(t => t.traceId === activeTraceId)?.color ?? 'var(--color-accent)';
    const activeTrace = traces.find(t => t.traceId === activeTraceId);

    const selectedNode = selectedNodeId
        ? graph.nodes.find(n => n.nodeId === selectedNodeId)
        : undefined;

    const navigateToShot = useCallback((item: CollectedShot) => {
        const trace = traces.find(t => t.fileName === item.traceFileName);
        if (!trace) return;
        const visit = trace.journey.visits.find(v => v.screenshots.some(s => s.sha1 === item.sha1));
        if (!visit) return;
        const node = graph.nodes.find(n => n.traceVisits.get(trace.traceId)?.includes(visit));
        if (!node) return;
        setSelectedNodeId(node.nodeId);
        setDetailCollapsed(false);
        setCollectionOpen(false);
        setFocus({ traceId: trace.traceId, visitId: visit.visitId, sha1: item.sha1, nonce: Date.now() });
    }, [traces, graph]);

    const openVisit = useCallback((nodeId: string, traceId: string, visitId: string, sha1?: string) => {
        setSelectedNodeId(nodeId);
        setDetailCollapsed(false);
        setFocus({ traceId, visitId, sha1, nonce: Date.now() });
    }, []);

    // ── Upload screen ──────────────────────────────────────────────────────────
    if (traces.length === 0) {
        return (
            <div className="app app--upload">
                <button
                    type="button"
                    className="app-theme-btn app-theme-btn--floating"
                    onClick={toggleTheme}
                    title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
                    aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
                >
                    {theme === 'dark' ? '☀' : '☾'}
                </button>
                <div className="upload-header">
                    <h1 className="app-logo">Playwright Trace URL Overview</h1>
                    <p className="app-subtitle">
                        Upload one or more traces to explore a mind map of the routes they visited
                    </p>
                </div>
                <TraceUpload onFiles={addFiles} isLoading={isLoading} error={loadError} />
            </div>
        );
    }

    // ── Viewer screen ──────────────────────────────────────────────────────────
    return (
        <div className="app app--viewer">
            <input
                ref={addInputRef}
                type="file"
                accept=".zip"
                multiple
                style={{ display: 'none' }}
                onChange={onAddInputChange}
            />

            {/* ─ App header ──────────────────────────────────── */}
            <header className="app-header">
                <div className="app-header-left">
                    <span className="app-header-logo">Playwright Trace URL Overview</span>
                    <span className="app-header-title">
                        {traces.length} trace{traces.length === 1 ? '' : 's'} ·{' '}
                        {graph.nodes.length} routes
                    </span>
                </div>
                <div className="app-header-right">
                    <TraceSwitcher
                        traces={traces}
                        activeTraceId={activeTraceId}
                        onSetActive={setActiveTraceId}
                        onRemove={removeTrace}
                        onAddTrace={triggerAdd}
                        isLoading={isLoading}
                    />
                    <button
                        type="button"
                        className={`app-collection-btn${collectionOpen ? ' app-collection-btn--open' : ''}`}
                        onClick={() => setCollectionOpen(o => !o)}
                        aria-expanded={collectionOpen}
                        title="Screenshot collection"
                    >
                        Collection
                        <span className="app-collection-count">{collection.length}</span>
                    </button>
                    <button
                        type="button"
                        className="app-theme-btn"
                        onClick={toggleTheme}
                        title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
                        aria-label={
                            theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'
                        }
                    >
                        {theme === 'dark' ? '☀' : '☾'}
                    </button>
                    <button type="button" className="app-reset-btn" onClick={handleReset}>
                        Clear all
                    </button>
                </div>
            </header>

            {loadError && (
                <div className="app-load-error" role="alert">
                    {loadError}
                </div>
            )}

            <CollectionContext.Provider value={collectionApi}>
                <div className="app-main">
                    {/* ─ Route graph ─────────────────────────────── */}
                    <section className="panel graph-section">
                        <header className="panel-header">
                            <div className="map-mode-toggle" role="group" aria-label="Map mode">
                                <button
                                    type="button"
                                    className={`map-mode-btn${mapMode === 'routes' ? ' map-mode-btn--active' : ''}`}
                                    aria-pressed={mapMode === 'routes'}
                                    onClick={() => setMapMode('routes')}
                                >
                                    Route map
                                </button>
                                <button
                                    type="button"
                                    className={`map-mode-btn${mapMode === 'flow' ? ' map-mode-btn--active' : ''}`}
                                    aria-pressed={mapMode === 'flow'}
                                    onClick={() => setMapMode('flow')}
                                >
                                    Trace flow
                                </button>
                            </div>
                            <span className="panel-header-meta">
                                {mapMode === 'routes'
                                    ? 'Drag routes or group headers · snaps to grid'
                                    : activeTrace
                                        ? `${activeTrace.fileName} · ${activeTrace.journey.visits.length} steps`
                                        : 'No active trace'}
                            </span>
                        </header>
                        <div className="panel-body">
                            {graph.nodes.length === 0 ? (
                                <div className="journey-empty">
                                    No URL visits detected in these traces.
                                </div>
                            ) : mapMode === 'flow' ? (
                                activeTrace ? (
                                    <TraceFlowView
                                        trace={activeTrace}
                                        graph={graph}
                                        selectedNodeId={selectedNodeId}
                                        onOpen={openVisit}
                                    />
                                ) : (
                                    <div className="journey-empty">
                                        Select a trace in the header to see its flow.
                                    </div>
                                )
                            ) : (
                                <RouteGraphView
                                    graph={graph}
                                    activeTraceId={activeTraceId}
                                    activeColor={activeColor}
                                    traceColorMap={traceColorMap}
                                    selectedNodeId={selectedNodeId}
                                    onSelectNode={setSelectedNodeId}
                                    viewState={viewState}
                                    onViewStateChange={setViewState}
                                />
                            )}
                        </div>
                    </section>

                    {!detailCollapsed && (
                        <div
                            className="panel-splitter"
                            role="separator"
                            aria-orientation="vertical"
                            aria-label="Resize details pane"
                            onPointerDown={startResize}
                        />
                    )}

                    {/* ─ Node detail ─────────────────────────────── */}
                    <section
                        className={`panel detail-section${detailCollapsed ? ' detail-section--collapsed' : ''}`}
                        style={detailCollapsed ? undefined : { width: detailWidth }}
                    >
                        {detailCollapsed ? (
                            <button
                                type="button"
                                className="detail-rail"
                                onClick={() => setDetailCollapsed(false)}
                                title="Expand details"
                                aria-expanded={false}
                            >
                                <span className="panel-chevron">‹</span>
                                <span className="detail-rail-label">Details</span>
                            </button>
                        ) : (
                            <>
                                <header className="panel-header">
                                    <span className="panel-title">Details</span>
                                    <button
                                        type="button"
                                        className="panel-collapse-btn"
                                        onClick={() => setDetailCollapsed(true)}
                                        title="Collapse details"
                                        aria-expanded
                                    >
                                        ›
                                    </button>
                                </header>
                                <div className="panel-body detail-scroll">
                                    {selectedNode ? (
                                        <NodeDetail
                                            node={selectedNode}
                                            traces={traces}
                                            activeTraceId={activeTraceId}
                                            onSetActive={setActiveTraceId}
                                            tracePaths={graph.tracePaths}
                                            onSelectNode={setSelectedNodeId}
                                            graphNodes={graph.nodes}
                                            groups={graph.groups}
                                            onAssignGroup={assignGroup}
                                            focus={focus}
                                        />
                                    ) : (
                                        <div className="detail-empty">
                                            Click a route in the map to see its details
                                        </div>
                                    )}
                                </div>
                            </>
                        )}
                    </section>

                    {collectionOpen && (
                        <ScreenshotCollection
                            items={collection}
                            traces={traces}
                            onRemove={removeFromCollection}
                            onClear={clearCollection}
                            onNavigate={navigateToShot}
                            onClose={closeCollection}
                        />
                    )}
                </div>
            </CollectionContext.Provider>
        </div>
    );
}
