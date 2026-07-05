package tools.depquery;

import com.github.javaparser.StaticJavaParser;
import com.github.javaparser.ast.CompilationUnit;
import com.github.javaparser.ast.body.ClassOrInterfaceDeclaration;
import com.github.javaparser.ast.body.MethodDeclaration;
import com.github.javaparser.ast.expr.MethodCallExpr;
import com.github.javaparser.ast.expr.MethodReferenceExpr;
import com.github.javaparser.ast.expr.ObjectCreationExpr;
import com.github.javaparser.resolution.declarations.ResolvedConstructorDeclaration;
import com.github.javaparser.resolution.declarations.ResolvedMethodDeclaration;
import com.github.javaparser.symbolsolver.javaparsermodel.JavaParserFacade;

import java.io.IOException;
import java.nio.file.*;
import java.util.*;

import static tools.depquery.DiagnosticLogger.*;
import static tools.depquery.FqnUtils.*;
import static tools.depquery.NodeFactory.*;
import static tools.depquery.MethodResolver.*;
import tools.depquery.CallIndexModels.*;

/**
 * BFS呼び出しグラフ走査・エッジ収集
 */
class CallGraphAnalyzer {

    static void collectEdges(
            MethodDeclaration md, String callerFqn, CompilationUnit cu, JavaParserFacade facade,
            GraphModels.Graph g, AnalyzerConfig cfg, SourceLocator locator,
            ChaContext chaContext,
            java.util.function.Consumer<String> enqueue) {
        // caller ノード（表示ラベル/行区間など）
        String callerId = ensureNodeFromDecl(g, new SourceLocator.MethodLoc(callerFqn, sourcePathOf(cu), md), facade);

        // 同一クラス内のメソッドを事前に収集（フォールバック用）
        var clazzDecl = md.findAncestor(ClassOrInterfaceDeclaration.class).orElse(null);
        String currentClassFqn = clazzDecl != null ? clazzDecl.getFullyQualifiedName().orElse(null) : null;
        Map<String, List<MethodDeclaration>> sameClassMethods = new HashMap<>();
        if (clazzDecl != null) {
            for (var m : clazzDecl.getMethods()) {
                sameClassMethods.computeIfAbsent(m.getNameAsString(), k -> new ArrayList<>()).add(m);
            }
        }

        // メソッド呼び出し
        var _dbgCalls = md.findAll(MethodCallExpr.class);
        debug("method=" + callerFqn + " calls=" + _dbgCalls.size());
        md.findAll(MethodCallExpr.class).forEach(mc -> {
            int line = mc.getRange().map(r -> r.begin.line).orElse(-1);
            int endLine = mc.getRange().map(r -> r.end.line).orElse(line);
            try {
                debugVerbose("Attempting to solve: " + mc + " at line " + line);
                ResolvedMethodDeclaration decl = facade.solve(mc).getCorrespondingDeclaration();
                String callee = toMethodFqn(decl);
                debug("resolve OK line=" + line + " expr=" + mc + " -> " + callee);
                if (!acceptByFilter(callee, cfg))
                    return;
                g.addEdge(callerId, callee, "call", line, endLine);
                debugVerbose("addEdge from=" + callerFqn + " to=" + callee + " line=" + line);
                // callee がプロジェクトソース内なら探索候補へ
                if (locator.resolveMethod(callee).isPresent())
                    enqueue.accept(callee);
                ensureNodeStubIfMissing(g, decl, locator); // 表示用にノード用意

                // CHA: 仮想呼び出しの場合、サブクラスの実装も追加
                if (isVirtualCall(decl)) {
                    addOverrideEdges(g, callee, line, endLine, cfg, locator, chaContext, facade, enqueue);
                }
            } catch (Throwable ex) {
                String errorMsg = formatExceptionDetail(ex);
                debug("resolve NG line=" + line + " expr=" + mc + " reason=" + errorMsg);

                // フォールバック: 同一クラス内のメソッド呼び出しを名前で検索
                boolean fallbackResolved = false;
                boolean hasScope = mc.getScope().isPresent();
                debugVerbose("Fallback check: method=" + mc.getNameAsString() + " hasScope=" + hasScope
                        + " currentClassFqn=" + currentClassFqn);

                if (currentClassFqn != null && !hasScope) {
                    // スコープなし = 同一クラス内の可能性が高い
                    String methodName = mc.getNameAsString();
                    int argCount = mc.getArguments().size();
                    var candidates = sameClassMethods.get(methodName);
                    debugVerbose("Fallback: looking for " + methodName + " with " + argCount + " args, candidates="
                            + (candidates != null ? candidates.size() : 0));
                    if (candidates != null) {
                        for (var candidate : candidates) {
                            debugVerbose("Fallback: candidate " + candidate.getNameAsString() + " has "
                                    + candidate.getParameters().size() + " params");
                            if (candidate.getParameters().size() == argCount) {
                                // マッチ！（全オーバーロードを追加するため break しない）
                                String callee = buildMethodFqn(currentClassFqn, candidate, facade);
                                debug("fallback resolved (same class): " + mc + " -> " + callee);
                                if (acceptByFilter(callee, cfg)) {
                                    g.addEdge(callerId, callee, "call", line, endLine);
                                    if (locator.resolveMethod(callee).isPresent())
                                        enqueue.accept(callee);
                                    // ノードも追加
                                    var loc = locator.resolveMethod(callee);
                                    if (loc.isPresent()) {
                                        ensureNodeFromDecl(g, loc.get(), facade);
                                    }

                                    // CHA: フォールバックで解決した場合もオーバーライドを追加
                                    try {
                                        ResolvedMethodDeclaration fallbackDecl = candidate.resolve();
                                        if (isVirtualCall(fallbackDecl)) {
                                            addOverrideEdges(g, callee, line, endLine, cfg, locator, chaContext, facade, enqueue);
                                        }
                                    } catch (Throwable chaEx) {
                                        debugVerbose("CHA failed for fallback method: " + callee);
                                    }
                                } else {
                                    debugVerbose("Fallback: callee filtered out: " + callee);
                                }
                                fallbackResolved = true;
                                // 同一引数数の全オーバーロードを処理するため break しない
                            }
                        }
                    }
                } else if (currentClassFqn != null && hasScope) {
                    String scopeStr = mc.getScope().get().toString();
                    String methodName = mc.getNameAsString();
                    int argCount = mc.getArguments().size();

                    if (scopeStr.equals("this") || scopeStr.equals("super")) {
                        // this/super スコープ: 同一クラス内を検索
                        var candidates = sameClassMethods.get(methodName);
                        debugVerbose("Fallback (this/super scope): looking for " + methodName + " with " + argCount
                                + " args");
                        if (candidates != null) {
                            for (var candidate : candidates) {
                                if (candidate.getParameters().size() == argCount) {
                                    String callee = buildMethodFqn(currentClassFqn, candidate, facade);
                                    debug("fallback resolved (this/super): " + mc + " -> " + callee);
                                    if (acceptByFilter(callee, cfg)) {
                                        g.addEdge(callerId, callee, "call", line, endLine);
                                        if (locator.resolveMethod(callee).isPresent())
                                            enqueue.accept(callee);
                                        var loc = locator.resolveMethod(callee);
                                        if (loc.isPresent()) {
                                            ensureNodeFromDecl(g, loc.get(), facade);
                                        }

                                        // CHA: フォールバックで解決した場合もオーバーライドを追加
                                        try {
                                            ResolvedMethodDeclaration fallbackDecl = candidate.resolve();
                                            if (isVirtualCall(fallbackDecl)) {
                                                addOverrideEdges(g, callee, line, endLine, cfg, locator, chaContext, facade, enqueue);
                                            }
                                        } catch (Throwable chaEx) {
                                            debugVerbose("CHA failed for fallback method: " + callee);
                                        }
                                    }
                                    fallbackResolved = true;
                                    // 同一引数数の全オーバーロードを処理するため break しない
                                }
                            }
                        }

                        // 同一クラスで見つからない場合、親クラスを探索
                        if (!fallbackResolved) {
                            List<String> parentClasses = chaContext.getCache().getParentClasses(currentClassFqn);
                            Set<String> visited = new HashSet<>();
                            Queue<String> parentQueue = new LinkedList<>(parentClasses);
                            while (!parentQueue.isEmpty()) {
                                String parentFqn = parentQueue.poll();
                                if (visited.contains(parentFqn)) continue;
                                visited.add(parentFqn);
                                List<String> callees = findAllMethodFqnsInClassFallback(parentFqn, methodName, argCount, locator, facade);
                                if (!callees.isEmpty()) {
                                    for (String callee : callees) {
                                        debug("fallback resolved (parent class): " + mc + " -> " + callee);
                                        if (acceptByFilter(callee, cfg)) {
                                            g.addEdge(callerId, callee, "call", line, endLine);
                                            if (locator.resolveMethod(callee).isPresent())
                                                enqueue.accept(callee);
                                            var loc = locator.resolveMethod(callee);
                                            if (loc.isPresent()) {
                                                ensureNodeFromDecl(g, loc.get(), facade);
                                            }
                                            // CHA: 親クラス経由フォールバックでもオーバーライドを追加
                                            addOverrideEdges(g, callee, line, endLine, cfg, locator, chaContext, facade, enqueue);
                                        }
                                    }
                                    fallbackResolved = true;
                                } else {
                                    parentQueue.addAll(chaContext.getCache().getParentClasses(parentFqn));
                                }
                            }
                        }
                    } else {
                        // 外部オブジェクトスコープ: フィールド型を解決してメソッドを検索
                        var scope = mc.getScope().get();
                        String scopeTypeFqn = null;
                        try {
                            var resolvedType = facade.getType(scope);
                            scopeTypeFqn = resolvedType.describe();
                        } catch (Throwable ex2) {
                            if (scope.isNameExpr()) {
                                String scopeName = scope.asNameExpr().getNameAsString();
                                scopeTypeFqn = resolveFieldTypeFallback(currentClassFqn, scopeName, locator, facade);
                            }
                        }
                        if (scopeTypeFqn != null) {
                            scopeTypeFqn = scopeTypeFqn.replaceAll("<.*?>", "");
                            List<String> calleeFqns = findAllMethodFqnsInClassFallback(scopeTypeFqn, methodName, argCount, locator, facade);
                            if (calleeFqns.isEmpty()) {
                                // ソースから見つからない場合は推測形式で記録
                                String guessedFqn = scopeTypeFqn + "#" + methodName + "(...)";
                                debugVerbose("Fallback resolved with scope (guessed): " + guessedFqn);
                                if (acceptByFilter(guessedFqn, cfg)) {
                                    g.addEdge(callerId, guessedFqn, "call", line, endLine);
                                }
                                fallbackResolved = true;
                            } else {
                                // 全オーバーロード候補に対してエッジ追加 + CHA override 追加
                                for (String calleeFqn : calleeFqns) {
                                    debugVerbose("Fallback resolved with scope (found): " + calleeFqn);
                                    if (acceptByFilter(calleeFqn, cfg)) {
                                        g.addEdge(callerId, calleeFqn, "call", line, endLine);
                                        if (locator.resolveMethod(calleeFqn).isPresent())
                                            enqueue.accept(calleeFqn);
                                        var loc = locator.resolveMethod(calleeFqn);
                                        if (loc.isPresent()) {
                                            ensureNodeFromDecl(g, loc.get(), facade);
                                        }
                                        // CHA: 外部スコープフォールバックのオーバーライドを追加（Bug 2 修正）
                                        addOverrideEdges(g, calleeFqn, line, endLine, cfg, locator, chaContext, facade, enqueue);
                                    }
                                }
                                fallbackResolved = true;
                            }
                        }
                    }
                }

                // "unknown tree"エラーの詳細を出力
                if (errorMsg.contains("unknown tree") || errorMsg.contains("UnknownTree")) {
                    System.err.println("[WARN] unknown tree error at line " + line + ": " + mc);
                    System.err.println("  Expression type: " + mc.getClass().getSimpleName());
                    mc.getScope().ifPresent(scope -> System.err
                            .println("  Scope: " + scope + " (type: " + scope.getClass().getSimpleName() + ")"));
                    if (DEBUG) {
                        ex.printStackTrace(System.err);
                    }
                }

                if (!fallbackResolved) {
                    g.addUnresolved(callerId, mc.toString(), line, formatResolveError(ex));
                }
            }
        });

        // コンストラクタ呼び出し
        md.findAll(ObjectCreationExpr.class).forEach(ne -> {
            int line = ne.getRange().map(r -> r.begin.line).orElse(-1);
            int endLine = ne.getRange().map(r -> r.end.line).orElse(line);
            try {
                ResolvedConstructorDeclaration decl = facade.solve(ne).getCorrespondingDeclaration();
                String callee = toCtorFqn(decl);
                if (!acceptByFilter(callee, cfg))
                    return;
                g.addEdge(callerId, callee, "ctor", line, endLine);
                if (locator.resolveMethod(callee).isPresent())
                    enqueue.accept(callee);
                ensureNodeStubIfMissing(g, decl, locator);
            } catch (Throwable ex) {
                g.addUnresolved(callerId, ne.toString(), line, "unresolved");
            }
        });

        // メソッド参照（e.g. obj::method）
        var _dbgMethodRefs = md.findAll(MethodReferenceExpr.class);
        debug("method=" + callerFqn + " method-refs=" + _dbgMethodRefs.size());
        md.findAll(MethodReferenceExpr.class).forEach(mr -> {
            int line = mr.getRange().map(r -> r.begin.line).orElse(-1);
            int endLine = mr.getRange().map(r -> r.end.line).orElse(line);
            debugVerbose("method-ref found: " + mr + " at line " + line);
            try {
                ResolvedMethodDeclaration decl = facade.solve(mr).getCorrespondingDeclaration();
                String callee = toMethodFqn(decl);
                debug("method-ref resolved: " + mr + " -> " + callee);
                if (!acceptByFilter(callee, cfg)) {
                    debugVerbose("method-ref filtered out: " + callee);
                    return;
                }
                g.addEdge(callerId, callee, "method-ref", line, endLine);
                debugVerbose("addEdge method-ref from=" + callerFqn + " to=" + callee);
                if (locator.resolveMethod(callee).isPresent())
                    enqueue.accept(callee);
                ensureNodeStubIfMissing(g, decl, locator);

                // CHA: メソッド参照の場合も、サブクラスの実装を追加
                if (isVirtualCall(decl)) {
                    addOverrideEdges(g, callee, line, endLine, cfg, locator, chaContext, facade, enqueue);
                }
            } catch (Throwable ex) {
                String errorMsg = formatExceptionDetail(ex);
                debug("method-ref resolve NG: " + mr + " reason=" + errorMsg);
                // "unknown tree"エラーの詳細を出力
                if (errorMsg.contains("unknown tree") || errorMsg.contains("UnknownTree")) {
                    System.err.println("[WARN] unknown tree error at line " + line + ": " + mr);
                    System.err.println("  Expression type: " + mr.getClass().getSimpleName());
                    System.err.println(
                            "  Scope: " + mr.getScope() + " (type: " + mr.getScope().getClass().getSimpleName() + ")");
                    if (DEBUG) {
                        ex.printStackTrace(System.err);
                    }
                }
                g.addUnresolved(callerId, mr.toString(), line, formatResolveError(ex));
            }
        });
    }

