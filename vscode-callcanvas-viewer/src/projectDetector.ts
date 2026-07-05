import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';
import { log } from './logger';

/**
 * Find the root of a multi-module project.
 * 1. Explicit: settings.gradle with 'include' / pom.xml with <modules> (traverses upward)
 * 2. Implicit: immediate parent has sibling directories with build files (1 level only)
 *
 * Implicit is limited to the immediate parent of startPath to avoid climbing
 * through deeply nested directories and matching unrelated projects
 * (e.g. /workspace/app when the project is under /workspace/issue/.../java-src).
 */
export function findMultiModuleRoot(startPath: string): string | null {
    const root = path.parse(startPath).root;

    // Implicit: check only the immediate parent for sibling modules
    const parentDir = path.dirname(startPath);
    if (parentDir !== startPath) {
        const siblings = countBuildSiblings(parentDir, startPath);
        if (siblings >= 1) {
            return parentDir;
        }
    }

    // Explicit: traverse upward for settings.gradle include / pom.xml <modules>
    let current = startPath;
    while (current !== root) {
        const settingsGradle = path.join(current, 'settings.gradle');
        const settingsGradleKts = path.join(current, 'settings.gradle.kts');

        for (const settingsFile of [settingsGradle, settingsGradleKts]) {
            if (fs.existsSync(settingsFile)) {
                const content = fs.readFileSync(settingsFile, 'utf-8');
                if (content.includes('include')) {
                    return current;
                }
            }
        }

        const pomXml = path.join(current, 'pom.xml');
        if (fs.existsSync(pomXml)) {
            const content = fs.readFileSync(pomXml, 'utf-8');
            if (content.includes('<modules>') || content.includes('<module>')) {
                return current;
            }
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
 * Find all submodule paths in a multi-module project
 */
export function findSubModules(multiModuleRoot: string): string[] {
    const modules: string[] = [];

    // Try Gradle settings.gradle
    const settingsGradle = path.join(multiModuleRoot, 'settings.gradle');
    const settingsGradleKts = path.join(multiModuleRoot, 'settings.gradle.kts');

    for (const settingsFile of [settingsGradle, settingsGradleKts]) {
        if (fs.existsSync(settingsFile)) {
            const content = fs.readFileSync(settingsFile, 'utf-8');
            const includeMatches = content.matchAll(/include\s*[('"][:']?([^'")\s]+)['")\s]/g);
            for (const match of includeMatches) {
                const moduleName = match[1].replace(/^:/, '');
                const modulePath = path.join(multiModuleRoot, moduleName);
                if (fs.existsSync(modulePath)) {
                    modules.push(modulePath);
                }
            }
        }
    }

    // Try Maven pom.xml with <modules>
    const pomXml = path.join(multiModuleRoot, 'pom.xml');
    if (fs.existsSync(pomXml) && modules.length === 0) {
        const content = fs.readFileSync(pomXml, 'utf-8');
        const moduleMatches = content.matchAll(/<module>([^<]+)<\/module>/g);
        for (const match of moduleMatches) {
            const modulePath = path.join(multiModuleRoot, match[1]);
            if (fs.existsSync(modulePath)) {
                modules.push(modulePath);
            }
        }
    }

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


/**
 * Find the analyzer JAR file
 * Priority: 1. Java Call Hierarchy extension's JAR, 2. CallCanvas Viewer's bundled JAR, 3. Development paths
 */
export function findAnalyzerJar(context: vscode.ExtensionContext, workspaceRoot: string): string | null {
    // 1. Java Call Hierarchy extension's resources (production: JAR is bundled there)
    const jchExtension = vscode.extensions.getExtension('share-github.java-call-hierarchy');
    if (jchExtension) {
        const jchJar = path.join(jchExtension.extensionPath, 'resources', 'java-call-hierarchy-analyzer.jar');
        if (fs.existsSync(jchJar)) {
            log(`Found analyzer JAR (from Java Call Hierarchy ext): ${jchJar}`);
            return jchJar;
        }
    }

    // 2. CallCanvas Viewer's own bundled resources (legacy fallback)
    const bundledJar = path.join(context.extensionPath, 'resources', 'java-call-hierarchy-analyzer.jar');
    if (fs.existsSync(bundledJar)) {
        log(`Found analyzer JAR (bundled): ${bundledJar}`);
        return bundledJar;
    }

    // 3. Development: scan app/build/libs for any matching JAR
    const devDirs = [
        path.join(workspaceRoot, 'app/build/libs'),
        path.join(workspaceRoot, '.devcontainer/vscode-extension/callcanvas-viewer'),
    ];
    for (const dir of devDirs) {
        const jar = findJarInDir(dir);
        if (jar) {
            log(`Found analyzer JAR (dev): ${jar}`);
            return jar;
        }
    }

    return null;
}

/** Find a java-call-hierarchy-analyzer JAR in a directory (prefer fat JAR over plain JAR). */
function findJarInDir(dirPath: string): string | undefined {
    if (!fs.existsSync(dirPath)) {
        return undefined;
    }
    try {
        const jars = fs.readdirSync(dirPath).filter(f =>
            f.startsWith('java-call-hierarchy-analyzer') &&
            f.endsWith('.jar') &&
            !f.includes('-sources') &&
            !f.includes('-javadoc')
        );
        if (jars.length === 0) {
            return undefined;
        }
        const fatJar = jars.find(f => !f.includes('-plain'));
        return path.join(dirPath, fatJar ?? jars[0]);
    } catch {
        return undefined;
    }
}

/**
 * Find Java executable path
 * Priority: 1. javaCallHierarchy.javaPath setting, 2. JAVA_HOME, 3. PATH
 */
export async function findJavaPath(): Promise<string | null> {
    // 1. Check javaCallHierarchy.javaPath setting (highest priority)
    const config = vscode.workspace.getConfiguration('javaCallHierarchy');
    const configuredJavaPath = config.get<string>('javaPath', '');
    if (configuredJavaPath) {
        if (fs.existsSync(configuredJavaPath)) {
            log(`Using configured Java path: ${configuredJavaPath}`);
            return configuredJavaPath;
        } else {
            log(`Configured Java path not found: ${configuredJavaPath}`);
        }
    }

    // 2. Check JAVA_HOME
    const javaHome = process.env.JAVA_HOME;
    if (javaHome) {
        const javaPath = path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
        if (fs.existsSync(javaPath)) {
            log(`Using JAVA_HOME: ${javaPath}`);
            return javaPath;
        }
    }

    // 3. Try java in PATH
    return new Promise((resolve) => {
        exec('which java || where java', (error, stdout) => {
            if (error || !stdout.trim()) {
                resolve(null);
            } else {
                const javaPath = stdout.trim().split('\n')[0];
                log(`Using Java from PATH: ${javaPath}`);
                resolve(javaPath);
            }
        });
    });
}
