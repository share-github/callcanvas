package tools.depquery;

import java.util.*;
import java.util.stream.Collectors;
import java.util.Comparator;

public class MermaidEmitters {

    private MermaidEmitters() {
        // ユーティリティクラス
    }

    public static String methodGraph(GraphModels.Graph g) {
        StringBuilder sb = new StringBuilder();
        sb.append("graph LR\n");
        sb.append("  classDef Controller fill:#eef,stroke:#99f;\n");
        sb.append("  classDef Service fill:#efe,stroke:#9f9;\n");
        sb.append("  classDef Repository fill:#fee,stroke:#f99;\n");

        Map<String, String> idMap = new HashMap<>();
        int i = 0;
        for (var n : g.nodes.values()) {
            String id = "N" + (i++);
            idMap.put(n.id, id);
            sb.append("  ").append(id).append("[\"").append(escape(n.display)).append("\"]\n");
            sb.append("  ").append("class ").append(id).append(" ").append(n.stereotype).append("\n");
        }
        for (var e : g.edges) {
            String from = idMap.getOrDefault(e.from, "X");
            String to = idMap.getOrDefault(e.to, "Y");
            String label = "L" + e.callLine;
            String style = switch (e.kind) {
                case "ctor" -> "-->|ctor " + label + "|";
                case "method-ref" -> "-->|ref " + label + "|";
                default -> "-->|" + label + "|";
            };
            sb.append("  ").append(from).append(" ").append(style).append(" ").append(to).append("\n");
        }
        return sb.toString();
    }

    public static String sequenceFromGraph(GraphModels.Graph g, List<String> roots) {
        // 超簡易：root から出る最初の2–3呼出を時系列に並べるデモ
        String root = roots.isEmpty() ? null : roots.get(0);
        if (root == null || !g.nodes.containsKey(root))
            return "sequenceDiagram\n  participant A as (no root)\n";

        var out = new StringBuilder("sequenceDiagram\n");
        // 参加者（root と直接の下流）
        var rootNode = g.nodes.get(root);
        out.append("  participant R as ").append(rootNode.display).append("\n");
        var downs = g.edges.stream().filter(e -> e.from.equals(root)).limit(3).toList();
        int idx = 0;
        for (var e : downs) {
            var n = g.nodes.get(e.to);
            if (n == null)
                continue;
            char p = (char) ('A' + idx);
            out.append("  participant ").append(p).append(" as ").append(n.display).append("\n");
            out.append("  R->>").append(p).append(": call (").append("L").append(e.callLine).append(")\n");
            idx++;
        }
        return out.toString();
    }

    public static String indexTable(GraphModels.Graph g) {
        StringBuilder sb = new StringBuilder();
        sb.append("| Label | FQN | File | Lines |\n|---|---|---|---|\n");
        for (var n : g.nodes.values()) {
            String lines = (n.lineStart >= 0 ? n.lineStart : "?") + "–" + (n.lineEnd >= 0 ? n.lineEnd : "?");
            sb.append("| ").append(escape(n.display)).append(" | ")
                    .append(escape(n.id)).append(" | ")
                    .append(escape(n.file)).append(" | ")
                    .append(lines).append(" |\n");
        }
        return sb.toString();
    }

    public static String callHierarchyTree(GraphModels.Graph g, List<String> roots) {
        StringBuilder sb = new StringBuilder();
        Set<String> visited = new HashSet<>();

        for (String rootFqn : roots) {
            if (!g.nodes.containsKey(rootFqn)) {
                continue;
            }
            var rootNode = g.nodes.get(rootFqn);
            // ルートメソッドの表示名を生成（シンプルな形式）
            String rootDisplay = simplifyMethodDisplay(rootNode);
            sb.append(rootDisplay).append("\n");

            // ルートから出ているエッジを取得
            var edges = g.edges.stream()
                    .filter(e -> e.from.equals(rootFqn))
                    .sorted(Comparator.comparingInt(e -> e.callLine))
                    .toList();

            visited.clear();
            visited.add(rootFqn);

            for (int i = 0; i < edges.size(); i++) {
                boolean isLast = (i == edges.size() - 1);
                printTreeNode(sb, g, edges.get(i), "", isLast, visited, 1);
            }

            sb.append("\n");
        }

        return sb.toString();
    }

    private static void printTreeNode(StringBuilder sb, GraphModels.Graph g,
            GraphModels.Edge edge, String prefix, boolean isLast, Set<String> visited, int depth) {

        // 深さ制限（無限ループ防止）
        if (depth > 10) {
            return;
        }

        String connector = isLast ? "└─ " : "├─ ";
        sb.append(prefix).append(connector);

        var node = g.nodes.get(edge.to);
        if (node == null) {
            sb.append(edge.to).append("\n");
            return;
        }

        String display = simplifyMethodDisplay(node);
        sb.append(display);

        // このノードから更に呼び出しがあるかチェック
        var childEdges = g.edges.stream()
                .filter(e -> e.from.equals(edge.to))
                .sorted(Comparator.comparingInt(e -> e.callLine))
                .toList();

        // 循環参照チェック
        if (visited.contains(edge.to)) {
            if (!childEdges.isEmpty()) {
                sb.append(" (循環参照)");
            }
            sb.append("\n");
            return;
        }

        if (childEdges.isEmpty()) {
            sb.append("\n");
        } else if (childEdges.size() == 1) {
            // 1つだけの場合は → でつなぐ
            sb.append(" → ");
            visited.add(edge.to);
            printInlineChain(sb, g, childEdges.get(0), visited, depth + 1);
        } else {
            // 複数の場合は改行してツリー表示
            sb.append("\n");
            visited.add(edge.to);
            String newPrefix = prefix + (isLast ? "   " : "│  ");
            for (int i = 0; i < childEdges.size(); i++) {
                boolean isChildLast = (i == childEdges.size() - 1);
                printTreeNode(sb, g, childEdges.get(i), newPrefix, isChildLast, visited, depth + 1);
            }
            visited.remove(edge.to);
        }
    }

    private static void printInlineChain(StringBuilder sb, GraphModels.Graph g,
            GraphModels.Edge edge, Set<String> visited, int depth) {

        if (depth > 10) {
            return;
        }

        var node = g.nodes.get(edge.to);
        if (node == null) {
            sb.append(edge.to).append("\n");
            return;
        }

        String display = simplifyMethodDisplay(node);
        sb.append(display);

        var childEdges = g.edges.stream()
                .filter(e -> e.from.equals(edge.to))
                .sorted(Comparator.comparingInt(e -> e.callLine))
                .toList();

        if (visited.contains(edge.to)) {
            sb.append(" (循環)");
            sb.append("\n");
            return;
        }

        if (childEdges.isEmpty()) {
            sb.append("\n");
        } else if (childEdges.size() == 1) {
            sb.append(" → ");
            visited.add(edge.to);
            printInlineChain(sb, g, childEdges.get(0), visited, depth + 1);
            visited.remove(edge.to);
        } else {
            // 複数ある場合はここで改行して展開
            sb.append("\n");
        }
    }

    private static String simplifyMethodDisplay(GraphModels.Node node) {
        // クラス名.メソッド名() の形式で表示
        String className = node.classFqn;
        if (className.contains(".")) {
            className = className.substring(className.lastIndexOf('.') + 1);
        }

        String methodName = node.name;

        // コンストラクタの場合
        if (methodName.equals(className)) {
            return "new " + className + "()";
        }

        // 通常のメソッド
        return className + "." + methodName + "()";
    }

    private static String escape(String s) {
        return s.replace("|", "\\|");
    }
}