    /**
     * Incoming Calls解析: 全ソースファイルをスキャンして、ターゲットメソッドへの呼び出しを検出
     */
    static void collectIncomingCalls(
            GraphModels.Graph g,
            AnalyzerConfig cfg,
            SourceLocator locator,
            JavaParserFacade facade,
            ChaContext chaContext,
            Map<Path, CompilationUnit> parsedFiles,
            CallIndex callIndex) {

        // ターゲットメソッド（グラフに既に追加されているノード）
        Set<String> targetMethods = new HashSet<>(g.nodes.keySet());
        if (targetMethods.isEmpty()) {
            return;
        }

        debug("Incoming calls: searching for callers of " + targetMethods.size() + " target methods");

        // インデックスがあれば使用（BFS再帰対応）
        if (callIndex != null) {
            debug("Using index for incoming calls (BFS recursive)");
            int callersFound = 0;

            // BFS再帰の安全上限
            final int MAX_INCOMING_DEPTH = 50;
            int effectiveMaxDepth = (cfg.depth == -1) ? MAX_INCOMING_DEPTH : cfg.depth;
            debug("Effective max depth: " + effectiveMaxDepth + " (cfg.depth=" + cfg.depth + ")");

            // BFSキュー: (メソッドFQN, 現在の深さ)
            record BfsEntry(String fqn, int depth) {}
            Queue<BfsEntry> queue = new LinkedList<>();
            Set<String> visited = new HashSet<>(targetMethods);

            // インデックスFQN → 実ノードID のマッピング
            // ensureNodeFromDecl が生成するIDはインデックスFQNと異なる場合がある
            // （型解決の差異: インデックスは "?" 、ensureNodeFromDecl は raw型名を使用）
            Map<String, String> indexFqnToNodeId = new HashMap<>();
            for (String target : targetMethods) {
                indexFqnToNodeId.put(target, target);
                queue.add(new BfsEntry(target, 0));
            }

            while (!queue.isEmpty()) {
                BfsEntry entry = queue.poll();
                MethodEntry indexedMethod = callIndex.getMethod(entry.fqn);
                if (indexedMethod == null) continue;

                String entryNodeId = indexFqnToNodeId.getOrDefault(entry.fqn, entry.fqn);

                for (CallRef callerRef : indexedMethod.callers) {
                    if (!acceptByFilter(callerRef.fqn, cfg))
                        continue;

                    // 呼び出し元のノードを先に追加（エッジで実ノードIDを使うため）
                    String callerNodeId = callerRef.fqn;
                    var callerLoc = locator.resolveMethod(callerRef.fqn);
                    if (callerLoc.isPresent()) {
                        callerNodeId = ensureNodeFromDecl(g, callerLoc.get(), facade);
                    }
                    indexFqnToNodeId.put(callerRef.fqn, callerNodeId);

                    g.addEdge(callerNodeId, entryNodeId, callerRef.type,
                            callerRef.line, callerRef.endLine);
                    callersFound++;

                    // BFS: 未訪問かつ深さ上限内なら次の探索候補に追加
                    // depth=N means N levels of callers; entry.depth+1 is the next level
                    if (!visited.contains(callerRef.fqn) && (entry.depth + 1) <= effectiveMaxDepth) {
                        visited.add(callerRef.fqn);
                        queue.add(new BfsEntry(callerRef.fqn, entry.depth + 1));
                    }
                }
            }

            info("[INFO] Found " + callersFound + " callers using index (BFS, maxDepth=" + effectiveMaxDepth + ")");
            return; // インデックスから取得できたのでフォールバックをスキップ
        }

        // フォールバック: 従来の解析（インデックスがない場合）
        // depth=-1（ルートまで再帰）はインデックス必須。フォールバックでは1階層のみ。
        if (cfg.depth == -1) {
            System.err.println("[WARN] Index not found. BFS recursive incoming calls (--depth -1) is only supported with index (--build-index). Falling back to 1-level scan.");
        }
        debug("Fallback to full scan for incoming calls");

        // 双方向CHAを使用して、ターゲットメソッドの実装/オーバーライドと親メソッドも含める
        Set<String> extendedTargets = new HashSet<>(targetMethods);
        for (String target : targetMethods) {
            // 下方向: ターゲットが抽象/インターフェースメソッドの場合、その実装も追加
            Set<String> overrides = chaContext.findOverrides(target);
            extendedTargets.addAll(overrides);

            // 上方向: ターゲットの親インターフェース/クラスのメソッドも追加（双方向CHA）
            Set<String> parentMethods = chaContext.findParentMethods(target);
            extendedTargets.addAll(parentMethods);
        }
        debug("Extended targets (with overrides and parents): " + extendedTargets.size() + " methods");

        // Stage 1: メソッド名ベースの高速フィルタリング
        // ターゲットメソッド名のセットを構築
        Set<String> targetMethodNames = new HashSet<>();
        for (String fqn : extendedTargets) {
            int hashPos = fqn.indexOf('#');
            int parenPos = fqn.indexOf('(', hashPos);
            if (hashPos >= 0 && parenPos > hashPos) {
                String methodName = fqn.substring(hashPos + 1, parenPos);
                targetMethodNames.add(methodName);
            }
        }
        debug("Stage 1: Searching for method names: " + targetMethodNames);

        // 全ソースファイルをスキャン（Stage 1: テキストマッチング）
        int filesScanned = 0;
        int filesSkipped = 0;
        final int[] callersFound = {0}; // ラムダ式の中で使用するため配列にする

        for (Path srcRoot : cfg.srcRoots) {
            try (var stream = Files.walk(srcRoot)) {
                var javaFiles = stream.filter(p -> p.toString().endsWith(".java")).toList();

                for (Path javaFile : javaFiles) {
                    filesScanned++;

                    // Stage 1: ファイル内容をテキストとして読み込み、メソッド名を含むかチェック
                    try {
                        String fileContent = Files.readString(javaFile);
                        boolean containsTargetMethod = false;
                        for (String methodName : targetMethodNames) {
                            // メソッド呼び出しのパターン: methodName(
                            if (fileContent.contains(methodName + "(")) {
                                containsTargetMethod = true;
                                break;
                            }
                        }

                        if (!containsTargetMethod) {
                            filesSkipped++;
                            if (filesScanned % 100 == 0) {
                                debug("Stage 1: Scanned " + filesScanned + " files, skipped " + filesSkipped + " files");
                            }
                            continue; // このファイルはスキップ
                        }
                    } catch (IOException ex) {
                        // ファイル読み込み失敗の場合は念のためパースする
                        debugVerbose("Failed to read file for filtering: " + javaFile);
                    }

                    // Stage 2: 候補ファイルのみ詳細解析
                    if (filesScanned % 100 == 0) {
                        debug("Stage 2: Scanned " + filesScanned + " files, found " + callersFound[0] + " callers, skipped " + filesSkipped);
                    }

                    try {
                        CompilationUnit cu = parsedFiles.computeIfAbsent(javaFile, FqnUtils::parseCu);

                        // このファイル内の各メソッドをチェック
                        cu.findAll(MethodDeclaration.class).forEach(md -> {
                            // クラス情報を取得
                            var clazzDecl = md.findAncestor(ClassOrInterfaceDeclaration.class).orElse(null);
                            if (clazzDecl == null) return;

                            String currentClassFqn = clazzDecl.getFullyQualifiedName().orElse(null);
                            if (currentClassFqn == null) return;

                            // メソッドFQNを構築
                            String callerFqn = buildMethodFqn(currentClassFqn, md, facade);

                            // メソッド呼び出しをチェック
                            md.findAll(MethodCallExpr.class).forEach(mc -> {
                                int line = mc.getRange().map(r -> r.begin.line).orElse(-1);
                                int endLine = mc.getRange().map(r -> r.end.line).orElse(line);

                                try {
                                    ResolvedMethodDeclaration decl = facade.solve(mc).getCorrespondingDeclaration();
                                    String callee = toMethodFqn(decl);

                                    // ターゲットメソッドへの呼び出しか？
                                    if (extendedTargets.contains(callee)) {
                                        // フィルタチェック
                                        if (!acceptByFilter(callerFqn, cfg)) {
                                            return;
                                        }

                                        // エッジを追加: caller → target
                                        g.addEdge(callerFqn, callee, "call", line, endLine);
                                        callersFound[0]++;
                                        debug("Found caller: " + callerFqn + " → " + callee + " at line " + line);

                                        // callerノードを追加
                                        var callerLoc = locator.resolveMethod(callerFqn);
                                        if (callerLoc.isPresent()) {
                                            ensureNodeFromDecl(g, callerLoc.get(), facade);
                                        } else {
                                            // ソースが見つからない場合でもスタブノードを作成
                                            ensureNodeStubIfMissing(g, decl, locator);
                                        }
                                    }
                                } catch (Throwable ex) {
                                    // 解決失敗は無視（呼び出し元検索では重要でない）
                                    debugVerbose("Failed to resolve call in " + callerFqn + ": " + mc);
                                }
                            });

                            // メソッド参照もチェック
                            md.findAll(MethodReferenceExpr.class).forEach(mr -> {
                                int line = mr.getRange().map(r -> r.begin.line).orElse(-1);
                                int endLine = mr.getRange().map(r -> r.end.line).orElse(line);

                                try {
                                    ResolvedMethodDeclaration decl = facade.solve(mr).getCorrespondingDeclaration();
                                    String callee = toMethodFqn(decl);

                                    if (extendedTargets.contains(callee)) {
                                        if (!acceptByFilter(callerFqn, cfg)) {
                                            return;
                                        }

                                        g.addEdge(callerFqn, callee, "method-ref", line, endLine);
                                        callersFound[0]++;
                                        debug("Found caller (method-ref): " + callerFqn + " → " + callee + " at line " + line);

                                        var callerLoc = locator.resolveMethod(callerFqn);
                                        if (callerLoc.isPresent()) {
                                            ensureNodeFromDecl(g, callerLoc.get(), facade);
                                        }
                                    }
                                } catch (Throwable ex) {
                                    debugVerbose("Failed to resolve method-ref in " + callerFqn + ": " + mr);
                                }
                            });
                        });

                    } catch (Throwable ex) {
                        debugVerbose("Failed to parse file: " + javaFile + " - " + ex.getMessage());
                    }
                }
            } catch (IOException ex) {
                System.err.println("[WARN] Failed to scan source root: " + srcRoot + " - " + ex.getMessage());
            }
        }

        info("[INFO] Incoming calls scan complete: " + filesScanned + " files scanned, " +
                          filesSkipped + " files skipped (Stage 1), " +
                          (filesScanned - filesSkipped) + " files analyzed (Stage 2), " +
                          callersFound[0] + " callers found");
    }

