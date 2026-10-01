package tools.depquery;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import tools.depquery.CallIndexModels.*;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;

import static tools.depquery.DiagnosticLogger.*;

/**
 * 変更集合キャンバス（Change Set Canvas）の Java ブロックを作る（{@code --changed-methods <input.json>}）。
 *
 * <p>入力は変更ファイルと hunk の一覧（git 操作は呼び出し側が行う。形式は app/README.md の
 * 「変更集合の入力」）。hunk を呼び出しインデックスのメソッド行範囲に当てて変更メソッド（種）を決め、
 * 下向きの直接到達か上向きの共通の祖先でつながる種を島にまとめる。決まりは viewer README の
 * 「変更集合キャンバス」節（島の決め方）のとおり。経路上の未変更の中継は経路長にかかわらず
 * すべて via ウィンドウにして実線で順に結ぶ。上向きは既存の呼び出し元解析（「ルートまで解析」）と同じ
 * {@link CallGraphAnalyzer#collectIncomingCalls} で辿る。出力は groups / windows /
 * connections / symbols と metadata.changeSet の Java 分（files）。
 */
class ChangeSetAnalyzer {

    static final String JAVA_BLOCK_ID = "blk-java";
    static final String OUTPUT_FILE_NAME = "changeset-java.json";

    /** 利用者に見せるエラー（CLI は [ERROR] を付けて終了コード 2 で終わる） */
    static class ChangeSetException extends Exception {
        ChangeSetException(String message) {
            super(message);
        }
    }

    record Hunk(int oldStart, int oldCount, int newStart, int newCount, JSONObject json) {
        /** 新側で触れる行の範囲 [first, last]。削除だけの hunk は newStart と newStart+1 の間 */
        int first() {
            return newStart;
        }

        int last() {
            return newCount > 0 ? newStart + newCount - 1 : newStart + 1;
        }

        boolean touches(int start, int end) {
            if (newCount > 0) return newStart <= end && last() >= start;
            return start <= newStart && newStart + 1 <= end;
        }
    }

    static class InputFile {
        String path;
        String oldPath;
        String status;
        boolean worktreeMatches = true;
        boolean binary;
        List<Hunk> hunks = new ArrayList<>();
        Path abs;
        List<String> lines;
        final List<String> windowIds = new ArrayList<>();

        /** 呼び出しグラフに当てられないときの理由（当てられるなら null） */
        String reasonNotInGraph() {
            if ("deleted".equals(status)) return "deleted";
            if (binary) return "binary";
            if (!worktreeMatches) return "worktreeMismatch";
            return null;
        }
    }

    /** 変更メソッド（種） */
    static class Seed {
        final MethodEntry entry;
        final InputFile file;
        final int order;
        final List<Hunk> hunks = new ArrayList<>();

        Seed(MethodEntry entry, InputFile file, int order) {
            this.entry = entry;
            this.file = file;
            this.order = order;
        }
    }

    /** 島をつなぐ経路。path は呼び出し方向（path[0] が呼び出し側、末尾が呼ばれる種） */
    record Link(List<String> path, boolean junction, int cost, int far) {
        /** 中継（両端を除く未変更メソッド） */
        List<String> relays() {
            return path.subList(1, path.size() - 1);
        }
    }

    private final CallIndex index;
    private final AnalyzerConfig cfg;
    private final Path workspace;
    private final Map<String, List<String>> calleesCache = new HashMap<>();

    ChangeSetAnalyzer(CallIndex index, AnalyzerConfig cfg, Path workspace) {
        this.index = index;
        this.cfg = cfg;
        this.workspace = workspace;
    }

    // ===== 入口 =====

    static void run(AnalyzerConfig cfg) throws Exception {
        Path workspace = (cfg.workspace != null ? cfg.workspace : Paths.get(".")).toAbsolutePath().normalize();
        List<InputFile> files = readInput(cfg.changedMethodsPath, workspace);
        CallIndex index = loadIndex(workspace);
        checkIndexFresh(index, files);
        JSONObject out = new ChangeSetAnalyzer(index, cfg, workspace).analyze(files);
        Files.createDirectories(cfg.outDir);
        Path outPath = cfg.outDir.resolve(OUTPUT_FILE_NAME);
        Files.writeString(outPath, out.toString(2));
        protocol("[CHANGESET_FILE]" + outPath.toAbsolutePath());
        alwaysPrint("Wrote: " + outPath.toAbsolutePath());
    }

