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
 * フィールド参照（CallCanvas JSON の windows[].fieldRefs とトップレベル fields）の検証。
 *
 * <p>sample-project/sample-app-fields を、インデックス無し（OnDemandIndexer）とインデックス有り（一時コピーに構築）の
 * 両経路で解析し、次を確かめる:
 * <ul>
 *   <li>すべての fieldRefs で、window の code の該当行の [col, col+len) がフィールド名と一致する（タブは 1 文字）</li>
 *   <li>this.x・修飾なし x・Foo.CONST・static import・enum 定数（修飾・case ラベル）・継承したフィールド
 *       （修飾なし・this.・super.）・ラムダ内・同じ行の複数参照・タブ混じり行の参照が含まれる</li>
 *   <li>ライブラリのフィールド（System.out）・配列の length・ローカル変数は含まれない</li>
 *   <li>fields の宣言情報（Javadoc 込みの開始行・型・static/final・enum 定数・定数値）</li>
 *   <li>両経路の fieldRefs と fields が一致する</li>
 * </ul>
 */
public class FieldRefTest {

    private static final String PKG = "com.example.fields.";
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
        Path project = workspaceRoot.resolve("sample-project/sample-app-fields");

        Path out1 = Files.createTempDirectory("fieldref-ondemand-");
        onDemand = analyze(List.of("--src", project.resolve("src/main/java").toString()), out1);

