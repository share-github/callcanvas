package tools.depquery;

import com.github.javaparser.ast.body.ClassOrInterfaceDeclaration;
import com.github.javaparser.resolution.declarations.ResolvedConstructorDeclaration;
import com.github.javaparser.resolution.declarations.ResolvedMethodDeclaration;
import com.github.javaparser.symbolsolver.javaparsermodel.JavaParserFacade;
import tools.depquery.CallIndexModels.*;

import java.nio.file.Path;
import java.util.List;

import static java.util.stream.Collectors.joining;
import static tools.depquery.DiagnosticLogger.*;
import static tools.depquery.FqnUtils.*;

/**
 * GraphModels.Node 生成ユーティリティ
 */
class NodeFactory {

    static String ensureNodeFromDecl(GraphModels.Graph g, SourceLocator.MethodLoc loc,
            JavaParserFacade facade) {
        var md = loc.decl();
        var clazzDecl = md.findAncestor(ClassOrInterfaceDeclaration.class).orElse(null);
        String classFqn = clazzDecl != null ? clazzDecl.getFullyQualifiedName().orElse("Unknown") : "Unknown";
        String simpleClass = clazzDecl != null ? clazzDecl.getNameAsString() : "Unknown";
        String name = md.getNameAsString();
        var paramsFqn = md.getParameters().stream()
                .map(p -> {
                    try {
                        return facade.getType(p).describe();
                    } catch (Throwable t) {
                        return p.getType().asString();
                    }
                })
                .toList();
        String id = classFqn + "#" + name + "(" + String.join(",", paramsFqn) + ")";
        int ls = md.getRange().map(r -> r.begin.line).orElse(-1);
        int le = md.getRange().map(r -> r.end.line).orElse(-1);
        String display = simpleClass + "." + name + "("
                + paramsFqn.stream().map(FqnUtils::shortType).collect(joining(", ")) + ")  L" + ls + "\u2013" + le;

        String stereotype = stereotypeOf(clazzDecl);
        var anns = md.getAnnotations().stream().map(a -> "@" + a.getNameAsString()).toList();
        g.addOrUpdateNode(new GraphModels.Node(id, display, classFqn, name, paramsFqn, loc.file().toString(), ls, le,
                anns, stereotype));
        return id;
    }

    static void ensureNodeStubIfMissing(GraphModels.Graph g, ResolvedMethodDeclaration decl,
            SourceLocator locator) {
        String id = toMethodFqn(decl);
        if (g.nodes.containsKey(id))
            return;
        String classFqn = decl.getPackageName() + "." + decl.getClassName();
        String simpleClass = decl.getClassName();
        String display = simpleClass + "." + decl.getName() + "("
                + paramTypeDescs(decl).stream().map(FqnUtils::shortType).collect(joining(", ")) + ")  L?-?";
        var anns = List.<String>of();
        var file = locator.resolveMethod(id).map(SourceLocator.MethodLoc::file).map(Path::toString).orElse("-");
        g.addOrUpdateNode(new GraphModels.Node(id, display, classFqn, decl.getName(),
                paramTypeDescs(decl), file, -1, -1, anns, "Component"));
    }

    static void ensureNodeStubIfMissing(GraphModels.Graph g, ResolvedConstructorDeclaration decl,
            SourceLocator locator) {
        String id = toCtorFqn(decl);
        if (g.nodes.containsKey(id))
            return;
        String classFqn = decl.getPackageName() + "." + decl.getClassName();
        String simpleClass = decl.getClassName();
        String display = simpleClass + "." + decl.getClassName() + "("
                + paramTypeDescs(decl).stream().map(FqnUtils::shortType).collect(joining(", ")) + ")  L?-?";
        var anns = List.<String>of();
        var file = locator.resolveMethod(id).map(SourceLocator.MethodLoc::file).map(Path::toString).orElse("-");
        g.addOrUpdateNode(new GraphModels.Node(id, display, classFqn, decl.getClassName(),
                paramTypeDescs(decl), file, -1, -1, anns, "Component"));
    }

    /**
     * インデックスのMethodEntryから直接Nodeを構築（パースなし・型解決なし）
     */
    static void createNodeFromEntry(GraphModels.Graph g, MethodEntry entry) {
        GraphModels.Node existing = g.nodes.get(entry.fqn);
        if (existing != null && existing.lineStart > 0) {
            return;
        }

        String display = entry.display != null ? entry.display : entry.fqn;
        String classFqn = entry.classFqn != null ? entry.classFqn : "Unknown";
        String methodName = entry.methodName != null ? entry.methodName : "unknown";
        List<String> paramsFqn = entry.paramsFqn != null ? entry.paramsFqn : List.of();
        List<String> annotations = entry.annotations != null ? entry.annotations : List.of();
        String stereotype = entry.stereotype != null ? entry.stereotype : "Component";

        var node = new GraphModels.Node(
            entry.fqn,
            display,
            classFqn,
            methodName,
            paramsFqn,
            entry.file,
            entry.lineStart,
            entry.lineEnd,
            annotations,
            stereotype
        );
        g.addOrUpdateNode(node);
    }

    /**
     * Indexにないメソッドのスタブノードを作成（外部ライブラリ等）
     */
    static void createStubNode(GraphModels.Graph g, String fqn) {
        if (g.nodes.containsKey(fqn)) {
            return;
        }

        int hashPos = fqn.indexOf('#');
        String classFqn = hashPos > 0 ? fqn.substring(0, hashPos) : "Unknown";
        String simpleClass = classFqn.contains(".")
            ? classFqn.substring(classFqn.lastIndexOf('.') + 1)
            : classFqn;
        int parenPos = fqn.indexOf('(', hashPos);
        String methodName = hashPos > 0 && parenPos > hashPos
            ? fqn.substring(hashPos + 1, parenPos)
            : "unknown";

        String display = simpleClass + "." + methodName + "(...)  [external]";
        var node = new GraphModels.Node(
            fqn,
            display,
            classFqn,
            methodName,
            List.of(),
            "-",
            -1,
            -1,
            List.of(),
            "External"
        );
        g.addOrUpdateNode(node);
    }

    static boolean acceptByFilter(String callee, AnalyzerConfig cfg) {
        String classPart = callee.contains("#") ? callee.substring(0, callee.indexOf('#')) : callee;
        boolean inc = cfg.includePatterns.isEmpty() ||
                      cfg.includePatterns.stream().anyMatch(p -> p.matcher(classPart).matches());
        boolean exc = cfg.excludePatterns.stream().anyMatch(p -> p.matcher(classPart).matches());
        return inc && !exc;
    }
}
