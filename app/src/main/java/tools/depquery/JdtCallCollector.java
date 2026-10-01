package tools.depquery;

import org.eclipse.jdt.core.JavaCore;
import org.eclipse.jdt.core.dom.*;
import tools.depquery.CallIndexModels.ConstantEntry;
import tools.depquery.CallIndexModels.MethodEntry;
import tools.depquery.CallIndexModels.SymbolEntry;
import tools.depquery.CallIndexModels.SymbolRef;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.*;
import java.util.stream.Stream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

import static java.util.stream.Collectors.joining;
import static tools.depquery.DiagnosticLogger.*;

/**
 * インデックス構築用の解析器（Eclipse JDT core）。
 *
 * <p>ASTParser.createASTs で対象ファイルを一括解析し（resolveBindings）、ファイルごとに
 * 宣言メソッドの {@link MethodEntry} と、各メソッドからの呼び出し（CHA 展開前）を返す。
 * CHA による override 辺の展開と逆引きは呼び出し側（{@link CallIndexBuilder}）が行う。
 *
 * <p>FQN は JavaParser 版と同じ書式に揃える（非インデックス経路や拡張と突き合わせるため）:
 * <ul>
 *   <li>クラス部はネストを '.' で繋いだ正規名（pkg.Outer.Inner）</li>
 *   <li>引数型はジェネリクス込み（{@code java.util.Map<java.lang.String, java.lang.Integer>}、型変数は名前のみ、可変長は []）</li>
 *   <li>コンストラクタ名はトップレベルからのクラス名（{@code pkg.Outer.Inner#Outer.Inner(int)}）</li>
 *   <li>呼び出し先はメソッドの宣言（ジェネリクス置換前）のシグネチャ（{@code java.util.List#add(E)}）</li>
 * </ul>
 *
 * <p>呼び出し元の単位:
 * <ul>
 *   <li>メソッド・コンストラクタ（ラムダ・匿名クラス・ローカルクラスの中の呼び出しは外側のメソッドに含める）</li>
 *   <li>インスタンスのフィールド初期化子・初期化ブロック → そのクラスの各コンストラクタ（this(...) 委譲を除く）。
 *       明示的なコンストラクタが無ければ {@code Class#<init>()} の擬似エントリ</li>
 *   <li>static のフィールド初期化子・static ブロック・enum 定数 → {@code Class#<clinit>()} の擬似エントリ</li>
 * </ul>
 * 擬似エントリは呼び出しがある時だけ作り、行番号を持たない（lineStart/lineEnd = -1。--resolve-from-index で
 * カーソル位置に当たらないように）。クラス単位 Export のルートにも含めない。
 *
 * <p>シンボル参照: 呼び出し元の範囲内（注釈・シグネチャ・本体）で、宣言がプロジェクトのソースにある
 * 型・フィールド（enum 定数・record のコンポーネントを含む）を指す識別子の位置を {@link SymbolRef} として集める
 * （修飾 this. / Foo. / パッケージは含めず識別子部分のみ）。インスタンス初期化子内の参照はコンストラクタには
 * 足さない（コンストラクタのウィンドウの範囲外なので）。併せてファイル内の型・フィールドの宣言
 * （{@link SymbolEntry}）を集める。
 */
final class JdtCallCollector {

    /** 擬似エントリのメソッド名（JVM の命名に合わせる） */
    static final String INSTANCE_INIT = "<init>";
    static final String STATIC_INIT = "<clinit>";

    /** 擬似エントリ（初期化子の呼び出しをまとめたもの。ソース上のメソッドではない）か */
    static boolean isInitializerPseudo(String fqn) {
        return fqn.contains("#" + INSTANCE_INIT + "(") || fqn.contains("#" + STATIC_INIT + "(");
    }

    /** CHA 展開前の呼び出し 1 件。virtual は CHA で override を展開する対象か。 */
    record RawCall(String callee, int line, int endLine, String type, boolean virtual) {}

    /** 呼び出し元 1 件（メソッドエントリ + 収集した呼び出し） */
    static final class Caller {
        final MethodEntry entry;
        final List<RawCall> calls = new ArrayList<>();
        final List<String> refs = new ArrayList<>();
        Caller(MethodEntry entry) { this.entry = entry; }
    }

    /** 1 ファイルの解析結果 */
    record FileResult(Path file, List<Caller> callers, Map<String, ConstantEntry> constants,
                      Map<String, SymbolEntry> symbols) {}

    /** 解析の統計（--timing / --debug 用） */
    static final class Stats {
        int units, compileErrors, calls, unresolvedCalls, recoveredCalls, fieldRefs, typeRefs, symbols;
    }

    private final AnalyzerConfig cfg;
    final Stats stats = new Stats();
    /** Lombok の生成ノードを除外するか（agent が有効な時だけ。{@link #isLombokGenerated}） */
    private final boolean skipLombokGenerated = LombokSupport.agentActive();

    /** JDT のクラスパス（null なら analyze のたびに cfg から作る） */
    private final List<String> classpath;

    JdtCallCollector(AnalyzerConfig cfg) {
        this(cfg, null);
    }

    /**
     * @param classpath {@link #classpathEntries(AnalyzerConfig)} の結果。解析を何度も繰り返す呼び出し元
     *                  （{@link OnDemandIndexer}）が使い回す（--cpdir の走査と fat-jar の展開を 1 回で済ませる）
     */
    JdtCallCollector(AnalyzerConfig cfg, List<String> classpath) {
        this.cfg = cfg;
        this.classpath = classpath;
    }

