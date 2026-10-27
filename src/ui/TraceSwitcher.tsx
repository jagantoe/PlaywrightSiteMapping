import { useEffect, useRef, useState } from 'react';
import type { LoadedTrace } from '../trace/contracts';

interface Props {
    traces: LoadedTrace[];
    activeTraceId: string | null;
    onSetActive: (traceId: string) => void;
    onRemove: (traceId: string) => void;
    onAddTrace: () => void;
    isLoading?: boolean;
}

/** Header dropdown to switch the highlighted trace, remove traces, or add more. */
export default function TraceSwitcher({ traces, activeTraceId, onSetActive, onRemove, onAddTrace, isLoading }: Props) {
    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent) => {
            if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setOpen(false);
        };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDown);
            document.removeEventListener('keydown', onKey);
        };
    }, [open]);

    const active = traces.find(t => t.traceId === activeTraceId) ?? null;

    return (
        <div className="trace-switcher" ref={rootRef}>
            <button
                type="button"
                className="trace-switcher-trigger"
                onClick={() => setOpen(o => !o)}
                aria-haspopup="listbox"
                aria-expanded={open}
                title={active?.fileName ?? 'Select the active trace'}
            >
                {active && <span className="trace-switcher-chip" style={{ background: active.color }} />}
                <span className="trace-switcher-name">{active?.fileName ?? 'Select trace'}</span>
                <span className="trace-switcher-count">{traces.length}</span>
                <span className="trace-switcher-caret">{open ? '▴' : '▾'}</span>
            </button>

            {open && (
                <div className="trace-switcher-menu" role="listbox" aria-label="Loaded traces">
                    {traces.map(t => {
                        const isActive = t.traceId === activeTraceId;
                        return (
                            <div
                                key={t.traceId}
                                className={`trace-switcher-item${isActive ? ' trace-switcher-item--active' : ''}`}
                                role="option"
                                aria-selected={isActive}
                            >
                                <button
                                    type="button"
                                    className="trace-switcher-select"
                                    onClick={() => {
                                        onSetActive(t.traceId);
                                        setOpen(false);
                                    }}
                                    title={t.fileName}
                                >
                                    <span className="trace-switcher-chip" style={{ background: t.color }} />
                                    <span className="trace-switcher-item-name">{t.fileName}</span>
                                    {isActive && <span className="trace-switcher-badge">active</span>}
                                </button>
                                <button
                                    type="button"
                                    className="trace-switcher-remove"
                                    onClick={() => onRemove(t.traceId)}
                                    aria-label={`Remove ${t.fileName}`}
                                    title="Remove trace"
                                >
                                    ×
                                </button>
                            </div>
                        );
                    })}
                    <button
                        type="button"
                        className="trace-switcher-add"
                        onClick={() => {
                            onAddTrace();
                            setOpen(false);
                        }}
                        disabled={isLoading}
                    >
                        {isLoading ? 'Loading…' : '+ Add trace'}
                    </button>
                </div>
            )}
        </div>
    );
}
