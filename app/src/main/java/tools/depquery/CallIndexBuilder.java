package tools.depquery;

import com.github.javaparser.ast.CompilationUnit;
import com.github.javaparser.ast.body.*;
import com.github.javaparser.ast.expr.LiteralExpr;
import com.github.javaparser.ast.expr.MethodCallExpr;
import com.github.javaparser.ast.expr.MethodReferenceExpr;
import com.github.javaparser.ast.expr.ObjectCreationExpr;
import com.github.javaparser.resolution.declarations.ResolvedConstructorDeclaration;
import com.github.javaparser.resolution.declarations.ResolvedMethodDeclaration;
import com.github.javaparser.symbolsolver.javaparsermodel.JavaParserFacade;
import tools.depquery.CallIndexModels.*;

import java.io.IOException;
import java.nio.file.*;
import java.util.*;

import static java.util.stream.Collectors.joining;
import static tools.depquery.DiagnosticLogger.*;
import static tools.depquery.FqnUtils.*;
import static tools.depquery.NodeFactory.acceptByFilter;

/**
 * CallIndex を構築するビルダー
 */
class CallIndexBuilder {
    private final AnalyzerConfig cfg;
    private final SourceLocator locator;
    private final JavaParserFacade facade;
    private final ChaContext chaContext;
    
    // 親クラス探索結果のキャッシュ: "classFqn#methodName#argCount" -> 解決されたFQN (nullは未発見)
    private final Map<String, String> parentMethodCache = new HashMap<>();
    
    // findMethodInClassの結果キャッシュ: "parentFqn#methodName#argCount" -> 存在有無
    private final Map<String, Boolean> methodExistsCache = new HashMap<>();
    
    // buildMethodFqnの結果キャッシュ: "parentFqn#methodName#argCount" -> FQN
    private final Map<String, String> methodFqnCache = new HashMap<>();
    
    CallIndexBuilder(AnalyzerConfig cfg, SourceLocator locator, JavaParserFacade facade, ChaContext chaContext) {
        this.cfg = cfg;
        this.locator = locator;
        this.facade = facade;
        this.chaContext = chaContext;
    }
    
