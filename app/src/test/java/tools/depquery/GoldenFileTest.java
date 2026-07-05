package tools.depquery;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.TestFactory;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.*;

/**
 * ゴールデンファイル（スナップショット）テスト
 * 
 * 解析CLIの出力JSONが期待値と一致することを検証する。
 * 
 * テストデータ構造:
 *   src/test/resources/golden/{test-case-name}/
 *     ├── config.json      # 解析パラメータ
 *     └── expected.json    # 期待値JSON
 * 
 * 使用方法:
 *   ./gradlew test                    # テスト実行
 *   ./gradlew updateGoldenFiles       # 期待値を更新
 */
public class GoldenFileTest {

    private static Path workspaceRoot;
    private static Path goldenDir;
    private static Path jarPath;

    @BeforeAll
    static void setup() throws Exception {
        // ワークスペースルートを検出
        workspaceRoot = detectWorkspaceRoot();
        goldenDir = workspaceRoot.resolve("app/src/test/resources/golden");
        
        // JARパスを動的に検出
        try {
            jarPath = findAnalyzerJar(workspaceRoot);
        } catch (Exception e) {
            System.err.println("[WARN] " + e.getMessage());
        }
        
        // JARが存在しない場合はスキップ
        if (jarPath == null || !Files.exists(jarPath)) {
            System.err.println("[WARN] JAR not found. Run './gradlew shadowJar' first.");
        }
    }

    private static Path detectWorkspaceRoot() {
        // 現在のディレクトリから遡ってワークスペースルートを検出
        Path current = Path.of(System.getProperty("user.dir"));
        while (current != null) {
            if (Files.exists(current.resolve("app/build.gradle")) && 
                Files.exists(current.resolve("sample-project"))) {
                return current;
            }
            // Gradleが app/ から実行される場合
            if (Files.exists(current.resolve("build.gradle")) && 
                current.getFileName().toString().equals("app")) {
                return current.getParent();
            }
            current = current.getParent();
        }
        // フォールバック
        return Path.of(System.getProperty("user.dir")).getParent();
    }

    private static Path findAnalyzerJar(Path workspaceRoot) throws IOException {
        Path libsDir = workspaceRoot.resolve("app/build/libs");
        if (!Files.exists(libsDir)) {
            throw new FileNotFoundException(
                "Libs directory not found: " + libsDir + ". Run './gradlew shadowJar' first.");
        }
        try (var stream = Files.list(libsDir)) {
            return stream
                .filter(p -> p.getFileName().toString().matches("java-call-hierarchy-analyzer-.*\\.jar"))
                .filter(p -> !p.getFileName().toString().contains("-sources"))
                .max(Comparator.comparingLong(p -> {
                    try {
                        return Files.getLastModifiedTime(p).toMillis();
                    } catch (IOException e) {
                        return 0;
                    }
                }))
                .orElseThrow(() -> new FileNotFoundException(
                    "Analyzer JAR not found in " + libsDir + ". Run './gradlew shadowJar' first."));
        }
    }

    @TestFactory
    Stream<DynamicTest> goldenFileTests() throws IOException {
        if (!Files.exists(goldenDir)) {
            return Stream.empty();
        }

        return Files.list(goldenDir)
            .filter(Files::isDirectory)
            .sorted()
            .map(testCaseDir -> DynamicTest.dynamicTest(
                testCaseDir.getFileName().toString(),
                () -> runGoldenTest(testCaseDir)
            ));
    }

