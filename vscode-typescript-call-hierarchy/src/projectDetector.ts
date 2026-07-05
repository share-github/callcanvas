import * as path from 'path';
import * as fs from 'fs';
import * as ts from 'typescript';
import { ProjectContext } from './types';

const MAX_FILES_WITHOUT_CONFIG = 500;

/**
 * Detect project type and collect files for analysis (TypeScript only).
 *
 * Decision tree:
 * 1. tsconfig.json → use config to get file list
 * 2. package.json → scan directory for .ts/.tsx/.mts
 * 3. None → single file mode
 */
export function detectProject(targetFilePath: string): ProjectContext {
    const targetAbsolute = path.resolve(targetFilePath);
    const targetDir = path.dirname(targetAbsolute);

    const configResult = findTsConfigFile(targetDir, targetAbsolute);
    if (configResult) {
        return configResult;
    }

    const packageDir = findParentWithFile(targetDir, 'package.json');
    if (packageDir) {
        const files = collectTypeScriptSourceFiles(packageDir);
        if (files.length > MAX_FILES_WITHOUT_CONFIG) {
            console.warn(
                `Found ${files.length} files. Consider creating tsconfig.json for better analysis.`
            );
        }
        return {
            type: 'package',
            files: files.slice(0, MAX_FILES_WITHOUT_CONFIG),
            rootDir: packageDir,
        };
    }

    return {
        type: 'single',
        files: [targetAbsolute],
        rootDir: targetDir,
    };
}

function findTsConfigFile(startDir: string, targetAbsolute: string): ProjectContext | null {
    let dir = startDir;
    const rootDir = path.parse(dir).root;

    while (dir !== rootDir) {
        const configPath = path.join(dir, 'tsconfig.json');
        if (fs.existsSync(configPath)) {
            try {
                const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
                if (configFile.error) { continue; }

                const parsed = ts.parseJsonConfigFileContent(
                    configFile.config,
                    ts.sys,
                    dir
                );

                const normalizedTarget = path.normalize(targetAbsolute);
                const isIncluded = parsed.fileNames.some(
                    f => path.normalize(f) === normalizedTarget
                );
                if (!isIncluded) { continue; }

                return {
                    type: 'tsconfig',
                    files: parsed.fileNames,
                    rootDir: dir,
                    compilerOptions: parsed.options,
                };
            } catch {
                continue;
            }
        }
        dir = path.dirname(dir);
    }

    return null;
}

function findParentWithFile(startDir: string, fileName: string): string | null {
    let dir = startDir;
    const rootDir = path.parse(dir).root;

    while (dir !== rootDir) {
        if (fs.existsSync(path.join(dir, fileName))) {
            return dir;
        }
        dir = path.dirname(dir);
    }

    return null;
}

function collectTypeScriptSourceFiles(rootDir: string): string[] {
    const files: string[] = [];
    const excludeDirs = new Set(['node_modules', 'dist', 'build', '.git', 'out', 'coverage', '.next']);
    const sourceExtensions = new Set(['.ts', '.tsx', '.mts']);
    let limitReached = false;

    function walk(dir: string): void {
        if (limitReached) { return; }
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            if (limitReached) { return; }
            if (entry.isDirectory()) {
                if (!excludeDirs.has(entry.name)) {
                    walk(path.join(dir, entry.name));
                }
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name);
                if (sourceExtensions.has(ext)) {
                    files.push(path.join(dir, entry.name));
                    if (files.length >= MAX_FILES_WITHOUT_CONFIG) {
                        limitReached = true;
                        return;
                    }
                }
            }
        }
    }

    walk(rootDir);
    return files;
}
