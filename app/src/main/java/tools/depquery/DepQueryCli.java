package tools.depquery;

import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.CompletableFuture;
import static tools.depquery.DiagnosticLogger.*;
import static tools.depquery.FqnUtils.*;
import static tools.depquery.NodeFactory.*;
import static tools.depquery.MethodResolver.*;
import static tools.depquery.OutputGenerator.*;
import static tools.depquery.CallGraphAnalyzer.*;
import tools.depquery.CallIndexModels.*;

public class DepQueryCli {

    // ===== CLI =====

    /**
     * Call Indexからファイルパスと行番号でメソッドFQNを逆引き
     */
    private static void resolveFromIndex(AnalyzerConfig cfg) throws Exception {
        if (cfg.resolveFromIndexPath == null || !cfg.resolveFromIndexPath.contains(":")) {
            System.err.println("[ERROR] Invalid --resolve-from-index format. Expected: <file:line>");
            System.exit(1);
        }
        
        // ファイルパスと行番号を分割
        int colonPos = cfg.resolveFromIndexPath.lastIndexOf(':');
        String filePath = cfg.resolveFromIndexPath.substring(0, colonPos);
        int lineNumber;
        try {
            lineNumber = Integer.parseInt(cfg.resolveFromIndexPath.substring(colonPos + 1));
        } catch (NumberFormatException e) {
            System.err.println("[ERROR] Invalid line number: " + cfg.resolveFromIndexPath.substring(colonPos + 1));
            System.exit(1);
            return;
        }
        
        // Indexを読み込み
        Path projectRoot = cfg.workspace != null ? cfg.workspace : Paths.get(".").toAbsolutePath().normalize();
        CallIndexManager indexManager = new CallIndexManager(projectRoot);
        
        if (!indexManager.indexExists()) {
            System.err.println("[ERROR] Call index not found. Please run --build-index first.");
            System.exit(1);
        }
        
        CallIndex index;
        try {
            index = indexManager.loadIndex();
            if (index == null) {
                System.err.println("[ERROR] Failed to load call index.");
                System.exit(1);
                return;
            }
        } catch (IOException e) {
            System.err.println("[ERROR] Failed to load call index: " + e.getMessage());
            System.exit(1);
            return;
        }
        
        // ファイルパスと行番号でメソッドを検索（絶対/相対・区切り文字の違いを正規化して比較）
        Path workspaceAbs = projectRoot.toAbsolutePath().normalize();
        Path requestedPath = Paths.get(filePath).normalize();
        String requestedNorm = pathStringForComparison(requestedPath, workspaceAbs);

        MethodEntry foundMethod = null;
        for (MethodEntry entry : index.methods.values()) {
            String entryNorm = pathStringForComparison(Paths.get(entry.file).normalize(), workspaceAbs);
            boolean pathMatches = (requestedNorm != null && entryNorm != null && requestedNorm.equals(entryNorm))
                    || entry.file.endsWith(filePath) || filePath.endsWith(entry.file);
            if (pathMatches && entry.lineStart <= lineNumber && lineNumber <= entry.lineEnd) {
                foundMethod = entry;
                break;
            }
        }
        
        if (foundMethod == null) {
            System.err.println("[ERROR] No method found at " + filePath + ":" + lineNumber);
            System.exit(1);
        } else {
            // FQNを標準出力に出力（VSCode拡張がこれを受け取る）
            System.out.println(foundMethod.fqn);
        }
    }

    /**
     * インデックス照合用にパスを正規化する。workspace からの相対パスをスラッシュ区切りで返す。
     * 絶対パスは workspace 基準の相対に変換、相対パスは workspace で resolve してから相対化する。
     */
    private static String pathStringForComparison(Path path, Path workspaceAbs) {
        Path abs = path.isAbsolute() ? path : workspaceAbs.resolve(path);
        abs = abs.normalize();
        if (!abs.startsWith(workspaceAbs)) {
            return null;
        }
        Path rel = workspaceAbs.relativize(abs);
        return rel.toString().replace(File.separatorChar, '/');
    }

