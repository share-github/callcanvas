package tools.depquery;

import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;

/**
 * ログ出力・デバッグ・タイミング計測ユーティリティ
 */
class DiagnosticLogger {

    static final String VERSION = "0.7.17";

    static final DateTimeFormatter TIMESTAMP_FMT =
        DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss.SSS");

    static boolean DEBUG = false;
    static boolean QUIET = false;
    static boolean TIMING = false;

    static void debug(String msg) {
        if (DEBUG && !QUIET) {
            System.err.println("[DEBUG] " + msg);
        }
    }

    static void debugVerbose(String msg) {
        if (DEBUG && !QUIET) {
            System.err.println("[DEBUG-VERBOSE] " + msg);
        }
    }

    static void debugTimed(String msg) {
        if (DEBUG && !QUIET) {
            String timestamp = LocalDateTime.now().format(TIMESTAMP_FMT);
            System.err.println("[" + timestamp + "] " + msg);
        }
    }

    static void info(String msg) {
        if (!QUIET) {
            System.out.println(msg);
        }
    }

    static void alwaysPrint(String msg) {
        System.out.println(msg);
    }

    static void timing(String msg) {
        if (TIMING || DEBUG) {
            String timestamp = LocalDateTime.now().format(TIMESTAMP_FMT);
            System.err.println("[TIMING] " + timestamp + " " + msg);
        }
    }

    static long startTiming(String blockName) {
        if (TIMING || DEBUG) {
            timing("START " + blockName);
        }
        return System.currentTimeMillis();
    }

    static void endTiming(String blockName, long startTime) {
        if (TIMING || DEBUG) {
            long elapsed = System.currentTimeMillis() - startTime;
            timing("END " + blockName + " (" + elapsed + "ms)");
        }
    }

    static void protocol(String msg) {
        System.err.println(msg);
    }

    static String formatExceptionDetail(Throwable ex) {
        StringBuilder sb = new StringBuilder();
        sb.append(ex.getClass().getSimpleName()).append(": ").append(ex.getMessage());
        Throwable cause = ex.getCause();
        int depth = 0;
        while (cause != null && depth < 5) {
            sb.append(" <- ").append(cause.getClass().getSimpleName()).append(": ").append(cause.getMessage());
            cause = cause.getCause();
            depth++;
        }
        return sb.toString();
    }

    static String formatResolveError(Throwable ex) {
        String msg = ex.getMessage();
        if (msg != null) {
            if (msg.contains("unknown tree")) {
                return "unknown tree (unsupported AST node)";
            }
            if (msg.contains("UnsolvedSymbol")) {
                return "unsolved symbol";
            }
        }
        return "unresolved";
    }
}