    /**
     * 全ソースファイルをスキャンしてインデックスを構築
     */
    CallIndex buildFullIndex() throws IOException {
        info("[INFO] Building call index...");
        long startTime = System.currentTimeMillis();
        
        CallIndex index = new CallIndex();
        
        // 全Javaファイルを収集
        long scanStart = startTiming("File Scan");
        List<Path> allJavaFiles = new ArrayList<>();
        for (Path srcRoot : cfg.srcRoots) {
            try (var stream = Files.walk(srcRoot)) {
                stream.filter(p -> p.toString().endsWith(".java"))
                      .forEach(allJavaFiles::add);
            }
        }
        endTiming("File Scan", scanStart);
        
        info("[INFO] Found " + allJavaFiles.size() + " Java files");
        
        long hashStart = startTiming("File Hashing (full index)");
        Map<String, String> fileHashes = CallIndexManager.calculateFileHashes(allJavaFiles);
        endTiming("File Hashing (full index)", hashStart);
        for (var entry : fileHashes.entrySet()) {
            index.setFileHash(entry.getKey(), entry.getValue());
        }
        
        // 各ファイルをパースしてメソッド呼び出しを解析
        long indexingStart = startTiming("Method Indexing");
        int processedFiles = 0;
        Map<Path, CompilationUnit> parsedFiles = new HashMap<>();
        
        for (Path javaFile : allJavaFiles) {
            try {
                processedFiles++;
                if (processedFiles % 100 == 0) {
                    info("[INFO] Processing file " + processedFiles + "/" + allJavaFiles.size());
                }
                
                CompilationUnit cu = parseCu(javaFile);
                parsedFiles.put(javaFile, cu);
                
                // ファイル内の全メソッドを処理
                cu.findAll(ClassOrInterfaceDeclaration.class).forEach(clazz -> {
                    String currentClassFqn = clazz.getFullyQualifiedName().orElse(null);
                    if (currentClassFqn == null) return;
                    
                    clazz.findAll(MethodDeclaration.class).forEach(md -> {
                        try {
                            String methodFqn = buildMethodFqn(currentClassFqn, md, facade);
                            int lineStart = md.getRange().map(r -> r.begin.line).orElse(-1);
                            int lineEnd = md.getRange().map(r -> r.end.line).orElse(-1);
                            
                            // メタデータ収集
                            String simpleClass = clazz.getNameAsString();
                            String methodName = md.getNameAsString();
                            List<String> paramsFqn = md.getParameters().stream()
                                .map(p -> {
                                    try {
                                        return facade.getType(p).describe();
                                    } catch (Throwable t) {
                                        return p.getType().asString();
                                    }
                                })
                                .toList();
                            String paramsDisplay = paramsFqn.stream()
                                .map(FqnUtils::shortType)
                                .collect(joining(", "));
                            String display = simpleClass + "." + methodName + "(" + paramsDisplay + ") L" + lineStart + "-" + lineEnd;
                            List<String> annotations = md.getAnnotations().stream()
                                .map(a -> "@" + a.getNameAsString())
                                .toList();
                            String stereotype = stereotypeOf(clazz);
                            
                            MethodEntry entry = new MethodEntry(methodFqn, javaFile.toString(), 
                                lineStart, lineEnd, display, currentClassFqn, methodName, 
                                paramsFqn, annotations, stereotype);
                            
                            // メソッド呼び出しを収集
                            collectCallsForMethod(md, methodFqn, currentClassFqn, entry, clazz);
                            
                            index.addMethod(entry);
                        } catch (Throwable ex) {
                            debugVerbose("Failed to process method in " + javaFile + ": " + ex.getMessage());
                        }
                    });
                    
                    // コンストラクタも処理
                    clazz.findAll(ConstructorDeclaration.class).forEach(cd -> {
                        try {
                            ResolvedConstructorDeclaration resolvedCtor = cd.resolve();
                            String ctorFqn = toCtorFqn(resolvedCtor);
                            int lineStart = cd.getRange().map(r -> r.begin.line).orElse(-1);
                            int lineEnd = cd.getRange().map(r -> r.end.line).orElse(-1);

                            // メタデータ収集
                            String simpleClass = clazz.getNameAsString();
                            String ctorName = cd.getNameAsString();
                            List<String> paramsFqn = cd.getParameters().stream()
                                .map(p -> {
                                    try {
                                        return facade.getType(p).describe();
                                    } catch (Throwable t) {
                                        return p.getType().asString();
                                    }
                                })
                                .toList();
                            String paramsDisplay = paramsFqn.stream()
                                .map(FqnUtils::shortType)
                                .collect(joining(", "));
                            String display = simpleClass + "." + ctorName + "(" + paramsDisplay + ") L" + lineStart + "-" + lineEnd;
                            List<String> annotations = cd.getAnnotations().stream()
                                .map(a -> "@" + a.getNameAsString())
                                .toList();
                            String stereotype = stereotypeOf(clazz);

                            MethodEntry entry = new MethodEntry(ctorFqn, javaFile.toString(),
                                lineStart, lineEnd, display, currentClassFqn, ctorName,
                                paramsFqn, annotations, stereotype);

                            // コンストラクタ内の呼び出しを収集
                            collectCallsForConstructor(cd, ctorFqn, currentClassFqn, entry, clazz);

                            index.addMethod(entry);
                        } catch (Throwable ex) {
                            debugVerbose("Failed to process constructor in " + javaFile + ": " + ex.getMessage());
                        }
                    });

                    // static final フィールド（定数）を収集
                    clazz.findAll(FieldDeclaration.class).forEach(fd -> {
                        if (!fd.isStatic() || !fd.isFinal()) return;
                        for (var var : fd.getVariables()) {
                            var.getInitializer().ifPresent(init -> {
                                if (init instanceof LiteralExpr) {
                                    String type = fd.getElementType().asString();
                                    if (isCollectableConstantType(type)) {
                                        index.symbolIndex.put(var.getNameAsString(),
                                            new CallIndexModels.ConstantEntry(init.toString(), currentClassFqn, type));
                                    }
                                }
                            });
                        }
                    });
                });

                // enum 値を収集
                cu.findAll(EnumDeclaration.class).forEach(ed -> {
                    String enumFqn = ed.getFullyQualifiedName().orElse(ed.getNameAsString());
                    int ordinal = 0;
                    for (var ec : ed.getEntries()) {
                        String key = ed.getNameAsString() + "." + ec.getNameAsString();
                        String value = (!ec.getArguments().isEmpty()
                                && ec.getArguments().get(0) instanceof LiteralExpr)
                            ? ec.getArguments().get(0).toString()
                            : String.valueOf(ordinal);
                        index.symbolIndex.put(key,
                            new CallIndexModels.ConstantEntry(value, enumFqn, "enum"));
                        ordinal++;
                    }
                });

            } catch (Throwable ex) {
                debugVerbose("Failed to parse file: " + javaFile + " - " + ex.getMessage());
            }
        }
        endTiming("Method Indexing", indexingStart);
        
        // 逆参照（callers）を構築
        long callerStart = startTiming("Caller References Build");
        buildCallerReferences(index);
        endTiming("Caller References Build", callerStart);
        
        long elapsed = System.currentTimeMillis() - startTime;
        info("[INFO] Index built in " + (elapsed / 1000) + "s: " + 
                         index.methods.size() + " methods indexed");
        
        return index;
    }
    
