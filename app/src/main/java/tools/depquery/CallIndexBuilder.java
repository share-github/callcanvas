package tools.depquery;

import tools.depquery.CallIndexModels.*;
import tools.depquery.JdtCallCollector.Caller;
import tools.depquery.JdtCallCollector.FileResult;
import tools.depquery.JdtCallCollector.RawCall;

import java.io.IOException;
import java.nio.file.*;
import java.util.*;

import static tools.depquery.DiagnosticLogger.*;
import static tools.depquery.NodeFactory.acceptByFilter;

/**
 * CallIndex を構築するビルダー
 *
 * <p>解析・型解決は Eclipse JDT（{@link JdtCallCollector}）。ここでは解析結果をインデックスに詰め、
 * CHA による override 辺の展開（{@link ChaContext}）と逆引き（callers）を行う。
 */
class CallIndexBuilder {
    private final AnalyzerConfig cfg;
    private final HierarchyCache hierarchyCache;

    CallIndexBuilder(AnalyzerConfig cfg, HierarchyCache hierarchyCache) {
        this.cfg = cfg;
        this.hierarchyCache = hierarchyCache;
    }

    private List<Path> scanJavaFiles() throws IOException {
        List<Path> allJavaFiles = new ArrayList<>();
        for (Path srcRoot : cfg.srcRoots) {
            if (!Files.isDirectory(srcRoot)) continue;
            try (var stream = Files.walk(srcRoot)) {
                stream.filter(p -> p.toString().endsWith(".java"))
                      .forEach(allJavaFiles::add);
            }
        }
        return allJavaFiles;
    }

    /** 構築結果: インデックスと差分更新の依存情報（{@code call-index.deps}） */
    record Built(CallIndex index, IndexDeps deps) {}

    /**
     * 全ソースファイルをスキャンしてインデックスを構築
     */
    Built buildFullIndex() throws IOException {
        info("[INFO] Building call index...");
        long startTime = System.currentTimeMillis();

        CallIndex index = new CallIndex();
        IndexDeps deps = new IndexDeps();

        // 全Javaファイルを収集
        long scanStart = startTiming("File Scan");
        List<Path> allJavaFiles = scanJavaFiles();
        endTiming("File Scan", scanStart);

        info("[INFO] Found " + allJavaFiles.size() + " Java files");

        long hashStart = startTiming("File Hashing (full index)");
        Map<String, String> fileHashes = CallIndexManager.calculateFileHashes(allJavaFiles);
        endTiming("File Hashing (full index)", hashStart);
        for (var entry : fileHashes.entrySet()) {
            index.setFileHash(entry.getKey(), entry.getValue());
        }

        // 全ファイルを一括解析してメソッド呼び出しを収集
        long indexingStart = startTiming("Method Indexing");
        List<String> classpath = JdtCallCollector.classpathEntries(cfg);
        List<FileResult> results = new JdtCallCollector(cfg, classpath).collectDeps().analyze(allJavaFiles);
        long chaStart = startTiming("CHA Expansion");
        addResults(index, results, List.of());
        endTiming("CHA Expansion", chaStart);
        endTiming("Method Indexing", indexingStart);
        for (FileResult r : results) deps.files.put(r.file().toString(), r.deps());
        index.symbolIndex = deps.symbolIndex();
        long libStart = startTiming("Library Owners");
        deps.environment = LibraryIndex.environment(cfg);
        deps.recordLibraries(LibraryIndex.of(classpath), true);
        endTiming("Library Owners", libStart);

        // 逆参照（callers）を構築
        long callerStart = startTiming("Caller References Build");
        buildCallerReferences(index);
        endTiming("Caller References Build", callerStart);

        long elapsed = System.currentTimeMillis() - startTime;
        info("[INFO] Index built in " + (elapsed / 1000) + "s: " +
                         index.methods.size() + " methods indexed");

        return new Built(index, deps);
    }

    /**
     * 解析結果をインデックスに追加する。先に全ファイルのメソッドを登録してから、
     * 呼び出し辺と CHA の override 辺を付ける（override 先の実在判定に宣言済みメソッドを使うため）。
     *
     * @param kept 差分更新で前回から引き継いだ（解析し直していない）メソッド。override 辺を新しい継承関係と
     *             宣言済みメソッドで展開し直す（{@link #reexpandOverrides}）
     */
    private void addResults(CallIndex index, List<FileResult> results, Collection<MethodEntry> kept) {
        for (FileResult r : results) {
            for (Caller c : r.callers()) index.addMethod(c.entry);
            index.symbols.putAll(r.symbols());
        }
        ChaContext cha = new ChaContext(hierarchyCache, new DeclaredMethodResolver(index.methods.values()));
        for (FileResult r : results) {
            for (Caller c : r.callers()) addCallees(c, cha, cfg);
        }
        for (MethodEntry m : kept) reexpandOverrides(m, cha, cfg);
        cha.emitChaTimingSummary();
    }

