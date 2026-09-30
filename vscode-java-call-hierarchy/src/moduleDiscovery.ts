import * as path from 'path';
import * as fs from 'fs';

// Module discovery for multi-module Maven/Gradle builds, shared by extension.ts and
// analyzer.ts. Kept free of the vscode API so it can be exercised from plain Node.

function readText(file: string): string | null {
    try {
        return fs.readFileSync(file, 'utf-8');
    } catch {
        return null;
    }
}

function isDirectory(p: string): boolean {
    try {
        return fs.statSync(p).isDirectory();
    } catch {
        return false;
    }
}

/**
 * Project paths named by the `include` statements of a settings.gradle(.kts).
 * Handles `include 'a', 'b'`, `include("a", "b")`, multi-line argument lists and
 * nested paths (':a:b' → 'a/b').
 */
function parseGradleIncludes(content: string): string[] {
    const withoutComments = content
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
    const names: string[] = [];
    // An include's arguments run to the end of the line, or to the closing paren
    // when they are wrapped in include( ... ) across several lines.
    const statement = /\binclude\s*(\(([^)]*)\)|([^\n]*))/g;
    for (const match of withoutComments.matchAll(statement)) {
        const args = match[2] ?? match[3] ?? '';
        for (const quoted of args.matchAll(/['"]([^'"]+)['"]/g)) {
            names.push(quoted[1]);
        }
    }
    return names;
}

/**
 * Directories of the Gradle projects a settings file includes. ':a:b' also makes
 * ':a' a project (Gradle creates it implicitly), so both are returned.
 */
function gradleModuleDirs(root: string): string[] | null {
    let found = false;
    const dirs: string[] = [];
    for (const name of ['settings.gradle', 'settings.gradle.kts']) {
        const content = readText(path.join(root, name));
        if (content === null) {
            continue;
        }
        found = true;
        for (const include of parseGradleIncludes(content)) {
            const segments = include.split(':').filter(Boolean);
            for (let i = 1; i <= segments.length; i++) {
                dirs.push(path.join(root, ...segments.slice(0, i)));
            }
        }
    }
    return found ? dirs : null;
}

/** Directories named by a pom.xml's <module> entries (comments ignored). */
function mavenModuleDirs(dir: string): string[] {
    const content = readText(path.join(dir, 'pom.xml'));
    if (content === null) {
        return [];
    }
    const withoutComments = content.replace(/<!--[\s\S]*?-->/g, '');
    const dirs: string[] = [];
    for (const match of withoutComments.matchAll(/<module>([^<]+)<\/module>/g)) {
        // <module> may point at a pom file rather than its directory.
        let modulePath = path.join(dir, match[1].trim());
        if (/\.xml$/i.test(modulePath)) {
            modulePath = path.dirname(modulePath);
        }
        dirs.push(modulePath);
    }
    return dirs;
}

/**
 * Every module declared under a multi-module root, following nested aggregators
 * (parent pom → ruoyi-modules/pom.xml → ruoyi-system). Aggregators without their
 * own sources (packaging=pom) are walked through but not returned; leaf modules
 * are returned whether or not they have src/main/java, as before.
 */
function collectDeclaredModules(multiModuleRoot: string): string[] {
    const result: string[] = [];
    const seen = new Set<string>([path.resolve(multiModuleRoot)]);

    const add = (dir: string, hasChildren: boolean) => {
        if (!hasChildren || fs.existsSync(path.join(dir, 'src', 'main', 'java'))) {
            result.push(dir);
        }
    };

    // Gradle: the root settings file already lists nested projects as ':a:b'.
    // Nested settings files belong to separate builds and are not followed.
    const gradleDirs = gradleModuleDirs(multiModuleRoot);
    if (gradleDirs) {
        const existing = gradleDirs.filter(dir => isDirectory(dir));
        for (const dir of existing) {
            const key = path.resolve(dir);
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            const hasChildren = existing.some(other => path.dirname(other) === dir);
            add(dir, hasChildren);
        }
        if (result.length > 0) {
            return result;
        }
    }

    // Maven: follow <modules> recursively. `seen` guards against cycles and
    // modules listed by more than one aggregator.
    const walk = (dir: string) => {
        for (const child of mavenModuleDirs(dir)) {
            const key = path.resolve(child);
            if (seen.has(key) || !isDirectory(child)) {
                continue;
            }
            seen.add(key);
            const grandChildren = mavenModuleDirs(child).length > 0;
            add(child, grandChildren);
            if (grandChildren) {
                walk(child);
            }
        }
    };
    walk(multiModuleRoot);
    return result;
}

/**
 * Does this directory declare itself the root of a multi-module build?
 */
function isAggregatorDir(dir: string): boolean {
    for (const name of ['settings.gradle', 'settings.gradle.kts']) {
        const content = readText(path.join(dir, name));
        if (content !== null && content.includes('include')) {
            return true;
        }
    }
    // Note: We check for '<modules>' only (not '<module>') to avoid false positives
    // from strings like '<artifactId>module-something</artifactId>'
    const pom = readText(path.join(dir, 'pom.xml'));
    return pom !== null && pom.includes('<modules>');
}

/**
 * Widen a multi-module root to the outermost aggregator that (transitively) declares
 * it. Without this, a file under ruoyi-modules/ruoyi-system stops at ruoyi-modules and
 * never sees ruoyi-common or ruoyi-admin.
 */
