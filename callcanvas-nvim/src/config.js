'use strict';
/**
 * Configuration backing `vscode.workspace.getConfiguration()`.
 *
 * Defaults are read from each extension's package.json
 * (contributes.configuration.properties) so this host never hardcodes a value
 * the VSIX owns.
 *
 * Precedence, highest first:
 *   1. explicit overrides (`--set`, the Neovim plugin's `settings`)
 *   2. `<project>/.callcanvas/config.json`
 *   3. `.vscode/settings.json` — the project's, then each ancestor up to the repo
 *      root. This is the same file VS Code reads, so a setting like
 *      `callcanvas.jumpToCallTargetKey` configured once for the VSIX also applies
 *      here, without duplicating it per module.
 *   4. `~/.config/callcanvas/config.json`
 *   5. the package.json default, then the caller's fallback argument
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

/**
 * Strip `//` and block comments without touching string contents (a settings file
 * full of `"http://..."` values must survive).
 */
function stripJsonComments(text) {
    let out = '';
    let inString = false;
    let escaped = false;
    let inLineComment = false;
    let inBlockComment = false;

    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        const next = text[i + 1];

        if (inLineComment) {
            if (c === '\n') {
                inLineComment = false;
                out += c;
            }
            continue;
        }
        if (inBlockComment) {
            if (c === '*' && next === '/') {
                inBlockComment = false;
                i++;
            }
            continue;
        }
        if (inString) {
            out += c;
            if (escaped) {
                escaped = false;
            } else if (c === '\\') {
                escaped = true;
            } else if (c === '"') {
                inString = false;
            }
            continue;
        }
        if (c === '"') {
            inString = true;
            out += c;
            continue;
        }
        if (c === '/' && next === '/') {
            inLineComment = true;
            i++;
            continue;
        }
        if (c === '/' && next === '*') {
            inBlockComment = true;
            i++;
            continue;
        }
        out += c;
    }
    return out;
}

/** VS Code settings files are JSONC: comments and trailing commas are legal. */
function readJsonc(file) {
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch {
        return null;
    }
    try {
        return JSON.parse(stripJsonComments(text).replace(/,(\s*[}\]])/g, '$1'));
    } catch {
        return null;
    }
}

/**
 * `.vscode/settings.json` from `startDir` upwards, nearest first. The walk stops
 * at the repository root (inclusive), which is the folder VS Code would have open.
 */
function collectVscodeSettings(startDir) {
    const layers = [];
    let dir = path.resolve(startDir);
    for (let depth = 0; depth < 20; depth++) {
        const settings = readJsonc(path.join(dir, '.vscode', 'settings.json'));
        if (settings) {
            layers.push(flatten(settings));
        }
        if (fs.existsSync(path.join(dir, '.git'))) {
            break;
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            break;
        }
        dir = parent;
    }
    return layers;
}

/** Collect `contributes.configuration.properties` defaults from extension dirs. */
function collectContributedDefaults(extensionDirs) {
    const defaults = {};
    for (const dir of extensionDirs) {
        const pkg = readJson(path.join(dir, 'package.json'));
        const contributed = pkg && pkg.contributes && pkg.contributes.configuration;
        if (!contributed) {
            continue;
        }
        const blocks = Array.isArray(contributed) ? contributed : [contributed];
        for (const block of blocks) {
            const props = block && block.properties;
            if (!props) {
                continue;
            }
            for (const [key, spec] of Object.entries(props)) {
                if (spec && Object.prototype.hasOwnProperty.call(spec, 'default')) {
                    defaults[key] = spec.default;
                }
            }
        }
    }
    return defaults;
}

function userConfigPath() {
    const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    return path.join(base, 'callcanvas', 'config.json');
}

/** Flatten `{callcanvas: {windowWidth: 600}}` into `{'callcanvas.windowWidth': 600}`. */
function flatten(obj, prefix = '', out = {}) {
    for (const [key, value] of Object.entries(obj || {})) {
        const full = prefix ? `${prefix}.${key}` : key;
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            flatten(value, full, out);
        } else {
            out[full] = value;
        }
    }
    return out;
}

class ConfigStore {
    /**
     * @param {string[]} extensionDirs extension roots whose package.json holds defaults
     * @param {string} projectRoot      project root (for .callcanvas/config.json)
     * @param {object} overrides        flat key -> value overrides (CLI / nvim)
     */
    constructor(extensionDirs, projectRoot, overrides = {}) {
        this.contributed = collectContributedDefaults(extensionDirs);
        this.user = flatten(readJson(userConfigPath()) || {});
        this.project = flatten(readJson(path.join(projectRoot, '.callcanvas', 'config.json')) || {});
        this.vscode = collectVscodeSettings(projectRoot);
        this.overrides = flatten(overrides);
    }

    /** Layers in precedence order, highest first. */
    get layers() {
        return [this.overrides, this.project, ...this.vscode, this.user, this.contributed];
    }

    /** Look up a fully-qualified key (e.g. `callcanvas.windowWidth`). */
    lookup(fullKey, fallback) {
        for (const layer of this.layers) {
            if (Object.prototype.hasOwnProperty.call(layer, fullKey)) {
                return layer[fullKey];
            }
        }
        return fallback;
    }

    has(fullKey) {
        return this.layers.some(layer => Object.prototype.hasOwnProperty.call(layer, fullKey));
    }

    /** `vscode.workspace.getConfiguration(section)` */
    section(sectionName) {
        const prefix = sectionName ? `${sectionName}.` : '';
        const store = this;
        return {
            get(key, fallback) {
                return store.lookup(prefix + key, fallback);
            },
            has(key) {
                return store.has(prefix + key);
            },
            inspect(key) {
                const full = prefix + key;
                const vscodeLayer = store.vscode.find(l => Object.prototype.hasOwnProperty.call(l, full));
                return {
                    key: full,
                    defaultValue: store.contributed[full],
                    globalValue: store.user[full],
                    workspaceValue: Object.prototype.hasOwnProperty.call(store.project, full)
                        ? store.project[full]
                        : (vscodeLayer ? vscodeLayer[full] : undefined)
                };
            },
            async update(key, value) {
                store.overrides[prefix + key] = value;
            }
        };
    }
}

module.exports = { ConfigStore, userConfigPath, readJsonc, stripJsonComments, collectVscodeSettings };
