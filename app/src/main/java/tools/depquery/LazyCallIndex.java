package tools.depquery;

import org.json.JSONObject;
import tools.depquery.CallIndexModels.CallIndex;
import tools.depquery.CallIndexModels.MethodEntry;

import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;

import static tools.depquery.DiagnosticLogger.debug;
import static tools.depquery.DiagnosticLogger.debugVerbose;

/**
 * サイドカー（.dat/.off/.meta）を使って、BFS が実際に触れるメソッドだけを
 * オンデマンドで seek+parse する遅延ロード版 CallIndex。
 *
 * <p>フルロード（全メソッドを Jackson でデシリアライズ）を避け、Index Load を
 * O(プロジェクト全体) から O(到達メソッド) に落とす。symbolIndex と version/timestamp は
 * 小さいため構築時にまとめてロードする。fileHashes は解析パスで不要なので読み込まない。
 *
 * <p>継承した {@code methods} マップは「ロード済みエントリのキャッシュ」として使う。
 */
class LazyCallIndex extends CallIndex {

    /** fqn -> [byteOffset, byteLength]（.dat 内の位置）。 */
    private final Map<String, long[]> offsets = new HashMap<>();
    private final RandomAccessFile data;

    /**
     * @param metaFile version/timestamp/symbolIndex を含む小さな JSON
     * @param offFile  TSV: fqn \t offset \t length（1 行 1 メソッド）
     * @param datFile  1 行 1 メソッドのコンパクト JSON（ランダムアクセス対象）
     */
    LazyCallIndex(Path metaFile, Path offFile, Path datFile) throws IOException {
        super();
        // meta: version / timestamp / symbolIndex
        String metaContent = Files.readString(metaFile);
        JSONObject meta = new JSONObject(metaContent);
        if (meta.has("version")) this.version = meta.getString("version");
        if (meta.has("timestamp")) this.timestamp = meta.getString("timestamp");
        if (meta.has("symbolIndex")) {
            JSONObject symObj = meta.getJSONObject("symbolIndex");
            for (String key : symObj.keySet()) {
                JSONObject e = symObj.getJSONObject(key);
                this.symbolIndex.put(key, new CallIndexModels.ConstantEntry(
                        e.getString("value"), e.getString("qualifier"), e.getString("type")));
            }
        }
        // offsets: TSV
        for (String line : Files.readAllLines(offFile, StandardCharsets.UTF_8)) {
            if (line.isEmpty()) continue;
            int t1 = line.indexOf('\t');
            int t2 = line.indexOf('\t', t1 + 1);
            if (t1 < 0 || t2 < 0) continue;
            String fqn = line.substring(0, t1);
            long off = Long.parseLong(line.substring(t1 + 1, t2));
            long len = Long.parseLong(line.substring(t2 + 1));
            offsets.put(fqn, new long[]{off, len});
        }
        this.data = new RandomAccessFile(datFile.toFile(), "r");
        debug("LazyCallIndex ready: " + offsets.size() + " method offsets");
    }

    @Override
    MethodEntry getMethod(String fqn) {
        MethodEntry cached = methods.get(fqn);
        if (cached != null) return cached;
        long[] loc = offsets.get(fqn);
        if (loc == null) return null; // インデックス外（スタブ扱いは呼び出し側に委譲）
        try {
            byte[] buf = new byte[(int) loc[1]];
            synchronized (data) {
                data.seek(loc[0]);
                data.readFully(buf);
            }
            JSONObject obj = new JSONObject(new String(buf, StandardCharsets.UTF_8));
            MethodEntry entry = MethodEntry.fromJson(obj);
            methods.put(fqn, entry); // キャッシュ
            return entry;
        } catch (Exception e) {
            debugVerbose("LazyCallIndex.getMethod failed for " + fqn + ": " + e.getMessage());
            return null;
        }
    }

    @Override
    int methodCount() {
        return offsets.size();
    }

    @Override
    Set<String> allMethodFqns() {
        return offsets.keySet();
    }
}
