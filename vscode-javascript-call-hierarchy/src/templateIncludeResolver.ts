import * as path from 'path';
import * as fs from 'fs';

export type TemplateType = 'jsp' | 'thymeleaf' | 'freemarker' | 'mayaa' | 'html';

export interface IncludeDirective {
    type: TemplateType;
    rawPath: string;
    line: number;  // 1-based
}

/** Template file extensions to scan */
export const TEMPLATE_EXTENSIONS = ['.html', '.htm', '.jsp', '.jspf', '.ftl', '.ftlh', '.mayaa'];

/** Project root marker files (searched upward) */
const PROJECT_ROOT_MARKERS = ['pom.xml', 'build.gradle', 'build.gradle.kts', '.git', 'gradlew'];

/** Candidate subdirectories for webapp templates (relative to project root) */
const WEBAPP_CANDIDATE_DIRS = [
    'src/main/webapp',
    'src/main/resources/templates',
    'webapp',
    'WebContent',
    'src/main/webapp/WEB-INF',
    'WEB-INF',
];

/**
 * Detect the template type from a file extension.
 */
export function detectTemplateType(filePath: string): TemplateType {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.jsp' || ext === '.jspf') { return 'jsp'; }
    if (ext === '.ftl' || ext === '.ftlh') { return 'freemarker'; }
    if (ext === '.mayaa') { return 'mayaa'; }
    // .html / .htm — could be Thymeleaf or plain HTML, treat as thymeleaf for include detection
    return 'thymeleaf';
}

/**
 * Extract all include directives from a template file's content.
 * Handles JSP, Thymeleaf, FreeMarker, and Mayaa include patterns.
 *
 * All patterns are tried regardless of file extension because:
 *   - FreeMarker can include .html files that also contain <#include>
 *   - .html files may use any template engine
 */
export function extractIncludeDirectives(content: string, fileType: TemplateType): IncludeDirective[] {
    const directives: IncludeDirective[] = [];

    // Always try all include patterns — file extension alone is insufficient
    // to determine the template engine (e.g. FreeMarker includes .html files).
    extractJspIncludes(content, directives);
    extractThymeleafIncludes(content, directives);
    extractFreemarkerIncludes(content, directives);
    extractMayaaIncludes(content, directives);

    return directives;
}

function getLineNumber(content: string, matchIndex: number): number {
    let line = 1;
    for (let i = 0; i < matchIndex; i++) {
        if (content[i] === '\n') { line++; }
    }
    return line;
}

function extractJspIncludes(content: string, directives: IncludeDirective[]): void {
    // <%@ include file="path.jsp" %>
    const staticInclude = /<%@\s*include\s+file\s*=\s*["']([^"']+)["']/gi;
    let m: RegExpExecArray | null;
    while ((m = staticInclude.exec(content)) !== null) {
        directives.push({ type: 'jsp', rawPath: m[1], line: getLineNumber(content, m.index) });
    }

    // <jsp:include page="path.jsp" />
    const dynamicInclude = /<jsp:include\s+[^>]*page\s*=\s*["']([^"']+)["']/gi;
    while ((m = dynamicInclude.exec(content)) !== null) {
        directives.push({ type: 'jsp', rawPath: m[1], line: getLineNumber(content, m.index) });
    }
}

function extractThymeleafIncludes(content: string, directives: IncludeDirective[]): void {
    // th:replace / th:insert / th:include (and data-th- variants)
    // Values: "templateName :: fragment", "~{templateName :: fragment}", "templateName"
    const attrs = [
        /(?:th:|data-th-)replace\s*=\s*["']([^"']+)["']/gi,
        /(?:th:|data-th-)insert\s*=\s*["']([^"']+)["']/gi,
        /(?:th:|data-th-)include\s*=\s*["']([^"']+)["']/gi,
    ];

    for (const regex of attrs) {
        let m: RegExpExecArray | null;
        while ((m = regex.exec(content)) !== null) {
            const raw = m[1];
            // Strip ~{...} wrapper
            const inner = raw.replace(/^~\{(.*)\}$/, '$1').trim();
            // Extract template name (before " :: ")
            const templateName = inner.split('::')[0].trim();
            if (templateName && templateName !== 'this') {
                directives.push({ type: 'thymeleaf', rawPath: templateName, line: getLineNumber(content, m.index) });
            }
        }
    }
}

function extractFreemarkerIncludes(content: string, directives: IncludeDirective[]): void {
    // <#include "path.ftl">
    const includeRegex = /<#include\s+["']([^"']+)["']/gi;
    let m: RegExpExecArray | null;
    while ((m = includeRegex.exec(content)) !== null) {
        directives.push({ type: 'freemarker', rawPath: m[1], line: getLineNumber(content, m.index) });
    }

    // <#import "path.ftl" as name>
    const importRegex = /<#import\s+["']([^"']+)["']/gi;
    while ((m = importRegex.exec(content)) !== null) {
        directives.push({ type: 'freemarker', rawPath: m[1], line: getLineNumber(content, m.index) });
    }
}

