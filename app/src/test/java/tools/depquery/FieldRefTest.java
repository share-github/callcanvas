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
 * 型・フィールド参照（CallCanvas JSON の windows[].refs とトップレベル symbols）の検証。
 *
 * <p>sample-project/sample-app-fields（ルート Counter#all(Point)）と sample-project/sample-app-typerefs
 * （ルート TypeRefs#all()）を、インデックス無し（OnDemandIndexer）とインデックス有り（一時コピーに構築）の
 * 両経路で解析し、次を確かめる:
 * <ul>
 *   <li>すべての refs で、window の code の該当行の [col, col+len) がシンボルの単純名と一致し、
 *       symbols の宣言の line の行にその名前がある（タブは 1 文字）</li>
 *   <li>フィールド: this.x・修飾なし x・Foo.CONST・static import・enum 定数（修飾・case ラベル）・継承したフィールド
 *       （修飾なし・this.・super.）・ラムダ内・同じ行の複数参照・タブ混じり行の参照が含まれる</li>
 *   <li>型: フィールド/変数/引数/戻り値の型・型引数・new・キャスト・instanceof・Foo.staticMethod() / Foo.CONST の Foo・
 *       throws / catch・extends / implements（ローカルクラス）・注釈・メソッド参照・完全修飾名（単純名の部分のみ）・
 *       ネスト型（Outer.Inner.Deep の各段）・匿名クラスの生成・型変数の境界</li>
 *   <li>ライブラリのフィールド・型（System.out・String・List・ArrayList）・配列の length・ローカル変数・型変数は含まれない</li>
 *   <li>symbols の宣言情報（名前の行・型・static/final・enum 定数・定数値・typeKind）</li>
 *   <li>両経路の refs と symbols が一致する</li>
 *   <li>世代違い（1.2）のインデックスが残っていても解析はそれを使わず、インデックス無しと同じ refs と symbols を出す</li>
 * </ul>
 */
public class FieldRefTest {

    private static final String PKG = "com.example.fields.";
    private static Path workspaceRoot;
    private static Path jarPath;
    private static final String TPKG = "com.example.typerefs.";
    private static JSONObject onDemand;
    private static JSONObject indexed;
    private static JSONObject onDemandTypes;
    private static JSONObject indexedTypes;

    @BeforeAll
    static void setup() throws Exception {
        Path cur = Path.of(System.getProperty("user.dir")).toAbsolutePath();
        workspaceRoot = cur.getFileName().toString().equals("app") ? cur.getParent() : cur;
        try (Stream<Path> s = Files.list(workspaceRoot.resolve("app/build/libs"))) {
            jarPath = s.filter(p -> p.getFileName().toString().matches("java-call-hierarchy-analyzer-.*\\.jar"))
                    .max(Comparator.comparingLong(p -> p.toFile().lastModified()))
                    .orElseThrow(() -> new IllegalStateException("Run './gradlew shadowJar' first"));
        }
        JSONObject[] fields = analyzeBothWays("sample-app-fields", "Counter#all(Point)");
        onDemand = fields[0];
        indexed = fields[1];
        JSONObject[] types = analyzeBothWays("sample-app-typerefs", "TypeRefs#all()");
        onDemandTypes = types[0];
        indexedTypes = types[1];
    }

    /** [インデックス無し, インデックス有り] の解析結果 */
    private static JSONObject[] analyzeBothWays(String projectName, String root) throws Exception {
        Path project = workspaceRoot.resolve("sample-project").resolve(projectName);
        JSONObject plain = analyze(List.of("--src", project.resolve("src/main/java").toString()), root);
        // インデックス有り: sample-project を汚さないように一時コピーへ構築する
        Path copy = Files.createTempDirectory("fieldref-project-");
        copyTree(project.resolve("src"), copy.resolve("src"));
        String src = copy.resolve("src/main/java").toString();
        run(List.of("--build-index", "--workspace", copy.toString(), "--src", src));
        JSONObject withIndex = analyze(List.of("--workspace", copy.toString(), "--src", src), root);
        return new JSONObject[] {plain, withIndex};
    }