    /**
     * 指定クラスに属する全メソッドの FQN をインデックスから列挙する。
     * 初版では callIndex が null の場合は exit(2)。ソース列挙は実装しない。
     * コンストラクタも含める。
     */
    private static List<String> collectMethodFqnsInClass(AnalyzerConfig cfg, CallIndex callIndex, String classFqn) {
        // 多段ネスト（Outer$Middle$Inner）は初版未対応
        int nestCount = 0;
        for (int i = 0; i < classFqn.length(); i++) {
            if (classFqn.charAt(i) == '$') nestCount++;
        }
        if (nestCount >= 2) {
            System.err.println("[ERROR] 未対応のネストです: " + classFqn);
            System.exit(2);
        }
        if (callIndex == null) {
            System.err.println("[ERROR] インデックスが未構築です。先に Build Call Index を実行してください: " + classFqn);
            System.exit(2);
        }
        String prefix = classFqn + "#";
        List<String> fqns = callIndex.allMethodFqns().stream()
                .filter(fqn -> fqn.startsWith(prefix))
                // 初期化子の擬似エントリ（<init>/<clinit>）はソース上のメソッドではないのでルートにしない
                .filter(fqn -> !JdtCallCollector.isInitializerPseudo(fqn))
                .sorted()
                .toList();
        return fqns;
    }

    /**
     * --root-class 指定時のみ、cfg.roots をそのクラス内メソッド一覧で上書きする。
     * rootClassFqn == null のときは cfg.roots に一切触れない。
     */
    private static void expandRootClassIfSet(AnalyzerConfig cfg, CallIndex callIndex) {
        if (cfg.rootClassFqn == null) {
            return;
        }
        List<String> methodFqns = collectMethodFqnsInClass(cfg, callIndex, cfg.rootClassFqn);
        if (methodFqns.isEmpty()) {
            System.err.println("[ERROR] No methods in class: " + cfg.rootClassFqn);
            System.exit(2);
        }
        cfg.roots.clear();
        cfg.roots.addAll(methodFqns);
    }
    
    /**
     * Call Indexを構築または増分更新
     */
    private static void buildCallIndex(AnalyzerConfig cfg) throws Exception {
        long totalStart = startTiming("Index Build");
        info("[INFO] Building/updating call index...");
        
        // HierarchyCache (CHA用)
        long hierarchyCacheStart = startTiming("Hierarchy Cache Build");
        Path cacheDir = cfg.workspace != null
                ? cfg.workspace.resolve(".callcanvas-cache")
                : cfg.outDir.resolve(".callcanvas-cache");
        HierarchyCache hierarchyCache = new HierarchyCache(cacheDir, cfg.srcRoots);
        hierarchyCache.initialize(cfg.rebuildCache);
        endTiming("Hierarchy Cache Build", hierarchyCacheStart);
        
        // CallIndexManager
        Path projectRoot = cfg.workspace != null ? cfg.workspace : cfg.outDir.getParent();
        CallIndexManager indexManager = new CallIndexManager(projectRoot);
        
        // CallIndexBuilder（解析は JDT。CHA は HierarchyCache + 宣言済みメソッド）
        CallIndexBuilder builder = new CallIndexBuilder(cfg, hierarchyCache);
        
        // 既存インデックスをチェック
        CallIndex callIndex;
        long indexBuildStart = startTiming("Index Construction");
        CallIndex oldIndex = null;
        IndexDeps oldDeps = null;
        if (indexManager.indexExists()) {
            long loadStart = startTiming("Index Load");
            oldIndex = indexManager.loadIndex();
            oldDeps = indexManager.loadDeps();
            endTiming("Index Load", loadStart);
            if (oldIndex != null && !CallIndex.CURRENT_VERSION.equals(oldIndex.version)) {
                info("[INFO] Existing index was built by an older analyzer (version " + oldIndex.version
                        + "). Rebuilding from scratch...");
                oldIndex = null;
            } else if (oldIndex != null && oldDeps == null) {
                info("[INFO] Existing index has no dependency data. Rebuilding from scratch...");
                oldIndex = null;
            } else if (oldIndex != null && !oldDeps.environment.equals(LibraryIndex.environment(cfg))) {
                info("[INFO] JDK or language level changed since the last build. Rebuilding from scratch...");
                oldIndex = null;
            }
        }
        CallIndexBuilder.Built built;
        if (oldIndex != null) {
            timing("META buildMode=incremental");
            info("[INFO] Existing index found. Performing incremental update...");
            built = builder.updateIndex(oldIndex, oldDeps, indexManager);
        } else {
            timing("META buildMode=full");
            info("[INFO] No existing index found. Building from scratch...");
            built = builder.buildFullIndex();
        }
        callIndex = built.index();
        timing("SUMMARY index=methods=" + callIndex.methods.size()
                + ",indexedFiles=" + callIndex.fileHashes.size());
        endTiming("Index Construction", indexBuildStart);
        
        // インデックスを保存
        long saveStart = startTiming("Index Save");
        indexManager.saveIndex(callIndex, built.deps());
        endTiming("Index Save", saveStart);
        
        info("[INFO] Call index build complete!");
        endTiming("Index Build", totalStart);
    }

