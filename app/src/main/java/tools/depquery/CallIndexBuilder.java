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

    /**
     * 全ソースファイルをスキャンしてインデックスを構築
     */
    CallIndex buildFullIndex() throws IOException {
        info("[INFO] Building call index...");
        long startTime = System.currentTimeMillis();

        CallIndex index = new CallIndex();

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
        List<FileResult> results = new JdtCallCollector(cfg).analyze(allJavaFiles);
        long chaStart = startTiming("CHA Expansion");
        addResults(index, results);
        endTiming("CHA Expansion", chaStart);
        endTiming("Method Indexing", indexingStart);

        // 逆参照（callers）を構築
        long callerStart = startTiming("Caller References Build");
        buildCallerReferences(index);
        endTiming("Caller References Build", callerStart);

        long elapsed = System.currentTimeMillis() - startTime;
        info("[INFO] Index built in " + (elapsed / 1000) + "s: " +
                         index.methods.size() + " methods indexed");

        return index;
    }

    /**
     * 解析結果をインデックスに追加する。先に全ファイルのメソッドを登録してから、
     * 呼び出し辺と CHA の override 辺を付ける（override 先の実在判定に宣言済みメソッドを使うため）。
     */
    private void addResults(CallIndex index, List<FileResult> results) {
        for (FileResult r : results) {
            for (Caller c : r.callers()) index.addMethod(c.entry);
            index.symbolIndex.putAll(r.constants());
            index.symbols.putAll(r.symbols());
        }
        ChaContext cha = new ChaContext(hierarchyCache, new DeclaredMethodResolver(index.methods.values()));
        for (FileResult r : results) {
            for (Caller c : r.callers()) addCallees(c, cha, cfg);
        }
        cha.emitChaTimingSummary();
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
            entry.addCallee(call.callee(), call.line(), call.endLine(), call.endCol(), call.type());
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
     * 既存インデックスを増分更新
     */
    CallIndex updateIndex(CallIndex oldIndex, CallIndexManager manager) throws IOException {
        info("[INFO] Updating call index incrementally...");
        long startTime = System.currentTimeMillis();

        // 全Javaファイルを収集
        long scanStart = startTiming("File Scan");
        List<Path> allJavaFiles = scanJavaFiles();
        endTiming("File Scan", scanStart);

        CallIndexManager.FileChanges changes = manager.detectChanges(oldIndex, allJavaFiles);

        int totalChanges = changes.added.size() + changes.modified.size() + changes.deleted.size();
        if (totalChanges == 0) {
            info("[INFO] No changes detected. Index is up to date.");
            return oldIndex;
        }

        info("[INFO] Changes detected: " +
                         changes.added.size() + " added, " +
                         changes.modified.size() + " modified, " +
                         changes.deleted.size() + " deleted");

        // 新しいインデックスを作成（既存をコピー）
        CallIndex newIndex = new CallIndex();
        newIndex.version = oldIndex.version;

        // 既存のメソッドをコピー（変更されたファイルのメソッドは除外）
        Set<String> changedFilePaths = new HashSet<>();
        changes.added.forEach(p -> changedFilePaths.add(p.toString()));
        changes.modified.forEach(p -> changedFilePaths.add(p.toString()));
        changes.deleted.forEach(changedFilePaths::add);

        for (var entry : oldIndex.methods.entrySet()) {
            if (!changedFilePaths.contains(entry.getValue().file)) {
                newIndex.methods.put(entry.getKey(), entry.getValue());
            }
        }

        // 未変更ファイルの symbolIndex エントリを旧 index からコピー
        // qualifier (クラスFQN) → file の逆引きマップを構築
        Map<String, String> classFqnToFile = new HashMap<>();
        for (var entry : oldIndex.methods.entrySet()) {
            CallIndexModels.MethodEntry me = entry.getValue();
            if (me.classFqn != null && me.file != null) {
                classFqnToFile.putIfAbsent(me.classFqn, me.file);
            }
        }
        for (var entry : oldIndex.symbolIndex.entrySet()) {
            String qualifier = entry.getValue().qualifier;
            String file = classFqnToFile.get(qualifier);
            // ファイルが特定できない場合、または変更されていないファイルのものはコピー
            if (file == null || !changedFilePaths.contains(file)) {
                newIndex.symbolIndex.put(entry.getKey(), entry.getValue());
            }
        }

        // 未変更ファイルの型・フィールド宣言をコピー（変更・追加ファイルの分は再解析で入れ直す）
        for (var entry : oldIndex.symbols.entrySet()) {
            if (!changedFilePaths.contains(entry.getValue().file)) {
                newIndex.symbols.put(entry.getKey(), entry.getValue());
            }
        }

        long persistHashStart = startTiming("File Hashing (persist index)");
        Map<String, String> newFileHashes = CallIndexManager.calculateFileHashes(allJavaFiles);
        endTiming("File Hashing (persist index)", persistHashStart);
        for (var entry : newFileHashes.entrySet()) {
            newIndex.setFileHash(entry.getKey(), entry.getValue());
        }

        // 変更・追加されたファイルを再解析（sourcepath は全体のまま、AST を作るのは対象ファイルだけ）
        List<Path> filesToProcess = new ArrayList<>();
        filesToProcess.addAll(changes.added);
        filesToProcess.addAll(changes.modified);

        info("[INFO] Reprocessing " + filesToProcess.size() + " files...");
        long reprocessStart = startTiming("File Reprocessing");
        List<FileResult> results = new JdtCallCollector(cfg).analyze(filesToProcess);
        addResults(newIndex, results);
        endTiming("File Reprocessing", reprocessStart);

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

        return newIndex;
    }
}
