package tools.depquery;

import org.json.JSONArray;
import org.json.JSONObject;
import tools.depquery.CallIndexModels.ConstantEntry;

import java.util.*;

/**
 * 差分更新の依存情報（{@code call-index.deps}）。インクリメンタルコンパイラの考え方を借りる:
 * JDT のビルダーの参照の記録（ReferenceCollection）と、Zinc の name hashing（依存している型の、使っている名前の
 * API が変わったときだけ作り直す）。
 *
 * <p>ファイルごとに次を持つ:
 * <ul>
 *   <li>{@code names} … ファイル中の識別子（単純名。型・メソッド・フィールド・変数。解決できなかった名前も含む）</li>
 *   <li>{@code types} … 解決に使ったソースの型の FQN（書かれた型・変数の型・呼び出し先 / フィールドの宣言クラス・
 *       呼び出し先の引数型と戻り値・ラムダのターゲット型・宣言した型の、それぞれ上位型まで）</li>
 *   <li>{@code libs} … 同じく解決に使ったライブラリ（ソース以外）の型のバイナリ名（上位型まで。JDK の型も入る）</li>
 *   <li>{@code unresolved} … 解決できなかった識別子</li>
 *   <li>{@code api} … 宣言している型（トップレベル・ネスト）ごとの API。ヘッダ（種類・修飾子・型引数・上位型）と、
 *       名前ごとのメンバー（メソッド・コンストラクタの引数型・戻り値・修飾子、フィールドの型・修飾子、メンバー型）の
 *       正規化した表記。メソッドの本体・注釈・throws・定数の値は入れない（呼び出しの解決を変えないので）。
 *       Lombok の生成メソッドもバインディングから取るので入る</li>
 * </ul>
 *
 * <p>変更・追加・削除したファイルの型の API を新旧で比べ、次の未変更ファイルを一緒に解析し直す
 * （{@link #dependents}）。解析し直したファイルの API が変わればさらに繰り返す（呼び出し側 {@link CallIndexBuilder}）:
 * <ul>
 *   <li>型の追加 … その単純名を使うファイル（{@code import x.*} や java.lang の同名の型を上書きしうる）</li>
 *   <li>型の削除・ヘッダの変更 … その型に依存するファイルと、その単純名を使うファイル</li>
 *   <li>メンバーの変更 … その型に依存し、かつ変わった名前を使うファイル</li>
 * </ul>
 * override 辺（CHA）は名前でなく継承関係全体に依存するので、ここでは扱わない（呼び出し側が全メソッドを展開し直す）。
 *
 * <p>クラスパス（ライブラリ）の変化には Zinc のライブラリ依存と同じ考え方で追従する（{@link #libraryDependents}）。
 * 構築に使った JAR の並びとスタンプ（{@code jars}）と、使われたライブラリのクラスの持ち主の JAR（{@code owners}。
 * JDK 等のクラスパスに無いクラスは ""）を持ち、JAR の並びが変わったら、持ち主が変わった・持ち主の JAR が変わった
 * クラスを使うファイルと、増えた・変わった JAR のクラスの単純名が解決できなかったファイルを解析し直す。
 * JDK・言語レベル（{@code environment}）が変わったらフル構築（JDK のクラスは JAR でないので追えない）。
 */
final class IndexDeps {
    static final int FORMAT_VERSION = 3;

    /** 型 1 つの API。header は種類・修飾子・型引数・上位型、members は名前 → その名前のメンバーの表記（並べて連結） */
    record TypeApi(String header, Map<String, String> members) {}

    /**
     * ファイル 1 つの依存情報。constants はそのファイルの定数（symbolIndex の元。同名の定数がファイルをまたいで
     * あるので、どのファイルのものを残すかをフル構築と差分更新で揃えるために持つ。{@link #symbolIndex}）
     */
    record FileDeps(Set<String> names, Set<String> types, Map<String, TypeApi> api,
                    Map<String, ConstantEntry> constants, Set<String> libs, Set<String> unresolved) {}

