'use strict';
/**
 * Loads the compiled CallCanvas VS Code extensions into this process.
 *
 * `require('vscode')` is intercepted and answered with the shim, so the very same
 * `out/extension.js` that ships in the VSIX runs here. Nothing is forked or
 * re-implemented: analysis, signature resolution and the viewer HTML all come
 * from the extensions themselves.
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** id -> repo directory name (the monorepo layout) */
const EXTENSIONS = [
    { id: 'share-github.java-call-hierarchy', dirName: 'vscode-java-call-hierarchy' },
    { id: 'share-github.javascript-call-hierarchy', dirName: 'vscode-javascript-call-hierarchy' },
    { id: 'share-github.typescript-call-hierarchy', dirName: 'vscode-typescript-call-hierarchy' },
    // The viewer activates last so the language extensions' API commands already exist.
    { id: 'share-github.callcanvas-viewer', dirName: 'vscode-callcanvas-viewer' }
];

function installedExtensionDirs() {
    const roots = [
        path.join(process.env.HOME || '', '.vscode', 'extensions'),
        path.join(process.env.HOME || '', '.vscode-server', 'extensions'),
        path.join(process.env.HOME || '', '.cursor', 'extensions'),
        path.join(process.env.HOME || '', '.cursor-server', 'extensions')
    ];
    const found = [];
    for (const root of roots) {
        let entries;
        try {
            entries = fs.readdirSync(root, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            if (entry.isDirectory() && entry.name.startsWith('share-github.')) {
                found.push(path.join(root, entry.name));
            }
        }
    }
    return found;
}

/**
 * Resolve where each extension lives. Priority:
 *   1. CALLCANVAS_EXT_DIR_<UPPER_SNAKE_ID> env override
 *   2. the monorepo checkout next to this package
 *   3. an installed VSIX directory (~/.vscode/extensions/...), newest version
 */
function resolveExtensionDirs() {
    const resolved = {};
    const installed = installedExtensionDirs();

    for (const ext of EXTENSIONS) {
        const envKey = 'CALLCANVAS_EXT_DIR_' + ext.dirName.replace(/[^A-Za-z0-9]/g, '_').toUpperCase();
        const candidates = [];
        if (process.env[envKey]) {
            candidates.push(process.env[envKey]);
        }
        candidates.push(path.join(REPO_ROOT, ext.dirName));

        const prefix = ext.id + '-';
        const matches = installed
            .filter(dir => path.basename(dir).startsWith(prefix))
            .sort()
            .reverse();
        candidates.push(...matches);

        const hit = candidates.find(dir => dir && fs.existsSync(path.join(dir, 'out', 'extension.js')));
        if (hit) {
            resolved[ext.id] = path.resolve(hit);
        }
    }
    return resolved;
}

let hookInstalled = false;
let currentShim = null;

/**
 * A stable stand-in for the `vscode` module.
 *
 * The compiled extensions import it once per module (`__importStar(require("vscode"))`,
 * which installs live getters), so every property read has to resolve against the
 * shim that is active *now* rather than the one that existed at import time. That
 * keeps a second host in the same process (tests, `callcanvas command`) correct
 * instead of silently registering its commands into the first host's registry.
 */
const vscodeModuleProxy = new Proxy({}, {
    get(_target, property) {
        if (!currentShim) {
            throw new Error('vscode shim requested before the extension host was created');
        }
        return currentShim[property];
    },
    has(_target, property) {
        return currentShim ? property in currentShim : false;
    },
    ownKeys() {
        return currentShim ? Reflect.ownKeys(currentShim) : [];
    },
    getOwnPropertyDescriptor(_target, property) {
        if (!currentShim) {
            return undefined;
        }
        return { configurable: true, enumerable: true, value: currentShim[property], writable: true };
    }
});

/** Intercept `require('vscode')` process-wide and answer with the shim proxy. */
function installRequireHook() {
    if (hookInstalled) {
        return;
    }
    const originalLoad = Module._load;
    Module._load = function patchedLoad(request) {
        if (request === 'vscode') {
            return vscodeModuleProxy;
        }
        return originalLoad.apply(this, arguments);
    };
    hookInstalled = true;
}

/**
 * Activate every extension that could be found.
 * @param {object} shimResult result of createVscodeShim()
 * @param {Record<string,string>} dirs extension id -> directory
 * @param {(msg: string) => void} log
 * @returns {{ dirs: Record<string,string>, activated: string[], missing: string[] }}
 */
function activateExtensions(shimResult, dirs, log = () => {}) {
    installRequireHook();
    currentShim = shimResult.vscode;

    const activated = [];
    const missing = [];

    for (const ext of EXTENSIONS) {
        const dir = dirs[ext.id];
        if (!dir) {
            missing.push(ext.id);
            continue;
        }
        const entry = path.join(dir, 'out', 'extension.js');
        try {
            const mod = require(entry);
            if (typeof mod.activate !== 'function') {
                throw new Error('no activate() export');
            }
            mod.activate(shimResult.makeExtensionContext(dir));
            activated.push(ext.id);
            log(`activated ${ext.id} (${dir})`);
        } catch (error) {
            missing.push(ext.id);
            log(`failed to activate ${ext.id}: ${error && error.stack ? error.stack : error}`);
        }
    }
    return { dirs, activated, missing };
}

module.exports = { EXTENSIONS, REPO_ROOT, resolveExtensionDirs, activateExtensions, vscodeModuleProxy };
