package tools.depquery;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 呼び出しインデックスの差分更新（--build-index の 2 回目以降）がフル構築と同じ結果になることの検証。
 *
 * <p>小さなプロジェクトを一時ディレクトリに作り、1 ステップ編集するたびに差分更新したインデックスと、
 * 同じソースをフル構築したインデックス（call-index.json と依存情報 call-index.deps）を比べる。
 * 呼び出し元の Service.java は一度も編集しない（未変更ファイルが変更の影響を受けるケースを見るため）:
 * 本体だけの変更（依存ファイルを解析し直さない）・オーバーロードの追加・引数型の変更・親への引き上げ・
 * 中間クラスの挿入・多重継承の上位への default メソッドの追加・同一パッケージの型による {@code import q.*} の上書きと
 * その削除・フィールドの引き上げ・override の削除・戻り値の型の変更・同名の定数（symbolIndex のキーが衝突する）の値の変更・
 * コンストラクタのオーバーロードの追加（未変更ファイルの {@code super(1)}・{@code new Repo(1)} の解決先が変わる）。
 * クラスパス（ライブラリの JAR）の追加・版の差し替え・同名クラスによる上書き・削除も、同じくフル構築と比べる。続けてシード固定のランダムな編集列でも比べる。
 */
public class IncrementalIndexTest {

    private static Path jarPath;

    @BeforeAll
    static void setup() throws Exception {
        Path cur = Path.of(System.getProperty("user.dir")).toAbsolutePath();
        Path workspaceRoot = cur.getFileName().toString().equals("app") ? cur.getParent() : cur;
        try (Stream<Path> s = Files.list(workspaceRoot.resolve("app/build/libs"))) {
            jarPath = s.filter(p -> p.getFileName().toString().matches("java-call-hierarchy-analyzer-.*\\.jar"))
                    .max(Comparator.comparingLong(p -> p.toFile().lastModified()))
                    .orElseThrow(() -> new IllegalStateException("Run './gradlew shadowJar' first"));
        }
    }

    /** 編集の状態。render() がソース一式（null = ファイル無し）を作る */
    static final class State {
        boolean bodyEdit;          // Repo.save の本体だけ変える
        boolean dogGreetString;    // Dog に greet(String) を足す（d.greet("x") の解決先が変わる）
        boolean saveTakesBase;     // Repo.save(Dog) → save(Base)
        boolean barkInBase;        // bark() を Dog から Base へ引き上げ
        boolean dogExtendsMammal;  // Dog extends Base → Mammal（中間クラスの挿入）
        boolean baseImplementsLoud;// Base implements Animal, Loud（Loud は default sound() を持つ上位インターフェース）
        boolean localHelper;       // p.Helper を追加（Service の import q.* の Helper を上書き）
        boolean countInBaseRepo;   // Repo.count を BaseRepo へ引き上げ
        boolean dogOverridesSound = true;
        boolean findReturnsBase;   // Repo.find() の戻り値 Dog → Base（saveTakesBase のときだけ）
        boolean repoTagChanged;    // 同名の定数 TAG（Base と Repo）のうち Repo の値を変える（symbolIndex は単純名がキー）
        boolean ctorOverload;      // Base(int)・Repo(int) を足す（未変更の Mammal の super(1)・Service の new Repo(1) の解決先が変わる）

