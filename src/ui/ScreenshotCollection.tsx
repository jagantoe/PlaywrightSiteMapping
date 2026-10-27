import JSZip from 'jszip';
import { useEffect, useMemo, useState } from 'react';
import type { LoadedTrace, ScreenshotEntry } from '../trace/contracts';
import { type CollectedShot, shotKey } from './collection';
import { downloadBlob, formatDuration, imageExtension, toFileSlug } from './utils';

interface Props {
    items: CollectedShot[];
    traces: LoadedTrace[];
    onRemove: (key: string) => void;
    onClear: () => void;
    onNavigate: (item: CollectedShot) => void;
    onClose: () => void;
}

interface TraceGroup {
    traceFileName: string;
    trace?: LoadedTrace;
    routes: { routeLabel: string; items: CollectedShot[] }[];
}

export default function ScreenshotCollection({ items, traces, onRemove, onClear, onNavigate, onClose }: Props) {
    const [zipping, setZipping] = useState(false);
    const [zipError, setZipError] = useState<string | null>(null);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onClose]);

    // fileName → (sha1 → screenshot) for the loaded traces.
    const lookup = useMemo(() => {
        const map = new Map<string, { trace: LoadedTrace; shots: Map<string, ScreenshotEntry> }>();
        for (const t of traces) {
            if (map.has(t.fileName)) continue;
            map.set(t.fileName, { trace: t, shots: new Map(t.journey.allScreenshots.map(s => [s.sha1, s])) });
        }
        return map;
    }, [traces]);

    const resolve = (item: CollectedShot) => lookup.get(item.traceFileName)?.shots.get(item.sha1);

    const groups = useMemo<TraceGroup[]>(() => {
        const byTrace = new Map<string, Map<string, CollectedShot[]>>();
        for (const item of items) {
            const routes = byTrace.get(item.traceFileName) ?? new Map<string, CollectedShot[]>();
            const list = routes.get(item.routeLabel) ?? [];
            list.push(item);
            routes.set(item.routeLabel, list);
            byTrace.set(item.traceFileName, routes);
        }
        return [...byTrace.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([traceFileName, routes]) => ({
                traceFileName,
                trace: lookup.get(traceFileName)?.trace,
                routes: [...routes.entries()]
                    .map(([routeLabel, list]) => ({
                        routeLabel,
                        items: list.slice().sort((a, b) => a.offsetMs - b.offsetMs),
                    }))
                    .sort((a, b) => a.items[0].offsetMs - b.items[0].offsetMs),
            }));
    }, [items, lookup]);

    const availableCount = items.filter(i => resolve(i)).length;

    const downloadZip = async () => {
        setZipping(true);
        setZipError(null);
        try {
            const zip = new JSZip();
            for (const group of groups) {
                const folder = zip.folder(toFileSlug(group.traceFileName, 'trace'));
                if (!folder) continue;
                let n = 0;
                for (const route of group.routes) {
                    for (const item of route.items) {
                        const shot = resolve(item);
                        if (!shot) continue;
                        const blob = await (await fetch(shot.url)).blob();
                        n++;
                        const name = `${String(n).padStart(3, '0')}_${toFileSlug(item.routeLabel, 'route')}_visit${item.visitNumber}_${Math.round(item.offsetMs)}ms.${imageExtension(blob.type)}`;
                        folder.file(name, blob);
                    }
                }
            }
            downloadBlob(await zip.generateAsync({ type: 'blob' }), 'screenshots.zip');
        } catch (err) {
            setZipError(err instanceof Error ? err.message : 'Could not create the zip.');
        } finally {
            setZipping(false);
        }
    };

    return (
        <aside className="collection-drawer" aria-label="Screenshot collection">
            <header className="collection-header">
                <span className="collection-title">Screenshot collection</span>
                <span className="collection-count">{items.length}</span>
                <button type="button" className="collection-close" onClick={onClose} aria-label="Close collection">
                    ✕
                </button>
            </header>

            <div className="collection-body">
                {items.length === 0 ? (
                    <div className="collection-empty">
                        Use “+ Collect” on a screenshot to add it here, then download them all as a zip.
                    </div>
                ) : (
                    groups.map(group => (
                        <section key={group.traceFileName} className="collection-trace">
                            <div className="collection-trace-header" title={group.traceFileName}>
                                <span
                                    className="collection-trace-chip"
                                    style={{ background: group.trace?.color ?? 'var(--text-muted)' }}
                                />
                                <span className="collection-trace-name">{group.traceFileName}</span>
                                {!group.trace && <span className="collection-missing">not loaded</span>}
                            </div>
                            {group.routes.map(route => (
                                <div key={route.routeLabel} className="collection-route">
                                    <div className="collection-route-label" title={route.routeLabel}>
                                        {route.routeLabel}
                                    </div>
                                    <ul className="collection-items">
                                        {route.items.map(item => {
                                            const key = shotKey(item.traceFileName, item.sha1);
                                            const shot = resolve(item);
                                            return (
                                                <li key={key} className={`collection-item${shot ? '' : ' collection-item--missing'}`}>
                                                    <button
                                                        type="button"
                                                        className="collection-item-open"
                                                        onClick={() => onNavigate(item)}
                                                        disabled={!shot}
                                                        title={shot ? 'Show in details' : 'Load this trace to view the screenshot'}
                                                    >
                                                        {shot ? (
                                                            <img src={shot.url} alt="" className="collection-thumb" />
                                                        ) : (
                                                            <span className="collection-thumb collection-thumb--missing">?</span>
                                                        )}
                                                        <span className="collection-item-meta">
                                                            <span>Visit #{item.visitNumber}</span>
                                                            <span className="collection-item-time">+{formatDuration(item.offsetMs)}</span>
                                                        </span>
                                                    </button>
                                                    <button
                                                        type="button"
                                                        className="collection-item-remove"
                                                        onClick={() => onRemove(key)}
                                                        aria-label="Remove from collection"
                                                        title="Remove from collection"
                                                    >
                                                        ×
                                                    </button>
                                                </li>
                                            );
                                        })}
                                    </ul>
                                </div>
                            ))}
                        </section>
                    ))
                )}
            </div>

            <footer className="collection-footer">
                {zipError && <div className="collection-error" role="alert">{zipError}</div>}
                <button
                    type="button"
                    className="collection-download"
                    onClick={() => void downloadZip()}
                    disabled={zipping || availableCount === 0}
                >
                    {zipping ? 'Creating zip…' : `Download zip (${availableCount})`}
                </button>
                <button
                    type="button"
                    className="collection-clear"
                    onClick={() => window.confirm('Remove all screenshots from the collection?') && onClear()}
                    disabled={items.length === 0}
                >
                    Clear
                </button>
            </footer>
        </aside>
    );
}
