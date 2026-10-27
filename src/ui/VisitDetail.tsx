import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import type { Action, ScreenshotEntry, UrlVisit } from '../trace/contracts';
import ActionList from './ActionList';
import { type FocusRequest, useCollection } from './collection';
import {
    downloadScreenshot,
    findActionByCallId,
    findScreenshotForAction,
    urlToPath,
} from './utils';

/** Tabs in the snapshot viewer: the three DOM-snapshot phases plus the screenshots carousel */
type ViewerTab = 'before' | 'action' | 'after' | 'screenshots';

// Module-level SW readiness promise — captures the controllerchange event regardless
// of when the VisitDetail component mounts (avoids the render→effect race condition).
let _swReadyPromise: Promise<void> | null = null;
function swReadyPromise(): Promise<void> {
    if (_swReadyPromise) return _swReadyPromise;
    if (!navigator.serviceWorker) return (_swReadyPromise = Promise.resolve());
    if (navigator.serviceWorker.controller) return (_swReadyPromise = Promise.resolve());
    _swReadyPromise = new Promise<void>(resolve => {
        navigator.serviceWorker!.addEventListener('controllerchange', () => resolve(), { once: true });
    });
    return _swReadyPromise;
}

interface Props {
    visit: UrlVisit;
    traceStartTime: number;
    allScreenshots: ScreenshotEntry[];
    /** Blob URL of the trace zip — passed to the service worker for snapshot rendering */
    traceUrl: string;
    /** Source zip name — used for screenshot downloads and the collection */
    traceFileName: string;
    /** Full route path of the visit's node */
    routeLabel: string;
    /** 1-based visit instance of the route within the trace */
    visitNumber: number;
    focus: FocusRequest | null;
}

/** Identifies a screenshot for download / collection actions. */
interface ShotContext {
    traceFileName: string;
    routeLabel: string;
    visitNumber: number;
    traceStartTime: number;
}

/** DFS: first action that has any Playwright DOM snapshot attached */
function findFirstActionWithSnapshot(actions: Action[]): string | null {
    for (const action of actions) {
        if (action.children.length > 0) {
            const found = findFirstActionWithSnapshot(action.children);
            if (found) return found;
        }
        if (action.beforeSnapshot ?? action.inputSnapshot ?? action.afterSnapshot) {
            return action.callId;
        }
    }
    return null;
}

