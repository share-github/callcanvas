package tools.depquery;

import com.github.javaparser.StaticJavaParser;
import com.github.javaparser.ast.CompilationUnit;
import com.github.javaparser.ast.body.ClassOrInterfaceDeclaration;
import com.github.javaparser.ast.body.MethodDeclaration;
import com.github.javaparser.symbolsolver.javaparsermodel.JavaParserFacade;

import java.nio.file.*;
import java.util.*;
import java.util.stream.Collectors;

import static tools.depquery.DiagnosticLogger.*;
import static tools.depquery.FqnUtils.*;

/**
 * メソッド解決・検索ユーティリティ
 * - フィールド型のフォールバック解決
 * - クラス内メソッドFQN検索
 * - メソッド宣言のシグネチャマッチング
 * - グラフ/インデックスからのルート解決
 */
class MethodResolver {

    /**
     * フィールドの型をソースファイルから解決（BFS解析フォールバック用）
     */
    static String resolveFieldTypeFallback(String currentClassFqn, String fieldName,
            SourceLocator locator, JavaParserFacade facade) {
        try {
            Path sourceFile = locator.resolveClassFile(currentClassFqn);
            if (sourceFile == null) return null;
            CompilationUnit cu = locator.getCompilationUnit(sourceFile);
            if (cu == null) return null;
            for (var clazz : cu.findAll(ClassOrInterfaceDeclaration.class)) {
                String classFqn = clazz.getFullyQualifiedName().orElse(null);
                if (currentClassFqn.equals(classFqn)) {
                    for (var field : clazz.getFields()) {
                        for (var variable : field.getVariables()) {
                            if (variable.getNameAsString().equals(fieldName)) {
                                try {
                                    return facade.getType(variable).describe();
                                } catch (Throwable ex) {
                                    return field.getElementType().asString();
                                }
                            }
                        }
                    }
                }
            }
        } catch (Throwable ex) {
            debugVerbose("resolveFieldTypeFallback failed: " + fieldName + " - " + ex.getMessage());
        }
        return null;
    }

    /**
     * クラス内のメソッドFQNをソースファイルから検索（BFS解析フォールバック用）
     * 引数個数が一致する最初の1件を返す（後方互換）。
     */
    static String findMethodFqnInClassFallback(String classFqn, String methodName, int argCount,
            SourceLocator locator, JavaParserFacade facade) {
        List<String> all = findAllMethodFqnsInClassFallback(classFqn, methodName, argCount, locator, facade);
        return all.isEmpty() ? null : all.get(0);
    }

    /**
     * クラス内の引数個数が一致する全オーバーロードのFQNを返す（BFS解析フォールバック用）。
     * オーバーロードが複数ある場合に全候補を返すことで、偽陰性（欠落）を防ぐ。
     */
    static List<String> findAllMethodFqnsInClassFallback(String classFqn, String methodName, int argCount,
            SourceLocator locator, JavaParserFacade facade) {
        List<String> results = new ArrayList<>();
        try {
            Path sourceFile = locator.resolveClassFile(classFqn);
            if (sourceFile == null) return results;
            CompilationUnit cu = locator.getCompilationUnit(sourceFile);
            if (cu == null) return results;
            for (var clazz : cu.findAll(ClassOrInterfaceDeclaration.class)) {
                String currentFqn = clazz.getFullyQualifiedName().orElse(null);
                if (classFqn.equals(currentFqn)) {
                    for (var md : clazz.getMethods()) {
                        if (md.getNameAsString().equals(methodName) &&
                                md.getParameters().size() == argCount) {
                            results.add(buildMethodFqn(classFqn, md, facade));
                        }
                    }
                }
            }
        } catch (Throwable ex) {
            debugVerbose("findAllMethodFqnsInClassFallback failed: " + classFqn + "#" + methodName);
        }
        return results;
    }

