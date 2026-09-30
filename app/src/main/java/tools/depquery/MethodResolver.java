package tools.depquery;

import java.util.*;

import static tools.depquery.DiagnosticLogger.*;
import static tools.depquery.FqnUtils.*;

/**
 * ルート解決ユーティリティ
 * - グラフ/宣言済みメソッド一覧からのルート解決（曖昧マッチング対応）
 */
class MethodResolver {

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
     * ユーザー指定のメソッドシグネチャを、宣言済みメソッドの FQN 一覧から解決（曖昧マッチング対応）
     */
    static String resolveRootMethodFqn(String userRoot, Collection<String> methodFqns) {
        // 1. 完全一致
        if (methodFqns.contains(userRoot)) {
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
        for (String candidateFqn : methodFqns) {
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