export default function VisitDetail({
    visit,
    traceStartTime,
    allScreenshots,
    traceUrl,
    traceFileName,
    routeLabel,
    visitNumber,
    focus,
}: Props) {
    const [selectedCallId, setSelectedCallId] = useState<string | null>(null);
    const [viewerTab, setViewerTab] = useState<ViewerTab>('action');
    const [shotIndex, setShotIndex] = useState(0);
    const [enlargedScreenshot, setEnlargedScreenshot] = useState<ScreenshotEntry | null>(null);
    const shotContext: ShotContext = { traceFileName, routeLabel, visitNumber, traceStartTime };

    // SW readiness: snapshot iframes only render correctly once the service worker is
    // controlling the page. We track this as state so changing it forces the iframe key
    // to change (remount). The module-level promise means we never miss the event even
    // if controllerchange fired before this component mounted.
    const [swReady, setSwReady] = useState(
        () => !navigator.serviceWorker || !!navigator.serviceWorker.controller,
    );
    useEffect(() => {
        if (swReady) return;
        let cancelled = false;
        swReadyPromise().then(() => { if (!cancelled) setSwReady(true); });
        return () => { cancelled = true; };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // On visit change: open the screenshots on the last frame (page fully loaded by then),
    // falling back to the DOM snapshot of the first action that has one.
    useEffect(() => {
        setSelectedCallId(findFirstActionWithSnapshot(visit.actions));
        setViewerTab(visit.screenshots.length > 0 ? 'screenshots' : 'action');
        setShotIndex(Math.max(0, visit.screenshots.length - 1));
    }, [visit.visitId]); // eslint-disable-line react-hooks/exhaustive-deps

    const handleSelectAction = (callId: string) => {
        setSelectedCallId(callId);
        if (viewerTab !== 'screenshots') return;
        const action = findActionByCallId(visit.actions, callId);
        const shot = action && findScreenshotForAction(allScreenshots, action, visit.startTime);
        const idx = shot ? visit.screenshots.findIndex(s => s.sha1 === shot.sha1) : -1;
        if (idx >= 0) setShotIndex(idx);
    };

    // Declared after the visit-change effect so a focus request wins over its defaults.
    const handledFocusRef = useRef<number | null>(null);
    useEffect(() => {
        if (!focus || handledFocusRef.current === focus.nonce || focus.visitId !== visit.visitId) return;
        const idx = visit.screenshots.findIndex(s => s.sha1 === focus.sha1);
        if (idx < 0) return;
        handledFocusRef.current = focus.nonce;
        setViewerTab('screenshots');
        setShotIndex(idx);
    }, [focus, visit]);

    const selectedAction = useMemo(
        () => (selectedCallId ? findActionByCallId(visit.actions, selectedCallId) : undefined),
        [visit.actions, selectedCallId],
    );

    // Build the snapshot iframe URL:
    //   {BASE_URL}snapshot/{pageId}?name={snapshotName}&trace={encodedBlobUrl}
    // The service worker intercepts this, loads the trace zip, and serves the
    // exact DOM snapshot for the requested callId + phase — no timestamp guessing.
    const snapshotIframeUrl = useMemo(() => {
        if (viewerTab === 'screenshots') return null;
        if (!selectedAction || !traceUrl || !selectedAction.pageId) return null;

        let snapshotName: string | undefined;
        if (viewerTab === 'before') {
            snapshotName = selectedAction.beforeSnapshot;
        } else if (viewerTab === 'action') {
            snapshotName = selectedAction.inputSnapshot ?? selectedAction.beforeSnapshot;
        } else {
            snapshotName = selectedAction.afterSnapshot ?? selectedAction.inputSnapshot ?? selectedAction.beforeSnapshot;
        }
        if (!snapshotName) return null;

        return `${import.meta.env.BASE_URL}snapshot/${selectedAction.pageId}?name=${encodeURIComponent(snapshotName)}&trace=${encodeURIComponent(traceUrl)}`;
    }, [selectedAction, viewerTab, traceUrl]);

    // Screencast fallback for actions that have no DOM snapshots
    const fallbackScreenshot = useMemo(
        () =>
            selectedAction && !snapshotIframeUrl && viewerTab !== 'screenshots'
                ? findScreenshotForAction(allScreenshots, selectedAction, visit.startTime)
                : undefined,
        [selectedAction, snapshotIframeUrl, viewerTab, allScreenshots, visit.startTime],
    );

    const hasPhaseSnapshots = !!(
        selectedAction &&
        (selectedAction.beforeSnapshot || selectedAction.inputSnapshot || selectedAction.afterSnapshot)
    );
    const hasScreenshots = visit.screenshots.length > 0;

    return (
        <div className="visit-detail">
            {/* ── Preview — screenshots carousel, DOM snapshot via SW, or screencast fallback */}
            <VisitSection title="Preview">
                <div className="action-snapshot-viewer">
                    {(hasPhaseSnapshots || hasScreenshots) && (
                        <div className="snapshot-phase-tabs">
                            {hasScreenshots && (
                                <button
                                    type="button"
                                    className={`snapshot-phase-tab${viewerTab === 'screenshots' ? ' snapshot-phase-tab--active' : ''}`}
                                    onClick={() => setViewerTab('screenshots')}
                                >Screenshots ({visit.screenshots.length})</button>
                            )}
                            {hasPhaseSnapshots && selectedAction && (
                                <>
                                    <button
                                        type="button"
                                        className={`snapshot-phase-tab${viewerTab === 'before' ? ' snapshot-phase-tab--active' : ''}`}
                                        disabled={!selectedAction.beforeSnapshot}
                                        onClick={() => setViewerTab('before')}
                                    >Before</button>
                                    <button
                                        type="button"
                                        className={`snapshot-phase-tab${viewerTab === 'action' ? ' snapshot-phase-tab--active' : ''}`}
                                        disabled={!(selectedAction.inputSnapshot ?? selectedAction.beforeSnapshot)}
                                        onClick={() => setViewerTab('action')}
                                    >Action</button>
                                    <button
                                        type="button"
                                        className={`snapshot-phase-tab${viewerTab === 'after' ? ' snapshot-phase-tab--active' : ''}`}
                                        disabled={!selectedAction.afterSnapshot}
                                        onClick={() => setViewerTab('after')}
                                    >After</button>
                                </>
                            )}
                        </div>
                    )}

                    {viewerTab === 'screenshots' ? (
                        <ScreenshotCarousel
                            screenshots={visit.screenshots}
                            index={shotIndex}
                            onIndexChange={setShotIndex}
                            onEnlarge={setEnlargedScreenshot}
                            shotContext={shotContext}
                        />
                    ) : snapshotIframeUrl ? (
                        <iframe
                            key={snapshotIframeUrl + (swReady ? '-r' : '-i')}
                            src={snapshotIframeUrl}
                            sandbox="allow-scripts allow-same-origin"
                            className="action-snapshot-iframe"
                            title={`Page state during "${selectedAction?.title}"`}
                        />
                    ) : fallbackScreenshot ? (
                        /* Screencast fallback for actions without DOM snapshots */
                        <>
                            <div
                                className="action-screenshot"
                                onClick={() => setEnlargedScreenshot(fallbackScreenshot)}
                                role="button"
                                tabIndex={0}
                                onKeyDown={e => e.key === 'Enter' && setEnlargedScreenshot(fallbackScreenshot)}
                                title="Click to enlarge"
                            >
                                <img
                                    src={fallbackScreenshot.url}
                                    alt={`Page state during "${selectedAction?.title}"`}
                                    className="action-screenshot-img"
                                />
                                <span className="action-screenshot-hint">Click to enlarge</span>
                            </div>
                            <div className="screenshot-actions-bar">
                                <ScreenshotActions shot={fallbackScreenshot} context={shotContext} />
                            </div>
                        </>
                    ) : selectedAction ? (
                        <div className="action-snapshot-empty">No preview available</div>
                    ) : (
                        <div className="action-snapshot-empty">Select an action to view its snapshot</div>
                    )}

                    {/* URL bar below snapshot */}
                    {viewerTab !== 'screenshots' && selectedAction && (selectedAction.currentUrl || selectedAction.navigationTargetUrl) && (
                        <div className="screenshot-url-bar">
                            <span className="screenshot-url-icon" aria-hidden="true">⊕</span>
                            <span className="screenshot-url" title={selectedAction.currentUrl}>
                                {urlToPath(selectedAction.currentUrl ?? '')}
                            </span>
                            {selectedAction.navigationTargetUrl && (
                                <>
                                    <span className="screenshot-url-arrow" aria-hidden="true">→</span>
                                    <span className="screenshot-url screenshot-url--target" title={selectedAction.navigationTargetUrl}>
                                        {urlToPath(selectedAction.navigationTargetUrl)}
                                    </span>
                                </>
                            )}
                        </div>
                    )}
                </div>
            </VisitSection>

            <VisitSection title="Actions" count={visit.actions.length}>
                {visit.actions.length === 0 ? (
                    <div className="visit-empty">No actions recorded for this URL</div>
                ) : (
                    <ActionList
                        actions={visit.actions}
                        selectedCallId={selectedCallId}
                        onSelect={handleSelectAction}
                        startTime={traceStartTime}
                    />
                )}
            </VisitSection>

            {/* ── Lightbox ──────────────────────────────────────── */}
            {enlargedScreenshot && (
                <div
                    className="lightbox"
                    onClick={() => setEnlargedScreenshot(null)}
                    role="dialog"
                    aria-modal="true"
                    aria-label="Enlarged screenshot"
                >
                    <div className="lightbox-toolbar" onClick={e => e.stopPropagation()}>
                        <ScreenshotActions shot={enlargedScreenshot} context={shotContext} />
                        <button
                            type="button"
                            className="lightbox-close"
                            onClick={() => setEnlargedScreenshot(null)}
                            aria-label="Close"
                        >
                            ✕
                        </button>
                    </div>
                    <img
                        src={enlargedScreenshot.url}
                        alt="Enlarged screenshot"
                        className="lightbox-img"
                        onClick={e => e.stopPropagation()}
                    />
                </div>
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function VisitSection({
    title,
    count,
    children,
}: {
    title: string;
    count?: number;
    children: ReactNode;
}) {
    const [open, setOpen] = useState(true);
    return (
        <section className={`visit-section${open ? '' : ' visit-section--collapsed'}`}>
            <button
                type="button"
                className="visit-section-header"
                onClick={() => setOpen(o => !o)}
                aria-expanded={open}
            >
                <span className="panel-chevron">{open ? '▾' : '▸'}</span>
                <span className="visit-section-title">{title}</span>
                {count != null && count > 0 && <span className="bottom-tab-count">{count}</span>}
            </button>
            {open && <div className="visit-section-body">{children}</div>}
        </section>
    );
}

/** Download + add-to-collection buttons for one screenshot. */
function ScreenshotActions({ shot, context }: { shot: ScreenshotEntry; context: ShotContext }) {
    const { isCollected, toggle } = useCollection();
    const collected = isCollected(context.traceFileName, shot.sha1);
    const offsetMs = Math.max(0, shot.timestamp - context.traceStartTime);
    return (
        <div className="screenshot-actions">
            <button
                type="button"
                className="screenshot-action-btn"
                onClick={() => void downloadScreenshot(shot, context.traceFileName, context.routeLabel, offsetMs)}
                title="Download this screenshot"
            >
                ⤓ Download
            </button>
            <button
                type="button"
                className={`screenshot-action-btn${collected ? ' screenshot-action-btn--on' : ''}`}
                onClick={() =>
                    toggle({
                        traceFileName: context.traceFileName,
                        sha1: shot.sha1,
                        routeLabel: context.routeLabel,
                        visitNumber: context.visitNumber,
                        offsetMs,
                    })
                }
                aria-pressed={collected}
                title={collected ? 'Remove from collection' : 'Add to collection'}
            >
                {collected ? '✓ Collected' : '+ Collect'}
            </button>
        </div>
    );
}

function ScreenshotCarousel({
    screenshots,
    index,
    onIndexChange,
    onEnlarge,
    shotContext,
}: {
    screenshots: ScreenshotEntry[];
    index: number;
    onIndexChange: (index: number) => void;
    onEnlarge: (shot: ScreenshotEntry) => void;
    shotContext: ShotContext;
}) {
    if (screenshots.length === 0) {
        return <div className="action-snapshot-empty">No screenshots captured</div>;
    }

    const safe = Math.max(0, Math.min(index, screenshots.length - 1));
    const current = screenshots[safe];
    const go = (delta: number) => onIndexChange(Math.max(0, Math.min(screenshots.length - 1, safe + delta)));

    return (
        <div className="screenshot-carousel">
            <div className="screenshot-carousel-stage">
                <button
                    type="button"
                    className="carousel-nav carousel-nav--prev"
                    onClick={() => go(-1)}
                    disabled={safe === 0}
                    aria-label="Previous screenshot"
                >
                    ‹
                </button>
                <img
                    src={current.url}
                    alt={`Screenshot ${safe + 1}`}
                    className="carousel-img"
                    onClick={() => onEnlarge(current)}
                    title="Click to enlarge"
                />
                <button
                    type="button"
                    className="carousel-nav carousel-nav--next"
                    onClick={() => go(1)}
                    disabled={safe === screenshots.length - 1}
                    aria-label="Next screenshot"
                >
                    ›
                </button>
            </div>
            <div className="screenshot-carousel-footer">
                <span className="carousel-counter">
                    {safe + 1} / {screenshots.length}
                </span>
                <ScreenshotActions shot={current} context={shotContext} />
            </div>
        </div>
    );
}
