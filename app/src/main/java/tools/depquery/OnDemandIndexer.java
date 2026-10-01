package tools.depquery;

import tools.depquery.CallIndexModels.CallIndex;
import tools.depquery.CallIndexModels.CallRef;
import tools.depquery.JdtCallCollector.Caller;
import tools.depquery.JdtCallCollector.FileResult;
import tools.depquery.JdtCallCollector.RawCall;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;
import java.util.concurrent.CompletableFuture;

import static tools.depquery.DiagnosticLogger.*;
import static tools.depquery.NodeFactory.acceptByFilter;

/**
 * インデックスが無い（またはルートがインデックスに無い）ときの解析用に、必要なファイルだけを
 * JDT（{@link JdtCallCollector}）で解析してメモリ上の {@link CallIndex} を作る。
 *
 * <p>作った CallIndex はインデックス有りの解析と同じ BFS（{@link CallGraphAnalyzer}）に渡す。
 * 呼び出しの解決・CHA の展開はインデックス構築と同じ部品（{@link JdtCallCollector}・
 * {@link CallIndexBuilder#addCallees}・{@link CallIndexBuilder.DeclaredMethodResolver}）を使う。
 *
 * <p>JDT の解析は 1 回ごとに環境の準備が要るので、BFS の階層ごとに必要なファイルをまとめて 1 回で解析する。
 * <ul>
 *   <li>outgoing: 階層 k のメソッドの呼び出し先のクラスと、仮想呼び出しの CHA に要るクラス
 *       （呼び出し先クラスのサブクラスとその上位）のファイルを解析してから、階層 k の callees を確定する</li>
 *   <li>incoming: 対象メソッド名の呼び出しを含むファイル（文字列で絞る）と、CHA に要るクラスのファイルを
 *       1 回で解析し、1 階層ぶんの呼び出し元を求める（全階層の呼び出し元はインデックスが必要）</li>
 * </ul>
 */
final class OnDemandIndexer {
    private final AnalyzerConfig cfg;
    private final SourceLocator locator;
    private final HierarchyCache hierarchy;

    final CallIndex index = new CallIndex();
    private final Map<String, Caller> callers = new HashMap<>();
    private final Set<Path> analyzed = new HashSet<>();
    private int rounds;
    /** 並行解析の分割数の上限と、1 分割あたりの最小ファイル数 */
    private static final int PARALLEL_MAX = 4;
    private static final int PARALLEL_MIN_FILES = 16;
    /** JDT のクラスパス（全ラウンドで共通なので 1 回だけ作る） */
    private List<String> classpath;

    OnDemandIndexer(AnalyzerConfig cfg, SourceLocator locator, HierarchyCache hierarchy) {
        this.cfg = cfg;
        this.locator = locator;
        this.hierarchy = hierarchy;
    }

    /** 未解析のファイルだけを 1 回の JDT 解析にまとめる */
    private void analyze(Collection<Path> files) {
        List<Path> todo = new ArrayList<>();
        for (Path f : files) {
            if (f != null && analyzed.add(f)) todo.add(f);
        }
        if (todo.isEmpty()) return;
        rounds++;
        debug("OnDemandIndexer round " + rounds + ": " + todo.size() + " files");
        try {
            if (classpath == null) classpath = JdtCallCollector.classpathEntries(cfg);
            for (FileResult r : analyzeChunks(todo)) {
                for (Caller c : r.callers()) {
                    callers.put(c.entry.fqn, c);
                    index.addMethod(c.entry);
                }
                index.symbolIndex.putAll(r.constants());
                index.symbols.putAll(r.symbols());
            }
        } catch (IOException ex) {
            info("[WARN] Failed to analyze sources: " + ex.getMessage());
        }
    }

    /** ファイル数が多い回は分割して並行に解析する（JDT の 1 回の解析は 1 スレッドで進むため） */
    private List<FileResult> analyzeChunks(List<Path> todo) throws IOException {
        int k = Math.min(PARALLEL_MAX, Math.max(1, Runtime.getRuntime().availableProcessors() / 2));
        k = Math.min(k, todo.size() / PARALLEL_MIN_FILES);
        if (k <= 1) return new JdtCallCollector(cfg, classpath).analyze(todo);
        List<CompletableFuture<List<FileResult>>> parts = new ArrayList<>();
        int size = (todo.size() + k - 1) / k;
        for (int i = 0; i < todo.size(); i += size) {
            List<Path> chunk = todo.subList(i, Math.min(todo.size(), i + size));
            parts.add(CompletableFuture.supplyAsync(() -> {
                try {
                    return new JdtCallCollector(cfg, classpath).analyze(chunk);
                } catch (IOException ex) {
                    throw new UncheckedIOException(ex);
                }
            }));
        }
        List<FileResult> results = new ArrayList<>();
        for (var p : parts) results.addAll(p.join());
        return results;
    }

    /**
     * ユーザー指定のルートを宣言済みメソッドの FQN に解決する（クラスのファイルを解析してから曖昧マッチング）。
     * 見つからないルートは警告して除く。
     */
    List<String> resolveRoots(List<String> userRoots) {
        List<Path> files = new ArrayList<>();
        for (String r : userRoots) {
            int h = r.indexOf('#');
            if (h > 0) files.addAll(locator.candidateFilesForUserClass(r.substring(0, h)));
        }
        analyze(files);
        List<String> resolved = new ArrayList<>();
        for (String userRoot : userRoots) {
            String fqn = MethodResolver.resolveRootMethodFqn(userRoot, callers.keySet());
            if (fqn == null) {
                System.err.println("[WARN] root not found: " + userRoot);
                continue;
            }
            if (!fqn.equals(userRoot)) {
                info("[INFO] Resolved root: " + userRoot + " -> " + fqn);
            }
            resolved.add(fqn);
        }
        return resolved;
    }

