package tools.depquery;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.management.ManagementFactory;
import java.nio.file.*;
import java.util.*;
import java.util.jar.JarEntry;
import java.util.jar.JarOutputStream;
import java.util.stream.Stream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

import static tools.depquery.DiagnosticLogger.*;

/**
 * インデックス構築で Lombok の生成メンバー（getter/setter・@Slf4j の log 等）を解決するための支援。
 *
 * <p>Lombok は JDT のコンパイラに Java agent としてパッチを当てて生成メンバーを AST に足す。agent は JVM 起動時に
 * 指定する必要があるが、拡張の java 起動引数は変えたくないので、プロジェクトのクラスパス（--cp / --cpdir）に
 * lombok.jar がある時だけ、同じ引数で自身を agent 付きの子プロセスとして起動し直す。
 *
 * <p>agent は JDT の ASTConverter から {@code lombok.eclipse.EcjAugments} などを直接参照するため、それらのクラスが
 * アプリのクラスパスに必要になる。lombok.jar 内では {@code SCL.lombok/...*.SCL.lombok} という名前で隠されているので、
 * {@code .class} に改名した JAR をユーザーキャッシュに 1 度だけ作り、子プロセスのクラスパスに足す。
 * これは Lombok の内部レイアウトに依存するので、子プロセスが失敗したら警告を出して Lombok 無しで続行する。
 */
final class LombokSupport {
    /** 子プロセスであることの印（再帰起動の防止） */
    static final String CHILD_PROPERTY = "callcanvas.lombok.child";
    private static final String SCL_PREFIX = "SCL.lombok/";
    private static final String SCL_SUFFIX = ".SCL.lombok";

    private LombokSupport() {}

    /** このプロセスで Lombok の agent が有効か（子プロセス、または呼び出し元が -javaagent で付けた） */
    static boolean agentActive() {
        if (System.getProperty(CHILD_PROPERTY) != null) return true;
        try {
            for (String a : ManagementFactory.getRuntimeMXBean().getInputArguments()) {
                if (a.startsWith("-javaagent:") && a.contains("lombok")) return true;
            }
        } catch (Throwable t) {
            // 取得できなければ無効とみなす
        }
        return false;
    }

    /**
     * lombok.jar がクラスパスにあれば agent 付きで自身を起動し直し、その終了を待つ。
     *
     * @return 子プロセスが処理（索引構築・インデックス無しの解析）を完了した（呼び出し側はそのまま終了してよい）なら true。
     *         Lombok が無い・既に agent 付き・子プロセスが失敗した場合は false（呼び出し側がこのプロセスで構築する）
     */
    static boolean relaunchWithAgentIfNeeded(AnalyzerConfig cfg, String[] args) {
        if (System.getProperty(CHILD_PROPERTY) != null) {
            info("[INFO] Lombok agent enabled");
            return false;
        }
        Path lombokJar = findLombokJar(cfg);
        if (lombokJar == null) return false;
        List<String> jvmArgs;
        try {
            jvmArgs = ManagementFactory.getRuntimeMXBean().getInputArguments();
        } catch (Throwable t) {
            jvmArgs = List.of();
        }
        for (String a : jvmArgs) {
            if (a.startsWith("-javaagent:") && a.contains("lombok")) return false; // 呼び出し元が既に付けている
        }

        long start = startTiming("Lombok Relaunch Setup");
        Path sclJar;
        try {
            sclJar = prepareSclJar(lombokJar);
        } catch (Throwable t) {
            warnFallback("could not prepare Lombok classes from " + lombokJar + ": " + t);
            return false;
        }
        String java = ProcessHandle.current().info().command()
                .orElse(Path.of(System.getProperty("java.home"), "bin", "java").toString());
        List<String> cmd = new ArrayList<>();
        cmd.add(java);
        cmd.addAll(jvmArgs);
        cmd.add("-javaagent:" + lombokJar + "=ECJ");
        cmd.add("-D" + CHILD_PROPERTY + "=1");
        String childCp = System.getProperty("java.class.path") + File.pathSeparator + sclJar;
        Path jsa = sharedArchivePath(jvmArgs, sclJar);
        boolean dumpArchive = false;
        if (jsa != null) {
            if (Files.isRegularFile(jsa)) {
                cmd.addAll(List.of("-XX:+IgnoreUnrecognizedVMOptions", "-Xlog:cds*=off", "-XX:SharedArchiveFile=" + jsa));
            } else {
                dumpArchive = true;
            }
        }
        cmd.add("-cp");
        cmd.add(childCp);
        cmd.add(DepQueryCli.class.getName());
        cmd.addAll(Arrays.asList(args));
        endTiming("Lombok Relaunch Setup", start);

        debug("Relaunching with Lombok agent: " + lombokJar);
        Process child;
        try {
            child = new ProcessBuilder(cmd).inheritIO().start();
        } catch (IOException ex) {
            warnFallback("could not start java with the Lombok agent: " + ex.getMessage());
            return false;
        }
        Process dumper = dumpArchive ? startArchiveDump(jvmArgs, childCp, jsa, args) : null;
        // 拡張がこのプロセスを止めたら子も止める
        Thread hook = new Thread(() -> {
            child.destroy();
            if (dumper != null) dumper.destroy();
        });
        Runtime.getRuntime().addShutdownHook(hook);
        int code;
        try {
            code = child.waitFor();
            if (dumper != null) finishArchiveDump(dumper, jsa);
        } catch (InterruptedException ex) {
            child.destroy();
            if (dumper != null) dumper.destroy();
            Thread.currentThread().interrupt();
            return true;
        }
        try {
            Runtime.getRuntime().removeShutdownHook(hook);
        } catch (IllegalStateException ignore) {
        }
        if (code == 0) return true;
        warnFallback("the run with the Lombok agent exited with code " + code);
        return false;
    }

