package tools.depquery;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;
import org.json.JSONArray;
import org.json.JSONObject;

import java.util.*;

/**
 * Call Index のデータモデルクラス
 */
class CallIndexModels {

    @JsonIgnoreProperties(ignoreUnknown = true)
    static class CallRef {
        @JsonProperty("fqn")
        String fqn;
        @JsonProperty("line")
        int line;
        @JsonProperty("endLine")
        int endLine;
        /** 呼び出し式の終端の直後の列（0 始まり、UTF-16）。override の辺は元の呼び出しのもの。1.3 以前の読み込みでは 0 */
        @JsonProperty("endCol")
        int endCol;
        @JsonProperty("type")
        String type;
        /**
         * 仮想呼び出し（CHA で override を展開する対象）か。差分更新で未変更メソッドの override 辺を
         * 新しい継承関係で展開し直すのに使う（callees のみ。true のときだけ書く）
         */
        @JsonProperty("virtual")
        boolean virtual;

        CallRef() {}

        CallRef(String fqn, int line, int endLine, int endCol, String type) {
            this(fqn, line, endLine, endCol, type, false);
        }

        CallRef(String fqn, int line, int endLine, int endCol, String type, boolean virtual) {
            this.fqn = fqn;
            this.line = line;
            this.endLine = endLine;
            this.endCol = endCol;
            this.type = type;
            this.virtual = virtual;
        }

        JSONObject toJson() {
            var obj = new JSONObject();
            obj.put("fqn", fqn);
            obj.put("line", line);
            obj.put("endLine", endLine);
            obj.put("endCol", endCol);
            obj.put("type", type);
            if (virtual) obj.put("virtual", true);
            return obj;
        }