    /** キー: インデックスのファイル表記（{@code MethodEntry.file} と同じ） */
    final Map<String, FileDeps> files = new HashMap<>();
    /** 解析環境（{@link LibraryIndex#environment}） */
    String environment = "";
    /** 構築に使ったクラスパスの JAR（クラスパス順） */
    List<LibraryIndex.Jar> jars = new ArrayList<>();
    /** 使われたライブラリのクラス → 持ち主の JAR（クラスパスに無いクラスは ""） */
    final Map<String, String> owners = new HashMap<>();

    /**
     * クラスパスが変わったとき、解析し直すべき未変更ファイル（Zinc のライブラリ依存の無効化）:
     * 持ち主の JAR が変わった（別の JAR になった・無くなった）クラスか、持ち主の JAR 自体が変わった（増えた・
     * スタンプが違う）クラスを使うファイルと、増えた・変わった JAR のクラスの単純名かパッケージ名の一部が解決できなかったファイル。
     *
     * @param lib     今回のクラスパス
     * @param exclude 既に解析する・削除したファイル（対象外）
     */
    Set<String> libraryDependents(LibraryIndex lib, Set<String> exclude) {
        Set<LibraryIndex.Jar> before = new HashSet<>(jars);
        Set<String> changedJars = new HashSet<>();
        for (LibraryIndex.Jar j : lib.jars) if (!before.contains(j)) changedJars.add(j.path());
        Set<String> affected = new HashSet<>();
        owners.forEach((cls, oldOwner) -> {
            String now = lib.ownerOf(cls);
            if (!now.equals(oldOwner) || changedJars.contains(now)) affected.add(cls);
        });
        // 増えた・変わった JAR のクラス名とパッケージ名の各部分（a.b.C なら a・b・C）。解決できなかった名前が
        // それで解決できるようになりうる（パッケージ名だけ解決できるようになる import の修飾部分も含めて揃える）
        Set<String> newNames = new HashSet<>();
        for (String jar : changedJars) {
            for (String cls : lib.classesOf(jar)) {
                newNames.add(LibraryIndex.simpleName(cls));
                int dot = cls.lastIndexOf('.');
                if (dot > 0) newNames.addAll(Arrays.asList(cls.substring(0, dot).split("\\.")));
            }
        }
        Set<String> result = new TreeSet<>();
        for (var e : files.entrySet()) {
            if (exclude.contains(e.getKey())) continue;
            FileDeps d = e.getValue();
            if (intersects(d.libs(), affected) || intersects(d.unresolved(), newNames)) result.add(e.getKey());
        }
        return result;
    }

    /** 全ファイルが使うライブラリのクラスの持ち主を、今回のクラスパスで記録し直す（前回の記録で足りれば JAR を読まない） */
    void recordLibraries(LibraryIndex lib, boolean classpathChanged) {
        Map<String, String> next = new HashMap<>();
        for (FileDeps d : files.values()) {
            for (String cls : d.libs()) {
                if (next.containsKey(cls)) continue;
                String known = classpathChanged ? null : owners.get(cls);
                next.put(cls, known != null ? known : lib.ownerOf(cls));
            }
        }
        owners.clear();
        owners.putAll(next);
        jars = new ArrayList<>(lib.jars);
    }