    /**
     * 指定ファイルを解析する。sourcepath は cfg.srcRoots 全体なので、差分更新で一部のファイルだけ渡しても
     * 他ファイルの型は解決される。
     */
    List<FileResult> analyze(List<Path> files) throws IOException {
        List<FileResult> results = new ArrayList<>();
        if (files.isEmpty()) return results;

        long setupStart = startTiming("JDT Setup");
        ASTParser parser = ASTParser.newParser(AST.getJLSLatest());
        parser.setKind(ASTParser.K_COMPILATION_UNIT);
        parser.setResolveBindings(true);
        parser.setBindingsRecovery(true);
        parser.setStatementsRecovery(true);
        Map<String, String> options = JavaCore.getOptions();
        JavaCore.setComplianceOptions(complianceOf(cfg.languageLevel), options);
        // Javadoc の中身は使わない（解析の手間を省く）
        options.put(JavaCore.COMPILER_DOC_COMMENT_SUPPORT, JavaCore.DISABLED);
        parser.setCompilerOptions(options);

        List<String> sourcepath = new ArrayList<>();
        for (Path src : cfg.srcRoots) {
            Path abs = src.toAbsolutePath().normalize();
            if (Files.isDirectory(abs)) sourcepath.add(abs.toString());
        }
        String[] encodings = new String[sourcepath.size()];
        Arrays.fill(encodings, "UTF-8");
        List<String> classpath = this.classpath != null ? this.classpath : classpathEntries(cfg);
        parser.setEnvironment(classpath.toArray(String[]::new), sourcepath.toArray(String[]::new), encodings, true);
        info("[INFO] JDT environment: " + sourcepath.size() + " source roots, " + classpath.size() + " classpath entries");
        endTiming("JDT Setup", setupStart);

        // JDT には絶対パスを渡し、結果はインデックスに記録する元のパス表記（cfg.srcRoots 起点）に戻す
        Map<String, Path> absToOrig = new HashMap<>();
        for (Path f : files) absToOrig.put(f.toAbsolutePath().normalize().toString(), f);

        long parseStart = startTiming("JDT Parse+Resolve");
        parser.createASTs(absToOrig.keySet().toArray(String[]::new), null, new String[0], new FileASTRequestor() {
            @Override
            public void acceptAST(String sourceFilePath, CompilationUnit cu) {
                Path orig = absToOrig.getOrDefault(sourceFilePath, Path.of(sourceFilePath));
                try {
                    stats.units++;
                    for (var p : cu.getProblems()) {
                        if (p.isError()) {
                            stats.compileErrors++;
                            debugVerbose("JDT problem " + orig + ":" + p.getSourceLineNumber() + " " + p.getMessage());
                        }
                    }
                    Visitor v = new Visitor(cu, orig.toString(), Path.of(sourceFilePath));
                    cu.accept(v);
                    for (Caller c : v.callers) c.entry.refs = c.refs;
                    results.add(new FileResult(orig, v.callers, v.constants, v.symbols));
                } catch (Throwable ex) {
                    debugVerbose("Failed to collect calls in " + orig + ": " + ex);
                }
            }
        }, null);
        endTiming("JDT Parse+Resolve", parseStart);
        timing("SUMMARY jdt=units=" + stats.units + ",compileErrors=" + stats.compileErrors
                + ",calls=" + stats.calls + ",unresolvedCalls=" + stats.unresolvedCalls
                + ",recoveredCalls=" + stats.recoveredCalls
                + ",fieldRefs=" + stats.fieldRefs + ",typeRefs=" + stats.typeRefs + ",symbols=" + stats.symbols);
        debug("JDT: units=" + stats.units + " compileErrors=" + stats.compileErrors + " calls=" + stats.calls
                + " unresolved=" + stats.unresolvedCalls + " recovered=" + stats.recoveredCalls);
        return results;
    }

    /** --classes / --cp / --cpdir（配下の JAR）を JDT のクラスパスにする */
    static List<String> classpathEntries(AnalyzerConfig cfg) {
        LinkedHashSet<String> cp = new LinkedHashSet<>();
        for (Path d : cfg.classDirs) {
            Path abs = d.toAbsolutePath().normalize();
            if (Files.isDirectory(abs)) cp.add(abs.toString());
        }
        for (Path jar : cfg.cpJars) {
            Path abs = jar.toAbsolutePath().normalize();
            if (Files.exists(abs)) {
                cp.add(abs.toString());
                // Spring Boot の fat-jar は依存 JAR を中に持つ（BOOT-INF/lib/*.jar）ので展開して足す
                for (Path nested : expandBootJarLibs(abs)) cp.add(nested.toString());
            }
        }
        for (Path dir : cfg.cpDirs) {
            Path abs = dir.toAbsolutePath().normalize();
            if (Files.isDirectory(abs)) {
                try (Stream<Path> s = Files.walk(abs)) {
                    s.filter(p -> p.toString().endsWith(".jar")).sorted().forEach(p -> cp.add(p.toString()));
                } catch (IOException ex) {
                    debugVerbose("Failed to scan cpdir " + abs + ": " + ex.getMessage());
                }
            } else if (abs.toString().endsWith(".jar") && Files.exists(abs)) {
                cp.add(abs.toString());
            }
        }
        return new ArrayList<>(cp);
    }

    /** Spring Boot fat-jar の BOOT-INF/lib/*.jar を一時ファイルに取り出す（終了時に消す） */
    private static List<Path> expandBootJarLibs(Path bootJar) {
        List<Path> out = new ArrayList<>();
        if (!Files.isRegularFile(bootJar) || !bootJar.toString().endsWith(".jar")) return out;
        try (ZipFile zf = new ZipFile(bootJar.toFile())) {
            Enumeration<? extends ZipEntry> entries = zf.entries();
            while (entries.hasMoreElements()) {
                ZipEntry e = entries.nextElement();
                String name = e.getName();
                if (name.startsWith("BOOT-INF/lib/") && name.endsWith(".jar")) {
                    Path tmp = Files.createTempFile("depq-bootlib-", ".jar");
                    tmp.toFile().deleteOnExit();
                    try (var in = zf.getInputStream(e)) {
                        Files.copy(in, tmp, StandardCopyOption.REPLACE_EXISTING);
                    }
                    out.add(tmp);
                }
            }
        } catch (Throwable ex) {
            debugVerbose("Failed to expand boot jar " + bootJar + ": " + ex.getMessage());
        }
        return out;
    }