    // ===== CHA (Class Hierarchy Analysis) =====

    /**
     * クラス継承関係のインデックスを構築
     * Key: 親クラス/インターフェースのFQN
     * Value: 直接の子クラス/実装クラスのFQNのSet
     */
    static Map<String, Set<String>> buildClassHierarchy(List<Path> srcRoots) {
        Map<String, Set<String>> hierarchy = new HashMap<>();

        for (Path root : srcRoots) {
            try (var stream = Files.walk(root)) {
                stream.filter(p -> p.toString().endsWith(".java"))
                        .forEach(javaFile -> {
                            try {
                                CompilationUnit cu = StaticJavaParser.parse(Files.readString(javaFile));
                                cu.findAll(ClassOrInterfaceDeclaration.class).forEach(cls -> {
                                    String classFqn = cls.getFullyQualifiedName().orElse(null);
                                    if (classFqn == null)
                                        return;

                                    // 親クラス（extends）
                                    cls.getExtendedTypes().forEach(extType -> {
                                        String parentFqn = resolveTypeFqn(extType, cu);
                                        if (parentFqn != null) {
                                            hierarchy.computeIfAbsent(parentFqn, k -> new HashSet<>()).add(classFqn);
                                        }
                                    });

                                    // 実装インターフェース（implements）
                                    cls.getImplementedTypes().forEach(implType -> {
                                        String parentFqn = resolveTypeFqn(implType, cu);
                                        if (parentFqn != null) {
                                            hierarchy.computeIfAbsent(parentFqn, k -> new HashSet<>()).add(classFqn);
                                        }
                                    });
                                });
                            } catch (Throwable ignored) {
                                // パースエラーは無視
                            }
                        });
            } catch (Throwable ignored) {
            }
        }

        return hierarchy;
    }