        Map<String, String> render() {
            Map<String, String> f = new LinkedHashMap<>();
            f.put("q/Helper.java", """
                    package q;

                    public class Helper {
                        public static String help() { return "q"; }
                    }
                    """);
            f.put("p/Animal.java", """
                    package p;

                    public interface Animal {
                        String sound();
                    }
                    """);
            f.put("p/Loud.java", """
                    package p;

                    public interface Loud extends Animal {
                        default String sound() { return "loud"; }
                    }
                    """);
            f.put("p/Base.java", "package p;\n\npublic abstract class Base implements Animal"
                    + (baseImplementsLoud ? ", Loud" : "") + " {\n"
                    + "    public static final String TAG = \"base\";\n"
                    + "    public Base() { }\n"
                    + "    public Base(long n) { }\n"
                    + (ctorOverload ? "    public Base(int n) { }\n" : "")
                    + "    public String sound() { return \"\"; }\n"
                    + "    public void greet(Object o) { }\n"
                    + (barkInBase ? "    public void bark() { }\n" : "")
                    + "}\n");
            f.put("p/Mammal.java", """
                    package p;

                    public class Mammal extends Base {
                        public Mammal() { super(1); }

                        @Override
                        public String sound() { return "mammal"; }
                    }
                    """);
            f.put("p/Dog.java", "package p;\n\npublic class Dog extends " + (dogExtendsMammal ? "Mammal" : "Base") + " {\n"
                    + (dogOverridesSound ? "    @Override\n    public String sound() { return \"woof\"; }\n" : "")
                    + (barkInBase ? "" : "    public void bark() { }\n")
                    + (dogGreetString ? "    public void greet(String s) { }\n" : "")
                    + "}\n");
            f.put("p/BaseRepo.java", """
                    package p;

                    public class BaseRepo {
                        public int count;
                    }
                    """);
            f.put("p/Repo.java", "package p;\n\npublic class Repo" + (countInBaseRepo ? " extends BaseRepo" : "") + " {\n"
                    + (countInBaseRepo ? "" : "    public int count;\n")
                    + "    public static final String TAG = \"" + (repoTagChanged ? "repo2" : "repo") + "\";\n"
                    + "    public Repo() { }\n"
                    + "    public Repo(long n) { }\n"
                    + (ctorOverload ? "    public Repo(int n) { }\n" : "")
                    + "    public void save(" + (saveTakesBase ? "Base" : "Dog") + " d) { count" + (bodyEdit ? " += 2" : "++") + "; }\n"
                    + "    public " + (findReturnsBase ? "Base" : "Dog") + " find() { return new Dog(); }\n"
                    + "}\n");
            f.put("p/Helper.java", localHelper ? """
                    package p;

                    public class Helper {
                        public static String help() { return "p"; }
                    }
                    """ : null);
            f.put("p/Service.java", """
                    package p;

                    import q.*;

                    public class Service {
                        private final Repo repo = new Repo();

                        public void run() {
                            Animal a = repo.find();
                            a.sound();
                            repo.save(repo.find());
                            Dog d = new Dog();
                            d.greet("x");
                            d.bark();
                            Helper.help();
                            int n = repo.count;
                            Repo other = new Repo(1);
                        }
                    }
                    """);
            return f;
        }
    }

    /** 差分更新の統計（--timing の SUMMARY incremental） */
    record Incremental(int changed, int deleted, int reparsed, int rounds) {}

    private static final Pattern SUMMARY = Pattern.compile(
            "SUMMARY incremental=changed=(\\d+),deleted=(\\d+),reparsed=(\\d+),rounds=(\\d+)");

    @Test
    void scenariosMatchFullBuild() throws Exception {
        Path project = Files.createTempDirectory("incremental-index-");
        State s = new State();
        write(project, s);
        build(project);

        // 本体だけの変更は、変更ファイルだけを解析する（依存ファイルを足さない）
        s.bodyEdit = true;
        Incremental body = step(project, s, "本体だけの変更");
        assertEquals(1, body.reparsed(), "本体だけの変更で依存ファイルを解析し直した");
        assertEquals(1, body.rounds());

        s.dogGreetString = true;
        assertReparsedService(step(project, s, "オーバーロードの追加"));
        s.saveTakesBase = true;
        assertReparsedService(step(project, s, "引数型の変更"));
        s.barkInBase = true;
        assertReparsedService(step(project, s, "親への引き上げ"));
        s.dogExtendsMammal = true;
        step(project, s, "中間クラスの挿入");
        s.baseImplementsLoud = true;
        step(project, s, "多重継承の上位に default メソッドを追加");
        s.localHelper = true;
        assertReparsedService(step(project, s, "同一パッケージの型で import q.* を上書き"));
        s.localHelper = false;
        assertReparsedService(step(project, s, "上書きした型の削除"));
        s.countInBaseRepo = true;
        assertReparsedService(step(project, s, "フィールドの引き上げ"));
        s.dogOverridesSound = false;
        step(project, s, "override の削除");
        s.findReturnsBase = true;
        step(project, s, "戻り値の型の変更");
        s.repoTagChanged = true;
        step(project, s, "同名の定数の値を変更");
        s.ctorOverload = true;
        Incremental ctor = step(project, s, "コンストラクタのオーバーロードを追加");
        assertTrue(ctor.reparsed() >= ctor.changed() + 2, "未変更の Mammal（super(1)）と Service（new Repo(1)）を解析し直していない: " + ctor);
    }