    /** 言語レベル名（JAVA_8 .. JAVA_25）→ JDT の compliance 文字列 */
    static String complianceOf(String languageLevel) {
        String name = String.valueOf(languageLevel);
        String digits = name.replaceAll("[^0-9_]", "").replaceAll("^_+", "");
        int dash = digits.indexOf('_');
        if (dash >= 0) digits = digits.substring(0, dash);
        if (digits.isEmpty()) return JavaCore.latestSupportedJavaVersion();
        int v = Integer.parseInt(digits);
        if (v <= 8) return "1." + Math.max(v, 1);
        String s = String.valueOf(v);
        return JavaCore.isSupportedJavaVersion(s) ? s : JavaCore.latestSupportedJavaVersion();
    }

    // ===== FQN 整形（JavaParser の describe() と同じ書式） =====

    /** 型の表記: ジェネリクス込み、型変数は名前、ワイルドカードは ? / ? extends X / ? super X */
    static String describe(ITypeBinding t) {
        if (t == null) return "?";
        if (t.isPrimitive()) return t.getName();
        if (t.isArray()) return describe(t.getComponentType()) + "[]";
        if (t.isCapture()) return describe(t.getWildcard());
        if (t.isWildcardType()) {
            ITypeBinding bound = t.getBound();
            if (bound == null) return "?";
            return (t.isUpperbound() ? "? extends " : "? super ") + describe(bound);
        }
        if (t.isTypeVariable()) return t.getName();
        // 解決できなかった型は書かれた名前（JavaParser 版のフォールバックと同じ。宣言側と呼び出し側で揃う）
        if (t.isRecovered()) return t.getErasure().getName();
        if (t.isParameterizedType()) {
            StringBuilder sb = new StringBuilder(className(t));
            sb.append('<');
            ITypeBinding[] args = t.getTypeArguments();
            for (int i = 0; i < args.length; i++) {
                if (i > 0) sb.append(", ");
                sb.append(describe(args[i]));
            }
            return sb.append('>').toString();
        }
        return className(t);
    }

    /** クラス部の表記（ネストは '.' 区切り、ジェネリクスなし）。ローカル・匿名クラスはバイナリ名 */
    static String className(ITypeBinding t) {
        ITypeBinding e = t.getErasure();
        if (e.isTypeVariable()) return e.getName();
        String q = e.getQualifiedName();
        if (q == null || q.isEmpty()) {
            q = e.getBinaryName();
            if (q == null || q.isEmpty()) q = e.getName();
        }
        int lt = q.indexOf('<');
        return lt >= 0 ? q.substring(0, lt) : q;
    }

    /** コンストラクタ名: トップレベルからのクラス名を '.' で繋いだもの（JavaParser の getClassName() 相当） */
    static String ctorName(ITypeBinding cls) {
        ITypeBinding e = cls.getErasure();
        String pkg = e.getPackage() != null ? e.getPackage().getName() : "";
        String q = className(e);
        if (!pkg.isEmpty() && q.startsWith(pkg + ".")) return q.substring(pkg.length() + 1);
        return e.getName();
    }

    /** 呼び出し先のメソッド FQN（宣言側のシグネチャ） */
    static String calleeFqn(IMethodBinding b) {
        IMethodBinding d = b.getMethodDeclaration();
        ITypeBinding cls = d.getDeclaringClass();
        StringBuilder sb = new StringBuilder(className(cls)).append('#');
        sb.append(d.isConstructor() ? ctorName(cls) : d.getName()).append('(');
        ITypeBinding[] ps = d.getParameterTypes();
        for (int i = 0; i < ps.length; i++) {
            if (i > 0) sb.append(',');
            sb.append(describe(ps[i]));
        }
        return sb.append(')').toString();
    }

    // ===== AST 走査 =====

    /** メンバー型（トップレベル・ネスト）1 つ分の文脈 */
    private static final class TypeCtx {
        final String fqn;
        final String simpleName;
        final String ctorName;
        final String stereotype;
        final boolean isClass;
        final List<Caller> ctors = new ArrayList<>();
        final Set<Caller> delegatingCtors = new HashSet<>();
        Caller clinit;          // static 初期化の擬似エントリ（遅延生成）
        Caller instanceInit;    // インスタンス初期化の呼び出しを一時的に貯める（entry は null）

        TypeCtx(String fqn, String simpleName, String ctorName, String stereotype, boolean isClass) {
            this.fqn = fqn;
            this.simpleName = simpleName;
            this.ctorName = ctorName;
            this.stereotype = stereotype;
            this.isClass = isClass;
        }
    }

    /**
     * Lombok（{@link LombokSupport} の agent）が生成したノードか。ソースに実在しないので、宣言にも辺にもしない。
     *
     * <p>ECJ モードの agent は生成ノードに印を付けない（Eclipse IDE 用の {@code $isGenerated} は無い）が、
     * 位置を元の注釈（@Data 等）の範囲に潰すので、実在のコードではあり得ない範囲で判定する:
     * <ul>
     *   <li>メソッド・型: 宣言全体の範囲が名前の範囲と一致（getter/setter・コンストラクタ・Builder 型など）</li>
     *   <li>フィールド: 宣言全体の範囲が型の範囲と一致（@Slf4j の log など）</li>
     *   <li>それ以外: 親の範囲からはみ出す（@NonNull の null チェック・@SneakyThrows の sneakyThrow など、
     *       実在のメソッドに挿入された文）</li>
     * </ul>
     * 生成メソッドの本体は DOM に変換されない（空の Block）ので、生成メソッド「からの」辺は元々無い。
     */
    static boolean isLombokGenerated(ASTNode n) {
        if (n instanceof MethodDeclaration md) return sameRange(md, md.getName());
        if (n instanceof AbstractTypeDeclaration td) return sameRange(td, td.getName());
        if (n instanceof FieldDeclaration fd) return sameRange(fd, fd.getType());
        ASTNode parent = n.getParent();
        if (parent == null || n.getStartPosition() < 0 || parent.getStartPosition() < 0) return false;
        return n.getStartPosition() < parent.getStartPosition()
                || n.getStartPosition() + n.getLength() > parent.getStartPosition() + parent.getLength();
    }

    private static boolean sameRange(ASTNode a, ASTNode b) {
        return b != null && a.getStartPosition() == b.getStartPosition() && a.getLength() == b.getLength();
    }