    // --- 子プロセスの起動短縮（AppCDS） ---
    //
    // 子プロセスは親の JVM 起動に続けてもう 1 度 JVM を起こし、JDT と agent のクラスを読み直すので、差分更新
    // （1 ファイル）では起動とクラスロードが大半を占める。そこで子のクラス（解析器 JAR + SCL の JAR）を
    // 動的 CDS アーカイブにして読み込みを省く（RuoYi-Vue-Plus の 1 ファイル差分で約 2.5 s → 約 1.8 s）。
    //
    // agent 付きの JVM ではアーカイブを作れない（診断用フラグ AllowArchivingWithJavaAgent が必要で、agent が
    // 書き換えたクラスが入ってしまう）。そのためアーカイブが無い初回だけ、agent 無しの JVM で 1 ファイルを
    // 解析させて（{@link CdsWarmup}）終了時にアーカイブを書かせる。子と並行に走らせるので待ち時間はほぼ増えない。
    // 以降の子はそのアーカイブを読むだけ。agent が書き換えるクラス（JDT の一部）はアーカイブを使わず
    // 通常どおり読まれるので、解析結果はアーカイブの有無で変わらない。

    /** 待ちの上限（子の終了後）。超えたら作成を諦める（次回また試す） */
    private static final long ARCHIVE_DUMP_TIMEOUT_SEC = 60;

    /**
     * 子プロセス用の CDS アーカイブの置き場所。解析器 JAR・Lombok・JDK の組ごとに別ファイル
     * （版の違う解析器が交互に動いても作り直しを繰り返さないように）。使わない場合は null
     * （呼び出し元が CDS を指定済み・JDK 12 以前・解析器 JAR が分からない）。
     */
    static Path sharedArchivePath(List<String> jvmArgs, Path sclJar) {
        if (Runtime.version().feature() < 13) return null;
        for (String a : jvmArgs) {
            if (a.contains("SharedArchive") || a.startsWith("-Xshare") || a.contains("ArchiveClassesAtExit")) return null;
        }
        try {
            Path app = Path.of(System.getProperty("java.class.path").split(File.pathSeparator)[0]);
            if (!Files.isRegularFile(app)) return null;
            String key = app.getFileName() + "-" + Files.size(app) + "-" + Files.getLastModifiedTime(app).toMillis()
                    + "-" + sclJar.getFileName().toString().replaceAll("-scl\\.jar$", "")
                    + "-jdk" + Runtime.version();
            return cacheDir().resolve(key.replaceAll("[^\\w.\\-]", "_") + ".jsa");
        } catch (IOException | RuntimeException ex) {
            debug("CDS archive disabled: " + ex);
            return null;
        }
    }