    /**
     * 型参照から完全修飾名を解決
     */
    static String resolveTypeFqn(com.github.javaparser.ast.type.ClassOrInterfaceType type, CompilationUnit cu) {
        String simpleName = type.getNameAsString();

        // 1. 同一ファイル内のクラスを探す
        for (var cls : cu.findAll(ClassOrInterfaceDeclaration.class)) {
            if (cls.getNameAsString().equals(simpleName)) {
                return cls.getFullyQualifiedName().orElse(null);
            }
        }

        // 2. importから解決
        for (var imp : cu.getImports()) {
            String importName = imp.getNameAsString();
            if (importName.endsWith("." + simpleName)) {
                return importName;
            }
            // ワイルドカードimportの場合は簡易的に推測
            if (imp.isAsterisk()) {
                String pkg = importName;
                return pkg + "." + simpleName;
            }
        }

        // 3. 同一パッケージ内と仮定
        return cu.getPackageDeclaration()
                .map(pd -> pd.getNameAsString() + "." + simpleName)
                .orElse(simpleName);
    }

    /**
     * サブクラスでオーバーライドしているメソッドを探索（再帰的）
     */
    static Set<String> findOverridingMethods(
            String methodFqn,
            Map<String, Set<String>> hierarchy,
            Map<String, String> methodIndex) {

        Set<String> result = new HashSet<>();

        // メソッドFQNからクラス名とメソッド名+パラメータを分離
        int hashPos = methodFqn.indexOf('#');
        if (hashPos < 0)
            return result;

        String classFqn = methodFqn.substring(0, hashPos);
        String methodSig = methodFqn.substring(hashPos + 1); // name(params)

        // 再帰的にサブクラスを探索
        findOverridingMethodsRecursive(classFqn, methodSig, hierarchy, methodIndex, result, new HashSet<>());

        return result;
    }