    private final class Visitor extends ASTVisitor {
        final CompilationUnit cu;
        final String file;
        final String pkg;
        final List<Caller> callers = new ArrayList<>();
        final Map<String, ConstantEntry> constants = new LinkedHashMap<>();
        final Map<String, SymbolEntry> symbols = new LinkedHashMap<>();
        /** 元のソース（フィールドの型・定数値の表記に使う。CompilationUnit は元の文字列を持たないので読む） */
        final Path absFile;
        String source;
        final Deque<TypeCtx> types = new ArrayDeque<>();
        final Deque<ASTNode> typeNodes = new ArrayDeque<>();
        /** 現在の呼び出し元。body の外（型の宣言部）では空 */
        final Deque<Caller> owners = new ArrayDeque<>();
        final Deque<ASTNode> ownerNodes = new ArrayDeque<>();

        Visitor(CompilationUnit cu, String file, Path absFile) {
            this.cu = cu;
            this.file = file;
            this.absFile = absFile;
            this.pkg = cu.getPackage() != null ? cu.getPackage().getName().getFullyQualifiedName() : "";
        }

        int line(int pos) { return cu.getLineNumber(pos); }
        int startLine(ASTNode n) { return line(n.getStartPosition()); }
        int endLine(ASTNode n) { return line(n.getStartPosition() + Math.max(n.getLength() - 1, 0)); }

        boolean inBody() { return !owners.isEmpty(); }

        /**
         * Lombok の生成ノードは子ごと飛ばす（visit/endVisit とも呼ばれない）。生成メソッドは @Data 等の注釈の
         * 位置を持つため、登録するとその行で --resolve-from-index やクラス単位 Export に混ざる。
         * 生成メソッドへの呼び出し（ユーザーコード側）はそのまま解決・記録する。
         * agent が無い解析では判定しない（構文エラーの回復で範囲が崩れた実在のノードを落とさないため）。
         */
        @Override public boolean preVisit2(ASTNode n) { return !(skipLombokGenerated && isLombokGenerated(n)); }

        // --- 型宣言 ---

        boolean enterType(AbstractTypeDeclaration td, boolean isClass) {
            if (inBody()) return true; // ローカル型: 中身は外側の呼び出し元に含める
            ITypeBinding b = td.resolveBinding();
            String simple = td.getName().getIdentifier();
            String fqn;
            String ctor;
            if (b != null) {
                fqn = className(b);
                ctor = ctorName(b);
            } else {
                String outer = types.isEmpty() ? (pkg.isEmpty() ? "" : pkg + ".") : types.peek().fqn + ".";
                fqn = outer + simple;
                ctor = types.isEmpty() ? simple : types.peek().ctorName + "." + simple;
            }
            putSymbol(fqn, SymbolEntry.type(file, line(td.getName().getStartPosition()), ctor, typeKindOf(td)));
            types.push(new TypeCtx(fqn, simple, ctor, stereotypeOf(td.modifiers()), isClass));
            typeNodes.push(td);
            return true;
        }

        void exitType(AbstractTypeDeclaration td) {
            if (typeNodes.isEmpty() || typeNodes.peek() != td) return;
            typeNodes.pop();
            TypeCtx ctx = types.pop();
            if (ctx.instanceInit != null && !ctx.instanceInit.calls.isEmpty()) {
                List<Caller> targets = new ArrayList<>();
                for (Caller c : ctx.ctors) if (!ctx.delegatingCtors.contains(c)) targets.add(c);
                if (ctx.ctors.isEmpty()) {
                    // 明示的なコンストラクタが無い → インスタンス初期化の擬似エントリ
                    Caller init = pseudo(ctx, ctx.fqn + "#" + INSTANCE_INIT + "()", INSTANCE_INIT, ctx.simpleName + "." + INSTANCE_INIT + "()");
                    init.refs.addAll(ctx.instanceInit.refs);
                    callers.add(init);
                    targets.add(init);
                }
                for (Caller t : targets) t.calls.addAll(ctx.instanceInit.calls);
            }
            if (ctx.clinit != null && !ctx.clinit.calls.isEmpty()) callers.add(ctx.clinit);
        }

        @Override public boolean visit(TypeDeclaration n) { return enterType(n, !n.isInterface()); }
        @Override public void endVisit(TypeDeclaration n) { exitType(n); }
        @Override public boolean visit(EnumDeclaration n) {
            collectEnumConstants(n);
            return enterType(n, true);
        }
        @Override public void endVisit(EnumDeclaration n) { exitType(n); }
        @Override public void endVisit(RecordDeclaration n) { exitType(n); }
        @Override public boolean visit(AnnotationTypeDeclaration n) { return enterType(n, false); }
        @Override public void endVisit(AnnotationTypeDeclaration n) { exitType(n); }

        Caller pseudo(TypeCtx ctx, String fqn, String methodName, String display) {
            return new Caller(new MethodEntry(fqn, file, -1, -1, display, ctx.fqn, methodName,
                    List.of(), List.of(), ctx.stereotype));
        }

        Caller clinitOf(TypeCtx ctx) {
            if (ctx.clinit == null) {
                ctx.clinit = pseudo(ctx, ctx.fqn + "#" + STATIC_INIT + "()", STATIC_INIT, ctx.simpleName + "." + STATIC_INIT + "()");
            }
            return ctx.clinit;
        }

        Caller instanceInitOf(TypeCtx ctx) {
            if (ctx.instanceInit == null) ctx.instanceInit = new Caller(null);
            return ctx.instanceInit;
        }

        void pushOwner(Caller c, ASTNode n) {
            owners.push(c);
            ownerNodes.push(n);
        }

        void popOwner(ASTNode n) {
            if (!ownerNodes.isEmpty() && ownerNodes.peek() == n) {
                ownerNodes.pop();
                owners.pop();
            }
        }

        // --- 呼び出し元 ---

