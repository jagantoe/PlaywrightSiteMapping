import { useState } from 'react';
import type { Action } from '../trace/contracts';
import {
    formatDuration,
    getActionCategory,
    getActionIcon,
    getCategoryColor,
    urlToPath,
} from './utils';

interface ActionListProps {
    actions: Action[];
    selectedCallId: string | null;
    onSelect: (callId: string) => void;
    startTime: number;
    depth?: number;
}

export default function ActionList({
    actions,
    selectedCallId,
    onSelect,
    startTime,
    depth = 0,
}: ActionListProps) {
    return (
        <ul
            className={`action-list ${depth === 0 ? 'action-list--root' : 'action-list--nested'}`}
            role="listbox"
            aria-label={depth === 0 ? 'Actions' : undefined}
        >
            {actions.map(action => (
                <ActionItem
                    key={action.callId}
                    action={action}
                    selectedCallId={selectedCallId}
                    onSelect={onSelect}
                    startTime={startTime}
                    depth={depth}
                />
            ))}
        </ul>
    );
}

// ---------------------------------------------------------------------------
// Single action row (recursive — renders children when expanded)
// ---------------------------------------------------------------------------

interface ActionItemProps {
    action: Action;
    selectedCallId: string | null;
    onSelect: (callId: string) => void;
    startTime: number;
    depth: number;
}

function ActionItem({
    action,
    selectedCallId,
    onSelect,
    startTime,
    depth,
}: ActionItemProps) {
    const hasChildren = action.children.length > 0;
    // Groups/steps start expanded; leaf actions don't need it
    const [expanded, setExpanded] = useState(hasChildren && depth === 0);

    const isSelected = action.callId === selectedCallId;
    const hasError = !!action.error;
    const category = getActionCategory(action.method, action.class);
    const icon = getActionIcon(action.method, action.class);
    const color = hasError ? 'var(--color-error)' : getCategoryColor(category);

    // How much to indent the row
    const paddingLeft = 12 + depth * 18;

    return (
        <li className="action-list-item">
            <div
                className={[
                    'action-row',
                    isSelected ? 'action-row--selected' : '',
                    hasError ? 'action-row--error' : '',
                ].join(' ')}
                style={{ paddingLeft }}
                onClick={() => onSelect(action.callId)}
                role="option"
                aria-selected={isSelected}
                tabIndex={0}
                onKeyDown={e => e.key === 'Enter' && onSelect(action.callId)}
            >
                {/* Expand / collapse toggle for groups */}
                {hasChildren ? (
                    <button
                        type="button"
                        className="action-expand-btn"
                        aria-label={expanded ? 'Collapse' : 'Expand'}
                        onClick={e => {
                            e.stopPropagation();
                            setExpanded(v => !v);
                        }}
                    >
                        {expanded ? '▾' : '▸'}
                    </button>
                ) : (
                    <span className="action-icon" style={{ color }} aria-hidden="true">
                        {icon}
                    </span>
                )}

                {/* Left accent bar */}
                <span
                    className="action-accent-bar"
                    style={{ backgroundColor: color }}
                    aria-hidden="true"
                />

                {/* Title */}
                <span className="action-title" title={action.title}>
                    {action.title}
                </span>

                {/* Navigation target — shown when action triggered a route change */}
                {action.navigationTargetUrl && (
                    <span
                        className="action-nav-target"
                        title={`Navigated to: ${action.navigationTargetUrl}`}
                    >
                        <span className="action-nav-arrow" aria-hidden="true">→</span>
                        <span className="action-nav-path">{urlToPath(action.navigationTargetUrl)}</span>
                    </span>
                )}

                {/* Duration */}
                <span className="action-duration">{formatDuration(action.duration)}</span>

                {/* Error indicator */}
                {hasError && (
                    <span className="action-error-badge" title={action.error?.message}>
                        ✕
                    </span>
                )}
            </div>

            {/* Recursively render children */}
            {hasChildren && expanded && (
                <ActionList
                    actions={action.children}
                    selectedCallId={selectedCallId}
                    onSelect={onSelect}
                    startTime={startTime}
                    depth={depth + 1}
                />
            )}
        </li>
    );
}