    /** シード固定のランダムな編集列（どの組み合わせでもコンパイルが通るフラグだけを反転する） */
    @Test
    void randomEditsMatchFullBuild() throws Exception {
        Path project = Files.createTempDirectory("incremental-index-random-");
        State s = new State();
        write(project, s);
        build(project);
        Random rnd = new Random(20261003L);
        String[] flags = {"bodyEdit", "dogGreetString", "saveTakesBase", "barkInBase", "dogExtendsMammal",
                "baseImplementsLoud", "localHelper", "countInBaseRepo", "dogOverridesSound", "repoTagChanged", "ctorOverload"};
        for (int i = 0; i < 16; i++) {
            // 1 ステップで 1〜3 個のフラグを反転する（複数ファイルを同時に変えるケースを含める）
            int n = 1 + rnd.nextInt(3);
            List<String> flipped = new ArrayList<>();
            for (int j = 0; j < n; j++) {
                String flag = flags[rnd.nextInt(flags.length)];
                var field = State.class.getDeclaredField(flag);
                field.setBoolean(s, !field.getBoolean(s));
                flipped.add(flag);
            }
            step(project, s, "ランダム " + (i + 1) + ": " + flipped);
        }
    }

    // ===== クラスパス（ライブラリ）の変化 =====

    /** ライブラリ lib.Lib を使う Uses.java と、使わない Other.java */
    private static final Map<String, String> LIB_PROJECT = Map.of(
            "p/Uses.java", """
                    package p;

                    import lib.Lib;

                    public class Uses {
                        public String run(String s) {
                            return Lib.help(s) + new Lib().name();
                        }
                    }
                    """,
            "p/Other.java", """
                    package p;

                    public class Other {
                        public int size(String s) { return s.length(); }
                    }
                    """);