    /**
     * outgoing: ルートから階層 0..depth のメソッドの callees を確定する（BFS は階層 depth のメソッドからの辺まで
     * 描くので、その呼び出し先 = 階層 depth+1 のメソッドの宣言まで解析する）
     */
    void expandOutgoing(List<String> roots, int depth) {
        Set<String> expanded = new HashSet<>();
        List<String> frontier = new ArrayList<>(roots);
        for (int level = 0; level <= depth && !frontier.isEmpty(); level++) {
            Set<Path> need = new LinkedHashSet<>();
            for (String m : frontier) {
                Caller c = callers.get(m);
                if (c == null) continue;
                for (RawCall call : c.calls) {
                    if (!acceptByFilter(call.callee(), cfg)) continue;
                    need.add(locator.resolveMethodFile(call.callee()));
                    if (call.virtual()) addChaFiles(classOf(call.callee()), need);
                }
            }
            analyze(need);

            ChaContext cha = newCha();
            Set<String> next = new LinkedHashSet<>();
            for (String m : frontier) {
                Caller c = callers.get(m);
                if (c == null || !expanded.add(m)) continue;
                CallIndexBuilder.addCallees(c, cha, cfg);
                for (CallRef ref : c.entry.callees) {
                    if (callers.containsKey(ref.fqn) && !expanded.contains(ref.fqn)) next.add(ref.fqn);
                }
            }
            frontier = new ArrayList<>(next);
        }
        info("[INFO] Analyzed " + analyzed.size() + " source files on demand (" + rounds + " JDT rounds)");
    }

    /**
     * incoming: 対象メソッドの呼び出し元（1 階層）が求まるだけ解析し、callers（逆引き）まで作る。
     */
    void prepareIncoming(List<String> targets) {
        Set<String> names = new HashSet<>();
        Set<Path> need = new LinkedHashSet<>();
        for (String t : targets) {
            int h = t.indexOf('#');
            int p = t.indexOf('(', h);
            if (h < 0 || p < 0) continue;
            String name = t.substring(h + 1, p);
            // コンストラクタ名は Outer.Inner 形式。呼び出しの文字列は new Inner(
            names.add(name.substring(name.lastIndexOf('.') + 1));
            // 上位クラスのメソッドへの呼び出しも CHA で対象に届くので、上位とその全サブクラスも解析する
            String cls = t.substring(0, h);
            Set<String> related = new LinkedHashSet<>();
            related.add(cls);
            related.addAll(ancestors(cls));
            for (String r : new ArrayList<>(related)) related.addAll(hierarchy.getAllSubclasses(r));
            for (String r : related) need.add(locator.resolveClassFile(r));
        }
        for (Path f : locator.allFiles()) {
            if (analyzed.contains(f) || need.contains(f)) continue;
            try {
                String content = Files.readString(f);
                for (String n : names) {
                    if (content.contains(n + "(") || content.contains("::" + n)) {
                        need.add(f);
                        break;
                    }
                }
            } catch (IOException ex) {
                need.add(f); // 読めないファイルは念のため解析に回す
            }
        }
        analyze(need);

        ChaContext cha = newCha();
        for (Caller c : callers.values()) {
            c.entry.callees.clear();
            CallIndexBuilder.addCallees(c, cha, cfg);
        }
        CallIndexBuilder.buildCallerReferences(index);
        info("[INFO] Analyzed " + analyzed.size() + " source files on demand (" + rounds + " JDT rounds)");
    }

    /**
     * シンボル参照（型・フィールド）の宣言が未解析のファイルにあれば解析する（出力の symbols を埋めるため）。
     * 宣言は参照元のクラスや呼び出し先のクラス・定数クラス・enum にあることが多く、たいていは解析済み。
     * 未解析のファイルは宣言を集めるためだけに解析する（そのファイルのメソッドの辺は出力に使わない）。
     */
    void ensureSymbolDeclarations(Collection<String> symbolKeys) {
        Set<Path> need = new LinkedHashSet<>();
        for (String key : symbolKeys) {
            if (index.symbols.containsKey(key)) continue;
            Path f = locator.resolveClassFile(classOf(key));
            if (f != null && !analyzed.contains(f)) need.add(f);
        }
        analyze(need);
    }

    private ChaContext newCha() {
        return new ChaContext(hierarchy, new CallIndexBuilder.DeclaredMethodResolver(index.methods.values()));
    }

    /** 仮想呼び出し先のクラスについて、CHA の実在判定に要るクラス（サブクラスとその上位）のファイル */
    private void addChaFiles(String cls, Set<Path> need) {
        for (String sub : hierarchy.getAllSubclasses(cls)) {
            need.add(locator.resolveClassFile(sub));
            for (String a : ancestors(sub)) need.add(locator.resolveClassFile(a));
        }
    }

    private Set<String> ancestors(String cls) {
        Set<String> seen = new LinkedHashSet<>();
        Deque<String> q = new ArrayDeque<>(hierarchy.getParentClasses(cls));
        while (!q.isEmpty()) {
            String p = q.poll();
            if (seen.add(p)) q.addAll(hierarchy.getParentClasses(p));
        }
        return seen;
    }

    private static String classOf(String fqn) {
        int h = fqn.indexOf('#');
        return h < 0 ? fqn : fqn.substring(0, h);
    }
}
