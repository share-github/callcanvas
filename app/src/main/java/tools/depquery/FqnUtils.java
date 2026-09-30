package tools.depquery;

import java.util.*;

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

    static String shortType(String fqn) {
        int i = Math.max(fqn.lastIndexOf('.'), fqn.lastIndexOf('$'));
        return i >= 0 ? fqn.substring(i + 1) : fqn;
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
}