    /**
     * メソッド内の呼び出しを収集
     */
    private void collectCallsForMethod(MethodDeclaration md, String callerFqn, String currentClassFqn,
                                      MethodEntry entry, ClassOrInterfaceDeclaration clazz) {
        // 同一クラス内のメソッドマップを構築（フォールバック用）
        Map<String, List<MethodDeclaration>> sameClassMethods = new HashMap<>();
        clazz.findAll(MethodDeclaration.class).forEach(m -> {
            sameClassMethods.computeIfAbsent(m.getNameAsString(), k -> new ArrayList<>()).add(m);
        });
        
        // メソッド呼び出し
        md.findAll(MethodCallExpr.class).forEach(mc -> {
            int line = mc.getRange().map(r -> r.begin.line).orElse(-1);
            int endLine = mc.getRange().map(r -> r.end.line).orElse(line);
            
            try {
                ResolvedMethodDeclaration decl = facade.solve(mc).getCorrespondingDeclaration();
                String callee = toMethodFqn(decl);
                
                if (acceptByFilter(callee, cfg)) {
                    entry.addCallee(callee, line, endLine, "call");
                    
                    // CHAでオーバーライドも追加
                    if (isVirtualCall(decl)) {
                        Set<String> overrides = chaContext.findOverrides(callee);
                        for (String impl : overrides) {
                            if (!impl.equals(callee) && acceptByFilter(impl, cfg)) {
                                entry.addCallee(impl, line, endLine, "override");
                            }
                        }
                    }
                }
            } catch (Throwable ex) {
                debugVerbose("facade.solve failed at L" + line + " [" + ex.getClass().getSimpleName() + "]: " + ex.getMessage());
                // フォールバック: 同一クラス内のメソッドを名前で検索
                tryFallbackResolve(mc, sameClassMethods, currentClassFqn, entry, line, endLine);
            }
        });
        
        // メソッド参照
        md.findAll(MethodReferenceExpr.class).forEach(mr -> {
            int line = mr.getRange().map(r -> r.begin.line).orElse(-1);
            int endLine = mr.getRange().map(r -> r.end.line).orElse(line);
            
            try {
                ResolvedMethodDeclaration decl = facade.solve(mr).getCorrespondingDeclaration();
                String callee = toMethodFqn(decl);
                
                if (acceptByFilter(callee, cfg)) {
                    entry.addCallee(callee, line, endLine, "method-ref");
                    
                    // CHAでオーバーライドも追加
                    if (isVirtualCall(decl)) {
                        Set<String> overrides = chaContext.findOverrides(callee);
                        for (String impl : overrides) {
                            if (!impl.equals(callee) && acceptByFilter(impl, cfg)) {
                                entry.addCallee(impl, line, endLine, "override");
                            }
                        }
                    }
                }
            } catch (Throwable ex) {
                debugVerbose("Failed to resolve method-ref: " + mr);
            }
        });
        
        // コンストラクタ呼び出し
        md.findAll(ObjectCreationExpr.class).forEach(ne -> {
            int line = ne.getRange().map(r -> r.begin.line).orElse(-1);
            int endLine = ne.getRange().map(r -> r.end.line).orElse(line);
            
            try {
                ResolvedConstructorDeclaration decl = facade.solve(ne).getCorrespondingDeclaration();
                String callee = toCtorFqn(decl);
                
                if (acceptByFilter(callee, cfg)) {
                    entry.addCallee(callee, line, endLine, "ctor");
                }
            } catch (Throwable ex) {
                debugVerbose("Failed to resolve constructor: " + ne);
            }
        });
    }
    
    /**
     * コンストラクタ内の呼び出しを収集
     */
    private void collectCallsForConstructor(ConstructorDeclaration cd, String callerFqn, String currentClassFqn,
                                           MethodEntry entry, ClassOrInterfaceDeclaration clazz) {
        // メソッドと同じロジックを適用（MethodDeclarationの代わりにConstructorDeclarationを使用）
        Map<String, List<MethodDeclaration>> sameClassMethods = new HashMap<>();
        clazz.findAll(MethodDeclaration.class).forEach(m -> {
            sameClassMethods.computeIfAbsent(m.getNameAsString(), k -> new ArrayList<>()).add(m);
        });
        
        cd.findAll(MethodCallExpr.class).forEach(mc -> {
            int line = mc.getRange().map(r -> r.begin.line).orElse(-1);
            int endLine = mc.getRange().map(r -> r.end.line).orElse(line);
            
            try {
                ResolvedMethodDeclaration decl = facade.solve(mc).getCorrespondingDeclaration();
                String callee = toMethodFqn(decl);
                
                if (acceptByFilter(callee, cfg)) {
                    entry.addCallee(callee, line, endLine, "call");
                    
                    if (isVirtualCall(decl)) {
                        Set<String> overrides = chaContext.findOverrides(callee);
                        for (String impl : overrides) {
                            if (!impl.equals(callee) && acceptByFilter(impl, cfg)) {
                                entry.addCallee(impl, line, endLine, "override");
                            }
                        }
                    }
                }
            } catch (Throwable ex) {
                tryFallbackResolve(mc, sameClassMethods, currentClassFqn, entry, line, endLine);
            }
        });
    }
    