        @Override public boolean visit(MethodDeclaration md) {
            if (inBody() || types.isEmpty()) return true; // ローカル・匿名クラスのメソッドは外側に含める
            TypeCtx ctx = types.peek();
            IMethodBinding b = md.resolveBinding();
            List<String> params = new ArrayList<>();
            if (b != null && (md.isCompactConstructor() || b.getParameterTypes().length == md.parameters().size())) {
                ITypeBinding[] ps = b.getParameterTypes();
                for (int i = 0; i < ps.length; i++) {
                    params.add(ps[i].isRecovered() && i < md.parameters().size()
                            ? writtenType((SingleVariableDeclaration) md.parameters().get(i))
                            : describe(ps[i]));
                }
            } else {
                for (Object o : md.parameters()) params.add(writtenType((SingleVariableDeclaration) o));
            }
            boolean ctor = md.isConstructor();
            String name = ctor ? ctx.ctorName : md.getName().getIdentifier();
            String methodName = md.getName().getIdentifier();
            String fqn = ctx.fqn + "#" + name + "(" + String.join(",", params) + ")";
            int lineStart = line(declStart(md));
            int lineEnd = endLine(md);
            String display = ctx.simpleName + "." + methodName + "("
                    + params.stream().map(FqnUtils::shortType).collect(joining(", ")) + ") L" + lineStart + "-" + lineEnd;
            List<String> annotations = new ArrayList<>();
            for (Object m : md.modifiers()) {
                if (m instanceof Annotation a) annotations.add("@" + a.getTypeName().getFullyQualifiedName());
            }
            MethodEntry entry = new MethodEntry(fqn, file, lineStart, lineEnd, display, ctx.fqn, methodName,
                    params, annotations, ctx.stereotype);
            Caller c = new Caller(entry);
            callers.add(c);
            if (ctor) {
                ctx.ctors.add(c);
                if (md.getBody() != null && !md.getBody().statements().isEmpty()
                        && md.getBody().statements().get(0) instanceof ConstructorInvocation) {
                    ctx.delegatingCtors.add(c);
                }
            }
            pushOwner(c, md);
            return true;
        }
        @Override public void endVisit(MethodDeclaration md) { popOwner(md); }

        /**
         * JavaParser の範囲と同じく、Javadoc を除いた宣言の開始位置（先頭の注釈・修飾子から）。
         * JDT の BodyDeclaration の範囲は Javadoc を含むので、子ノードの最小位置を使う。
         */
        int declStart(MethodDeclaration md) {
            int min = Integer.MAX_VALUE;
            for (Object o : md.modifiers()) min = Math.min(min, ((ASTNode) o).getStartPosition());
            for (Object o : md.typeParameters()) min = Math.min(min, ((ASTNode) o).getStartPosition());
            if (md.getReturnType2() != null) min = Math.min(min, md.getReturnType2().getStartPosition());
            min = Math.min(min, md.getName().getStartPosition());
            return min;
        }

        /** 型が解決できない引数は書かれたとおりの表記（JavaParser 版のフォールバックと同じ） */
        String writtenType(SingleVariableDeclaration p) {
            String t = p.getType().toString();
            t += "[]".repeat(p.extraDimensions().size());
            if (p.isVarargs()) t += "[]";
            return t;
        }

        @Override public boolean visit(Initializer n) {
            if (inBody() || types.isEmpty()) return true;
            TypeCtx ctx = types.peek();
            pushOwner(Modifier.isStatic(n.getModifiers()) ? clinitOf(ctx) : instanceInitOf(ctx), n);
            return true;
        }
        @Override public void endVisit(Initializer n) { popOwner(n); }

        @Override public boolean visit(FieldDeclaration n) {
            collectFieldDecls(n);
            if (inBody() || types.isEmpty()) return true;
            TypeCtx ctx = types.peek();
            boolean isStatic = Modifier.isStatic(n.getModifiers()) || !ctx.isClass;
            collectConstants(n, ctx);
            pushOwner(isStatic ? clinitOf(ctx) : instanceInitOf(ctx), n);
            return true;
        }
        @Override public void endVisit(FieldDeclaration n) { popOwner(n); }

        @Override public boolean visit(EnumConstantDeclaration n) {
            collectEnumConstantDecl(n);
            if (inBody() || types.isEmpty()) return true;
            Caller clinit = clinitOf(types.peek());
            pushOwner(clinit, n);
            IMethodBinding b = n.resolveConstructorBinding();
            // 暗黙の既定コンストラクタは辺にしない（宣言が無く、どの定数からも同じ辺になるだけ）
            if (b != null && !b.isDefaultConstructor()) addCall(b, n, "ctor", false);
            return true;
        }
        @Override public void endVisit(EnumConstantDeclaration n) { popOwner(n); }

        @Override public boolean visit(RecordDeclaration n) {
            for (Object o : n.recordComponents()) collectRecordComponentDecl((SingleVariableDeclaration) o);
            return enterType(n, true);
        }

        // --- 型・フィールドの宣言（symbols） ---

        String source() {
            if (source == null) {
                try {
                    source = Files.readString(absFile);
                } catch (IOException | RuntimeException ex) {
                    source = "";
                }
            }
            return source;
        }

        /** ノードの元のソース表記（読めなければ AST の文字列化） */
        String text(ASTNode n) {
            String src = source();
            int s = n.getStartPosition(), e = s + n.getLength();
            if (s >= 0 && e <= src.length()) return src.substring(s, e);
            return n.toString();
        }

        String declaringClassOf(IVariableBinding vb, String fallback) {
            ITypeBinding d = vb != null ? vb.getDeclaringClass() : null;
            return d != null ? className(d) : fallback;
        }

        String currentTypeFqn() {
            return types.isEmpty() ? (pkg.isEmpty() ? "" : pkg + ".") + "?" : types.peek().fqn;
        }

        void putSymbol(String key, SymbolEntry e) {
            symbols.put(key, e);
            stats.symbols++;
        }

        void putField(String cls, String name, SymbolEntry e) {
            putSymbol(cls + "#" + name, e);
        }

