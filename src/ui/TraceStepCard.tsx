import { Handle, type NodeProps, Position } from '@xyflow/react';
import { type CSSProperties, useState } from 'react';
import type { TraceStepData } from './flowLayout';
import { formatDuration, groupColor } from './utils';

export interface TraceStepRenderData extends TraceStepData {
    isSelected: boolean;
    onOpenShot: (data: TraceStepData, sha1: string) => void;
}

export function TraceStepCard({ data }: NodeProps) {
    const d = data as TraceStepRenderData;
    const { visit } = d;
    const [pickedSha1, setPickedSha1] = useState<string | null>(null);
    const previewShot =
        d.frames.find(f => f.shot.sha1 === pickedSha1)?.shot ?? visit.screenshots[visit.screenshots.length - 1];
    const style = { '--group-color': groupColor(d.colorIndex) } as CSSProperties;

    return (
        <div className={`trace-step${d.isSelected ? ' trace-step--selected' : ''}`} style={style}>
            <Handle type="target" position={Position.Left} className="route-node-handle" />

            <div className="trace-step-header">
                <span className="trace-step-index">{d.index + 1}</span>
                <span className="trace-step-label" title={visit.url}>{d.label}</span>
                <span className="trace-step-meta">
                    {formatDuration(visit.duration)}
                    {visit.hasErrors && <span className="route-node-error" title="Had errors" />}
                </span>
            </div>

            <div className="trace-step-preview">
                {previewShot ? (
                    <img src={previewShot.url} alt="" className="trace-step-preview-img" draggable={false} />
                ) : (
                    <span className="route-node-preview-empty">No screenshot</span>
                )}
            </div>

            <div className="trace-step-frames nodrag nowheel">
                {d.frames.length === 0 ? (
                    <span className="trace-step-frames-empty">No action frames</span>
                ) : (
                    d.frames.map(f => (
                        <button
                            key={f.shot.sha1}
                            type="button"
                            className={`trace-step-frame${f.shot.sha1 === pickedSha1 ? ' trace-step-frame--active' : ''}`}
                            title={f.title}
                            aria-pressed={f.shot.sha1 === pickedSha1}
                            onClick={e => {
                                e.stopPropagation();
                                setPickedSha1(f.shot.sha1);
                                d.onOpenShot(d, f.shot.sha1);
                            }}
                        >
                            <img src={f.shot.url} alt={f.title} draggable={false} />
                        </button>
                    ))
                )}
            </div>

            <Handle type="source" position={Position.Right} className="route-node-handle" />
        </div>
    );
}
