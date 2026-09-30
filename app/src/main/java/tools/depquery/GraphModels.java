package tools.depquery;

import java.util.*;

public class GraphModels {

    public static class Node {
        public final String id;
        public String display;
        public final String classFqn;
        public final String name;
        public final List<String> paramsFqn;
        public final String file;
        public final int lineStart;
        public final int lineEnd;
        public final List<String> annotations;
        public final String stereotype;
        public String code; // メソッドのソースコード
        /** 本体内のフィールド参照（CallIndexModels.FieldRef の符号化文字列） */
        public List<String> fieldRefs = List.of();

        public Node(String id, String display, String classFqn, String name, List<String> paramsFqn,
                String file, int lineStart, int lineEnd, List<String> annotations, String stereotype) {
            this.id = id;
            this.display = display;
            this.classFqn = classFqn;
            this.name = name;
            this.paramsFqn = paramsFqn;
            this.file = file;
            this.lineStart = lineStart;
            this.lineEnd = lineEnd;
            this.annotations = annotations;
            this.stereotype = stereotype;
            this.code = null;
        }

        public void setCode(String code) {
            this.code = code;
        }
    }

    public static class Edge {
        public final String from, to, kind;
        public final int callLine;
        public final int callEndLine;

        public Edge(String from, String to, String kind, int callLine, int callEndLine) {
            this.from = from;
            this.to = to;
            this.kind = kind;
            this.callLine = callLine;
            this.callEndLine = callEndLine;
        }
    }

    public static class Unresolved {
        public final String from, expr, reason;
        public final int line;

        public Unresolved(String from, String expr, int line, String reason) {
            this.from = from;
            this.expr = expr;
            this.line = line;
            this.reason = reason;
        }
    }

    public static class Graph {
        public final Map<String, Node> nodes = new LinkedHashMap<>();
        public final List<Edge> edges = new ArrayList<>();
        public final List<Unresolved> unresolved = new ArrayList<>();

        public void addOrUpdateNode(Node n) {
            nodes.put(n.id, n);
        }

        public void addEdge(String from, String to, String kind, int line, int endLine) {
            edges.add(new Edge(from, to, kind, line, endLine));
        }

        public void addUnresolved(String from, String expr, int line, String reason) {
            unresolved.add(new Unresolved(from, expr, line, reason));
        }
    }
}