        static CallRef fromJson(JSONObject obj) {
            return new CallRef(
                obj.getString("fqn"),
                obj.getInt("line"),
                obj.getInt("endLine"),
                obj.optInt("endCol", 0),
                obj.getString("type"),
                obj.optBoolean("virtual", false)
            );
        }
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    static class MethodEntry {
        @JsonProperty("fqn")
        String fqn;
        @JsonProperty("file")
        String file;
        @JsonProperty("lineStart")
        int lineStart;
        @JsonProperty("lineEnd")
        int lineEnd;
        @JsonProperty("callers")
        List<CallRef> callers;
        @JsonProperty("callees")
        List<CallRef> callees;
        @JsonProperty("display")
        String display;
        @JsonProperty("classFqn")
        String classFqn;
        @JsonProperty("methodName")
        String methodName;
        @JsonProperty("paramsFqn")
        List<String> paramsFqn;
        @JsonProperty("annotations")
        List<String> annotations;
        @JsonProperty("stereotype")
        String stereotype;
        /**
         * 本体内のシンボル（型・フィールド）参照。1 件 = {@code "行:列:長さ:シンボルキー"}（{@link SymbolRef}）。
         * 宣言の有無は出力時に {@link CallIndex#getSymbol} で確かめる（無いものは出さない）
         */
        @JsonProperty("refs")
        List<String> refs = new ArrayList<>();

        MethodEntry() {}

        MethodEntry(String fqn, String file, int lineStart, int lineEnd) {
            this.fqn = fqn;
            this.file = file;
            this.lineStart = lineStart;
            this.lineEnd = lineEnd;
            this.callers = new ArrayList<>();
            this.callees = new ArrayList<>();
            this.paramsFqn = new ArrayList<>();
            this.annotations = new ArrayList<>();
        }

        MethodEntry(String fqn, String file, int lineStart, int lineEnd,
                   String display, String classFqn, String methodName,
                   List<String> paramsFqn, List<String> annotations, String stereotype) {
            this.fqn = fqn;
            this.file = file;
            this.lineStart = lineStart;
            this.lineEnd = lineEnd;
            this.display = display;
            this.classFqn = classFqn;
            this.methodName = methodName;
            this.paramsFqn = paramsFqn != null ? new ArrayList<>(paramsFqn) : new ArrayList<>();
            this.annotations = annotations != null ? new ArrayList<>(annotations) : new ArrayList<>();
            this.stereotype = stereotype;
            this.callers = new ArrayList<>();
            this.callees = new ArrayList<>();
        }

        void addCaller(String callerFqn, int line, int endLine, int endCol, String type) {
            callers.add(new CallRef(callerFqn, line, endLine, endCol, type));
        }

        void addCallee(String calleeFqn, int line, int endLine, int endCol, String type) {
            addCallee(calleeFqn, line, endLine, endCol, type, false);
        }

        void addCallee(String calleeFqn, int line, int endLine, int endCol, String type, boolean virtual) {
            callees.add(new CallRef(calleeFqn, line, endLine, endCol, type, virtual));
        }

        JSONObject toJson() {
            var obj = new JSONObject();
            obj.put("fqn", fqn);
            obj.put("file", file);
            obj.put("lineStart", lineStart);
            obj.put("lineEnd", lineEnd);
            if (display != null) obj.put("display", display);
            if (classFqn != null) obj.put("classFqn", classFqn);
            if (methodName != null) obj.put("methodName", methodName);
            if (paramsFqn != null && !paramsFqn.isEmpty()) {
                obj.put("paramsFqn", new JSONArray(paramsFqn));
            }
            if (annotations != null && !annotations.isEmpty()) {
                obj.put("annotations", new JSONArray(annotations));
            }
            if (stereotype != null) obj.put("stereotype", stereotype);
            if (refs != null && !refs.isEmpty()) obj.put("refs", new JSONArray(refs));
            var callersArr = new JSONArray();
            for (var caller : callers) {
                callersArr.put(caller.toJson());
            }
            obj.put("callers", callersArr);
            var calleesArr = new JSONArray();
            for (var callee : callees) {
                calleesArr.put(callee.toJson());
            }
            obj.put("callees", calleesArr);
            return obj;
        }

        static MethodEntry fromJson(JSONObject obj) {
            var entry = new MethodEntry(
                obj.getString("fqn"),
                obj.getString("file"),
                obj.getInt("lineStart"),
                obj.getInt("lineEnd")
            );
            if (obj.has("display")) entry.display = obj.getString("display");
            if (obj.has("classFqn")) entry.classFqn = obj.getString("classFqn");
            if (obj.has("methodName")) entry.methodName = obj.getString("methodName");
            if (obj.has("paramsFqn")) {
                JSONArray paramsArr = obj.getJSONArray("paramsFqn");
                entry.paramsFqn = new ArrayList<>();
                for (int i = 0; i < paramsArr.length(); i++) {
                    entry.paramsFqn.add(paramsArr.getString(i));
                }
            }
            if (obj.has("annotations")) {
                JSONArray annsArr = obj.getJSONArray("annotations");
                entry.annotations = new ArrayList<>();
                for (int i = 0; i < annsArr.length(); i++) {
                    entry.annotations.add(annsArr.getString(i));
                }
            }
            if (obj.has("stereotype")) entry.stereotype = obj.getString("stereotype");
            if (obj.has("refs")) {
                JSONArray refsArr = obj.getJSONArray("refs");
                for (int i = 0; i < refsArr.length(); i++) {
                    entry.refs.add(refsArr.getString(i));
                }
            }
            JSONArray callersArr = obj.getJSONArray("callers");
            for (int i = 0; i < callersArr.length(); i++) {
                entry.callers.add(CallRef.fromJson(callersArr.getJSONObject(i)));
            }
            JSONArray calleesArr = obj.getJSONArray("callees");
            for (int i = 0; i < calleesArr.length(); i++) {
                entry.callees.add(CallRef.fromJson(calleesArr.getJSONObject(i)));
            }
            return entry;
        }
    }

    /**
     * シンボル参照 1 件の符号化（インデックスを小さく保つため文字列 1 つにまとめる）。
     * line は 1 始まりの絶対行、col はその行内の 0 始まりの char offset（タブは 1 文字）、len は識別子の長さ。
     * symbol はシンボルキー（型は FQN、フィールドは {@code 宣言クラスFQN#名前}）。
     */
    record SymbolRef(int line, int col, int len, String symbol) {
        String encode() {
            return line + ":" + col + ":" + len + ":" + symbol;
        }

        static SymbolRef decode(String s) {
            String[] p = s.split(":", 4);
            if (p.length < 4) return null;
            try {
                return new SymbolRef(Integer.parseInt(p[0]), Integer.parseInt(p[1]), Integer.parseInt(p[2]), p[3]);
            } catch (NumberFormatException e) {
                return null;
            }
        }
    }

