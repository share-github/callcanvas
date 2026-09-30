package tools.depquery;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

/**
 * ゴールデンファイル（期待値JSON）を更新するユーティリティ
 * 
 * 使用方法:
 *   ./gradlew updateGoldenFiles                        # 全ての期待値を更新
 *   ./gradlew updateGoldenFiles --args='sample-app-animal'  # 特定のテストケースのみ
 */
public class GoldenFileUpdater {

    private static Path workspaceRoot;
    private static Path goldenDir;
    private static Path jarPath;

    public static void main(String[] args) throws Exception {
        // ワークスペースルートを検出
        workspaceRoot = detectWorkspaceRoot();
        goldenDir = workspaceRoot.resolve("app/src/test/resources/golden");
        
        // JARパスを動的に検出
        try {
            jarPath = findAnalyzerJar(workspaceRoot);
        } catch (Exception e) {
            System.err.println("ERROR: " + e.getMessage());
            System.exit(1);
        }

        System.out.println("Workspace root: " + workspaceRoot);
        System.out.println("Golden dir: " + goldenDir);
        System.out.println("JAR path: " + jarPath);

        if (!Files.exists(jarPath)) {
            System.err.println("ERROR: JAR not found: " + jarPath);
            System.err.println("Run './gradlew shadowJar' first.");
            System.exit(1);
        }

        if (!Files.exists(goldenDir)) {
            System.err.println("ERROR: Golden directory not found: " + goldenDir);
            System.exit(1);
        }

        // 対象のテストケースを決定
        Set<String> targetCases = new HashSet<>();
        if (args.length > 0) {
            for (String arg : args) {
                targetCases.add(arg);
            }
        }

        // 各テストケースを処理
        try (var dirs = Files.list(goldenDir)) {
            dirs.filter(Files::isDirectory)
                .sorted()
                .forEach(testCaseDir -> {
                    String name = testCaseDir.getFileName().toString();
                    if (targetCases.isEmpty() || targetCases.contains(name)) {
                        try {
                            updateGoldenFile(testCaseDir);
                        } catch (Exception e) {
                            System.err.println("ERROR updating " + name + ": " + e.getMessage());
                            e.printStackTrace();
                        }
                    }
                });
        }

        System.out.println("\nDone!");
    }

    private static Path detectWorkspaceRoot() {
        Path current = Path.of(System.getProperty("user.dir"));
        while (current != null) {
            if (Files.exists(current.resolve("app/build.gradle")) && 
                Files.exists(current.resolve("sample-project"))) {
                return current;
            }
            if (Files.exists(current.resolve("build.gradle")) && 
                current.getFileName().toString().equals("app")) {
                return current.getParent();
            }
            current = current.getParent();
        }
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

    private static void updateGoldenFile(Path testCaseDir) throws Exception {
        String testName = testCaseDir.getFileName().toString();
        Path configPath = testCaseDir.resolve("config.json");
        Path expectedPath = testCaseDir.resolve("expected.json");

        System.out.println("\n=== Updating: " + testName + " ===");

        if (!Files.exists(configPath)) {
            System.err.println("SKIP: config.json not found");
            return;
        }

        // 設定を読み込み
        JSONObject config = new JSONObject(Files.readString(configPath, StandardCharsets.UTF_8));

        // 解析CLIを実行
        String actualJson = runAnalyzer(config);

        // JSONを正規化
        JSONObject normalized = normalizeJson(new JSONObject(actualJson));

        // 整形して保存
        String prettyJson = normalized.toString(2);
        Files.writeString(expectedPath, prettyJson, StandardCharsets.UTF_8);

        System.out.println("Updated: " + expectedPath);
        System.out.println("  Windows: " + normalized.getJSONArray("windows").length());
        System.out.println("  Connections: " + normalized.getJSONArray("connections").length());
    }

    private static String runAnalyzer(JSONObject config) throws Exception {
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
        if (!(hasRoot ^ hasRootClass)) {
            throw new IllegalArgumentException("config must have exactly one of 'root' or 'rootClass' (mutually exclusive)");
        }

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
        Path tempDir = Files.createTempDirectory("golden-update-");
        command.add("--out");
        command.add(tempDir.toString());

        System.out.println("Command: " + String.join(" ", command));

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
            throw new RuntimeException("Analyzer did not produce any callcanvas JSON file\n" +
                 "Exit code: " + exitCode + "\n" +
                 "Output:\n" + output);
        }

        String jsonContent = Files.readString(outputJson, StandardCharsets.UTF_8);

        // 一時ファイルを削除
        deleteDirectory(tempDir);

        return jsonContent;
    }

    /**
     * Call indexを事前構築
     */
    private static void buildCallIndex(JSONObject config, Path projectRoot) throws Exception {
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
        
        System.out.println("Build index: " + String.join(" ", command));
        
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
        
        int exitCode = process.waitFor();
        if (exitCode != 0) {
            throw new RuntimeException("Failed to build call index\n" +
                 "Exit code: " + exitCode + "\n" +
                 "Output:\n" + output);
        }
    }

    /**
     * callcanvas.json を正規化
     * - ファイルパスをプレースホルダーに置換
     * - position（UIレイアウト情報）を除外
     * - windows を displayName でソート
     */
    private static JSONObject normalizeJson(JSONObject json) {
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
                if (window.has("fieldRefs")) {
                    normalizedWindow.put("fieldRefs", window.getJSONArray("fieldRefs"));
                }
                
                // ファイルパスを正規化（ワークスペースルートを除去）
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

        // fields（filePath はウィンドウと同じくワークスペースルートを除去）
        if (json.has("fields")) {
            JSONObject fields = json.getJSONObject("fields");
            JSONObject normalizedFields = new JSONObject();
            for (String key : fields.keySet()) {
                JSONObject f = new JSONObject(fields.getJSONObject(key).toString());
                if (f.has("filePath")) {
                    f.put("filePath", f.getString("filePath").replace(workspaceRoot.toString() + "/", ""));
                }
                normalizedFields.put(key, f);
            }
            normalized.put("fields", normalizedFields);
        }

        return normalized;
    }

    private static JSONArray sortJsonArray(JSONArray array, String key) {
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

    private static JSONArray sortConnectionsArray(JSONArray array) {
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
     * カンマ区切りのパスをそれぞれプロジェクトルートで解決する
     */
    private static String resolvePaths(Path projectRoot, String commaSeparatedPaths) {
        return Arrays.stream(commaSeparatedPaths.split(","))
            .map(String::trim)
            .map(p -> projectRoot.resolve(p).toString())
            .reduce((a, b) -> a + "," + b)
            .orElse("");
    }

    private static void deleteDirectory(Path dir) throws IOException {
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


