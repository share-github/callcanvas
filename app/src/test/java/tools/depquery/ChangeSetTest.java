package tools.depquery;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 変更集合キャンバス（{@code --changed-methods}）の Java ブロックの検証。
 *
 * <p>sample-project/sample-app-changeset を一時コピーしてインデックスを構築し、
 * src/test/resources/changeset/input.json（変更ファイルと hunk）を解析する。出力全体を expected.json と照合し、
 * 島の決め方の各ケースを個別に確かめる。expected.json を作り直すときは消してから
 * {@code ./gradlew test --tests ChangeSetTest} を 2 回実行する（1 回目が書き出して失敗する。意図した変更か差分を見ること）。
 */
public class ChangeSetTest {

    private static final String PKG = "com.example.changeset.";
    private static final String SRC = "src/main/java/com/example/changeset/";
    private static Path workspaceRoot;
    private static Path jarPath;
    private static Path project;
    private static Path input;
    private static JSONObject out;
    /** インデックスを構築する前に実行したときの出力 */
    private static String noIndexOutput;

    @BeforeAll
    static void setup() throws Exception {
        Path cur = Path.of(System.getProperty("user.dir")).toAbsolutePath();
        workspaceRoot = cur.getFileName().toString().equals("app") ? cur.getParent() : cur;
        try (Stream<Path> s = Files.list(workspaceRoot.resolve("app/build/libs"))) {
            jarPath = s.filter(p -> p.getFileName().toString().matches("java-call-hierarchy-analyzer-.*\\.jar"))
                    .max(Comparator.comparingLong(p -> p.toFile().lastModified()))
                    .orElseThrow(() -> new IllegalStateException("Run './gradlew shadowJar' first"));
        }
        input = workspaceRoot.resolve("app/src/test/resources/changeset/input.json");
        project = copyProject();
        noIndexOutput = run(analyzeArgs(project, Files.createTempDirectory("changeset-out-")), 2);
        run(List.of("--build-index", "--workspace", project.toString(),
                "--src", project.resolve("src/main/java").toString()), 0);
        out = analyze(project);
    }

    /** sample-project を汚さないように一時コピーへ（インデックスもそこに作る） */
    private static Path copyProject() throws IOException {
        Path from = workspaceRoot.resolve("sample-project/sample-app-changeset/src");
        Path copy = Files.createTempDirectory("changeset-project-");
        try (Stream<Path> s = Files.walk(from)) {
            for (Path p : (Iterable<Path>) s::iterator) {
                Path dst = copy.resolve("src").resolve(from.relativize(p).toString());
                if (Files.isDirectory(p)) Files.createDirectories(dst);
                else Files.copy(p, dst, StandardCopyOption.REPLACE_EXISTING);
            }
        }
        return copy;
    }

    private static List<String> analyzeArgs(Path ws, Path outDir, String... extra) {
        List<String> args = new ArrayList<>(List.of("--changed-methods", input.toString(),
                "--workspace", ws.toString(), "--src", ws.resolve("src/main/java").toString(),
                "--out", outDir.toString()));
        args.addAll(List.of(extra));
        return args;
    }

    private static JSONObject analyze(Path ws, String... extra) throws Exception {
        Path outDir = Files.createTempDirectory("changeset-out-");
        String log = run(analyzeArgs(ws, outDir, extra), 0);
        Path json = outDir.resolve("changeset-java.json");
        assertTrue(log.contains("[CHANGESET_FILE]" + json.toAbsolutePath()), log);
        return new JSONObject(Files.readString(json, StandardCharsets.UTF_8));
    }

    private static String run(List<String> args, int expectedExit) throws Exception {
        List<String> cmd = new ArrayList<>(List.of("java", "-jar", jarPath.toString()));
        cmd.addAll(args);
        Process p = new ProcessBuilder(cmd).redirectErrorStream(true).start();
        String output = new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        assertEquals(expectedExit, p.waitFor(), "exit code: " + String.join(" ", cmd) + "\n" + output);
        return output;
    }

    // ===== 参照ヘルパー =====

    private static JSONObject window(JSONObject json, String displayName) {
        JSONArray ws = json.getJSONArray("windows");
        for (int i = 0; i < ws.length(); i++) {
            if (ws.getJSONObject(i).getString("displayName").equals(displayName)) return ws.getJSONObject(i);
        }
        return fail("window not found: " + displayName);
    }

