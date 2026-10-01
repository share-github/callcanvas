package tools.depquery;

import java.util.*;

import static tools.depquery.DiagnosticLogger.*;
import static tools.depquery.NodeFactory.*;
import tools.depquery.CallIndexModels.*;

/**
 * BFS呼び出しグラフ走査・エッジ収集
 *
 * <p>呼び出し関係は常に {@link CallIndex} から引く。インデックスが無い解析では
 * {@link OnDemandIndexer} が必要な範囲だけ JDT で解析して作った CallIndex を渡す。
 */
class CallGraphAnalyzer {

    /** --depth -1（ルートまで）の incoming で辿る階層の安全上限 */
    static final int MAX_INCOMING_DEPTH = 50;

    record Item(String fqn, int depth) {
    }

    /**
     * Outgoing calls: ルートから呼び出し先を BFS で辿る
     *
     * @return 展開したメソッド数
     */
    static int collectOutgoingCalls(GraphModels.Graph graph, AnalyzerConfig cfg, CallIndex callIndex,
            List<String> roots) {
        var visited = new HashSet<String>();
        var q = new ArrayDeque<Item>();
        for (String root : roots) q.add(new Item(root, 0));
        int methodsFromIndex = 0;

        while (!q.isEmpty()) {
            var it = q.removeFirst();
            if (!visited.add(it.fqn) || it.depth > cfg.depth)
                continue;

            MethodEntry indexedMethod = callIndex.getMethod(it.fqn);
            if (indexedMethod == null)
                continue;
            debug("Using index for: " + it.fqn);
            methodsFromIndex++;

            // インデックスから現在のノードを構築（メタデータ使用）
            createNodeFromEntry(graph, indexedMethod);

            // インデックスから呼び出し先を取得
            // 【順序前提】calleesリストは CallIndexBuilder#addCallees により、
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
                    // CallCanvas Viewer の F12 は接続の callLine とウィンドウ内の行番号の一致でジャンプするので、
                    // 宣言が分かれば親メソッドの宣言行を使う
                    MethodEntry interfaceEntry = callIndex.getMethod(lastCallTargetFqn);
                    int overrideCallLine = calleeRef.line;
                    int overrideCallEndLine = calleeRef.endLine;
                    if (interfaceEntry != null && interfaceEntry.lineStart > 0) {
                        overrideCallLine = interfaceEntry.lineStart;
                        overrideCallEndLine = interfaceEntry.lineEnd;
                    }
                    graph.addEdge(lastCallTargetFqn, calleeRef.fqn, "override",
                                overrideCallLine, overrideCallEndLine);
                } else {
                    // Normal call: caller -> callee
                    graph.addEdge(it.fqn, calleeRef.fqn, calleeRef.type,
                                calleeRef.line, calleeRef.endLine);
                }

                // 呼び出し先のノードを追加（メタデータ使用）
                MethodEntry calleeEntry = callIndex.getMethod(calleeRef.fqn);
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
        }
        return methodsFromIndex;
    }

    /**
     * Incoming calls: ターゲットメソッド（グラフに追加済みのノード）の呼び出し元を BFS で辿る
     *
     * @param maxDepth 呼び出し元を辿る階層数
     */
    static void collectIncomingCalls(GraphModels.Graph g, AnalyzerConfig cfg, CallIndex callIndex, int maxDepth) {
        // ターゲットメソッド（グラフに既に追加されているノード）
        Set<String> targetMethods = new HashSet<>(g.nodes.keySet());
        if (targetMethods.isEmpty()) {
            return;
        }

        debug("Incoming calls: searching for callers of " + targetMethods.size() + " target methods");
        debug("Effective max depth: " + maxDepth + " (cfg.depth=" + cfg.depth + ")");
        int callersFound = 0;

        // BFSキュー: (メソッドFQN, 現在の深さ)
        record BfsEntry(String fqn, int depth) {}
        Queue<BfsEntry> queue = new LinkedList<>();
        Set<String> visited = new HashSet<>(targetMethods);
        for (String target : targetMethods) {
            queue.add(new BfsEntry(target, 0));
        }

        while (!queue.isEmpty()) {
            BfsEntry entry = queue.poll();
            MethodEntry indexedMethod = callIndex.getMethod(entry.fqn);
            if (indexedMethod == null) continue;

            for (CallRef callerRef : indexedMethod.callers) {
                if (!acceptByFilter(callerRef.fqn, cfg))
                    continue;

                // 呼び出し元のノードを先に追加
                MethodEntry callerEntry = callIndex.getMethod(callerRef.fqn);
                if (callerEntry != null) {
                    createNodeFromEntry(g, callerEntry);
                }

                g.addEdge(callerRef.fqn, entry.fqn, callerRef.type,
                        callerRef.line, callerRef.endLine);
                callersFound++;

                // BFS: 未訪問かつ深さ上限内なら次の探索候補に追加
                // depth=N means N levels of callers; entry.depth+1 is the next level
                if (!visited.contains(callerRef.fqn) && (entry.depth + 1) <= maxDepth) {
                    visited.add(callerRef.fqn);
                    queue.add(new BfsEntry(callerRef.fqn, entry.depth + 1));
                }
            }
        }

        info("[INFO] Found " + callersFound + " callers (BFS, maxDepth=" + maxDepth + ")");
    }
}