    /**
     * クラスパスの変化（Zinc のライブラリ依存）: JAR が無い状態からの追加（解決できなかった名前）・同じパスの JAR の
     * 版の差し替え・無関係な JAR の追加（何も解析し直さない）・同名クラスを持つ JAR を前に足す（持ち主の上書き）・
     * その削除・全部の削除。毎回フル構築と比べ、ライブラリを使わない Other.java は解析し直さない。
     */
    @Test
    void classpathChangesMatchFullBuild() throws Exception {
        Path libs = Files.createTempDirectory("incremental-index-libs-");
        Path lib = libs.resolve("lib.jar");
        jar(lib, Map.of("lib/Lib.java", """
                package lib;
                public class Lib {
                    public static String help(String s) { return s; }
                    public String name() { return "v1"; }
                }
                """));
        Path unrelated = libs.resolve("unrelated.jar");
        jar(unrelated, Map.of("q/Unused.java", "package q;\npublic class Unused { public void x() { } }\n"));
        Path shadow = libs.resolve("shadow.jar");
        jar(shadow, Map.of("lib/Lib.java", """
                package lib;
                public class Lib {
                    public static String help(CharSequence s) { return s.toString(); }
                    public String name() { return "shadow"; }
                }
                """));

        Path project = Files.createTempDirectory("incremental-index-cp-");
        write(project, LIB_PROJECT);
        build(project);

        Incremental added = step(project, LIB_PROJECT, List.of(lib), "JAR が無い状態から追加");
        assertEquals(1, added.reparsed(), "解決できなかった Lib を使う Uses.java だけを解析し直す: " + added);

        Thread.sleep(1100); // スタンプ（更新時刻）を確実に変える
        jar(lib, Map.of("lib/Lib.java", """
                package lib;
                public class Lib {
                    public static String help(Object s) { return String.valueOf(s); }
                    public String name() { return "v2"; }
                }
                """));
        Incremental replaced = step(project, LIB_PROJECT, List.of(lib), "同じパスの JAR の版を差し替え");
        assertEquals(1, replaced.reparsed(), "Lib を使う Uses.java だけを解析し直す: " + replaced);

        Incremental noUse = step(project, LIB_PROJECT, List.of(lib, unrelated), "無関係な JAR を追加");
        assertEquals(0, noUse.reparsed(), "どのファイルも使わない JAR で解析し直した: " + noUse);

        Incremental shadowed = step(project, LIB_PROJECT, List.of(shadow, lib, unrelated), "同名クラスの JAR を前に追加");
        assertEquals(1, shadowed.reparsed(), "持ち主が変わった Lib を使う Uses.java だけを解析し直す: " + shadowed);

        step(project, LIB_PROJECT, List.of(lib, unrelated), "同名クラスの JAR を削除");
        Incremental removed = step(project, LIB_PROJECT, List.of(), "JAR を全部削除");
        assertEquals(1, removed.reparsed(), "Lib を使う Uses.java だけを解析し直す: " + removed);
    }

    /** ソースをコンパイルして JAR にする */
    private static void jar(Path jarFile, Map<String, String> sources) throws IOException {
        Path work = Files.createTempDirectory("incremental-index-jar-");
        List<Path> files = new ArrayList<>();
        for (var e : sources.entrySet()) {
            Path f = work.resolve("src").resolve(e.getKey());
            Files.createDirectories(f.getParent());
            Files.writeString(f, e.getValue());
            files.add(f);
        }
        Path classes = Files.createDirectories(work.resolve("classes"));
        javax.tools.JavaCompiler javac = javax.tools.ToolProvider.getSystemJavaCompiler();
        List<String> args = new ArrayList<>(List.of("-d", classes.toString()));
        files.forEach(f -> args.add(f.toString()));
        assertEquals(0, javac.run(null, null, null, args.toArray(String[]::new)), "javac failed");
        try (var out = new java.util.jar.JarOutputStream(Files.newOutputStream(jarFile));
             Stream<Path> walk = Files.walk(classes)) {
            for (Path c : walk.filter(Files::isRegularFile).sorted().toList()) {
                out.putNextEntry(new java.util.jar.JarEntry(classes.relativize(c).toString().replace('\\', '/')));
                out.write(Files.readAllBytes(c));
                out.closeEntry();
            }
        }
    }

    private static void assertReparsedService(Incremental inc) {
        assertTrue(inc.reparsed() > inc.changed(), "未変更の Service.java を解析し直していない: " + inc);
    }

    /** 編集して差分更新し、同じソースのフル構築と比べる */
    private static Incremental step(Path project, State s, String label) throws Exception {
        return step(project, s.render(), List.of(), label);
    }

    /** ソース一式（null = ファイル無し）とクラスパスの JAR で差分更新し、同じ入力のフル構築と比べる */
    private static Incremental step(Path project, Map<String, String> files, List<Path> classpath, String label)
            throws Exception {
        write(project, files);
        String out = build(project, classpath);
        assertTrue(out.contains("Performing incremental update"), label + ": 差分更新になっていない\n" + out);
        Matcher m = SUMMARY.matcher(out);
        assertTrue(m.find(), label + ": SUMMARY incremental が無い\n" + out);
        Incremental inc = new Incremental(Integer.parseInt(m.group(1)), Integer.parseInt(m.group(2)),
                Integer.parseInt(m.group(3)), Integer.parseInt(m.group(4)));

        Path full = Files.createTempDirectory("incremental-index-full-");
        write(full, files);
        build(full, classpath);
        JSONObject a = normalizedIndex(project), b = normalizedIndex(full);
        assertEquals(diff(b, a), "", label + ": 差分更新とフル構築のインデックスが違う（-フル +差分）");
        JSONObject da = deps(project), db = deps(full);
        assertTrue(da.similar(db), label + ": 差分更新とフル構築の依存情報が違う");
        return inc;
    }

