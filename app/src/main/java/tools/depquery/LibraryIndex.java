package tools.depquery;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.*;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

import static tools.depquery.DiagnosticLogger.debugVerbose;

/**
 * 解析に使ったクラスパスの JAR（ライブラリ）と、ライブラリのクラス → 持ち主の JAR の対応。
 *
 * <p>差分更新でクラスパスの変化に追従するために使う（Zinc のライブラリ依存と同じ考え方。{@link IndexDeps}）。
 * JDT はバインディングから JAR を教えないので（Java モデル無しの環境では getJavaElement() が null）、
 * JDT と同じくクラスパスを先頭から探し、最初にそのクラスを含む JAR を持ち主とする。
 * JAR の変化はパス・サイズ・更新時刻（スタンプ）で見る。クラスディレクトリ（target/classes 等）は
 * プロジェクト自身のコンパイル結果で、解析はソースから行うので対象外。fat-jar から取り出した JAR の持ち主は元の fat-jar。
 */
final class LibraryIndex {

    /** クラスパスの JAR 1 つ（path は持ち主として記録するパス） */
    record Jar(String path, String stamp) {}

    /** クラスパス順の JAR（同じ持ち主は 1 つ） */
    final List<Jar> jars;
    /** 目次を読む実ファイル（クラスパス順）→ 持ち主のパス */
    private final LinkedHashMap<String, String> files;
    /** クラスのバイナリ名 → 持ち主の JAR（必要になったときに目次を読む） */
    private Map<String, String> owners;
    /** 持ち主の JAR → その JAR のクラスのバイナリ名 */
    private Map<String, List<String>> classesByJar;

    private LibraryIndex(List<Jar> jars, LinkedHashMap<String, String> files) {
        this.jars = jars;
        this.files = files;
    }

    /** JDT に渡すクラスパス（{@link JdtCallCollector#classpathEntries}）の JAR から作る */
    static LibraryIndex of(List<String> classpath) {
        LinkedHashMap<String, String> files = new LinkedHashMap<>();
        LinkedHashMap<String, String> stamps = new LinkedHashMap<>();
        for (String entry : classpath) {
            Path p = Path.of(entry);
            if (!entry.endsWith(".jar") || !Files.isRegularFile(p)) continue;
            String owner = JdtCallCollector.NESTED_JAR_OWNER.getOrDefault(entry, entry);
            files.put(entry, owner);
            if (!stamps.containsKey(owner)) stamps.put(owner, stamp(Path.of(owner)));
        }
        List<Jar> jars = new ArrayList<>();
        stamps.forEach((path, stamp) -> jars.add(new Jar(path, stamp)));
        return new LibraryIndex(jars, files);
    }

    private static String stamp(Path p) {
        try {
            BasicFileAttributes a = Files.readAttributes(p, BasicFileAttributes.class);
            return a.size() + ":" + a.lastModifiedTime().toMillis();
        } catch (IOException e) {
            return "?";
        }
    }

    /** クラスの持ち主の JAR（クラスパスのどの JAR にも無い＝JDK 等なら ""） */
    String ownerOf(String binaryName) {
        scan();
        return owners.getOrDefault(binaryName, "");
    }

    /** 指定した JAR のクラスのバイナリ名 */
    List<String> classesOf(String jarPath) {
        scan();
        return classesByJar.getOrDefault(jarPath, List.of());
    }

    private void scan() {
        if (owners != null) return;
        owners = new HashMap<>();
        classesByJar = new HashMap<>();
        for (var e : files.entrySet()) {
            List<String> classes = classesByJar.computeIfAbsent(e.getValue(), k -> new ArrayList<>());
            try (ZipFile z = new ZipFile(e.getKey())) {
                Enumeration<? extends ZipEntry> en = z.entries();
                while (en.hasMoreElements()) {
                    String name = en.nextElement().getName();
                    if (!name.endsWith(".class") || name.endsWith("module-info.class")) continue;
                    // 多版 JAR の版別クラスは同じクラスの別版なので、持ち主は通常の位置で決まる
                    if (name.startsWith("META-INF/")) continue;
                    String binary = name.substring(0, name.length() - ".class".length()).replace('/', '.');
                    classes.add(binary);
                    owners.putIfAbsent(binary, e.getValue());
                }
            } catch (IOException ex) {
                debugVerbose("Failed to read jar " + e.getKey() + ": " + ex.getMessage());
            }
        }
    }

    /** バイナリ名の単純名（ネストは最後の $ の後ろ） */
    static String simpleName(String binaryName) {
        String s = binaryName.substring(binaryName.lastIndexOf('.') + 1);
        return s.substring(s.lastIndexOf('$') + 1);
    }

    /** 解析環境（JDK と言語レベル）。変わったらフル構築（JDK のクラスはクラスパスの JAR でないので追えない） */
    static String environment(AnalyzerConfig cfg) {
        return System.getProperty("java.home") + "|" + System.getProperty("java.version") + "|" + cfg.languageLevel;
    }
}