    static CallIndex loadIndex(Path workspace) throws ChangeSetException, IOException {
        CallIndexManager manager = new CallIndexManager(workspace);
        if (!manager.indexExists()) {
            throw new ChangeSetException("Call index not found under " + workspace.resolve(".callcanvas-cache")
                    + ". The change set canvas needs the call index: build it first (--build-index / \"Build Call Index\").");
        }
        CallIndex index = manager.loadIndex();
        if (index == null) {
            throw new ChangeSetException("Failed to load the call index. Rebuild it (--build-index / \"Build Call Index\").");
        }
        if (!CallIndex.CURRENT_VERSION.equals(index.version)) {
            throw new ChangeSetException("Call index version " + index.version + " is not supported (expected "
                    + CallIndex.CURRENT_VERSION + "). Rebuild it (--build-index / \"Build Call Index\").");
        }
        return index;
    }

    /** グラフに当てるファイルの内容がインデックス構築時と同じか（違うと hunk の行がずれる） */
    static void checkIndexFresh(CallIndex index, List<InputFile> files) throws ChangeSetException, IOException {
        Map<Path, String> hashes = new HashMap<>();
        index.fileHashes.forEach((k, v) -> hashes.put(Path.of(k).toAbsolutePath().normalize(), v));
        List<String> stale = new ArrayList<>();
        for (InputFile f : files) {
            if (f.reasonNotInGraph() != null) continue;
            String hash = hashes.get(f.abs);
            if (hash == null || !hash.equals(CallIndexManager.calculateFileHash(f.abs))) stale.add(f.path);
        }
        if (!stale.isEmpty()) {
            throw new ChangeSetException("Call index is out of date for " + String.join(", ", stale)
                    + ". Update it first (--build-index / \"Build Call Index\").");
        }
    }

