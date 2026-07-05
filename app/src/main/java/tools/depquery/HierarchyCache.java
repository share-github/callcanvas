package tools.depquery;

import org.json.JSONObject;

import java.io.IOException;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/**
 * クラス継承関係のキャッシュを管理するクラス。
 * 大規模プロジェクトでのCHA（Class Hierarchy Analysis）を高速化する。
 * 
 * - 初回: フルスキャン → キャッシュ保存
 * - 2回目以降: キャッシュ読み込み → 更新日時で差分検出 → 変更ファイルのみ再スキャン
 * - --rebuild-cache: 強制フルスキャン
 */
public class HierarchyCache {

    private static final int CACHE_VERSION = 2;
    private static final String CACHE_FILE_NAME = "hierarchy.json";

    private final Path cacheDir;
    private final List<Path> srcRoots;

    // Key: 親クラス/インターフェースのFQN, Value: 直接のサブクラスのFQNのSet
    private final Map<String, Set<String>> hierarchy = new ConcurrentHashMap<>();

    // Key: ファイル相対パス, Value: ファイル情報（更新日時、継承関係）
    private final Map<String, FileInfo> fileIndex = new ConcurrentHashMap<>();

    // Key: 子クラスFQN, Value: 親クラス/インターフェースのFQNリスト（extends + implements）
    private final Map<String, List<String>> childToParents = new ConcurrentHashMap<>();

    private boolean dirty = false;

    // 継承関係抽出用の正規表現パターン
    private static final Pattern CLASS_EXTENDS = Pattern.compile(
            "(?:class|interface)\\s+(\\w+)(?:<[^>]*>)?\\s+extends\\s+([\\w.<>,\\s]+?)(?:\\s+implements|\\s*\\{)");
    private static final Pattern CLASS_IMPLEMENTS = Pattern.compile(
            "class\\s+(\\w+)(?:<[^>]*>)?(?:\\s+extends\\s+[\\w.<>,\\s]+)?\\s+implements\\s+([\\w.<>,\\s]+?)\\s*\\{");
    private static final Pattern INTERFACE_EXTENDS = Pattern.compile(
            "interface\\s+(\\w+)(?:<[^>]*>)?\\s+extends\\s+([\\w.<>,\\s]+?)\\s*\\{");

    record FileInfo(long mtime, List<String> extendsClasses, List<String> implementsClasses) {
    }

    public HierarchyCache(Path cacheDir, List<Path> srcRoots) {
        this.cacheDir = cacheDir;
        this.srcRoots = srcRoots;
    }

    /**
     * キャッシュを初期化する。
     * キャッシュが存在すれば読み込み＋差分更新、なければフルスキャン。
     * 
     * @param forceRebuild trueの場合、キャッシュを無視してフルスキャン
     */
    public void initialize(boolean forceRebuild) {
        if (forceRebuild) {
            System.out.println("[INFO] Rebuilding hierarchy cache (forced)...");
            rebuild();
            return;
        }

        Path cacheFile = cacheDir.resolve(CACHE_FILE_NAME);
        if (Files.exists(cacheFile)) {
            int loadResult = load(cacheFile);
            switch (loadResult) {
                case 0 -> {
                    // 完全ロード成功 → 差分更新
                    updateIfNeeded();
                }
                case 1 -> {
                    // mtime情報のみロード（バージョン不一致）→ mtime情報を使って効率的に再構築
                    rebuildWithMtimeHints();
                }
                default -> {
                    // ロード失敗 → フルスキャン
                    rebuild();
                }
            }
        } else {
            System.out.println("[INFO] Building hierarchy cache (first time)...");
            rebuild();
        }
    }