    private void runGoldenTest(Path testCaseDir) throws Exception {
        String testName = testCaseDir.getFileName().toString();
        Path configPath = testCaseDir.resolve("config.json");
        Path expectedPath = testCaseDir.resolve("expected.json");

        assertTrue(Files.exists(configPath), 
            "config.json not found for test case: " + testName);
        assertTrue(Files.exists(expectedPath), 
            "expected.json not found for test case: " + testName);
        assertTrue(Files.exists(jarPath),
            "JAR not found. Run './gradlew shadowJar' first: " + jarPath);

        // 設定を読み込み
        JSONObject config = new JSONObject(Files.readString(configPath, StandardCharsets.UTF_8));
        
        // 解析CLIを実行
        String actualJson = runAnalyzer(config);
        
        // 期待値を読み込み
        String expectedJson = Files.readString(expectedPath, StandardCharsets.UTF_8);

        // JSON比較（パスを正規化）
        JSONObject actual = normalizeJson(new JSONObject(actualJson));
        JSONObject expected = normalizeJson(new JSONObject(expectedJson));

        // 詳細な差分を表示
        String diff = compareJsonObjects(expected, actual);
        if (!diff.isEmpty()) {
            fail("JSON mismatch for " + testName + ":\n" + diff + 
                 "\n\n--- Expected (first 2000 chars) ---\n" + truncate(expected.toString(2), 2000) +
                 "\n\n--- Actual (first 2000 chars) ---\n" + truncate(actual.toString(2), 2000));
        }
    }

    private String runAnalyzer(JSONObject config) throws Exception {
        // プロジェクトパスを解決
        String projectPath = config.optString("projectPath", ".");
        Path projectRoot = workspaceRoot.resolve(projectPath).normalize();

        // buildIndexフラグがある場合は事前にインデックスを構築
        if (config.optBoolean("buildIndex", false)) {
            buildCallIndex(config, projectRoot);
        }

        List<String> command = new ArrayList<>();
        command.add("java");
        command.add("-jar");
        command.add(jarPath.toString());

        // 必須パラメータ: root と rootClass はいずれか一方必須（排他）
        boolean hasRoot = config.has("root");
        boolean hasRootClass = config.has("rootClass");
        assertTrue(hasRoot ^ hasRootClass,
            "config must have exactly one of 'root' or 'rootClass' (mutually exclusive)");

        command.add("--src");
        command.add(resolvePaths(projectRoot, config.getString("src")));

        if (hasRootClass) {
            command.add("--root-class");
            command.add(config.getString("rootClass"));
        } else {
            command.add("--root");
            command.add(config.getString("root"));
        }

        command.add("--depth");
        command.add(String.valueOf(config.getInt("depth")));

        command.add("--format");
        command.add("callcanvas");

        // buildIndexフラグがある場合は--workspaceを追加（インデックスを使用）
        if (config.optBoolean("buildIndex", false)) {
            command.add("--workspace");
            command.add(projectRoot.toString());
        }

        // オプションパラメータ
        if (config.has("classes")) {
            command.add("--classes");
            command.add(resolvePaths(projectRoot, config.getString("classes")));
        }
        if (config.has("cp")) {
            command.add("--cp");
            command.add(resolvePaths(projectRoot, config.getString("cp")));
        }
        if (config.has("cpdir")) {
            command.add("--cpdir");
            command.add(resolvePaths(projectRoot, config.getString("cpdir")));
        }
        if (config.has("exclude")) {
            command.add("--exclude");
            command.add(config.getString("exclude"));
        }
        if (config.has("include")) {
            command.add("--include");
            command.add(config.getString("include"));
        }
        if (config.has("direction")) {
            command.add("--direction");
            command.add(config.getString("direction"));
        }

        // 出力先を一時ディレクトリに設定
        Path tempDir = Files.createTempDirectory("golden-test-");
        command.add("--out");
        command.add(tempDir.toString());

        // 実行
        ProcessBuilder pb = new ProcessBuilder(command);
        pb.redirectErrorStream(true);
        Process process = pb.start();

        // 標準出力を読み取り
        String output;
        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
            output = reader.lines().reduce("", (a, b) -> a + "\n" + b);
        }

