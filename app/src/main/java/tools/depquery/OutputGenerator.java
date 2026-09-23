package tools.depquery;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;
import java.nio.file.*;
import java.util.*;

import static tools.depquery.DiagnosticLogger.*;
import static tools.depquery.FqnUtils.*;

/**
 * JSON / CallCanvas 形式の出力生成ユーティリティ
 */
class OutputGenerator {

    static JSONObject toJson(GraphModels.Graph g, List<Path> srcRoots, Path workspace) {
        var out = new JSONObject();
        var ns = new JSONArray();
        g.nodes.values().forEach(n -> ns.put(new JSONObject()
                .put("id", n.id).put("display", n.display).put("class", n.classFqn)
                .put("name", n.name).put("params_fqn", n.paramsFqn)
                .put("file", toRelativePath(n.file, srcRoots, workspace))
                .put("line_start", n.lineStart).put("line_end", n.lineEnd)
                .put("annotations", n.annotations).put("stereotype", n.stereotype)));
        var es = new JSONArray();
        g.edges.forEach(e -> es.put(new JSONObject()
                .put("from", e.from).put("to", e.to).put("kind", e.kind).put("callsite_line", e.callLine).put("callsite_line_end", e.callEndLine)));
        var ur = new JSONArray();
        g.unresolved.forEach(u -> ur.put(new JSONObject()
                .put("from", u.from).put("expr", u.expr).put("line", u.line).put("reason", u.reason)));
        out.put("nodes", ns).put("links", es).put("unresolved", ur);
        return out;
    }

    /**
     * ノードにコード内容を設定する
     */
    static void populateCodeForNodes(GraphModels.Graph g, List<Path> srcRoots) {
        for (var node : g.nodes.values()) {
            if (node.lineStart < 0 || node.lineEnd < 0 || "-".equals(node.file)) {
                continue;
            }
            try {
                Path filePath = resolveFilePath(node.file, srcRoots);
                if (filePath != null && Files.exists(filePath)) {
                    List<String> lines = Files.readAllLines(filePath);
                    int start = Math.max(0, node.lineStart - 1);
                    int end = Math.min(lines.size(), node.lineEnd);
                    if (start < end) {
                        node.setCode(String.join("\n", lines.subList(start, end)));
                    }
                }
            } catch (IOException e) {
                // コード取得に失敗しても続行
            }
        }
    }

    /**
     * ファイルパスを解決する（絶対パスまたは相対パスから実際のパスを取得）
     */
    static Path resolveFilePath(String file, List<Path> srcRoots) {
        Path p = Path.of(file);
        if (Files.exists(p)) {
            return p;
        }
        // srcRoots からの相対パスとして探す
        for (Path root : srcRoots) {
            Path candidate = root.resolve(file);
            if (Files.exists(candidate)) {
                return candidate;
            }
        }
        return null;
    }

    /** 行が JEP 467 のマークダウン Javadoc（/// 始まり）かどうか。 */
    private static boolean isMarkdownDocLine(String trimmed) {
        return trimmed.startsWith("///");
    }

    /**
     * メソッド直上の Javadoc/コメントの先頭行（1-based）を返す。
     * 検出する形式は次の3つ:
     *   - 従来のブロック Javadoc（/ と * で始まり * と / で終わる形式）
     *   - マークダウン Javadoc（Java 23 / JEP 467 の /// 行の連続）
     *   - 連続する // 行（通常の行コメント）
     * 該当しなければ methodStart1Based を返す。
     */
    static int findCommentStartLine(List<String> lines, int methodStart1Based) {
        if (methodStart1Based <= 1 || lines == null || lines.isEmpty()) {
            return methodStart1Based;
        }
        if (methodStart1Based > lines.size()) {
            return methodStart1Based;
        }
        int i = methodStart1Based - 2; // 0-based: メソッド直上の行
        while (i >= 0 && lines.get(i).trim().isEmpty()) {
            i--;
        }
        if (i < 0) {
            return methodStart1Based;
        }
        String trimmed = lines.get(i).trim();
        // マークダウン Javadoc /// の連続。
        // ブロック Javadoc の直上にある // は窓に含めないのと揃えるため、
        // /// の連なりが途切れた時点で止める（手前の素の // は含めない）。
        if (isMarkdownDocLine(trimmed)) {
            int j = i;
            while (j >= 0 && isMarkdownDocLine(lines.get(j).trim())) {
                j--;
            }
            return j + 2; // 先頭の /// 行の 1-based
        }
        // ブロックコメント終端 */ の直上 → 先頭 /** を逆順で探索
        if (trimmed.contains("*/")) {
            for (int j = i; j >= 0; j--) {
                if (lines.get(j).trim().startsWith("/**")) {
                    return j + 1;
                }
            }
            return methodStart1Based;
        }
        // 単行コメント // の連続
        if (trimmed.startsWith("//")) {
            int j = i;
            while (j >= 0 && lines.get(j).trim().startsWith("//")) {
                j--;
            }
            return j + 2; // 先頭の // 行の 1-based
        }
        return methodStart1Based;
    }