    private static JSONObject analyze(List<String> args, String root) throws Exception {
        Path out = Files.createTempDirectory("fieldref-out-");
        List<String> cmd = new ArrayList<>(args);
        cmd.addAll(List.of("--root", root, "--depth", "2", "--format", "callcanvas", "--out", out.toString()));
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

    /** window の displayName → refs を「行:列:シンボルキー」の集合にしたもの */
    private static Map<String, Set<String>> refsByWindow(JSONObject json) {
        Map<String, Set<String>> map = new TreeMap<>();
        JSONArray windows = json.getJSONArray("windows");
        for (int i = 0; i < windows.length(); i++) {
            JSONObject w = windows.getJSONObject(i);
            Set<String> refs = new TreeSet<>();
            JSONArray arr = w.optJSONArray("refs");
            if (arr != null) {
                for (int j = 0; j < arr.length(); j++) {
                    JSONObject r = arr.getJSONObject(j);
                    refs.add(r.getInt("line") + ":" + r.getInt("col") + ":" + r.getString("symbol"));
                }
            }
            map.put(w.getString("displayName"), refs);
        }
        return map;
    }

    private static void assertRef(String window, int line, int col, String field) {
        assertRef(onDemand, window, line, col, PKG + field);
    }

    private static void assertTypeRef(int line, int col, String symbol) {
        assertRef(onDemandTypes, "TypeRefs # make", line, col, TPKG + symbol);
    }

    private static void assertRef(JSONObject json, String window, int line, int col, String key) {
        Set<String> refs = refsByWindow(json).get(window);
        assertNotNull(refs, "window not found: " + window);
        assertTrue(refs.contains(line + ":" + col + ":" + key),
                "missing ref " + key + " at " + line + ":" + col + " in " + window + ": " + refs);
    }

    /** シンボルキーの単純名（型 a.b.Outer.Inner → Inner、フィールド a.b.Foo#x → x） */
    private static String simpleName(String key) {
        int h = key.indexOf('#');
        return h >= 0 ? key.substring(h + 1) : key.substring(key.lastIndexOf('.') + 1);
    }

    @Test
    void colAndLenPointToSymbolNameInCode() throws IOException {
        for (JSONObject json : List.of(onDemand, indexed, onDemandTypes, indexedTypes)) {
            Path project = workspaceRoot.resolve(json == onDemand || json == indexed
                    ? "sample-project/sample-app-fields" : "sample-project/sample-app-typerefs");
            JSONArray windows = json.getJSONArray("windows");
            JSONObject symbols = json.getJSONObject("symbols");
            int checked = 0;
            for (int i = 0; i < windows.length(); i++) {
                JSONObject w = windows.getJSONObject(i);
                JSONArray arr = w.optJSONArray("refs");
                if (arr == null) continue;
                String[] lines = w.getString("code").split("\n", -1);
                for (int j = 0; j < arr.length(); j++) {
                    JSONObject r = arr.getJSONObject(j);
                    String line = lines[r.getInt("line") - w.getInt("startLine")];
                    String key = r.getString("symbol");
                    String text = line.substring(r.getInt("col"), r.getInt("col") + r.getInt("len"));
                    assertEquals(simpleName(key), text, "ref " + r + " in " + w.getString("displayName"));
                    assertTrue(symbols.has(key), "symbols has no declaration for " + key);
                    checked++;
                }
            }
            assertTrue(checked >= 30, "too few refs: " + checked);
            // 宣言の line の行に名前がある
            for (String key : symbols.keySet()) {
                JSONObject sym = symbols.getJSONObject(key);
                String rel = sym.getString("filePath");
                Path file = project.resolve(rel.substring(rel.indexOf("src/main/java/")));
                String declLine = Files.readAllLines(file).get(sym.getInt("line") - 1);
                assertTrue(java.util.regex.Pattern.compile("\\b" + simpleName(key) + "\\b").matcher(declLine).find(),
                        key + " not on line " + sym.getInt("line") + ": " + declLine);
            }
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
        // 同じ行の複数参照（history.length の length は含めない）。47 行目は引数の型 Point
        assertEquals(Set.of("47:24:" + PKG + "Point", "48:15:" + PKG + "Counter#count", "48:23:" + PKG + "Counter#count",
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
    void containsExpectedTypeReferenceKinds() {
        assertTypeRef(9, 5, "Tag");                 // 注釈
        assertTypeRef(10, 11, "Shape");             // 戻り値の型
        assertTypeRef(10, 22, "Size");              // 引数の型
        assertTypeRef(10, 38, "Circle");            // 型引数（List<Circle> の List は出さない）
        assertTypeRef(10, 62, "ShapeException");    // throws
        assertTypeRef(11, 8, "Circle");             // 変数の型
        assertTypeRef(11, 23, "Circle");            // new
        assertTypeRef(12, 19, "Shape");             // キャスト
        assertTypeRef(13, 25, "Circle");            // instanceof
        assertTypeRef(14, 12, "Registry");          // Foo.staticMethod()
        assertTypeRef(16, 16, "Registry");          // Foo.CONST の Foo
        assertRef(onDemandTypes, "TypeRefs # make", 16, 25, TPKG + "Registry#LIMIT");
        // ネスト型（修飾の各段がそれぞれの型を指す）と、ネスト型の定数
        assertTypeRef(16, 33, "Outer");
        assertTypeRef(16, 39, "Outer.Inner");
        assertTypeRef(16, 45, "Outer.Inner.Deep");
        assertRef(onDemandTypes, "TypeRefs # make", 16, 50, TPKG + "Outer.Inner.Deep#DEPTH");
        assertTypeRef(17, 26, "Outer.Inner");       // 型引数の中のネスト型
        assertTypeRef(18, 29, "Circle");            // 完全修飾名は単純名の部分のみ
        assertTypeRef(19, 48, "Outer.Inner.Deep");  // new Outer.Inner.Deep()
        assertTypeRef(20, 24, "Circle");            // メソッド参照 Circle::area
        assertTypeRef(24, 17, "ShapeException");    // catch
        assertTypeRef(27, 25, "Shape");             // 匿名クラスの生成
        assertTypeRef(30, 28, "Circle");            // extends（ローカルクラス）
        assertTypeRef(30, 46, "Shape");             // implements（ローカルクラス）
        assertTypeRef(33, 20, "Kind");              // enum の修飾
        assertRef(onDemandTypes, "TypeRefs # make", 33, 25, TPKG + "Kind#ROUND");
        assertRef(onDemandTypes, "TypeRefs # same", 37, 29, TPKG + "Shape"); // 型変数の境界

        // 完全修飾名・パッケージ・ライブラリ型（String・List・Map・ArrayList・HashMap）・型変数 T は出さない
        Set<String> make = refsByWindow(onDemandTypes).get("TypeRefs # make");
        for (String r : make) assertTrue(r.contains(":" + TPKG), "unexpected ref " + r);
        assertTrue(make.stream().noneMatch(r -> r.startsWith("21:")), "line 21 has only library types: " + make);
        assertEquals(Set.of("18:29:" + TPKG + "Circle"),
                make.stream().filter(r -> r.startsWith("18:")).collect(java.util.stream.Collectors.toSet()));
        assertEquals(Set.of("37:29:" + TPKG + "Shape"), refsByWindow(onDemandTypes).get("TypeRefs # same"));
        // var は型名を書いていないので出さない（new Size の Size は出す）
        assertEquals(Set.of("41:11:" + TPKG + "Shape", "42:23:" + TPKG + "Size", "43:45:" + TPKG + "Circle"),
                refsByWindow(onDemandTypes).get("TypeRefs # all"));
    }

    @Test
    void typeDeclarations() {
        JSONObject symbols = onDemandTypes.getJSONObject("symbols");
        Map<String, String> kinds = Map.of("Shape", "interface", "Circle", "class", "Kind", "enum",
                "Size", "record", "Tag", "annotation", "Outer.Inner.Deep", "class");
        kinds.forEach((name, kind) -> {
            JSONObject t = symbols.getJSONObject(TPKG + name);
            assertEquals("type", t.getString("kind"), name);
            assertEquals(kind, t.getString("typeKind"), name);
            assertEquals(name, t.getString("displayName"));
        });
        JSONObject deep = symbols.getJSONObject(TPKG + "Outer.Inner.Deep");
        assertEquals(5, deep.getInt("line"));
        assertTrue(deep.getString("filePath").endsWith("src/main/java/com/example/typerefs/Outer.java"));
        assertEquals(7, symbols.getJSONObject(TPKG + "Tag").getInt("line"), "注釈の行ではなく型名の行");
        // 参照されていない型・ライブラリ型・ローカル / 匿名クラスは出さない
        assertFalse(symbols.has(TPKG + "TypeRefs"));
        assertTrue(symbols.keySet().stream().allMatch(k -> k.startsWith(TPKG)), symbols.keySet().toString());
    }

    @Test
    void fieldDeclarations() {
        JSONObject fields = onDemand.getJSONObject("symbols");
        JSONObject name = fields.getJSONObject(PKG + "Constants#DEFAULT_NAME");
        assertEquals("field", name.getString("kind"));
        assertEquals("Constants # DEFAULT_NAME", name.getString("displayName"));
        assertEquals(5, name.getInt("line"), "Javadoc ではなくフィールド名の行");
        assertFalse(name.has("code"));
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
        assertEquals(6, green.getInt("line"));
        assertTrue(green.isNull("value"));

        JSONObject count = fields.getJSONObject(PKG + "Counter#count");
        assertFalse(count.getBoolean("static"));
        assertFalse(count.getBoolean("final"));
        assertEquals(PKG + "Counter", count.getString("declaringClass"));

        assertEquals("List<String>", fields.getJSONObject(PKG + "Counter#names").getString("type"));
        assertEquals("int[]", fields.getJSONObject(PKG + "Counter#history").getString("type"));
        // 1 宣言に複数の変数（注釈の行ではなく名前の行）
        assertEquals(13, fields.getJSONObject(PKG + "Counter#alias").getInt("line"));
        assertEquals(3, fields.getJSONObject(PKG + "Point#x").getInt("line"));
        assertEquals(PKG + "Base", fields.getJSONObject(PKG + "Base#baseCount").getString("declaringClass"));
    }

    /**
     * 世代違い（1.2 以前は refs/symbols を持たない）のインデックスが残っていても、解析はそれを使わずソースを解析し
     * refs/symbols を出す（拡張が再構築するまでの間も定義へ移動が効くように）。
     */
    @Test
    void olderIndexGenerationIsNotUsedForAnalysis() throws Exception {
        Path project = workspaceRoot.resolve("sample-project/sample-app-typerefs");
        Path copy = Files.createTempDirectory("fieldref-stale-");
        copyTree(project.resolve("src"), copy.resolve("src"));
        String src = copy.resolve("src/main/java").toString();
        run(List.of("--build-index", "--workspace", copy.toString(), "--src", src));
        Path cache = copy.resolve(".callcanvas-cache");
        for (String name : List.of("call-index.json", "call-index.meta")) {
            Path f = cache.resolve(name);
            Files.writeString(f, Files.readString(f).replaceFirst("\"version\"\\s*:\\s*\"[^\"]*\"", "\"version\":\"1.2\""));
        }
        Path out = Files.createTempDirectory("fieldref-out-");
        String log = run(List.of("--workspace", copy.toString(), "--src", src, "--root", "TypeRefs#all()", "--depth", "2",
                "--format", "callcanvas", "--out", out.toString()));
        assertTrue(log.contains("built by an older analyzer (version 1.2)"), log);
        JSONObject json;
        try (Stream<Path> s = Files.list(out)) {
            Path p = s.filter(f -> f.getFileName().toString().startsWith("callcanvas_")).findFirst().orElseThrow();
            json = new JSONObject(Files.readString(p, StandardCharsets.UTF_8));
        }
        assertAgree(onDemandTypes, json);
    }

    @Test
    void indexedAndOnDemandAgree() {
        assertAgree(onDemand, indexed);
        assertAgree(onDemandTypes, indexedTypes);
    }

    private static void assertAgree(JSONObject x, JSONObject y) {
        assertEquals(refsByWindow(x), refsByWindow(y));
        JSONObject a = x.getJSONObject("symbols");
        JSONObject b = y.getJSONObject("symbols");
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