function extractMayaaIncludes(content: string, directives: IncludeDirective[]): void {
    // <m:insert path="templateName" />
    const insertRegex = /<m:insert\s+[^>]*path\s*=\s*["']([^"']+)["']/gi;
    let m: RegExpExecArray | null;
    while ((m = insertRegex.exec(content)) !== null) {
        directives.push({ type: 'mayaa', rawPath: m[1], line: getLineNumber(content, m.index) });
    }

    // m:extends="templateName" attribute on root element
    const extendsRegex = /m:extends\s*=\s*["']([^"']+)["']/gi;
    while ((m = extendsRegex.exec(content)) !== null) {
        directives.push({ type: 'mayaa', rawPath: m[1], line: getLineNumber(content, m.index) });
    }
}

/**
 * Find the project root by searching upward for marker files.
 */
export function findProjectRoot(startDir: string): string | null {
    let dir = startDir;
    const root = path.parse(dir).root;

    while (dir !== root) {
        for (const marker of PROJECT_ROOT_MARKERS) {
            if (fs.existsSync(path.join(dir, marker))) {
                return dir;
            }
        }
        dir = path.dirname(dir);
    }
    return null;
}

/**
 * Find the webapp root (directory containing WEB-INF) by searching from the project root.
 * Used to resolve absolute-path includes (starting with /).
 */
export function findWebappRoot(projectRoot: string): string | null {
    for (const candidate of WEBAPP_CANDIDATE_DIRS) {
        const candidatePath = path.join(projectRoot, candidate);
        if (fs.existsSync(candidatePath)) {
            return candidatePath;
        }
    }
    return null;
}

/**
 * Find the Thymeleaf template root directory.
 * Spring Boot default: src/main/resources/templates
 */
export function findTemplatesRoot(projectRoot: string): string | null {
    const springBootTemplates = path.join(projectRoot, 'src/main/resources/templates');
    if (fs.existsSync(springBootTemplates)) {
        return springBootTemplates;
    }
    // Fallback: look for a "templates" directory anywhere under project root
    const candidates = [
        path.join(projectRoot, 'templates'),
        path.join(projectRoot, 'src/main/resources'),
        path.join(projectRoot, 'resources/templates'),
    ];
    for (const c of candidates) {
        if (fs.existsSync(c)) { return c; }
    }
    return null;
}

/**
 * Resolve an include directive path to an absolute file path.
 * Returns null if the file cannot be found.
 */