    /**
     * フォールバック解決を試みる
     */
    private void tryFallbackResolve(MethodCallExpr mc, Map<String, List<MethodDeclaration>> sameClassMethods,
                                   String currentClassFqn, MethodEntry entry, int line, int endLine) {
        boolean hasScope = mc.getScope().isPresent();
        if (currentClassFqn != null && !hasScope) {
            String methodName = mc.getNameAsString();
            int argCount = mc.getArguments().size();
            var candidates = sameClassMethods.get(methodName);

            boolean found = false;
            if (candidates != null) {
                for (var candidate : candidates) {
                    if (candidate.getParameters().size() == argCount) {
                        String callee = buildMethodFqn(currentClassFqn, candidate, facade);
                        if (acceptByFilter(callee, cfg)) {
                            entry.addCallee(callee, line, endLine, "call");
                            // CHA: 同一クラス内フォールバックでもオーバーライドを追加
                            Set<String> overrides = chaContext.findOverrides(callee);
                            for (String impl : overrides) {
                                if (!impl.equals(callee) && acceptByFilter(impl, cfg)) {
                                    entry.addCallee(impl, line, endLine, "override");
                                }
                            }
                        }
                        found = true;
                        // 同一引数数の全オーバーロードを処理するため return しない
                    }
                }
            }

            if (!found) {
                // 同一クラス内で見つからない場合、親クラスを探索
                tryResolveInParentClasses(methodName, argCount, currentClassFqn, entry, line, endLine);
            }
        }

        // スコープありの場合も処理（例: serviceInstance.updateMethod(...)）
        if (hasScope) {
            tryResolveWithScope(mc, currentClassFqn, entry, line, endLine);
        }
    }

    /**
     * スコープ付きメソッド呼び出しを解決
     * 例: serviceInstance.updateMethod(...) の場合、serviceInstanceの型を特定してメソッドを検索
     */
    private void tryResolveWithScope(MethodCallExpr mc, String currentClassFqn, 
                                    MethodEntry entry, int line, int endLine) {
        try {
            String methodName = mc.getNameAsString();
            int argCount = mc.getArguments().size();
            
            // スコープの型を取得
            var scope = mc.getScope().get();
            String scopeTypeFqn = null;
            
            try {
                // facadeで型解決を試みる
                var resolvedType = facade.getType(scope);
                scopeTypeFqn = resolvedType.describe();
            } catch (Throwable ex) {
                // 型解決失敗時は、スコープがフィールドの場合、SourceLocatorで探索
                if (scope.isNameExpr()) {
                    String scopeName = scope.asNameExpr().getNameAsString();
                    scopeTypeFqn = resolveFieldType(currentClassFqn, scopeName);
                }
            }
            
            if (scopeTypeFqn == null) {
                debugVerbose("Failed to resolve scope type for: " + mc);
                return;
            }
            
            // 型名を正規化（java.util.List<String> -> java.util.List）
            scopeTypeFqn = scopeTypeFqn.replaceAll("<.*?>", "");

            // 単純名しか取れていない場合（パッケージなし）は、呼び出し元 CU の import から FQN を補完
            if (!scopeTypeFqn.contains(".")) {
                var cuOpt = mc.findCompilationUnit();
                if (cuOpt.isPresent()) {
                    scopeTypeFqn = resolveSimpleNameWithImports(cuOpt.get(), scopeTypeFqn);
                    debugVerbose("Resolved scope type via imports: " + scopeTypeFqn);
                }
            }
            
            // その型のメソッドをソースファイルから検索してFQNを構築（全オーバーロード取得）
            List<String> calleeFqns = findAllMethodFqnsInClass(scopeTypeFqn, methodName, argCount);

            if (calleeFqns.isEmpty()) {
                // ソースファイルから見つからない場合、推測形式で記録
                String guessedFqn = scopeTypeFqn + "#" + methodName + "(...)";
                debugVerbose("Fallback resolved with scope (guessed): " + guessedFqn);
                if (acceptByFilter(guessedFqn, cfg)) {
                    entry.addCallee(guessedFqn, line, endLine, "call");
                    debugVerbose("Added callee (guessed): " + guessedFqn + " at L" + line);
                }
            } else {
                // 全オーバーロード候補に対してエッジ追加 + CHA override 追加（Bug 2 修正）
                for (String calleeFqn : calleeFqns) {
                    debugVerbose("Fallback resolved with scope (found): " + calleeFqn);
                    if (acceptByFilter(calleeFqn, cfg)) {
                        entry.addCallee(calleeFqn, line, endLine, "call");
                        debugVerbose("Added callee: " + calleeFqn + " at L" + line);
                        // CHA: 外部スコープフォールバックのオーバーライドも追加
                        Set<String> overrides = chaContext.findOverrides(calleeFqn);
                        for (String impl : overrides) {
                            if (!impl.equals(calleeFqn) && acceptByFilter(impl, cfg)) {
                                entry.addCallee(impl, line, endLine, "override");
                                debugVerbose("Added override callee: " + impl + " at L" + line);
                            }
                        }
                    } else {
                        debugVerbose("Callee filtered out: " + calleeFqn);
                    }
                }
            }
        } catch (Throwable ex) {
            debugVerbose("Failed to resolve with scope: " + mc + " - " + ex.getMessage());
        }
    }
    