    static Optional<MethodDeclaration> findMethodDeclBySig(CompilationUnit cu, String fqn) {
        // fqn: pkg.Class#name(param,param)
        int h = fqn.indexOf('#');
        String className = fqn.substring(0, h);
        String sig = fqn.substring(h + 1);
        String mname = sig.substring(0, sig.indexOf('('));
        String params = sig.substring(sig.indexOf('(') + 1, sig.lastIndexOf(')'));
        var paramList = params.isBlank() ? List.<String>of() : splitParams(params);

        debugVerbose("findMethodDeclBySig: fqn=" + fqn + " className=" + className + " mname=" + mname + " paramList="
                + paramList);

        return cu.findAll(ClassOrInterfaceDeclaration.class).stream()
                .filter(c -> c.getFullyQualifiedName().orElse("").equals(className))
                .findFirst()
                .flatMap(c -> {
                    debugVerbose("findMethodDeclBySig: found class, methods=" + c.getMethodsByName(mname).size());
                    // パラメータ型も考慮してマッチング（オーバーロード対応）
                    return c.getMethodsByName(mname).stream()
                            .filter(md -> md.getParameters().size() == paramList.size())
                            .filter(md -> {
                                // パラメータ型の簡易マッチング（完全修飾名の末尾一致）
                                if (paramList.isEmpty())
                                    return true;

                                var mdParams = md.getParameters();
                                for (int i = 0; i < paramList.size(); i++) {
                                    String expectedType = paramList.get(i);
                                    String actualType = mdParams.get(i).getType().asString();

                                    debugVerbose("findMethodDeclBySig: comparing param[" + i + "] expected="
                                            + expectedType + " actual=" + actualType);

                                    // 完全一致
                                    if (actualType.equals(expectedType)) {
                                        continue;
                                    }

                                    // まずジェネリクスを除去してから、末尾一致をチェック
                                    // 例: "Map<Integer, Map<String, ProductInfo>>" -> "Map" -> 末尾一致チェック
                                    String expectedBase = removeGenericsFromType(expectedType);
                                    String actualBase = removeGenericsFromType(actualType);

                                    debugVerbose("findMethodDeclBySig: after removeGenerics expectedBase="
                                            + expectedBase + " actualBase=" + actualBase);

                                    // 末尾一致（パッケージ省略対応）
                                    // 例: "Integer" と "java.lang.Integer", "int" と "int"
                                    String expectedSimple = expectedBase.contains(".")
                                            ? expectedBase.substring(expectedBase.lastIndexOf('.') + 1)
                                            : expectedBase;
                                    String actualSimple = actualBase.contains(".")
                                            ? actualBase.substring(actualBase.lastIndexOf('.') + 1)
                                            : actualBase;

                                    debugVerbose("findMethodDeclBySig: after processing expectedSimple="
                                            + expectedSimple + " actualSimple=" + actualSimple);

                                    if (!expectedSimple.equals(actualSimple)) {
                                        debugVerbose("findMethodDeclBySig: type mismatch");
                                        return false;
                                    }
                                }
                                return true;
                            })
                            .findFirst();
                });
    }

    /**
     * ユーザー指定のroot文字列をグラフ内の実際のノードIDに解決する（曖昧マッチング対応）
     *
     * マッチング規則:
     * 1. 完全一致: そのまま見つかればOK
     * 2. クラス名短縮形: TodoService#method(...) -> *.TodoService#method(...)
     * 3. パラメータ型短縮形: String -> java.lang.String, LocalDate -> java.time.LocalDate
     */
    static String resolveRootFromGraph(String userRoot, GraphModels.Graph graph) {
        debug("resolveRootFromGraph: userRoot=" + userRoot + " graph.nodes.size=" + graph.nodes.size());

        // 1. 完全一致
        if (graph.nodes.containsKey(userRoot)) {
            debug("resolveRootFromGraph: exact match found");
            return userRoot;
        }

        // 2. パース: Class#method(params)
        if (!userRoot.contains("#")) {
            debug("resolveRootFromGraph: invalid format (no #)");
            return null; // 不正な形式
        }

        int hashPos = userRoot.indexOf('#');
        String userClass = userRoot.substring(0, hashPos);
        String methodSig = userRoot.substring(hashPos + 1);

        int parenPos = methodSig.indexOf('(');
        if (parenPos < 0) {
            debug("resolveRootFromGraph: invalid format (no parens)");
            return null; // 不正な形式
        }

        String methodName = methodSig.substring(0, parenPos);
        String paramsPart = methodSig.substring(parenPos + 1, methodSig.lastIndexOf(')'));
        List<String> userParams = paramsPart.isBlank() ? List.of() : splitParams(paramsPart);

        debug("resolveRootFromGraph: userClass=" + userClass + " methodName=" + methodName + " userParams="
                + userParams);

        // 3. グラフ内の全ノードと照合
        for (var node : graph.nodes.values()) {
            debug("resolveRootFromGraph: checking node id=" + node.id + " classFqn=" + node.classFqn + " name="
                    + node.name + " paramsFqn=" + node.paramsFqn);

            // クラス名マッチング（末尾一致）
            if (!classNameMatches(node.classFqn, userClass)) {
                debug("resolveRootFromGraph: class mismatch");
                continue;
            }

            // メソッド名マッチング（完全一致）
            if (!node.name.equals(methodName)) {
                debug("resolveRootFromGraph: method name mismatch");
                continue;
            }

            // パラメータ数マッチング
            if (node.paramsFqn.size() != userParams.size()) {
                debug("resolveRootFromGraph: param count mismatch: " + node.paramsFqn.size() + " vs "
                        + userParams.size());
                continue;
            }

            // パラメータ型マッチング（型名の末尾一致）
            boolean paramsMatch = true;
            for (int i = 0; i < userParams.size(); i++) {
                boolean match = typeMatches(node.paramsFqn.get(i), userParams.get(i));
                debug("resolveRootFromGraph: typeMatches(" + node.paramsFqn.get(i) + ", " + userParams.get(i) + ") = "
                        + match);
                if (!match) {
                    paramsMatch = false;
                    break;
                }
            }

            if (paramsMatch) {
                debug("resolveRootFromGraph: found match: " + node.id);
                return node.id;
            }
        }

        debug("resolveRootFromGraph: no match found");
        return null; // マッチするノードが見つからなかった
    }