export function resolveIncludePath(
    directive: IncludeDirective,
    currentFilePath: string,
    projectRoot: string
): string | null {
    const currentDir = path.dirname(currentFilePath);
    let rawPath = directive.rawPath;

    // Strip template expression wrappers like ${...} or @{...}
    rawPath = rawPath.replace(/^[$@#]\{(.*)\}$/, '$1').trim();

    // Strip query strings / fragment identifiers that templates may add
    rawPath = rawPath.split('?')[0].split('#')[0];

    if (!rawPath) { return null; }

    const candidates = buildCandidatePaths(rawPath, currentDir, projectRoot, directive.type);

    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
        // Try adding common template extensions if no extension
        if (!path.extname(candidate)) {
            for (const ext of ['.html', '.jsp', '.jspf', '.ftl', '.ftlh']) {
                const withExt = candidate + ext;
                if (fs.existsSync(withExt)) {
                    return withExt;
                }
            }
        }
    }

    return null;
}

function buildCandidatePaths(
    rawPath: string,
    currentDir: string,
    projectRoot: string,
    type: TemplateType
): string[] {
    const candidates: string[] = [];

    if (rawPath.startsWith('/')) {
        // Absolute path — try webapp root first
        const webappRoot = findWebappRoot(projectRoot);
        if (webappRoot) {
            candidates.push(path.join(webappRoot, rawPath));
        }
        // Then project root itself
        candidates.push(path.join(projectRoot, rawPath));
        // Also try each webapp candidate dir
        for (const wd of WEBAPP_CANDIDATE_DIRS) {
            candidates.push(path.join(projectRoot, wd, rawPath));
        }
    } else {
        // Relative path — try current directory first
        candidates.push(path.resolve(currentDir, rawPath));

        if (type === 'thymeleaf') {
            // Thymeleaf: template names are relative to templates root
            const templatesRoot = findTemplatesRoot(projectRoot);
            if (templatesRoot) {
                candidates.push(path.join(templatesRoot, rawPath));
                // Also try with path separators converted (Thymeleaf uses / as path separator)
                candidates.push(path.join(templatesRoot, rawPath.replace(/\//g, path.sep)));
            }
            // Also try from project root
            candidates.push(path.join(projectRoot, rawPath));
        } else if (type === 'mayaa') {
            // Mayaa: relative to current file, then webapp root
            const webappRoot = findWebappRoot(projectRoot);
            if (webappRoot) {
                candidates.push(path.join(webappRoot, rawPath));
            }
            candidates.push(path.join(projectRoot, rawPath));
        }
    }

    return candidates;
}

/**
 * Recursively collect all template files reachable via include directives
 * from the given entry file.
 *
 * Returns an array of absolute paths (including the entry file itself).
 * Handles circular references via a visited set.
 */
export function collectIncludeTree(
    entryFilePath: string,
    projectRoot: string
): string[] {
    const visited = new Set<string>();
    const result: string[] = [];

    function visit(filePath: string): void {
        const normalized = path.normalize(filePath);
        if (visited.has(normalized)) { return; }
        visited.add(normalized);

        let content: string;
        try {
            content = fs.readFileSync(filePath, 'utf-8');
        } catch {
            return;
        }

        result.push(filePath);

        const fileType = detectTemplateType(filePath);
        const directives = extractIncludeDirectives(content, fileType);

        for (const directive of directives) {
            const resolved = resolveIncludePath(directive, filePath, projectRoot);
            if (resolved) {
                visit(resolved);
            }
        }

        // For .html files that may have a Mayaa companion (.mayaa)
        if (path.extname(filePath).toLowerCase() === '.html') {
            const mayaaPath = filePath.replace(/\.html$/i, '.mayaa');
            if (fs.existsSync(mayaaPath)) {
                visit(mayaaPath);
            }
        }
    }

    visit(entryFilePath);
    return result;
}

export interface IncludeEdge {
    fromFile: string;      // absolute path
    toFile: string;        // absolute path
    directiveLine: number;
    directiveType: TemplateType;
}

/**
 * Recursively collect all template files reachable via include directives
 * from the given entry file, preserving parent-child edges.
 *
 * Returns { nodes: absolute paths, edges: directed include edges }.
 * Handles circular references via a visited set.
 */
export function collectIncludeEdges(
    entryFilePath: string,
    projectRoot: string
): { nodes: string[]; edges: IncludeEdge[] } {
    const visited = new Set<string>();
    const nodes: string[] = [];
    const edges: IncludeEdge[] = [];

    function visit(filePath: string): void {
        const normalized = path.normalize(filePath);
        if (visited.has(normalized)) { return; }
        visited.add(normalized);

        let content: string;
        try {
            content = fs.readFileSync(filePath, 'utf-8');
        } catch {
            return;
        }

        nodes.push(filePath);

        const fileType = detectTemplateType(filePath);
        const directives = extractIncludeDirectives(content, fileType);

        for (const directive of directives) {
            const resolved = resolveIncludePath(directive, filePath, projectRoot);
            if (resolved) {
                edges.push({
                    fromFile: filePath,
                    toFile: resolved,
                    directiveLine: directive.line,
                    directiveType: directive.type,
                });
                visit(resolved);
            }
        }

        // For .html files that may have a Mayaa companion (.mayaa)
        if (path.extname(filePath).toLowerCase() === '.html') {
            const mayaaPath = filePath.replace(/\.html$/i, '.mayaa');
            if (fs.existsSync(mayaaPath)) {
                edges.push({
                    fromFile: filePath,
                    toFile: mayaaPath,
                    directiveLine: 1,
                    directiveType: 'mayaa',
                });
                visit(mayaaPath);
            }
        }
    }

    visit(entryFilePath);
    return { nodes, edges };
}

/**
 * Find all template files under searchRoot that have the given template extensions.
 * Respects a maximum search depth.
 */
export function findAllTemplateFiles(
    searchRoot: string,
    maxDepth: number = 10
): string[] {
    const files: string[] = [];
    const extSet = new Set(TEMPLATE_EXTENSIONS);
    const excludeDirs = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'target/classes']);

    function walk(dir: string, depth: number): void {
        if (depth > maxDepth) { return; }
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (entry.isDirectory()) {
                if (!excludeDirs.has(entry.name)) {
                    walk(path.join(dir, entry.name), depth + 1);
                }
            } else if (entry.isFile()) {
                if (extSet.has(path.extname(entry.name).toLowerCase())) {
                    files.push(path.join(dir, entry.name));
                }
            }
        }
    }

    walk(searchRoot, 0);
    return files;
}
