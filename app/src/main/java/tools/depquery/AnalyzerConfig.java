package tools.depquery;

import java.nio.file.Path;
import java.util.*;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

/**
 * CLI引数パース・設定クラス
 */
class AnalyzerConfig {
    List<Path> srcRoots = new ArrayList<>();
    List<Path> classDirs = new ArrayList<>();
    List<String> roots = new ArrayList<>();
    int depth = 2;
    List<String> includes = new ArrayList<>();
    List<String> excludes = new ArrayList<>();
    Path outDir;
    Set<String> formats = new HashSet<>();
    List<Path> cpJars = new ArrayList<>();
    List<Path> cpDirs = new ArrayList<>();
    Path workspace;
    /**
     * 既定の言語レベル。JAVA_21 のままにしてあるのは後方互換のため
     * （既存の解析結果・キャッシュと出力が変わらないようにする）。
     * Java 22〜25 のソースを解析する場合は --lang-level 25 のように明示指定する。
     */
    static final String DEFAULT_LANGUAGE_LEVEL = "JAVA_21";

    /** 言語レベル（JAVA_8 .. JAVA_25）。JDT の compliance へは {@link JdtCallCollector#complianceOf} で変換する */
    String languageLevel = DEFAULT_LANGUAGE_LEVEL;
    boolean debug = false;
    boolean quiet = false;
    boolean timing = false;
    int windowWidth = 600;
    boolean rebuildCache = false;
    String direction = "outgoing";
    boolean buildIndex = false;
    String resolveFromIndexPath = null;
    String rootClassFqn = null;
    List<Pattern> includePatterns = new ArrayList<>();
    List<Pattern> excludePatterns = new ArrayList<>();