    /**
     * プロジェクトのソースにある型・フィールド（enum 定数・record のコンポーネントを含む）の宣言。
     * キーは型なら FQN（ネストは Outer.Inner）、フィールドなら {@code 宣言クラスFQN#名前}。
     * CallCanvas JSON の symbols の元（displayName・filePath は出力時に作る）。
     */
    @JsonIgnoreProperties(ignoreUnknown = true)
    static class SymbolEntry {
        static final String TYPE = "type";
        static final String FIELD = "field";

        /** "type" / "field" */
        @JsonProperty("kind")
        String kind;
        @JsonProperty("file")
        String file;
        /** 宣言の名前がある行（ジャンプ先） */
        @JsonProperty("line")
        int line;
        /** type のみ: class / interface / enum / record / annotation */
        @JsonProperty("typeKind")
        String typeKind;
        /** 型の表示名（パッケージを除いた名前。ネストは Outer.Inner）。type のみ */
        @JsonProperty("name")
        String name;
        /** field のみ: 宣言型（ソース上の表記） */
        @JsonProperty("type")
        String type;
        @JsonProperty("declaringClass")
        String declaringClass;
        @JsonProperty("static")
        boolean isStatic;
        @JsonProperty("final")
        boolean isFinal;
        @JsonProperty("enumConstant")
        boolean enumConstant;
        /** field のみ: コンパイル時定数なら初期化子のソース表記、それ以外は null */
        @JsonProperty("value")
        String value;

        SymbolEntry() {}

        static SymbolEntry type(String file, int line, String name, String typeKind) {
            var e = new SymbolEntry();
            e.kind = TYPE;
            e.file = file;
            e.line = line;
            e.name = name;
            e.typeKind = typeKind;
            return e;
        }

        static SymbolEntry field(String file, int line, String type, String declaringClass,
                                 boolean isStatic, boolean isFinal, boolean enumConstant, String value) {
            var e = new SymbolEntry();
            e.kind = FIELD;
            e.file = file;
            e.line = line;
            e.type = type;
            e.declaringClass = declaringClass;
            e.isStatic = isStatic;
            e.isFinal = isFinal;
            e.enumConstant = enumConstant;
            e.value = value;
            return e;
        }

        boolean isType() {
            return TYPE.equals(kind);
        }

        JSONObject toJson() {
            var obj = new JSONObject();
            obj.put("kind", kind);
            obj.put("file", file);
            obj.put("line", line);
            if (isType()) {
                obj.put("name", name);
                obj.put("typeKind", typeKind);
                return obj;
            }
            obj.put("type", type);
            obj.put("declaringClass", declaringClass);
            if (isStatic) obj.put("static", true);
            if (isFinal) obj.put("final", true);
            if (enumConstant) obj.put("enumConstant", true);
            if (value != null) obj.put("value", value);
            return obj;
        }

        static SymbolEntry fromJson(JSONObject obj) {
            if (TYPE.equals(obj.optString("kind"))) {
                return type(obj.getString("file"), obj.getInt("line"), obj.optString("name", null),
                        obj.optString("typeKind", null));
            }
            return field(obj.getString("file"), obj.getInt("line"),
                    obj.optString("type", null), obj.optString("declaringClass", null),
                    obj.optBoolean("static"), obj.optBoolean("final"), obj.optBoolean("enumConstant"),
                    obj.has("value") && !obj.isNull("value") ? obj.getString("value") : null);
        }
    }

    static class ConstantEntry {
        @JsonProperty("value")
        String value;
        @JsonProperty("qualifier")
        String qualifier;
        @JsonProperty("type")
        String type;

        ConstantEntry() {}

        ConstantEntry(String value, String qualifier, String type) {
            this.value = value;
            this.qualifier = qualifier;
            this.type = type;
        }

