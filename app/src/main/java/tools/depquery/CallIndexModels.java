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
        @JsonProperty("type")
        String type;

        CallRef() {}

        CallRef(String fqn, int line, int endLine, String type) {
            this.fqn = fqn;
            this.line = line;
            this.endLine = endLine;
            this.type = type;
        }

        JSONObject toJson() {
            var obj = new JSONObject();
            obj.put("fqn", fqn);
            obj.put("line", line);
            obj.put("endLine", endLine);
            obj.put("type", type);
            return obj;
        }

        static CallRef fromJson(JSONObject obj) {
            return new CallRef(
                obj.getString("fqn"),
                obj.getInt("line"),
                obj.getInt("endLine"),
                obj.getString("type")
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

        void addCaller(String callerFqn, int line, int endLine, String type) {
            callers.add(new CallRef(callerFqn, line, endLine, type));
        }

        void addCallee(String calleeFqn, int line, int endLine, String type) {
            callees.add(new CallRef(calleeFqn, line, endLine, type));
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

        CallIndex() {
            this.version = "1.0";
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
            return index;
        }
    }
}