    /** agent 無しの JVM で {@link CdsWarmup} を動かし、終了時にアーカイブ（一時ファイル）を書かせる */
    private static Process startArchiveDump(List<String> jvmArgs, String childCp, Path jsa, String[] args) {
        try {
            Files.createDirectories(jsa.getParent());
            Path tmp = jsa.resolveSibling(jsa.getFileName() + ".tmp" + ProcessHandle.current().pid());
            String java = ProcessHandle.current().info().command()
                    .orElse(Path.of(System.getProperty("java.home"), "bin", "java").toString());
            List<String> cmd = new ArrayList<>();
            cmd.add(java);
            cmd.addAll(jvmArgs);
            cmd.addAll(List.of("-XX:+IgnoreUnrecognizedVMOptions", "-Xlog:cds*=off", "-XX:ArchiveClassesAtExit=" + tmp));
            cmd.add("-cp");
            cmd.add(childCp);
            cmd.add(CdsWarmup.class.getName());
            cmd.addAll(Arrays.asList(args));
            debug("Creating CDS archive for the Lombok child: " + jsa);
            return new ProcessBuilder(cmd)
                    .redirectOutput(ProcessBuilder.Redirect.DISCARD)
                    .redirectError(ProcessBuilder.Redirect.DISCARD)
                    .start();
        } catch (IOException | RuntimeException ex) {
            debug("CDS archive dump not started: " + ex);
            return null;
        }
    }