function widenToOutermostAggregator(root: string, boundary: string | null): string {
    let result = root;
    let current = path.dirname(root);
    const fsRoot = path.parse(root).root;
    while (current !== fsRoot) {
        if (boundary && !path.normalize(current).startsWith(boundary)) {
            break;
        }
        if (isAggregatorDir(current)) {
            if (allDeclaredDirs(current).has(path.resolve(result))) {
                result = current;
            }
        }
        if (boundary && path.normalize(current) === boundary) {
            break;
        }
        current = path.dirname(current);
    }
    return result;
}

/** All declared module directories under a root, aggregators included. */
function allDeclaredDirs(root: string): Set<string> {
    const dirs = new Set<string>();
    for (const dir of gradleModuleDirs(root) ?? []) {
        dirs.add(path.resolve(dir));
    }
    const walk = (dir: string) => {
        for (const child of mavenModuleDirs(dir)) {
            const key = path.resolve(child);
            if (dirs.has(key) || key === path.resolve(root)) {
                continue;
            }
            dirs.add(key);
            walk(child);
        }
    };
    walk(root);
    return dirs;
}

/**
 * Find the multi-module root directory (contains settings.gradle or pom.xml with <modules>).
 * A nested aggregator is widened to the outermost aggregator that declares it.
 * @param workspaceBoundary If provided, do not traverse above this directory.
 * @param allowImplicitMultiModule If false, do not treat a parent with sibling projects as multi-module root (avoids wrong root when workspace is a parent folder).
 */
export function findMultiModuleRoot(startPath: string, workspaceBoundary?: string, allowImplicitMultiModule: boolean = true): string | null {
    let current = startPath;
    const root = path.parse(current).root;
    const boundary = workspaceBoundary ? path.normalize(workspaceBoundary) : null;

    // Implicit multi-module: only check the immediate parent of startPath.
    // Climbing further would match unrelated projects (e.g. /workspace/app when
    // the project is deep under /workspace/issue/.../java-src).
    if (allowImplicitMultiModule) {
        const parentDir = path.dirname(startPath);
        if (parentDir !== startPath) {
            const normalizedParent = path.normalize(parentDir);
            const isAboveBoundary = boundary && !normalizedParent.startsWith(boundary);
            if (!isAboveBoundary) {
                const siblings = countBuildSiblings(parentDir, startPath);
                if (siblings >= 1) {
                    return widenToOutermostAggregator(parentDir, boundary);
                }
            }
        }
    }

    while (current !== root) {
        if (isAggregatorDir(current)) {
            return widenToOutermostAggregator(current, boundary);
        }

        // Stop traversal at workspace boundary
        if (boundary && path.normalize(current) === boundary) {
            break;
        }

        current = path.dirname(current);
    }

    return null;
}

/**
 * Count sibling directories that have pom.xml or build.gradle
 */
function countBuildSiblings(parentDir: string, excludePath: string): number {
    try {
        const entries = fs.readdirSync(parentDir, { withFileTypes: true });
        let count = 0;
        for (const entry of entries) {
            if (entry.isDirectory()) {
                const siblingPath = path.join(parentDir, entry.name);
                if (siblingPath !== excludePath) {
                    const hasPom = fs.existsSync(path.join(siblingPath, 'pom.xml'));
                    const hasBuildGradle = fs.existsSync(path.join(siblingPath, 'build.gradle'));
                    const hasBuildGradleKts = fs.existsSync(path.join(siblingPath, 'build.gradle.kts'));
                    if (hasPom || hasBuildGradle || hasBuildGradleKts) {
                        // Skip non-Java siblings (e.g. migration, config modules) —
                        // they don't disqualify the parent as a multi-module root.
                        const hasSrc = fs.existsSync(path.join(siblingPath, 'src', 'main', 'java'));
                        if (!hasSrc) {
                            continue;
                        }
                        count++;
                    }
                }
            }
        }
        return count;
    } catch {
        return 0;
    }
}

/**
 * Find all submodule paths in a multi-module project, following nested
 * <modules> and ':a:b' includes to any depth.
 */
export function findSubModules(multiModuleRoot: string): string[] {
    const modules = collectDeclaredModules(multiModuleRoot);

    // If no modules found, scan for directories with pom.xml or build.gradle
    if (modules.length === 0) {
        try {
            const entries = fs.readdirSync(multiModuleRoot, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    const modulePath = path.join(multiModuleRoot, entry.name);
                    const modulePom = path.join(modulePath, 'pom.xml');
                    const moduleBuildGradle = path.join(modulePath, 'build.gradle');
                    const moduleBuildGradleKts = path.join(modulePath, 'build.gradle.kts');
                    const moduleSrc = path.join(modulePath, 'src', 'main', 'java');

                    if ((fs.existsSync(modulePom) || fs.existsSync(moduleBuildGradle) || fs.existsSync(moduleBuildGradleKts))
                        && fs.existsSync(moduleSrc)) {
                        modules.push(modulePath);
                    }
                }
            }
        } catch {
            // Ignore errors
        }
    }

    // Also include the root if it has src/main/java
    const rootSrc = path.join(multiModuleRoot, 'src', 'main', 'java');
    if (fs.existsSync(rootSrc)) {
        modules.unshift(multiModuleRoot);
    }

    return modules;
}