        void collectFieldDecls(FieldDeclaration fd) {
            String type = text(fd.getType());
            boolean inInterface = fd.getParent() instanceof TypeDeclaration td && td.isInterface();
            for (Object o : fd.fragments()) {
                VariableDeclarationFragment f = (VariableDeclarationFragment) o;
                IVariableBinding vb = f.resolveBinding();
                int mod = vb != null ? vb.getModifiers() : fd.getModifiers();
                boolean isStatic = Modifier.isStatic(mod) || inInterface;
                boolean isFinal = Modifier.isFinal(mod) || inInterface;
                String value = null;
                if (vb != null && vb.getConstantValue() != null && f.getInitializer() != null) {
                    value = text(f.getInitializer());
                }
                String cls = declaringClassOf(vb, currentTypeFqn());
                putField(cls, f.getName().getIdentifier(), SymbolEntry.field(file, startLine(f.getName()),
                        type + "[]".repeat(f.extraDimensions().size()), cls, isStatic, isFinal, false, value));
            }
        }

        void collectEnumConstantDecl(EnumConstantDeclaration ec) {
            IVariableBinding vb = ec.resolveVariable();
            String enumName = ec.getParent() instanceof EnumDeclaration ed ? ed.getName().getIdentifier() : "enum";
            String cls = declaringClassOf(vb, currentTypeFqn());
            putField(cls, ec.getName().getIdentifier(), SymbolEntry.field(file, startLine(ec.getName()),
                    enumName, cls, true, true, true, null));
        }

        /** record のコンポーネント（本体からは private final フィールドとして参照される） */
        void collectRecordComponentDecl(SingleVariableDeclaration p) {
            IVariableBinding vb = p.resolveBinding();
            String cls = vb != null && vb.getDeclaringClass() != null ? className(vb.getDeclaringClass())
                    : (types.isEmpty() ? (pkg.isEmpty() ? "" : pkg + ".") : types.peek().fqn + ".")
                        + ((RecordDeclaration) p.getParent()).getName().getIdentifier();
            putField(cls, p.getName().getIdentifier(), SymbolEntry.field(file, startLine(p.getName()),
                    text(p.getType()) + (p.isVarargs() ? "[]" : ""), cls, false, true, false, null));
        }

        // --- シンボル参照（refs） ---

        /**
         * 型名・フィールド名の出現。型は SimpleType / QualifiedType / 修飾名（a.b.Foo・Foo.CONST・Foo::bar）/
         * 注釈名のどれでも、その単純名の SimpleName が型のバインディングを持つので、ここで一括して拾える
         * （パッケージ部分は IPackageBinding なので入らない）。
         */
        @Override public boolean visit(SimpleName n) {
            if (owners.isEmpty() || n.isDeclaration()) return false;
            IBinding b = n.resolveBinding();
            String key;
            if (b instanceof IVariableBinding vb) {
                if (!vb.isField()) return false;
                IVariableBinding decl = vb.getVariableDeclaration();
                ITypeBinding cls = decl.getDeclaringClass();
                // 配列の length（宣言クラス無し）とライブラリのフィールドは対象外
                if (cls == null || !cls.getErasure().isFromSource()) return false;
                key = className(cls) + "#" + decl.getName();
                stats.fieldRefs++;
            } else if (b instanceof ITypeBinding tb) {
                // var は推論した型を指すが、型名が書かれているわけではない
                if (n.getParent() instanceof SimpleType st && st.isVar()) return false;
                key = sourceTypeKey(tb);
                if (key == null) return false;
                stats.typeRefs++;
            } else {
                return false;
            }
            int pos = n.getStartPosition();
            int line = line(pos);
            int col = cu.getColumnNumber(pos);
            if (line < 1 || col < 0) return false;
            owners.peek().refs.add(new SymbolRef(line, col, n.getLength(), key).encode());
            return false;
        }

        /**
         * 宣言がプロジェクトのソースにあるメンバー型（トップレベル・ネスト）のキー（FQN）。
         * ライブラリ・型変数・解決できない型・ローカル / 匿名クラス（とその中の型）は null
         */
        String sourceTypeKey(ITypeBinding tb) {
            while (tb.isArray()) tb = tb.getElementType();
            ITypeBinding t = tb.getTypeDeclaration();
            if (t == null || t.isTypeVariable() || t.isRecovered() || t.isPrimitive() || !t.isFromSource()) return null;
            String q = t.getQualifiedName();
            if (q == null || q.isEmpty()) return null;
            return className(t);
        }

        // --- 定数（symbolIndex） ---

        void collectConstants(FieldDeclaration fd, TypeCtx ctx) {
            // JavaParser 版と同じく、クラス・インターフェースの static final かつリテラル初期化子のみ
            if (!(fd.getParent() instanceof TypeDeclaration)) return;
            int mod = fd.getModifiers();
            if (!Modifier.isStatic(mod) || !Modifier.isFinal(mod)) return;
            String type = fd.getType().toString();
            if (!isCollectableConstantType(type)) return;
            for (Object o : fd.fragments()) {
                VariableDeclarationFragment f = (VariableDeclarationFragment) o;
                if (!f.extraDimensions().isEmpty()) continue;
                String lit = literalText(f.getInitializer());
                if (lit != null) constants.put(f.getName().getIdentifier(), new ConstantEntry(lit, ctx.fqn, type));
            }
        }

        void collectEnumConstants(EnumDeclaration ed) {
            ITypeBinding b = ed.resolveBinding();
            String enumFqn = b != null ? className(b) : ed.getName().getIdentifier();
            int ordinal = 0;
            for (Object o : ed.enumConstants()) {
                EnumConstantDeclaration ec = (EnumConstantDeclaration) o;
                String key = ed.getName().getIdentifier() + "." + ec.getName().getIdentifier();
                String lit = ec.arguments().isEmpty() ? null : literalText((Expression) ec.arguments().get(0));
                constants.put(key, new ConstantEntry(lit != null ? lit : String.valueOf(ordinal), enumFqn, "enum"));
                ordinal++;
            }
        }

        String literalText(Expression e) {
            if (e instanceof StringLiteral || e instanceof NumberLiteral || e instanceof CharacterLiteral
                    || e instanceof BooleanLiteral || e instanceof NullLiteral || e instanceof TextBlock) {
                return source(e);
            }
            return null;
        }

        String source(ASTNode n) {
            // CompilationUnit は元のソースを持たないので toString（リテラルはトークンをそのまま保持している）
            if (n instanceof StringLiteral s) return s.getEscapedValue();
            if (n instanceof NumberLiteral s) return s.getToken();
            if (n instanceof CharacterLiteral s) return s.getEscapedValue();
            if (n instanceof TextBlock s) return s.getEscapedValue();
            return n.toString();
        }