    private static void findOverridingMethodsRecursive(
            String classFqn,
            String methodSig,
            Map<String, Set<String>> hierarchy,
            Map<String, String> methodIndex,
            Set<String> result,
            Set<String> visited) {

        if (visited.contains(classFqn))
            return;
        visited.add(classFqn);

        // このクラスの直接のサブクラスを取得
        Set<String> subclasses = hierarchy.get(classFqn);
        if (subclasses == null)
            return;

        for (String subclass : subclasses) {
            // サブクラスがこのメソッドをオーバーライドしているか確認
            String candidateFqn = subclass + "#" + methodSig;
            if (methodIndex.containsKey(candidateFqn)) {
                result.add(candidateFqn);
            }

            // さらに下のサブクラスも探索
            findOverridingMethodsRecursive(subclass, methodSig, hierarchy, methodIndex, result, visited);
        }
    }

    // ===== private helpers =====

    /**
     * CHA: オーバーライドエッジを追加する共通ヘルパー
     */
    private static void addOverrideEdges(
            GraphModels.Graph g, String callee, int line, int endLine,
            AnalyzerConfig cfg, SourceLocator locator, ChaContext chaContext,
            JavaParserFacade facade, java.util.function.Consumer<String> enqueue) {
        Set<String> overrides = chaContext.findOverrides(callee);
        for (String impl : overrides) {
            if (!acceptByFilter(impl, cfg))
                continue;
            if (impl.equals(callee))
                continue;
            GraphModels.Node calleeNode = g.nodes.get(callee);
            int calleeLine = line;
            int calleeEndLine = endLine;
            if (calleeNode != null && calleeNode.lineStart > 0) {
                calleeLine = calleeNode.lineStart;
                calleeEndLine = calleeNode.lineEnd;
            } else {
                var calleeLoc = locator.resolveMethod(callee);
                if (calleeLoc.isPresent()) {
                    var calleeDecl = calleeLoc.get().decl();
                    calleeLine = calleeDecl.getRange().map(r -> r.begin.line).orElse(line);
                    calleeEndLine = calleeDecl.getRange().map(r -> r.end.line).orElse(endLine);
                    ensureNodeFromDecl(g, calleeLoc.get(), facade);
                }
            }
            g.addEdge(callee, impl, "override", calleeLine, calleeEndLine);
            debug("CHA addEdge from=" + callee + " to=" + impl + " (override)");
            if (locator.resolveMethod(impl).isPresent())
                enqueue.accept(impl);
        }
    }
}
