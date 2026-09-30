package tools.depquery;

import java.io.IOException;
import java.nio.file.*;
import java.util.*;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/**
 * クラス名からソースファイルを探す（パースはしない。解析は {@link JdtCallCollector}）。
 *
 * <p>インデックスが無い解析で、BFS が辿るメソッドのクラスから「次に解析するファイル」を決めるのに使う。
 */
public class SourceLocator {
    private final List<Path> roots;
    private final Map<String, Path> classToFile = new HashMap<>();
    private List<Path> allFiles;

    public SourceLocator(List<Path> roots) {
        this.roots = roots;
    }

    /**
     * クラス FQN（ネストは '.' 区切り: pkg.Outer.Inner）からソースファイルを解決する。
     *
     * @return ソースファイルのパス、見つからない場合は null
     */
    public Path resolveClassFile(String classFqn) {
        // 見つからない（外部ライブラリの）クラスも null で覚えておく（CHA で同じクラスを何度も引くため）
        if (classToFile.containsKey(classFqn)) return classToFile.get(classFqn);
        Path file = findFileByClassFqn(classFqn);
        classToFile.put(classFqn, file);
        return file;
    }

    /** メソッド FQN（Class#name(params)）の宣言クラスのソースファイル。見つからなければ null */
    public Path resolveMethodFile(String methodFqn) {
        int h = methodFqn.indexOf('#');
        return h < 0 ? null : resolveClassFile(methodFqn.substring(0, h));
    }

    /**
     * ユーザー指定のクラス名（パッケージ省略可・ネストは '.' 区切り）を宣言している可能性のあるファイル。
     * 曖昧なルート（{@code AnimalController#getAllSounds()} など）の解決で、解析する範囲を絞るのに使う。
     */
    public List<Path> candidateFilesForUserClass(String userClass) {
        Path direct = resolveClassFile(userClass);
        if (direct != null) return List.of(direct);
        String[] segs = userClass.split("\\.");
        // パッケージ省略: 先頭のセグメントをトップレベルのクラス名とみなす（Outer.Inner → Outer.java）
        String top = segs[0];
        List<Path> hits = new ArrayList<>();
        for (Path p : allFiles()) {
            if (p.getFileName().toString().equals(top + ".java")) hits.add(p);
        }
        if (!hits.isEmpty()) return hits;
        // ネストしたクラスを単純名だけで指定された場合など: 型宣言の文字列を含むファイル
        Pattern decl = Pattern.compile("\\b(class|interface|enum|record)\\s+" + Pattern.quote(segs[segs.length - 1]) + "\\b");
        for (Path p : allFiles()) {
            try {
                if (decl.matcher(Files.readString(p)).find()) hits.add(p);
            } catch (IOException ignored) {
            }
        }
        return hits;
    }

    /** ソースルート配下の全 .java ファイル（1 回だけ走査） */
    public List<Path> allFiles() {
        if (allFiles == null) {
            List<Path> files = new ArrayList<>();
            for (Path root : roots) {
                if (!Files.isDirectory(root)) continue;
                try (Stream<Path> s = Files.walk(root)) {
                    s.filter(p -> p.toString().endsWith(".java")).sorted().forEach(files::add);
                } catch (IOException ignored) {
                }
            }
            allFiles = files;
        }
        return allFiles;
    }

    private Path findFileByClassFqn(String classFqn) {
        // pkg.Outer.Inner → pkg/Outer/Inner.java, pkg/Outer.java の順に試す（ネストしたクラスは外側のファイル）
        String rel = classFqn.replace('.', '/');
        while (true) {
            for (Path root : roots) {
                Path p = root.resolve(rel + ".java");
                if (Files.exists(p))
                    return p;
            }
            int slash = rel.lastIndexOf('/');
            if (slash < 0) break;
            rel = rel.substring(0, slash);
        }
        // fallback: 単純名のファイルを探す（パッケージとディレクトリが一致しないソース）
        String simple = classFqn.substring(classFqn.lastIndexOf('.') + 1) + ".java";
        for (Path p : allFiles()) {
            if (p.getFileName().toString().equals(simple))
                return p;
        }
        return null;
    }
}
