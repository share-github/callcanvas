import * as fs from 'node:fs';

export interface LineCoverage {
    mi: number;  // missed instructions
    ci: number;  // covered instructions
    mb: number;  // missed branches
    cb: number;  // covered branches
}

/**
 * Map from "package/filename" (e.g. "com/example/app/controller/OrderController.java")
 * to a Map of line number -> LineCoverage.
 */
export type CoverageData = Map<string, Map<number, LineCoverage>>;

/**
 * Parse a JaCoCo XML report file (both single-module and aggregate formats).
 *
 * Aggregate format wraps packages in <group> elements; single-module format
 * has <package> directly under <report>. Both are handled transparently because
 * we only track <package> and <sourcefile> tags regardless of nesting depth.
 */
export function parseJacocoCoverage(xmlPath: string): CoverageData {
    const content = fs.readFileSync(xmlPath, 'utf8');
    const result: CoverageData = new Map();

    let currentPackage = '';
    let currentSourcefile = '';

    // Match every XML tag: <tagName attrs/> or <tagName attrs> or </tagName>
    // [^>]*? handles attribute values safely because JaCoCo attribute values
    // never contain a literal '>' character (entities like &gt; are safe too).
    const tagPattern = /<(\/?)([A-Za-z]\w*)([^>]*?)(\/?)>/g;
    let m: RegExpExecArray | null;

    while ((m = tagPattern.exec(content)) !== null) {
        const isClosing = m[1] === '/';
        const tagName = m[2];
        const attrs = m[3];
        const isSelfClosing = m[4] === '/';

        if (!isClosing) {
            if (tagName === 'package') {
                currentPackage = attr(attrs, 'name');
            } else if (tagName === 'sourcefile') {
                currentSourcefile = attr(attrs, 'name');
                if (currentPackage && currentSourcefile) {
                    const key = `${currentPackage}/${currentSourcefile}`;
                    if (!result.has(key)) {
                        result.set(key, new Map());
                    }
                }
            } else if (tagName === 'line') {
                // <line> elements only appear inside <sourcefile>
                if (currentPackage && currentSourcefile) {
                    const key = `${currentPackage}/${currentSourcefile}`;
                    const nr = Number.parseInt(attr(attrs, 'nr'), 10);
                    const mi = Number.parseInt(attr(attrs, 'mi'), 10);
                    const ci = Number.parseInt(attr(attrs, 'ci'), 10);
                    const mb = Number.parseInt(attr(attrs, 'mb'), 10);
                    const cb = Number.parseInt(attr(attrs, 'cb'), 10);
                    if (!Number.isNaN(nr)) {
                        result.get(key)!.set(nr, { mi, ci, mb, cb });
                    }
                }
            }
        }

        if (isClosing || isSelfClosing) {
            if (tagName === 'sourcefile') {
                currentSourcefile = '';
            } else if (tagName === 'package') {
                currentPackage = '';
            }
        }
    }

    return result;
}

function attr(attrs: string, name: string): string {
    const m = new RegExp(`${name}="([^"]*)"`).exec(attrs);
    return m ? m[1] : '';
}
