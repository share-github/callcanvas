package tools.depquery;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.json.JSONObject;
import tools.depquery.CallIndexModels.*;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.*;

import static tools.depquery.DiagnosticLogger.*;

/**
 * CallIndex の読み書き、ファイルハッシュ計算を管理
 */
class CallIndexManager {
    private static final String INDEX_FILE_NAME = "call-index.json";
    private static final String CACHE_DIR_NAME = ".callcanvas-cache";
    // ランダムアクセス用サイドカー（outgoing 解析の部分ロード用）
    private static final String DAT_FILE_NAME = "call-index.dat";   // 1 行 1 メソッドのコンパクト JSON
    private static final String OFF_FILE_NAME = "call-index.off";   // TSV: fqn \t offset \t length
    private static final String META_FILE_NAME = "call-index.meta"; // version/timestamp/symbolIndex

    private final Path projectRoot;
    private final Path cacheDir;
    private final Path indexFilePath;
    private final Path datFilePath;
    private final Path offFilePath;
    private final Path metaFilePath;

    CallIndexManager(Path projectRoot) {
        this.projectRoot = projectRoot;
        this.cacheDir = projectRoot.resolve(CACHE_DIR_NAME);
        this.indexFilePath = cacheDir.resolve(INDEX_FILE_NAME);
        this.datFilePath = cacheDir.resolve(DAT_FILE_NAME);
        this.offFilePath = cacheDir.resolve(OFF_FILE_NAME);
        this.metaFilePath = cacheDir.resolve(META_FILE_NAME);
    }

    /**
     * インデックスが存在するかチェック
     */
    boolean indexExists() {
        return Files.exists(indexFilePath);
    }

    /**
     * インデックスを読み込む（Jackson使用で高速化）
     */
    CallIndex loadIndex() throws IOException {
        if (!indexExists()) {
            debug("No index found at: " + indexFilePath);
            return null;
        }

        debug("Loading index from: " + indexFilePath);

        // Jacksonストリーミングパーサーで高速読み込み
        ObjectMapper mapper = new ObjectMapper();
        try (var is = Files.newInputStream(indexFilePath)) {
            return mapper.readValue(is, CallIndex.class);
        } catch (Exception e) {
            // フォールバック: org.jsonで読み込み（互換性確保）
            debug("Jackson parse failed, falling back to org.json: " + e.getMessage());
            String content = Files.readString(indexFilePath);
            JSONObject obj = new JSONObject(content);
            return CallIndex.fromJson(obj);
        }
    }

    /**
     * インデックスを保存
     */
    void saveIndex(CallIndex index) throws IOException {
        Files.createDirectories(cacheDir);

        debug("Saving index to: " + indexFilePath);
        String content = index.toJson().toString(2); // 2スペースインデント
        Files.writeString(indexFilePath, content);

        info("[INFO] Call index saved: " + indexFilePath);

        // ランダムアクセス用サイドカーを併せて生成（失敗しても call-index.json は有効。
        // 解析側はサイドカー欠如時にフルロードへフォールバックするため致命的ではない）
        try {
            saveSidecar(index);
        } catch (Exception e) {
            System.err.println("[WARN] Failed to write random-access sidecar (will fall back to full load): "
                    + e.getMessage());
            // 中途半端なサイドカーを残さない
            try {
                Files.deleteIfExists(datFilePath);
                Files.deleteIfExists(offFilePath);
                Files.deleteIfExists(metaFilePath);
            } catch (IOException ignore) {
            }
        }
    }