    /**
     * キャッシュをファイルから読み込む
     * 
     * @return 0: 完全ロード成功, 1: mtime+継承情報ロード（バージョン不一致）, -1: ロード失敗
     */
    private int load(Path cacheFile) {
        try {
            String content = Files.readString(cacheFile);
            JSONObject json = new JSONObject(content);

            int version = json.optInt("version", 0);
            boolean versionMismatch = (version != CACHE_VERSION);

            if (versionMismatch) {
                System.out.println("[INFO] Cache version mismatch (v" + version + " -> v" + CACHE_VERSION
                        + "), will rebuild with cached hints...");
            }

            // fileIndex を読み込み（バージョン不一致でも継承情報を読み込む - mtimeが同じファイルは再利用可能）
            JSONObject filesJson = json.optJSONObject("files");
            if (filesJson != null) {
                for (String filePath : filesJson.keySet()) {
                    JSONObject fileJson = filesJson.getJSONObject(filePath);
                    long mtime = fileJson.getLong("mtime");
                    List<String> extendsClasses = new ArrayList<>();
                    List<String> implementsClasses = new ArrayList<>();

                    // 継承情報も読み込む（バージョン不一致でもmtimeが同じなら再利用可能）
                    if (fileJson.has("extends")) {
                        fileJson.getJSONArray("extends").forEach(v -> extendsClasses.add((String) v));
                    }
                    if (fileJson.has("implements")) {
                        fileJson.getJSONArray("implements").forEach(v -> implementsClasses.add((String) v));
                    }

                    fileIndex.put(filePath, new FileInfo(mtime, extendsClasses, implementsClasses));
                }
            }

            // バージョン一致時のみ hierarchy を読み込み
            if (!versionMismatch) {
                JSONObject hierarchyJson = json.optJSONObject("hierarchy");
                if (hierarchyJson != null) {
                    for (String parentFqn : hierarchyJson.keySet()) {
                        Set<String> children = new HashSet<>();
                        hierarchyJson.getJSONArray(parentFqn).forEach(v -> children.add((String) v));
                        hierarchy.put(parentFqn, children);
                    }
                }

                // childToParents を構築（fileIndex から逆引きマップを生成）
                buildChildToParentsFromFileIndex();

                System.out.println("[INFO] Loaded hierarchy cache: " + hierarchy.size() + " parent classes, "
                        + fileIndex.size() + " files");
                return 0; // 完全ロード成功
            } else {
                System.out.println("[INFO] Loaded cached hints for " + fileIndex.size() + " files");
                return 1; // mtime+継承情報ロード
            }

        } catch (Exception e) {
            System.err.println("[WARN] Failed to load cache: " + e.getMessage());
            return -1; // ロード失敗
        }
    }

    /**
     * キャッシュをファイルに保存する
     */
    public void save() {
        if (!dirty) {
            return;
        }

        try {
            Files.createDirectories(cacheDir);

            JSONObject json = new JSONObject();
            json.put("version", CACHE_VERSION);

            // hierarchy を保存
            JSONObject hierarchyJson = new JSONObject();
            for (var entry : hierarchy.entrySet()) {
                hierarchyJson.put(entry.getKey(), entry.getValue());
            }
            json.put("hierarchy", hierarchyJson);

            // fileIndex を保存
            JSONObject filesJson = new JSONObject();
            for (var entry : fileIndex.entrySet()) {
                JSONObject fileJson = new JSONObject();
                fileJson.put("mtime", entry.getValue().mtime());
                fileJson.put("extends", entry.getValue().extendsClasses());
                fileJson.put("implements", entry.getValue().implementsClasses());
                filesJson.put(entry.getKey(), fileJson);
            }
            json.put("files", filesJson);

            Path cacheFile = cacheDir.resolve(CACHE_FILE_NAME);
            Files.writeString(cacheFile, json.toString(2));
            dirty = false;

        } catch (IOException e) {
            System.err.println("[WARN] Failed to save cache: " + e.getMessage());
        }
    }