        JSONObject toJson() {
            return new JSONObject().put("value", value).put("qualifier", qualifier).put("type", type);
        }
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    static class CallIndex {
        /**
         * 構築した解析器の世代。1.0 = JavaParser 版、1.1 = JDT 版（ファイル形式は同じ）、
         * 1.2 = フィールド参照（methods[].fieldRefs と fields）を追加、
         * 1.3 = 型参照を加えて汎用化（methods[].refs と symbols。fieldRefs / fields は廃止）、
         * 1.4 = 呼び出しの終端の列（callers / callees の endCol。同じ行の呼び出しの実行順）を追加、
         * 1.5 = 差分更新の依存情報（callees の virtual と call-index.deps）を追加。
         * 世代が違うインデックスは差分更新せずフル再構築する（新旧の解析結果を混在させないため）。
         * 解析では世代違いを使わずソースを解析する。上げたら拡張の CALL_INDEX_VERSION（extension.ts）も合わせる。
         */
        static final String CURRENT_VERSION = "1.5";

        @JsonProperty("version")
        String version;
        @JsonProperty("timestamp")
        String timestamp;
        @JsonProperty("fileHashes")
        Map<String, String> fileHashes;
        @JsonProperty("methods")
        Map<String, MethodEntry> methods;
        @JsonProperty("symbolIndex")
        Map<String, ConstantEntry> symbolIndex = new HashMap<>();
        /** 型・フィールドの宣言（キー: 型の FQN / 宣言クラスFQN#名前） */
        @JsonProperty("symbols")
        Map<String, SymbolEntry> symbols = new HashMap<>();

        CallIndex() {
            this.version = CURRENT_VERSION;
            this.timestamp = java.time.Instant.now().toString();
            this.fileHashes = new HashMap<>();
            this.methods = new HashMap<>();
        }

        void addMethod(MethodEntry entry) {
            methods.put(entry.fqn, entry);
        }

        MethodEntry getMethod(String fqn) {
            return methods.get(fqn);
        }

        /** 型・フィールドの宣言（Lazy 実装ではサイドカーから読むためオーバーライド可能）。無ければ null */
        SymbolEntry getSymbol(String key) {
            return symbols.get(key);
        }

        /** メソッド総数（Lazy 実装では offset 件数を返すためオーバーライド可能）。 */
        int methodCount() {
            return methods.size();
        }

        /** 全メソッド FQN の集合（Lazy 実装では offset キーを返すためオーバーライド可能）。 */
        Set<String> allMethodFqns() {
            return methods.keySet();
        }

        void setFileHash(String filePath, String hash) {
            fileHashes.put(filePath, hash);
        }

        String getFileHash(String filePath) {
            return fileHashes.get(filePath);
        }

        JSONObject toJson() {
            var obj = new JSONObject();
            obj.put("version", version);
            obj.put("timestamp", timestamp);
            var hashesObj = new JSONObject();
            for (var entry : fileHashes.entrySet()) {
                hashesObj.put(entry.getKey(), entry.getValue());
            }
            obj.put("fileHashes", hashesObj);
            var methodsObj = new JSONObject();
            for (var entry : methods.entrySet()) {
                methodsObj.put(entry.getKey(), entry.getValue().toJson());
            }
            obj.put("methods", methodsObj);
            if (!symbolIndex.isEmpty()) {
                var symObj = new JSONObject();
                symbolIndex.forEach((k, v) -> symObj.put(k, v.toJson()));
                obj.put("symbolIndex", symObj);
            }
            if (!symbols.isEmpty()) {
                var symbolsObj = new JSONObject();
                symbols.forEach((k, v) -> symbolsObj.put(k, v.toJson()));
                obj.put("symbols", symbolsObj);
            }
            return obj;
        }

        static CallIndex fromJson(JSONObject obj) {
            var index = new CallIndex();
            index.version = obj.getString("version");
            index.timestamp = obj.getString("timestamp");
            JSONObject hashesObj = obj.getJSONObject("fileHashes");
            for (String key : hashesObj.keySet()) {
                index.fileHashes.put(key, hashesObj.getString(key));
            }
            JSONObject methodsObj = obj.getJSONObject("methods");
            for (String key : methodsObj.keySet()) {
                index.methods.put(key, MethodEntry.fromJson(methodsObj.getJSONObject(key)));
            }
            if (obj.has("symbolIndex")) {
                JSONObject symObj = obj.getJSONObject("symbolIndex");
                for (String key : symObj.keySet()) {
                    JSONObject e = symObj.getJSONObject(key);
                    index.symbolIndex.put(key, new ConstantEntry(
                        e.getString("value"), e.getString("qualifier"), e.getString("type")));
                }
            }
            if (obj.has("symbols")) {
                JSONObject symbolsObj = obj.getJSONObject("symbols");
                for (String key : symbolsObj.keySet()) {
                    index.symbols.put(key, SymbolEntry.fromJson(symbolsObj.getJSONObject(key)));
                }
            }
            return index;
        }
    }
}