    private static List<JSONObject> windowsOfFile(JSONObject json, String file) {
        List<JSONObject> list = new ArrayList<>();
        JSONArray ws = json.getJSONArray("windows");
        for (int i = 0; i < ws.length(); i++) {
            if (ws.getJSONObject(i).getString("filePath").equals(SRC + file)) list.add(ws.getJSONObject(i));
        }
        return list;
    }

    private static String island(JSONObject json, String displayName) {
        return window(json, displayName).getString("group");
    }

    private static JSONObject connection(JSONObject json, String from, String to) {
        String f = window(json, from).getString("id"), t = window(json, to).getString("id");
        JSONArray cs = json.getJSONArray("connections");
        for (int i = 0; i < cs.length(); i++) {
            JSONObject c = cs.getJSONObject(i);
            if (c.getString("from").equals(f) && c.getString("to").equals(t)) return c;
        }
        return null;
    }

    private static JSONObject fileEntry(JSONObject json, String file) {
        JSONArray fs = json.getJSONObject("metadata").getJSONObject("changeSet").getJSONArray("files");
        for (int i = 0; i < fs.length(); i++) {
            if (fs.getJSONObject(i).getString("path").equals(SRC + file)) return fs.getJSONObject(i);
        }
        return fail("file not found: " + file);
    }

    private static boolean hasWindow(JSONObject json, String displayName) {
        JSONArray ws = json.getJSONArray("windows");
        for (int i = 0; i < ws.length(); i++) {
            if (ws.getJSONObject(i).getString("displayName").equals(displayName)) return true;
        }
        return false;
    }

    /** 未変更の中継ウィンドウ（via）であること: 島に属し、展開して表示（collapsed なし）、change/diffState なし */
    private static void assertVia(JSONObject json, String displayName, String island) {
        JSONObject v = window(json, displayName);
        assertEquals("via", v.getString("windowType"));
        assertEquals(island, v.getString("group"));
        assertFalse(v.has("collapsed"));
        assertFalse(v.has("change"));
        assertFalse(v.has("diffState"));
    }

    /** 省略なしの実線接続（callLine 付き）を返す */
    private static JSONObject solid(JSONObject json, String from, String to) {
        JSONObject c = connection(json, from, to);
        assertNotNull(c, from + " -> " + to);
        assertTrue(c.has("callLine"), c.toString());
        return c;
    }

    // ===== テスト =====

    @Test
    void matchesExpectedJson() throws IOException {
        Path expectedPath = workspaceRoot.resolve("app/src/test/resources/changeset/expected.json");
        if (!Files.exists(expectedPath)) {
            Files.writeString(expectedPath, out.toString(2) + "\n");
            fail("expected.json を書き出した。差分を確かめてから再実行すること: " + expectedPath);
        }
        JSONObject expected = new JSONObject(Files.readString(expectedPath, StandardCharsets.UTF_8));
        assertTrue(expected.similar(out), "output differs from expected.json:\n" + out.toString(2));
    }

    /** 直接呼び出し（下向きの到達）でつながる 2 種は 1 つの島。経路は最短 */
    @Test
    void directCallJoinsIsland() {
        assertEquals(island(out, "OrderService # validate"), island(out, "OrderRepository # save"));
        JSONObject c = connection(out, "OrderService # validate", "OrderRepository # save");
        assertNotNull(c);
        assertEquals(15, c.getInt("callLine"));
    }

    /** 未変更の中継（OrderFacade#place → OrderWorkflow#run）は via ウィンドウにして順に実線で結ぶ */
    @Test
    void unchangedRelaysBecomeViaWindows() {
        String isl = island(out, "OrderController # create");
        assertEquals(isl, island(out, "OrderService # validate"));
        assertVia(out, "OrderFacade # place", isl);
        assertVia(out, "OrderWorkflow # run", isl);
        assertEquals(10, solid(out, "OrderController # create", "OrderFacade # place").getInt("callLine"));
        solid(out, "OrderFacade # place", "OrderWorkflow # run");
        solid(out, "OrderWorkflow # run", "OrderService # validate");
        assertNull(connection(out, "OrderController # create", "OrderService # validate"));
    }

    /** 接続は隣り合うウィンドウを結ぶ実線だけ（中継をまとめる省略接続は無い）。metadata に探索の上限・しきい値は無い */
    @Test
    void connectionsArePlainCallsOnly() {
        JSONArray conns = out.getJSONArray("connections");
        for (int i = 0; i < conns.length(); i++) {
            JSONObject c = conns.getJSONObject(i);
            assertEquals(Set.of("from", "to", "callLine", "callEndLine", "callEndCol"), c.keySet(), c.toString());
        }
        assertEquals(Set.of("files"),
                out.getJSONObject("metadata").getJSONObject("changeSet").keySet());
    }

