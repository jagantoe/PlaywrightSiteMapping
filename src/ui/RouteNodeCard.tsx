import { Handle, type NodeProps, Position } from '@xyflow/react';
import type { CSSProperties } from 'react';
import type { GroupNodeData, RouteNodeData } from './layoutShared';
import { groupColor } from './utils';

/** Dynamic fields merged into node data by RouteGraphView each render. */
export interface RouteNodeRenderData extends RouteNodeData {
    /** Map of traceId → palette color (for the per-trace dots) */
    traceColorMap: Record<string, string>;
    /** Step numbers (1-based) where the active trace visited this route — empty if not on path */
    sequence: number[];
    /** True if this node lies on the active trace's path */
    onActivePath: boolean;
    /** True if this node is the currently selected one */
    isSelected: boolean;
    /** Blob URL of the route's preview screenshot (last frame of its last visit) */
    previewUrl?: string;
}

export function RouteNodeCard({ data }: NodeProps) {
    const d = data as RouteNodeRenderData;
    const classes = [
        'route-node',
        d.onActivePath ? 'route-node--active' : 'route-node--dim',
        d.isSelected ? 'route-node--selected' : '',
    ]
        .filter(Boolean)
        .join(' ');

    // Cap the visible dots so many traces don't overflow the card.
    const MAX_DOTS = 8;
    const visibleIds = d.traceIds.slice(0, MAX_DOTS);
    const overflow = d.traceIds.length - visibleIds.length;

    return (
        <div className={classes}>
            <Handle type="target" position={Position.Left} className="route-node-handle" />

            {d.sequence.length > 0 && (
                <span
                    className="route-node-seq"
                    title={`Visited at step ${d.sequence.join(', ')} in the active trace`}
                >
                    {d.sequence.join(',')}
                </span>
            )}

            <div className="route-node-preview">
                {d.previewUrl ? (
                    <img src={d.previewUrl} alt="" className="route-node-preview-img" draggable={false} />
                ) : (
                    <span className="route-node-preview-empty">No screenshot</span>
                )}
            </div>

            <div className="route-node-body">
                <span className="route-node-label" title={d.nodeId}>
                    {d.label}
                </span>
                <div className="route-node-meta">
                    <div className="route-node-dots" title={`${d.traceIds.length} traces visited this route`}>
                        {visibleIds.map(id => (
                            <span
                                key={id}
                                className="route-node-dot"
                                style={{ background: d.traceColorMap[id] ?? '#888' }}
                                title={id}
                            />
                        ))}
                        {overflow > 0 && (
                            <span className="route-node-dot-more">+{overflow}</span>
                        )}
                    </div>
                    {d.hasErrors && <span className="route-node-error" title="Had errors" />}
                </div>
            </div>

            <Handle type="source" position={Position.Right} className="route-node-handle" />
        </div>
    );
}

export function OriginGroupNode({ data }: NodeProps) {
    const d = data as GroupNodeData;
    const style = { '--group-color': groupColor(d.colorIndex) } as CSSProperties;
    return (
        <div className="origin-group" style={style}>
            <span className="origin-group-label" title={`${d.origin}${d.base} — drag to move the group`}>
                <span className="origin-group-origin">{d.origin}</span>
                {d.base && <span className="origin-group-base">{d.base}</span>}
                <span className="origin-group-count">{d.count}</span>
            </span>
        </div>
    );
}