    /**
     * フルスキャンでキャッシュを再構築する（並列処理）
     */
    public void rebuild() {
        hierarchy.clear();
        fileIndex.clear();
        childToParents.clear();

        long startTime = System.currentTimeMillis();

        // 全ファイルを並列でスキャン
        srcRoots.parallelStream()
                .flatMap(root -> {
                    try {
                        return Files.walk(root);
                    } catch (IOException e) {
                        return Stream.empty();
                    }
                })
                .filter(p -> p.toString().endsWith(".java"))
                .forEach(this::indexFile);

        long elapsed = System.currentTimeMillis() - startTime;
        System.out.println("[INFO] Built hierarchy cache in " + elapsed + "ms: "
                + hierarchy.size() + " parent classes, " + fileIndex.size() + " files");

        dirty = true;
        save();
    }

    /**
     * 古いキャッシュの情報を使って効率的にキャッシュを再構築する。
     * バージョン不一致時に使用。mtimeが変わっていないファイルは古い継承情報をそのまま再利用。
     */
    private void rebuildWithMtimeHints() {
        // 古いファイル情報を保持（fileIndexには既にロード済み）
        Map<String, FileInfo> oldFileIndex = new HashMap<>(fileIndex);

        // hierarchy, fileIndex, childToParents をクリア
        hierarchy.clear();
        fileIndex.clear();
        childToParents.clear();

        long startTime = System.currentTimeMillis();
        var stats = new int[] { 0, 0 }; // [0]=scanned, [1]=reused

        // 全ファイルを処理（mtimeが変わっていないファイルは古い情報を再利用）
        srcRoots.parallelStream()
                .flatMap(root -> {
                    try {
                        return Files.walk(root);
                    } catch (IOException e) {
                        return Stream.empty();
                    }
                })
                .filter(p -> p.toString().endsWith(".java"))
                .forEach(file -> {
                    String relativePath = getRelativePath(file);
                    try {
                        long currentMtime = Files.getLastModifiedTime(file).toMillis();
                        FileInfo oldInfo = oldFileIndex.get(relativePath);

                        if (oldInfo != null && oldInfo.mtime() == currentMtime) {
                            // mtimeが変わっていない → 古い継承情報を再利用
                            reuseFileInfo(file, relativePath, currentMtime, oldInfo);
                            synchronized (stats) {
                                stats[1]++;
                            }
                        } else {
                            // 新規または変更あり → 再スキャン
                            indexFile(file);
                            synchronized (stats) {
                                stats[0]++;
                            }
                        }
                    } catch (IOException e) {
                        // エラー時はスキャンを試みる
                        indexFile(file);
                        synchronized (stats) {
                            stats[0]++;
                        }
                    }
                });

        long elapsed = System.currentTimeMillis() - startTime;
        System.out.println("[INFO] Rebuilt hierarchy cache in " + elapsed + "ms: "
                + hierarchy.size() + " parent classes, " + fileIndex.size() + " files"
                + " (scanned: " + stats[0] + ", reused: " + stats[1] + ")");

        dirty = true;
        save();
    }

    /**
     * 古いファイル情報を再利用してhierarchyを構築する
     */
    private void reuseFileInfo(Path file, String relativePath, long mtime, FileInfo oldInfo) {
        // ファイル情報を再利用
        fileIndex.put(relativePath, new FileInfo(mtime, oldInfo.extendsClasses(), oldInfo.implementsClasses()));

        // hierarchyに追加（クラスFQNを推測）
        // relativePath: com/example/ServiceImpl.java -> com.example.ServiceImpl
        String classFqn = relativePath
                .replace('/', '.')
                .replace('\\', '.')
                .replaceAll("\\.java$", "");

        for (String parent : oldInfo.extendsClasses()) {
            hierarchy.computeIfAbsent(parent, k -> ConcurrentHashMap.newKeySet()).add(classFqn);
        }
        for (String parent : oldInfo.implementsClasses()) {
            hierarchy.computeIfAbsent(parent, k -> ConcurrentHashMap.newKeySet()).add(classFqn);
        }

        // childToParents に追加（子→親の逆引き用）
        List<String> allParents = new ArrayList<>(oldInfo.extendsClasses());
        allParents.addAll(oldInfo.implementsClasses());
        if (!allParents.isEmpty()) {
            childToParents.put(classFqn, allParents);
        }
    }

