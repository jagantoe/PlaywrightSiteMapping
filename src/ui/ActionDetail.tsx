import { useState } from 'react';
import type { Action, ConsoleEvent, HarEntry } from '../trace/contracts';
import { formatDuration, formatParamValue, urlToPath } from './utils';

type TabId = 'call' | 'log' | 'network' | 'console';

interface Props {
    action: Action;
    /** Visit-level network requests — filtered to action time window */
    networkRequests: HarEntry[];
    /** Visit-level console messages — filtered to action time window */
    consoleMessages: ConsoleEvent[];
}

export default function ActionDetail({ action, networkRequests, consoleMessages }: Props) {
    const [activeTab, setActiveTab] = useState<TabId>('call');

    // Filter to the action's time window (start → end)
    const actionNet = networkRequests.filter(
        r =>
            (r._monotonicTime ?? 0) >= action.startTime &&
            (r._monotonicTime ?? 0) <= action.endTime,
    );
    const actionConsole = consoleMessages.filter(
        m => m.time >= action.startTime && m.time <= action.endTime,
    );

    const tabs: { id: TabId; label: string; count?: number }[] = [
        { id: 'call', label: 'Call' },
        { id: 'log', label: 'Log', count: action.logs.length },
        { id: 'network', label: 'Network', count: actionNet.length },
        { id: 'console', label: 'Console', count: actionConsole.length },
    ];

    return (
        <div className="action-detail">
            {/* Tab bar */}
            <div className="detail-tabs" role="tablist">
                {tabs.map(tab => (
                    <button
                        key={tab.id}
                        type="button"
                        role="tab"
                        aria-selected={activeTab === tab.id}
                        className={`detail-tab ${activeTab === tab.id ? 'detail-tab--active' : ''}`}
                        onClick={() => setActiveTab(tab.id)}
                    >
                        {tab.label}
                        {tab.count != null && tab.count > 0 && (
                            <span className="detail-tab-count">{tab.count}</span>
                        )}
                    </button>
                ))}
            </div>

            {/* Tab content */}
            <div className="detail-content" role="tabpanel">
                {activeTab === 'call' && <CallTab action={action} />}
                {activeTab === 'log' && <LogTab logs={action.logs} />}
                {activeTab === 'network' && <NetworkTab requests={actionNet} />}
                {activeTab === 'console' && <ConsoleTab messages={actionConsole} />}
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Call tab
// ---------------------------------------------------------------------------

function CallTab({ action }: { action: Action }) {
    return (
        <div className="call-tab">
            {/* URL bar — shows which route this action ran on */}
            {(action.currentUrl || action.navigationTargetUrl) && (
                <div className="call-section call-section--url">
                    <div className="call-section-label">Page URL</div>
                    <div className="call-url-bar">
                        <span className="call-url-icon" aria-hidden="true">⊕</span>
                        {action.currentUrl && (
                            <span className="call-url" title={action.currentUrl}>
                                {urlToPath(action.currentUrl)}
                            </span>
                        )}
                        {action.navigationTargetUrl && (
                            <>
                                <span className="call-url-arrow" aria-hidden="true">→</span>
                                <span className="call-url call-url--target" title={action.navigationTargetUrl}>
                                    {urlToPath(action.navigationTargetUrl)}
                                </span>
                            </>
                        )}
                    </div>
                </div>
            )}

            {/* Title row */}
            <div className="call-section">
                <div className="call-title">
                    <span className="call-class">{action.class}</span>
                    <span className="call-method-sep">.</span>
                    <span className="call-method">{action.method}</span>
                </div>
                <span className="call-duration">{formatDuration(action.duration)}</span>
            </div>

            {/* Params */}
            {Object.keys(action.params).length > 0 && (
                <div className="call-section">
                    <div className="call-section-label">Params</div>
                    <table className="call-table">
                        <tbody>
                            {Object.entries(action.params).map(([key, val]) => (
                                <tr key={key}>
                                    <td className="call-param-key">{key}</td>
                                    <td className="call-param-val">{formatParamValue(val)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {/* Result */}
            {action.result !== undefined && action.result !== null && (
                <div className="call-section">
                    <div className="call-section-label">Result</div>
                    <pre className="call-code">{formatParamValue(action.result)}</pre>
                </div>
            )}

            {/* Error */}
            {action.error && (
                <div className="call-section call-section--error">
                    <div className="call-section-label">Error</div>
                    <div className="call-error-message">{action.error.message}</div>
                    {action.error.stack && (
                        <pre className="call-code call-code--error">{action.error.stack}</pre>
                    )}
                </div>
            )}

            {/* Stack */}
            {action.stack && action.stack.length > 0 && (
                <div className="call-section">
                    <div className="call-section-label">Stack</div>
                    <div className="call-stack">
                        {action.stack.map((frame, i) => (
                            <div key={i} className="call-stack-frame">
                                <span className="call-stack-file">{frame.file}</span>
                                {frame.line != null && (
                                    <span className="call-stack-loc">:{frame.line}</span>
                                )}
                                {frame.column != null && (
                                    <span className="call-stack-loc">:{frame.column}</span>
                                )}
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Log tab
// ---------------------------------------------------------------------------

function LogTab({ logs }: { logs: string[] }) {
    if (logs.length === 0) {
        return <div className="tab-empty">No log entries</div>;
    }
    return (
        <ul className="log-list">
            {logs.map((msg, i) => (
                <li key={i} className="log-entry">
                    <span className="log-bullet" aria-hidden="true">›</span>
                    <span className="log-text">{msg}</span>
                </li>
            ))}
        </ul>
    );
}

// ---------------------------------------------------------------------------
// Network tab
// ---------------------------------------------------------------------------

function NetworkTab({ requests }: { requests: HarEntry[] }) {
    const [selected, setSelected] = useState<HarEntry | null>(null);

    if (requests.length === 0) {
        return <div className="tab-empty">No network requests in this action window</div>;
    }

    return (
        <div className="network-tab">
            <table className="network-table">
                <thead>
                    <tr>
                        <th>Method</th>
                        <th>Status</th>
                        <th>URL</th>
                        <th>Type</th>
                    </tr>
                </thead>
                <tbody>
                    {requests.map((entry, i) => (
                        <tr
                            key={i}
                            className={`network-row ${selected === entry ? 'network-row--selected' : ''} ${entry.response.status >= 400 ? 'network-row--error' : ''}`}
                            onClick={() => setSelected(selected === entry ? null : entry)}
                        >
                            <td className="network-method">{entry.request.method}</td>
                            <td className={`network-status ${entry.response.status >= 400 ? 'network-status--error' : entry.response.status >= 300 ? 'network-status--redirect' : ''}`}>
                                {entry.response.status}
                            </td>
                            <td className="network-url" title={entry.request.url}>
                                {shortUrl(entry.request.url)}
                            </td>
                            <td className="network-type">{entry._resourceType ?? '—'}</td>
                        </tr>
                    ))}
                </tbody>
            </table>

            {selected && (
                <div className="network-detail">
                    <NetworkRequestDetail entry={selected} />
                </div>
            )}
        </div>
    );
}

function NetworkRequestDetail({ entry }: { entry: HarEntry }) {
    const [tab, setTab] = useState<'request' | 'response'>('request');
    return (
        <div className="net-detail">
            <div className="net-detail-tabs">
                <button
                    type="button"
                    className={`net-detail-tab ${tab === 'request' ? 'net-detail-tab--active' : ''}`}
                    onClick={() => setTab('request')}
                >
                    Request
                </button>
                <button
                    type="button"
                    className={`net-detail-tab ${tab === 'response' ? 'net-detail-tab--active' : ''}`}
                    onClick={() => setTab('response')}
                >
                    Response
                </button>
            </div>
            {tab === 'request' && (
                <div className="net-detail-body">
                    <div className="net-detail-row">
                        <span className="net-detail-key">URL</span>
                        <span className="net-detail-val net-detail-val--url">{entry.request.url}</span>
                    </div>
                    <div className="net-detail-row">
                        <span className="net-detail-key">Method</span>
                        <span className="net-detail-val">{entry.request.method}</span>
                    </div>
                    <HeadersTable headers={entry.request.headers} />
                    {entry.request.postData && (
                        <div className="net-detail-row">
                            <span className="net-detail-key">Body</span>
                            <pre className="net-detail-body-text">{entry.request.postData.text ?? ''}</pre>
                        </div>
                    )}
                </div>
            )}
            {tab === 'response' && (
                <div className="net-detail-body">
                    <div className="net-detail-row">
                        <span className="net-detail-key">Status</span>
                        <span className={`net-detail-val ${entry.response.status >= 400 ? 'net-detail-val--error' : ''}`}>
                            {entry.response.status} {entry.response.statusText}
                        </span>
                    </div>
                    <HeadersTable headers={entry.response.headers} />
                </div>
            )}
        </div>
    );
}

function HeadersTable({ headers }: { headers: { name: string; value: string }[] }) {
    if (!headers.length) return null;
    return (
        <div className="net-detail-headers">
            <div className="net-detail-key" style={{ marginBottom: 4 }}>Headers</div>
            <table className="headers-table">
                <tbody>
                    {headers.map((h, i) => (
                        <tr key={i}>
                            <td className="headers-name">{h.name}</td>
                            <td className="headers-value">{h.value}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Console tab
// ---------------------------------------------------------------------------

function ConsoleTab({ messages }: { messages: ConsoleEvent[] }) {
    if (messages.length === 0) {
        return <div className="tab-empty">No console messages in this action window</div>;
    }
    return (
        <ul className="console-list">
            {messages.map((msg, i) => (
                <li key={i} className={`console-entry console-entry--${msg.messageType}`}>
                    <span className="console-type" aria-label={msg.messageType}>
                        {consoleTypeIcon(msg.messageType)}
                    </span>
                    <span className="console-text">{msg.text}</span>
                </li>
            ))}
        </ul>
    );
}

function consoleTypeIcon(type: string): string {
    switch (type) {
        case 'error': return '✕';
        case 'warning': return '⚠';
        case 'info': return 'ℹ';
        default: return '›';
    }
}

function shortUrl(url: string): string {
    try {
        const parsed = new URL(url);
        const path = parsed.pathname + parsed.search;
        return path.length > 60 ? '…' + path.slice(-57) : path;
    } catch {
        return url.slice(0, 60);
    }
}