    /**
     * ファイルから指定行範囲のソースコードを取得（高速版）
     * JavaParserを使わず、純粋なファイルI/Oのみ（1ファイル 0.5〜2ms）
     */
    static String extractSourceCode(Path filePath, int startLine, int endLine) {
        try {
            List<String> lines = Files.readAllLines(filePath);
            int start = Math.max(0, startLine - 1);
            int end = Math.min(lines.size(), endLine);
            if (start >= end || start >= lines.size()) {
                return "// Source not available (invalid line range)";
            }
            return String.join("\n", lines.subList(start, end));
        } catch (IOException e) {
            return "// Source not available: " + e.getMessage();
        }
    }

    /**
     * 相対パスまたは絶対パスを絶対パスに解決
     */
    static Path resolveAbsolutePath(String filePath, List<Path> srcRoots, Path workspace) {
        if (filePath == null || "-".equals(filePath)) {
            return null;
        }

        Path path = Path.of(filePath);

        // 既に絶対パスの場合
        if (path.isAbsolute()) {
            return Files.exists(path) ? path : null;
        }

        // ワークスペースからの相対パス
        if (workspace != null) {
            Path resolved = workspace.resolve(filePath);
            if (Files.exists(resolved)) {
                return resolved;
            }
        }

        // srcRoots からの相対パス
        for (Path root : srcRoots) {
            Path resolved = root.resolve(filePath);
            if (Files.exists(resolved)) {
                return resolved;
            }
            // src/main/java の親ディレクトリからも試す
            Path parent = root.getParent();
            if (parent != null) {
                parent = parent.getParent();
                if (parent != null) {
                    parent = parent.getParent();
                    if (parent != null) {
                        resolved = parent.resolve(filePath);
                        if (Files.exists(resolved)) {
                            return resolved;
                        }
                    }
                }
            }
        }

        return null;
    }

    /**
     * ファイルパスをワークスペースまたは srcRoot からの相対パスに変換する
     */
    static String toRelativePath(String absolutePath, List<Path> srcRoots, Path workspace) {
        if (absolutePath == null || "-".equals(absolutePath)) {
            return absolutePath;
        }

        Path path = Path.of(absolutePath);

        // 既に相対パスの場合はそのまま返す（二重変換防止）
        if (!path.isAbsolute()) {
            return absolutePath;
        }

        Path absPath = path.toAbsolutePath().normalize();

        // ワークスペースが指定されている場合は、そこからの相対パスを返す
        if (workspace != null) {
            Path absWorkspace = workspace.toAbsolutePath().normalize();
            if (absPath.startsWith(absWorkspace)) {
                return absWorkspace.relativize(absPath).toString();
            }
        }

        // フォールバック: srcRoot からの相対パス
        for (Path root : srcRoots) {
            Path absRoot = root.toAbsolutePath().normalize();
            if (absPath.startsWith(absRoot)) {
                // src/main/java の親ディレクトリ（プロジェクトルート）からの相対パスを返す
                Path projectRoot = absRoot.getParent().getParent().getParent();
                if (projectRoot != null && absPath.startsWith(projectRoot)) {
                    return projectRoot.relativize(absPath).toString();
                }
                return absRoot.relativize(absPath).toString();
            }
        }
        return absolutePath;
    }