    /**
     * 更新日時をチェックして差分更新を行う
     */
    private void updateIfNeeded() {
        long startTime = System.currentTimeMillis();
        int updated = 0;
        int added = 0;
        int removed = 0;

        // 現在のファイル一覧を収集
        Set<String> currentFiles = new HashSet<>();

        for (Path root : srcRoots) {
            try (var stream = Files.walk(root)) {
                List<Path> javaFiles = stream
                        .filter(p -> p.toString().endsWith(".java"))
                        .toList();

                for (Path file : javaFiles) {
                    String relativePath = getRelativePath(file);
                    currentFiles.add(relativePath);

                    long currentMtime = Files.getLastModifiedTime(file).toMillis();
                    FileInfo cached = fileIndex.get(relativePath);

                    if (cached == null) {
                        // 新規ファイル
                        indexFile(file);
                        added++;
                    } else if (currentMtime != cached.mtime()) {
                        // 更新されたファイル
                        removeFileFromHierarchy(relativePath, cached);
                        indexFile(file);
                        updated++;
                    }
                    // 変更なしの場合は何もしない
                }
            } catch (IOException e) {
                System.err.println("[WARN] Error scanning directory: " + e.getMessage());
            }
        }

        // 削除されたファイルを処理
        Set<String> toRemove = new HashSet<>(fileIndex.keySet());
        toRemove.removeAll(currentFiles);
        for (String removedPath : toRemove) {
            FileInfo cached = fileIndex.get(removedPath);
            if (cached != null) {
                removeFileFromHierarchy(removedPath, cached);
            }
            fileIndex.remove(removedPath);
            removed++;
        }

        if (updated > 0 || added > 0 || removed > 0) {
            dirty = true;
            long elapsed = System.currentTimeMillis() - startTime;
            System.out.println("[INFO] Updated hierarchy cache in " + elapsed + "ms: "
                    + added + " added, " + updated + " updated, " + removed + " removed");
            save();
        } else {
            System.out.println("[INFO] Hierarchy cache is up to date");
        }
    }

    /**
     * ファイルをインデックスに追加する
     */
    private void indexFile(Path file) {
        try {
            String content = Files.readString(file);
            String relativePath = getRelativePath(file);
            long mtime = Files.getLastModifiedTime(file).toMillis();

            // パッケージ名を取得
            String packageName = extractPackageName(content);

            // import文を収集
            Map<String, String> imports = extractImports(content);

            // 継承関係を抽出
            List<String> extendsClasses = new ArrayList<>();
            List<String> implementsClasses = new ArrayList<>();

            // class/interface extends
            extractInheritance(content, packageName, imports, CLASS_EXTENDS, extendsClasses);
            extractInheritance(content, packageName, imports, INTERFACE_EXTENDS, extendsClasses);

            // class implements
            extractInheritance(content, packageName, imports, CLASS_IMPLEMENTS, implementsClasses);

            // ファイル情報を保存
            fileIndex.put(relativePath, new FileInfo(mtime, extendsClasses, implementsClasses));

            // 継承関係をhierarchyに追加
            String className = extractClassName(content);
            if (className != null) {
                String classFqn = packageName.isEmpty() ? className : packageName + "." + className;

                for (String parent : extendsClasses) {
                    hierarchy.computeIfAbsent(parent, k -> ConcurrentHashMap.newKeySet()).add(classFqn);
                }
                for (String parent : implementsClasses) {
                    hierarchy.computeIfAbsent(parent, k -> ConcurrentHashMap.newKeySet()).add(classFqn);
                }

                // childToParents に追加（子→親の逆引き用）
                List<String> allParents = new ArrayList<>(extendsClasses);
                allParents.addAll(implementsClasses);
                if (!allParents.isEmpty()) {
                    childToParents.put(classFqn, allParents);
                }
            }

        } catch (IOException e) {
            // ファイル読み込みエラーは無視
        }
    }