    /** 共通の祖先でつながる 2 種は、最も近い共通の祖先を junction にして 1 つの島 */
    @Test
    void commonAncestorBecomesJunction() {
        String isl = island(out, "InventoryService # reserve");
        assertEquals(isl, island(out, "PaymentService # charge"));
        JSONObject j = window(out, "CheckoutService # checkout");
        assertEquals("junction", j.getString("windowType"));
        assertEquals(isl, j.getString("group"));
        assertFalse(j.has("collapsed"));
        assertFalse(j.has("change"));
        assertFalse(j.has("diffState"));
        // より遠い共通の祖先（CheckoutController#post）は出さない
        assertTrue(windowsOfFile(out, "checkout/CheckoutController.java").isEmpty());
        JSONObject toReserve = connection(out, "CheckoutService # checkout", "InventoryService # reserve");
        assertNotNull(toReserve);
        assertEquals(8, toReserve.getInt("callLine"));
        // 合流点 → 種の経路の中継 1 段（PaymentFacade#pay）も via ウィンドウ
        assertVia(out, "PaymentFacade # pay", isl);
        assertEquals(9, solid(out, "CheckoutService # checkout", "PaymentFacade # pay").getInt("callLine"));
        solid(out, "PaymentFacade # pay", "PaymentService # charge");
        assertNull(connection(out, "CheckoutService # checkout", "PaymentService # charge"));
    }

    /** どの種ともつながらない種は 1 人の島（ラベルに … を付けない） */
    @Test
    void unrelatedSeedIsSeparateIsland() {
        String isl = island(out, "ReportService # monthly");
        for (String other : List.of("OrderController # create", "InventoryService # reserve", "AuditService # log",
                "JobRunner # runJob")) {
            assertNotEquals(isl, island(out, other), other);
        }
        assertEquals(1, membersOf(out, isl).size());
        assertTrue(groupLabel(out, isl).endsWith("ReportService # monthly"), groupLabel(out, isl));
    }

    /**
     * 上向きは既存の呼び出し元解析（「ルートまで解析」= --direction incoming --depth -1）と同じ辿り方。
     * 既存解析は @GetMapping の AdminController#audit/stats で止まらず main まで辿るので、
     * AuditService#log と MetricsService#count は AdminLauncher#main を合流点にして 1 つの島になる
     */
    @Test
    void upwardSearchFollowsIncomingAnalysis() throws Exception {
        for (String root : List.of(PKG + "admin.AuditService#log(java.lang.String)", PKG + "admin.MetricsService#count()")) {
            Set<String> incoming = incomingDisplayNames(root);
            assertTrue(incoming.contains("AdminLauncher # main"), root + ": " + incoming);
        }
        String isl = island(out, "AuditService # log");
        assertEquals(isl, island(out, "MetricsService # count"));
        JSONObject j = window(out, "AdminLauncher # main");
        assertEquals("junction", j.getString("windowType"));
        assertEquals(isl, j.getString("group"));
        assertVia(out, "AdminController # audit", isl);
        assertVia(out, "AdminController # stats", isl);
        solid(out, "AdminLauncher # main", "AdminController # audit");
        solid(out, "AdminController # audit", "AuditService # log");
        solid(out, "AdminLauncher # main", "AdminController # stats");
        solid(out, "AdminController # stats", "MetricsService # count");
    }

    /** --exclude は既存の呼び出し元解析と同じく効く（除外したクラスは辿らず、合流点にもしない） */
    @Test
    void excludeFilterMatchesIncomingAnalysis() throws Exception {
        String exclude = PKG + "admin.AdminLauncher";
        Set<String> incoming = incomingDisplayNames(PKG + "admin.AuditService#log(java.lang.String)", "--exclude", exclude);
        assertFalse(incoming.contains("AdminLauncher # main"), incoming.toString());
        assertTrue(incoming.contains("AdminController # audit"), incoming.toString());
        JSONObject excluded = analyze(project, "--exclude", exclude);
        assertNotEquals(island(excluded, "AuditService # log"), island(excluded, "MetricsService # count"));
        assertTrue(windowsOfFile(excluded, "admin/AdminLauncher.java").isEmpty());
        assertTrue(windowsOfFile(excluded, "admin/AdminController.java").isEmpty());
    }