    /**
     * outgoing 解析の部分ロード用サイドカーを生成する。
     * <ul>
     *   <li>{@code .dat} … 1 行 1 メソッドのコンパクト JSON（ランダムアクセス対象）</li>
     *   <li>{@code .off} … TSV {@code fqn \t byteOffset \t byteLength}（.dat 内の位置）</li>
     *   <li>{@code .meta} … version / timestamp / symbolIndex（解析側で必要な小さいメタのみ）</li>
     * </ul>
     * fileHashes は解析パスで不要なため含めない。
     */
    private void saveSidecar(CallIndex index) throws IOException {
        StringBuilder off = new StringBuilder();
        long offset = 0;
        try (var out = new java.io.BufferedOutputStream(Files.newOutputStream(datFilePath))) {
            for (var e : index.methods.entrySet()) {
                // org.json の toString() はコンパクト 1 行。文字列値中の改行は \n にエスケープされるため
                // 1 メソッド = 物理 1 行が保証される。
                byte[] line = e.getValue().toJson().toString().getBytes(StandardCharsets.UTF_8);
                out.write(line);
                out.write('\n');
                off.append(e.getKey()).append('\t')
                        .append(offset).append('\t')
                        .append(line.length).append('\n');
                offset += line.length + 1; // +1 は行区切りの '\n'
            }
        }
        Files.writeString(offFilePath, off.toString());

        JSONObject meta = new JSONObject();
        meta.put("version", index.version);
        meta.put("timestamp", index.timestamp);
        if (!index.symbolIndex.isEmpty()) {
            JSONObject symObj = new JSONObject();
            index.symbolIndex.forEach((k, v) -> symObj.put(k, v.toJson()));
            meta.put("symbolIndex", symObj);
        }
        Files.writeString(metaFilePath, meta.toString());
        debug("Random-access sidecar saved: " + index.methods.size() + " methods");
    }

    /** サイドカー 3 点が揃っているか。 */
    boolean sidecarExists() {
        return Files.exists(datFilePath) && Files.exists(offFilePath) && Files.exists(metaFilePath);
    }

    /**
     * 解析パス用のインデックスをロードする。
     * outgoing かつサイドカーが揃っていれば {@link LazyCallIndex}（部分ロード）を返し、
     * それ以外（incoming・サイドカー欠如・ロード失敗）は従来のフルロードにフォールバックする。
     */
    CallIndex loadIndexForAnalysis(String direction) throws IOException {
        if ("outgoing".equals(direction) && sidecarExists()) {
            try {
                return new LazyCallIndex(metaFilePath, offFilePath, datFilePath);
            } catch (Exception e) {
                debug("Lazy index load failed, falling back to full load: " + e.getMessage());
            }
        }
        return loadIndex();
    }

    /**
     * ファイルのSHA-256ハッシュを計算
     */
    static String calculateFileHash(Path file) throws IOException {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] fileBytes = Files.readAllBytes(file);
            byte[] hashBytes = digest.digest(fileBytes);

            // バイト配列を16進数文字列に変換
            StringBuilder sb = new StringBuilder();
            for (byte b : hashBytes) {
                sb.append(String.format("%02x", b));
            }
            return sb.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new RuntimeException("SHA-256 algorithm not available", e);
        }
    }

    /**
     * ファイルリストのハッシュマップを作成
     */
    static Map<String, String> calculateFileHashes(List<Path> files) throws IOException {
        Map<String, String> hashes = new HashMap<>();
        for (Path file : files) {
            try {
                String hash = calculateFileHash(file);
                hashes.put(file.toString(), hash);
            } catch (IOException e) {
                debugVerbose("Failed to hash file: " + file + " - " + e.getMessage());
            }
        }
        return hashes;
    }

    /**
     * 変更されたファイルを検出（増分更新用）
     */
    static class FileChanges {
        List<Path> added = new ArrayList<>();
        List<Path> modified = new ArrayList<>();
        List<String> deleted = new ArrayList<>();
    }

    FileChanges detectChanges(CallIndex oldIndex, List<Path> currentFiles) throws IOException {
        FileChanges changes = new FileChanges();

        long hashStart = startTiming("Change Detection Hash");
        Map<String, String> currentHashes = calculateFileHashes(currentFiles);
        endTiming("Change Detection Hash", hashStart);

        long diffStart = startTiming("Change Detection Diff");
        Set<String> currentFilePaths = currentHashes.keySet();
        Set<String> oldFilePaths = oldIndex.fileHashes.keySet();

        for (Path file : currentFiles) {
            String filePath = file.toString();
            String currentHash = currentHashes.get(filePath);
            String oldHash = oldIndex.getFileHash(filePath);

            if (oldHash == null) {
                changes.added.add(file);
            } else if (!currentHash.equals(oldHash)) {
                changes.modified.add(file);
            }
        }

        for (String oldFilePath : oldFilePaths) {
            if (!currentFilePaths.contains(oldFilePath)) {
                changes.deleted.add(oldFilePath);
            }
        }
        endTiming("Change Detection Diff", diffStart);

        return changes;
    }
}