    /**
     * 単純クラス名を import 文から完全修飾名（FQN）に解決する。
     * facade が失敗した場合のフォールバックとして使用する。
     *
     * 解決優先順:
     *   1. 既に FQN（ドットを含む）→ そのまま返す
     *   2. import 文の末尾が単純名と一致 → その FQN を返す
     *   3. 同一パッケージ想定 → package + "." + simpleName を返す
     *   4. パッケージ宣言なし → simpleName をそのまま返す
     */
    private static String resolveSimpleNameWithImports(CompilationUnit cu, String simpleName) {
        if (simpleName == null || simpleName.contains(".")) {
            return simpleName;
        }
        for (var imp : cu.getImports()) {
            if (!imp.isAsterisk() && !imp.isStatic()) {
                String fqn = imp.getNameAsString();
                if (fqn.endsWith("." + simpleName)) {
                    return fqn;
                }
            }
        }
        String pkg = cu.getPackageDeclaration()
                .map(p -> p.getNameAsString()).orElse("");
        return pkg.isEmpty() ? simpleName : pkg + "." + simpleName;
    }

    /**
     * クラス内のメソッドFQNを検索（引数個数一致の最初の1件、後方互換）
     */
    private String findMethodFqnInClass(String classFqn, String methodName, int argCount) {
        List<String> all = findAllMethodFqnsInClass(classFqn, methodName, argCount);
        return all.isEmpty() ? null : all.get(0);
    }

    /**
     * クラス内の引数個数が一致する全オーバーロードのFQNを返す。
     * オーバーロードが複数ある場合に全候補を返すことで、偽陰性（欠落）を防ぐ。
     */
    private List<String> findAllMethodFqnsInClass(String classFqn, String methodName, int argCount) {
        List<String> results = new ArrayList<>();
        try {
            Path sourceFile = locator.resolveClassFile(classFqn);
            if (sourceFile == null) {
                return results;
            }

            CompilationUnit cu = locator.getCompilationUnit(sourceFile);
            if (cu == null) {
                return results;
            }

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
            debugVerbose("Failed to find method FQN in class: " + classFqn + "#" + methodName);
        }
        return results;
    }
    
    /**
     * フィールドの型を解決
     */
    private String resolveFieldType(String currentClassFqn, String fieldName) {
        try {
            // SourceLocatorでクラスのソースファイルを取得
            Path sourceFile = locator.resolveClassFile(currentClassFqn);
            if (sourceFile == null) {
                return null;
            }
            
            CompilationUnit cu = locator.getCompilationUnit(sourceFile);
            if (cu == null) {
                return null;
            }
            
            // フィールド宣言を探索
            for (var clazz : cu.findAll(ClassOrInterfaceDeclaration.class)) {
                String classFqn = clazz.getFullyQualifiedName().orElse(null);
                if (currentClassFqn.equals(classFqn)) {
                    for (var field : clazz.getFields()) {
                        for (var variable : field.getVariables()) {
                            if (variable.getNameAsString().equals(fieldName)) {
                                // フィールドの型を取得
                                try {
                                    return facade.getType(variable).describe();
                                } catch (Throwable ex) {
                                    // facade で解決できない場合は import 文から FQN を解決
                                    String simpleName = field.getElementType().asString();
                                    return resolveSimpleNameWithImports(cu, simpleName);
                                }
                            }
                        }
                    }
                }
            }
        } catch (Throwable ex) {
            debugVerbose("Failed to resolve field type: " + fieldName + " - " + ex.getMessage());
        }
        return null;
    }
    
