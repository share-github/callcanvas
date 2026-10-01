'use strict';
/**
 * Fixtures for the change-set tests (`callcanvas changeset`, `:CallCanvasChangeSet`).
 *
 *   node test/changeset-fixture.js   -> prints {"repo": ..., "commit": ..., "subject": ..., "env": {...}}
 *
 * - repo: a throwaway git repository (a copy of sample-project/sample-app-changeset)
 *   with two commits; the second adds a method to OrderService, so `commit` (the
 *   second commit's hash) has exactly one changed Java method.
 * - env: `CALLCANVAS_EXT_DIR_VSCODE_JAVA_CALL_HIERARCHY` pointing at a copy of the
 *   Java extension with the freshly built analyzer, when the JAR in its resources is
 *   older than `--changed-methods` (placing the JAR there is a release step). Empty
 *   once resources has a JAR that knows it.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SAMPLE = path.join(REPO_ROOT, 'sample-project/sample-app-changeset');
const JAVA_EXT = path.join(REPO_ROOT, 'vscode-java-call-hierarchy');
const ENV_KEY = 'CALLCANVAS_EXT_DIR_VSCODE_JAVA_CALL_HIERARCHY';

function jarKnowsChangeSet(jar) {
    try {
        return execFileSync('unzip', ['-l', jar], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
            .includes('tools/depquery/ChangeSetAnalyzer.class');
    } catch {
        return false;
    }
}

function copyDir(from, to, skip) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        if (skip && skip(entry.name)) {
            continue;
        }
        const source = path.join(from, entry.name);
        const target = path.join(to, entry.name);
        if (entry.isDirectory()) {
            copyDir(source, target, skip);
        } else {
            fs.copyFileSync(source, target);
        }
    }
}

/** @returns {Record<string, string>} env additions for the host process */
function javaExtensionEnv(workDir) {
    if (process.env[ENV_KEY]) {
        return { [ENV_KEY]: process.env[ENV_KEY] };
    }
    if (jarKnowsChangeSet(path.join(JAVA_EXT, 'resources', 'java-call-hierarchy-analyzer.jar'))) {
        return {};
    }
    const libs = path.join(REPO_ROOT, 'app/build/libs');
    const built = fs.existsSync(libs)
        ? fs.readdirSync(libs).filter(n => /^java-call-hierarchy-analyzer-.*\.jar$/.test(n)).map(n => path.join(libs, n))
        : [];
    const jar = built.find(jarKnowsChangeSet);
    if (!jar) {
        throw new Error('no analyzer JAR with --changed-methods (run ./gradlew shadowJar in app/)');
    }
    const ext = path.join(workDir, 'java-ext');
    // out/ is copied, not linked: the extension finds its JAR from __dirname too,
    // and a symlinked out/ would resolve back to the checkout's resources.
    copyDir(path.join(JAVA_EXT, 'out'), path.join(ext, 'out'));
    fs.copyFileSync(path.join(JAVA_EXT, 'package.json'), path.join(ext, 'package.json'));
    fs.symlinkSync(path.join(JAVA_EXT, 'node_modules'), path.join(ext, 'node_modules'));
    fs.mkdirSync(path.join(ext, 'resources'));
    fs.copyFileSync(jar, path.join(ext, 'resources', 'java-call-hierarchy-analyzer.jar'));
    return { [ENV_KEY]: ext };
}

function git(cwd, args) {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** Two commits; the second adds `OrderService.changeSetProbe()`. */
function createRepo(workDir) {
    const repo = path.join(workDir, 'repo');
    copyDir(SAMPLE, repo, name => name === 'target' || name === 'build' || name === '.callcanvas-cache');
    // Build output and the index cache are not changes (the workbench must stay empty).
    fs.writeFileSync(path.join(repo, '.gitignore'), 'build/\ntarget/\n.callcanvas-cache/\n');
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'test']);
    git(repo, ['config', 'commit.gpgsign', 'false']);
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'base']);

    const file = path.join(repo, 'src/main/java/com/example/changeset/order/OrderService.java');
    const text = fs.readFileSync(file, 'utf8');
    const end = text.lastIndexOf('}');
    fs.writeFileSync(file, text.slice(0, end)
        + '\n    public int changeSetProbe() {\n        return 42;\n    }\n' + text.slice(end));
    git(repo, ['commit', '-q', '-am', 'add changeSetProbe']);
    // Plain analysis (a canvas opened before the change set) wants compiled classes;
    // target/ is ignored, so this is not a change.
    const sources = [];
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p); } else if (e.name.endsWith('.java')) { sources.push(p); }
    });
    walk(path.join(repo, 'src/main/java'));
    execFileSync('javac', ['-d', path.join(repo, 'target/classes'), ...sources], { stdio: 'ignore' });
    return { repo, commit: git(repo, ['rev-parse', '--short', 'HEAD']), subject: 'add changeSetProbe' };
}

/** @returns {{repo: string, commit: string, subject: string, env: Record<string, string>, workDir: string}} */
function createChangeSetFixture() {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'callcanvas-changeset-'));
    const { repo, commit, subject } = createRepo(workDir);
    return { repo, commit, subject, env: javaExtensionEnv(workDir), workDir };
}

module.exports = { createChangeSetFixture };

if (require.main === module) {
    process.stdout.write(JSON.stringify(createChangeSetFixture()) + '\n');
}