        // インデックス有り: sample-project を汚さないように一時コピーへ構築する
        Path copy = Files.createTempDirectory("fieldref-project-");
        copyTree(project.resolve("src"), copy.resolve("src"));
        String src = copy.resolve("src/main/java").toString();
        run(List.of("--build-index", "--workspace", copy.toString(), "--src", src));
        Path out2 = Files.createTempDirectory("fieldref-indexed-");
        indexed = analyze(List.of("--workspace", copy.toString(), "--src", src), out2);
    }

    private static JSONObject analyze(List<String> args, Path out) throws Exception {
        List<String> cmd = new ArrayList<>(args);
        cmd.addAll(List.of("--root", "Counter#all(Point)", "--depth", "2", "--format", "callcanvas", "--out", out.toString()));
        run(cmd);
        try (Stream<Path> s = Files.list(out)) {
            Path json = s.filter(p -> p.getFileName().toString().startsWith("callcanvas_")).findFirst().orElseThrow();
            return new JSONObject(Files.readString(json, StandardCharsets.UTF_8));
        }
    }

    private static void run(List<String> args) throws Exception {
        List<String> cmd = new ArrayList<>(List.of("java", "-jar", jarPath.toString()));
        cmd.addAll(args);
        Process p = new ProcessBuilder(cmd).redirectErrorStream(true).start();
        String output = new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        assertEquals(0, p.waitFor(), "analyzer failed: " + String.join(" ", cmd) + "\n" + output);
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

    /** window の displayName → fieldRefs を「行:列:フィールドキー」の集合にしたもの */
    private static Map<String, Set<String>> refsByWindow(JSONObject json) {
        Map<String, Set<String>> map = new TreeMap<>();
        JSONArray windows = json.getJSONArray("windows");
        for (int i = 0; i < windows.length(); i++) {
            JSONObject w = windows.getJSONObject(i);
            Set<String> refs = new TreeSet<>();
            JSONArray arr = w.optJSONArray("fieldRefs");
            if (arr != null) {
                for (int j = 0; j < arr.length(); j++) {
                    JSONObject r = arr.getJSONObject(j);
                    refs.add(r.getInt("line") + ":" + r.getInt("col") + ":" + r.getString("field"));
                }
            }
            map.put(w.getString("displayName"), refs);
        }
        return map;
    }

    private static void assertRef(String window, int line, int col, String field) {
        Set<String> refs = refsByWindow(onDemand).get(window);
        assertNotNull(refs, "window not found: " + window);
        assertTrue(refs.contains(line + ":" + col + ":" + PKG + field),
                "missing ref " + field + " at " + line + ":" + col + " in " + window + ": " + refs);
    }

    @Test
    void colAndLenPointToFieldNameInCode() {
        for (JSONObject json : List.of(onDemand, indexed)) {
            JSONArray windows = json.getJSONArray("windows");
            int checked = 0;
            for (int i = 0; i < windows.length(); i++) {
                JSONObject w = windows.getJSONObject(i);
                JSONArray arr = w.optJSONArray("fieldRefs");
                if (arr == null) continue;
                String[] lines = w.getString("code").split("\n", -1);
                for (int j = 0; j < arr.length(); j++) {
                    JSONObject r = arr.getJSONObject(j);
                    String line = lines[r.getInt("line") - w.getInt("startLine")];
                    String field = r.getString("field");
                    String text = line.substring(r.getInt("col"), r.getInt("col") + r.getInt("len"));
                    assertEquals(field.substring(field.indexOf('#') + 1), text, "ref " + r + " in " + w.getString("displayName"));
                    assertTrue(json.getJSONObject("fields").has(field), "fields has no declaration for " + field);
                    checked++;
                }
            }
            assertTrue(checked >= 30, "too few refs: " + checked);
        }
    }

    @Test
    void containsExpectedReferenceKinds() {
        // this.x と修飾なし x（同じ行の複数参照を含む）
        assertRef("Counter # increment", 20, 13, "Counter#count");
        assertRef("Counter # increment", 21, 8, "Counter#count");
        assertRef("Counter # increment", 21, 16, "Counter#count");
        // Foo.CONST と static import
        assertRef("Counter # describe", 26, 29, "Constants#DEFAULT_NAME");
        assertRef("Counter # describe", 27, 20, "Constants#MAX");
        assertRef("Counter # describe", 28, 20, "Constants#MAX");
        // enum 定数（case ラベルと修飾付き）、継承した static フィールド
        assertRef("Counter # describe", 31, 17, "Color#RED");
        assertRef("Counter # describe", 32, 33, "Color#RED");
        assertRef("Counter # describe", 34, 42, "Base#prefix");
        assertRef("Counter # all", 63, 49, "Color#GREEN");
        // 継承したフィールド（修飾なし・this.・super.）
        assertRef("Counter # inherited", 39, 8, "Base#baseCount");
        assertRef("Counter # inherited", 40, 20, "Base#baseCount");
        assertRef("Counter # inherited", 40, 38, "Base#baseCount");
        // ラムダ内
        assertRef("Counter # lambda", 44, 21, "Counter#count");
        assertRef("Counter # lambda", 44, 29, "Base#baseCount");
        // 同じ行の複数参照（history.length の length は含めない）
        assertEquals(Set.of("48:15:" + PKG + "Counter#count", "48:23:" + PKG + "Counter#count",
                        "48:31:" + PKG + "Base#baseCount", "48:43:" + PKG + "Counter#history"),
                refsByWindow(onDemand).get("Counter # sameLine"));
        // タブ混じりの行（タブは 1 文字）。System.out（ライブラリ）は含めない
        assertEquals(Set.of("52:5:" + PKG + "Counter#count", "53:2:" + PKG + "Counter#label",
                        "53:10:" + PKG + "Counter#alias", "55:21:" + PKG + "Counter#label"),
                refsByWindow(onDemand).get("Counter # tabs"));
        // record のコンポーネント
        assertRef("Point # sum", 5, 15, "Point#x");
        assertRef("Point # sum", 5, 19, "Point#y");
    }

    @Test
    void fieldDeclarations() {
        JSONObject fields = onDemand.getJSONObject("fields");
        JSONObject name = fields.getJSONObject(PKG + "Constants#DEFAULT_NAME");
        assertEquals("Constants # DEFAULT_NAME", name.getString("displayName"));
        assertEquals(4, name.getInt("startLine"), "Javadoc を含む開始行");
        assertEquals(5, name.getInt("endLine"));
        assertEquals("    /** 既定の名前 */\n    public static final String DEFAULT_NAME = \"anon\";", name.getString("code"));
        assertEquals("String", name.getString("type"));
        assertEquals("\"anon\"", name.getString("value"));
        assertTrue(name.getBoolean("static"));
        assertTrue(name.getBoolean("final"));
        assertFalse(name.getBoolean("enumConstant"));
        assertTrue(name.getString("filePath").endsWith("src/main/java/com/example/fields/Constants.java"));

        assertEquals("10 * 2", fields.getJSONObject(PKG + "Constants#MAX").getString("value"));
        // static final でも初期化子が無い（static ブロックで代入）なら定数ではない
        assertTrue(fields.getJSONObject(PKG + "Constants#TIMEOUT_MS").isNull("value"));

        JSONObject green = fields.getJSONObject(PKG + "Color#GREEN");
        assertTrue(green.getBoolean("enumConstant"));
        assertEquals("Color", green.getString("type"));
        assertEquals(5, green.getInt("startLine"));
        assertTrue(green.isNull("value"));

        JSONObject count = fields.getJSONObject(PKG + "Counter#count");
        assertFalse(count.getBoolean("static"));
        assertFalse(count.getBoolean("final"));
        assertEquals(PKG + "Counter", count.getString("declaringClass"));

        assertEquals("List<String>", fields.getJSONObject(PKG + "Counter#names").getString("type"));
        assertEquals("int[]", fields.getJSONObject(PKG + "Counter#history").getString("type"));
        // 1 宣言に複数の変数（注釈込みの範囲を共有する）
        JSONObject alias = fields.getJSONObject(PKG + "Counter#alias");
        assertEquals(12, alias.getInt("startLine"));
        assertEquals(13, alias.getInt("endLine"));
        assertEquals(PKG + "Base", fields.getJSONObject(PKG + "Base#baseCount").getString("declaringClass"));
    }

    @Test
    void indexedAndOnDemandAgree() {
        assertEquals(refsByWindow(onDemand), refsByWindow(indexed));
        JSONObject a = onDemand.getJSONObject("fields");
        JSONObject b = indexed.getJSONObject("fields");
        assertEquals(new TreeSet<>(a.keySet()), new TreeSet<>(b.keySet()));
        for (String key : a.keySet()) {
            JSONObject fa = new JSONObject(a.getJSONObject(key).toString());
            JSONObject fb = new JSONObject(b.getJSONObject(key).toString());
            // filePath は解析したプロジェクトの場所で変わるので末尾だけ比べる
            String pa = fa.getString("filePath"), pb = fb.getString("filePath");
            assertTrue(pa.endsWith(pb) || pb.endsWith(pa), key + ": " + pa + " vs " + pb);
            fa.remove("filePath");
            fb.remove("filePath");
            assertTrue(fa.similar(fb), key + ": " + fa + " vs " + fb);
        }
    }
}
