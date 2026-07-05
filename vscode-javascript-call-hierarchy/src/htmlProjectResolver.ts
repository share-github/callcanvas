import * as path from 'path';
import * as fs from 'fs';
import { ScriptReference } from './types';
import {
    TEMPLATE_EXTENSIONS,
    collectIncludeTree,
    findProjectRoot,
    findWebappRoot,
    findAllTemplateFiles,
} from './templateIncludeResolver';

/**
 * Strip template expression wrappers from a src attribute value.
 *
 * Handles:
 *   Thymeleaf  @{/js/app.js}          => /js/app.js
 *   JSP        ${pageContext.request.contextPath}/js/app.js => /js/app.js
 *   FreeMarker ${base}/js/app.js       => /js/app.js
 */
function stripTemplateExpression(src: string): string {
    let result = src.replace(/^[@#]\{([^}]*)\}$/, '$1').trim();
    result = result.replace(/^\$\{[^}]*\}/, '').trim();
    return result;
}

/**
 * Parse HTML/template file and extract <script src="..."> references.
 * Only collects classic scripts (non-module, non-CDN, non-inline).
 *
 * Supports:
 *   <script src="app.js">
 *   <script th:src="@{/js/app.js}">
 *   <script src="${pageContext.request.contextPath}/js/app.js">
 */
export function extractScriptReferences(templatePath: string): ScriptReference[] {
    let content: string;
    try {
        content = fs.readFileSync(templatePath, 'utf-8');
    } catch {
        return [];
    }

    const templateDir = path.dirname(templatePath);
    const projectRoot = findProjectRoot(templateDir) ?? templateDir;
    const webappRoot = findWebappRoot(projectRoot) ?? templateDir;
    const results: ScriptReference[] = [];

    const scriptTagRegex = /<script\b([^>]*)(?:\/>|>[^<]*<\/script>)/gi;
    let match: RegExpExecArray | null;

    while ((match = scriptTagRegex.exec(content)) !== null) {
        const attrs = match[1];

        const srcMatch = attrs.match(/\b(?:th:src|data-th-src|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
        if (!srcMatch) {
            continue;
        }
        let src = (srcMatch[1] ?? srcMatch[2]) || '';
        if (!src) { continue; }

        src = stripTemplateExpression(src);
        if (!src) { continue; }

        if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('//')) {
            continue;
        }

        const typeMatch = attrs.match(/\btype\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
        const typeValue = typeMatch ? (typeMatch[1] ?? typeMatch[2]) : null;

        if (typeValue === 'module') { continue; }
        if (typeValue && typeValue !== 'text/javascript' && typeValue !== 'application/javascript') {
            continue;
        }

        let absolutePath: string;
        if (src.startsWith('/')) {
            const fromWebapp = path.join(webappRoot, src);
            const fromProject = path.join(projectRoot, src);
            absolutePath = fs.existsSync(fromWebapp) ? fromWebapp : fromProject;
        } else {
            absolutePath = path.resolve(templateDir, src);
        }

        results.push({ absolutePath, src, isClassic: true });
    }

    return results;
}

/**
 * Collect all script references reachable from a template file,
 * following include directives recursively.
 */
export function collectScriptsFromTemplateTree(
    templatePath: string,
    projectRoot: string
): ScriptReference[] {
    const includedFiles = collectIncludeTree(templatePath, projectRoot);
    const seen = new Set<string>();
    const allScripts: ScriptReference[] = [];

    for (const filePath of includedFiles) {
        const scripts = extractScriptReferences(filePath);
        for (const s of scripts) {
            if (!seen.has(s.absolutePath)) {
                seen.add(s.absolutePath);
                allScripts.push(s);
            }
        }
    }

    return allScripts;
}

/**
 * Find all template files (HTML, JSP, FTL, Mayaa, etc.) in the search scope
 * that include the target JS file (directly or via include chains).
 *
 * Search strategy:
 * 1. Immediate and parent directories (up to maxDepth levels)
 * 2. If a project root is found, also scan webapp-specific directories
 *
 * Returns results sorted: same-directory first, then parent directories.
 */
export function findAllHtmlsForJsFile(
    targetJsPath: string,
    maxDepth: number = 3
): { htmlPath: string; scripts: ScriptReference[] }[] {
    const targetAbsolute = path.resolve(targetJsPath);
    let searchDir = path.dirname(targetAbsolute);
    const rootDir = path.parse(searchDir).root;
    const results: { htmlPath: string; scripts: ScriptReference[] }[] = [];
    const seenTemplates = new Set<string>();

    const projectRoot = findProjectRoot(searchDir);

    const checkTemplate = (templatePath: string): void => {
        const normalized = path.normalize(templatePath);
        if (seenTemplates.has(normalized)) { return; }
        seenTemplates.add(normalized);

        let content: string;
        try {
            content = fs.readFileSync(templatePath, 'utf-8');
        } catch {
            return;
        }

        const baseName = path.basename(targetAbsolute);
        const baseNameNoExt = path.basename(baseName, path.extname(baseName));
        if (!content.includes(baseName) && !content.includes(baseNameNoExt)) {
            return;
        }

        const scripts = collectScriptsFromTemplateTree(
            templatePath,
            projectRoot ?? path.dirname(templatePath)
        );
        const referencesTarget = scripts.some(
            s => path.normalize(s.absolutePath) === path.normalize(targetAbsolute)
        );
        if (referencesTarget) {
            results.push({ htmlPath: templatePath, scripts });
        }
    };

    const extSet = new Set(TEMPLATE_EXTENSIONS);
    let currentDir = searchDir;
    for (let depth = 0; depth < maxDepth && currentDir !== rootDir; depth++) {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(currentDir, { withFileTypes: true });
        } catch {
            currentDir = path.dirname(currentDir);
            continue;
        }

        const templateFiles = entries
            .filter(e => e.isFile() && extSet.has(path.extname(e.name).toLowerCase()))
            .map(e => path.join(currentDir, e.name));

        for (const tf of templateFiles) {
            checkTemplate(tf);
        }

        currentDir = path.dirname(currentDir);
    }

    if (projectRoot) {
        const webappScanDirs = [
            'src/main/webapp',
            'src/main/resources/templates',
            'webapp',
            'WebContent',
        ].map(d => path.join(projectRoot, d)).filter(d => fs.existsSync(d));

        for (const webDir of webappScanDirs) {
            const allTemplates = findAllTemplateFiles(webDir, 8);
            for (const tf of allTemplates) {
                checkTemplate(tf);
            }
        }
    }

    return results;
}

/**
 * Find template files in the given directory and its parent directories that
 * reference the target JS file via <script src>.
 * Returns the first matching template's script references.
 */
export function findHtmlForJsFile(
    targetJsPath: string,
    maxDepth: number = 3
): { htmlPath: string; scripts: ScriptReference[] } | null {
    const results = findAllHtmlsForJsFile(targetJsPath, maxDepth);
    return results.length > 0 ? results[0] : null;
}