    /**
     * 親クラス/インターフェースでメソッドを探索
     * JavaSymbolSolverで解決できなかった場合のフォールバック
     * 
     * @param methodName メソッド名
     * @param argCount 引数の数
     * @param currentClassFqn 現在のクラスFQN
     * @param entry 呼び出し元のメソッドエントリ
     * @param line 呼び出し行
     * @param endLine 呼び出し終了行
     */
    private void tryResolveInParentClasses(String methodName, int argCount, String currentClassFqn,
                                          MethodEntry entry, int line, int endLine) {
        // キャッシュキーを作成
        String cacheKey = currentClassFqn + "#" + methodName + "#" + argCount;
        
        // キャッシュをチェック
        if (parentMethodCache.containsKey(cacheKey)) {
            String cachedCallee = parentMethodCache.get(cacheKey);
            if (cachedCallee != null && acceptByFilter(cachedCallee, cfg)) {
                entry.addCallee(cachedCallee, line, endLine, "call");
            }
            return; // キャッシュヒット（見つからなかった場合もスキップ）
        }
        
        // 親クラスリストを取得（HierarchyCache経由）
        List<String> parentClasses = chaContext.getCache().getParentClasses(currentClassFqn);
        if (parentClasses.isEmpty()) {
            parentMethodCache.put(cacheKey, null); // 見つからないことをキャッシュ
            return;
        }
        
        Set<String> visited = new HashSet<>();
        Queue<String> queue = new LinkedList<>(parentClasses);
        
        while (!queue.isEmpty()) {
            String parentFqn = queue.poll();
            if (visited.contains(parentFqn)) {
                continue;
            }
            visited.add(parentFqn);

            // 親クラス＋メソッド名でキャッシュをチェック
            String methodKey = parentFqn + "#" + methodName + "#" + argCount;

            // methodFqnCacheにヒットすれば、そのFQNを使用
            if (methodFqnCache.containsKey(methodKey)) {
                String cachedFqn = methodFqnCache.get(methodKey);
                if (cachedFqn != null) {
                    parentMethodCache.put(cacheKey, cachedFqn);
                    if (acceptByFilter(cachedFqn, cfg)) {
                        entry.addCallee(cachedFqn, line, endLine, "call");
                        // CHA: 親クラス経由フォールバックでもオーバーライドを追加
                        Set<String> overrides = chaContext.findOverrides(cachedFqn);
                        for (String impl : overrides) {
                            if (!impl.equals(cachedFqn) && acceptByFilter(impl, cfg)) {
                                entry.addCallee(impl, line, endLine, "override");
                            }
                        }
                    }
                    return;
                }
                // cachedFqn == null: このクラスにはメソッドがない、次の親へ
                List<String> grandParents = chaContext.getCache().getParentClasses(parentFqn);
                queue.addAll(grandParents);
                continue;
            }

            // キャッシュミス: 実際に全オーバーロードを探索
            List<String> foundCallees = findAllMethodFqnsInClass(parentFqn, methodName, argCount);
            if (!foundCallees.isEmpty()) {
                // キャッシュには最初の1件を格納（後方互換）
                methodFqnCache.put(methodKey, foundCallees.get(0));
                parentMethodCache.put(cacheKey, foundCallees.get(0));
                for (String callee : foundCallees) {
                    if (acceptByFilter(callee, cfg)) {
                        entry.addCallee(callee, line, endLine, "call");
                        debugVerbose("Fallback resolved in parent: " + callee);
                        // CHA: 親クラス経由フォールバックでもオーバーライドを追加
                        Set<String> overrides = chaContext.findOverrides(callee);
                        for (String impl : overrides) {
                            if (!impl.equals(callee) && acceptByFilter(impl, cfg)) {
                                entry.addCallee(impl, line, endLine, "override");
                            }
                        }
                    }
                }
                return;
            } else {
                // このクラスにはメソッドがないことをキャッシュ
                methodFqnCache.put(methodKey, null);
            }

            // さらに上の親クラスも探索
            List<String> grandParents = chaContext.getCache().getParentClasses(parentFqn);
            queue.addAll(grandParents);
        }

        // 見つからなかった場合もキャッシュ
        parentMethodCache.put(cacheKey, null);
    }

    /**
     * 指定クラスから指定メソッドを探索
     * 
     * @param classFqn クラスFQN
     * @param methodName メソッド名
     * @param argCount 引数の数
     * @return メソッド宣言（見つからない場合はempty）
     */
    private Optional<MethodDeclaration> findMethodInClass(String classFqn, String methodName, int argCount) {
        // SourceLocator経由でソースファイルを取得
        Path sourceFile = locator.resolveClassFile(classFqn);
        if (sourceFile == null) {
            return Optional.empty();
        }
        
        // SourceLocatorのキャッシュを使用（パフォーマンス最適化）
        CompilationUnit cu = locator.getCompilationUnit(sourceFile);
        if (cu == null) {
            debugVerbose("Failed to parse " + sourceFile);
            return Optional.empty();
        }
        
        return cu.findAll(MethodDeclaration.class).stream()
            .filter(md -> md.getNameAsString().equals(methodName))
            .filter(md -> md.getParameters().size() == argCount)
            .findFirst();
    }
    
    private static boolean isCollectableConstantType(String type) {
        return switch (type) {
            case "int", "long", "short", "byte", "double", "float",
                 "boolean", "char", "String", "Integer", "Long",
                 "Boolean", "Double", "Float" -> true;
            default -> false;
        };
    }

