import { useEffect, useMemo, useRef, useState } from 'react';
import type { LoadedTrace, RouteGroup, RouteNode } from '../trace/contracts';
import type { FocusRequest } from './collection';
import { formatDuration } from './utils';
import VisitDetail from './VisitDetail';

const NEW_GROUP = '__new-group__';

interface Props {
    node: RouteNode;
    traces: LoadedTrace[];
    activeTraceId: string | null;
    /** Make the given trace the active (highlighted) one in the map */
    onSetActive: (traceId: string) => void;
    tracePaths: Map<string, string[]>;
    onSelectNode: (nodeId: string) => void;
    graphNodes: RouteNode[];
    groups: RouteGroup[];
    /** Move a route into a custom group (key) or back to its origin's default group (null) */
    onAssignGroup: (nodeId: string, key: string | null) => void;
    /** Request to show a specific trace/visit/screenshot (from the collection) */
    focus: FocusRequest | null;
}

export default function NodeDetail({
    node,
    traces,
    activeTraceId,
    onSetActive,
    tracePaths,
    onSelectNode,
    graphNodes,
    groups,
    onAssignGroup,
    focus,
}: Props) {
    // Traces that actually visited this route, in load order.
    const visitingTraces = useMemo(
        () => traces.filter(t => node.traceVisits.has(t.traceId)),
        [traces, node],
    );

    const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
    const [instanceIndex, setInstanceIndex] = useState(0);
    const [dropdownOpen, setDropdownOpen] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);
    // Carries the selected trace ID across node changes so prev/next navigation preserves it
    const selectedTraceIdRef = useRef<string | null>(null);
    selectedTraceIdRef.current = selectedTraceId;

    // When the node changes, try to preserve the current trace; fall back to active then first.
    useEffect(() => {
        const prev = selectedTraceIdRef.current;
        const def =
            (prev && node.traceVisits.has(prev))
                ? prev
                : activeTraceId && node.traceVisits.has(activeTraceId)
                    ? activeTraceId
                    : (visitingTraces[0]?.traceId ?? null);
        setSelectedTraceId(def);
        setInstanceIndex(0);
        setDropdownOpen(false);
    }, [node.nodeId]); // eslint-disable-line react-hooks/exhaustive-deps

    // Declared after the node-change effect so a focus request wins over its defaults.
    const handledFocusRef = useRef<number | null>(null);
    useEffect(() => {
        if (!focus || handledFocusRef.current === focus.nonce) return;
        const visits = node.traceVisits.get(focus.traceId);
        const idx = visits?.findIndex(v => v.visitId === focus.visitId) ?? -1;
        if (idx < 0) return;
        handledFocusRef.current = focus.nonce;
        setSelectedTraceId(focus.traceId);
        setInstanceIndex(idx);
    }, [focus, node]);

    // Close the dropdown on outside click or Escape.
    useEffect(() => {
        if (!dropdownOpen) return;
        const onDown = (e: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
                setDropdownOpen(false);
            }
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setDropdownOpen(false);
        };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDown);
            document.removeEventListener('keydown', onKey);
        };
    }, [dropdownOpen]);

    const selectedTrace = visitingTraces.find(t => t.traceId === selectedTraceId) ?? null;
    const instances = selectedTrace ? (node.traceVisits.get(selectedTrace.traceId) ?? []) : [];
    const safeIndex = Math.min(instanceIndex, Math.max(0, instances.length - 1));
    const visit = instances[safeIndex];

    // Prev/next route navigation within the selected trace's path
    const nodeById = useMemo(
        () => new Map(graphNodes.map(n => [n.nodeId, n])),
        [graphNodes],
    );
    const uniquePath = useMemo(() => {
        if (!selectedTraceId) return [] as string[];
        const path = tracePaths.get(selectedTraceId) ?? [];
        return path.filter((id, i) => path[i - 1] !== id);
    }, [tracePaths, selectedTraceId]);
    const currentIdx = uniquePath.indexOf(node.nodeId);
    const prevNode = currentIdx > 0 ? (nodeById.get(uniquePath[currentIdx - 1]) ?? null) : null;
    const nextNode = currentIdx >= 0 && currentIdx < uniquePath.length - 1
        ? (nodeById.get(uniquePath[currentIdx + 1]) ?? null)
        : null;

    // Groups of this route's origin, with member counts, for the group selector.
    const originGroups = useMemo(() => {
        const counts = new Map<string, number>();
        for (const n of graphNodes) counts.set(n.groupId, (counts.get(n.groupId) ?? 0) + 1);
        return groups
            .filter(g => g.origin === node.origin)
            .map(g => ({ group: g, count: counts.get(g.id) ?? 0 }));
    }, [groups, graphNodes, node.origin]);
    const ownGroupExists = originGroups.some(({ group }) => group.key === node.path);

    const handleGroupChange = (value: string) => {
        if (value === NEW_GROUP) {
            onAssignGroup(node.nodeId, node.path);
            return;
        }
        const target = groups.find(g => g.id === value);
        if (target) onAssignGroup(node.nodeId, target.key || null);
    };

    return (
        <div className="node-detail">
            <div className="node-detail-header">
                <div className="node-detail-title-row">
                    <span className="node-detail-route" title={visit?.url ?? node.nodeId}>
                        {node.label}
                    </span>
                    {visit && (
                        <span className="node-detail-stats">
                            {formatDuration(visit.duration)}
                            {visit.hasErrors && <span className="visit-badge visit-badge--error">Errors</span>}
                        </span>
                    )}
                </div>

                <div className="node-detail-trace-row">
                    <span className="node-detail-controls-label">Trace</span>
                    {/* Prev/next within the selected trace's path — flanking the dropdown */}
                    <button
                        type="button"
                        className="node-detail-nav-btn"
                        disabled={!prevNode}
                        onClick={() => prevNode && onSelectNode(prevNode.nodeId)}
                        title={prevNode ? `Previous: ${prevNode.label}` : undefined}
                        aria-label="Previous route"
                    >‹</button>
                    {/* Trace selector dropdown */}
                    <div className="node-detail-dropdown" ref={dropdownRef}>
                        <button
                            type="button"
                            className="node-detail-dropdown-trigger"
                            onClick={() => setDropdownOpen(o => !o)}
                            aria-expanded={dropdownOpen}
                            aria-haspopup="listbox"
                            title={selectedTrace?.fileName}
                        >
                            {selectedTrace && (
                                <span
                                    className="node-detail-trace-chip"
                                    style={{ background: selectedTrace.color }}
                                />
                            )}
                            <span className="node-detail-dropdown-name">
                                {selectedTrace?.fileName ?? 'Select trace'}
                            </span>
                            <span className="node-detail-dropdown-count">
                                {visitingTraces.length}
                            </span>
                            <span className="node-detail-dropdown-caret">
                                {dropdownOpen ? '▴' : '▾'}
                            </span>
                        </button>

                        {dropdownOpen && (
                            <div className="node-detail-dropdown-menu" role="listbox">
                                {visitingTraces.map(t => {
                                    const isSelected = t.traceId === selectedTraceId;
                                    const isActive = t.traceId === activeTraceId;
                                    return (
                                        <div
                                            key={t.traceId}
                                            className={`node-detail-trace-item${isSelected
                                                ? ' node-detail-trace-item--selected'
                                                : ''
                                                }`}
                                            role="option"
                                            aria-selected={isSelected}
                                        >
                                            <button
                                                type="button"
                                                className="node-detail-trace-btn"
                                                onClick={() => {
                                                    setSelectedTraceId(t.traceId);
                                                    setInstanceIndex(0);
                                                    setDropdownOpen(false);
                                                }}
                                                title={t.fileName}
                                            >
                                                <span
                                                    className="node-detail-trace-chip"
                                                    style={{ background: t.color }}
                                                />
                                                <span className="node-detail-trace-name">
                                                    {t.fileName}
                                                </span>
                                            </button>
                                            <button
                                                type="button"
                                                className={`node-detail-trace-active${isActive
                                                    ? ' node-detail-trace-active--on'
                                                    : ''
                                                    }`}
                                                onClick={() => onSetActive(t.traceId)}
                                                title={
                                                    isActive
                                                        ? 'Highlighted in the map'
                                                        : 'Highlight this trace in the map'
                                                }
                                                aria-pressed={isActive}
                                            >
                                                {isActive ? 'Active' : 'Highlight'}
                                            </button>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>

                    <button
                        type="button"
                        className="node-detail-nav-btn"
                        disabled={!nextNode}
                        onClick={() => nextNode && onSelectNode(nextNode.nodeId)}
                        title={nextNode ? `Next: ${nextNode.label}` : undefined}
                        aria-label="Next route"
                    >›</button>
                </div>

                {instances.length > 1 && (
                    <div className="node-detail-instances">
                        <span className="node-detail-controls-label">Visit</span>
                        {instances.map((_, i) => (
                            <button
                                key={i}
                                type="button"
                                className={`node-detail-instance-btn${i === safeIndex
                                    ? ' node-detail-instance-btn--active'
                                    : ''
                                    }`}
                                onClick={() => setInstanceIndex(i)}
                            >
                                #{i + 1}
                            </button>
                        ))}
                    </div>
                )}

                <div className="node-detail-group">
                    <label className="node-detail-controls-label" htmlFor="node-detail-group-select">
                        Group
                    </label>
                    <select
                        id="node-detail-group-select"
                        className="node-detail-group-select"
                        value={node.groupId}
                        onChange={e => handleGroupChange(e.target.value)}
                        title="Split this route into its own group, or move it to another group of this origin"
                    >
                        {originGroups.map(({ group, count }) => (
                            <option key={group.id} value={group.id}>
                                {group.key ? '' : 'Shared · '}
                                {group.base || '/'} ({count})
                            </option>
                        ))}
                        {!ownGroupExists && (
                            <option value={NEW_GROUP}>+ New group from this route</option>
                        )}
                    </select>
                </div>
            </div>

            {selectedTrace && visit ? (
                <VisitDetail
                    visit={visit}
                    traceStartTime={selectedTrace.journey.startTime}
                    allScreenshots={selectedTrace.journey.allScreenshots}
                    traceUrl={selectedTrace.traceUrl}
                    traceFileName={selectedTrace.fileName}
                    routeLabel={node.path}
                    visitNumber={safeIndex + 1}
                    focus={focus?.traceId === selectedTrace.traceId ? focus : null}
                />
            ) : (
                <div className="detail-empty">No visit data for this route.</div>
            )}
        </div>
    );
}
