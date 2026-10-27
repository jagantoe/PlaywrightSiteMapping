import { useCallback, useRef, useState } from 'react';

interface Props {
    onFiles: (files: File[]) => void;
    isLoading: boolean;
    error: string | null;
}

export default function TraceUpload({ onFiles, isLoading, error }: Props) {
    const [isDragging, setIsDragging] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    const handleFiles = useCallback(
        (files: FileList | null) => {
            const zips = Array.from(files ?? []).filter(f => f.name.endsWith('.zip'));
            if (zips.length > 0) onFiles(zips);
        },
        [onFiles],
    );

    const onDrop = useCallback(
        (e: React.DragEvent) => {
            e.preventDefault();
            setIsDragging(false);
            handleFiles(e.dataTransfer.files);
        },
        [handleFiles],
    );

    const onDragOver = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(true);
    };

    const onDragLeave = () => setIsDragging(false);

    return (
        <div className="upload-wrapper">
            <div
                className={`upload-zone ${isDragging ? 'upload-zone--dragging' : ''} ${isLoading ? 'upload-zone--loading' : ''}`}
                onDrop={onDrop}
                onDragOver={onDragOver}
                onDragLeave={onDragLeave}
                onClick={() => !isLoading && inputRef.current?.click()}
                role="button"
                tabIndex={0}
                onKeyDown={e => e.key === 'Enter' && inputRef.current?.click()}
                aria-label="Drop a Playwright trace .zip file here or click to browse"
            >
                <input
                    ref={inputRef}
                    type="file"
                    accept=".zip"
                    multiple
                    className="upload-input"
                    onChange={e => handleFiles(e.target.files)}
                />
                <div className="upload-icon" aria-hidden="true">
                    {isLoading ? '⏳' : '📂'}
                </div>
                {isLoading ? (
                    <p className="upload-label">Parsing trace file…</p>
                ) : (
                    <>
                        <p className="upload-label">
                            Drop one or more Playwright trace <code>.zip</code> files here
                        </p>
                        <p className="upload-hint">or click to browse</p>
                    </>
                )}
            </div>

            {error && (
                <div className="upload-error" role="alert">
                    <span className="upload-error-icon">✕</span>
                    <span>{error}</span>
                </div>
            )}
        </div>
    );
}