        // --- 呼び出し ---

        void addCall(IMethodBinding b, ASTNode n, String type, boolean dispatchable) {
            addCall(b, n, type, dispatchable, List.of());
        }

        /**
         * @param args 実引数（型が解決できない引数があるとき、JDT は最も近いオーバーロードを返すので確かめる）
         */
        void addCall(IMethodBinding b, ASTNode n, String type, boolean dispatchable, List<?> args) {
            if (owners.isEmpty()) return;
            if (b == null) {
                stats.unresolvedCalls++;
                debugVerbose("JDT unresolved " + type + " at " + file + ":" + startLine(n) + " " + abbreviate(n));
                return;
            }
            ITypeBinding cls = b.getDeclaringClass();
            if (cls == null || cls.isArray()) return;
            if (b.isRecovered()) stats.recoveredCalls++;
            String callee;
            boolean uncertain = false;
            if (b.isConstructor() && cls.isAnonymous()) {
                // 匿名クラスの生成は親クラスのコンストラクタへの呼び出しとして記録（インターフェースは辺にしない）
                ITypeBinding sup = cls.getSuperclass();
                if (sup == null || cls.getInterfaces().length > 0) return;
                IMethodBinding superCtor = findCtor(sup, b.getParameterTypes().length, b);
                if (superCtor == null) return;
                callee = calleeFqn(superCtor);
            } else if ("<factory>".equals(b.getName())) {
                // ダイヤモンド（new X<>(...)）の推論に失敗したときの合成メソッド → X のコンストラクタ
                IMethodBinding ctor = findCtor(cls, b.getParameterTypes().length, b);
                if (ctor == null) return;
                callee = calleeFqn(ctor);
            } else {
                IMethodBinding target = b;
                if (hasUnresolvedArgument(args) && overloadCount(cls, b) > 1) {
                    // 型が分かっている引数で候補を絞る（1 つに決まればそれ。JDT は最も近い候補を返すだけなので確かめる）
                    List<IMethodBinding> compatible = compatibleOverloads(cls, b, args);
                    if (compatible.size() == 1) target = compatible.get(0);
                    else uncertain = true;
                }
                // 引数の型が分からず候補を絞れない呼び出しは、JavaParser 版と同じく推測形式（引数型なし）で残す
                callee = uncertain ? className(cls) + "#" + b.getName() + "(...)" : calleeFqn(target);
            }
            int mod = b.getModifiers();
            boolean virtual = dispatchable && !uncertain && !b.isConstructor()
                    && !Modifier.isStatic(mod) && !Modifier.isPrivate(mod);
            stats.calls++;
            owners.peek().calls.add(new RawCall(callee, startLine(n), endLine(n), type, virtual));
        }

        boolean hasUnresolvedArgument(List<?> args) {
            for (Object o : args) {
                ITypeBinding t = ((Expression) o).resolveTypeBinding();
                if (t == null || t.isRecovered()) return true;
            }
            return false;
        }

        /** 宣言クラスとその上位にある同名・同引数個数のメソッド数 */
        int overloadCount(ITypeBinding cls, IMethodBinding b) {
            int arity = b.getParameterTypes().length;
            String name = b.getName();
            Set<String> seen = new HashSet<>();
            Deque<ITypeBinding> q = new ArrayDeque<>();
            q.add(cls.getErasure());
            int count = 0;
            while (!q.isEmpty()) {
                ITypeBinding t = q.poll();
                if (!seen.add(t.getKey())) continue;
                for (IMethodBinding m : t.getDeclaredMethods()) {
                    if (m.getName().equals(name) && (m.getParameterTypes().length == arity || m.isVarargs())) count++;
                }
                if (t.getSuperclass() != null) q.add(t.getSuperclass().getErasure());
                for (ITypeBinding i : t.getInterfaces()) q.add(i.getErasure());
            }
            return count;
        }

        /**
         * 宣言クラスとその上位にある同名・同引数個数（可変長を除く）のメソッドのうち、型が分かっている実引数を
         * すべて受け取れるもの（型が分からない実引数はどの型でも可とする）
         */
        List<IMethodBinding> compatibleOverloads(ITypeBinding cls, IMethodBinding b, List<?> args) {
            List<IMethodBinding> result = new ArrayList<>();
            Set<String> seenMethods = new HashSet<>();
            Set<String> seen = new HashSet<>();
            Deque<ITypeBinding> q = new ArrayDeque<>();
            q.add(cls.getErasure());
            while (!q.isEmpty()) {
                ITypeBinding t = q.poll();
                if (!seen.add(t.getKey())) continue;
                for (IMethodBinding m : t.getDeclaredMethods()) {
                    if (!m.getName().equals(b.getName()) || m.isVarargs()
                            || m.getParameterTypes().length != args.size()) continue;
                    if (!acceptsKnownArguments(m, args)) continue;
                    // override 関係の同じシグネチャは 1 つに数える（下位クラスのものを先に見る）
                    if (seenMethods.add(erasedSignature(m))) result.add(m);
                }
                if (t.getSuperclass() != null) q.add(t.getSuperclass().getErasure());
                for (ITypeBinding i : t.getInterfaces()) q.add(i.getErasure());
            }
            return result;
        }

        boolean acceptsKnownArguments(IMethodBinding m, List<?> args) {
            ITypeBinding[] ps = m.getParameterTypes();
            for (int i = 0; i < ps.length; i++) {
                ITypeBinding a = ((Expression) args.get(i)).resolveTypeBinding();
                if (a == null || a.isRecovered()) continue;
                ITypeBinding p = ps[i].getErasure();
                if (p.isTypeVariable()) continue;
                if (!a.getErasure().isAssignmentCompatible(p)) return false;
            }
            return true;
        }

        String erasedSignature(IMethodBinding m) {
            StringBuilder sb = new StringBuilder(m.getName()).append('(');
            for (ITypeBinding p : m.getParameterTypes()) sb.append(p.getErasure().getQualifiedName()).append(',');
            return sb.append(')').toString();
        }