    /**
     * 全ソースファイルをスキャンして、メソッドシグネチャのインデックスを構築
     * Key: 短縮形または完全修飾名のメソッドシグネチャ
     * Value: 完全修飾名のメソッドシグネチャ
     */
    static Map<String, String> buildMethodIndex(List<Path> srcRoots, JavaParserFacade facade) {
        Map<String, String> index = new HashMap<>();

        for (Path root : srcRoots) {
            try (var stream = Files.walk(root)) {
                stream.filter(p -> p.toString().endsWith(".java"))
                        .forEach(javaFile -> {
                            try {
                                CompilationUnit cu = StaticJavaParser.parse(Files.readString(javaFile));
                                cu.findAll(ClassOrInterfaceDeclaration.class).forEach(cls -> {
                                    String classFqn = cls.getFullyQualifiedName().orElse(null);
                                    String simpleClassName = cls.getNameAsString();
                                    if (classFqn == null)
                                        return;

                                    cls.getMethods().forEach(md -> {
                                        String methodName = md.getNameAsString();

                                        // パラメータ型を取得（完全修飾名）
                                        List<String> paramsFqn = md.getParameters().stream()
                                                .map(p -> {
                                                    try {
                                                        return facade.getType(p).describe();
                                                    } catch (Throwable t) {
                                                        return p.getType().asString();
                                                    }
                                                })
                                                .toList();

                                        // 完全修飾名のシグネチャ
                                        String fullSig = classFqn + "#" + methodName + "(" + String.join(",", paramsFqn)
                                                + ")";

                                        // インデックスに登録
                                        index.put(fullSig, fullSig);
                                    });
                                });
                            } catch (Throwable ignored) {
                                // パースエラーは無視
                            }
                        });
            } catch (Throwable ignored) {
            }
        }

        return index;
    }

    /**
     * ユーザー指定のメソッドシグネチャを、メソッドインデックスから解決
     */
    static String resolveRootMethodFqn(String userRoot, Map<String, String> methodIndex) {
        // 1. 完全一致
        if (methodIndex.containsKey(userRoot)) {
            return userRoot;
        }

        // 2. パース
        if (!userRoot.contains("#")) {
            return null;
        }

        int hashPos = userRoot.indexOf('#');
        String userClass = userRoot.substring(0, hashPos);
        String methodSig = userRoot.substring(hashPos + 1);

        int parenPos = methodSig.indexOf('(');
        if (parenPos < 0) {
            return null;
        }

        String methodName = methodSig.substring(0, parenPos);
        String paramsPart = methodSig.substring(parenPos + 1, methodSig.lastIndexOf(')'));
        List<String> userParams = paramsPart.isBlank() ? List.of() : splitParams(paramsPart);

        // 3. インデックス内の全シグネチャと照合
        for (String candidateFqn : methodIndex.keySet()) {
            if (!candidateFqn.contains("#"))
                continue;

            int h = candidateFqn.indexOf('#');
            String candidateClass = candidateFqn.substring(0, h);
            String candidateSig = candidateFqn.substring(h + 1);

            int p = candidateSig.indexOf('(');
            if (p < 0)
                continue;

            String candidateMethod = candidateSig.substring(0, p);
            String candidateParamsPart = candidateSig.substring(p + 1, candidateSig.lastIndexOf(')'));
            List<String> candidateParams = candidateParamsPart.isBlank() ? List.of() : splitParams(candidateParamsPart);

            // クラス名マッチング
            if (!classNameMatches(candidateClass, userClass)) {
                continue;
            }

            // メソッド名マッチング
            if (!candidateMethod.equals(methodName)) {
                continue;
            }

            // パラメータ数マッチング
            if (candidateParams.size() != userParams.size()) {
                continue;
            }

            // パラメータ型マッチング
            boolean paramsMatch = true;
            for (int i = 0; i < userParams.size(); i++) {
                if (!typeMatches(candidateParams.get(i), userParams.get(i))) {
                    paramsMatch = false;
                    break;
                }
            }

            if (paramsMatch) {
                return candidateFqn;
            }
        }

        return null;
    }
}