    /**
     * 引き継いだメソッドの override 辺を作り直す。CHA の結果は継承関係全体と宣言済みメソッドで決まるので、
     * 呼び出し元のファイルが変わっていなくても変わる（上位・中間への型や override の追加・削除）。
     * 仮想呼び出しの直後に override 群を並べる順序（{@link #addCallees}）を保つ。
     */
    static void reexpandOverrides(MethodEntry entry, ChaContext cha, AnalyzerConfig cfg) {
        List<CallRef> out = new ArrayList<>(entry.callees.size());
        for (CallRef c : entry.callees) {
            if ("override".equals(c.type)) continue;
            out.add(c);
            if (!c.virtual) continue;
            for (String impl : cha.findOverrides(c.fqn)) {
                if (!impl.equals(c.fqn) && acceptByFilter(impl, cfg)) {
                    out.add(new CallRef(impl, c.line, c.endLine, c.endCol, "override"));
                }
            }
        }
        entry.callees = out;
    }

    /**
     * 呼び出し元 1 件の呼び出しを callees に詰め、仮想呼び出しは CHA で override 辺を展開する。
     * インデックス構築とインデックス無しの解析（{@link OnDemandIndexer}）で共通。
     */
    static void addCallees(Caller c, ChaContext cha, AnalyzerConfig cfg) {
        MethodEntry entry = c.entry;
        for (RawCall call : c.calls) {
            if (!acceptByFilter(call.callee(), cfg)) continue;
            // 【順序前提】呼び出し先の直後にその override 群を並べる（解析側が lastCallTargetFqn で辿る）
            entry.addCallee(call.callee(), call.line(), call.endLine(), call.endCol(), call.type(), call.virtual());
            if (call.virtual()) {
                for (String impl : cha.findOverrides(call.callee())) {
                    if (!impl.equals(call.callee()) && acceptByFilter(impl, cfg)) {
                        entry.addCallee(impl, call.line(), call.endLine(), call.endCol(), "override");
                    }
                }
            }
        }
    }

    /**
     * CHA の実在判定: 候補 FQN（Class#name(params)）に対し、インデックスに宣言のあるメソッドを返す。
     * 完全一致が無ければ同名・同引数個数のメソッド（ジェネリクスの型引数違いの override 等）。
     * 複数あれば引数型の単純名が一致するもの、無ければ先頭（JavaParser 版の SourceLocator と同じ緩さ）。
     */
    static final class DeclaredMethodResolver implements java.util.function.Function<String, String> {
        private final Set<String> exact = new HashSet<>();
        private final Map<String, List<MethodEntry>> byNameArity = new HashMap<>();

        DeclaredMethodResolver(Collection<MethodEntry> methods) {
            List<MethodEntry> sorted = new ArrayList<>(methods);
            sorted.sort(Comparator.comparing((MethodEntry m) -> m.file == null ? "" : m.file)
                    .thenComparingInt(m -> m.lineStart));
            for (MethodEntry m : sorted) {
                if (m.classFqn == null || m.methodName == null || m.lineStart < 0) continue;
                exact.add(m.fqn);
                int arity = m.paramsFqn == null ? 0 : m.paramsFqn.size();
                byNameArity.computeIfAbsent(m.classFqn + "#" + m.methodName + "#" + arity, k -> new ArrayList<>()).add(m);
            }
        }

        @Override
        public String apply(String candidateFqn) {
            if (exact.contains(candidateFqn)) return candidateFqn;
            int h = candidateFqn.indexOf('#');
            int p = candidateFqn.indexOf('(', h);
            if (h < 0 || p < 0) return null;
            String params = candidateFqn.substring(p + 1, candidateFqn.lastIndexOf(')'));
            List<String> paramList = params.isBlank() ? List.of() : FqnUtils.splitParams(params);
            List<MethodEntry> cands = byNameArity.get(candidateFqn.substring(0, p) + "#" + paramList.size());
            if (cands == null || cands.isEmpty()) return null;
            if (cands.size() > 1) {
                for (MethodEntry m : cands) {
                    boolean match = true;
                    for (int i = 0; i < paramList.size(); i++) {
                        if (!simple(paramList.get(i)).equals(simple(m.paramsFqn.get(i)))) { match = false; break; }
                    }
                    if (match) return m.fqn;
                }
            }
            return cands.get(0).fqn;
        }