        IMethodBinding findCtor(ITypeBinding sup, int argc, IMethodBinding anonCtor) {
            IMethodBinding first = null;
            ITypeBinding[] want = anonCtor.getParameterTypes();
            for (IMethodBinding m : sup.getErasure().getDeclaredMethods()) {
                if (!m.isConstructor() || m.getParameterTypes().length != argc) continue;
                if (first == null) first = m;
                boolean same = true;
                ITypeBinding[] ps = m.getParameterTypes();
                for (int i = 0; i < argc; i++) {
                    if (!ps[i].getErasure().isEqualTo(want[i].getErasure())) { same = false; break; }
                }
                if (same) return m;
            }
            return first;
        }

        String abbreviate(ASTNode n) {
            String s = n.toString().replaceAll("\\s+", " ");
            return s.length() > 120 ? s.substring(0, 120) + "..." : s;
        }

        @Override public boolean visit(MethodInvocation n) {
            IMethodBinding b = n.resolveMethodBinding();
            if (b == null) addGuessedCall(n);
            else addCall(b, n, "call", true, n.arguments());
            return true;
        }

        /**
         * 解決できなかった呼び出しの扱いは JavaParser 版に合わせる:
         * レシーバの型が分かれば {@code Type#name(...)} の推測形式、レシーバが無ければ
         * 自クラス（と上位）の同名・同引数個数のメソッドすべて。
         */
        void addGuessedCall(MethodInvocation n) {
            if (owners.isEmpty()) return;
            stats.unresolvedCalls++;
            String name = n.getName().getIdentifier();
            int line = startLine(n), end = endLine(n);
            if (n.getExpression() != null) {
                ITypeBinding t = n.getExpression().resolveTypeBinding();
                if (t == null || t.isRecovered() || t.isArray() || t.isPrimitive()) return;
                owners.peek().calls.add(new RawCall(className(t) + "#" + name + "(...)", line, end, "call", false));
                return;
            }
            ITypeBinding self = enclosingType(n);
            if (self == null) return;
            int arity = n.arguments().size();
            Set<String> seen = new HashSet<>();
            Deque<ITypeBinding> q = new ArrayDeque<>();
            q.add(self);
            while (!q.isEmpty()) {
                ITypeBinding t = q.poll().getErasure();
                if (!seen.add(t.getKey())) continue;
                boolean found = false;
                for (IMethodBinding m : t.getDeclaredMethods()) {
                    if (m.getName().equals(name) && m.getParameterTypes().length == arity) {
                        int mod = m.getModifiers();
                        owners.peek().calls.add(new RawCall(calleeFqn(m), line, end, "call",
                                !Modifier.isStatic(mod) && !Modifier.isPrivate(mod)));
                        found = true;
                    }
                }
                if (found) return;
                if (t.getSuperclass() != null) q.add(t.getSuperclass());
                for (ITypeBinding i : t.getInterfaces()) q.add(i);
                if (t.getDeclaringClass() != null) q.add(t.getDeclaringClass());
            }
        }

        ITypeBinding enclosingType(ASTNode n) {
            for (ASTNode p = n.getParent(); p != null; p = p.getParent()) {
                if (p instanceof AbstractTypeDeclaration td) return td.resolveBinding();
                if (p instanceof AnonymousClassDeclaration ac) return ac.resolveBinding();
            }
            return null;
        }
        @Override public boolean visit(SuperMethodInvocation n) { addCall(n.resolveMethodBinding(), n, "call", false, n.arguments()); return true; }
        @Override public boolean visit(ClassInstanceCreation n) {
            ITypeBinding t = n.getType().resolveBinding();
            // 生成する型自体が解決できない場合、JDT は Object() 等を返すことがあるので辺にしない
            if (t == null || t.isRecovered()) {
                stats.unresolvedCalls++;
                return true;
            }
            addCall(n.resolveConstructorBinding(), n, "ctor", false, n.arguments());
            return true;
        }
        @Override public boolean visit(ConstructorInvocation n) { addCall(n.resolveConstructorBinding(), n, "ctor", false, n.arguments()); return true; }
        @Override public boolean visit(SuperConstructorInvocation n) { addCall(n.resolveConstructorBinding(), n, "ctor", false, n.arguments()); return true; }
        @Override public boolean visit(ExpressionMethodReference n) { addCall(n.resolveMethodBinding(), n, "method-ref", true); return true; }
        @Override public boolean visit(TypeMethodReference n) { addCall(n.resolveMethodBinding(), n, "method-ref", true); return true; }
        @Override public boolean visit(SuperMethodReference n) { addCall(n.resolveMethodBinding(), n, "method-ref", false); return true; }
        @Override public boolean visit(CreationReference n) {
            IMethodBinding b = n.resolveMethodBinding();
            // String[]::new などの配列生成はメソッドではない
            if (b != null || !n.getType().isArrayType()) addCall(b, n, "method-ref", false);
            return true;
        }
    }

    // ===== 補助 =====

    /** symbols の typeKind */
    static String typeKindOf(AbstractTypeDeclaration td) {
        if (td instanceof TypeDeclaration t) return t.isInterface() ? "interface" : "class";
        if (td instanceof EnumDeclaration) return "enum";
        if (td instanceof RecordDeclaration) return "record";
        if (td instanceof AnnotationTypeDeclaration) return "annotation";
        return "class";
    }

    /** JavaParser 版の stereotypeOf と同じ判定（注釈は書かれたとおりの名前で照合） */
    static String stereotypeOf(List<?> modifiers) {
        Set<String> names = new HashSet<>();
        for (Object m : modifiers) {
            if (m instanceof Annotation a) names.add(a.getTypeName().getFullyQualifiedName());
        }
        if (names.contains("Controller") || names.contains("RestController")) return "Controller";
        if (names.contains("Service")) return "Service";
        if (names.contains("Repository")) return "Repository";
        return "Component";
    }

    static boolean isCollectableConstantType(String type) {
        return switch (type) {
            case "int", "long", "short", "byte", "double", "float",
                 "boolean", "char", "String", "Integer", "Long",
                 "Boolean", "Double", "Float" -> true;
            default -> false;
        };
    }
}
