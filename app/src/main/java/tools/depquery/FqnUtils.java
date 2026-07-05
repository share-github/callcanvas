package tools.depquery;

import com.github.javaparser.StaticJavaParser;
import com.github.javaparser.ast.CompilationUnit;
import com.github.javaparser.ast.body.ClassOrInterfaceDeclaration;
import com.github.javaparser.ast.body.MethodDeclaration;
import com.github.javaparser.resolution.declarations.ResolvedConstructorDeclaration;
import com.github.javaparser.resolution.declarations.ResolvedMethodDeclaration;
import com.github.javaparser.resolution.declarations.ResolvedMethodLikeDeclaration;
import com.github.javaparser.symbolsolver.javaparsermodel.JavaParserFacade;

import java.io.IOException;
import java.nio.file.Path;
import java.util.*;
import java.util.stream.Collectors;

import static tools.depquery.DiagnosticLogger.*;

/**
 * FQN / 型文字列操作ユーティリティ
 */
class FqnUtils {

    static class MethodInfo {
        String className;
        String methodName;
        MethodInfo(String className, String methodName) {
            this.className = className;
            this.methodName = methodName;
        }
    }

    static MethodInfo parseMethodSignature(String signature) {
        if (signature == null || !signature.contains("#")) {
            return new MethodInfo("Unknown", "Unknown");
        }
        int hashIndex = signature.indexOf('#');
        String fullClassName = signature.substring(0, hashIndex);
        String afterHash = signature.substring(hashIndex + 1);
        int parenIndex = afterHash.indexOf('(');
        String methodName = parenIndex != -1 ? afterHash.substring(0, parenIndex) : afterHash;
        int lastDotIndex = fullClassName.lastIndexOf('.');
        String simpleClassName = lastDotIndex != -1
            ? fullClassName.substring(lastDotIndex + 1)
            : fullClassName;
        if (methodName.equals("<init>")) {
            methodName = "init";
        }
        return new MethodInfo(simpleClassName, methodName);
    }

    static String sanitizeForFilename(String input) {
        if (input == null || input.isEmpty()) {
            return "Unknown";
        }
        String sanitized = input.replaceAll("[<>:\"/\\\\|?*\\[\\](),{}\\s]+", "_");
        sanitized = sanitized.replaceAll("_+", "_");
        sanitized = sanitized.replaceAll("^_|_$", "");
        if (sanitized.length() > 100) {
            sanitized = sanitized.substring(0, 100);
        }
        return sanitized.isEmpty() ? "Unknown" : sanitized;
    }

    static String toMethodFqn(ResolvedMethodDeclaration d) {
        String cls = d.getPackageName() + "." + d.getClassName();
        String params = String.join(",", paramTypeDescs(d));
        return cls + "#" + d.getName() + "(" + params + ")";
    }

    static String toCtorFqn(ResolvedConstructorDeclaration d) {
        String cls = d.getPackageName() + "." + d.getClassName();
        String params = String.join(",", paramTypeDescs(d));
        return cls + "#" + d.getClassName() + "(" + params + ")";
    }

    static List<String> paramTypeDescs(ResolvedMethodLikeDeclaration decl) {
        List<String> types = new ArrayList<>();
        for (int i = 0; i < decl.getNumberOfParams(); i++) {
            try {
                types.add(decl.getParam(i).getType().describe());
            } catch (Throwable t) {
                types.add("?");
            }
        }
        return types;
    }

    static String shortType(String fqn) {
        int i = Math.max(fqn.lastIndexOf('.'), fqn.lastIndexOf('$'));
        return i >= 0 ? fqn.substring(i + 1) : fqn;
    }

    static String removeGenericsFromType(String type) {
        int genStart = type.indexOf('<');
        if (genStart < 0) {
            return type;
        }
        return type.substring(0, genStart);
    }

    static List<String> splitParams(String params) {
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

    static String removeGenerics(String type) {
        int genStart = type.indexOf('<');
        if (genStart < 0) {
            return type;
        }
        return type.substring(0, genStart);
    }

    static boolean isPrimitive(String type) {
        return type.equals("int") || type.equals("long") || type.equals("double") ||
                type.equals("float") || type.equals("boolean") || type.equals("char") ||
                type.equals("byte") || type.equals("short") || type.equals("void");
    }

    static boolean isFullyQualifiedRoot(String root) {
        if (!root.contains("#"))
            return false;
        int hashPos = root.indexOf('#');
        String classPart = root.substring(0, hashPos);
        if (!classPart.contains("."))
            return false;
        String[] parts = classPart.split("\\.");
        if (parts.length < 2)
            return false;
        return Character.isLowerCase(parts[0].charAt(0));
    }

    static boolean classNameMatches(String nodeFqn, String userClass) {
        if (nodeFqn.equals(userClass)) {
            return true;
        }
        if (nodeFqn.endsWith("." + userClass)) {
            return true;
        }
        return false;
    }

    static boolean typeMatches(String nodeFqn, String userType) {
        if (nodeFqn.equals(userType)) {
            return true;
        }
        if (isPrimitive(userType)) {
            return false;
        }
        String nodeBase = removeGenerics(nodeFqn);
        String userBase = removeGenerics(userType);
        if (nodeBase.equals(userBase)) {
            return true;
        }
        if (nodeBase.endsWith("." + userBase) || userBase.endsWith("." + nodeBase)) {
            return true;
        }
        if (userType.endsWith("[]") && nodeFqn.endsWith("[]")) {
            String userArrayBase = userType.substring(0, userType.length() - 2);
            String nodeArrayBase = nodeFqn.substring(0, nodeFqn.length() - 2);
            return typeMatches(nodeArrayBase, userArrayBase);
        }
        return false;
    }

    static CompilationUnit parseCu(Path file) {
        try {
            return StaticJavaParser.parse(file);
        } catch (IOException e) {
            throw new RuntimeException(e);
        }
    }

    static Path sourcePathOf(CompilationUnit cu) {
        return Path.of(cu.getStorage().map(s -> s.getPath().toString()).orElse("-"));
    }

    static String stereotypeOf(ClassOrInterfaceDeclaration cls) {
        if (cls == null)
            return "Component";
        var names = cls.getAnnotations().stream().map(a -> a.getNameAsString()).collect(Collectors.toSet());
        if (names.contains("Controller") || names.contains("RestController"))
            return "Controller";
        if (names.contains("Service"))
            return "Service";
        if (names.contains("Repository"))
            return "Repository";
        return "Component";
    }

    static String buildMethodFqn(String classFqn, MethodDeclaration md, JavaParserFacade facade) {
        String name = md.getNameAsString();
        List<String> paramsFqn = md.getParameters().stream()
                .map(p -> {
                    try {
                        return facade.getType(p).describe();
                    } catch (Throwable t) {
                        return p.getType().asString();
                    }
                })
                .toList();
        return classFqn + "#" + name + "(" + String.join(",", paramsFqn) + ")";
    }

    static boolean isVirtualCall(ResolvedMethodDeclaration decl) {
        try {
            if (decl.declaringType().isInterface()) {
                return true;
            }
            if (decl.isAbstract()) {
                return true;
            }
            if (decl.isStatic()) {
                return false;
            }
            return true;
        } catch (Throwable t) {
            return true;
        }
    }
}