    private static void write(Path project, State s) throws IOException {
        write(project, s.render());
    }

    private static void write(Path project, Map<String, String> files) throws IOException {
        Path src = project.resolve("src/main/java");
        for (var e : files.entrySet()) {
            Path f = src.resolve(e.getKey());
            if (e.getValue() == null) {
                Files.deleteIfExists(f);
                continue;
            }
            Files.createDirectories(f.getParent());
            if (!Files.exists(f) || !Files.readString(f).equals(e.getValue())) Files.writeString(f, e.getValue());
        }
    }

    private static String build(Path project) throws Exception {
        return build(project, List.of());
    }

    private static String build(Path project, List<Path> classpath) throws Exception {
        List<String> cmd = new ArrayList<>(List.of("java", "-jar", jarPath.toString(), "--build-index", "--timing",
                "--workspace", project.toString(), "--src", "src/main/java"));
        if (!classpath.isEmpty()) {
            cmd.add("--cp");
            cmd.add(String.join(",", classpath.stream().map(Path::toString).toList()));
        }
        Process p = new ProcessBuilder(cmd).directory(project.toFile()).redirectErrorStream(true).start();
        String output = new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        assertEquals(0, p.waitFor(), "analyzer failed: " + String.join(" ", cmd) + "\n" + output);
        return output;
    }

    /** call-index.json から timestamp を除き、callers を並べ替えたもの（逆引きの並びは構築の順で変わるため） */
    private static JSONObject normalizedIndex(Path project) throws IOException {
        JSONObject idx = new JSONObject(Files.readString(project.resolve(".callcanvas-cache/call-index.json")));
        idx.remove("timestamp");
        JSONObject methods = idx.getJSONObject("methods");
        for (String k : methods.keySet()) {
            JSONObject m = methods.getJSONObject(k);
            List<String> callers = new ArrayList<>();
            JSONArray arr = m.getJSONArray("callers");
            for (int i = 0; i < arr.length(); i++) callers.add(arr.getJSONObject(i).toString());
            Collections.sort(callers);
            JSONArray sorted = new JSONArray();
            for (String c : callers) sorted.put(new JSONObject(c));
            m.put("callers", sorted);
        }
        return idx;
    }

    private static JSONObject deps(Path project) throws IOException {
        return new JSONObject(Files.readString(project.resolve(".callcanvas-cache/call-index.deps")));
    }

    /** トップレベルとメソッド単位の違い（無ければ空文字） */
    private static String diff(JSONObject full, JSONObject incr) {
        StringBuilder sb = new StringBuilder();
        Set<String> keys = new TreeSet<>(full.keySet());
        keys.addAll(incr.keySet());
        for (String k : keys) {
            Object f = full.opt(k), i = incr.opt(k);
            if (f instanceof JSONObject fo && i instanceof JSONObject io) {
                Set<String> sub = new TreeSet<>(fo.keySet());
                sub.addAll(io.keySet());
                for (String s : sub) {
                    Object fv = fo.opt(s), iv = io.opt(s);
                    if (fv == null || iv == null || !(fv instanceof JSONObject a ? a.similar(iv) : fv.equals(iv))) {
                        sb.append(k).append('[').append(s).append("]\n  - ").append(fv).append("\n  + ").append(iv).append('\n');
                    }
                }
            } else if (f == null || !f.equals(i)) {
                sb.append(k).append("\n  - ").append(f).append("\n  + ").append(i).append('\n');
            }
        }
        return sb.toString();
    }
}
