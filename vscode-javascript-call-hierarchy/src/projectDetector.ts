import * as path from 'path';
import * as fs from 'fs';
import * as ts from 'typescript';
import { ProjectContext } from './types';
import { findHtmlForJsFile } from './htmlProjectResolver';

const MAX_FILES_WITHOUT_CONFIG = 500;

/**
 * Detect project type and collect files for analysis.
 *
 * Decision tree:
 * 1. tsconfig.json / jsconfig.json → use config to get file list
 * 2. HTML file referencing the target JS → collect <script src> files
 * 3. package.json → scan directory for .js/.ts files
 * 4. None → single file mode
 */
export function detectProject(targetFilePath: string): ProjectContext {
    const targetAbsolute = path.resolve(targetFilePath);
    const targetDir = path.dirname(targetAbsolute);

    // 1. Check for tsconfig.json or jsconfig.json
    const configResult = findConfigFile(targetDir, targetAbsolute);
    if (configResult) {
        return configResult;
    }

    // 2. Check for HTML file referencing this JS
    const htmlResult = findHtmlForJsFile(targetAbsolute);
    if (htmlResult) {
        const rootDir = path.dirname(htmlResult.htmlPath);
        const files = htmlResult.scripts
            .map(s => s.absolutePath)
            .filter(f => fs.existsSync(f));
        return {
            type: 'html',
            files,
            rootDir,
            htmlPath: htmlResult.htmlPath,
        };
    }

    // 3. Check for package.json
    const packageDir = findParentWithFile(targetDir, 'package.json');
    if (packageDir) {
        const files = collectSourceFiles(packageDir);
        if (files.length > MAX_FILES_WITHOUT_CONFIG) {
            // Too many files - warn and suggest config
            console.warn(
                `Found ${files.length} files. Consider creating tsconfig.json or jsconfig.json for better analysis.`
            );
        }
        return {
            type: 'package',
            files: files.slice(0, MAX_FILES_WITHOUT_CONFIG),
            rootDir: packageDir,
        };
    }

    // 4. Single file mode
    return {
        type: 'single',
        files: [targetAbsolute],
        rootDir: targetDir,
    };
}

function findConfigFile(startDir: string, targetAbsolute: string): ProjectContext | null {
    let dir = startDir;
    const rootDir = path.parse(dir).root;

    while (dir !== rootDir) {
        for (const configName of ['tsconfig.json', 'jsconfig.json']) {
            const configPath = path.join(dir, configName);
            if (fs.existsSync(configPath)) {
                try {
                    const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
                    if (configFile.error) { continue; }

                    const parsed = ts.parseJsonConfigFileContent(
                        configFile.config,
                        ts.sys,
                        dir
                    );

                    // Verify the target file is included in this config's file list
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

function collectSourceFiles(rootDir: string): string[] {
    const files: string[] = [];
    const excludeDirs = new Set(['node_modules', 'dist', 'build', '.git', 'out', 'coverage']);
    const sourceExtensions = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);
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