    public static void main(String[] args) throws Exception {
        long startTime = System.currentTimeMillis();
        
        // タイミング測定用変数
        long indexLoadTime = 0;
        long bfsTime = 0;
        long outputTime = 0;
        long indexBuildTime = 0;
        
        var cfg = AnalyzerConfig.parse(args);
        DEBUG = cfg.debug;
        QUIET = cfg.quiet;
        TIMING = cfg.timing;

        // --root と --root-class は同時に指定できない
        if (cfg.rootClassFqn != null && !cfg.roots.isEmpty()) {
            System.err.println("[ERROR] --root and --root-class cannot be specified together.");
            System.exit(2);
        }
        
        // デバッグモード: バージョン情報と実行パラメータを出力
        if (DEBUG) {
            debugTimed("=== Java Call Hierarchy Analyzer v" + VERSION + " ===");
            if (cfg.buildIndex) {
                debugTimed("START Index Build");
                debugTimed("  Workspace: " + (cfg.workspace != null ? cfg.workspace : "(none)"));
                debugTimed("  Source roots: " + cfg.srcRoots.size() + " directories");
                debugTimed("  Class dirs: " + cfg.classDirs.size() + " directories");
            } else {
                debugTimed("START Analysis");
                debugTimed("  Root methods: " + cfg.roots.size());
                if (!cfg.roots.isEmpty()) {
                    debugTimed("    - " + cfg.roots.get(0) + (cfg.roots.size() > 1 ? " (and " + (cfg.roots.size() - 1) + " more)" : ""));
                }
                debugTimed("  Direction: " + cfg.direction);
                debugTimed("  Depth: " + cfg.depth);
                debugTimed("  Workspace: " + (cfg.workspace != null ? cfg.workspace : "(none)"));
            }
        }

        // --build-index オプションが指定された場合、インデックスを構築して終了
        // 同時に --root-class が指定されていても root-class は無視し、インデックス構築のみ行う
        if (cfg.buildIndex) {
            // lombok.jar がクラスパスにあれば Lombok の agent 付きで自身を起動し直す（成功したらそちらの結果で終了）
            if (LombokSupport.relaunchWithAgentIfNeeded(cfg, args)) {
                return;
            }
            long buildStart = System.currentTimeMillis();
            buildCallIndex(cfg);
            indexBuildTime = System.currentTimeMillis() - buildStart;
            
            if (DEBUG) {
                debugTimed("END Index Build (total: " + indexBuildTime + "ms)");
            }
            
            if (QUIET) {
                long totalTime = System.currentTimeMillis() - startTime;
                alwaysPrint("\n=== Performance Summary ===");
                alwaysPrint(String.format("Index build: %.1fs", indexBuildTime / 1000.0));
                alwaysPrint(String.format("Total:       %.1fs", totalTime / 1000.0));
            }
            return;
        }
        
        // --resolve-from-index オプションが指定された場合、Index逆引きして終了
        if (cfg.resolveFromIndexPath != null) {
            resolveFromIndex(cfg);
            return;
        }

        // --changed-methods: 変更集合キャンバスの Java ブロックを出力して終了（インデックス必須）
        if (cfg.changedMethodsPath != null) {
            try {
                ChangeSetAnalyzer.run(cfg);
            } catch (ChangeSetAnalyzer.ChangeSetException e) {
                System.err.println("[ERROR] " + e.getMessage());
                System.exit(2);
            }
            return;
        }

        // === 解析パス開始（build-index / resolve-from-index の early return の後）===
        Files.createDirectories(cfg.outDir);

        // インデックス早期ロード（root-class 展開およびルート解決で参照する）
        Path projectRoot = cfg.workspace != null ? cfg.workspace : cfg.outDir.getParent();
        CallIndexManager indexManager = new CallIndexManager(projectRoot);
        CallIndex callIndex = null;
        long indexLoadStart = startTiming("Index Load");
        try {
            if (indexManager.indexExists()) {
                // outgoing はサイドカーがあれば部分ロード（LazyCallIndex）。到達メソッドのみ seek+parse。
                callIndex = indexManager.loadIndexForAnalysis(cfg.direction);
                if (callIndex != null) {
                    indexLoadTime = System.currentTimeMillis() - indexLoadStart;
                    endTiming("Index Load", indexLoadStart);
                    info("[INFO] Loaded call index with " + callIndex.methodCount() + " methods"
                            + (callIndex instanceof LazyCallIndex ? " (lazy)" : ""));
                    if (DEBUG) {
                        debugTimed("Index loaded in " + indexLoadTime + "ms (" + callIndex.methodCount() + " methods)");
                    }
                }
            } else {
                endTiming("Index Load", indexLoadStart);
                if (DEBUG) {
                    debugTimed("Index: not found");
                }
            }
        } catch (IOException e) {
            endTiming("Index Load", indexLoadStart);
            debug("Failed to load call index: " + e.getMessage());
        }
        // 世代違いのインデックス（1.2 以前は refs/symbols を持たない）は呼び出しの解析に使わずソースを解析する。
        // メソッド一覧は世代で変わらないので root-class の展開にだけ使う（再構築は拡張・--build-index 側が行う）
        CallIndex listingIndex = callIndex;
        if (callIndex != null && !CallIndex.CURRENT_VERSION.equals(callIndex.version)) {
            info("[INFO] Call index was built by an older analyzer (version " + callIndex.version
                    + "). Analyzing sources instead; rebuild the index (--build-index) to use it again.");
            callIndex = null;
        }
        final CallIndex finalCallIndex = callIndex;

        // root-class 指定時のみ cfg.roots をクラス内メソッド一覧で上書き（CLI の --root 入力とは別物）
        expandRootClassIfSet(cfg, listingIndex);

        if (cfg.roots.isEmpty()) {
            System.err.println("""
                    Usage:
                      java -jar depq.jar \\
                        --src src/main/java \\
                        --classes target/classes \\
                        --root 'com.example.service.PaymentService#process(com.example.domain.Order)' \\
                        --depth 2 \\
                        --include 'com.example.**' \\
                        --exclude '..dto..,..config..' \\
                        --out build/depgraph \\
                        --format mermaid,json,seq,call-hierarchy \\
                        --lang-level JAVA_8 \\
                        --debug

                    Usage (class-level): --root-class 'com.example.app.controller.OrderController'
                    """);
            System.exit(2);
        }

        var graph = new GraphModels.Graph();

        // ルート解決: インデックスがあればインデックスの FQN から（曖昧マッチング対応）
        CallIndex analysisIndex = finalCallIndex;
        List<String> rootFqns = new ArrayList<>();
        if (finalCallIndex != null) {
            for (String userRoot : cfg.roots) {
                String fqn = finalCallIndex.getMethod(userRoot) != null ? userRoot
                        : resolveRootMethodFqn(userRoot, finalCallIndex.allMethodFqns());
                if (fqn == null) {
                    // インデックスに無い（未構築のファイル・古いインデックス）→ ソースを解析する
                    info("[INFO] Root not found in call index, analyzing sources: " + userRoot);
                    analysisIndex = null;
                    rootFqns.clear();
                    break;
                }
                if (!fqn.equals(userRoot)) {
                    info("[INFO] Resolved root: " + userRoot + " -> " + fqn);
                }
                rootFqns.add(fqn);
            }
        }

        // インデックスが使えなければ、必要なファイルだけ JDT で解析してメモリ上のインデックスを作る
        boolean onDemand = analysisIndex == null;
        OnDemandIndexer onDemandIndexer = null;
        if (onDemand) {
            // インデックス構築と同じく、lombok.jar がクラスパスにあれば agent 付きで起動し直す
            // （Lombok が生成するメンバーへの呼び出しを解決し、インデックス有りと同じ結果にするため）
            if (LombokSupport.relaunchWithAgentIfNeeded(cfg, args)) {
                return;
            }
            info("[INFO] Using language level: " + cfg.languageLevel);
            long onDemandStart = startTiming("On-demand Analysis");
            Path cacheDir = cfg.workspace != null
                    ? cfg.workspace.resolve(".callcanvas-cache")
                    : cfg.outDir.resolve(".callcanvas-cache");
            HierarchyCache hierarchyCache = new HierarchyCache(cacheDir, cfg.srcRoots);
            // 継承関係のキャッシュ（初回は全ソースの走査）は CHA で初めて使うので、ルートのファイルの JDT 解析と並行に作る
            var hierarchyReady = CompletableFuture.runAsync(() -> hierarchyCache.initialize(cfg.rebuildCache));
            var indexer = new OnDemandIndexer(cfg, new SourceLocator(cfg.srcRoots), hierarchyCache);
            rootFqns = indexer.resolveRoots(cfg.roots);
            hierarchyReady.join();
            if (cfg.direction.equals("outgoing")) {
                indexer.expandOutgoing(rootFqns, cfg.depth);
            } else {
                indexer.prepareIncoming(rootFqns);
            }
            analysisIndex = indexer.index;
            endTiming("On-demand Analysis", onDemandStart);
            onDemandIndexer = indexer;
        }
        final CallIndex bfsIndex = analysisIndex;

        for (String root : rootFqns) {
            createNodeFromEntry(graph, bfsIndex.getMethod(root));
            debug("Root: " + root);
        }

        // 解析実行（BFS解析）
        long analysisStart = startTiming("BFS Analysis");
        if (cfg.direction.equals("outgoing")) {
            int methodsFromIndex = collectOutgoingCalls(graph, cfg, bfsIndex, rootFqns);
            long analysisTime = System.currentTimeMillis() - analysisStart;
            if (!onDemand) {
                info("[INFO] Outgoing analysis: " + methodsFromIndex + " methods from index");
            }
            if (DEBUG) {
                debugTimed("BFS analysis completed in " + analysisTime + "ms (" +
                          graph.nodes.size() + " nodes, " + graph.edges.size() + " edges)");
                debugTimed("  - Methods expanded: " + methodsFromIndex);
            }
            endTiming("BFS Analysis", analysisStart);
        } else {
            int maxDepth = (cfg.depth == -1) ? MAX_INCOMING_DEPTH : cfg.depth;
            if (onDemand) {
                // インデックス無しでは 1 階層のみ（全階層の呼び出し元を求めるには全ファイルの解析が要る）
                if (cfg.depth == -1) {
                    System.err.println("[WARN] Index not found. BFS recursive incoming calls (--depth -1) is only supported with index (--build-index). Falling back to 1-level scan.");
                }
                maxDepth = 0;
            }
            collectIncomingCalls(graph, cfg, bfsIndex, maxDepth);
            long analysisTime = System.currentTimeMillis() - analysisStart;
            endTiming("BFS Analysis", analysisStart);
            if (DEBUG) {
                debugTimed("Incoming analysis completed in " + analysisTime + "ms (" +
                          graph.nodes.size() + " nodes, " + graph.edges.size() + " edges)");
            }
        }

        // 出力
        long outputStart = startTiming("Output Generation");
        
        // JSON
        long jsonStart = startTiming("JSON Output");
        JSONObject json = toJson(graph, cfg.srcRoots, cfg.workspace);
        Files.writeString(cfg.outDir.resolve("calls-method.json"), json.toString(2));
        endTiming("JSON Output", jsonStart);

        // ルートノードの解決（曖昧マッチング対応）
        // Note: この時点でグラフにノードが追加されているので、改めて解決する
        List<String> resolvedRoots = new ArrayList<>();
        for (String userRoot : cfg.roots) {
            String resolved = resolveRootFromGraph(userRoot, graph);
            if (resolved != null) {
                resolvedRoots.add(resolved);
                // メッセージは最初のルート解決時に既に出力済みなのでここでは出力しない
            } else {
                System.err.println("[WARN] Could not resolve root in graph: " + userRoot);
                resolvedRoots.add(userRoot); // フォールバック
            }
        }

        // Mermaid Graph
        if (cfg.formats.contains("mermaid")) {
            String mm = MermaidEmitters.methodGraph(graph);
            Files.writeString(cfg.outDir.resolve("graph.md"), "```mermaid\n" + mm + "\n```\n");
        }

        // Mermaid Sequence（主要経路: ルート→下流の最短経路を1~3本）
        if (cfg.formats.contains("seq")) {
            String seq = MermaidEmitters.sequenceFromGraph(graph, resolvedRoots);
            Files.writeString(cfg.outDir.resolve("sequence.md"), "```mermaid\n" + seq + "\n```\n");
        }

        // 索引テーブル（PR貼り付け用）
        var idx = MermaidEmitters.indexTable(graph);
        Files.writeString(cfg.outDir.resolve("index.md"), idx);

        // 呼び出し階層ツリー
        if (cfg.formats.contains("call-hierarchy")) {
            String tree = MermaidEmitters.callHierarchyTree(graph, resolvedRoots);
            Files.writeString(cfg.outDir.resolve("call-hierarchy.md"), tree);
        }

        // CallCanvas 形式（コード付き JSON）
        if (cfg.formats.contains("callcanvas")) {
            long callcanvasStart = startTiming("CallCanvas Output");
            // インデックス無しでは、型・フィールド参照の宣言が未解析のファイルにあれば解析しておく
            if (onDemandIndexer != null) {
                Set<String> symbolKeys = new HashSet<>();
                for (var node : graph.nodes.values()) {
                    if (node.lineStart <= 0) continue;
                    for (String ref : node.refs) {
                        var r = SymbolRef.decode(ref);
                        if (r != null) symbolKeys.add(r.symbol());
                    }
                }
                onDemandIndexer.ensureSymbolDeclarations(symbolKeys);
            }
            // code は toCallCanvasJson 内でファイルから Javadoc 含めて取得するためここでは埋めない
            JSONObject callcanvasJson = toCallCanvasJson(graph, cfg.srcRoots, resolvedRoots, cfg.workspace,
                    cfg.windowWidth,
                    onDemand ? null : bfsIndex.symbolIndex,
                    bfsIndex::getSymbol);

            // 動的ファイル名生成（rootClass 時は 0 件で既に exit しているため、この分岐では resolvedRoots を参照しない）
            String callcanvasFilename;
            if (cfg.rootClassFqn != null) {
                // SimpleClassName: 最後の '.' と最後の '$' のうち後ろにある方で切る（$ がない場合は lastIndexOf('.')）
                int lastDot = cfg.rootClassFqn.lastIndexOf('.');
                int lastDollar = cfg.rootClassFqn.lastIndexOf('$');
                int cut = Math.max(lastDot, lastDollar);
                String simpleClassName = (cut >= 0) ? cfg.rootClassFqn.substring(cut + 1) : cfg.rootClassFqn;
                callcanvasFilename = "callcanvas_" + sanitizeForFilename(simpleClassName) + ".json";
            } else {
                if (!resolvedRoots.isEmpty()) {
                    String rootSignature = resolvedRoots.get(0);
                    MethodInfo methodInfo = parseMethodSignature(rootSignature);
                    String sanitizedClass = sanitizeForFilename(methodInfo.className);
                    String sanitizedMethod = sanitizeForFilename(methodInfo.methodName);
                    callcanvasFilename = "callcanvas_" + sanitizedClass + "_" + sanitizedMethod + ".json";
                } else {
                    callcanvasFilename = "callcanvas.json";
                }
            }

            Path callcanvasPath = cfg.outDir.resolve(callcanvasFilename);
            Files.writeString(callcanvasPath, callcanvasJson.toString(2));

            // TypeScriptがパースできるようにファイルパスをプロトコル出力
            protocol("[CALLCANVAS_FILE]" + callcanvasPath.toAbsolutePath());

            endTiming("CallCanvas Output", callcanvasStart);
        }

        outputTime = System.currentTimeMillis() - outputStart;
        endTiming("Output Generation", outputStart);

        alwaysPrint("Wrote: " + cfg.outDir.toAbsolutePath());
        
        // デバッグモード: 総実行時間を出力
        if (DEBUG) {
            long elapsed = System.currentTimeMillis() - startTime;
            debugTimed("END Analysis (total: " + elapsed + "ms)");
        }
        
        // Quietモード: パフォーマンスサマリー出力
        if (QUIET) {
            long totalTime = System.currentTimeMillis() - startTime;
            alwaysPrint("\n=== Performance Summary ===");
            if (indexLoadTime > 0) {
                alwaysPrint(String.format("Index load:   %.1fs", indexLoadTime / 1000.0));
            }
            if (bfsTime > 0) {
                alwaysPrint(String.format("BFS analysis: %.1fs", bfsTime / 1000.0));
            }
            if (outputTime > 0) {
                alwaysPrint(String.format("Output:       %.1fs", outputTime / 1000.0));
            }
            alwaysPrint(String.format("Total:        %.1fs", totalTime / 1000.0));
        }
    }
}