    /**
     * ファイルの継承関係をhierarchyから削除する
     */
    private void removeFileFromHierarchy(String relativePath, FileInfo cached) {
        // このファイルで定義されていたクラスのFQNを推測
        // relativePath: com/example/ServiceImpl.java -> com.example.ServiceImpl
        String classFqn = relativePath
                .replace('/', '.')
                .replace('\\', '.')
                .replaceAll("\\.java$", "");

        // 親クラスからこのクラスへの参照を削除
        for (String parent : cached.extendsClasses()) {
            Set<String> children = hierarchy.get(parent);
            if (children != null) {
                children.remove(classFqn);
                if (children.isEmpty()) {
                    hierarchy.remove(parent);
                }
            }
        }
        for (String parent : cached.implementsClasses()) {
            Set<String> children = hierarchy.get(parent);
            if (children != null) {
                children.remove(classFqn);
                if (children.isEmpty()) {
                    hierarchy.remove(parent);
                }
            }
        }

        // childToParents からも削除
        childToParents.remove(classFqn);
    }

    /**
     * 継承関係を抽出してリストに追加
     */
    private void extractInheritance(String content, String packageName, Map<String, String> imports,
            Pattern pattern, List<String> resultList) {
        Matcher matcher = pattern.matcher(content);
        while (matcher.find()) {
            String parentsPart = matcher.group(2);

            // カンマで分割（ジェネリクス内のカンマは無視）
            List<String> parents = splitParents(parentsPart);

            for (String parent : parents) {
                parent = parent.trim();
                if (parent.isEmpty())
                    continue;

                // ジェネリクスを除去
                int genStart = parent.indexOf('<');
                if (genStart > 0) {
                    parent = parent.substring(0, genStart);
                }

                // FQNに解決
                String parentFqn = resolveToFqn(parent, packageName, imports);
                resultList.add(parentFqn);
            }
        }
    }

    /**
     * 親クラス/インターフェースのリストを分割（ジェネリクス内のカンマは無視）
     */
    private List<String> splitParents(String parentsPart) {
        List<String> result = new ArrayList<>();
        int depth = 0;
        int start = 0;

        for (int i = 0; i < parentsPart.length(); i++) {
            char c = parentsPart.charAt(i);
            if (c == '<')
                depth++;
            else if (c == '>')
                depth--;
            else if (c == ',' && depth == 0) {
                result.add(parentsPart.substring(start, i).trim());
                start = i + 1;
            }
        }
        if (start < parentsPart.length()) {
            result.add(parentsPart.substring(start).trim());
        }
        return result;
    }

    /**
     * パッケージ名を抽出
     */
    private String extractPackageName(String content) {
        int pkgIdx = content.indexOf("package ");
        if (pkgIdx >= 0) {
            int semiIdx = content.indexOf(';', pkgIdx);
            if (semiIdx > pkgIdx) {
                return content.substring(pkgIdx + 8, semiIdx).trim();
            }
        }
        return "";
    }

    /**
     * クラス名を抽出
     */
    private String extractClassName(String content) {
        Pattern pattern = Pattern.compile("(?:class|interface|enum)\\s+(\\w+)");
        Matcher matcher = pattern.matcher(content);
        if (matcher.find()) {
            return matcher.group(1);
        }
        return null;
    }

