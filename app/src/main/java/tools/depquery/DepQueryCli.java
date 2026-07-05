package tools.depquery;

import com.github.javaparser.StaticJavaParser;
import com.github.javaparser.ParserConfiguration;
import com.github.javaparser.ParserConfiguration.LanguageLevel;
import com.github.javaparser.ast.CompilationUnit;
import com.github.javaparser.symbolsolver.javaparsermodel.JavaParserFacade;
import com.github.javaparser.symbolsolver.JavaSymbolSolver;
import com.github.javaparser.symbolsolver.resolution.typesolvers.*;
import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.nio.file.*;
import java.util.*;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import java.net.URL;
import java.net.URLClassLoader;
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
        
        long analyzerSetupStart = startTiming("Analyzer Setup");
        CombinedTypeSolver solver = new CombinedTypeSolver(new ReflectionTypeSolver());
        for (Path src : cfg.srcRoots)
            solver.add(new JavaParserTypeSolver(src.toFile()));
        
        if (!cfg.classDirs.isEmpty()) {
            try {
                URL[] urls = cfg.classDirs.stream().map(p -> p.toUri()).map(u -> {
                    try {
                        return u.toURL();
                    } catch (Exception e) {
                        throw new RuntimeException(e);
                    }
                }).toArray(URL[]::new);
                ClassLoader cl = new URLClassLoader(urls, DepQueryCli.class.getClassLoader());
                solver.add(new ClassLoaderTypeSolver(cl));
            } catch (Throwable ignore) {
            }
        }
        for (Path jar : cfg.cpJars) {
            try {
                solver.add(new JarTypeSolver(jar.toString()));
            } catch (Throwable ignore) {
            }
        }
        for (Path dir : cfg.cpDirs) {
            try {
                if (Files.isDirectory(dir)) {
                    try (var s = Files.walk(dir)) {
                        s.filter(p -> p.toString().endsWith(".jar")).forEach(p -> {
                            try {
                                solver.add(new JarTypeSolver(p.toString()));
                            } catch (Throwable ignore) {
                            }
                        });
                    }
                } else if (dir.toString().endsWith(".jar")) {
                    solver.add(new JarTypeSolver(dir.toString()));
                }
            } catch (Throwable ignore) {
            }
        }
        
        StaticJavaParser.setConfiguration(new ParserConfiguration()
                .setSymbolResolver(new JavaSymbolSolver(solver))
                .setLanguageLevel(cfg.languageLevel));
        var facade = JavaParserFacade.get(solver);
        var locator = new SourceLocator(cfg.srcRoots);
        endTiming("Analyzer Setup", analyzerSetupStart);
        
        // HierarchyCache (CHA用)
        long hierarchyCacheStart = startTiming("Hierarchy Cache Build");
        Path cacheDir = cfg.workspace != null
                ? cfg.workspace.resolve(".callcanvas-cache")
                : cfg.outDir.resolve(".callcanvas-cache");
        HierarchyCache hierarchyCache = new HierarchyCache(cacheDir, cfg.srcRoots);
        hierarchyCache.initialize(cfg.rebuildCache);
        endTiming("Hierarchy Cache Build", hierarchyCacheStart);
        
        // ChaContext
        ChaContext chaContext = new ChaContext(locator, hierarchyCache);
        
        // CallIndexManager
        Path projectRoot = cfg.workspace != null ? cfg.workspace : cfg.outDir.getParent();
        CallIndexManager indexManager = new CallIndexManager(projectRoot);
        
        // CallIndexBuilder
        CallIndexBuilder builder = new CallIndexBuilder(cfg, locator, facade, chaContext);
        
        // 既存インデックスをチェック
        CallIndex callIndex;
        long indexBuildStart = startTiming("Index Construction");
        if (indexManager.indexExists()) {
            timing("META buildMode=incremental");
            info("[INFO] Existing index found. Performing incremental update...");
            long loadStart = startTiming("Index Load");
            CallIndex oldIndex = indexManager.loadIndex();
            endTiming("Index Load", loadStart);
            callIndex = builder.updateIndex(oldIndex, indexManager);
        } else {
            timing("META buildMode=full");
            info("[INFO] No existing index found. Building from scratch...");
            callIndex = builder.buildFullIndex();
        }
        chaContext.emitChaTimingSummary();
        timing("SUMMARY index=methods=" + callIndex.methods.size()
                + ",indexedFiles=" + callIndex.fileHashes.size());
        endTiming("Index Construction", indexBuildStart);
        
        // インデックスを保存
        long saveStart = startTiming("Index Save");
        indexManager.saveIndex(callIndex);
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
        final CallIndex finalCallIndex = callIndex;

        // root-class 指定時のみ cfg.roots をクラス内メソッド一覧で上書き（CLI の --root 入力とは別物）
        expandRootClassIfSet(cfg, finalCallIndex);

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

        // TypeSolver 構築
        CombinedTypeSolver solver = new CombinedTypeSolver(new ReflectionTypeSolver());
        for (Path src : cfg.srcRoots)
            solver.add(new JavaParserTypeSolver(src.toFile()));
        // 追加: ビルド済みクラスディレクトリをClassLoader経由で解決
        if (!cfg.classDirs.isEmpty()) {
            try {
                URL[] urls = cfg.classDirs.stream().map(p -> p.toUri()).map(u -> {
                    try {
                        return u.toURL();
                    } catch (Exception e) {
                        throw new RuntimeException(e);
                    }
                }).toArray(URL[]::new);
                ClassLoader cl = new URLClassLoader(urls, DepQueryCli.class.getClassLoader());
                solver.add(new ClassLoaderTypeSolver(cl));
            } catch (Throwable ignore) {
            }
        }
        // 追加クラスパス（JAR/ディレクトリ）
        for (Path jar : cfg.cpJars) {
            try {
                solver.add(new JarTypeSolver(jar.toString()));
                // Spring Boot fat-jar を自動展開（BOOT-INF/lib/*.jar）
                try {
                    expandBootJarLibs(jar).forEach(nestedJar -> {
                        try {
                            solver.add(new JarTypeSolver(nestedJar.toString()));
                        } catch (Throwable ignore2) {
                        }
                    });
                } catch (Throwable ignore3) {
                }
            } catch (Throwable ignore) {
            }
        }
        for (Path dir : cfg.cpDirs) {
            try {
                if (Files.isDirectory(dir)) {
                    try (var s = Files.walk(dir)) {
                        s.filter(p -> p.toString().endsWith(".jar")).forEach(p -> {
                            try {
                                solver.add(new JarTypeSolver(p.toString()));
                            } catch (Throwable ignore) {
                            }
                        });
                    }
                } else if (dir.toString().endsWith(".jar")) {
                    solver.add(new JarTypeSolver(dir.toString()));
                }
            } catch (Throwable ignore) {
            }
        }
        // JavaParser 設定（言語レベル/JSS）
        LanguageLevel langLevel = cfg.languageLevel;
        info("[INFO] Using language level: " + langLevel);
        ParserConfiguration pc = new ParserConfiguration()
                .setLanguageLevel(langLevel)
                .setAttributeComments(false)
                .setSymbolResolver(new JavaSymbolSolver(solver));
        StaticJavaParser.setConfiguration(pc);

        JavaParserFacade facade = JavaParserFacade.get(solver);

        // 解析準備
        var locator = new SourceLocator(cfg.srcRoots);
        var graph = new GraphModels.Graph();
        var visited = new HashSet<String>();
        var q = new ArrayDeque<Item>();

        // 遅延評価用のキャッシュ（必要に応じてオンデマンドで構築）
        Map<String, String> methodIndex = new HashMap<>(); // 曖昧マッチング時のみ使用
        Map<Path, CompilationUnit> parsedFiles = new HashMap<>(); // パース済みファイルキャッシュ

        // ルートメソッドが曖昧な場合のみ、メソッドインデックスをスキャン
        boolean needsFullScan = cfg.roots.stream().anyMatch(r -> !isFullyQualifiedRoot(r));

        if (needsFullScan) {
            info("[INFO] Scanning source files for method signatures (ambiguous root detected)...");
            methodIndex = buildMethodIndex(cfg.srcRoots, facade);
            info("[INFO] Found " + methodIndex.size() + " methods");
        } else {
            info("[INFO] Using lazy evaluation mode (fully qualified root)");
            info("[INFO] CHA will use on-demand search (no full scan)");
        }

        // 継承関係キャッシュを初期化（CHA高速化用）
        Path cacheDir = cfg.workspace != null
                ? cfg.workspace.resolve(".callcanvas-cache")
                : cfg.outDir.resolve(".callcanvas-cache");
        HierarchyCache hierarchyCache = new HierarchyCache(cacheDir, cfg.srcRoots);
        hierarchyCache.initialize(cfg.rebuildCache);

        // CHA用コンテキスト（キャッシュを使用して高速検索）
        final ChaContext chaContext = new ChaContext(locator, hierarchyCache);

        // 後方互換性のため（resolveRootMethodFqn等で使用）
        final Map<String, String> finalMethodIndex = methodIndex;

        // ルート解決（finalCallIndex は解析パス開始直後にロード済み）
        for (String userRoot : cfg.roots) {
            String resolvedRoot;

            if (needsFullScan) {
                // 曖昧マッチング対応（フルスキャン済み）
                resolvedRoot = resolveRootMethodFqn(userRoot, methodIndex);
                if (resolvedRoot == null) {
                    System.err.println("[WARN] root not found: " + userRoot);
                    continue;
                }
                if (!resolvedRoot.equals(userRoot)) {
                    info("[INFO] Resolved root: " + userRoot + " -> " + resolvedRoot);
                }
            } else {
                // 遅延評価モード：完全修飾名をそのまま使用
                resolvedRoot = userRoot;
            }

            // インデックスがあればルートもインデックスから取得（パースなし）
            if (finalCallIndex != null) {
                MethodEntry rootEntry = finalCallIndex.getMethod(resolvedRoot);
                if (rootEntry != null) {
                    q.add(new Item(resolvedRoot, 0));
                    createNodeFromEntry(graph, rootEntry);
                    debug("Root from index: " + resolvedRoot);
                    continue;  // パースをスキップ
                }
            }

            // フォールバック：インデックスにない場合は従来の方法
            var loc = locator.resolveMethod(resolvedRoot).orElse(null);
            if (loc == null) {
                System.err.println("[WARN] root source file not found: " + resolvedRoot);
                continue;
            }
            q.add(new Item(resolvedRoot, 0));
            ensureNodeFromDecl(graph, loc, facade);
            debug("Root from parsing: " + resolvedRoot);
        }

        // 解析実行（BFS解析）
        long analysisStart = startTiming("BFS Analysis");
        if (cfg.direction.equals("outgoing")) {
            // Outgoing calls: BFSで呼び出し先を追跡
            int methodsFromIndex = 0;
            int methodsFromParsing = 0;
            
            while (!q.isEmpty()) {
                var it = q.removeFirst();
                if (!visited.add(it.fqn) || it.depth > cfg.depth)
                    continue;

                // インデックスがあれば使用
                if (finalCallIndex != null) {
                    MethodEntry indexedMethod = finalCallIndex.getMethod(it.fqn);
                    if (indexedMethod != null) {
                        debug("Using index for: " + it.fqn);
                        methodsFromIndex++;
                        
                        // インデックスから現在のノードを構築（メタデータ使用）
                        createNodeFromEntry(graph, indexedMethod);
                        
                        // インデックスから呼び出し先を取得
                        // 【順序前提】calleesリストは collectCallsForMethod により、
                        // 非override callee → そのoverride callee群 の順序で格納されている。
                        // この順序に依存して lastCallTargetFqn を追跡する。
                        // 順序が崩れた場合は lastCallTargetFqn が null となり、
                        // override callee は caller からの直接エッジにフォールバックする（フェイルセーフ）。
                        String lastCallTargetFqn = null;
                        
                        for (CallRef calleeRef : indexedMethod.callees) {
                            boolean isOverride = "override".equals(calleeRef.type);
                            boolean accepted = acceptByFilter(calleeRef.fqn, cfg);

                            // フィルタ通過した非override calleeのみlastCallTargetFqnに記録
                            // フィルタ除外時はnullにリセット（overrideがcallerからのフォールバックエッジを使うように）
                            if (!isOverride) {
                                lastCallTargetFqn = accepted ? calleeRef.fqn : null;
                            }

                            if (!accepted) {
                                continue;
                            }
                            
                            // Create edge: override -> interface->implementation, others -> caller->callee
                            if (isOverride && lastCallTargetFqn != null) {
                                // Override: interface/parent method -> implementation
                                MethodEntry interfaceEntry = finalCallIndex.getMethod(lastCallTargetFqn);
                                int overrideCallLine = calleeRef.line;
                                int overrideCallEndLine = calleeRef.endLine;
                                if (interfaceEntry != null && interfaceEntry.lineStart > 0) {
                                    overrideCallLine = interfaceEntry.lineStart;
                                    overrideCallEndLine = interfaceEntry.lineEnd;
                                }
                                // CallCanvas Viewer の F12 は接続の callLine とウィンドウ内の行番号の一致でジャンプする。
                                // SourceLocator がシグネチャ一致で宣言行を解決できた場合のみ上書き（誤フォールバックで悪化させない）。
                                var ifaceDeclLoc = locator.resolveMethod(lastCallTargetFqn);
                                if (ifaceDeclLoc.isPresent()) {
                                    var range = ifaceDeclLoc.get().decl().getRange();
                                    if (range.isPresent()) {
                                        overrideCallLine = range.get().begin.line;
                                        overrideCallEndLine = range.get().end.line;
                                    }
                                }
                                graph.addEdge(lastCallTargetFqn, calleeRef.fqn, "override",
                                            overrideCallLine, overrideCallEndLine);
                            } else {
                                // Normal call: caller -> callee
                                graph.addEdge(it.fqn, calleeRef.fqn, calleeRef.type, 
                                            calleeRef.line, calleeRef.endLine);
                            }
                            
                            // 呼び出し先のノードを追加（メタデータ使用）
                            MethodEntry calleeEntry = finalCallIndex.getMethod(calleeRef.fqn);
                            if (calleeEntry != null) {
                                createNodeFromEntry(graph, calleeEntry);
                                
                                if (!visited.contains(calleeRef.fqn) && it.depth < cfg.depth) {
                                    q.add(new Item(calleeRef.fqn, it.depth + 1));
                                }
                            } else {
                                // Indexにない場合はスタブノードを作成（パース回避）
                                createStubNode(graph, calleeRef.fqn);
                                // 探索キューには追加しない（詳細情報がないため）
                            }
                        }
                        continue; // インデックスから取得できたのでcollectEdgesをスキップ
                    }
                }

                // フォールバック: 従来の解析（インデックスがない場合）
                var locOpt = locator.resolveMethod(it.fqn);
                if (locOpt.isEmpty())
                    continue;
                var loc = locOpt.get();
                var cu = parseCu(loc.file());
                var md = findMethodDeclBySig(cu, it.fqn).orElse(null);
                if (md == null)
                    continue;

                debug("Fallback to parsing for: " + it.fqn);
                methodsFromParsing++;
                collectEdges(md, it.fqn, cu, facade, graph, cfg, locator, chaContext, (callee) -> {
                    if (!visited.contains(callee) && it.depth < cfg.depth) {
                        q.add(new Item(callee, it.depth + 1));
                    }
                });
            }
            
            long analysisTime = System.currentTimeMillis() - analysisStart;
            if (finalCallIndex != null) {
                info("[INFO] Outgoing analysis: " + methodsFromIndex + " methods from index, " 
                                 + methodsFromParsing + " methods from parsing");
            }
            if (DEBUG) {
                debugTimed("BFS analysis completed in " + analysisTime + "ms (" + 
                          graph.nodes.size() + " nodes, " + graph.edges.size() + " edges)");
                debugTimed("  - Methods from index: " + methodsFromIndex);
                debugTimed("  - Methods from parsing: " + methodsFromParsing);
            }
            endTiming("BFS Analysis", analysisStart);
        } else {
            // Incoming calls: 全ソースファイルをスキャンしてターゲットメソッドへの呼び出しを検索
            collectIncomingCalls(graph, cfg, locator, facade, chaContext, parsedFiles, finalCallIndex);
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
            // code は toCallCanvasJson 内でファイルから Javadoc 含めて取得するためここでは埋めない
            JSONObject callcanvasJson = toCallCanvasJson(graph, cfg.srcRoots, resolvedRoots, cfg.workspace,
                    cfg.windowWidth,
                    finalCallIndex != null ? finalCallIndex.symbolIndex : null);

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


    // ===== helpers =====

    record Item(String fqn, int depth) {
    }

    private static List<Path> expandBootJarLibs(Path bootJar) {
        List<Path> out = new ArrayList<>();
        if (!Files.isRegularFile(bootJar) || !bootJar.toString().endsWith(".jar"))
            return out;
        try (ZipFile zf = new ZipFile(bootJar.toFile())) {
            Enumeration<? extends ZipEntry> entries = zf.entries();
            while (entries.hasMoreElements()) {
                ZipEntry e = entries.nextElement();
                String name = e.getName();
                if (name.startsWith("BOOT-INF/lib/") && name.endsWith(".jar")) {
                    Path tmp = Files.createTempFile("depq-bootlib-", ".jar");
                    try (var in = zf.getInputStream(e)) {
                        Files.copy(in, tmp, StandardCopyOption.REPLACE_EXISTING);
                    }
                    out.add(tmp);
                }
            }
        } catch (Throwable ignore) {
        }
        return out;
    }


}