    /**
     * CallCanvas 形式の JSON を生成する
     * ソースが利用できないノード（標準ライブラリ等）は除外する
     * ただし、ソースなし中間ノードを経由した接続は親から孫へ直接接続を追加する
     */
    static JSONObject toCallCanvasJson(GraphModels.Graph g, List<Path> srcRoots, List<String> rootFqns,
            Path workspace, int windowWidth,
            Map<String, CallIndexModels.ConstantEntry> symbolIndex) {
        long callcanvasStart = System.currentTimeMillis();
        var out = new JSONObject();
        out.put("autoLayout", true);

        // パス1: 出力に含まれるノードIDを先に収集（ソースがあるもののみ）
        Set<String> includedNodeIds = new HashSet<>();
        // エッジで接続されているノードIDを収集（孤立ノード除外のため）
        Set<String> connectedNodeIds = new HashSet<>();
        for (var edge : g.edges) {
            connectedNodeIds.add(edge.from);
            connectedNodeIds.add(edge.to);
        }
        // ルートノードIDを収集（エッジなしでも常に含める）
        Set<String> rootNodeIds = new HashSet<>(rootFqns);

        for (var node : g.nodes.values()) {
            // ファイルパスと行番号が有効で、かつエッジで接続されているか、ルートノードである場合のみ含める
            if (node.file != null && !node.file.equals("-") && node.lineStart > 0
                    && (connectedNodeIds.contains(node.id) || rootNodeIds.contains(node.id))) {
                includedNodeIds.add(node.id);
            }
        }

        // パス1.5: ソースなしノードを経由した接続を解決するための準備
        // 各ノードへの入力エッジを構築（親ノードを探すため）
        Map<String, Set<String>> incomingNodes = new HashMap<>();
        for (var edge : g.edges) {
            incomingNodes.computeIfAbsent(edge.to, k -> new HashSet<>()).add(edge.from);
        }

        var windows = new JSONArray();
        Map<String, String> nodeIdToWindowId = new HashMap<>();
        int windowIndex = 1;
        int sourceCodeFileCount = 0;
        long sourceCodeStart = System.currentTimeMillis();
        Map<Path, List<String>> fileLinesCache = new HashMap<>();

        // パス2: ノード（windows）を生成
        for (var node : g.nodes.values()) {
            // ソースが利用できないノードは除外
            if (!includedNodeIds.contains(node.id)) {
                continue;
            }

            String windowId = "window-" + windowIndex++;
            nodeIdToWindowId.put(node.id, windowId);

            var window = new JSONObject();
            window.put("id", windowId);

            // displayName: ClassName # methodName 形式（視認性向上のためスペース追加）
            String className = node.classFqn;
            if (className != null && className.contains(".")) {
                className = className.substring(className.lastIndexOf('.') + 1);
            }
            window.put("displayName", className + " # " + node.name);

            window.put("filePath", toRelativePath(node.file, srcRoots, workspace));

            // ソースコードを行番号ベースで取得（Javadoc 含む）
            String code;
            if (node.code != null && !node.code.isEmpty()) {
                // 既にcodeがある場合（旧形式のサポート）
                code = node.code;
                window.put("startLine", node.lineStart > 0 ? node.lineStart : 1);
            } else {
                Path absoluteFilePath = resolveAbsolutePath(node.file, srcRoots, workspace);
                if (absoluteFilePath != null) {
                    List<String> lines = fileLinesCache.get(absoluteFilePath);
                    if (lines == null) {
                        try {
                            lines = Files.readAllLines(absoluteFilePath);
                            fileLinesCache.put(absoluteFilePath, lines);
                        } catch (IOException e) {
                            // キャッシュせずフォールバック
                        }
                    }
                    if (lines != null) {
                        int docStart = findCommentStartLine(lines, node.lineStart);
                        int end = Math.min(lines.size(), node.lineEnd);
                        if (docStart <= end) {
                            code = String.join("\n", lines.subList(docStart - 1, end));
                            window.put("startLine", docStart);
                        } else {
                            code = extractSourceCode(absoluteFilePath, node.lineStart, node.lineEnd);
                            window.put("startLine", node.lineStart > 0 ? node.lineStart : 1);
                        }
                        sourceCodeFileCount++;
                    } else {
                        code = extractSourceCode(absoluteFilePath, node.lineStart, node.lineEnd);
                        window.put("startLine", node.lineStart > 0 ? node.lineStart : 1);
                        sourceCodeFileCount++;
                    }
                } else {
                    code = "// Source not available (file not found)";
                    window.put("startLine", node.lineStart > 0 ? node.lineStart : 1);
                }
            }
            window.put("code", code);

            // 位置は autoLayout で自動計算されるが、初期位置を設定
            // レベル間の間隔はウィンドウ幅 + 100pxのギャップ
            int levelWidth = windowWidth + 100;
            var position = new JSONObject();
            position.put("top", 40);
            position.put("left", 40 + ((windowIndex - 2) % 3) * levelWidth);
            position.put("width", windowWidth);
            position.put("height", 320);
            window.put("position", position);

            windows.put(window);
        }
        long sourceCodeTime = System.currentTimeMillis() - sourceCodeStart;
        out.put("windows", windows);

        if (DEBUG) {
            debugTimed("Source code extraction in " + sourceCodeTime + "ms (" + sourceCodeFileCount + " files)");
        }

        // 接続（connections）を生成
        var connections = new JSONArray();
        Set<String> addedConnections = new HashSet<>();

        // callLine を優先しつつ、元のエッジ列挙順も保持した安定ソートを実施
        List<GraphModels.Edge> sortedEdges = new ArrayList<>(g.edges);
        Map<GraphModels.Edge, Integer> edgeIndex = new IdentityHashMap<>();
        for (int i = 0; i < g.edges.size(); i++) {
            edgeIndex.put(g.edges.get(i), i);
        }
        sortedEdges.sort((e1, e2) -> {
            int fromComp = e1.from.compareTo(e2.from);
            if (fromComp != 0)
                return fromComp;
            // callLine が 0 以下なら大きな値にシフトして末尾へ
            int l1 = e1.callLine > 0 ? e1.callLine : Integer.MAX_VALUE / 2 + edgeIndex.get(e1);
            int l2 = e2.callLine > 0 ? e2.callLine : Integer.MAX_VALUE / 2 + edgeIndex.get(e2);
            if (l1 != l2)
                return Integer.compare(l1, l2);
            return Integer.compare(edgeIndex.get(e1), edgeIndex.get(e2));
        });

        for (var edge : sortedEdges) {
            String fromId = edge.from;
            String toId = edge.to;

            // ケース1: 両端がソースあり → 通常の接続
            if (includedNodeIds.contains(fromId) && includedNodeIds.contains(toId)) {
                addConnection(connections, addedConnections, nodeIdToWindowId, fromId, toId, edge.callLine, edge.callEndLine);
                continue;
            }

            // ケース2: 終点がソースありで起点がソースなし
            // → 起点を呼び出しているソースありノードから直接接続を追加
            if (!includedNodeIds.contains(fromId) && includedNodeIds.contains(toId)) {
                Set<String> ancestors = findSourcedAncestors(fromId, includedNodeIds, incomingNodes, new HashSet<>());
                for (String ancestor : ancestors) {
                    addConnection(connections, addedConnections, nodeIdToWindowId, ancestor, toId, edge.callLine, edge.callEndLine);
                }
            }
        }
        out.put("connections", connections);

        if (symbolIndex != null && !symbolIndex.isEmpty()) {
            var symObj = new JSONObject();
            symbolIndex.forEach((k, e) -> symObj.put(k, e.toJson()));
            out.put("symbolIndex", symObj);
        }

        long callcanvasTime = System.currentTimeMillis() - callcanvasStart;
        if (DEBUG) {
            debugTimed("JSON output generated in " + callcanvasTime + "ms");
        }

        return out;
    }

