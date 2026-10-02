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
 * 接続の callEndCol（呼び出し式の終端の直後の列）の検証。
 *
 * <p>sample-project/sample-app-callorder（ルート Flow#run()）を、インデックス無しとインデックス有り（一時コピーに構築）の
 * 両経路で解析し、run の接続を (callEndLine, callEndCol) で並べると実行順になることを確かめる:
 * 引数の呼び出しが先（{@code outer(inner(1))}）・メソッドチェーンは左から（{@code first().second()}）・
 * 同じ行の文は左から・複数行の呼び出しは引数が先（{@code wrap(⏎ arg() ⏎)}）。
 * 同じ行・同じ呼び出し先の重複（{@code twice(twice(0))}）は先に実行される内側を残す。
 * Viewer の「左右キーでステップ実行」はこの順で呼び出し先に入る。
 */
public class CallOrderTest {

    private static Path workspaceRoot;
    private static Path jarPath;
    private static JSONObject onDemand;
    private static JSONObject indexed;

    @BeforeAll
    static void setup() throws Exception {
        Path cur = Path.of(System.getProperty("user.dir")).toAbsolutePath();
        workspaceRoot = cur.getFileName().toString().equals("app") ? cur.getParent() : cur;
        try (Stream<Path> s = Files.list(workspaceRoot.resolve("app/build/libs"))) {
            jarPath = s.filter(p -> p.getFileName().toString().matches("java-call-hierarchy-analyzer-.*\\.jar"))
                    .max(Comparator.comparingLong(p -> p.toFile().lastModified()))
                    .orElseThrow(() -> new IllegalStateException("Run './gradlew shadowJar' first"));
        }
        Path project = workspaceRoot.resolve("sample-project/sample-app-callorder");
        onDemand = analyze(List.of("--src", project.resolve("src/main/java").toString()));
        Path copy = Files.createTempDirectory("callorder-project-");
        copyTree(project.resolve("src"), copy.resolve("src"));
        String src = copy.resolve("src/main/java").toString();
        run(List.of("--build-index", "--workspace", copy.toString(), "--src", src));
        indexed = analyze(List.of("--workspace", copy.toString(), "--src", src));
    }

    private static final List<String> EXPECTED = List.of(
            "Flow # inner", "Flow # outer",
            "Flow # first", "Chain # second",
            "Flow # a", "Flow # b",
            "Flow # arg", "Flow # wrap",
            "Flow # make", "Chain # value", "Chain # use",
            "Flow # twice", "Flow # tall");

    @Test
    void connectionsSortedByEndPositionFollowExecutionOrder() {
        assertEquals(EXPECTED, calleesInExecutionOrder(onDemand));
    }

    @Test
    void indexedAnalysisHasSameOrder() {
        assertEquals(EXPECTED, calleesInExecutionOrder(indexed));
        assertEquals(positions(onDemand), positions(indexed));
    }

    /** 同じ行・同じ呼び出し先は 1 本にまとめ、先に実行される内側 twice(0) の終端を残す */
    @Test
    void duplicateOnSameLineKeepsFirstExecuted() {
        JSONObject c = connectionsFromRun(onDemand).stream()
                .filter(x -> name(onDemand, x.getString("to")).equals("Flow # twice")).findFirst().orElseThrow();
        String line = "        twice(twice(0));";
        assertEquals(line.indexOf("twice(0)") + "twice(0)".length(), c.getInt("callEndCol"));
    }

    @Test
    void multiLineCallEndsOnLastLine() {
        JSONObject wrap = connectionsFromRun(onDemand).stream()
                .filter(x -> name(onDemand, x.getString("to")).equals("Flow # wrap")).findFirst().orElseThrow();
        assertEquals(wrap.getInt("callLine") + 2, wrap.getInt("callEndLine"));
        assertEquals("        )".length(), wrap.getInt("callEndCol"));
    }

    private static List<String> calleesInExecutionOrder(JSONObject json) {
        List<JSONObject> conns = connectionsFromRun(json);
        conns.forEach(c -> assertTrue(c.has("callEndCol"), "callEndCol missing: " + c));
        conns.sort(Comparator.<JSONObject>comparingInt(c -> c.getInt("callEndLine"))
                .thenComparingInt(c -> c.getInt("callEndCol")));
        List<String> names = new ArrayList<>();
        for (JSONObject c : conns) names.add(name(json, c.getString("to")));
        return names;
    }

    private static List<String> positions(JSONObject json) {
        List<String> out = new ArrayList<>();
        for (JSONObject c : connectionsFromRun(json)) {
            out.add(name(json, c.getString("to")) + "@" + c.getInt("callLine") + "-" + c.getInt("callEndLine")
                    + ":" + c.getInt("callEndCol"));
        }
        Collections.sort(out);
        return out;
    }

    private static List<JSONObject> connectionsFromRun(JSONObject json) {
        String runId = null;
        JSONArray windows = json.getJSONArray("windows");
        for (int i = 0; i < windows.length(); i++) {
            if (windows.getJSONObject(i).getString("displayName").equals("Flow # run")) {
                runId = windows.getJSONObject(i).getString("id");
            }
        }
        assertNotNull(runId, "Flow # run window not found");
        List<JSONObject> out = new ArrayList<>();
        JSONArray conns = json.getJSONArray("connections");
        for (int i = 0; i < conns.length(); i++) {
            if (conns.getJSONObject(i).getString("from").equals(runId)) out.add(conns.getJSONObject(i));
        }
        return out;
    }

    private static String name(JSONObject json, String windowId) {
        JSONArray windows = json.getJSONArray("windows");
        for (int i = 0; i < windows.length(); i++) {
            JSONObject w = windows.getJSONObject(i);
            if (w.getString("id").equals(windowId)) return w.getString("displayName");
        }
        throw new IllegalStateException("window not found: " + windowId);
    }

    private static JSONObject analyze(List<String> args) throws Exception {
        Path out = Files.createTempDirectory("callorder-out-");
        List<String> cmd = new ArrayList<>(args);
        cmd.addAll(List.of("--root", "com.example.callorder.Flow#run()", "--depth", "2",
                "--format", "callcanvas", "--out", out.toString()));
        run(cmd);
        try (Stream<Path> s = Files.list(out)) {
            Path json = s.filter(p -> p.getFileName().toString().startsWith("callcanvas_")).findFirst().orElseThrow();
            return new JSONObject(Files.readString(json, StandardCharsets.UTF_8));
        }
    }

    private static String run(List<String> args) throws Exception {
        List<String> cmd = new ArrayList<>(List.of("java", "-jar", jarPath.toString()));
        cmd.addAll(args);
        Process p = new ProcessBuilder(cmd).redirectErrorStream(true).start();
        String output = new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        assertEquals(0, p.waitFor(), "analyzer failed: " + String.join(" ", cmd) + "\n" + output);
        return output;
    }

    private static void copyTree(Path from, Path to) throws IOException {
        try (Stream<Path> s = Files.walk(from)) {
            for (Path p : (Iterable<Path>) s::iterator) {
                Path dst = to.resolve(from.relativize(p).toString());
                if (Files.isDirectory(p)) Files.createDirectories(dst);
                else Files.copy(p, dst, StandardCopyOption.REPLACE_EXISTING);
            }
        }
    }
}