        // 標準エラー出力を読み取り（[CALLCANVAS_FILE]マーカーはstderrに出力される）
        String stderr;
        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(process.getErrorStream(), StandardCharsets.UTF_8))) {
            stderr = reader.lines().reduce("", (a, b) -> a + "\n" + b);
        }

        int exitCode = process.waitFor();

        // 出力JSONファイルを読み取り（動的ファイル名対応）
        Path outputJson = null;

        // Strategy 1: Parse [CALLCANVAS_FILE] marker from stderr (stdout is reserved for JSON)
        String marker = "[CALLCANVAS_FILE]";
        for (String line : stderr.split("\n")) {
            if (line.contains(marker)) {
                String fullPath = line.substring(line.indexOf(marker) + marker.length()).trim();
                outputJson = Paths.get(fullPath);
                if (Files.exists(outputJson)) {
                    break;
                }
            }
        }

        // Strategy 2: Search for callcanvas_*.json pattern
        if (outputJson == null || !Files.exists(outputJson)) {
            try (var stream = Files.list(tempDir)) {
                Optional<Path> found = stream
                    .filter(p -> p.getFileName().toString().startsWith("callcanvas_")
                              && p.getFileName().toString().endsWith(".json"))
                    .max(Comparator.comparingLong(p -> {
                        try {
                            return Files.getLastModifiedTime(p).toMillis();
                        } catch (IOException e) {
                            return 0;
                        }
                    }));
                if (found.isPresent()) {
                    outputJson = found.get();
                }
            }
        }

        // Strategy 3: Fallback to legacy callcanvas.json
        if (outputJson == null || !Files.exists(outputJson)) {
            Path legacyPath = tempDir.resolve("callcanvas.json");
            if (Files.exists(legacyPath)) {
                outputJson = legacyPath;
            }
        }

        if (outputJson == null || !Files.exists(outputJson)) {
            fail("Analyzer did not produce any callcanvas JSON file\n" +
                 "Exit code: " + exitCode + "\n" +
                 "Command: " + String.join(" ", command) + "\n" +
                 "Output:\n" + output);
        }

        // Class-level: output filename must be callcanvas_<SimpleClassName>.json (rootClass 時は resolvedRoots を参照しない)
        if (config.has("rootClass")) {
            String rootClassFqn = config.getString("rootClass");
            int lastDot = rootClassFqn.lastIndexOf('.');
            int lastDollar = rootClassFqn.lastIndexOf('$');
            int cut = Math.max(lastDot, lastDollar);
            String simpleClassName = (cut >= 0) ? rootClassFqn.substring(cut + 1) : rootClassFqn;
            String expectedFilename = "callcanvas_" + simpleClassName + ".json";
            assertEquals(expectedFilename, outputJson.getFileName().toString(),
                "Class-level analysis must output file: " + expectedFilename);
        }

        String jsonContent = Files.readString(outputJson, StandardCharsets.UTF_8);

        // 一時ファイルを削除
        deleteDirectory(tempDir);

        return jsonContent;
    }

    /**
     * Call indexを事前構築
     */
    private void buildCallIndex(JSONObject config, Path projectRoot) throws Exception {
        List<String> command = new ArrayList<>();
        command.add("java");
        command.add("-jar");
        command.add(jarPath.toString());
        
        command.add("--build-index");
        command.add("--workspace");
        command.add(projectRoot.toString());
        command.add("--src");
        command.add(resolvePaths(projectRoot, config.getString("src")));
        
        if (config.has("classes")) {
            command.add("--classes");
            command.add(resolvePaths(projectRoot, config.getString("classes")));
        }
        if (config.has("cp")) {
            command.add("--cp");
            command.add(resolvePaths(projectRoot, config.getString("cp")));
        }
        if (config.has("cpdir")) {
            command.add("--cpdir");
            command.add(resolvePaths(projectRoot, config.getString("cpdir")));
        }
        
        // 実行
        ProcessBuilder pb = new ProcessBuilder(command);
        pb.redirectErrorStream(true);
        Process process = pb.start();
        
        // 標準出力を読み取り（デバッグ用）
        String output;
        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
            output = reader.lines().reduce("", (a, b) -> a + "\n" + b);
        }
        
        int exitCode = process.waitFor();
        if (exitCode != 0) {
            fail("Failed to build call index\n" +
                 "Exit code: " + exitCode + "\n" +
                 "Command: " + String.join(" ", command) + "\n" +
                 "Output:\n" + output);
        }
    }

    /**
     * callcanvas.json を正規化
     * - ファイルパスをプレースホルダーに置換
     * - position（UIレイアウト情報）を除外
     * - windows を displayName でソート
     */
    private JSONObject normalizeJson(JSONObject json) {
        JSONObject normalized = new JSONObject();

        // autoLayout
        if (json.has("autoLayout")) {
            normalized.put("autoLayout", json.getBoolean("autoLayout"));
        }

        // windows
        if (json.has("windows")) {
            JSONArray normalizedWindows = new JSONArray();
            JSONArray windows = json.getJSONArray("windows");
            for (int i = 0; i < windows.length(); i++) {
                JSONObject window = windows.getJSONObject(i);
                JSONObject normalizedWindow = new JSONObject();
                
                // 比較対象のフィールドのみコピー（positionは除外）
                normalizedWindow.put("id", window.getString("id"));
                normalizedWindow.put("displayName", window.getString("displayName"));
                normalizedWindow.put("startLine", window.getInt("startLine"));
                normalizedWindow.put("code", window.getString("code"));
                
                if (window.has("highlightLines")) {
                    normalizedWindow.put("highlightLines", window.getJSONArray("highlightLines"));
                }
                if (window.has("collapsed")) {
                    normalizedWindow.put("collapsed", window.getBoolean("collapsed"));
                }
                
                // ファイルパスを正規化
                if (window.has("filePath")) {
                    String filePath = window.getString("filePath");
                    filePath = filePath.replace(workspaceRoot.toString() + "/", "");
                    normalizedWindow.put("filePath", filePath);
                }
                
                normalizedWindows.put(normalizedWindow);
            }
            // displayName でソートして順序を安定化
            normalized.put("windows", sortJsonArray(normalizedWindows, "displayName"));
        }

        // connections
        if (json.has("connections")) {
            JSONArray normalizedConnections = new JSONArray();
            JSONArray connections = json.getJSONArray("connections");
            for (int i = 0; i < connections.length(); i++) {
                normalizedConnections.put(connections.getJSONObject(i));
            }
            // from, to でソート
            normalized.put("connections", sortConnectionsArray(normalizedConnections));
        }

        // symbolIndex（そのままコピー）
        if (json.has("symbolIndex")) {
            normalized.put("symbolIndex", json.getJSONObject("symbolIndex"));
        }

        return normalized;
    }

    private JSONArray sortJsonArray(JSONArray array, String key) {
        List<JSONObject> list = new ArrayList<>();
        for (int i = 0; i < array.length(); i++) {
            list.add(array.getJSONObject(i));
        }
        list.sort(Comparator.comparing(obj -> obj.optString(key, "")));
        
        JSONArray sorted = new JSONArray();
        for (JSONObject obj : list) {
            sorted.put(obj);
        }
        return sorted;
    }

    private JSONArray sortConnectionsArray(JSONArray array) {
        List<JSONObject> list = new ArrayList<>();
        for (int i = 0; i < array.length(); i++) {
            list.add(array.getJSONObject(i));
        }
        list.sort(Comparator
            .comparing((JSONObject obj) -> obj.optString("from", ""))
            .thenComparing(obj -> obj.optString("to", "")));
        
        JSONArray sorted = new JSONArray();
        for (JSONObject obj : list) {
            sorted.put(obj);
        }
        return sorted;
    }

    /**
     * 2つのJSONオブジェクト（callcanvas.json形式）を比較し、差分を文字列で返す
     */
    private String compareJsonObjects(JSONObject expected, JSONObject actual) {
        StringBuilder diff = new StringBuilder();

        // windows比較
        if (expected.has("windows") && actual.has("windows")) {
            JSONArray expWindows = expected.getJSONArray("windows");
            JSONArray actWindows = actual.getJSONArray("windows");
            
            if (expWindows.length() != actWindows.length()) {
                diff.append("windows count mismatch: expected ")
                    .append(expWindows.length())
                    .append(", actual ")
                    .append(actWindows.length())
                    .append("\n");
            }

            // displayNameをキーにして比較
            Map<String, JSONObject> expMap = toMapByDisplayName(expWindows);
            Map<String, JSONObject> actMap = toMapByDisplayName(actWindows);

            for (String name : expMap.keySet()) {
                if (!actMap.containsKey(name)) {
                    diff.append("Missing window: ").append(name).append("\n");
                }
            }
            for (String name : actMap.keySet()) {
                if (!expMap.containsKey(name)) {
                    diff.append("Unexpected window: ").append(name).append("\n");
                }
            }
        }

        // connections比較
        if (expected.has("connections") && actual.has("connections")) {
            JSONArray expConns = expected.getJSONArray("connections");
            JSONArray actConns = actual.getJSONArray("connections");
            
            if (expConns.length() != actConns.length()) {
                diff.append("connections count mismatch: expected ")
                    .append(expConns.length())
                    .append(", actual ")
                    .append(actConns.length())
                    .append("\n");
            }

            // connectionをキーにして比較
            Set<String> expConnSet = toConnectionKeySet(expConns);
            Set<String> actConnSet = toConnectionKeySet(actConns);

            for (String key : expConnSet) {
                if (!actConnSet.contains(key)) {
                    diff.append("Missing connection: ").append(key).append("\n");
                }
            }
            for (String key : actConnSet) {
                if (!expConnSet.contains(key)) {
                    diff.append("Unexpected connection: ").append(key).append("\n");
                }
            }
        }

        // symbolIndex比較
        boolean expHasSym = expected.has("symbolIndex");
        boolean actHasSym = actual.has("symbolIndex");
        if (expHasSym != actHasSym) {
            diff.append("symbolIndex presence mismatch: expected=").append(expHasSym)
                .append(", actual=").append(actHasSym).append("\n");
        } else if (expHasSym) {
            JSONObject expSym = expected.getJSONObject("symbolIndex");
            JSONObject actSym = actual.getJSONObject("symbolIndex");
            for (String key : expSym.keySet()) {
                if (!actSym.has(key)) {
                    diff.append("Missing symbolIndex key: ").append(key).append("\n");
                } else if (!expSym.getJSONObject(key).similar(actSym.getJSONObject(key))) {
                    diff.append("symbolIndex value mismatch for key '").append(key)
                        .append("': expected=").append(expSym.getJSONObject(key))
                        .append(", actual=").append(actSym.getJSONObject(key)).append("\n");
                }
            }
            for (String key : actSym.keySet()) {
                if (!expSym.has(key)) {
                    diff.append("Unexpected symbolIndex key: ").append(key).append("\n");
                }
            }
        }

        return diff.toString();
    }

    private Map<String, JSONObject> toMapByDisplayName(JSONArray array) {
        Map<String, JSONObject> map = new HashMap<>();
        for (int i = 0; i < array.length(); i++) {
            JSONObject obj = array.getJSONObject(i);
            map.put(obj.optString("displayName", String.valueOf(i)), obj);
        }
        return map;
    }

    private Set<String> toConnectionKeySet(JSONArray array) {
        Set<String> set = new HashSet<>();
        for (int i = 0; i < array.length(); i++) {
            JSONObject conn = array.getJSONObject(i);
            String key = conn.optString("from", "") + " -> " + conn.optString("to", "");
            set.add(key);
        }
        return set;
    }

    /**
     * カンマ区切りのパスをそれぞれプロジェクトルートで解決する
     */
    private String resolvePaths(Path projectRoot, String commaSeparatedPaths) {
        return Arrays.stream(commaSeparatedPaths.split(","))
            .map(String::trim)
            .map(p -> projectRoot.resolve(p).toString())
            .reduce((a, b) -> a + "," + b)
            .orElse("");
    }

    private String truncate(String s, int maxLen) {
        return s.length() > maxLen ? s.substring(0, maxLen) + "..." : s;
    }

    private void deleteDirectory(Path dir) throws IOException {
        if (Files.exists(dir)) {
            Files.walk(dir)
                .sorted(Comparator.reverseOrder())
                .forEach(path -> {
                    try {
                        Files.delete(path);
                    } catch (IOException e) {
                        // ignore
                    }
                });
        }
    }
}