        private static String simple(String type) {
            return FqnUtils.shortType(FqnUtils.removeGenerics(type));
        }
    }

    /**
     * 逆参照（callers）を構築
     */
    static void buildCallerReferences(CallIndex index) {
        info("[INFO] Building caller references...");

        for (MethodEntry caller : index.methods.values()) {
            for (CallRef calleeRef : caller.callees) {
                MethodEntry callee = index.getMethod(calleeRef.fqn);
                if (callee != null) {
                    callee.addCaller(caller.fqn, calleeRef.line, calleeRef.endLine, calleeRef.endCol, calleeRef.type);
                }
            }
        }
    }

    /**
     * 既存インデックスを差分更新する（{@link IndexDeps} の依存情報で、変更の影響を受ける未変更ファイルも解析し直す）。
     *
     * <ol>
     *   <li>変更・追加ファイルを解析し、変更・追加・削除ファイルの型の API を新旧で比べる</li>
     *   <li>API の変化に依存する未変更ファイル（{@link IndexDeps#dependents}）を解析し直す。
     *       その API も変わればさらに繰り返す</li>
     *   <li>解析していないファイルのメソッドは引き継ぎ、override 辺だけ新しい継承関係で展開し直す</li>
     * </ol>
     * 結果はフル構築と同じになる（IncrementalIndexTest）。
     */
    Built updateIndex(CallIndex oldIndex, IndexDeps oldDeps, CallIndexManager manager) throws IOException {
        info("[INFO] Updating call index incrementally...");
        long startTime = System.currentTimeMillis();

        // 全Javaファイルを収集
        long scanStart = startTiming("File Scan");
        List<Path> allJavaFiles = scanJavaFiles();
        endTiming("File Scan", scanStart);

        CallIndexManager.FileChanges changes = manager.detectChanges(oldIndex, allJavaFiles);
        List<String> classpath = JdtCallCollector.classpathEntries(cfg);
        LibraryIndex lib = LibraryIndex.of(classpath);
        boolean classpathChanged = !lib.jars.equals(oldDeps.jars);

        int totalChanges = changes.added.size() + changes.modified.size() + changes.deleted.size();
        if (totalChanges == 0 && !classpathChanged) {
            info("[INFO] No changes detected. Index is up to date.");
            return new Built(oldIndex, oldDeps);
        }

        info("[INFO] Changes detected: " +
                         changes.added.size() + " added, " +
                         changes.modified.size() + " modified, " +
                         changes.deleted.size() + " deleted" +
                         (classpathChanged ? ", classpath changed" : ""));

        Map<String, Path> byKey = new HashMap<>();
        for (Path p : allJavaFiles) byKey.put(p.toString(), p);
        Set<String> deleted = new HashSet<>(changes.deleted);
        // 前回の依存情報が無い既存ファイル（解析に失敗していた等）は、影響を判定できないので解析し直す
        List<Path> toParse = new ArrayList<>(changes.added);
        toParse.addAll(changes.modified);
        Set<String> changedKeys = new HashSet<>();
        toParse.forEach(p -> changedKeys.add(p.toString()));
        for (Path p : allJavaFiles) {
            String k = p.toString();
            if (!changedKeys.contains(k) && oldIndex.getFileHash(k) != null && !oldDeps.files.containsKey(k)) {
                toParse.add(p);
            }
        }

        // クラスパスが変わったら、変わったライブラリのクラスを使うファイルも解析する（Zinc のライブラリ依存）
        int libraryDependents = 0;
        if (classpathChanged) {
            long libStart = startTiming("Library Dependents");
            Set<String> exclude = new HashSet<>(changedKeys);
            exclude.addAll(deleted);
            for (Path p : toParse) exclude.add(p.toString());
            for (String k : oldDeps.libraryDependents(lib, exclude)) {
                Path p = byKey.get(k);
                if (p != null) {
                    toParse.add(p);
                    libraryDependents++;
                }
            }
            endTiming("Library Dependents", libStart);
            info("[INFO] Classpath changed: " + libraryDependents + " files use changed libraries");
        }

        // 解析 → API の差 → 依存ファイル、を変化が無くなるまで繰り返す
        long reprocessStart = startTiming("File Reprocessing");
        JdtCallCollector collector = new JdtCallCollector(cfg, classpath).collectDeps();
        Map<String, FileResult> parsed = new LinkedHashMap<>();
        List<String> roundOld = new ArrayList<>(deleted);
        int round = 0;
        // 削除だけのときも 1 回は判定する（削除した型に依存する未変更ファイルがある）
        while (round == 0 || !toParse.isEmpty()) {
            round++;
            if (!toParse.isEmpty()) {
                info("[INFO] Reprocessing " + toParse.size() + " files" + (round == 1 ? "" : " (dependents, round " + round + ")") + "...");
            }
            Map<String, IndexDeps.TypeApi> newApi = new HashMap<>();
            for (FileResult r : collector.analyze(toParse)) {
                parsed.put(r.file().toString(), r);
                newApi.putAll(r.deps().api());
            }
            toParse.forEach(p -> roundOld.add(p.toString()));
            Set<String> exclude = new HashSet<>(parsed.keySet());
            exclude.addAll(deleted);
            toParse.forEach(p -> exclude.add(p.toString())); // 解析に失敗したファイルも繰り返さない
            Set<String> dependents = oldDeps.dependents(oldDeps.apiOf(roundOld), newApi, exclude);
            roundOld.clear();
            toParse = new ArrayList<>();
            for (String k : dependents) {
                Path p = byKey.get(k);
                if (p != null) toParse.add(p);
            }
        }
        endTiming("File Reprocessing", reprocessStart);
        timing("SUMMARY incremental=changed=" + (changes.added.size() + changes.modified.size())
                + ",deleted=" + deleted.size() + ",reparsed=" + parsed.size() + ",rounds=" + round
                + ",classpathChanged=" + classpathChanged + ",libraryDependents=" + libraryDependents);

        Set<String> replaced = new HashSet<>(parsed.keySet());
        replaced.addAll(deleted);
        replaced.addAll(changedKeys); // 解析に失敗した変更ファイルの古いメソッドも残さない

        CallIndex newIndex = new CallIndex();
        newIndex.version = oldIndex.version;

        // 解析し直していないファイルのメソッドを引き継ぐ
        List<MethodEntry> kept = new ArrayList<>();
        for (var entry : oldIndex.methods.entrySet()) {
            if (!replaced.contains(entry.getValue().file)) {
                newIndex.methods.put(entry.getKey(), entry.getValue());
                kept.add(entry.getValue());
            }
        }

        // 引き継ぐファイルの型・フィールド宣言をコピー（解析し直したファイルの分は解析結果で入れ直す）
        for (var entry : oldIndex.symbols.entrySet()) {
            if (!replaced.contains(entry.getValue().file)) {
                newIndex.symbols.put(entry.getKey(), entry.getValue());
            }
        }

        changes.currentHashes.forEach(newIndex::setFileHash);

        long chaStart = startTiming("CHA Expansion");
        addResults(newIndex, new ArrayList<>(parsed.values()), kept);
        endTiming("CHA Expansion", chaStart);

        IndexDeps newDeps = new IndexDeps();
        oldDeps.files.forEach((k, v) -> {
            if (!replaced.contains(k)) newDeps.files.put(k, v);
        });
        parsed.forEach((k, r) -> newDeps.files.put(k, r.deps()));
        newIndex.symbolIndex = newDeps.symbolIndex();
        newDeps.environment = oldDeps.environment;
        newDeps.owners.putAll(oldDeps.owners);
        newDeps.jars = oldDeps.jars;
        long libStart = startTiming("Library Owners");
        newDeps.recordLibraries(lib, classpathChanged);
        endTiming("Library Owners", libStart);

        // caller参照を再構築（変更されたメソッドの影響を受けるため、全体を再構築）
        info("[INFO] Rebuilding caller references...");
        long callerStart = startTiming("Caller References Rebuild");
        for (MethodEntry method : newIndex.methods.values()) {
            method.callers.clear();
        }
        buildCallerReferences(newIndex);
        endTiming("Caller References Rebuild", callerStart);

        long elapsed = System.currentTimeMillis() - startTime;
        info("[INFO] Index updated in " + (elapsed / 1000) + "s: " +
                         newIndex.methods.size() + " methods indexed");

        return new Built(newIndex, newDeps);
    }
}