    /**
     * 新旧の API の差から、解析し直すべき未変更ファイルを返す。
     *
     * @param oldApi  解析し直した・削除したファイルの、前回の型 → API
     * @param newApi  解析し直したファイルの、今回の型 → API
     * @param exclude 既に解析した・削除したファイル（対象外）
     */
    Set<String> dependents(Map<String, TypeApi> oldApi, Map<String, TypeApi> newApi, Set<String> exclude) {
        // 型 → 変わった名前（null ならヘッダ・型自体が変わった＝型に依存するもの全部）
        Set<String> byName = new HashSet<>();            // 単純名を使うファイルが対象
        Set<String> byType = new HashSet<>();            // 型に依存するファイルが対象
        Map<String, Set<String>> byMember = new HashMap<>(); // 型に依存し、かつ名前を使うファイルが対象
        Set<String> all = new HashSet<>(oldApi.keySet());
        all.addAll(newApi.keySet());
        for (String type : all) {
            TypeApi o = oldApi.get(type), n = newApi.get(type);
            if (Objects.equals(o, n)) continue;
            if (o == null) {
                byName.add(simpleName(type));
            } else if (n == null || !o.header().equals(n.header())) {
                byName.add(simpleName(type));
                byType.add(type);
            } else {
                Set<String> names = new HashSet<>(o.members().keySet());
                names.addAll(n.members().keySet());
                names.removeIf(k -> Objects.equals(o.members().get(k), n.members().get(k)));
                if (!names.isEmpty()) byMember.put(type, names);
            }
        }
        Set<String> result = new TreeSet<>();
        if (byName.isEmpty() && byType.isEmpty() && byMember.isEmpty()) return result;
        for (var e : files.entrySet()) {
            if (exclude.contains(e.getKey())) continue;
            FileDeps d = e.getValue();
            if (intersects(d.names(), byName) || intersects(d.types(), byType)) {
                result.add(e.getKey());
                continue;
            }
            for (var m : byMember.entrySet()) {
                if (d.types().contains(m.getKey()) && intersects(d.names(), m.getValue())) {
                    result.add(e.getKey());
                    break;
                }
            }
        }
        return result;
    }

    /** 指定ファイル群の型 → API（同じ型が複数ファイルにあれば後勝ち。コンパイルできない状態なのでどちらでもよい） */
    Map<String, TypeApi> apiOf(Collection<String> paths) {
        Map<String, TypeApi> api = new HashMap<>();
        for (String p : paths) {
            FileDeps d = files.get(p);
            if (d != null) api.putAll(d.api());
        }
        return api;
    }

    /**
     * 全ファイルの定数を、ファイルの表記順に後勝ちで重ねた symbolIndex（キーは定数の単純名なので同名が衝突する。
     * フル構築・差分更新で同じものを選ぶため、走査順に依存させない）
     */
    Map<String, ConstantEntry> symbolIndex() {
        Map<String, ConstantEntry> out = new HashMap<>();
        for (var e : new TreeMap<>(files).entrySet()) out.putAll(e.getValue().constants());
        return out;
    }

    static String simpleName(String typeFqn) {
        return typeFqn.substring(typeFqn.lastIndexOf('.') + 1);
    }

    private static boolean intersects(Set<String> a, Set<String> b) {
        if (a.size() > b.size()) { Set<String> t = a; a = b; b = t; }
        for (String s : a) if (b.contains(s)) return true;
        return false;
    }

    // ===== JSON（名前と型は表に入れて番号で引く。ファイル間で重複が多いため） =====

    JSONObject toJson() {
        Map<String, Integer> nameIds = new LinkedHashMap<>();
        Map<String, Integer> typeIds = new LinkedHashMap<>();
        Map<String, Integer> libIds = new LinkedHashMap<>();
        JSONObject filesObj = new JSONObject();
        for (var e : new TreeMap<>(files).entrySet()) {
            FileDeps d = e.getValue();
            JSONObject f = new JSONObject();
            f.put("n", ids(d.names(), nameIds));
            f.put("t", ids(d.types(), typeIds));
            JSONObject api = new JSONObject();
            for (var t : d.api().entrySet()) {
                api.put(t.getKey(), new JSONObject().put("h", t.getValue().header())
                        .put("m", new JSONObject(t.getValue().members())));
            }
            f.put("api", api);
            JSONObject constants = new JSONObject();
            d.constants().forEach((k, v) -> constants.put(k, v.toJson()));
            f.put("c", constants);
            f.put("l", ids(d.libs(), libIds));
            f.put("u", ids(d.unresolved(), nameIds));
            filesObj.put(e.getKey(), f);
        }
        JSONArray jarsArr = new JSONArray();
        for (LibraryIndex.Jar j : jars) jarsArr.put(new JSONArray().put(j.path()).put(j.stamp()));
        JSONObject ownersObj = new JSONObject();
        new TreeMap<>(owners).forEach(ownersObj::put);
        return new JSONObject()
                .put("version", FORMAT_VERSION)
                .put("environment", environment)
                .put("jars", jarsArr)
                .put("owners", ownersObj)
                .put("names", new JSONArray(nameIds.keySet()))
                .put("types", new JSONArray(typeIds.keySet()))
                .put("libs", new JSONArray(libIds.keySet()))
                .put("files", filesObj);
    }

