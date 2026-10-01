package tools.depquery;

import tools.depquery.CallIndexModels.*;

import java.util.List;

/**
 * GraphModels.Node 生成ユーティリティ
 */
class NodeFactory {

    /**
     * インデックスのMethodEntryから直接Nodeを構築（パースなし・型解決なし）
     */
    static void createNodeFromEntry(GraphModels.Graph g, MethodEntry entry) {
        GraphModels.Node existing = g.nodes.get(entry.fqn);
        if (existing != null && existing.lineStart > 0) {
            return;
        }

        String display = entry.display != null ? entry.display : entry.fqn;
        String classFqn = entry.classFqn != null ? entry.classFqn : "Unknown";
        String methodName = entry.methodName != null ? entry.methodName : "unknown";
        List<String> paramsFqn = entry.paramsFqn != null ? entry.paramsFqn : List.of();
        List<String> annotations = entry.annotations != null ? entry.annotations : List.of();
        String stereotype = entry.stereotype != null ? entry.stereotype : "Component";

        var node = new GraphModels.Node(
            entry.fqn,
            display,
            classFqn,
            methodName,
            paramsFqn,
            entry.file,
            entry.lineStart,
            entry.lineEnd,
            annotations,
            stereotype
        );
        if (entry.refs != null) node.refs = entry.refs;
        g.addOrUpdateNode(node);
    }

    /**
     * Indexにないメソッドのスタブノードを作成（外部ライブラリ等）
     */
    static void createStubNode(GraphModels.Graph g, String fqn) {
        if (g.nodes.containsKey(fqn)) {
            return;
        }

        int hashPos = fqn.indexOf('#');
        String classFqn = hashPos > 0 ? fqn.substring(0, hashPos) : "Unknown";
        String simpleClass = classFqn.contains(".")
            ? classFqn.substring(classFqn.lastIndexOf('.') + 1)
            : classFqn;
        int parenPos = fqn.indexOf('(', hashPos);
        String methodName = hashPos > 0 && parenPos > hashPos
            ? fqn.substring(hashPos + 1, parenPos)
            : "unknown";

        String display = simpleClass + "." + methodName + "(...)  [external]";
        var node = new GraphModels.Node(
            fqn,
            display,
            classFqn,
            methodName,
            List.of(),
            "-",
            -1,
            -1,
            List.of(),
            "External"
        );
        g.addOrUpdateNode(node);
    }

    static boolean acceptByFilter(String callee, AnalyzerConfig cfg) {
        String classPart = callee.contains("#") ? callee.substring(0, callee.indexOf('#')) : callee;
        boolean inc = cfg.includePatterns.isEmpty() ||
                      cfg.includePatterns.stream().anyMatch(p -> p.matcher(classPart).matches());
        boolean exc = cfg.excludePatterns.stream().anyMatch(p -> p.matcher(classPart).matches());
        return inc && !exc;
    }
}