    /**
     * ソースなしノードの祖先で、ソースがあるノードを再帰的に探す
     */
    static Set<String> findSourcedAncestors(
            String nodeId,
            Set<String> includedNodeIds,
            Map<String, Set<String>> incomingNodes,
            Set<String> visited) {

        Set<String> result = new HashSet<>();
        if (visited.contains(nodeId))
            return result;
        visited.add(nodeId);

        Set<String> parents = incomingNodes.get(nodeId);
        if (parents == null)
            return result;

        for (String parent : parents) {
            if (includedNodeIds.contains(parent)) {
                // 親がソースあり → この親を結果に追加
                result.add(parent);
            } else {
                // 親もソースなし → さらに上の祖先を探す
                result.addAll(findSourcedAncestors(parent, includedNodeIds, incomingNodes, visited));
            }
        }

        return result;
    }

    /**
     * 接続を追加（重複チェック付き）
     */
    static void addConnection(
            JSONArray connections,
            Set<String> addedConnections,
            Map<String, String> nodeIdToWindowId,
            String fromId,
            String toId,
            int callLine,
            int callEndLine) {

        String fromWindowId = nodeIdToWindowId.get(fromId);
        String toWindowId = nodeIdToWindowId.get(toId);

        if (fromWindowId != null && toWindowId != null) {
            // callLineを含めて重複チェック（同じウィンドウ間でも異なる行からの呼び出しは別接続として許可）
            String connKey = fromWindowId + "->" + toWindowId + "@" + callLine;
            if (!addedConnections.contains(connKey)) {
                var conn = new JSONObject();
                conn.put("from", fromWindowId);
                conn.put("to", toWindowId);
                if (callLine > 0) {
                    conn.put("callLine", callLine);
                    conn.put("callEndLine", callEndLine);
                }
                connections.put(conn);
                addedConnections.add(connKey);
            }
        }
    }
}