    private static void finishArchiveDump(Process dumper, Path jsa) throws InterruptedException {
        Path tmp = jsa.resolveSibling(jsa.getFileName() + ".tmp" + ProcessHandle.current().pid());
        try {
            if (!dumper.waitFor(ARCHIVE_DUMP_TIMEOUT_SEC, java.util.concurrent.TimeUnit.SECONDS)) {
                dumper.destroyForcibly();
                debug("CDS archive dump timed out");
            } else if (dumper.exitValue() == 0 && Files.isRegularFile(tmp)) {
                Files.move(tmp, jsa, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
                deleteStaleArchives(jsa);
            }
        } catch (IOException ex) {
            debug("CDS archive not saved: " + ex);
        } finally {
            try {
                Files.deleteIfExists(tmp);
            } catch (IOException ignore) {
            }
        }
    }

    /**
     * 今の組（{@code current}）以外の CDS アーカイブを消す。1 つ 15〜18MB あり、解析器を更新するたびに増えるため。
     * 作成途中の一時ファイル（{@code .jsa.tmp<pid>}）は他プロセスのものなので触らない。
     * 別プロセスが使用中のアーカイブを消しても、Linux/macOS では読み込み済みの内容はそのまま使われる。
     * 消せない場合（Windows で使用中など）は次回また試す。
     */
    static void deleteStaleArchives(Path current) {
        Path dir = current.getParent();
        if (dir == null) return;
        try (DirectoryStream<Path> ds = Files.newDirectoryStream(dir, "*.jsa")) {
            for (Path p : ds) {
                if (p.getFileName().equals(current.getFileName())) continue;
                try {
                    if (Files.deleteIfExists(p)) debug("Deleted stale CDS archive: " + p);
                } catch (IOException | RuntimeException ex) {
                    debug("Stale CDS archive not deleted: " + p + " (" + ex + ")");
                }
            }
        } catch (IOException | RuntimeException ex) {
            debug("Stale CDS archives not scanned: " + ex);
        }
    }

    /**
     * CDS アーカイブ作成用の起動口（agent 無し）。子プロセスと同じ引数で JDT の解析環境を作り、ソースを 1 ファイル
     * だけ解析して、差分更新で読まれるクラス（JDT のコンパイラ・バインディング解決・解析器）を読み込ませる。
     * 出力は捨てられ、インデックスには触れない。
     */
    static final class CdsWarmup {
        public static void main(String[] args) throws Exception {
            AnalyzerConfig cfg = AnalyzerConfig.parse(args);
            DiagnosticLogger.QUIET = true;
            DiagnosticLogger.DEBUG = false;
            DiagnosticLogger.TIMING = false;
            Path sample = null;
            for (Path root : cfg.srcRoots) {
                if (!Files.isDirectory(root)) continue;
                try (Stream<Path> s = Files.walk(root)) {
                    sample = s.filter(p -> p.toString().endsWith(".java")).findFirst().orElse(null);
                }
                if (sample != null) break;
            }
            if (sample != null) new JdtCallCollector(cfg).analyze(List.of(sample));
            System.exit(0);
        }
    }

    private static void warnFallback(String reason) {
        System.err.println("[WARN] Lombok support disabled: " + reason
                + ". Continuing without Lombok (calls to Lombok-generated members stay unresolved).");
    }

    /** --cp / --cpdir から lombok.jar を探す（lombok-mapstruct-binding などは除く） */
    static Path findLombokJar(AnalyzerConfig cfg) {
        List<Path> jars = new ArrayList<>(cfg.cpJars);
        for (Path dir : cfg.cpDirs) {
            if (Files.isDirectory(dir)) {
                try (Stream<Path> s = Files.walk(dir)) {
                    s.filter(p -> p.toString().endsWith(".jar")).sorted().forEach(jars::add);
                } catch (IOException ignore) {
                }
            } else {
                jars.add(dir);
            }
        }
        for (Path jar : jars) {
            String name = jar.getFileName() == null ? "" : jar.getFileName().toString();
            if (!name.matches("lombok(-\\d[\\w.\\-]*)?\\.jar") || !Files.isRegularFile(jar)) continue;
            try (ZipFile z = new ZipFile(jar.toFile())) {
                if (z.getEntry("lombok/launch/Agent.class") != null) return jar.toAbsolutePath().normalize();
            } catch (IOException ignore) {
            }
        }
        return null;
    }

    /**
     * lombok.jar 内の SCL.lombok クラスを .class に改名した JAR を用意する（キャッシュ済みなら再利用）。
     * 置き場所: $XDG_CACHE_HOME/callcanvas（未設定なら ~/.cache/callcanvas）。
     */
    static Path prepareSclJar(Path lombokJar) throws IOException {
        long size = Files.size(lombokJar);
        long mtime = Files.getLastModifiedTime(lombokJar).toMillis();
        String base = lombokJar.getFileName().toString().replaceAll("\\.jar$", "");
        Path dir = cacheDir();
        Path out = dir.resolve(base + "-" + size + "-" + mtime + "-scl.jar");
        if (Files.isRegularFile(out)) return out;
        Files.createDirectories(dir);
        Path tmp = Files.createTempFile(dir, base, ".tmp");
        int count = 0;
        try (ZipFile z = new ZipFile(lombokJar.toFile());
             OutputStream fo = Files.newOutputStream(tmp);
             JarOutputStream jo = new JarOutputStream(fo)) {
            var it = z.entries();
            byte[] buf = new byte[65536];
            while (it.hasMoreElements()) {
                ZipEntry e = it.nextElement();
                String n = e.getName();
                if (e.isDirectory() || !n.startsWith(SCL_PREFIX) || !n.endsWith(SCL_SUFFIX)) continue;
                String cls = n.substring(SCL_PREFIX.length(), n.length() - SCL_SUFFIX.length()) + ".class";
                jo.putNextEntry(new JarEntry(cls));
                try (InputStream in = z.getInputStream(e)) {
                    int r;
                    while ((r = in.read(buf)) > 0) jo.write(buf, 0, r);
                }
                jo.closeEntry();
                count++;
            }
        } catch (IOException | RuntimeException ex) {
            Files.deleteIfExists(tmp);
            throw ex;
        }
        if (count == 0) {
            Files.deleteIfExists(tmp);
            throw new IOException("no " + SCL_PREFIX + " classes in " + lombokJar);
        }
        try {
            Files.move(tmp, out, StandardCopyOption.ATOMIC_MOVE);
        } catch (IOException ex) {
            // 同時に別プロセスが作った場合など
            Files.deleteIfExists(tmp);
            if (!Files.isRegularFile(out)) throw ex;
        }
        return out;
    }

    private static Path cacheDir() {
        String xdg = System.getenv("XDG_CACHE_HOME");
        Path root = xdg != null && !xdg.isBlank()
                ? Path.of(xdg)
                : Path.of(System.getProperty("user.home"), ".cache");
        return root.resolve("callcanvas");
    }
}
