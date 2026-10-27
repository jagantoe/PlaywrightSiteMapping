/**
 * Bundle expansion — lets the user upload a .zip that itself contains trace .zip files.
 *
 * A Playwright trace zip holds `.trace` files; a bundle holds no `.trace` files but one or
 * more nested `.zip` entries. Bundles are replaced by the nested zips (as File objects);
 * anything else is passed through untouched.
 */

import JSZip from 'jszip';

function isNestedZip(name: string, entry: JSZip.JSZipObject): boolean {
    return (
        !entry.dir &&
        name.toLowerCase().endsWith('.zip') &&
        !name.startsWith('__MACOSX/') &&
        !name.split('/').pop()!.startsWith('._')
    );
}

export async function expandTraceBundles(files: File[]): Promise<File[]> {
    const result: File[] = [];
    for (const file of files) {
        let zip: JSZip;
        try {
            zip = await JSZip.loadAsync(file);
        } catch {
            result.push(file); // let the parser report the error
            continue;
        }

        const names = Object.keys(zip.files);
        const isTrace = names.some(n => n.endsWith('.trace') && !zip.files[n].dir);
        const nested = names.filter(n => isNestedZip(n, zip.files[n])).sort();
        if (isTrace || nested.length === 0) {
            result.push(file);
            continue;
        }

        const baseCounts = new Map<string, number>();
        for (const n of nested) {
            const base = n.split('/').pop()!;
            baseCounts.set(base, (baseCounts.get(base) ?? 0) + 1);
        }

        for (const path of nested) {
            const base = path.split('/').pop()!;
            // Generic names like "trace.zip" repeat per test folder, so keep the path to tell them apart.
            const name = baseCounts.get(base)! > 1 ? path.replace(/\//g, '_') : base;
            const blob = await zip.files[path].async('blob');
            result.push(new File([blob], name, { type: 'application/zip' }));
        }
    }
    return result;
}