    private static JSONArray ids(Set<String> values, Map<String, Integer> table) {
        JSONArray a = new JSONArray();
        for (String v : new TreeSet<>(values)) a.put(table.computeIfAbsent(v, k -> table.size()));
        return a;
    }

    /** 読めない・版が違うときは null（呼び出し側はフル構築する） */
    static IndexDeps fromJson(JSONObject obj) {
        if (obj.optInt("version", -1) != FORMAT_VERSION) return null;
        JSONArray names = obj.getJSONArray("names");
        JSONArray types = obj.getJSONArray("types");
        JSONArray libs = obj.getJSONArray("libs");
        JSONObject filesObj = obj.getJSONObject("files");
        IndexDeps deps = new IndexDeps();
        deps.environment = obj.getString("environment");
        JSONArray jarsArr = obj.getJSONArray("jars");
        for (int i = 0; i < jarsArr.length(); i++) {
            JSONArray j = jarsArr.getJSONArray(i);
            deps.jars.add(new LibraryIndex.Jar(j.getString(0), j.getString(1)));
        }
        JSONObject ownersObj = obj.getJSONObject("owners");
        for (String k : ownersObj.keySet()) deps.owners.put(k, ownersObj.getString(k));
        for (String path : filesObj.keySet()) {
            JSONObject f = filesObj.getJSONObject(path);
            Set<String> n = new HashSet<>();
            JSONArray na = f.getJSONArray("n");
            for (int i = 0; i < na.length(); i++) n.add(names.getString(na.getInt(i)));
            Set<String> t = new HashSet<>();
            JSONArray ta = f.getJSONArray("t");
            for (int i = 0; i < ta.length(); i++) t.add(types.getString(ta.getInt(i)));
            Map<String, TypeApi> api = new HashMap<>();
            JSONObject apiObj = f.getJSONObject("api");
            for (String type : apiObj.keySet()) {
                JSONObject a = apiObj.getJSONObject(type);
                JSONObject m = a.getJSONObject("m");
                Map<String, String> members = new HashMap<>();
                for (String k : m.keySet()) members.put(k, m.getString(k));
                api.put(type, new TypeApi(a.getString("h"), members));
            }
            Map<String, ConstantEntry> constants = new LinkedHashMap<>();
            JSONObject c = f.getJSONObject("c");
            for (String k : c.keySet()) {
                JSONObject e = c.getJSONObject(k);
                constants.put(k, new ConstantEntry(e.getString("value"), e.getString("qualifier"), e.getString("type")));
            }
            Set<String> l = new HashSet<>();
            JSONArray la = f.getJSONArray("l");
            for (int i = 0; i < la.length(); i++) l.add(libs.getString(la.getInt(i)));
            Set<String> u = new HashSet<>();
            JSONArray ua = f.getJSONArray("u");
            for (int i = 0; i < ua.length(); i++) u.add(names.getString(ua.getInt(i)));
            deps.files.put(path, new FileDeps(n, t, api, constants, l, u));
        }
        return deps;
    }
}