    /** 2 経路で共有する中継（Dispatcher#dispatch）は via ウィンドウ 1 つ・区間 runJob → dispatch も 1 本 */
    @Test
    void sharedRelayIsOneViaWindow() {
        assertEquals(island(out, "JobRunner # runJob"), island(out, "NotifyService # email"));
        assertEquals(island(out, "JobRunner # runJob"), island(out, "NotifyService # sms"));
        String isl = island(out, "JobRunner # runJob");
        assertVia(out, "Dispatcher # dispatch", isl);
        assertEquals(1, windowsOfFile(out, "notify/Dispatcher.java").size());
        solid(out, "Dispatcher # dispatch", "NotifyService # email");
        solid(out, "Dispatcher # dispatch", "NotifyService # sms");
        String from = window(out, "JobRunner # runJob").getString("id"), to = window(out, "Dispatcher # dispatch").getString("id");
        JSONArray cs = out.getJSONArray("connections");
        int n = 0;
        for (int i = 0; i < cs.length(); i++) {
            if (cs.getJSONObject(i).getString("from").equals(from) && cs.getJSONObject(i).getString("to").equals(to)) n++;
        }
        assertEquals(1, n);
        assertNull(connection(out, "JobRunner # runJob", "NotifyService # email"));
    }

    /** 既存の呼び出し元解析（--direction incoming --depth -1 --format callcanvas）のウィンドウの displayName */
    private static Set<String> incomingDisplayNames(String root, String... extra) throws Exception {
        Path outDir = Files.createTempDirectory("changeset-incoming-");
        List<String> args = new ArrayList<>(List.of("--root", root, "--direction", "incoming", "--depth", "-1",
                "--format", "callcanvas", "--workspace", project.toString(),
                "--src", project.resolve("src/main/java").toString(), "--out", outDir.toString()));
        args.addAll(List.of(extra));
        run(args, 0);
        Set<String> names = new TreeSet<>();
        try (Stream<Path> s = Files.list(outDir)) {
            for (Path p : (Iterable<Path>) s.filter(p -> p.getFileName().toString().startsWith("callcanvas"))::iterator) {
                JSONArray ws = new JSONObject(Files.readString(p, StandardCharsets.UTF_8)).getJSONArray("windows");
                for (int i = 0; i < ws.length(); i++) names.add(ws.getJSONObject(i).getString("displayName"));
            }
        }
        assertFalse(names.isEmpty(), "no callcanvas output in " + outDir);
        return names;
    }

    /** どのメソッドにも当たらない hunk（フィールド）はファイル全文の outsideMethod のファイル単位ウィンドウ */
    @Test
    void hunkOutsideMethodBecomesFileWindow() throws IOException {
        List<JSONObject> ws = windowsOfFile(out, "order/OrderService.java");
        JSONObject file = ws.stream().filter(w -> w.getString("windowType").equals("file")).findFirst().orElseThrow();
        assertEquals("blk-java", file.getString("group"));
        JSONObject change = file.getJSONObject("change");
        assertEquals("worktree", change.getString("source"));
        assertEquals(List.of("outsideMethod"), change.getJSONArray("flags").toList());
        // hunk は 4 行目。ウィンドウはファイル全文
        assertEquals(1, file.getInt("startLine"));
        assertEquals(String.join("\n", Files.readAllLines(project.resolve(SRC + "order/OrderService.java"))),
                file.getString("code"));
        JSONArray hunks = file.getJSONObject("diffState").getJSONArray("hunks");
        assertEquals(1, hunks.length());
        assertEquals(4, hunks.getJSONObject(0).getInt("newStart"));
        // Javadoc の hunk と本体の hunk はメソッドの種に当たる（Javadoc から始まるウィンドウ）
        JSONObject validate = window(out, "OrderService # validate");
        assertEquals("method", validate.getString("windowType"));
        assertEquals(8, validate.getInt("startLine"));
        assertEquals(2, validate.getJSONObject("diffState").getJSONArray("hunks").length());
        assertEquals("worktree", validate.getJSONObject("change").getString("source"));
        JSONArray fileWindows = fileEntry(out, "order/OrderService.java").getJSONArray("windows");
        assertEquals(List.of(validate.getString("id"), file.getString("id")), fileWindows.toList());
    }

