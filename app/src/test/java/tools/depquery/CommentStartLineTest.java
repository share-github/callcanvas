package tools.depquery;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * OutputGenerator#findCommentStartLine の単体テスト。
 *
 * ウィンドウの開始行（= メソッド直上のドキュメントコメント先頭）が
 * 各コメント形式で正しく求まることを検証する。
 */
class CommentStartLineTest {

    /** 1-based のメソッド開始行を渡し、1-based のウィンドウ開始行を得る。 */
    private static int start(List<String> lines, int methodStart1Based) {
        return OutputGenerator.findCommentStartLine(lines, methodStart1Based);
    }

    @Nested
    @DisplayName("マークダウン Javadoc (JEP 467 / ///)")
    class MarkdownDoc {

        @Test
        @DisplayName("/// の連続はすべてウィンドウに含まれる")
        void includesWholeMarkdownDocBlock() {
            var lines = List.of(
                    "/// Returns the total amount.",   // 1
                    "/// @param order the order",      // 2
                    "public BigDecimal total(Order order) {"); // 3
            assertEquals(1, start(lines, 3));
        }

        @Test
        @DisplayName("/// とメソッドの間にアノテーションがあっても先頭 /// に戻る")
        void worksWhenDeclarationStartsAtAnnotation() {
            var lines = List.of(
                    "/// Markdown javadoc.",  // 1
                    "@Override",              // 2
                    "public void process() {"); // 3
            // JavaParser はアノテーション行を宣言の開始として報告する
            assertEquals(1, start(lines, 2));
        }

        @Test
        @DisplayName("先行する素の // は含めない（ブロック Javadoc と同じ扱い）")
        void stopsAtPlainLineCommentAbove() {
            var lines = List.of(
                    "// TODO: internal note",  // 1
                    "/// Markdown javadoc.",   // 2
                    "public void process() {"); // 3
            assertEquals(2, start(lines, 3));
        }

        @Test
        @DisplayName("インデントされた /// も検出する")
        void handlesIndentedMarkdownDoc() {
            var lines = List.of(
                    "class Foo {",                     // 1
                    "    /// Markdown javadoc.",       // 2
                    "    /// second line",             // 3
                    "    void process() {");           // 4
            assertEquals(2, start(lines, 4));
        }

        @Test
        @DisplayName("空行で区切られた /// ブロックは含めない")
        void ignoresMarkdownDocSeparatedByBlankLine() {
            var lines = List.of(
                    "/// Unrelated doc.",      // 1
                    "",                        // 2
                    "public void process() {"); // 3
            // 空行スキップ後に /// に到達するため、そこまで遡る
            assertEquals(1, start(lines, 3));
        }
    }

    @Nested
    @DisplayName("従来形式")
    class LegacyFormats {

        @Test
        @DisplayName("ブロック Javadoc は /** から含まれる")
        void includesBlockJavadoc() {
            var lines = List.of(
                    "/**",                     // 1
                    " * Returns the total.",   // 2
                    " */",                     // 3
                    "public void process() {"); // 4
            assertEquals(1, start(lines, 4));
        }

        @Test
        @DisplayName("// の連続は先頭行から含まれる")
        void includesLineCommentRun() {
            var lines = List.of(
                    "// first",                // 1
                    "// second",               // 2
                    "public void process() {"); // 3
            assertEquals(1, start(lines, 3));
        }

        @Test
        @DisplayName("コメントが無ければメソッド開始行のまま")
        void returnsMethodStartWhenNoComment() {
            var lines = List.of(
                    "private int x;",          // 1
                    "public void process() {"); // 2
            assertEquals(2, start(lines, 2));
        }
    }

    @Nested
    @DisplayName("境界条件")
    class EdgeCases {

        @Test
        @DisplayName("1 行目のメソッドはそのまま返す")
        void returnsAsIsForFirstLine() {
            assertEquals(1, start(List.of("public void process() {"), 1));
        }

        @Test
        @DisplayName("行数を超える指定はそのまま返す")
        void returnsAsIsWhenOutOfRange() {
            assertEquals(99, start(List.of("public void process() {"), 99));
        }

        @Test
        @DisplayName("null / 空リストはそのまま返す")
        void handlesNullAndEmpty() {
            assertEquals(5, start(null, 5));
            assertEquals(5, start(List.of(), 5));
        }
    }
}