    static List<InputFile> readInput(Path inputPath, Path workspace) throws ChangeSetException {
        JSONObject in;
        try {
            in = new JSONObject(Files.readString(inputPath, StandardCharsets.UTF_8));
        } catch (IOException | JSONException e) {
            throw new ChangeSetException("Cannot read change set input " + inputPath + ": " + e.getMessage());
        }
        List<InputFile> files = new ArrayList<>();
        try {
            JSONArray arr = in.getJSONArray("files");
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.getJSONObject(i);
                var f = new InputFile();
                f.path = o.getString("path");
                f.oldPath = o.optString("oldPath", null);
                f.status = o.getString("status");
                f.worktreeMatches = o.optBoolean("worktreeMatches", true);
                f.binary = o.optBoolean("binary", false);
                JSONArray hs = o.optJSONArray("hunks");
                if (hs != null) {
                    for (int j = 0; j < hs.length(); j++) {
                        JSONObject h = hs.getJSONObject(j);
                        f.hunks.add(new Hunk(h.getInt("oldStart"), h.getInt("oldCount"),
                                h.getInt("newStart"), h.getInt("newCount"), h));
                    }
                }
                Path p = Path.of(f.path);
                f.abs = (p.isAbsolute() ? p : workspace.resolve(p)).normalize();
                if (f.reasonNotInGraph() == null) {
                    if (!Files.isRegularFile(f.abs)) {
                        throw new ChangeSetException("Changed file not found in the working tree: " + f.abs);
                    }
                    f.lines = Files.readAllLines(f.abs);
                }
                files.add(f);
            }
        } catch (JSONException | IOException e) {
            throw new ChangeSetException("Invalid change set input " + inputPath + ": " + e.getMessage());
        }
        return files;
    }

    // ===== 解析 =====

    JSONObject analyze(List<InputFile> files) {
        Map<Path, List<MethodEntry>> methodsByFile = methodsByFile();
        Map<String, Seed> seeds = new LinkedHashMap<>();
        Map<InputFile, List<Hunk>> outsideHunks = new LinkedHashMap<>();

        // 1. hunk → 変更メソッド（種）。メソッドの範囲は直上の Javadoc/コメントから宣言の終わりまで
        for (InputFile f : files) {
            if (f.reasonNotInGraph() != null) continue;
            List<MethodEntry> methods = methodsByFile.getOrDefault(f.abs, List.of());
            for (Hunk h : f.hunks) {
                boolean hit = false;
                for (MethodEntry m : methods) {
                    int start = OutputGenerator.findCommentStartLine(f.lines, m.lineStart);
                    if (!h.touches(start, m.lineEnd)) continue;
                    hit = true;
                    seeds.computeIfAbsent(m.fqn, k -> new Seed(m, f, seeds.size())).hunks.add(h);
                }
                if (!hit) outsideHunks.computeIfAbsent(f, k -> new ArrayList<>()).add(h);
            }
        }

        // 2. 種どうしの連結（下向きの直接到達 → 上向きの共通の祖先）
        List<String> seedFqns = new ArrayList<>(seeds.keySet());
        Map<String, Integer> uf = new HashMap<>();
        for (String s : seedFqns) uf.put(s, uf.size());
        int[] parent = new int[seedFqns.size()];
        for (int i = 0; i < parent.length; i++) parent[i] = i;

        List<Link> links = new ArrayList<>();
        for (String s : seedFqns) {
            for (List<String> path : searchDown(s, seeds.keySet())) {
                links.add(new Link(path, false, path.size() - 1, path.size() - 1));
                union(parent, uf.get(s), uf.get(path.get(path.size() - 1)));
            }
        }
        Map<String, Map<String, String>> upChild = new HashMap<>();
        Map<String, Map<String, Integer>> upDist = new HashMap<>();
        for (String s : seedFqns) {
            Map<String, String> child = new HashMap<>();
            upDist.put(s, searchUp(s, seeds.keySet(), child));
            upChild.put(s, child);
        }
        // 共通の祖先の候補（最も近いものを 1 つ）を近い順に並べ、別の島どうしをつなぐものだけ採る
        record Candidate(String junction, String a, String b, int cost, int far) {
        }
        List<Candidate> candidates = new ArrayList<>();
        for (int i = 0; i < seedFqns.size(); i++) {
            for (int j = i + 1; j < seedFqns.size(); j++) {
                String a = seedFqns.get(i), b = seedFqns.get(j);
                Map<String, Integer> da = upDist.get(a), db = upDist.get(b);
                Candidate best = null;
                for (var e : da.entrySet()) {
                    String anc = e.getKey();
                    if (anc.equals(a) || !db.containsKey(anc) || anc.equals(b)) continue;
                    int x = e.getValue(), y = db.get(anc);
                    var c = new Candidate(anc, a, b, x + y, Math.max(x, y));
                    if (best == null || compare(c.cost, c.far, c.junction, best.cost, best.far, best.junction) < 0) {
                        best = c;
                    }
                }
                if (best != null) candidates.add(best);
            }
        }
        candidates.sort((c1, c2) -> compare(c1.cost, c1.far, c1.junction, c2.cost, c2.far, c2.junction));
        Set<String> junctions = new LinkedHashSet<>();
        for (Candidate c : candidates) {
            int ra = find(parent, uf.get(c.a)), rb = find(parent, uf.get(c.b));
            if (ra == rb) continue;
            union(parent, ra, rb);
            junctions.add(c.junction);
            for (String s : List.of(c.a, c.b)) {
                List<String> path = new ArrayList<>();
                for (String n = c.junction; n != null; n = upChild.get(s).get(n)) path.add(n);
                links.add(new Link(path, true, path.size() - 1, path.size() - 1));
            }
        }

        // 3. 島（連結成分）。順は最初の種の順
        Map<Integer, List<String>> components = new LinkedHashMap<>();
        for (String s : seedFqns) components.computeIfAbsent(find(parent, uf.get(s)), k -> new ArrayList<>()).add(s);
        Map<String, String> islandOf = new HashMap<>();
        var groups = new JSONArray();
        groups.put(new JSONObject().put("id", JAVA_BLOCK_ID).put("kind", "java").put("label", "Java"));
        int islandNo = 0;
        for (List<String> members : components.values()) {
            String id = "isl-" + (++islandNo);
            for (String m : members) islandOf.put(m, id);
            String label = "島 " + islandNo + ": " + displayName(seeds.get(members.get(0)).entry)
                    + (members.size() > 1 ? " …" : "");
            groups.put(new JSONObject().put("id", id).put("kind", "island").put("parent", JAVA_BLOCK_ID).put("label", label));
        }
        // 中継を via ウィンドウにする（経路どうしで共有する中継は 1 つ）
        Set<String> vias = new LinkedHashSet<>();
        for (Link l : links) {
            String island = islandOf.get(l.path.get(l.path.size() - 1));
            if (l.junction) islandOf.putIfAbsent(l.path.get(0), island);
            for (String v : l.relays()) {
                islandOf.putIfAbsent(v, island);
                vias.add(v);
            }
        }

        // 4. ウィンドウ（島ごとに 種 → 合流点 → 中継 の順）
        var windows = new JSONArray();
        Map<String, String> windowIdOf = new HashMap<>();
        Map<Path, List<String>> linesCache = new HashMap<>();
        Map<String, SymbolEntry> usedSymbols = new TreeMap<>();
        for (List<String> members : components.values()) {
            for (String fqn : members) {
                Seed seed = seeds.get(fqn);
                JSONObject w = methodWindow("m-", seed.entry, islandOf.get(fqn), "method", linesCache, usedSymbols);
                var change = new JSONObject().put("status", seed.file.status);
                if (seed.file.oldPath != null) change.put("oldPath", seed.file.oldPath);
                change.put("source", "worktree");
                w.put("change", change);
                w.put("diffState", new JSONObject().put("hunks", hunksJson(seed.hunks)));
                windows.put(w);
                windowIdOf.put(fqn, w.getString("id"));
                seed.file.windowIds.add(w.getString("id"));
            }
            for (String j : junctions) {
                if (!islandOf.get(j).equals(islandOf.get(members.get(0))) || windowIdOf.containsKey(j)) continue;
                JSONObject w = methodWindow("j-", index.getMethod(j), islandOf.get(j), "junction", linesCache, usedSymbols);
                windows.put(w);
                windowIdOf.put(j, w.getString("id"));
            }
            for (String v : vias) {
                if (!islandOf.get(v).equals(islandOf.get(members.get(0))) || windowIdOf.containsKey(v)) continue;
                JSONObject w = methodWindow("v-", index.getMethod(v), islandOf.get(v), "via", linesCache, usedSymbols);
                windows.put(w);
                windowIdOf.put(v, w.getString("id"));
            }
        }
        // メソッド外の hunk（import・フィールド等）はファイル全文のファイル単位ウィンドウ 1 つ
        for (var e : outsideHunks.entrySet()) {
            InputFile f = e.getKey();
            JSONObject w = fileWindow(f, 1, f.lines.size(), List.of("outsideMethod"), "メソッド外の変更", hunksJson(e.getValue()));
            windows.put(w);
            f.windowIds.add(w.getString("id"));
        }
        // hunk が無い（リネームだけ等）ファイルは全文のファイル単位ウィンドウ
        for (InputFile f : files) {
            if (f.reasonNotInGraph() != null || !f.windowIds.isEmpty()) continue;
            JSONObject w = fileWindow(f, 1, f.lines.size(), List.of(), null, new JSONArray());
            windows.put(w);
            f.windowIds.add(w.getString("id"));
        }

        // 5. 接続
        var connections = new JSONArray();
        Set<String> added = new HashSet<>();
        for (Link l : links) {
            // 1 段ずつ実線で結ぶ（共有する区間は 1 本）
            for (int i = 0; i + 1 < l.path.size(); i++) {
                addConnection(connections, added, windowIdOf, l.path.get(i), l.path.get(i + 1));
            }
        }

        // 6. metadata.changeSet（Java 分）
        var filesJson = new JSONArray();
        for (InputFile f : files) {
            var o = new JSONObject().put("path", f.path);
            if (f.oldPath != null) o.put("oldPath", f.oldPath);
            o.put("status", f.status).put("block", "java");
            String reason = f.reasonNotInGraph();
            o.put("inGraph", reason == null);
            if (reason != null) o.put("reason", reason);
            o.put("windows", new JSONArray(f.windowIds));
            filesJson.put(o);
        }
        var changeSet = new JSONObject().put("files", filesJson);

        var out = new JSONObject();
        out.put("groups", groups);
        out.put("windows", windows);
        out.put("connections", connections);
        if (!usedSymbols.isEmpty()) {
            out.put("symbols", OutputGenerator.symbolsJson(usedSymbols, cfg.srcRoots, workspace));
        }
        out.put("metadata", new JSONObject().put("changeSet", changeSet));
        info("[INFO] Change set: " + seeds.size() + " changed methods, " + components.size() + " islands, "
                + junctions.size() + " junctions, " + vias.size() + " vias");
        return out;
    }

    /** from → to の接続（callLine は from の中で to を呼ぶ最初の呼び出し） */
    private void addConnection(JSONArray connections, Set<String> added, Map<String, String> windowIdOf,
            String fromFqn, String toFqn) {
        String from = windowIdOf.get(fromFqn);
        String to = windowIdOf.get(toFqn);
        if (from == null || to == null || !added.add(from + "->" + to)) return;
        var conn = new JSONObject().put("from", from).put("to", to);
        CallRef call = firstCall(fromFqn, toFqn);
        if (call != null) {
            conn.put("callLine", call.line);
            conn.put("callEndLine", call.endLine);
        }
        connections.put(conn);
    }

    private static int compare(int cost1, int far1, String fqn1, int cost2, int far2, String fqn2) {
        if (cost1 != cost2) return Integer.compare(cost1, cost2);
        if (far1 != far2) return Integer.compare(far1, far2);
        return fqn1.compareTo(fqn2);
    }

    private static int find(int[] parent, int i) {
        while (parent[i] != i) {
            parent[i] = parent[parent[i]];
            i = parent[i];
        }
        return i;
    }

    /** 小さい方（先に現れた種）を根にする */
    private static void union(int[] parent, int a, int b) {
        int ra = find(parent, a), rb = find(parent, b);
        if (ra == rb) return;
        if (ra < rb) parent[rb] = ra;
        else parent[ra] = rb;
    }

    // ===== 探索 =====

    /**
     * 種 s から callees を下向きに辿り、到達した別の種への最短経路（s … t）を返す。
     * 種に着いたらその先は辿らない（その種自身の探索が受け持つ）。
     */
    List<List<String>> searchDown(String s, Set<String> seeds) {
        Map<String, String> parent = new HashMap<>();
        parent.put(s, null);
        var q = new ArrayDeque<String>(List.of(s));
        List<List<String>> found = new ArrayList<>();
        while (!q.isEmpty()) {
            String u = q.poll();
            for (String v : callees(u)) {
                if (parent.containsKey(v)) continue;
                parent.put(v, u);
                if (seeds.contains(v)) {
                    List<String> path = new ArrayList<>();
                    for (String n = v; n != null; n = parent.get(n)) path.add(0, n);
                    found.add(path);
                    continue;
                }
                q.add(v);
            }
        }
        return found;
    }

    /**
     * 種 s の祖先 → s までの距離を返す（s 自身は 0）。child には祖先から s へ向かう次のメソッドを書く。
     * 呼び出し元は既存の呼び出し元解析（「ルートまで解析」= --direction incoming --depth -1）と同じ
     * {@link CallGraphAnalyzer#collectIncomingCalls} で集める（辿り方・停止条件・include/exclude は同じ）。
     * 別の種は祖先にしない（種どうしは下向き探索でつながる）。
     */
    Map<String, Integer> searchUp(String s, Set<String> seeds, Map<String, String> child) {
        var g = new GraphModels.Graph();
        NodeFactory.createNodeFromEntry(g, index.getMethod(s));
        CallGraphAnalyzer.collectIncomingCalls(g, cfg, index, CallGraphAnalyzer.MAX_INCOMING_DEPTH);
        Map<String, Set<String>> callersOf = new HashMap<>();
        for (GraphModels.Edge e : g.edges) {
            callersOf.computeIfAbsent(e.to, k -> new TreeSet<>()).add(e.from);
        }
        Map<String, Integer> dist = new HashMap<>();
        dist.put(s, 0);
        var q = new ArrayDeque<String>(List.of(s));
        while (!q.isEmpty()) {
            String u = q.poll();
            for (String p : callersOf.getOrDefault(u, Set.of())) {
                if (dist.containsKey(p) || seeds.contains(p) || index.getMethod(p) == null) continue;
                dist.put(p, dist.get(u) + 1);
                child.put(p, u);
                q.add(p);
            }
        }
        return dist;
    }

    /** ソースのあるメソッド（初期化子の擬似エントリを除く）への呼び出し先。重複なし・名前順 */
    List<String> callees(String fqn) {
        return calleesCache.computeIfAbsent(fqn, k -> {
            MethodEntry e = index.getMethod(k);
            if (e == null) return List.of();
            Set<String> out = new TreeSet<>();
            for (CallRef r : e.callees) {
                if (r.fqn.equals(e.fqn) || !NodeFactory.acceptByFilter(r.fqn, cfg)) continue;
                if (isSourceMethod(index.getMethod(r.fqn))) out.add(r.fqn);
            }
            return new ArrayList<>(out);
        });
    }

    static boolean isSourceMethod(MethodEntry m) {
        return m != null && m.lineStart > 0 && !JdtCallCollector.isInitializerPseudo(m.fqn);
    }

    /** from の中で to を呼ぶ最初の呼び出し */
    private CallRef firstCall(String from, String to) {
        MethodEntry e = index.getMethod(from);
        CallRef best = null;
        if (e == null) return null;
        for (CallRef r : e.callees) {
            if (r.fqn.equals(to) && r.line > 0 && (best == null || r.line < best.line)) best = r;
        }
        return best;
    }

    // ===== ウィンドウ =====

    private Map<Path, List<MethodEntry>> methodsByFile() {
        Map<Path, List<MethodEntry>> map = new HashMap<>();
        Map<String, Path> resolved = new HashMap<>();
        for (String fqn : index.allMethodFqns()) {
            MethodEntry m = index.getMethod(fqn);
            if (!isSourceMethod(m)) continue;
            Path abs = resolved.computeIfAbsent(m.file, f -> {
                Path p = OutputGenerator.resolveAbsolutePath(f, cfg.srcRoots, workspace);
                return p != null ? p.toAbsolutePath().normalize() : null;
            });
            if (abs != null) map.computeIfAbsent(abs, k -> new ArrayList<>()).add(m);
        }
        for (List<MethodEntry> list : map.values()) {
            list.sort(Comparator.comparingInt((MethodEntry m) -> m.lineStart).thenComparing(m -> m.fqn));
        }
        return map;
    }

    private JSONObject methodWindow(String prefix, MethodEntry entry, String group, String windowType,
            Map<Path, List<String>> linesCache, Map<String, SymbolEntry> usedSymbols) {
        var g = new GraphModels.Graph();
        NodeFactory.createNodeFromEntry(g, entry);
        GraphModels.Node node = g.nodes.get(entry.fqn);
        var w = new JSONObject();
        w.put("id", prefix + shortHash(entry.fqn));
        w.put("group", group);
        w.put("windowType", windowType);
        w.put("displayName", displayName(entry));
        OutputGenerator.putMethodSource(w, node, cfg.srcRoots, workspace, linesCache, index::getSymbol, usedSymbols);
        return w;
    }

    private JSONObject fileWindow(InputFile f, int start, int end, List<String> flags, String label, JSONArray hunks) {
        var w = new JSONObject();
        w.put("id", "f-" + shortHash(f.path + ":" + start));
        w.put("group", JAVA_BLOCK_ID);
        w.put("windowType", "file");
        w.put("displayName", f.abs.getFileName().toString());
        w.put("filePath", OutputGenerator.toRelativePath(f.abs.toString(), cfg.srcRoots, workspace));
        w.put("startLine", start);
        w.put("code", f.lines.isEmpty() ? "" : String.join("\n", f.lines.subList(start - 1, end)));
        w.put("change", changeJson(f, flags, label));
        if (!hunks.isEmpty()) w.put("diffState", new JSONObject().put("hunks", hunks));
        return w;
    }

    private static JSONObject changeJson(InputFile f, List<String> flags, String label) {
        var change = new JSONObject().put("status", f.status);
        if (f.oldPath != null) change.put("oldPath", f.oldPath);
        change.put("source", "worktree");
        if (!flags.isEmpty()) change.put("flags", new JSONArray(flags));
        if (label != null) change.put("label", label);
        return change;
    }

    private static JSONArray hunksJson(List<Hunk> hunks) {
        var arr = new JSONArray();
        for (Hunk h : hunks) arr.put(h.json);
        return arr;
    }

    /** 表示名 {@code 単純クラス名.メソッド名}（コンストラクタはクラス名） */
    static String displayName(MethodEntry e) {
        String cls = e.classFqn != null ? e.classFqn : e.fqn.substring(0, e.fqn.indexOf('#'));
        cls = cls.substring(cls.lastIndexOf('.') + 1);
        String name = e.methodName != null ? e.methodName : e.fqn.substring(e.fqn.indexOf('#') + 1, e.fqn.indexOf('('));
        return cls + "." + name;
    }

    /** 安定した不透明 ID 用の短いハッシュ */
    static String shortHash(String s) {
        try {
            byte[] d = MessageDigest.getInstance("SHA-1").digest(s.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < 5; i++) sb.append(String.format("%02x", d[i]));
            return sb.toString();
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