    /** 作業ツリーと不一致・削除のファイルはグラフに入れない（ウィンドウは呼び出し側が作る） */
    @Test
    void worktreeMismatchIsNotInGraph() {
        JSONObject mismatch = fileEntry(out, "report/ReportLegacy.java");
        assertFalse(mismatch.getBoolean("inGraph"));
        assertEquals("worktreeMismatch", mismatch.getString("reason"));
        assertEquals("java", mismatch.getString("block"));
        assertTrue(mismatch.getJSONArray("windows").isEmpty());
        JSONObject deleted = fileEntry(out, "order/LegacyRule.java");
        assertFalse(deleted.getBoolean("inGraph"));
        assertEquals("deleted", deleted.getString("reason"));
        assertTrue(fileEntry(out, "order/OrderController.java").getBoolean("inGraph"));
    }

    /** 不変条件: 全 files が入力に 1 回ずつ、windows は実在、group は groups にあり、接続の両端は同じ島 */
    @Test
    void invariantsHold() throws IOException {
        Map<String, JSONObject> windows = new HashMap<>();
        JSONArray ws = out.getJSONArray("windows");
        for (int i = 0; i < ws.length(); i++) windows.put(ws.getJSONObject(i).getString("id"), ws.getJSONObject(i));
        Map<String, String> groupKinds = new HashMap<>();
        JSONArray gs = out.getJSONArray("groups");
        for (int i = 0; i < gs.length(); i++) groupKinds.put(gs.getJSONObject(i).getString("id"), gs.getJSONObject(i).getString("kind"));
        for (JSONObject w : windows.values()) assertTrue(groupKinds.containsKey(w.getString("group")), w.getString("id"));

        JSONArray in = new JSONObject(Files.readString(input)).getJSONArray("files");
        JSONArray fs = out.getJSONObject("metadata").getJSONObject("changeSet").getJSONArray("files");
        assertEquals(in.length(), fs.length());
        for (int i = 0; i < fs.length(); i++) {
            assertEquals(in.getJSONObject(i).getString("path"), fs.getJSONObject(i).getString("path"));
            for (Object id : fs.getJSONObject(i).getJSONArray("windows")) assertTrue(windows.containsKey(id), id + "");
        }
        JSONArray cs = out.getJSONArray("connections");
        assertTrue(cs.length() >= 6);
        for (int i = 0; i < cs.length(); i++) {
            JSONObject c = cs.getJSONObject(i);
            String g1 = windows.get(c.getString("from")).getString("group");
            String g2 = windows.get(c.getString("to")).getString("group");
            assertEquals(g1, g2, c.toString());
            assertEquals("island", groupKinds.get(g1));
        }
    }

    /** インデックスが無い・世代違い・古いときは構築を促すエラー（終了コード 2） */
    @Test
    void requiresCurrentIndex() throws Exception {
        assertTrue(noIndexOutput.contains("[ERROR] Call index not found"), noIndexOutput);
        assertTrue(noIndexOutput.contains("--build-index"), noIndexOutput);

        Path old = copyProject();
        run(List.of("--build-index", "--workspace", old.toString(), "--src", old.resolve("src/main/java").toString()), 0);
        Path indexJson = old.resolve(".callcanvas-cache/call-index.json");
        Files.writeString(indexJson, Files.readString(indexJson).replaceFirst("\"version\": \"[0-9.]+\"", "\"version\": \"1.2\""));
        String log = run(analyzeArgs(old, Files.createTempDirectory("changeset-out-")), 2);
        assertTrue(log.contains("[ERROR] Call index version 1.2 is not supported"), log);

        // 変更ファイルがインデックス構築後に書き換わっている（hunk の行がずれる）
        Path stale = copyProject();
        run(List.of("--build-index", "--workspace", stale.toString(), "--src", stale.resolve("src/main/java").toString()), 0);
        Files.writeString(stale.resolve(SRC + "report/ReportService.java"), "\n", StandardOpenOption.APPEND);
        log = run(analyzeArgs(stale, Files.createTempDirectory("changeset-out-")), 2);
        assertTrue(log.contains("[ERROR] Call index is out of date for " + SRC + "report/ReportService.java"), log);
    }

    private static List<String> membersOf(JSONObject json, String group) {
        List<String> list = new ArrayList<>();
        JSONArray ws = json.getJSONArray("windows");
        for (int i = 0; i < ws.length(); i++) {
            if (ws.getJSONObject(i).getString("group").equals(group)) list.add(ws.getJSONObject(i).getString("id"));
        }
        return list;
    }

    private static String groupLabel(JSONObject json, String group) {
        JSONArray gs = json.getJSONArray("groups");
        for (int i = 0; i < gs.length(); i++) {
            if (gs.getJSONObject(i).getString("id").equals(group)) return gs.getJSONObject(i).getString("label");
        }
        return fail("group not found: " + group);
    }
}
