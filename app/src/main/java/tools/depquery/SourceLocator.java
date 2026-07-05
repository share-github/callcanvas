package tools.depquery;

import com.github.javaparser.StaticJavaParser;
import com.github.javaparser.ast.CompilationUnit;
import com.github.javaparser.ast.body.MethodDeclaration;

import java.nio.file.*;
import java.util.*;
import java.util.stream.Collectors;

public class SourceLocator {
    private final List<Path> roots;
    private final Map<String, Path> classToFile = new HashMap<>();
    private final Map<Path, CompilationUnit> cuCache = new HashMap<>();

    public SourceLocator(List<Path> roots) {
        this.roots = roots;
    }

    public Optional<MethodLoc> resolveMethod(String methodFqn) {
        int h = methodFqn.indexOf('#');
        if (h < 0)
            return Optional.empty();
        String classFqn = methodFqn.substring(0, h);

        Path file = classToFile.computeIfAbsent(classFqn, this::findFileByClassFqn);
        if (file == null)
            return Optional.empty();

        CompilationUnit cu = cuCache.computeIfAbsent(file, p -> {
            try {
                // ファイルパスを直接渡すことで、CompilationUnit にストレージ情報が含まれる
                return StaticJavaParser.parse(p);
            } catch (Exception e) {
                throw new RuntimeException(e);
            }
        });

        return findMethodDeclBySig(cu, methodFqn).map(md -> new MethodLoc(methodFqn, file, md));
    }

    /**
     * クラスFQNからソースファイルパスを解決
     * 
     * @param classFqn クラスの完全修飾名
     * @return ソースファイルのパス、見つからない場合はnull
     */
    public Path resolveClassFile(String classFqn) {
        return classToFile.computeIfAbsent(classFqn, this::findFileByClassFqn);
    }

    /**
     * ファイルパスからCompilationUnitを取得（キャッシュ使用）
     * 
     * @param file ソースファイルのパス
     * @return CompilationUnit、パース失敗時はnull
     */
    public CompilationUnit getCompilationUnit(Path file) {
        if (file == null) {
            return null;
        }
        try {
            return cuCache.computeIfAbsent(file, p -> {
                try {
                    return StaticJavaParser.parse(p);
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }
            });
        } catch (Exception e) {
            return null;
        }
    }

    private Path findFileByClassFqn(String classFqn) {
        String rel = classFqn.replace('.', '/') + ".java";
        for (Path root : roots) {
            Path p = root.resolve(rel);
            if (Files.exists(p))
                return p;
        }
        // fallback: 探索（遅いので必要時のみ）
        for (Path root : roots) {
            try (var s = Files.walk(root)) {
                Optional<Path> hit = s.filter(p -> p.toString().endsWith("/" + rel.substring(rel.lastIndexOf('/') + 1)))
                        .findFirst();
                if (hit.isPresent())
                    return hit.get();
            } catch (Exception ignored) {
            }
        }
        return null;
    }

    private Optional<MethodDeclaration> findMethodDeclBySig(CompilationUnit cu, String fqn) {
        int h = fqn.indexOf('#');
        String className = fqn.substring(0, h);
        String sig = fqn.substring(h + 1);
        String mname = sig.substring(0, sig.indexOf('('));
        String params = sig.substring(sig.indexOf('(') + 1, sig.lastIndexOf(')'));
        var paramList = params.isBlank() ? List.<String>of() : splitParams(params);

        List<MethodDeclaration> candidates = cu
                .findAll(com.github.javaparser.ast.body.ClassOrInterfaceDeclaration.class).stream()
                .filter(c -> c.getFullyQualifiedName().orElse("").equals(className))
                .findFirst()
                .map(c -> c.getMethodsByName(mname).stream()
                        .filter(md -> md.getParameters().size() == paramList.size())
                        .collect(Collectors.toList()))
                .orElse(List.of());

        if (candidates.isEmpty()) return Optional.empty();
        if (candidates.size() == 1) return Optional.of(candidates.get(0));

        // 同一引数数のオーバーロードが複数ある場合、引数型でより詳細にマッチング
        for (MethodDeclaration md : candidates) {
            boolean match = true;
            for (int i = 0; i < paramList.size(); i++) {
                String fqnType = paramList.get(i);
                String srcType = md.getParameter(i).getType().asString();
                if (!simplifyTypeName(fqnType).equals(srcType)) {
                    match = false;
                    break;
                }
            }
            if (match) return Optional.of(md);
        }

        // 型マッチ失敗でも候補があれば最初のものを返す（CHA等で必要）
        return Optional.of(candidates.get(0));
    }

    /**
     * FQN型名を単純型名に変換する（パッケージプレフィックスを除去）
     * 例: "java.lang.String" → "String"
     *     "java.lang.String[]" → "String[]"
     *     "java.util.Map<java.lang.String, java.lang.String>" → "Map<String, String>"
     */
    private String simplifyTypeName(String fqnType) {
        // 配列サフィックスを保持
        String suffix = "";
        String base = fqnType;
        while (base.endsWith("[]")) {
            suffix += "[]";
            base = base.substring(0, base.length() - 2);
        }
        // ジェネリクス部分を処理
        int ltPos = base.indexOf('<');
        if (ltPos >= 0) {
            String rawBase = base.substring(0, ltPos);
            String genericPart = base.substring(ltPos);
            return simplifyBaseName(rawBase) + simplifyGenericPart(genericPart) + suffix;
        }
        return simplifyBaseName(base) + suffix;
    }

    private String simplifyBaseName(String name) {
        int lastDot = name.lastIndexOf('.');
        return lastDot >= 0 ? name.substring(lastDot + 1) : name;
    }

    private String simplifyGenericPart(String generic) {
        // ジェネリクス内の各型名を単純化（例: "<java.lang.String, java.lang.String>" → "<String, String>"）
        StringBuilder sb = new StringBuilder();
        int depth = 0;
        int tokenStart = 0;
        for (int i = 0; i < generic.length(); i++) {
            char c = generic.charAt(i);
            if (c == '<') {
                if (depth == 0) {
                    sb.append('<');
                    tokenStart = i + 1;
                }
                depth++;
            } else if (c == '>') {
                depth--;
                if (depth == 0) {
                    String token = generic.substring(tokenStart, i).trim();
                    if (!token.isEmpty()) {
                        sb.append(simplifyTypeName(token));
                    }
                    sb.append('>');
                }
            } else if (c == ',' && depth == 1) {
                String token = generic.substring(tokenStart, i).trim();
                sb.append(simplifyTypeName(token));
                sb.append(",");
                tokenStart = i + 1;
            }
        }
        return sb.toString();
    }
    
    /**
     * ジェネリクスの深さを考慮してパラメータを分割する
     * 例: "Map<Integer, Map<String, Hoge>>,String" -> ["Map<Integer, Map<String, Hoge>>", "String"]
     */
    private List<String> splitParams(String params) {
        List<String> result = new ArrayList<>();
        int depth = 0;
        int start = 0;
        for (int i = 0; i < params.length(); i++) {
            char c = params.charAt(i);
            if (c == '<') {
                depth++;
            } else if (c == '>') {
                depth--;
            } else if (c == ',' && depth == 0) {
                result.add(params.substring(start, i).trim());
                start = i + 1;
            }
        }
        if (start < params.length()) {
            result.add(params.substring(start).trim());
        }
        return result;
    }

    public record MethodLoc(String fqn, Path file, MethodDeclaration decl) {
    }
}
