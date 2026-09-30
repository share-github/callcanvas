package tools.depquery;

import java.util.*;
import java.util.function.Function;

import static tools.depquery.DiagnosticLogger.*;

/**
 * CHA（Class Hierarchy Analysis）用のコンテキスト
 * HierarchyCacheを使用して高速にサブクラスを検索
 */
class ChaContext {
    private final HierarchyCache cache;
    /**
     * 候補 FQN（サブクラス/親クラス名 + "#" + name(params)）に対応するメソッドが実在するかを判定し、
     * 実在すればそのメソッドの FQN を返す（無ければ null）。
     */
    private final Function<String, String> methodResolver;
    // findOverrides結果のメモ化キャッシュ（パフォーマンス最適化）
    private final Map<String, Set<String>> overrideCache = new HashMap<>();
    // findParentMethods結果のメモ化キャッシュ
    private final Map<String, Set<String>> parentMethodCache = new HashMap<>();

    /** --timing 用集約（FQN・パスは出さない） */
    private long overrideCacheHits;
    private long overrideCacheMisses;
    private int maxSubclassesOnCompute;
    private long sumSubclassesOnCompute;

    /**
     * CHA用のコンテキストを作成（実在判定は JDT で解析済みの宣言メソッドの一覧から引く）
     *
     * @param cache          継承関係キャッシュ
     * @param methodResolver 候補 FQN → 実在するメソッドの FQN（無ければ null）
     */
    ChaContext(HierarchyCache cache, Function<String, String> methodResolver) {
        this.cache = cache;
        this.methodResolver = methodResolver;
    }

    /**
     * HierarchyCacheを取得（親クラス探索用）
     *
     * @return 継承関係キャッシュ
     */
    HierarchyCache getCache() {
        return cache;
    }

    /**
     * オーバーライドメソッドを取得（キャッシュから高速に検索）
     *
     * @param methodFqn 親クラスのメソッドFQN
     * @return サブクラスでオーバーライドしているメソッドFQNのSet
     */
    Set<String> findOverrides(String methodFqn) {
        Set<String> cached = overrideCache.get(methodFqn);
        if (cached != null) {
            overrideCacheHits++;
            debugVerbose("CHA override cache hit: " + methodFqn);
            return cached;
        }

        overrideCacheMisses++;
        Set<String> result = computeOverrides(methodFqn);
        overrideCache.put(methodFqn, result);
        return result;
    }

    /**
     * CHA の集約統計を 1 行で出力（機密にならない数値のみ）
     */
    void emitChaTimingSummary() {
        timing("SUMMARY cha=overrideHits=" + overrideCacheHits
                + ",overrideMisses=" + overrideCacheMisses
                + ",subclassCountMax=" + maxSubclassesOnCompute
                + ",subclassCountSum=" + sumSubclassesOnCompute);
    }

    /**
     * オーバーライドメソッドを計算（内部実装）
     */
    private Set<String> computeOverrides(String methodFqn) {
        Set<String> result = new HashSet<>();

        // メソッドFQNからクラス名とメソッドシグネチャを分離
        int hashPos = methodFqn.indexOf('#');
        if (hashPos < 0)
            return result;

        String classFqn = methodFqn.substring(0, hashPos);
        String methodSig = methodFqn.substring(hashPos + 1); // name(params)

        Set<String> allSubclasses = cache.getAllSubclasses(classFqn);
        int subCount = allSubclasses.size();
        if (subCount > maxSubclassesOnCompute) {
            maxSubclassesOnCompute = subCount;
        }
        sumSubclassesOnCompute += subCount;
        debug("CHA cache: " + classFqn + " has " + subCount + " subclasses");

        // 各サブクラスでメソッドが存在するか確認
        for (String subclass : allSubclasses) {
            String candidateFqn = subclass + "#" + methodSig;
            String found = methodResolver.apply(candidateFqn);
            if (found != null) {
                result.add(found);
                debug("CHA cache: found override " + found);
            } else {
                // サブクラスにメソッドがない場合、親クラスチェーンを遡って実装を探す
                String inheritedImpl = findInheritedMethod(subclass, methodSig);
                if (inheritedImpl != null && !result.contains(inheritedImpl)) {
                    result.add(inheritedImpl);
                    debug("CHA cache: found inherited " + inheritedImpl + " for " + subclass);
                }
            }
        }

        return result;
    }

    /**
     * 親クラスチェーンを遡ってメソッド実装を探す
     *
     * @param classFqn  検索開始のクラスFQN
     * @param methodSig メソッドシグネチャ（name(params)形式）
     * @return 見つかったメソッドのFQN、見つからなければnull
     */
    private String findInheritedMethod(String classFqn, String methodSig) {
        Set<String> visited = new HashSet<>();
        Queue<String> queue = new LinkedList<>(cache.getParentClasses(classFqn));

        while (!queue.isEmpty()) {
            String parent = queue.poll();
            if (visited.contains(parent))
                continue;
            visited.add(parent);

            String candidateFqn = parent + "#" + methodSig;
            String found = methodResolver.apply(candidateFqn);
            if (found != null) {
                return found;
            }

            // さらに上の親クラスを探索
            queue.addAll(cache.getParentClasses(parent));
        }
        return null;
    }

    /**
     * 親クラス/インターフェースでオーバーライド元となるメソッドを取得（双方向CHA）
     *
     * @param methodFqn 子クラスのメソッドFQN
     * @return 親クラス/インターフェースでオーバーライド元となるメソッドFQNのSet
     */
    Set<String> findParentMethods(String methodFqn) {
        // メモ化キャッシュをチェック
        Set<String> cached = parentMethodCache.get(methodFqn);
        if (cached != null) {
            debugVerbose("CHA parent method cache hit: " + methodFqn);
            return cached;
        }

        // キャッシュミス時は計算
        Set<String> result = computeParentMethods(methodFqn);
        parentMethodCache.put(methodFqn, result);
        return result;
    }

    /**
     * 親メソッドを計算（内部実装）
     */
    private Set<String> computeParentMethods(String methodFqn) {
        Set<String> result = new HashSet<>();

        // メソッドFQNからクラス名とメソッドシグネチャを分離
        int hashPos = methodFqn.indexOf('#');
        if (hashPos < 0)
            return result;

        String classFqn = methodFqn.substring(0, hashPos);
        String methodSig = methodFqn.substring(hashPos + 1); // name(params)

        // 親クラス/インターフェースを取得
        List<String> parentClasses = cache.getParentClasses(classFqn);
        debug("CHA parent search: " + classFqn + " has " + parentClasses.size() + " parent(s)");

        // 各親クラス/インターフェースでメソッドが存在するか確認
        Set<String> visited = new HashSet<>();
        Queue<String> queue = new LinkedList<>(parentClasses);

        while (!queue.isEmpty()) {
            String parent = queue.poll();
            if (visited.contains(parent))
                continue;
            visited.add(parent);

            String candidateFqn = parent + "#" + methodSig;
            String found = methodResolver.apply(candidateFqn);
            if (found != null) {
                result.add(found);
                debug("CHA parent search: found parent method " + found);
            }

            // さらに上の親クラスも探索（再帰的）
            queue.addAll(cache.getParentClasses(parent));
        }

        return result;
    }
}