    /**
     * import文を収集
     */
    private Map<String, String> extractImports(String content) {
        Map<String, String> imports = new HashMap<>();
        int idx = 0;
        while ((idx = content.indexOf("import ", idx)) >= 0) {
            int semiIdx = content.indexOf(';', idx);
            if (semiIdx > idx) {
                String importStmt = content.substring(idx + 7, semiIdx).trim();
                if (!importStmt.startsWith("static ") && !importStmt.endsWith(".*")) {
                    String simpleName = importStmt.substring(importStmt.lastIndexOf('.') + 1);
                    imports.put(simpleName, importStmt);
                }
            }
            idx = semiIdx > 0 ? semiIdx : idx + 1;
        }
        return imports;
    }

    /**
     * シンプル名をFQNに解決
     */
    private String resolveToFqn(String simpleName, String packageName, Map<String, String> imports) {
        // 既にFQNの場合
        if (simpleName.contains(".")) {
            return simpleName;
        }

        // import文から解決
        if (imports.containsKey(simpleName)) {
            return imports.get(simpleName);
        }

        // 同一パッケージと仮定
        return packageName.isEmpty() ? simpleName : packageName + "." + simpleName;
    }

    /**
     * ファイルの相対パスを取得
     */
    private String getRelativePath(Path file) {
        Path absFile = file.toAbsolutePath().normalize();
        for (Path root : srcRoots) {
            Path absRoot = root.toAbsolutePath().normalize();
            if (absFile.startsWith(absRoot)) {
                return absRoot.relativize(absFile).toString().replace('\\', '/');
            }
        }
        return file.toString().replace('\\', '/');
    }

    /**
     * 指定したクラスの直接のサブクラスを取得
     */
    public Set<String> getDirectSubclasses(String parentFqn) {
        Set<String> result = hierarchy.get(parentFqn);
        return result != null ? new HashSet<>(result) : new HashSet<>();
    }

    /**
     * 指定したクラスの全サブクラスを再帰的に取得
     */
    public Set<String> getAllSubclasses(String parentFqn) {
        Set<String> result = new HashSet<>();
        getAllSubclassesRecursive(parentFqn, result, new HashSet<>());
        return result;
    }

    private void getAllSubclassesRecursive(String parentFqn, Set<String> result, Set<String> visited) {
        if (visited.contains(parentFqn))
            return;
        visited.add(parentFqn);

        Set<String> direct = hierarchy.get(parentFqn);
        if (direct == null)
            return;

        for (String child : direct) {
            result.add(child);
            getAllSubclassesRecursive(child, result, visited);
        }
    }

    /**
     * キャッシュ内の親クラス数を取得（デバッグ用）
     */
    public int getParentClassCount() {
        return hierarchy.size();
    }

    /**
     * キャッシュ内のファイル数を取得（デバッグ用）
     */
    public int getFileCount() {
        return fileIndex.size();
    }

    /**
     * 指定したクラスの親クラス/インターフェースのリストを取得
     * （extends + implements の両方を含む）
     * 
     * @param childFqn 子クラスのFQN
     * @return 親クラス/インターフェースのFQNリスト（なければ空リスト）
     */
    public List<String> getParentClasses(String childFqn) {
        return childToParents.getOrDefault(childFqn, List.of());
    }

    /**
     * fileIndex から childToParents マップを構築する
     * キャッシュロード時に呼び出される
     */
    private void buildChildToParentsFromFileIndex() {
        childToParents.clear();
        for (var entry : fileIndex.entrySet()) {
            String relativePath = entry.getKey();
            FileInfo info = entry.getValue();

            // relativePath: com/example/ServiceImpl.java -> com.example.ServiceImpl
            String classFqn = relativePath
                    .replace('/', '.')
                    .replace('\\', '.')
                    .replaceAll("\\.java$", "");

            List<String> allParents = new ArrayList<>(info.extendsClasses());
            allParents.addAll(info.implementsClasses());
            if (!allParents.isEmpty()) {
                childToParents.put(classFqn, allParents);
            }
        }
    }
}