    static AnalyzerConfig parse(String[] args) {
        var cfg = new AnalyzerConfig();
        for (int i = 0; i < args.length; i++) {
            switch (args[i]) {
                case "--src" -> cfg.srcRoots = Arrays.stream(args[++i].split(",")).map(Path::of).toList();
                case "--classes" -> cfg.classDirs = Arrays.stream(args[++i].split(",")).map(Path::of).toList();
                case "--root" -> cfg.roots.add(args[++i]);
                case "--root-class" -> cfg.rootClassFqn = args[++i];
                case "--depth" -> cfg.depth = Integer.parseInt(args[++i]);
                case "--include" -> cfg.includes = Arrays.stream(args[++i].split(",")).map(String::trim).toList();
                case "--exclude" -> cfg.excludes = Arrays.stream(args[++i].split(",")).map(String::trim).toList();
                case "--out" -> cfg.outDir = Path.of(args[++i]);
                case "--format" ->
                    cfg.formats = Arrays.stream(args[++i].split(",")).map(String::trim).collect(Collectors.toSet());
                case "--cp" ->
                    cfg.cpJars = Arrays.stream(args[++i].split(",")).map(String::trim).map(Path::of).toList();
                case "--cpdir" ->
                    cfg.cpDirs = Arrays.stream(args[++i].split(",")).map(String::trim).map(Path::of).toList();
                case "--workspace" -> cfg.workspace = Path.of(args[++i]);
                case "--lang-level" -> cfg.languageLevel = parseLanguageLevel(args[++i]);
                case "--debug" -> cfg.debug = true;
                case "--quiet" -> cfg.quiet = true;
                case "--timing" -> cfg.timing = true;
                case "--width" -> cfg.windowWidth = Integer.parseInt(args[++i]);
                case "--rebuild-cache" -> cfg.rebuildCache = true;
                case "--direction" -> cfg.direction = args[++i].toLowerCase();
                case "--build-index" -> cfg.buildIndex = true;
                case "--resolve-from-index" -> cfg.resolveFromIndexPath = args[++i];
                case "--help", "-h" -> {
                    System.out.println(
                            """
                                    Options:
                                      --src <path>        Source directories (comma-separated)
                                      --classes <path>    Compiled class directories (comma-separated)
                                      --root <sig>        Root method signature (e.g., MyClass#method(String))
                                      --root-class <fqn>  Root class FQN (class-level analysis; exclusive with --root)
                                      --depth <n>         Maximum analysis depth (default: 2, -1 for unlimited/to root)
                                      --direction <dir>   Analysis direction: outgoing (callees) or incoming (callers) (default: outgoing)
                                      --include <pattern> Include patterns (comma-separated)
                                      --exclude <pattern> Exclude patterns (comma-separated)
                                      --out <path>        Output directory (default: build/depgraph)
                                      --format <formats>  Output formats: mermaid,json,seq,call-hierarchy,callcanvas
                                      --cp <jars>         Additional JARs for classpath (comma-separated)
                                      --cpdir <dirs>      Directories to search for JARs (comma-separated)
                                      --workspace <path>  Workspace root for relative path calculation
                                      --lang-level <lvl>  Java language level: JAVA_8 .. JAVA_25 (e.g. JAVA_17, JAVA_21, JAVA_25) (default: JAVA_21)
                                      --width <n>         Window width for CallCanvas output (default: 600)
                                      --rebuild-cache     Force rebuild hierarchy cache (for CHA optimization)
                                      --build-index       Build call index for faster analysis (incremental update if exists)
                                      --resolve-from-index <file:line>  Resolve method FQN from call index by file path and line number
                                      --debug             Enable debug output
                                      --help, -h          Show this help

                                    Usage (class-level): --root-class 'com.example.app.controller.OrderController'
                                    """);
                    System.exit(0);
                }
            }
        }
        if (cfg.formats.isEmpty())
            cfg.formats = Set.of("mermaid", "json");
        if (cfg.depth == 0)
            cfg.depth = 2;
        if (cfg.depth < -1) {
            System.err.println("[WARN] Invalid --depth value: " + cfg.depth + ", using default (2)");
            cfg.depth = 2;
        }
        if (cfg.srcRoots.isEmpty())
            cfg.srcRoots = List.of(Path.of("src/main/java"));
        if (cfg.outDir == null)
            cfg.outDir = Path.of("build/depgraph");
        if (!cfg.direction.equals("outgoing") && !cfg.direction.equals("incoming")) {
            System.err.println("[ERROR] Invalid --direction value: " + cfg.direction);
            System.err.println("        Must be 'outgoing' or 'incoming'");
            System.exit(1);
        }
        if (cfg.depth == -1 && cfg.direction.equals("outgoing")) {
            System.err.println("[WARN] --depth -1 (unlimited) is only supported with --direction incoming. Using default depth (2).");
            cfg.depth = 2;
        }

        for (String inc : cfg.includes) {
            String re = inc.replace("**", "__DOUBLESTAR__")
                          .replace("*", "[^.]*")
                          .replace(".", "\\.")
                          .replace("__DOUBLESTAR__", ".*");
            cfg.includePatterns.add(Pattern.compile(re));
        }
        for (String exc : cfg.excludes) {
            String re = exc.replace("**", "__DOUBLESTAR__")
                          .replace("*", "[^.]*")
                          .replace(".", "\\.")
                          .replace("__DOUBLESTAR__", ".*");
            cfg.excludePatterns.add(Pattern.compile(re));
        }

        return cfg;
    }

    private static String parseLanguageLevel(String level) {
        String v = level.toUpperCase();
        if (v.startsWith("JAVA_")) v = v.substring("JAVA_".length());
        try {
            int n = Integer.parseInt(v);
            if (n >= 8 && n <= 25) return "JAVA_" + n;
        } catch (NumberFormatException ignored) {
        }
        System.err.println("[WARN] Unknown language level: " + level + ", using " + DEFAULT_LANGUAGE_LEVEL);
        return DEFAULT_LANGUAGE_LEVEL;
    }
}