    /**
     * 逆参照（callers）を構築
     */
    private void buildCallerReferences(CallIndex index) {
        info("[INFO] Building caller references...");
        
        for (MethodEntry caller : index.methods.values()) {
            for (CallRef calleeRef : caller.callees) {
                MethodEntry callee = index.getMethod(calleeRef.fqn);
                if (callee != null) {
                    callee.addCaller(caller.fqn, calleeRef.line, calleeRef.endLine, calleeRef.type);
                }
            }
        }
    }
    
    /**
     * 既存インデックスを増分更新
     */
    CallIndex updateIndex(CallIndex oldIndex, CallIndexManager manager) throws IOException {
        info("[INFO] Updating call index incrementally...");
        long startTime = System.currentTimeMillis();
        
        // 全Javaファイルを収集
        long scanStart = startTiming("File Scan");
        List<Path> allJavaFiles = new ArrayList<>();
        for (Path srcRoot : cfg.srcRoots) {
            try (var stream = Files.walk(srcRoot)) {
                stream.filter(p -> p.toString().endsWith(".java"))
                      .forEach(allJavaFiles::add);
            }
        }
        endTiming("File Scan", scanStart);
        
        CallIndexManager.FileChanges changes = manager.detectChanges(oldIndex, allJavaFiles);
        
        int totalChanges = changes.added.size() + changes.modified.size() + changes.deleted.size();
        if (totalChanges == 0) {
            info("[INFO] No changes detected. Index is up to date.");
            return oldIndex;
        }
        
        info("[INFO] Changes detected: " +
                         changes.added.size() + " added, " +
                         changes.modified.size() + " modified, " +
                         changes.deleted.size() + " deleted");
        
        // 新しいインデックスを作成（既存をコピー）
        CallIndex newIndex = new CallIndex();
        newIndex.version = oldIndex.version;
        
        // 既存のメソッドをコピー（変更されたファイルのメソッドは除外）
        Set<String> changedFilePaths = new HashSet<>();
        changes.added.forEach(p -> changedFilePaths.add(p.toString()));
        changes.modified.forEach(p -> changedFilePaths.add(p.toString()));
        changes.deleted.forEach(changedFilePaths::add);
        
        for (var entry : oldIndex.methods.entrySet()) {
            if (!changedFilePaths.contains(entry.getValue().file)) {
                newIndex.methods.put(entry.getKey(), entry.getValue());
            }
        }

        // 未変更ファイルの symbolIndex エントリを旧 index からコピー
        // qualifier (クラスFQN) → file の逆引きマップを構築
        Map<String, String> classFqnToFile = new HashMap<>();
        for (var entry : oldIndex.methods.entrySet()) {
            CallIndexModels.MethodEntry me = entry.getValue();
            if (me.classFqn != null && me.file != null) {
                classFqnToFile.putIfAbsent(me.classFqn, me.file);
            }
        }
        for (var entry : oldIndex.symbolIndex.entrySet()) {
            String qualifier = entry.getValue().qualifier;
            String file = classFqnToFile.get(qualifier);
            // ファイルが特定できない場合、または変更されていないファイルのものはコピー
            if (file == null || !changedFilePaths.contains(file)) {
                newIndex.symbolIndex.put(entry.getKey(), entry.getValue());
            }
        }

        long persistHashStart = startTiming("File Hashing (persist index)");
        Map<String, String> newFileHashes = CallIndexManager.calculateFileHashes(allJavaFiles);
        endTiming("File Hashing (persist index)", persistHashStart);
        for (var entry : newFileHashes.entrySet()) {
            newIndex.setFileHash(entry.getKey(), entry.getValue());
        }
        
        // 変更・追加されたファイルを再解析
        List<Path> filesToProcess = new ArrayList<>();
        filesToProcess.addAll(changes.added);
        filesToProcess.addAll(changes.modified);
        
        info("[INFO] Reprocessing " + filesToProcess.size() + " files...");
        long reprocessStart = startTiming("File Reprocessing");
        
        for (Path javaFile : filesToProcess) {
            try {
                CompilationUnit cu = parseCu(javaFile);
                
                cu.findAll(ClassOrInterfaceDeclaration.class).forEach(clazz -> {
                    String currentClassFqn = clazz.getFullyQualifiedName().orElse(null);
                    if (currentClassFqn == null) return;
                    
                    clazz.findAll(MethodDeclaration.class).forEach(md -> {
                        try {
                            String methodFqn = buildMethodFqn(currentClassFqn, md, facade);
                            int lineStart = md.getRange().map(r -> r.begin.line).orElse(-1);
                            int lineEnd = md.getRange().map(r -> r.end.line).orElse(-1);
                            
                            // メタデータ収集
                            String simpleClass = clazz.getNameAsString();
                            String methodName = md.getNameAsString();
                            List<String> paramsFqn = md.getParameters().stream()
                                .map(p -> {
                                    try {
                                        return facade.getType(p).describe();
                                    } catch (Throwable t) {
                                        return p.getType().asString();
                                    }
                                })
                                .toList();
                            String paramsDisplay = paramsFqn.stream()
                                .map(FqnUtils::shortType)
                                .collect(joining(", "));
                            String display = simpleClass + "." + methodName + "(" + paramsDisplay + ") L" + lineStart + "-" + lineEnd;
                            List<String> annotations = md.getAnnotations().stream()
                                .map(a -> "@" + a.getNameAsString())
                                .toList();
                            String stereotype = stereotypeOf(clazz);
                            
                            MethodEntry entry = new MethodEntry(methodFqn, javaFile.toString(), 
                                lineStart, lineEnd, display, currentClassFqn, methodName, 
                                paramsFqn, annotations, stereotype);
                            collectCallsForMethod(md, methodFqn, currentClassFqn, entry, clazz);
                            newIndex.addMethod(entry);
                        } catch (Throwable ex) {
                            debugVerbose("Failed to process method: " + ex.getMessage());
                        }
                    });
                    
                    clazz.findAll(ConstructorDeclaration.class).forEach(cd -> {
                        try {
                            ResolvedConstructorDeclaration resolvedCtor = cd.resolve();
                            String ctorFqn = toCtorFqn(resolvedCtor);
                            int lineStart = cd.getRange().map(r -> r.begin.line).orElse(-1);
                            int lineEnd = cd.getRange().map(r -> r.end.line).orElse(-1);
                            
                            // メタデータ収集
                            String simpleClass = clazz.getNameAsString();
                            String ctorName = cd.getNameAsString();
                            List<String> paramsFqn = cd.getParameters().stream()
                                .map(p -> {
                                    try {
                                        return facade.getType(p).describe();
                                    } catch (Throwable t) {
                                        return p.getType().asString();
                                    }
                                })
                                .toList();
                            String paramsDisplay = paramsFqn.stream()
                                .map(FqnUtils::shortType)
                                .collect(joining(", "));
                            String display = simpleClass + "." + ctorName + "(" + paramsDisplay + ") L" + lineStart + "-" + lineEnd;
                            List<String> annotations = cd.getAnnotations().stream()
                                .map(a -> "@" + a.getNameAsString())
                                .toList();
                            String stereotype = stereotypeOf(clazz);
                            
                            MethodEntry entry = new MethodEntry(ctorFqn, javaFile.toString(), 
                                lineStart, lineEnd, display, currentClassFqn, ctorName, 
                                paramsFqn, annotations, stereotype);
                            collectCallsForConstructor(cd, ctorFqn, currentClassFqn, entry, clazz);
                            newIndex.addMethod(entry);
                        } catch (Throwable ex) {
                            debugVerbose("Failed to process constructor: " + ex.getMessage());
                        }
                    });

                    // static final フィールド（定数）を収集
                    clazz.findAll(FieldDeclaration.class).forEach(fd -> {
                        if (!fd.isStatic() || !fd.isFinal()) return;
                        for (var var : fd.getVariables()) {
                            var.getInitializer().ifPresent(init -> {
                                if (init instanceof LiteralExpr) {
                                    String type = fd.getElementType().asString();
                                    if (isCollectableConstantType(type)) {
                                        newIndex.symbolIndex.put(var.getNameAsString(),
                                            new CallIndexModels.ConstantEntry(init.toString(), currentClassFqn, type));
                                    }
                                }
                            });
                        }
                    });
                });

                // enum 値を収集
                cu.findAll(EnumDeclaration.class).forEach(ed -> {
                    String enumFqn = ed.getFullyQualifiedName().orElse(ed.getNameAsString());
                    int ordinal = 0;
                    for (var ec : ed.getEntries()) {
                        String key = ed.getNameAsString() + "." + ec.getNameAsString();
                        String value = (!ec.getArguments().isEmpty()
                                && ec.getArguments().get(0) instanceof LiteralExpr)
                            ? ec.getArguments().get(0).toString()
                            : String.valueOf(ordinal);
                        newIndex.symbolIndex.put(key,
                            new CallIndexModels.ConstantEntry(value, enumFqn, "enum"));
                        ordinal++;
                    }
                });

            } catch (Throwable ex) {
                debugVerbose("Failed to parse file: " + javaFile + " - " + ex.getMessage());
            }
        }
        endTiming("File Reprocessing", reprocessStart);
        
        // caller参照を再構築（変更されたメソッドの影響を受けるため、全体を再構築）
        info("[INFO] Rebuilding caller references...");
        long callerStart = startTiming("Caller References Rebuild");
        for (MethodEntry method : newIndex.methods.values()) {
            method.callers.clear();
        }
        buildCallerReferences(newIndex);
        endTiming("Caller References Rebuild", callerStart);
        
        long elapsed = System.currentTimeMillis() - startTime;
        info("[INFO] Index updated in " + (elapsed / 1000) + "s: " +
                         newIndex.methods.size() + " methods indexed");
        
        return newIndex;
    }
}
