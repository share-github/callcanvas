// IS_EXPORT_MODE: true when rendered as standalone HTML export
const IS_EXPORT_MODE = window.CALLCANVAS_CONFIG.IS_EXPORT_MODE;

// VS Code API (real in webview, no-op dummy in export HTML)
const vscode = IS_EXPORT_MODE
    ? { postMessage: function(){}, getState: function(){ return {}; }, setState: function(){} }
    : acquireVsCodeApi();

// Settings from VSCode configuration
const SETTINGS = window.CALLCANVAS_CONFIG.SETTINGS;

function toKeyBindingString(e) {
    const parts = [];
    if (e.ctrlKey) parts.push('ctrl');
    if (e.altKey) parts.push('alt');
    if (e.metaKey) parts.push('meta');
    if (e.shiftKey) parts.push('shift');
    const key = e.key && e.key.length === 1 ? e.key.toLowerCase() : (e.key || '').toLowerCase();
    if (key) parts.push(key);
    return parts.join('+');
}

// Height calculation constants and helpers (used by toggle functions and renderVisualization)
const TITLE_BAR_HEIGHT = 33;
const CONTENT_PADDING = 24;
const LINE_HEIGHT = 20;
const BOTTOM_BUFFER = 20;  // Extra px so the last line is not clipped (subpixel/scrollbar)
// Comment bubble: font-size 12px, line-height 1.4 → ~17px per line; margin+padding ~36px total
const COMMENT_LINE_HEIGHT_PX = 17;
const COMMENT_BUBBLE_CHROME_PX = 36;

function calcWindowHeight(lineCount, applyMaxLimit) {
    const raw = TITLE_BAR_HEIGHT + CONTENT_PADDING + (lineCount * LINE_HEIGHT) + BOTTOM_BUFFER;
    const min = SETTINGS.minWindowHeight;
    if (applyMaxLimit) {
        return Math.max(min, Math.min(SETTINGS.maxWindowHeight, raw));
    }
    return Math.max(min, raw);
}

function getLineCount(windowData) {
    return Array.isArray(windowData.code)
        ? windowData.code.length
        : (windowData.code || '').split(String.fromCharCode(10)).length;
}

function getCommentHeightInLines(windowData) {
    if (!Array.isArray(windowData.code)) return 0;
    let total = 0;
    for (const line of windowData.code) {
        if (line.comment && typeof line.comment === 'string') {
            const newlines = (line.comment.match(new RegExp(String.fromCharCode(10), 'g')) || []).length;
            total += 2 + newlines;
        }
    }
    return total;
}

/** Total pixel height of all comment bubbles (matches .line-comment-bubble CSS). */
function getCommentHeightPx(windowData) {
    if (!Array.isArray(windowData.code)) return 0;
    let total = 0;
    for (const line of windowData.code) {
        if (line.comment && typeof line.comment === 'string') {
            const newlines = (line.comment.match(new RegExp(String.fromCharCode(10), 'g')) || []).length;
            const textLines = 1 + newlines;
            total += COMMENT_BUBBLE_CHROME_PX + textLines * COMMENT_LINE_HEIGHT_PX;
        }
    }
    return total;
}

function getEffectiveLineCountForFullHeight(windowData) {
    return getLineCount(windowData) + getCommentHeightInLines(windowData);
}

/** Full-height window size using code lines (20px) + comment bubbles (actual px). Avoids excess bottom margin. */
function calcFullHeightWindowHeight(windowData) {
    const codeLines = getLineCount(windowData);
    const commentPx = getCommentHeightPx(windowData);
    const raw = TITLE_BAR_HEIGHT + CONTENT_PADDING + (codeLines * LINE_HEIGHT) + commentPx + BOTTOM_BUFFER;
    return Math.max(SETTINGS.minWindowHeight, raw);
}

// Initialize on page load
window.addEventListener('DOMContentLoaded', function () {
    const data = window.CALLCANVAS_CONFIG.initialData;
    renderVisualization(data);
    initializeZoom();
    initializeConnectionMode();
    if (!IS_EXPORT_MODE) {
        window.addEventListener('scroll', scheduleViewportCheck, { passive: true });
    }

    // 定数ツールチップ
    const tip = document.createElement('div');
    tip.id = 'constant-tooltip';
    tip.className = 'constant-tooltip';
    document.body.appendChild(tip);

    document.addEventListener('mouseover', e => {
        const el = e.target.closest('.symbol-ref[data-tip], .constant-token');
        if (!el) return;
        const encoded = el.dataset.tip || '';
        try {
            tip.textContent = decodeURIComponent(encoded);
        } catch {
            // Fallback for legacy/unencoded tooltip attributes
            tip.textContent = encoded;
        }
        tip.style.display = 'block';
    });
    document.addEventListener('mousemove', e => {
        if (tip.style.display === 'block') {
            tip.style.left = (e.clientX + 14) + 'px';
            tip.style.top  = (e.clientY - 28) + 'px';
        }
    });
    document.addEventListener('mouseout', e => {
        if (e.target.closest('.symbol-ref[data-tip], .constant-token')) {
            tip.style.display = 'none';
        }
    });

    // Ctrl/⌘ held → symbol-ref tokens show underline + link cursor on hover (IDE style)
    const setModHeld = held => document.body.classList.toggle('symbol-mod-held', !!held);
    document.addEventListener('keydown', e => {
        if (e.key === 'Control' || e.key === 'Meta') setModHeld(true);
    });
    document.addEventListener('keyup', e => {
        if (e.key === 'Control' || e.key === 'Meta') setModHeld(false);
    });
    document.addEventListener('mousemove', e => setModHeld(e.ctrlKey || e.metaKey), { passive: true });
    window.addEventListener('blur', () => setModHeld(false));
});

// Store current data globally for updates
let currentData = null;

// Connection mode state
let connectionMode = false;
let connectionSource = null;

// Multi-selection state
let selectedWindows = new Set();     // Selected window IDs
let selectedConnections = new Set(); // Selected connection IDs (format: "fromId->toId")
let isSelecting = false;             // Drag selection in progress
let selectionBox = null;             // Selection rectangle DOM element
let selectionStart = null;           // Selection start coordinates {x, y}

// Jump history for navigation (Alt+← to go back)
let jumpHistory = [];                // Stack of {windowId, lineNumber}
const JUMP_HISTORY_MAX_SIZE = 50;

// Search functionality
let searchQuery = '';                // Current search query
let searchMatches = [];              // Array of matched window IDs
let currentMatchIndex = -1;          // Current focused match index
let searchBoxVisible = false;        // Search box visibility state

// Selection-driven highlight (all windows, no dimming; exclusive with Ctrl+F text marks)
let selectionHighlightQuery = '';
const SELECTION_HIGHLIGHT_MAX_LEN = 128;
let _selectionHighlightDebounceTimer = null;
/** After innerHTML updates for highlights, ignore empty selection briefly (avoids clearing user highlight). */
let _selectionHighlightAllowEmptyClear = true;
let _selectionHighlightQuietTimeout = null;

// Coverage overlay
// Structure: { [packageSlashFile]: { [lineNr]: { mi, ci, mb, cb } } }
let currentCoverage = null;

// ---- Viewport-based content virtualization ----
const VIEWPORT_BUFFER_PX = 800;

// Listen for messages from VS Code
window.addEventListener('message', event => {
    const message = event.data;
    switch (message.command) {
        case 'addWindow':
            addWindowToViewer(message.window);
            break;
        case 'mergeCallCanvasData':
            mergeCallCanvasData(message.data, message.sourceWindowDisplayName, message.sourceWindowId);
            break;
        case 'jumpBack':
            jumpBack();
            break;
        case 'commitDiffDetails':
            applyDiffOverlay(message.diffs);
            break;
        case 'applyWidth':
            applyWidthToAllWindows(message.width);
            break;
        case 'reloadData':
            reloadViewer(message.data, message.reloadSource);
            break;
        case 'applyCoverage':
            applyCoverageOverlay(message.coverage);
            break;
        case 'clearCoverage':
            clearCoverageOverlay();
            break;
        case 'requestExportHtml': {
            const exportData = buildSaveData();
            if (exportData) {
                vscode.postMessage({ command: 'exportHtml', data: exportData });
            }
            break;
        }
    }
});

// Toast notification function (replacement for alert in sandboxed webview)
function showToast(message, type = 'info', duration = 3000) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = 'toast ' + type;
    toast.textContent = message;
    container.appendChild(toast);

    // Trigger show animation
    requestAnimationFrame(() => {
        toast.classList.add('show');
    });

    // Auto-remove after duration
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => {
            if (toast.parentNode) {
                toast.parentNode.removeChild(toast);
            }
        }, 300);
    }, duration);
}

// Zoom functionality
let zoomLevel = 1.0;
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 3.0;
const ZOOM_SENSITIVITY = 0.002;  // deltaY-proportional zoom (smooth trackpad/wheel)

function initializeZoom() {
    const body = document.body;
    
    body.addEventListener('wheel', function(e) {
        // Shift+wheel: horizontal scroll (Windows などで deltaX が 0 のまま deltaY だけ送られる環境に対応)
        if (e.shiftKey) {
            e.preventDefault();
            const dx = e.deltaX !== 0 ? e.deltaX : e.deltaY;
            window.scrollBy(dx, 0);
            return;
        }
        // Ctrl or Cmd + wheel: zoom
        if (e.ctrlKey || e.metaKey) {
            e.preventDefault();

            // Delta-proportional zoom (B): smooth response to trackpad and wheel
            const factor = 1 - e.deltaY * ZOOM_SENSITIVITY;
            const newZoomLevel = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoomLevel * factor));

            if (newZoomLevel !== zoomLevel) {
                const oldZoom = zoomLevel;
                const mouseX = e.clientX;
                const mouseY = e.clientY;

                // Content coordinate under the mouse cursor (accounting for scroll and zoom)
                const contentX = (window.scrollX + mouseX) / oldZoom;
                const contentY = (window.scrollY + mouseY) / oldZoom;

                zoomLevel = newZoomLevel;

                // (A) Disable transition during zoom so scale and scroll stay in sync
                const container = document.querySelector('.container');
                if (container) {
                    container.style.transition = 'none';
                }

                applyZoom();

                // Adjust scroll so the same content point stays under the mouse
                const newScrollX = contentX * newZoomLevel - mouseX;
                const newScrollY = contentY * newZoomLevel - mouseY;
                window.scrollTo(newScrollX, newScrollY);

                // Restore transition after this frame so other animations (e.g. window hover) still work
                if (container) {
                    requestAnimationFrame(() => {
                        container.style.transition = '';
                    });
                }
            }
            return;
        }
    }, { passive: false });
}

function applyZoom() {
    const container = document.querySelector('.container');
    if (container) {
        container.style.transform = `scale(${zoomLevel})`;
        container.style.transformOrigin = 'top left';
        scheduleViewportCheck();
    }
}

function addWindowToViewer(windowData) {
    if (!currentData) return;

    // Normalize the window data
    const normalizedWindow = normalizeWindowData(windowData);

    // Add default position (place it at a visible location)
    if (!normalizedWindow.position) {
        normalizedWindow.position = {
            top: 100 + (currentData.windows.length * 50),
            left: 100 + (currentData.windows.length * 50),
            width: 600,
            height: 320
        };
    }

    // Add to current data
    currentData.windows.push(normalizedWindow);

    // Render the new window
    const container = document.querySelector('.container');
    const windowElement = createWindow(normalizedWindow);
    container.appendChild(windowElement);

    // Update container size
    updateContainerSize();

    // Save the updated data
    saveData();
}

function addConnectedWindow(sourceWindowId, displayName, code, filePath) {
    const sourceWindow = currentData.windows.find(w => w.id === sourceWindowId);
    if (!sourceWindow) return;
    const newId = 'window-' + Date.now();
    const GAP = 80;
    const newPosition = {
        top: sourceWindow.position.top,
        left: sourceWindow.position.left + sourceWindow.position.width + GAP,
        width: sourceWindow.position.width,
        height: 320
    };
    const windowData = {
        id: newId,
        displayName,
        filePath: filePath || undefined,
        startLine: 1,
        code: code || '',
        position: newPosition,
        collapsed: false,
        visible: true,
        fullHeight: false
    };
    const normalized = normalizeWindowData(windowData);
    currentData.windows.push(normalized);
    const container = document.querySelector('.container');
    container.appendChild(createWindow(normalized));
    addConnection(sourceWindowId, newId);
    updateContainerSize();
    showToast(`"${displayName}" を追加しました`, 'success', 2000);
}

function showAddConnectedWindowModal(sourceWindowId) {
    const overlay = document.createElement('div');
    overlay.className = 'add-connected-window-modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'add-connected-window-modal';
    modal.innerHTML = `
        <div class="add-connected-window-modal-title">接続済みWindowを追加</div>
        <div class="add-connected-window-modal-field">
            <label>Window名 <span style="color:#f44336">*</span></label>
            <input type="text" id="acw-display-name" placeholder="ClassName # methodName" />
        </div>
        <div class="add-connected-window-modal-field">
            <label>ファイルパス（任意）</label>
            <input type="text" id="acw-file-path" placeholder="mapper/OrderMapper.xml" />
        </div>
        <div class="add-connected-window-modal-field">
            <label>コード（任意）</label>
            <textarea id="acw-code" placeholder="SELECT * FROM orders WHERE id = #{id}" rows="4"></textarea>
        </div>
        <div class="add-connected-window-modal-buttons">
            <button id="acw-cancel">キャンセル</button>
            <button id="acw-ok" class="primary">OK</button>
        </div>
    `;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const nameInput = modal.querySelector('#acw-display-name');
    nameInput.focus();

    function close() {
        document.body.removeChild(overlay);
    }

    function submit() {
        const displayName = nameInput.value.trim();
        if (!displayName) {
            nameInput.style.outline = '2px solid #f44336';
            nameInput.focus();
            return;
        }
        const filePath = modal.querySelector('#acw-file-path').value.trim();
        const code = modal.querySelector('#acw-code').value.trim();
        close();
        addConnectedWindow(sourceWindowId, displayName, code, filePath || undefined);
    }

    modal.querySelector('#acw-cancel').addEventListener('click', close);
    modal.querySelector('#acw-ok').addEventListener('click', submit);
    nameInput.addEventListener('input', () => { nameInput.style.outline = ''; });

    overlay.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); close(); }
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.stopPropagation(); submit(); }
    });
}

// Analyze next level for the selected window
function analyzeSelectedWindowNextLevel() {
    if (selectedWindows.size !== 1) {
        showToast('1つのウィンドウを選択してください', 'warning');
        return;
    }

    const windowId = Array.from(selectedWindows)[0];
    const windowData = currentData?.windows.find(w => w.id === windowId);
    
    if (!windowData) {
        showToast('ウィンドウが見つかりません', 'error');
        return;
    }

    // Check if it's an analyzable file
    const lang = detectLanguage(windowData.filePath);
    if (!windowData.filePath || !lang) {
        showToast('Java/JS/TSファイルのみ解析可能です', 'warning');
        return;
    }

    // Send message to VS Code extension
    vscode.postMessage({
        command: 'analyzeNextLevel',
        windowData: {
            id: windowData.id,
            displayName: windowData.displayName,
            filePath: windowData.filePath,
            code: windowData.code.map(line => line.content).join(String.fromCharCode(10)),
            startLine: windowData.code[0]?.line || windowData.startLine || 1
        }
    });
}

// Analyze incoming calls for the selected window
function analyzeSelectedWindowIncomingCalls() {
    if (selectedWindows.size !== 1) {
        showToast('1つのウィンドウを選択してください', 'warning');
        return;
    }

    const windowId = Array.from(selectedWindows)[0];
    const windowData = currentData?.windows.find(w => w.id === windowId);
    
    if (!windowData) {
        showToast('ウィンドウが見つかりません', 'error');
        return;
    }

    // Check if it's an analyzable file
    const lang = detectLanguage(windowData.filePath);
    if (!windowData.filePath || !lang) {
        showToast('Java/JS/TSファイルのみ解析可能です', 'warning');
        return;
    }
    if (lang === 'javascript') {
        showToast('JS/TSのIncoming Calls解析は将来対応予定です', 'info');
        return;
    }

    // Send message to VS Code extension
    vscode.postMessage({
        command: 'analyzeIncomingCalls',
        windowData: {
            id: windowData.id,
            displayName: windowData.displayName,
            filePath: windowData.filePath,
            code: windowData.code.map(line => line.content).join(String.fromCharCode(10)),
            startLine: windowData.code[0]?.line || windowData.startLine || 1
        }
    });
}

// Analyze incoming calls to root (recursive) for the selected window
function analyzeSelectedWindowToRoot() {
    if (selectedWindows.size !== 1) {
        showToast('1つのウィンドウを選択してください', 'warning');
        return;
    }

    const windowId = Array.from(selectedWindows)[0];
    const windowData = currentData?.windows.find(w => w.id === windowId);

    if (!windowData) {
        showToast('ウィンドウが見つかりません', 'error');
        return;
    }

    // Check if it's an analyzable file (Java only)
    const lang = detectLanguage(windowData.filePath);
    if (!windowData.filePath || lang !== 'java') {
        showToast('Javaファイルのみ解析可能です', 'warning');
        return;
    }

    // Send message to VS Code extension
    vscode.postMessage({
        command: 'analyzeToRoot',
        windowData: {
            id: windowData.id,
            displayName: windowData.displayName,
            filePath: windowData.filePath,
            code: windowData.code.map(line => line.content).join(String.fromCharCode(10)),
            startLine: windowData.code[0]?.line || windowData.startLine || 1
        }
    });
}

// Re-analyze the root method and refresh the viewer
function reanalyzeRoot() {
    // Change Set Canvas has no call-hierarchy root: regenerate it from metadata.changeSet instead
    if (isChangeSetCanvas(currentData)) {
        showToast('変更集合キャンバスはルート再解析の対象外です（変更集合から再生成してください）', 'warning');
        return;
    }
    vscode.postMessage({ command: 'reanalyzeRoot' });
}

// Reload viewer with entirely new data (reanalyzeRoot or disk reload from extension)
function reloadViewer(newData, reloadSource) {
    if (!newData || !newData.windows) return;

    // Clear search state before re-rendering to avoid stale matches
    searchQuery = '';
    searchMatches = [];
    currentMatchIndex = -1;
    searchBoxVisible = false;
    selectionHighlightQuery = '';
    const searchBox = document.getElementById('search-box');
    const searchInput = document.getElementById('search-input');
    if (searchBox) searchBox.classList.remove('visible');
    if (searchInput) searchInput.value = '';

    // Clear current state
    currentData = null;
    selectedWindows.clear();
    selectedConnections.clear();
    jumpHistory = [];

    const container = document.querySelector('.container');
    if (container) {
        container.innerHTML = '';
    }

    // Re-render with new data
    renderVisualization(newData);
    const toastMessage = reloadSource === 'disk' ? 'JSONを再読み込みしました' : '再解析完了';
    showToast(toastMessage, 'success', 2500);
}

// Merge callcanvas data from analysis result
function mergeCallCanvasData(newData, sourceWindowDisplayName, sourceWindowId) {
    if (!currentData || !newData || !newData.windows) return;

    const incomingMeta = newData.metadata;
    const currentMeta = currentData.metadata;
    const currentMetaEmpty = !currentMeta || typeof currentMeta !== 'object' || Array.isArray(currentMeta) || Object.keys(currentMeta).length === 0;
    if (
        currentMetaEmpty &&
        incomingMeta &&
        typeof incomingMeta === 'object' &&
        !Array.isArray(incomingMeta) &&
        Object.keys(incomingMeta).length > 0
    ) {
        // Adopt project context (rootDir/htmlPath/...) but never `analysis`: this
        // payload describes the sub-analysis of a child window, and recording it
        // would re-root the canvas there on the next ルート再解析.
        const { analysis, ...contextMeta } = incomingMeta;
        if (Object.keys(contextMeta).length > 0) {
            currentData.metadata = { ...contextMeta };
        }
    }

    // Adopt the result's constants before any window is (re)rendered below, so windows added by this
    // merge get constant-tokens too (resets _symbolKeys → wrapConstantTokens rebuilds its cache).
    const addedSymbols = mergeSymbolIndex(currentData, newData);
    // Same for declarations (symbols): windows added below render their refs as tokens right away
    const addedDeclarations = mergeSymbols(currentData, newData);

    const container = document.querySelector('.container');
    
    // Find the source window to position new windows relative to it.
    // Prefer stable window id (REPORT.md Case A: displayName alone can drift vs. CLI output).
    const sourceWindow =
        (sourceWindowId && currentData.windows.find(w => w.id === sourceWindowId)) ||
        currentData.windows.find(w => w.displayName === sourceWindowDisplayName);
    const baseLeft = sourceWindow ? sourceWindow.position.left + sourceWindow.position.width + 100 : 40;
    const baseTop = sourceWindow ? sourceWindow.position.top : 40;

    // Update highlight lines for source window from new data
    // The first window in newData is the root (source) with updated highlightLines
    if (sourceWindow && newData.windows.length > 0) {
        const newRootWindow = newData.windows[0];
        if (newRootWindow.highlightLines && newRootWindow.highlightLines.length > 0) {
            // Convert highlightLines to code line highlights
            const highlightSet = new Set(newRootWindow.highlightLines);
            sourceWindow.code.forEach(line => {
                if (highlightSet.has(line.line)) {
                    line.highlight = true;
                }
            });
            
            // Re-render the source window to show highlights
            const sourceElement = document.getElementById(sourceWindow.id);
            if (sourceElement) {
                const newElement = createWindow(sourceWindow);
                sourceElement.replaceWith(newElement);
            }
        }
    }

    // Track existing windows by filePath + startLine to avoid duplicates
    const existingKeys = new Set(
        currentData.windows.map(w => `${w.filePath}:${w.code[0]?.line || w.startLine}`)
    );

    // Add new windows (skip the first one which is the root/source)
    let addedCount = 0;
    let yOffset = 0;
    
    newData.windows.forEach((newWindow, index) => {
        // Skip the root window (index 0) as it's already displayed
        if (index === 0) {
            return;
        }
        
        const key = `${newWindow.filePath}:${newWindow.startLine}`;
        
        // Skip if already exists (but restore visibility if hidden)
        if (existingKeys.has(key)) {
            const existingWindow = currentData.windows.find(w => 
                `${w.filePath}:${w.code[0]?.line || w.startLine}` === key
            );
            if (existingWindow && existingWindow.visible === false) {
                existingWindow.visible = true;
                const el = document.getElementById(existingWindow.id);
                if (el) {
                    el.style.display = '';
                }
                addedCount++;
            }
            return;
        }

        // Normalize and position the new window
        const normalizedWindow = normalizeWindowData(newWindow);
        normalizedWindow.id = 'window-' + Date.now() + '-' + index;
        normalizedWindow.position = {
            top: baseTop + yOffset,
            left: baseLeft,
            width: normalizedWindow.position?.width || SETTINGS.windowWidth,
            height: normalizedWindow.position?.height || 320
        };
        
        // Change Set Canvas: windows found from a grouped window join its group (island)
        if (sourceWindow && typeof sourceWindow.group === 'string' && sourceWindow.group && !normalizedWindow.group) {
            normalizedWindow.group = sourceWindow.group;
        }

        // Mark as newly added (for F12 pending jump)
        normalizedWindow._newlyAdded = true;

        // Add to data
        currentData.windows.push(normalizedWindow);
        existingKeys.add(key);

        // Render the window
        const windowElement = createWindow(normalizedWindow);
        container.appendChild(windowElement);

        yOffset += (normalizedWindow.collapsed === true ? 53 : normalizedWindow.position.height + 20);
        addedCount++;
    });

    // Add connections from source window to new windows
    if (sourceWindow && newData.connections) {
        // Map old window IDs to new window IDs
        const idMapping = {};
        
        // Map the root window (index 0) to the source window
        if (newData.windows.length > 0) {
            idMapping[newData.windows[0].id] = sourceWindow.id;
        }
        
        // Map other windows
        newData.windows.forEach((newWindow, index) => {
            if (index === 0) return; // Already mapped
            const key = `${newWindow.filePath}:${newWindow.startLine}`;
            const existingWindow = currentData.windows.find(w => 
                `${w.filePath}:${w.code[0]?.line || w.startLine}` === key
            );
            if (existingWindow) {
                idMapping[newWindow.id] = existingWindow.id;
            }
        });

        // Add connections
        if (!currentData.connections) {
            currentData.connections = [];
        }

        newData.connections.forEach(conn => {
            const fromId = idMapping[conn.from] || conn.from;
            const toId = idMapping[conn.to] || conn.to;
            
            // Check if connection already exists.
            // Keep distinct edges when the same from/to pair is called at different lines.
            const exists = currentData.connections.some(
                c => c.from === fromId &&
                    c.to === toId &&
                    c.callLine === conn.callLine &&
                    ((c.callEndLine != null ? c.callEndLine : c.callLine) ===
                        (conn.callEndLine != null ? conn.callEndLine : conn.callLine))
            );

            const fromExists = currentData.windows.some(w => w.id === fromId);
            const toExists = currentData.windows.some(w => w.id === toId);
            
            if (!exists && fromExists && toExists) {
                currentData.connections.push({ 
                    from: fromId, 
                    to: toId,
                    callLine: conn.callLine,
                    callEndLine: conn.callEndLine
                });
            }
        });
    }

    // Windows already on the canvas (source / duplicates) adopt the result's refs
    const refsIdMapping = {};
    newData.windows.forEach((newWindow, index) => {
        if (index === 0) {
            if (sourceWindow) refsIdMapping[newWindow.id] = sourceWindow.id;
            return;
        }
        const key = `${newWindow.filePath}:${newWindow.startLine}`;
        const existingWindow = currentData.windows.find(w =>
            `${w.filePath}:${w.code[0]?.line || w.startLine}` === key
        );
        if (existingWindow) refsIdMapping[newWindow.id] = existingWindow.id;
    });
    const refsAdopted = adoptWindowRefs(currentData, newData, refsIdMapping);
    if (addedSymbols.length > 0 && addedCount === 0) {
        // No auto-layout re-render follows: refresh windows already on the canvas for the new constants
        rerenderCodeAreas(() => true);
    } else if (addedDeclarations.length > 0 || refsAdopted.length > 0) {
        rerenderCodeAreas(w => Array.isArray(w.refs) && w.refs.length > 0);
    }

    // Update arrows and container
    updateArrows();
    updateContainerSize();

    // Save data
    saveData();


    // Apply auto-layout after merge
    if (addedCount > 0) {
        const layoutData = applyAutoLayout(currentData);
        currentData.windows = layoutData.windows;

        // Re-render all windows with new positions
        const container = document.querySelector('.container');
        container.innerHTML = '';
        currentData.windows.forEach(w => {
            const windowElement = createWindow(w);
            container.appendChild(windowElement);
        });

        updateArrows();
        updateContainerSize();
        saveData();
        renderViewportWindows();
    }

    // Check for pending F12 jump after merge
    if (pendingF12Jump) {
        const { windowId, lineNumber, omitEndLine } = pendingF12Jump;
        pendingF12Jump = null;
        const newConnections = findConnectionsAtLine(windowId, lineNumber, omitEndLine);
        
        if (newConnections.length >= 1) {
            // F12ジャンプ先のwindow IDを特定
            const targetIds = new Set(newConnections.map(c => c.to));
            
            // analyzeNextLevelで新規追加されたウィンドウのうち、ジャンプ先以外をvisible:falseに
            currentData.windows.forEach(w => {
                if (w._newlyAdded && !targetIds.has(w.id)) {
                    w.visible = false;
                    const el = document.getElementById(w.id);
                    if (el) el.style.display = 'none';
                }
                delete w._newlyAdded;
            });
            
            updateArrows();
            // 可視ウィンドウのみ再レイアウトし、完了後にジャンプ実行
            resetLayout(() => {
                if (newConnections.length === 1) {
                    jumpToWindowWithOrigin(newConnections[0].to, windowId, lineNumber);
                } else {
                    // 複数候補の場合はポップアップ
                    const row = document.querySelector(
                        '.code-line-row[data-window-id="' + windowId + '"][data-line-number="' + lineNumber + '"]'
                    );
                    if (row) {
                        showJumpPopupMenu(row, newConnections);
                    }
                }
            });
        } else {
            // Clean up flags even if no connections found
            currentData.windows.forEach(w => {
                delete w._newlyAdded;
            });
            showToast('解析完了しましたが、この行にコール先が見つかりませんでした', 'info');
        }
    } else {
        // No F12 pending (e.g. root analysis / incoming calls) —
        // clean up _newlyAdded so a later F12 merge won't hide these windows.
        currentData.windows.forEach(w => {
            delete w._newlyAdded;
        });
    }
}

/** Re-render the already-rendered code areas of windows matching `predicate`. */
function rerenderCodeAreas(predicate) {
    if (!currentData) return;
    currentData.windows.forEach(w => {
        if (!predicate(w)) return;
        const el = document.getElementById(w.id);
        const ca = el && el.querySelector('.code-area');
        if (!ca || ca.dataset.rendered !== 'true') return;
        delete ca.dataset.hljsApplied;
        rerenderCodeArea(ca, w);
    });
}

/**
 * Ctrl/⌘+click or "Go to Declaration" on a symbol-ref token: open the declaration with the same
 * openFile message as the title-bar double-click (VS Code: editor, nvim bridge: side panel).
 * The canvas is not changed (nothing is added or saved). No-op in Export HTML (nowhere to open).
 */
function goToDeclaration(symbolKey) {
    if (IS_EXPORT_MODE || !currentData || !symbolKey) return;
    const message = buildOpenDeclarationMessage(currentData.symbols, symbolKey);
    if (!message) {
        showToast('宣言が見つかりません: ' + symbolKey, 'warning');
        return;
    }
    vscode.postMessage(message);
}

function buildSaveData() {
    if (!currentData) return null;
    const payload = {
        autoLayout: currentData.autoLayout || false,
        windows: currentData.windows.map(w => {
            // Use original (pre-diff) code when diff overlay is active
            const sourceCode = (w._originalCode || w.code).filter(line => !line.diffType);
            const lineComments = sourceCode.filter(l => l.comment).reduce((acc, l) => ({ ...acc, [String(l.line)]: l.comment }), {});

            // Collect diff comments (comments on added/removed lines)
            let diffState = undefined;
            if (w._hasDiffOverlay && w._diffHunks) {
                const diffComments = {};
                for (const line of w.code) {
                    if (line.diffType && line.comment) {
                        diffComments[`${line.diffType}:${line.line}`] = line.comment;
                    }
                }
                diffState = {
                    hunks: w._diffHunks,
                    ...(Object.keys(diffComments).length ? { diffComments } : {})
                };
            }

            // Persist saved diff comments even when diff is cleared
            const savedDiffComments = w._savedDiffComments && Object.keys(w._savedDiffComments).length
                ? w._savedDiffComments : undefined;

            // diffState from the JSON that no overlay consumed (no hunk in the window's range / not
            // restored yet): keep it as is, Change Set Canvas windows are generated with it
            if (!diffState && !w._hasDiffOverlay && w.diffState && Array.isArray(w.diffState.hunks)) {
                diffState = w.diffState;
            }

            return {
                highlightLines: sourceCode.filter(line => line.highlight).map(line => line.line),
                code: sourceCode.map(line => line.content).join(String.fromCharCode(10)),
                displayName: w.displayName,
                filePath: w.filePath,
                startLine: sourceCode[0]?.line || w.startLine || 1,
                id: w.id,
                position: w.position,
                collapsed: w.collapsed === true,
                visible: w.visible !== false,
                fullHeight: w.fullHeight === true,
                // Change Set Canvas
                ...(typeof w.group === 'string' && w.group ? { group: w.group } : {}),
                ...(typeof w.windowType === 'string' && w.windowType ? { windowType: w.windowType } : {}),
                ...(w.change && typeof w.change === 'object' ? { change: w.change } : {}),
                ...(Array.isArray(w.refs) && w.refs.length ? { refs: w.refs } : {}),
                ...(Object.keys(lineComments).length ? { lineComments } : {}),
                ...(diffState ? { diffState } : {}),
                ...(savedDiffComments ? { savedDiffComments } : {})
            };
        }),
        connections: currentData.connections || []
    };
    // symbolIndex drives constant-token rendering; without it the tokens vanish after the first save
    // and in Export HTML (both rebuild the canvas from this payload). _symbolKeys is derived, not saved.
    if (currentData.symbolIndex && typeof currentData.symbolIndex === 'object' && Object.keys(currentData.symbolIndex).length > 0) {
        payload.symbolIndex = currentData.symbolIndex;
    }
    // symbols: declarations the windows' refs point at (Ctrl/⌘+click → openFile, constant tooltips)
    if (currentData.symbols && typeof currentData.symbols === 'object' && Object.keys(currentData.symbols).length > 0) {
        payload.symbols = currentData.symbols;
    }
    // Change Set Canvas blocks / islands (windows[].group refers to them)
    if (hasCanvasGroups(currentData)) {
        payload.groups = currentData.groups;
    }
    const meta = currentData.metadata;
    if (meta && typeof meta === 'object' && !Array.isArray(meta) && Object.keys(meta).length > 0) {
        payload.metadata = meta;
    }
    return payload;
}

function saveData() {
    if (IS_EXPORT_MODE) return;
    if (!currentData) return;

    const dataToSave = buildSaveData();
    vscode.postMessage({
        command: 'saveData',
        data: dataToSave
    });
}

function resetLayout(afterRelayout) {
    if (!currentData) return;
    
    // Layout only visible windows
    const visibleWindows = currentData.windows.filter(w => w.visible !== false);
    const visibleIds = new Set(visibleWindows.map(w => w.id));
    const visibleConnections = (currentData.connections || []).filter(
        c => visibleIds.has(c.from) && visibleIds.has(c.to)
    );
    
    // Apply auto-layout to visible windows only
    const layoutData = applyAutoLayout({
        windows: visibleWindows,
        connections: visibleConnections,
        autoLayout: true,
        ...(hasCanvasGroups(currentData) ? { groups: currentData.groups } : {})
    });

    // Update positions of visible windows in original data
    layoutData.windows.forEach(layoutWindow => {
        const originalWindow = currentData.windows.find(w => w.id === layoutWindow.id);
        if (originalWindow) {
            originalWindow.position = layoutWindow.position;
        }
    });
    
    // Re-render all windows with new positions
    const container = document.querySelector('.container');
    container.innerHTML = '';
    currentData.windows.forEach(w => {
        const windowElement = createWindow(w);
        container.appendChild(windowElement);
    });
    
    // Use requestAnimationFrame to ensure DOM is fully updated before relayout
    requestAnimationFrame(() => {
        // Use relayoutWindows to optimize Y positions based on parent-child relationships
        relayoutWindows();
        
        // Save data
        saveData();
        if (typeof afterRelayout === 'function') afterRelayout();
    });
}

function showWidthChangeDialog() {
    if (!currentData || !currentData.windows || currentData.windows.length === 0) {
        return;
    }
    
    // 現在の幅を取得（最初のウィンドウの幅をデフォルト）
    const currentWidth = currentData.windows[0]?.position?.width || SETTINGS.windowWidth;
    
    // VS Code APIでダイアログを表示するようメッセージを送る
    vscode.postMessage({
        command: 'showWidthInputDialog',
        currentWidth: currentWidth
    });
}

function applyWidthToAllWindows(newWidth) {
    currentData.windows.forEach(w => {
        w.position.width = newWidth;
    });
    resetLayout();
}

// Helper function to create dropdown menu
function createDropdownMenu(label, items) {
    const dropdown = document.createElement('div');
    dropdown.className = 'toolbar-dropdown';
    
    const button = document.createElement('button');
    button.className = 'toolbar-dropdown-button';
    button.textContent = label;
    
    const menu = document.createElement('div');
    menu.className = 'toolbar-dropdown-menu';
    
    const menuInner = document.createElement('div');
    menuInner.className = 'toolbar-dropdown-menu-inner';
    
    items.forEach(item => {
        if (item.separator) {
            const separator = document.createElement('div');
            separator.className = 'toolbar-dropdown-separator';
            menuInner.appendChild(separator);
        } else {
            const menuItem = document.createElement('button');
            menuItem.className = 'toolbar-dropdown-item';
            if (item.className) {
                menuItem.className += ' ' + item.className;
            }
            menuItem.textContent = item.label;
            menuItem.title = item.title || '';
            if (item.id) {
                menuItem.id = item.id;
            }
            if (item.disabled) {
                menuItem.disabled = true;
            }
            if (item.onClick) {
                menuItem.addEventListener('click', function() {
                    item.onClick();
                    // Close menu after click by adding closed class
                    dropdown.classList.add('closed');
                });
            }
            menuInner.appendChild(menuItem);
        }
    });
    
    // Remove closed class when mouse leaves to allow hover again
    dropdown.addEventListener('mouseleave', function() {
        dropdown.classList.remove('closed');
    });
    
    menu.appendChild(menuInner);
    dropdown.appendChild(button);
    dropdown.appendChild(menu);
    return dropdown;
}

function initializeConnectionMode() {
    // Create toolbar container
    const toolbar = document.createElement('div');
    toolbar.className = 'toolbar';

    // Add connection mode toggle button to the page
    const toggleButton = document.createElement('button');
    toggleButton.id = 'connection-mode-toggle';
    toggleButton.className = 'toolbar-button';
    toggleButton.textContent = '接続モード: OFF';
    toggleButton.title = '接続モードを有効にして、ウィンドウ間の接続を追加';
    
    toggleButton.addEventListener('click', function() {
        connectionMode = !connectionMode;
        toggleButton.textContent = connectionMode ? '接続モード: ON' : '接続モード: OFF';
        toggleButton.classList.toggle('active', connectionMode);
        
        if (!connectionMode) {
            // Clear selection when turning off
            clearConnectionSource();
        }
    });

    // Add collapse all button
    const collapseAllButton = document.createElement('button');
    collapseAllButton.className = 'toolbar-button';
    collapseAllButton.textContent = '▶▶ 全て折りたたみ';
    collapseAllButton.title = '全てのウィンドウを折りたたむ';
    collapseAllButton.addEventListener('click', function() {
        collapseAll();
    });

    // Add expand all button
    const expandAllButton = document.createElement('button');
    expandAllButton.className = 'toolbar-button';
    expandAllButton.textContent = '▼▼ 全て展開';
    expandAllButton.title = '全てのウィンドウを展開する';
    expandAllButton.addEventListener('click', function() {
        expandAll();
    });

    // Add expand highlighted only button
    const expandHighlightedButton = document.createElement('button');
    expandHighlightedButton.id = 'expand-highlighted-button';
    expandHighlightedButton.className = 'toolbar-button';
    expandHighlightedButton.textContent = '🔍 ハイライト展開';
    expandHighlightedButton.title = 'ハイライトのあるウィンドウのみを展開';
    expandHighlightedButton.addEventListener('click', function() {
        expandHighlightedOnly();
    });

    // Add full height toggle button (sync initial state with data so first click behaves correctly)
    const fullHeightButton = document.createElement('button');
    fullHeightButton.id = 'full-height-toggle';
    fullHeightButton.className = 'toolbar-button';
    fullHeightButton.title = '全てのウィンドウをコード全行分の高さに切り替え';
    if (currentData && currentData.windows.length > 0) {
        const target = currentData.windows.filter(w => w.visible !== false && w.collapsed !== true);
        const allFullHeight = target.length > 0 && target.every(w => w.fullHeight === true);
        if (allFullHeight) {
            fullHeightButton.textContent = '↕ 通常表示';
            fullHeightButton.classList.add('active');
        } else {
            fullHeightButton.textContent = '↕ 全行表示';
        }
    } else {
        fullHeightButton.textContent = '↕ 全行表示';
    }
    fullHeightButton.addEventListener('click', function() {
        toggleAllFullHeight();
    });

    // Add delete selected button
    const deleteSelectedButton = document.createElement('button');
    deleteSelectedButton.id = 'delete-selected-button';
    deleteSelectedButton.className = 'toolbar-button';
    deleteSelectedButton.textContent = '🗑 選択削除';
    deleteSelectedButton.title = '選択したウィンドウを削除 (Delete)';
    deleteSelectedButton.disabled = true;
    deleteSelectedButton.addEventListener('click', function() {
        deleteSelectedWindows();
    });

    // Add analyze next level button
    const analyzeButton = document.createElement('button');
    analyzeButton.id = 'analyze-next-level-button';
    analyzeButton.className = 'toolbar-button analyze-button';
    analyzeButton.textContent = '🔍 次の階層を解析';
    analyzeButton.title = '選択したウィンドウのメソッドから次の呼び出し階層を解析';
    analyzeButton.disabled = true;
    analyzeButton.addEventListener('click', function() {
        analyzeSelectedWindowNextLevel();
    });

    // Add analyze incoming calls button
    const analyzeIncomingButton = document.createElement('button');
    analyzeIncomingButton.id = 'analyze-incoming-button';
    analyzeIncomingButton.className = 'toolbar-button analyze-button';
    analyzeIncomingButton.textContent = '🔍 呼び出し元を解析';
    analyzeIncomingButton.title = '選択したウィンドウのメソッドを呼び出しているメソッドを解析';
    analyzeIncomingButton.disabled = true;
    analyzeIncomingButton.addEventListener('click', function() {
        analyzeSelectedWindowIncomingCalls();
    });

    // Add reset layout button
    const resetLayoutButton = document.createElement('button');
    resetLayoutButton.id = 'reset-layout-button';
    resetLayoutButton.className = 'toolbar-button';
    resetLayoutButton.textContent = '🔄 ウィンドウ整列';
    resetLayoutButton.title = '表示中のウィンドウを整列する';
    resetLayoutButton.addEventListener('click', function() {
        resetLayout();
    });

    // Add change width button
    const changeWidthButton = document.createElement('button');
    changeWidthButton.id = 'change-width-button';
    changeWidthButton.className = 'toolbar-button';
    changeWidthButton.textContent = '📐 幅変更';
    changeWidthButton.title = 'すべてのウィンドウの幅を一括変更';
    changeWidthButton.addEventListener('click', function() {
        showWidthChangeDialog();
    });

    // Add commit highlight button
    const commitHighlightButton = document.createElement('button');
    commitHighlightButton.id = 'commit-highlight-button';
    commitHighlightButton.className = 'toolbar-button';
    commitHighlightButton.textContent = '📝 コミット変更';
    commitHighlightButton.title = 'コミットで変更された行をハイライト';
    commitHighlightButton.addEventListener('click', function() {
        showCommitHighlightDialog();
    });

    // Add workbench (uncommitted) highlight button
    const workbenchHighlightButton = document.createElement('button');
    workbenchHighlightButton.id = 'workbench-highlight-button';
    workbenchHighlightButton.className = 'toolbar-button';
    workbenchHighlightButton.textContent = '📄 ワークベンチ';
    workbenchHighlightButton.title = '未コミットの変更（ワークベンチ）で変更された行をハイライト';
    workbenchHighlightButton.addEventListener('click', function() {
        showWorkbenchHighlight();
    });

    // Add clear diff button (hidden by default, shown when diff overlay is active)
    const clearDiffButton = document.createElement('button');
    clearDiffButton.id = 'clear-diff-button';
    clearDiffButton.className = 'toolbar-button';
    clearDiffButton.textContent = '✕ 差分クリア';
    clearDiffButton.title = '差分表示をクリアして元の表示に戻す';
    clearDiffButton.style.display = 'none';
    clearDiffButton.addEventListener('click', function() {
        clearDiffOverlay();
    });

    // Add focus display button
    const focusDisplayButton = document.createElement('button');
    focusDisplayButton.id = 'focus-display-button';
    focusDisplayButton.className = 'toolbar-button';
    focusDisplayButton.textContent = '🎯 ハイライト経路のみ';
    focusDisplayButton.title = 'ハイライト行を持つウィンドウへの経路のみ表示';
    focusDisplayButton.addEventListener('click', function() {
        applyFocusFilter();
    });

    // Add show all button
    const showAllButton = document.createElement('button');
    showAllButton.id = 'show-all-button';
    showAllButton.className = 'toolbar-button';
    showAllButton.textContent = '⇄ すべて表示';
    showAllButton.title = 'フィルターを解除してすべてのウィンドウを表示';
    showAllButton.addEventListener('click', function() {
        showAllWindows();
    });

    // Create selection hint (inline with toolbar)
    const selectionHint = document.createElement('span');
    selectionHint.id = 'selection-hint';
    selectionHint.className = 'selection-hint';
    selectionHint.style.display = 'none';

    // Create dropdown menus
    const displayMenu = createDropdownMenu('表示', [
        { label: '▶▶ 全て折りたたみ', title: '全てのウィンドウを折りたたむ', onClick: () => collapseAll() },
        { label: '▼▼ 全て展開', title: '全てのウィンドウを展開する', onClick: () => expandAll() },
        { label: '🔍 ハイライト展開', title: 'ハイライトのあるウィンドウのみを展開', onClick: () => expandHighlightedOnly() },
        { label: '↕ 全行表示', title: '全てのウィンドウをコード全行分の高さに切り替え', onClick: () => toggleAllFullHeight() },
        { separator: true },
        { label: '🎯 ハイライト経路のみ', title: 'ハイライト行を持つウィンドウへの経路のみ表示', onClick: () => applyFocusFilter() },
        { label: '🔀 差分経路のみ', title: '差分変更箇所への経路のみ表示（差分表示が必要）', onClick: () => applyDiffPathFilter() },
        { label: '⇄ すべて表示', title: 'フィルターを解除してすべてのウィンドウを表示', onClick: () => showAllWindows() }
    ]);

    const analyzeMenu = createDropdownMenu('解析', [
        { id: 'analyze-next-level-button', label: '🔍 次の階層を解析', title: '選択したウィンドウのメソッドから次の呼び出し階層を解析', onClick: () => analyzeSelectedWindowNextLevel(), disabled: true, className: 'analyze-button' },
        { id: 'analyze-incoming-button', label: '🔍 呼び出し元を解析', title: '選択したウィンドウのメソッドを呼び出しているメソッドを解析', onClick: () => analyzeSelectedWindowIncomingCalls(), disabled: true, className: 'analyze-button' },
        { id: 'analyze-to-root-button', label: '🔍 ルートまで解析', title: '選択したメソッドの呼び出し元をルートメソッドまで再帰的に解析', onClick: () => analyzeSelectedWindowToRoot(), disabled: true, className: 'analyze-button' },
        { separator: true },
        { label: '🔄 ルート再解析', title: 'ルートメソッドを再解析してビューアを更新', onClick: () => reanalyzeRoot() },
        { separator: true },
        { label: '📝 コミット変更 (差分表示)', title: 'コミットの変更を before/after 形式で表示', onClick: () => showCommitHighlightDialog() },
        { label: '📄 ワークベンチの変更 (差分表示)', title: '未コミットの変更を before/after 形式で表示', onClick: () => showWorkbenchHighlight() },
        { label: '✕ 差分クリア', title: '差分表示をクリアして元の表示に戻す', id: 'clear-diff-menu-item', onClick: () => clearDiffOverlay() },
        { separator: true },
        { label: '📊 カバレッジ読込', title: 'JaCoCo XML レポートを読み込んでカバレッジをハイライト表示', onClick: () => vscode.postMessage({ command: 'loadCoverageReport' }) },
        { label: '✕ カバレッジクリア', title: 'カバレッジハイライトをクリア', onClick: () => clearCoverageOverlay() }
    ]);

    const layoutMenu = createDropdownMenu('レイアウト', [
        { label: '🔄 ウィンドウ整列', title: '表示中のウィンドウを整列する', onClick: () => resetLayout() },
        { label: '📐 幅変更', title: 'すべてのウィンドウの幅を一括変更', onClick: () => showWidthChangeDialog() }
    ]);

    const editMenu = createDropdownMenu('編集', [
        { label: '📄 JSONファイルを開く', title: '現在のCallCanvas JSONをエディタで開く', onClick: () => {
            vscode.postMessage({ command: 'openJsonFile' });
        }},
        { separator: true },
        { label: toggleButton.textContent, title: '接続モードを有効にして、ウィンドウ間の接続を追加', onClick: () => {
            connectionMode = !connectionMode;
            const btn = editMenu.querySelector('.toolbar-dropdown-item');
            if (btn) {
                btn.textContent = connectionMode ? '接続モード: ON' : '接続モード: OFF';
            }
            toggleButton.textContent = connectionMode ? '接続モード: ON' : '接続モード: OFF';
            toggleButton.classList.toggle('active', connectionMode);
            if (!connectionMode) {
                clearConnectionSource();
            }
        }},
        { id: 'add-connected-window-menu-item', label: '+ 接続済みWindowを追加', title: '選択中のWindowの右隣に接続済み新規Windowを追加', disabled: true, onClick: () => {
            if (selectedWindows.size === 1) {
                showAddConnectedWindowModal([...selectedWindows][0]);
            }
        }},
        { id: 'delete-selected-button', label: '🗑 選択削除', title: '選択したウィンドウを削除 (Delete)', onClick: () => deleteSelectedWindows(), disabled: true },
        { separator: true },
        { label: '📤 HTMLにエクスポート', title: '現在の表示をHTMLファイルとして保存', onClick: () => {
            const exportData = buildSaveData();
            if (exportData) {
                vscode.postMessage({ command: 'exportHtml', data: exportData });
            }
        }},
        { separator: true },
        { label: '📋 JSONパスをコピー', title: 'JSONファイルパスをコピー（AIへの文脈伝達用）', onClick: async () => {
            const path = window.CALLCANVAS_CONFIG.jsonFilePath;
            if (!path) return;
            await navigator.clipboard.writeText(path);
        }}
    ]);
    editMenu.classList.add('rightmost-menu');

    toolbar.appendChild(displayMenu);
    if (!IS_EXPORT_MODE) {
        toolbar.appendChild(analyzeMenu);
        toolbar.appendChild(layoutMenu);
        toolbar.appendChild(editMenu);
        toolbar.appendChild(clearDiffButton);
    }
    toolbar.appendChild(selectionHint);
    document.body.insertBefore(toolbar, document.body.firstChild);

    // Breadcrumb bar（選択ウィンドウのパスを上部に表示）
    const breadcrumbBarEl = document.createElement('div');
    breadcrumbBarEl.id = 'breadcrumb-bar';
    breadcrumbBarEl.className = 'breadcrumb-bar';
    document.body.insertBefore(breadcrumbBarEl, document.body.firstChild);

    // Initialize drag selection (not needed in export mode)
    if (!IS_EXPORT_MODE) {
        initializeDragSelection();
    }

    // Create search box
    createSearchBox();

    if (!IS_EXPORT_MODE) {
        initializeSelectionHighlightListener();
    }

    // Keyboard shortcuts
    document.addEventListener('keydown', function(e) {
        // Ctrl+F (Cmd+F on Mac) to open search box
        if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
            // Don't open if focus is in an input
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
            e.preventDefault();
            showSearchBox();
        }
        
        // ESC key to cancel connection selection, clear selection, or close search box
        if (e.key === 'Escape') {
            if (searchBoxVisible) {
                hideSearchBox();
            } else if (connectionMode) {
                clearConnectionSource();
            } else {
                clearSelection();
            }
        }
        
        // Delete or Backspace to delete selected windows and connections
        if ((e.key === 'Delete' || e.key === 'Backspace') && (selectedWindows.size > 0 || selectedConnections.size > 0)) {
            // Don't delete if focus is in an input
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
            e.preventDefault();
            if (selectedWindows.size > 0) {
                deleteSelectedWindows();
            }
            if (selectedConnections.size > 0) {
                deleteSelectedConnections();
            }
        }

        // Ctrl+A to select all
        if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
            // Don't select all if focus is in an input
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
            e.preventDefault();
            selectAll();
        }

        // Arrow keys to navigate between code lines
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            const focusedRow = document.activeElement;
            if (focusedRow && focusedRow.classList.contains('code-line-row')) {
                e.preventDefault();
                const allRows = Array.from(focusedRow.closest('.code-area').querySelectorAll('.code-line-row'));
                const currentIndex = allRows.indexOf(focusedRow);
                let nextIndex;
                if (e.key === 'ArrowUp') {
                    nextIndex = Math.max(0, currentIndex - 1);
                } else {
                    nextIndex = Math.min(allRows.length - 1, currentIndex + 1);
                }
                if (nextIndex !== currentIndex) {
                    allRows[nextIndex].focus();
                    // 親ウィンドウを自動選択（スクロールロック解除のため）
                    const windowDiv = focusedRow.closest('.code-window');
                    if (windowDiv) {
                        const windowId = windowDiv.getAttribute('data-window-id');
                        if (windowId && !windowDiv.classList.contains('selected')) {
                            selectWindow(windowId, false, true); // キーボード操作由来: 行フォーカスを維持
                        }
                    }
                }
            }
        }

        // Jump to call target (key configurable via callcanvas.jumpToCallTargetKey)
        if (toKeyBindingString(e) === SETTINGS.jumpToCallTargetKey) {
            const focusedRow = document.activeElement;
            if (focusedRow && focusedRow.classList.contains('code-line-row')) {
                e.preventDefault();
                handleF12Jump(focusedRow);
            }
        }
    });
}

function clearConnectionSource() {
    if (connectionSource) {
        const sourceElement = document.getElementById(connectionSource);
        if (sourceElement) {
            sourceElement.classList.remove('connection-source');
        }
    }
    connectionSource = null;
}

function handleWindowClickForConnection(windowId) {
    if (!connectionMode) return false;

    if (!connectionSource) {
        // Select as source
        connectionSource = windowId;
        const sourceElement = document.getElementById(windowId);
        if (sourceElement) {
            sourceElement.classList.add('connection-source');
        }
    } else if (connectionSource === windowId) {
        // Clicking same window - deselect
        clearConnectionSource();
    } else {
        // Create connection
        addConnection(connectionSource, windowId);
        clearConnectionSource();
    }

    return true;
}

function addConnection(fromId, toId) {
    if (!currentData) return;

    // Initialize connections array if not exists
    if (!currentData.connections) {
        currentData.connections = [];
    }

    // Check if connection already exists
    const exists = currentData.connections.some(
        conn => conn.from === fromId && conn.to === toId
    );

    if (exists) {
        showToast('この接続は既に存在します', 'warning');
        return;
    }

    // Add connection
    currentData.connections.push({ from: fromId, to: toId });

    // Update arrows
    updateArrows();

    // Save data
    saveData();
}

function deleteConnection(fromId, toId) {
    if (!currentData || !currentData.connections) return;

    // Remove the connection
    currentData.connections = currentData.connections.filter(
        conn => !(conn.from === fromId && conn.to === toId)
    );

    // Update arrows
    updateArrows();

    // Save data
    saveData();
}

function renderVisualization(data) {
    const container = document.querySelector('.container');
    container.innerHTML = ''; // Clear existing content

    // Apply auto-layout if needed
    const layoutData = applyAutoLayout(data);

    // Normalize window data (convert simple format to detailed format)
    const normalizedData = {
        ...layoutData,
        metadata: layoutData.metadata || null,
        windows: layoutData.windows.map(w => normalizeWindowData(w))
    };

    // Store data globally
    currentData = normalizedData;
    currentData._symbolKeys = currentData.symbolIndex
        ? Object.keys(currentData.symbolIndex).sort((a, b) => b.length - a.length)
        : [];

    // Render windows via DocumentFragment (single DOM insertion)
    const windowFragment = document.createDocumentFragment();
    normalizedData.windows.forEach(window => {
        windowFragment.appendChild(createWindow(window));
    });
    container.appendChild(windowFragment);

    // relayoutWindows → updateArrows → renderArrows の順で矢印も描画される
    relayoutWindows();

    // Update container size to fit all windows
    updateContainerSize();
    renderViewportWindows(); // populate any windows newly in viewport after relayout
    updateArrowVisibility(); // ビューポート外矢印を非表示化

    // Restore diff overlay from saved diffState
    restoreDiffStates();

    // Change Set Canvas: the diff overlay grew the windows after the layout — restack the groups
    if (hasCanvasGroups(currentData)) {
        relayoutWindows();
    }
}

function updateArrows() {
    if (!currentData) return;

    const container = document.querySelector('.container');

    // Remove existing arrows
    container.querySelectorAll('.arrow').forEach(arrow => arrow.remove());

    // Re-render arrows with current window positions (without animation)
    renderArrows(currentData, container, true);

    // Change Set Canvas: group frames follow the windows (drag / collapse / relayout)
    renderGroupFrames();

    // Re-apply path highlight after arrows are re-rendered
    updatePathHighlight();

    syncViewerCallTargetMarkers();

    // ビューポート外の矢印を隠して描画コストを削減
    scheduleViewportCheck();
}

function deleteWindow(windowId) {
    if (!currentData) return;

    // Cascade delete: children whose parents are all deleted go too
    const deletion = computeWindowDeletion(currentData.connections, [windowId]);
    const windowsToDelete = new Set(deletion.deleteIds);

    windowsToDelete.forEach(id => {
        const windowElement = document.getElementById(id);
        if (windowElement) {
            windowElement.remove();
        }
    });

    currentData.windows = currentData.windows.filter(w => !windowsToDelete.has(w.id));
    if (currentData.connections) {
        currentData.connections = deletion.connections;
    }

    // Adjust positions in all columns (close gaps left by deleted windows)
    adjustColumnOverlaps();

    // Update arrows after positions are adjusted
    updateArrows();

    // Update container size
    updateContainerSize();

    // Save data
    saveData();
}

function toggleCollapse(windowId) {
    if (!currentData) return;

    // Find window data
    const windowData = currentData.windows.find(w => w.id === windowId);
    if (!windowData) return;

    // Toggle collapsed state
    windowData.collapsed = !windowData.collapsed;

    // Update DOM
    const windowElement = document.getElementById(windowId);
    if (windowElement) {
        windowElement.classList.toggle('collapsed', windowData.collapsed);
        
        // Update collapse button icon
        const collapseButton = windowElement.querySelector('.collapse-button');
        if (collapseButton) {
            collapseButton.textContent = windowData.collapsed ? '▶' : '▼';
        }
    }

    // Adjust overlaps only for the changed window's column
    adjustColumnOverlaps(windowId);

    // Update arrows (collapsed windows have different height)
    updateArrows();

    // Save data
    saveData();
}

function toggleFullHeight(windowId) {
    if (!currentData) return;

    // Find window data
    const windowData = currentData.windows.find(w => w.id === windowId);
    if (!windowData) return;

    // Toggle fullHeight state
    windowData.fullHeight = !windowData.fullHeight;

    // Calculate new height (full height uses actual comment bubble px to avoid excess bottom margin)
    const newHeight = windowData.fullHeight
        ? calcFullHeightWindowHeight(windowData)
        : calcWindowHeight(getLineCount(windowData), true);  // Normal height (with max limit)

    // Update position data
    windowData.position.height = newHeight;

    // Update DOM
    const windowElement = document.getElementById(windowId);
    if (windowElement) {
        windowElement.style.height = newHeight + 'px';
        windowElement.classList.toggle('full-height', windowData.fullHeight);

        // Update full height button state
        const fullHeightButton = windowElement.querySelector('.full-height-button');
        if (fullHeightButton) {
            fullHeightButton.classList.toggle('active', windowData.fullHeight);
        }
    }

    // Update arrows (window height changed)
    updateArrows();

    // Relayout windows to adjust positions
    relayoutWindows();

    // Save data
    saveData();
}

// Toggle line highlight (add/remove from highlightLines)
function toggleLineHighlight(windowId, lineNumber) {
    if (!currentData) return;
    
    // Find window data
    const windowData = currentData.windows.find(w => w.id === windowId);
    if (!windowData) return;
    
    // Find line data
    const lineData = windowData.code.find(line => line.line === lineNumber);
    if (!lineData) return;
    
    // Toggle highlight
    lineData.highlight = !lineData.highlight;
    
    // Update DOM
    const windowElement = document.getElementById(windowId);
    if (windowElement) {
        const lineRow = windowElement.querySelector(`.code-line-row[data-line-number="${lineNumber}"]`);
        if (lineRow) {
            const codeLine = lineRow.querySelector('.code-line');
            if (codeLine) {
                if (lineData.highlight) {
                    codeLine.classList.add('highlighted');
                } else {
                    codeLine.classList.remove('highlighted');
                }
            }
        }
    }
    
    // Save data
    saveData();
}

// Lightweight function to adjust overlaps without reordering windows
// If changedWindowId is provided, only affects the column containing that window
// If not provided, adjusts all columns (for collapseAll/expandAll)
function adjustColumnOverlaps(changedWindowId) {
    if (!currentData || currentData.windows.length === 0) return;

    // Change Set Canvas: columns span several groups — restack the groups instead
    if (hasCanvasGroups(currentData)) {
        relayoutWindows();
        return;
    }

    const COLLAPSED_HEIGHT = 33;
    const WINDOW_SPACING = 20;
    const COLUMN_TOLERANCE = 50;

    const getWindowHeight = (window) => {
        if (window.collapsed === true) return COLLAPSED_HEIGHT;
        if (window.fullHeight === true) return calcFullHeightWindowHeight(window);
        return window.position?.height || SETTINGS.minWindowHeight;
    };

    if (changedWindowId) {
        // Single window changed - only adjust its column
        const changedWindow = currentData.windows.find(w => w.id === changedWindowId);
        if (!changedWindow) return;
        
        const changedWindowLeft = changedWindow.position.left || 0;

        // Find all windows in the same column
        const windowsInColumn = currentData.windows.filter(window => {
            const left = window.position.left || 0;
            return Math.abs(left - changedWindowLeft) < COLUMN_TOLERANCE;
        });

        // Sort by current top position to preserve existing order
        windowsInColumn.sort((a, b) => (a.position.top || 0) - (b.position.top || 0));

        // Find the index of the changed window in the sorted list
        const changedIndex = windowsInColumn.findIndex(w => w.id === changedWindowId);
        
        // Only adjust windows from the changed window onwards
        let currentY = changedWindow.position.top + getWindowHeight(changedWindow) + WINDOW_SPACING;
        
        for (let i = changedIndex + 1; i < windowsInColumn.length; i++) {
            const window = windowsInColumn[i];
            const newTop = currentY;
            
            if (newTop !== window.position.top) {
                window.position.top = newTop;
                const element = document.getElementById(window.id);
                if (element) {
                    element.style.top = newTop + 'px';
                }
            }

            const actualHeight = getWindowHeight(window);
            currentY = newTop + actualHeight + WINDOW_SPACING;
        }
    } else {
        // All windows changed (collapseAll/expandAll) - adjust all columns
        const columns = new Map();
        currentData.windows.forEach(window => {
            const left = window.position.left || 0;
            let foundColumn = null;
            for (const [colX, windows] of columns) {
                if (Math.abs(left - colX) < COLUMN_TOLERANCE) {
                    foundColumn = colX;
                    break;
                }
            }
            if (foundColumn !== null) {
                columns.get(foundColumn).push(window);
            } else {
                columns.set(left, [window]);
            }
        });

        columns.forEach((windowsInColumn) => {
            windowsInColumn.sort((a, b) => (a.position.top || 0) - (b.position.top || 0));

            let currentY = windowsInColumn[0]?.position.top || 40;
            
            windowsInColumn.forEach((window, index) => {
                if (index === 0) {
                    currentY = (window.position.top || 40) + getWindowHeight(window) + WINDOW_SPACING;
                } else {
                    const newTop = currentY;
                    
                    if (newTop !== window.position.top) {
                        window.position.top = newTop;
                        const element = document.getElementById(window.id);
                        if (element) {
                            element.style.top = newTop + 'px';
                        }
                    }

                    const actualHeight = getWindowHeight(window);
                    currentY = newTop + actualHeight + WINDOW_SPACING;
                }
            });
        });
    }

    updateContainerSize(false);
}

/**
 * Collapse all windows
 */
function collapseAll() {
    if (!currentData) return;

    currentData.windows.forEach(windowData => {
        windowData.collapsed = true;

        // Update DOM
        const windowElement = document.getElementById(windowData.id);
        if (windowElement) {
            windowElement.classList.add('collapsed');
            
            // Update collapse button icon
            const collapseButton = windowElement.querySelector('.collapse-button');
            if (collapseButton) {
                collapseButton.textContent = '▶';
            }
        }
    });

    // Use requestAnimationFrame to ensure DOM is fully updated before adjusting positions
    requestAnimationFrame(() => {
        // Use relayoutWindows to respect parent-child relationships
        relayoutWindows();

        // Save data
        saveData();
    });
}

/**
 * Expand all windows
 */
function expandAll() {
    if (!currentData) return;

    currentData.windows.forEach(windowData => {
        windowData.collapsed = false;

        // Update DOM
        const windowElement = document.getElementById(windowData.id);
        if (windowElement) {
            windowElement.classList.remove('collapsed');
            
            // Update collapse button icon
            const collapseButton = windowElement.querySelector('.collapse-button');
            if (collapseButton) {
                collapseButton.textContent = '▼';
            }
        }
    });

    // Use requestAnimationFrame to ensure DOM is fully updated before adjusting positions
    requestAnimationFrame(() => {
        // Use relayoutWindows to respect parent-child relationships
        relayoutWindows();

        // Save data
        saveData();
    });
}

/**
 * Toggle all windows between full height and normal height
 */
function toggleAllFullHeight() {
    if (!currentData) return;

    // Determine target windows: visible and not collapsed
    const targetWindows = currentData.windows.filter(w =>
        w.visible !== false && w.collapsed !== true
    );

    if (targetWindows.length === 0) return;

    // Check if all target windows are already in full height mode
    const allFullHeight = targetWindows.every(w => w.fullHeight === true);
    const newFullHeightState = !allFullHeight;

    targetWindows.forEach(windowData => {
        windowData.fullHeight = newFullHeightState;
        const newHeight = newFullHeightState
            ? calcFullHeightWindowHeight(windowData)
            : calcWindowHeight(getLineCount(windowData), true);
        windowData.position.height = newHeight;

        const windowElement = document.getElementById(windowData.id);
        if (windowElement) {
            windowElement.style.height = newHeight + 'px';
            windowElement.classList.toggle('full-height', newFullHeightState);

            const fullHeightButton = windowElement.querySelector('.full-height-button');
            if (fullHeightButton) {
                fullHeightButton.classList.toggle('active', newFullHeightState);
            }
        }
    });

    const toolbarButton = document.getElementById('full-height-toggle');
    if (toolbarButton) {
        if (newFullHeightState) {
            toolbarButton.textContent = '↕ 通常表示';
            toolbarButton.classList.add('active');
        } else {
            toolbarButton.textContent = '↕ 全行表示';
            toolbarButton.classList.remove('active');
        }
    }

    requestAnimationFrame(() => {
        relayoutWindows();
        saveData();
    });
}

/**
 * Expand only windows with highlighted lines, collapse others
 */
function expandHighlightedOnly() {
    if (!currentData) return;

    currentData.windows.forEach(windowData => {
        // Check if window has any highlighted lines
        const hasHighlight = windowData.code.some(line => line.highlight);
        
        // Set collapsed state (expand if highlighted, collapse otherwise)
        windowData.collapsed = !hasHighlight;
        
        // Update DOM
        const windowElement = document.getElementById(windowData.id);
        if (windowElement) {
            if (hasHighlight) {
                windowElement.classList.remove('collapsed');
            } else {
                windowElement.classList.add('collapsed');
            }
            
            // Update collapse button icon
            const collapseButton = windowElement.querySelector('.collapse-button');
            if (collapseButton) {
                collapseButton.textContent = hasHighlight ? '▼' : '▶';
            }
        }
    });

    // Use requestAnimationFrame to ensure DOM is fully updated before adjusting positions
    requestAnimationFrame(() => {
        // Use relayoutWindows to respect parent-child relationships
        relayoutWindows();

        // Save data
        saveData();
    });
}

/**
 * Find true root windows: windows with no incoming edges.
 * Falls back to windows[0] for cyclic graphs.
 */
function findRootIds() {
    if (!currentData || !currentData.windows) return [];
    const hasIncoming = new Set((currentData.connections || []).map(c => c.to));
    const roots = currentData.windows
        .filter(w => !hasIncoming.has(w.id))
        .map(w => w.id);
    // Fallback: all windows have incoming (cyclic graph) → use windows[0]
    return roots.length > 0 ? roots : (currentData.windows[0] ? [currentData.windows[0].id] : []);
}

/**
 * Find all windows on paths from root(s) to target windows using BFS.
 * rootIds can be an array of root window IDs.
 */
function findPathWindows(rootIds, targetIds) {
    const rootIdArray = Array.isArray(rootIds) ? rootIds : [rootIds];
    if (!currentData || !currentData.connections) {
        return new Set(rootIdArray);
    }

    // BFS from all roots, tracking ALL parents per node (for multi-path graphs)
    const parents = new Map(); // node → Set<parentId>
    const queue = [...rootIdArray];
    rootIdArray.forEach(id => parents.set(id, new Set())); // roots have empty parent set

    while (queue.length > 0) {
        const current = queue.shift();
        currentData.connections
            .filter(c => c.from === current)
            .forEach(c => {
                if (!parents.has(c.to)) {
                    parents.set(c.to, new Set());
                    queue.push(c.to);
                }
                parents.get(c.to).add(current);
            });
    }

    // Backtrack from each reachable target to collect all path nodes.
    // Only roots that are actual ancestors of a target are included.
    // If no target is reachable from any root (e.g. isolated window selected),
    // fall back to showing all roots as context anchors.
    const visibleIds = new Set();
    const backtrackQueue = targetIds.filter(t => parents.has(t));
    const backtrackVisited = new Set(backtrackQueue);
    backtrackQueue.forEach(t => visibleIds.add(t));

    while (backtrackQueue.length > 0) {
        const node = backtrackQueue.shift();
        parents.get(node).forEach(p => {
            visibleIds.add(p);
            if (!backtrackVisited.has(p)) {
                backtrackVisited.add(p);
                backtrackQueue.push(p);
            }
        });
    }

    // Fallback: no target reachable → show roots so the caller gets a non-empty set
    if (visibleIds.size === 0) {
        rootIdArray.forEach(id => visibleIds.add(id));
    }

    return visibleIds;
}

/**
 * Apply focus filter: show only windows on paths from root to highlighted windows
 */
function applyFocusFilter() {
    if (!currentData || !currentData.windows || currentData.windows.length === 0) {
        return;
    }
    
    // 1. Identify root windows (windows with no incoming edges)
    const rootIds = findRootIds();

    // 2. Identify windows with highlighted lines (using internal format: code[].highlight)
    const highlightedWindows = currentData.windows.filter(w =>
        w.code && w.code.some(line => line.highlight)
    );

    if (highlightedWindows.length === 0) {
        showToast('ハイライト行を持つウィンドウがありません', 'warning');
        return;
    }

    // 3. Find all windows on paths from root(s) to highlighted windows
    const visibleIds = findPathWindows(rootIds, highlightedWindows.map(w => w.id));
    
    // 4. Update visible attribute
    currentData.windows.forEach(w => {
        w.visible = visibleIds.has(w.id);
    });
    
    // 5. Apply layout to visible windows only
    resetLayout();
}

/**
 * Apply diff path filter: show only windows on paths from root to windows with diff changes,
 * plus windows on paths to highlighted windows (union of both).
 */
function applyDiffPathFilter() {
    if (!currentData || !currentData.windows || currentData.windows.length === 0) {
        return;
    }

    // 1. Check if diff overlay is active
    const hasDiff = currentData.windows.some(w => w._hasDiffOverlay === true);
    if (!hasDiff) {
        showToast('まず差分表示を適用してください', 'warning');
        return;
    }

    // 2. Find windows that have diff changes (added or removed lines)
    const diffWindows = currentData.windows.filter(w =>
        w.code && w.code.some(line => line.diffType === 'added' || line.diffType === 'removed')
    );

    if (diffWindows.length === 0) {
        showToast('差分変更のあるウィンドウがありません', 'warning');
        return;
    }

    // 3. Find windows with highlighted lines
    const highlightedWindows = currentData.windows.filter(w =>
        w.code && w.code.some(line => line.highlight)
    );

    // 4. Find root windows (no incoming edges)
    const rootIds = findRootIds();

    // 5. Collect target windows: diff windows + highlighted windows (union)
    const targetIds = [
        ...new Set([
            ...diffWindows.map(w => w.id),
            ...highlightedWindows.map(w => w.id)
        ])
    ];

    // 6. Find all windows on paths from root(s) to target windows
    const visibleIds = findPathWindows(rootIds, targetIds);

    // 7. Update visible attribute
    currentData.windows.forEach(w => {
        w.visible = visibleIds.has(w.id);
    });

    // 8. Re-layout with only visible windows
    resetLayout();
}

/**
 * Show all windows (reset visible attribute)
 */
function showAllWindows() {
    if (!currentData || !currentData.windows) {
        return;
    }
    
    // Set all windows to visible
    currentData.windows.forEach(w => {
        w.visible = true;
    });
    
    // Apply layout to all windows
    resetLayout();
}

// ========== Multi-selection functions ==========

function updateBreadcrumb() {
    const barEl = document.getElementById('breadcrumb-bar');
    if (!barEl) return;

    if (selectedWindows.size !== 1) {
        barEl.innerHTML = '';
        barEl.style.display = 'none';
        return;
    }

    const windowId = [...selectedWindows][0];
    const windowData = currentData.windows.find(w => w.id === windowId);
    const filePath = windowData && windowData.filePath;
    if (!filePath) {
        barEl.innerHTML = '';
        barEl.style.display = 'none';
        return;
    }

    const segments = filePath.split('/');
    segments[segments.length - 1] = segments[segments.length - 1].replace(/\.[^.]+$/, '');

    barEl.innerHTML = segments.map((seg, i) => {
        const isLast = i === segments.length - 1;
        return `<span class="bc-segment${isLast ? ' bc-last' : ''}">${seg}</span>`
             + (!isLast ? `<span class="bc-separator">›</span>` : '');
    }).join('');

    barEl.style.display = 'flex';
}

function clearSelection(clearRowFocus = true) {
    selectedWindows.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.remove('selected');
    });
    selectedWindows.clear();
    
    // Clear connection selection
    selectedConnections.forEach(connId => {
        const arrows = document.querySelectorAll('.arrow');
        arrows.forEach(arrow => {
            const from = arrow.getAttribute('data-from');
            const to = arrow.getAttribute('data-to');
            if (connId === from + '->' + to) {
                arrow.classList.remove('selected');
            }
        });
    });
    selectedConnections.clear();
    
    // ウィンドウ選択解除時に行選択（フォーカス）も解除する（別ウィンドウを選ぶために呼んだ場合は解除しない）
    if (clearRowFocus && document.activeElement && document.activeElement.classList.contains('code-line-row')) {
        document.activeElement.blur();
    }
    
    updateDeleteButtonState();
    updateBreadcrumb();
}

function selectWindow(windowId, addToSelection = false, fromRowClick = false) {
    if (!addToSelection) {
        // 行クリック由来の場合は行フォーカスを残す（行クリック後に同ウィンドウが選ばれるため）
        // タイトルバー等からの選択は前ウィンドウの行フォーカスをクリアする
        clearSelection(!fromRowClick);
    }
    
    if (selectedWindows.has(windowId)) {
        // Toggle off if already selected
        selectedWindows.delete(windowId);
        const el = document.getElementById(windowId);
        if (el) el.classList.remove('selected');
    } else {
        selectedWindows.add(windowId);
        const el = document.getElementById(windowId);
        if (el) el.classList.add('selected');
    }
    updateDeleteButtonState();
    updateBreadcrumb();
}

function selectAll() {
    if (!currentData) return;
    currentData.windows.forEach(w => {
        selectedWindows.add(w.id);
        const el = document.getElementById(w.id);
        if (el) el.classList.add('selected');
    });
    updateDeleteButtonState();
}

function updateDeleteButtonState() {
    const totalSelected = selectedWindows.size + selectedConnections.size;
    const deleteButton = document.getElementById('delete-selected-button');
    if (deleteButton) {
        deleteButton.disabled = totalSelected === 0;
        if (totalSelected > 0) {
            const parts = [];
            if (selectedWindows.size > 0) parts.push('W:' + selectedWindows.size);
            if (selectedConnections.size > 0) parts.push('C:' + selectedConnections.size);
            deleteButton.textContent = '🗑 選択削除 (' + parts.join(', ') + ')';
        } else {
            deleteButton.textContent = '🗑 選択削除';
        }
    }

    // Update add-connected-window button state (only enabled when exactly 1 window is selected)
    const addConnectedBtn = document.getElementById('add-connected-window-menu-item');
    if (addConnectedBtn) addConnectedBtn.disabled = selectedWindows.size !== 1;

    // Update analyze button state (only enabled when exactly 1 window is selected)
    const analyzeButton = document.getElementById('analyze-next-level-button');
    if (analyzeButton) {
        const canAnalyze = selectedWindows.size === 1 && selectedConnections.size === 0;
        analyzeButton.disabled = !canAnalyze;
        
        // Check if selected window is an analyzable file
        if (canAnalyze && currentData) {
            const windowId = Array.from(selectedWindows)[0];
            const windowData = currentData.windows.find(w => w.id === windowId);
            if (windowData && windowData.filePath && !detectLanguage(windowData.filePath)) {
                analyzeButton.disabled = true;
                analyzeButton.title = 'Java/JS/TSファイルのみ解析可能です';
            } else {
                analyzeButton.title = '選択したウィンドウのメソッドから次の呼び出し階層を解析';
            }
        }
    }

    // Update incoming calls button state
    const analyzeIncomingButton = document.getElementById('analyze-incoming-button');
    if (analyzeIncomingButton) {
        const canAnalyze = selectedWindows.size === 1 && selectedConnections.size === 0;
        analyzeIncomingButton.disabled = !canAnalyze;
        
        // Check if selected window is an analyzable file
        if (canAnalyze && currentData) {
            const windowId = Array.from(selectedWindows)[0];
            const windowData = currentData.windows.find(w => w.id === windowId);
            const lang = detectLanguage(windowData?.filePath);
            if (windowData && windowData.filePath && !lang) {
                analyzeIncomingButton.disabled = true;
                analyzeIncomingButton.title = 'Java/JS/TSファイルのみ解析可能です';
            } else if (lang === 'javascript') {
                analyzeIncomingButton.disabled = true;
                analyzeIncomingButton.title = 'JS/TSのIncoming Calls解析は将来対応予定です';
            } else {
                analyzeIncomingButton.title = '選択したウィンドウのメソッドを呼び出しているメソッドを解析';
            }
        }
    }

    // Update analyze-to-root button state (Java only)
    const analyzeToRootButton = document.getElementById('analyze-to-root-button');
    if (analyzeToRootButton) {
        const canAnalyze = selectedWindows.size === 1 && selectedConnections.size === 0;
        analyzeToRootButton.disabled = !canAnalyze;

        if (canAnalyze && currentData) {
            const windowId = Array.from(selectedWindows)[0];
            const windowData = currentData.windows.find(w => w.id === windowId);
            const lang = detectLanguage(windowData?.filePath);
            if (!windowData || !windowData.filePath || lang !== 'java') {
                analyzeToRootButton.disabled = true;
                analyzeToRootButton.title = 'Javaファイルのみ解析可能です';
            } else {
                analyzeToRootButton.title = '選択したメソッドの呼び出し元をルートメソッドまで再帰的に解析';
            }
        }
    }

    // Update selection hint in toolbar
    const selectionHint = document.getElementById('selection-hint');
    if (selectionHint) {
        if (totalSelected > 0) {
            selectionHint.textContent = 'Delete で削除 / Esc で選択解除';
            selectionHint.style.display = 'inline';
        } else {
            selectionHint.style.display = 'none';
        }
    }

    // Update path highlight
    updatePathHighlight();
}

/**
 * Highlight the path from root to selected window
 */
function updatePathHighlight() {
    // 1. Reset: remove on-path from all windows and arrows
    document.querySelectorAll('.code-window.on-path').forEach(el => el.classList.remove('on-path'));
    document.querySelectorAll('.arrow.on-path').forEach(el => el.classList.remove('on-path'));

    // 2. Only highlight when exactly 1 window is selected
    if (selectedWindows.size !== 1 || !currentData) return;

    const selectedId = selectedWindows.values().next().value;
    const rootIds = findRootIds();
    if (rootIds.length === 0) return;

    // 3. Get path windows using findPathWindows with dynamic roots
    const pathWindowIds = findPathWindows(rootIds, [selectedId]);

    // 4. Guard for isolated windows: if selected window is not in path, do nothing
    //    findPathWindows always returns rootId, so this prevents meaningless
    //    green border on root when an isolated window is selected
    if (!pathWindowIds.has(selectedId)) return;

    // 5. Add on-path class to path windows
    pathWindowIds.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.add('on-path');
    });

    // 6. Build connection keys for path
    const pathConnectionKeys = new Set();
    currentData.connections.forEach(c => {
        if (pathWindowIds.has(c.from) && pathWindowIds.has(c.to)) {
            pathConnectionKeys.add(c.from + '->' + c.to);
        }
    });

    // 7. Add on-path class to arrows (match by data-from + data-to)
    document.querySelectorAll('.arrow').forEach(arrow => {
        const from = arrow.getAttribute('data-from');
        const to = arrow.getAttribute('data-to');
        const key = from + '->' + to;
        if (pathConnectionKeys.has(key)) {
            arrow.classList.add('on-path');
        }
    });
}

function deleteSelectedWindows() {
    if (!currentData || selectedWindows.size === 0) return;

    // Cascade delete: children whose parents are all deleted go too
    const deletion = computeWindowDeletion(currentData.connections, [...selectedWindows]);
    const windowsToDelete = new Set(deletion.deleteIds);

    windowsToDelete.forEach(id => {
        const windowElement = document.getElementById(id);
        if (windowElement) {
            windowElement.remove();
        }
    });

    currentData.windows = currentData.windows.filter(w => !windowsToDelete.has(w.id));
    if (currentData.connections) {
        currentData.connections = deletion.connections;
    }

    // Clear selection
    clearSelection();

    // Adjust positions in all columns (close gaps left by deleted windows)
    adjustColumnOverlaps();

    // Update arrows after positions are adjusted
    updateArrows();

    // Update container size
    updateContainerSize();

    // Save data
    saveData();
}

function deleteSelectedConnections() {
    if (!currentData || !currentData.connections || selectedConnections.size === 0) return;

    // Delete each selected connection
    selectedConnections.forEach(connId => {
        const [fromId, toId] = connId.split('->');
        currentData.connections = currentData.connections.filter(
            conn => !(conn.from === fromId && conn.to === toId)
        );
    });

    // Clear connection selection
    selectedConnections.clear();
    
    // Update arrows
    updateArrows();
    
    // Save data
    saveData();
    
    // Update button state
    updateDeleteButtonState();
}

// ========== F12 Jump functions ==========

// Pending F12 jump state (for auto-analyze scenario)
let pendingF12Jump = null; // { windowId, lineNumber }

/** Build a Set of composite keys (windowId + unit separator + line) for lines that have an outgoing CallCanvas connection. */
function collectCallOriginLineKeys(data) {
    const set = new Set();
    const sep = String.fromCharCode(31);
    if (!data || !data.connections) return set;
    for (const conn of data.connections) {
        if (!conn.from || conn.callLine == null) continue;
        const startLine = conn.callLine;
        const endLine = conn.callEndLine != null ? conn.callEndLine : conn.callLine;
        for (let L = startLine; L <= endLine; L++) {
            set.add(conn.from + sep + L);
        }
    }
    // Nested-omit card rows only render `startLine` (sl); lines (sl, el] are removed from the DOM.
    // Map any connection origin in (sl, el] to the visible card row key (sl) so F12 markers match.
    if (data.windows) {
        for (const w of data.windows) {
            if (!Array.isArray(w.code)) continue;
            for (const line of w.code) {
                if (!line.nestedOmitCard || line.omitEndLine == null) continue;
                const sl = line.line;
                const el = line.omitEndLine;
                for (let L = sl + 1; L <= el; L++) {
                    if (set.has(w.id + sep + L)) {
                        set.add(w.id + sep + sl);
                        break;
                    }
                }
            }
        }
    }
    return set;
}

/** Toggle has-viewer-call-target on each code line row (marker on the right; sync after connections or code DOM change). */
function syncViewerCallTargetMarkers() {
    if (typeof document === 'undefined') return;
    const keys = currentData ? collectCallOriginLineKeys(currentData) : new Set();
    document.querySelectorAll('.code-line-row').forEach(row => {
        const wid = row.getAttribute('data-window-id');
        const ln = parseInt(row.getAttribute('data-line-number'), 10);
        if (!wid || !Number.isFinite(ln)) return;
        const k = wid + String.fromCharCode(31) + ln;
        if (keys.has(k)) {
            row.classList.add('has-viewer-call-target');
        } else {
            row.classList.remove('has-viewer-call-target');
        }
    });
}

// Find connections from a window at a specific line (supports multi-line method calls).
// omitEndLine: when the focused row is a nested-omit card (data-omit-end-line), treat the origin
// range as [lineNumber, omitEndLine] so calls on collapsed inner lines still resolve.
function findConnectionsAtLine(windowId, lineNumber, omitEndLine) {
    if (!currentData || !currentData.connections) return [];

    const rangeStart = lineNumber;
    const rangeEnd = omitEndLine != null && Number.isFinite(omitEndLine) ? omitEndLine : lineNumber;

    return currentData.connections.filter(conn => {
        if (conn.from !== windowId) return false;
        const startLine = conn.callLine;
        const endLine = conn.callEndLine != null ? conn.callEndLine : conn.callLine;
        // Overlap [rangeStart, rangeEnd] with [startLine, endLine] (inclusive)
        return !(endLine < rangeStart || startLine > rangeEnd);
    });
}

// Get display name for a window
function getWindowDisplayName(windowId) {
    if (!currentData || !currentData.windows) return windowId;
    const window = currentData.windows.find(w => w.id === windowId);
    return window ? (window.displayName || window.filePath || windowId) : windowId;
}

// Handle F12 key press to jump to call target
function handleF12Jump(focusedRow) {
    const lineNumber = parseInt(focusedRow.getAttribute('data-line-number'));
    const windowId = focusedRow.getAttribute('data-window-id');
    
    if (!lineNumber || !windowId) return;

    const omitAttr = focusedRow.getAttribute('data-omit-end-line');
    const parsedOmitEnd = omitAttr != null && omitAttr !== '' ? parseInt(omitAttr, 10) : NaN;
    const omitEndLine = Number.isFinite(parsedOmitEnd) ? parsedOmitEnd : undefined;
    
    // Find connections at this line
    const connections = findConnectionsAtLine(windowId, lineNumber, omitEndLine);
    
    if (connections.length === 0) {
        // No connection at this line - try to analyze if it's a Java file
        const targetWindow = currentData.windows.find(w => w.id === windowId);
        
        if (targetWindow && targetWindow.filePath && detectLanguage(targetWindow.filePath)) {
            // Store pending F12 jump info
            pendingF12Jump = { windowId, lineNumber, omitEndLine };
            
            // Trigger analysis for this window
            vscode.postMessage({
                command: 'analyzeNextLevel',
                windowData: {
                    displayName: targetWindow.displayName,
                    filePath: targetWindow.filePath,
                    code: targetWindow.code.map(line => line.content).join(String.fromCharCode(10)),
                    startLine: targetWindow.code[0]?.line || targetWindow.startLine || 1
                }
            });
            
            showToast('解析中...', 'info', 2000);
            return;
        }
        
        // Not a Java file - show brief feedback
        focusedRow.style.transition = 'background-color 0.3s';
        focusedRow.style.backgroundColor = 'rgba(255, 100, 100, 0.2)';
        setTimeout(() => {
            focusedRow.style.backgroundColor = '';
        }, 300);
        return;
    }
    
    if (connections.length === 1) {
        // Single connection - jump directly with explicit origin for history
        jumpToWindowWithOrigin(connections[0].to, windowId, lineNumber);
    } else {
        // Multiple connections - show popup menu
        showJumpPopupMenu(focusedRow, connections);
    }
}

// Show popup menu for multiple jump targets
function showJumpPopupMenu(anchorElement, connections) {
    // Remove existing popup if any
    const existingPopup = document.getElementById('jump-popup-menu');
    if (existingPopup) {
        existingPopup.remove();
    }
    
    // Save jump origin BEFORE showing popup (since focus will move to popup items)
    const originWindowId = anchorElement.getAttribute('data-window-id');
    const originLineNumber = parseInt(anchorElement.getAttribute('data-line-number'));
    
    const popup = document.createElement('div');
    popup.id = 'jump-popup-menu';
    popup.className = 'jump-popup-menu';
    
    connections.forEach((conn, index) => {
        const item = document.createElement('div');
        item.className = 'jump-popup-item';
        item.textContent = getWindowDisplayName(conn.to);
        item.setAttribute('data-index', index);
        item.tabIndex = 0;
        
        item.addEventListener('click', function(e) {
            e.stopPropagation();
            popup.remove();
            jumpToWindowWithOrigin(conn.to, originWindowId, originLineNumber);
        });
        
        item.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                popup.remove();
                jumpToWindowWithOrigin(conn.to, originWindowId, originLineNumber);
            } else if (e.key === 'Escape') {
                e.preventDefault();
                popup.remove();
                anchorElement.focus();
            } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                const next = item.nextElementSibling;
                if (next) next.focus();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                const prev = item.previousElementSibling;
                if (prev) prev.focus();
            }
        });
        
        popup.appendChild(item);
    });
    
    // Position popup near the anchor element
    const rect = anchorElement.getBoundingClientRect();
    popup.style.position = 'fixed';
    popup.style.top = (rect.bottom + 4) + 'px';
    popup.style.left = rect.left + 'px';
    
    document.body.appendChild(popup);
    
    // Focus first item
    const firstItem = popup.querySelector('.jump-popup-item');
    if (firstItem) {
        firstItem.focus();
    }
    
    // Close popup when clicking outside
    function closePopup(e) {
        if (!popup.contains(e.target)) {
            popup.remove();
            document.removeEventListener('click', closePopup);
        }
    }
    setTimeout(() => {
        document.addEventListener('click', closePopup);
    }, 0);
}

// Show line context menu for highlight toggle
function showLineContextMenu(e, lineRow, windowId, lineNumber) {
    e.preventDefault();
    e.stopPropagation();

    // Remove existing menu if any
    const existingMenu = document.getElementById('line-context-menu');
    if (existingMenu) {
        existingMenu.remove();
    }

    // Check if line is already highlighted
    const windowData = currentData.windows.find(w => w.id === windowId);
    if (!windowData) return;

    const diffType = lineRow.getAttribute('data-diff-type') || null;
    const lineData = windowData.code.find(line =>
        line.line === lineNumber && (diffType ? line.diffType === diffType : !line.diffType));
    if (!lineData) return;
    
    const isHighlighted = lineData.highlight;
    const hasComment = !!(lineData.comment && lineData.comment.trim());
    
    // Create menu
    const menu = document.createElement('div');
    menu.id = 'line-context-menu';
    menu.className = 'line-context-menu';

    // Go to Declaration (only when right-clicking a symbol-ref token)
    const symbolToken = e.target && e.target.closest ? e.target.closest('.symbol-ref') : null;
    if (symbolToken) {
        const symbolKey = symbolToken.getAttribute('data-symbol');
        const declItem = document.createElement('div');
        declItem.className = 'line-context-menu-item';
        declItem.textContent = 'Go to Declaration';
        declItem.addEventListener('click', function(clickEvent) {
            clickEvent.stopPropagation();
            menu.remove();
            goToDeclaration(symbolKey);
        });
        menu.appendChild(declItem);
    }
    
    // Highlight item
    const item = document.createElement('div');
    item.className = 'line-context-menu-item';
    item.textContent = isHighlighted ? 'ハイライト削除' : 'ハイライト追加';
    item.addEventListener('click', function(clickEvent) {
        clickEvent.stopPropagation();
        menu.remove();
        toggleLineHighlight(windowId, lineNumber);
    });
    menu.appendChild(item);
    
    // Comment insert / edit
    const commentItem = document.createElement('div');
    commentItem.className = 'line-context-menu-item';
    commentItem.textContent = hasComment ? 'コメント編集' : 'コメント挿入';
    commentItem.addEventListener('click', function(clickEvent) {
        clickEvent.stopPropagation();
        menu.remove();
        showCommentInputPopover(lineRow, windowId, lineNumber, lineData.comment || '', diffType);
    });
    menu.appendChild(commentItem);

    // Comment delete (only when has comment)
    if (hasComment) {
        const deleteCommentItem = document.createElement('div');
        deleteCommentItem.className = 'line-context-menu-item';
        deleteCommentItem.textContent = 'コメント削除';
        deleteCommentItem.addEventListener('click', function(clickEvent) {
            clickEvent.stopPropagation();
            menu.remove();
            removeLineComment(windowId, lineNumber, diffType);
        });
        menu.appendChild(deleteCommentItem);
    }
    
    // Position menu at mouse cursor
    menu.style.position = 'fixed';
    menu.style.top = e.clientY + 'px';
    menu.style.left = e.clientX + 'px';
    
    document.body.appendChild(menu);
    
    // Close menu when clicking outside
    function closeMenu(clickEvent) {
        if (!menu.contains(clickEvent.target)) {
            menu.remove();
            document.removeEventListener('click', closeMenu);
        }
    }
    setTimeout(() => {
        document.addEventListener('click', closeMenu);
    }, 0);
}

function extractMethodName(displayName) {
    const normalized = normalizeDisplayNameToClassMethod(displayName);
    const idx = normalized.indexOf('#');
    return idx >= 0 ? normalized.slice(idx + 1) : '';
}

function normalizeDisplayNameToClassMethod(displayName) {
    if (!displayName || typeof displayName !== 'string') return '';
    // "Class # method" -> "Class#method"
    return displayName.replace(/\s*#\s*/g, '#').trim();
}

function removeTitleContextMenu() {
    const existing = document.getElementById('title-context-menu');
    if (existing) {
        existing.remove();
    }
}

function showTitleContextMenu(e, titleBar, windowData) {
    removeTitleContextMenu();

    const menu = document.createElement('div');
    menu.id = 'title-context-menu';
    menu.className = 'jump-popup-menu';
    menu.style.position = 'fixed';
    menu.style.top = `${e.clientY}px`;
    menu.style.left = `${e.clientX}px`;

    const createCopyMenuItem = ({ label, getText, missingTextWarning }) => {
        const item = document.createElement('div');
        item.className = 'jump-popup-item';
        item.textContent = label;
        item.tabIndex = 0;

        const handleCopy = async () => {
            const textToCopy = (getText() || '').trim();
            if (!textToCopy) {
                showToast(missingTextWarning, 'warning');
                removeTitleContextMenu();
                return;
            }
            try {
                await navigator.clipboard.writeText(textToCopy);
                showToast(`コピーしました: ${textToCopy}`, 'success', 1800);
            } catch (err) {
                showToast('コピーに失敗しました', 'error');
            } finally {
                removeTitleContextMenu();
            }
        };

        item.addEventListener('mouseenter', () => item.focus());
        item.addEventListener('click', (evt) => {
            evt.stopPropagation();
            handleCopy();
        });
        item.addEventListener('keydown', (evt) => {
            if (evt.key === 'Enter') {
                evt.preventDefault();
                handleCopy();
            } else if (evt.key === 'Escape') {
                evt.preventDefault();
                removeTitleContextMenu();
                titleBar.focus();
            }
        });

        return item;
    };

    const copyClassMethodItem = createCopyMenuItem({
        label: 'Copy class#method',
        getText: () => normalizeDisplayNameToClassMethod(windowData?.displayName || ''),
        missingTextWarning: 'コピー対象のwindow名が見つかりません'
    });
    const copyRepoPathItem = createCopyMenuItem({
        label: 'Copy repository path',
        getText: () => (windowData?.filePath || '').split('\\').join('/'),
        missingTextWarning: 'コピー対象のrepository pathが見つかりません'
    });

    const copyMethodRefItem = createCopyMenuItem({
        label: 'Copy filePath#method',
        getText: () => {
            const filePath = (windowData?.filePath || '').split('\\').join('/');
            const method = extractMethodName(windowData?.displayName || '');
            if (!filePath) return '';
            return method ? `${filePath}#${method}` : filePath;
        },
        missingTextWarning: 'コピー対象のfilePath#methodが見つかりません'
    });

    menu.appendChild(copyClassMethodItem);
    menu.appendChild(copyRepoPathItem);
    menu.appendChild(copyMethodRefItem);
    document.body.appendChild(menu);
    copyClassMethodItem.focus();

    const closeMenu = (evt) => {
        if (!menu.contains(evt.target)) {
            removeTitleContextMenu();
            document.removeEventListener('mousedown', closeMenu);
        }
    };
    setTimeout(() => document.addEventListener('mousedown', closeMenu), 0);
}

// Comment input popover (textarea + OK/Cancel)
function showCommentInputPopover(lineRow, windowId, lineNumber, initialValue, diffType) {
    const existing = document.getElementById('line-comment-input-popover');
    if (existing) existing.remove();
    
    const popover = document.createElement('div');
    popover.id = 'line-comment-input-popover';
    popover.className = 'line-comment-input-popover';
    
    const textarea = document.createElement('textarea');
    textarea.className = 'line-comment-input-textarea';
    textarea.placeholder = 'コメントを入力...';
    textarea.value = initialValue;
    textarea.rows = 3;
    popover.appendChild(textarea);
    
    const buttons = document.createElement('div');
    buttons.className = 'line-comment-input-buttons';
    const okBtn = document.createElement('button');
    okBtn.className = 'line-comment-input-btn line-comment-input-ok';
    okBtn.textContent = 'OK';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'line-comment-input-btn line-comment-input-cancel';
    cancelBtn.textContent = 'キャンセル';
    buttons.appendChild(okBtn);
    buttons.appendChild(cancelBtn);
    popover.appendChild(buttons);
    
    function closePopover() {
        popover.remove();
        document.removeEventListener('click', closeOnClickOutside);
    }
    
    function closeOnClickOutside(e) {
        if (!popover.contains(e.target)) closePopover();
    }
    
    okBtn.addEventListener('click', function() {
        const value = textarea.value.trim();
        closePopover();
        if (value === '') return;
        setLineComment(windowId, lineNumber, value, diffType);
    });
    cancelBtn.addEventListener('click', closePopover);
    textarea.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') { e.preventDefault(); closePopover(); }
    });
    
    document.body.appendChild(popover);
    const rect = lineRow.getBoundingClientRect();
    popover.style.position = 'fixed';
    popover.style.top = (rect.bottom + 4) + 'px';
    popover.style.left = Math.max(8, rect.left) + 'px';
    popover.style.width = Math.min(320, document.documentElement.clientWidth - 16) + 'px';
    textarea.focus();
    setTimeout(() => document.addEventListener('click', closeOnClickOutside), 0);
}

function setLineComment(windowId, lineNumber, text, diffType) {
    const windowData = currentData.windows.find(w => w.id === windowId);
    if (!windowData) return;
    const lineData = windowData.code.find(line =>
        line.line === lineNumber && (diffType ? line.diffType === diffType : !line.diffType));
    if (!lineData) return;
    lineData.comment = text;
    addOrUpdateCommentBubble(windowId, lineNumber, text, diffType);
    saveData();
}

function removeLineComment(windowId, lineNumber, diffType) {
    const windowData = currentData.windows.find(w => w.id === windowId);
    if (!windowData) return;
    const lineData = windowData.code.find(line =>
        line.line === lineNumber && (diffType ? line.diffType === diffType : !line.diffType));
    if (!lineData) return;
    lineData.comment = undefined;
    removeCommentBubble(windowId, lineNumber, diffType);
    saveData();
}

function addOrUpdateCommentBubble(windowId, lineNumber, text, diffType) {
    const windowElement = document.getElementById(windowId);
    if (!windowElement) return;
    const codeArea = windowElement.querySelector('.code-area');
    if (!codeArea) return;
    const diffSelector = diffType ? `[data-diff-type="${diffType}"]` : ':not([data-diff-type])';
    const lineRow = codeArea.querySelector(`.code-line-row[data-window-id="${windowId}"][data-line-number="${lineNumber}"]${diffSelector}`);
    if (!lineRow) return;
    let bubble = lineRow.nextElementSibling;
    if (bubble && bubble.classList.contains('line-comment-bubble')) {
        bubble.textContent = text;
        return;
    }
    bubble = document.createElement('div');
    bubble.className = 'line-comment-bubble';
    bubble.setAttribute('data-window-id', windowId);
    bubble.setAttribute('data-line-number', String(lineNumber));
    bubble.textContent = text;
    lineRow.parentNode.insertBefore(bubble, lineRow.nextSibling);
}

function removeCommentBubble(windowId, lineNumber, diffType) {
    const windowElement = document.getElementById(windowId);
    if (!windowElement) return;
    const codeArea = windowElement.querySelector('.code-area');
    if (!codeArea) return;
    const diffSelector = diffType ? `[data-diff-type="${diffType}"]` : ':not([data-diff-type])';
    const lineRow = codeArea.querySelector(`.code-line-row[data-window-id="${windowId}"][data-line-number="${lineNumber}"]${diffSelector}`);
    if (!lineRow) return;
    const bubble = lineRow.nextElementSibling;
    if (bubble && bubble.classList.contains('line-comment-bubble')) {
        bubble.remove();
    }
}

// Jump to a window by ID
function jumpToWindow(windowId, skipHistory = false) {
    // visible:false の場合は表示を復元してレイアウト再計算
    const windowData = currentData.windows.find(w => w.id === windowId);
    if (windowData && windowData.visible === false) {
        windowData.visible = true;
        const el = document.getElementById(windowId);
        if (el) {
            el.style.display = '';
        }
        updateArrows();
        // 可視ウィンドウのみ再レイアウトし、完了後に再度ジャンプ
        resetLayout(() => jumpToWindow(windowId, skipHistory));
        return;
    }

    const windowElement = document.getElementById(windowId);
    if (!windowElement) return;
    
    // Save current position to jump history (before jumping)
    if (!skipHistory) {
        const focusedRow = document.activeElement;
        if (focusedRow && focusedRow.classList.contains('code-line-row')) {
            const fromWindowId = focusedRow.getAttribute('data-window-id');
            const fromLineNumber = parseInt(focusedRow.getAttribute('data-line-number'));
            if (fromWindowId && fromLineNumber) {
                jumpHistory.push({ windowId: fromWindowId, lineNumber: fromLineNumber });
                // Limit history size
                if (jumpHistory.length > JUMP_HISTORY_MAX_SIZE) {
                    jumpHistory.shift();
                }
            }
        }
    }
    
    // Update selection: clear previous and select target window
    clearSelection(false);
    selectedWindows.add(windowId);
    windowElement.classList.add('selected');
    updateDeleteButtonState();
    
    // Expand if collapsed (windowData already retrieved above for visible check)
    if (windowData && windowData.collapsed === true) {
        toggleCollapse(windowId);
    }
    
    // Scroll window into view (center both vertically and horizontally)
    windowElement.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    
    // Focus first code line after a short delay (for expand animation). preventScroll keeps our centering.
    setTimeout(() => {
        const firstRow = windowElement.querySelector('.code-line-row');
        if (firstRow) {
            firstRow.focus({ preventScroll: true });
        }
    }, 100);
}

// Jump to a window with explicit origin (used by popup menu)
function jumpToWindowWithOrigin(windowId, originWindowId, originLineNumber) {
    // Save origin to jump history
    if (originWindowId && originLineNumber) {
        jumpHistory.push({ windowId: originWindowId, lineNumber: originLineNumber });
        // Limit history size
        if (jumpHistory.length > JUMP_HISTORY_MAX_SIZE) {
            jumpHistory.shift();
        }
    }
    // Jump without saving history again (already saved above)
    jumpToWindow(windowId, true);
}

// Jump back to previous position (Alt+←)
function jumpBack() {
    if (jumpHistory.length === 0) return;
    
    const previousPosition = jumpHistory.pop();
    const windowElement = document.getElementById(previousPosition.windowId);
    if (!windowElement) return;
    
    // Update selection
    clearSelection(false);
    selectedWindows.add(previousPosition.windowId);
    windowElement.classList.add('selected');
    updateDeleteButtonState();
    
    // Expand if collapsed
    const windowData = currentData.windows.find(w => w.id === previousPosition.windowId);
    if (windowData && windowData.collapsed === true) {
        toggleCollapse(previousPosition.windowId);
    }
    
    // Scroll window into view (center both vertically and horizontally)
    windowElement.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    
    // Focus the specific line after a short delay. preventScroll keeps our centering.
    setTimeout(() => {
        const targetRow = windowElement.querySelector('.code-line-row[data-line-number="' + previousPosition.lineNumber + '"]');
        if (targetRow) {
            targetRow.focus({ preventScroll: true });
        } else {
            // Fallback to first row
            const firstRow = windowElement.querySelector('.code-line-row');
            if (firstRow) firstRow.focus({ preventScroll: true });
        }
    }, 100);
}

// ========== Search functions ==========

function createSearchBox() {
    const searchBox = document.createElement('div');
    searchBox.id = 'search-box';
    searchBox.className = 'search-box';
    
    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.id = 'search-input';
    searchInput.className = 'search-input';
    searchInput.placeholder = '検索...';
    
    const searchCount = document.createElement('span');
    searchCount.id = 'search-count';
    searchCount.className = 'search-count';
    
    const prevButton = document.createElement('button');
    prevButton.id = 'search-prev-button';
    prevButton.className = 'search-nav-button';
    prevButton.textContent = '▲';
    prevButton.title = '前へ (Shift+Enter)';
    prevButton.disabled = true;
    
    const nextButton = document.createElement('button');
    nextButton.id = 'search-next-button';
    nextButton.className = 'search-nav-button';
    nextButton.textContent = '▼';
    nextButton.title = '次へ (Enter)';
    nextButton.disabled = true;
    
    const closeButton = document.createElement('button');
    closeButton.id = 'search-close-button';
    closeButton.className = 'search-close-button';
    closeButton.textContent = '×';
    closeButton.title = '閉じる (Esc)';
    
    searchBox.appendChild(searchInput);
    searchBox.appendChild(searchCount);
    searchBox.appendChild(prevButton);
    searchBox.appendChild(nextButton);
    searchBox.appendChild(closeButton);
    
    document.body.appendChild(searchBox);
    
    // Event listeners
    searchInput.addEventListener('input', function(e) {
        const query = e.target.value;
        performSearch(query);
    });
    
    searchInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            if (e.shiftKey) {
                goToPreviousMatch();
            } else {
                goToNextMatch();
            }
        } else if (e.key === 'Escape') {
            e.preventDefault();
            hideSearchBox();
        }
    });
    
    prevButton.addEventListener('click', function() {
        goToPreviousMatch();
    });
    
    nextButton.addEventListener('click', function() {
        goToNextMatch();
    });
    
    closeButton.addEventListener('click', function() {
        hideSearchBox();
    });
}

function showSearchBox() {
    const searchBox = document.getElementById('search-box');
    const searchInput = document.getElementById('search-input');
    if (searchBox && searchInput) {
        searchBox.classList.add('visible');
        searchBoxVisible = true;
        searchInput.focus();
        if (searchQuery) {
            performSearch(searchQuery);
        }
    }
}

function hideSearchBox() {
    const searchBox = document.getElementById('search-box');
    const searchInput = document.getElementById('search-input');
    if (searchBox && searchInput) {
        searchBox.classList.remove('visible');
        searchBoxVisible = false;
        searchQuery = '';
        searchInput.value = '';
        clearSearchHighlight();
    }
}

function getWindowText(windowData) {
    if (!windowData) return '';
    
    let text = '';
    
    // Add display name (method name)
    if (windowData.displayName) {
        text += windowData.displayName + ' ';
    }
    
    // Add file path
    if (windowData.filePath) {
        text += windowData.filePath + ' ';
    }
    
    // Add code content
    if (windowData.code) {
        if (Array.isArray(windowData.code)) {
            // Code is in array format (after normalization)
            text += windowData.code.map(line => line.content).join(' ');
        } else {
            // Code is in string format
            text += windowData.code;
        }
    }
    
    return text.toLowerCase();
}

function performSearch(query) {
    searchQuery = query;

    if (query.trim()) {
        selectionHighlightQuery = '';
    }

    if (!query.trim()) {
        clearSearchHighlight();
        updateSearchCount(0, 0);
        return;
    }
    
    if (!currentData || !currentData.windows) {
        clearSearchHighlight();
        updateSearchCount(0, 0);
        return;
    }
    
    const queryLower = query.toLowerCase();
    searchMatches = [];
    
    // Search through all windows
    currentData.windows.forEach(window => {
        const windowText = getWindowText(window);
        if (windowText.includes(queryLower)) {
            searchMatches.push(window.id);
        }
    });
    
    // Reset current match index
    // 選択中ウィンドウがあれば、そのウィンドウ内の最初のマッチから開始
    if (searchMatches.length === 0) {
        currentMatchIndex = -1;
    } else if (selectedWindows.size > 0) {
        const firstSelectedMatch = searchMatches.findIndex(id => selectedWindows.has(id));
        currentMatchIndex = firstSelectedMatch !== -1 ? firstSelectedMatch : 0;
    } else {
        currentMatchIndex = 0;
    }

    // Update UI
    highlightMatches();
    updateSearchCount(currentMatchIndex + 1, searchMatches.length);
    updateSearchNavButtons();

    // Scroll to first match if any
    if (searchMatches.length > 0) {
        scrollToMatch(searchMatches[currentMatchIndex]);
    }
}

function highlightMatches() {
    if (!currentData || !currentData.windows) return;
    
    // Clear all search-related classes and text highlights
    currentData.windows.forEach(window => {
        const el = document.getElementById(window.id);
        if (el) {
            el.classList.remove('search-match', 'search-current', 'search-dimmed');
            clearTextHighlight(window.id);
        }
    });
    
    if (searchMatches.length === 0) {
        // No matches - dim all windows
        currentData.windows.forEach(window => {
            const el = document.getElementById(window.id);
            if (el) {
                el.classList.add('search-dimmed');
            }
        });
        return;
    }
    
    // Highlight matches
    searchMatches.forEach((windowId, index) => {
        const el = document.getElementById(windowId);
        if (el) {
            el.classList.add('search-match');
            if (index === currentMatchIndex) {
                el.classList.add('search-current');
            }
            // Highlight matching text within the window
            highlightSearchText(windowId, searchQuery);
        }
    });
    
    // Dim non-matching windows
    currentData.windows.forEach(window => {
        if (!searchMatches.includes(window.id)) {
            const el = document.getElementById(window.id);
            if (el) {
                el.classList.add('search-dimmed');
            }
        }
    });
}

function clearSearchHighlight() {
    if (!currentData || !currentData.windows) return;

    const selSnap = captureCodeAreaSelectionSnapshot();
    try {
        currentData.windows.forEach(window => {
            const el = document.getElementById(window.id);
            if (el) {
                el.classList.remove('search-match', 'search-current', 'search-dimmed');
                clearTextHighlight(window.id);
            }
        });

        searchMatches = [];
        currentMatchIndex = -1;
        updateSearchCount(0, 0);
        updateSearchNavButtons();

        if (selectionHighlightQuery) {
            reapplySelectionHighlights();
        }
    } finally {
        if (selSnap) {
            restoreCodeAreaSelectionSnapshot(selSnap);
        }
    }
}

function armSelectionHighlightDomQuietPeriod() {
    _selectionHighlightAllowEmptyClear = false;
    if (_selectionHighlightQuietTimeout !== null) {
        clearTimeout(_selectionHighlightQuietTimeout);
    }
    _selectionHighlightQuietTimeout = setTimeout(function () {
        _selectionHighlightQuietTimeout = null;
        _selectionHighlightAllowEmptyClear = true;
    }, 200);
}

function reapplySelectionHighlights() {
    if (!selectionHighlightQuery || !currentData || !currentData.windows) return;
    armSelectionHighlightDomQuietPeriod();
    const q = selectionHighlightQuery;
    const qLower = q.toLowerCase();
    currentData.windows.forEach(w => {
        if (getWindowText(w).includes(qLower)) {
            highlightSearchText(w.id, q, 'selection-text-highlight');
        }
    });
}

function reapplySearchTextHighlightsOnly() {
    if (!searchQuery || !searchQuery.trim() || !currentData || !currentData.windows) return;
    if (searchMatches.length === 0) return;
    const q = searchQuery;
    const qLower = q.toLowerCase();
    searchMatches.forEach(windowId => {
        const w = currentData.windows.find(function (x) { return x.id === windowId; });
        if (w && getWindowText(w).includes(qLower)) {
            highlightSearchText(windowId, q);
        }
    });
}

function clearSelectionHighlightOnly() {
    selectionHighlightQuery = '';
    if (!currentData || !currentData.windows) return;
    currentData.windows.forEach(window => {
        const el = document.getElementById(window.id);
        if (el) {
            clearTextHighlight(window.id);
        }
    });
    reapplySearchTextHighlightsOnly();
}

function applySelectionHighlightFromUser(text) {
    selectionHighlightQuery = text;
    const searchBox = document.getElementById('search-box');
    const searchInput = document.getElementById('search-input');
    if (searchBox) {
        searchBox.classList.remove('visible');
    }
    searchBoxVisible = false;
    searchQuery = '';
    if (searchInput) {
        searchInput.value = '';
    }
    searchMatches = [];
    currentMatchIndex = -1;
    updateSearchCount(0, 0);
    updateSearchNavButtons();

    if (!currentData || !currentData.windows) return;

    const selSnap = captureCodeAreaSelectionSnapshot();
    try {
        currentData.windows.forEach(window => {
            const el = document.getElementById(window.id);
            if (el) {
                el.classList.remove('search-match', 'search-current', 'search-dimmed');
                clearTextHighlight(window.id);
            }
        });

        reapplySelectionHighlights();
    } finally {
        if (selSnap) {
            restoreCodeAreaSelectionSnapshot(selSnap);
        }
    }
}

function nodeInAllowedSelectRegion(node) {
    if (!node) return false;
    const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    if (!el || !el.closest) return false;
    const win = el.closest('.code-window');
    if (!win) return false;
    return !!(el.closest('.code-line') || el.closest('.file-path'));
}

/** UTF-16 offset from start of codeLine.textContent to (container, offset); -1 if not inside codeLine. */
function codeLineTextOffsetFromDomPoint(codeLine, container, offset) {
    if (!codeLine || !container || !codeLine.contains(container)) {
        return -1;
    }
    let total = 0;
    const walker = document.createTreeWalker(codeLine, NodeFilter.SHOW_TEXT, null);
    let n;
    while ((n = walker.nextNode())) {
        if (n === container) {
            return total + offset;
        }
        total += n.nodeValue.length;
    }
    return -1;
}

function collectIntersectingCodeLinesOrdered(range) {
    const lines = [];
    document.querySelectorAll('.code-window .code-line').forEach(lineEl => {
        if (range.intersectsNode(lineEl)) {
            lines.push(lineEl);
        }
    });
    lines.sort((a, b) => {
        const p = a.compareDocumentPosition(b);
        if (p & Node.DOCUMENT_POSITION_FOLLOWING) {
            return -1;
        }
        if (p & Node.DOCUMENT_POSITION_PRECEDING) {
            return 1;
        }
        return 0;
    });
    return lines;
}

/**
 * Snapshot of a text selection in .code-line nodes so it can survive innerHTML highlight updates.
 * @returns {{ segments: Array<{ codeLine: Element, start: number, end: number }> } | null}
 */
function captureCodeAreaSelectionSnapshot() {
    if (IS_EXPORT_MODE) {
        return null;
    }
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) {
        return null;
    }
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
        return null;
    }
    const r = sel.getRangeAt(0);
    const anchor = sel.anchorNode;
    const focus = sel.focusNode;
    const anchorEl = anchor && (anchor.nodeType === Node.TEXT_NODE ? anchor.parentElement : anchor);
    if (anchorEl && anchorEl.closest && anchorEl.closest('#search-input')) {
        return null;
    }
    if (!nodeInAllowedSelectRegion(anchor) || !nodeInAllowedSelectRegion(focus)) {
        return null;
    }

    const lines = collectIntersectingCodeLinesOrdered(r);
    if (!lines.length) {
        return null;
    }

    const segments = [];
    for (let i = 0; i < lines.length; i++) {
        const codeLine = lines[i];
        const lineRange = document.createRange();
        lineRange.selectNodeContents(codeLine);
        if (r.compareBoundaryPoints(Range.END_TO_START, lineRange) > 0) {
            continue;
        }
        if (r.compareBoundaryPoints(Range.START_TO_END, lineRange) < 0) {
            continue;
        }

        let startOff;
        if (r.compareBoundaryPoints(Range.START_TO_START, lineRange) <= 0) {
            startOff = 0;
        } else {
            const o = codeLineTextOffsetFromDomPoint(codeLine, r.startContainer, r.startOffset);
            if (o < 0) {
                return null;
            }
            startOff = o;
        }

        let endOff;
        const textLen = codeLine.textContent.length;
        if (r.compareBoundaryPoints(Range.END_TO_END, lineRange) >= 0) {
            endOff = textLen;
        } else {
            const o = codeLineTextOffsetFromDomPoint(codeLine, r.endContainer, r.endOffset);
            if (o < 0) {
                return null;
            }
            endOff = o;
        }

        if (startOff > endOff) {
            return null;
        }
        segments.push({ codeLine: codeLine, start: startOff, end: endOff });
    }
    return segments.length ? { segments: segments } : null;
}

/** Map UTF-16 offset in codeLine.textContent to a DOM (node, offset) for Range APIs. */
function offsetToDomPointInCodeLine(codeLine, charOffset) {
    const max = codeLine.textContent.length;
    if (charOffset < 0 || charOffset > max) {
        return null;
    }
    if (max === 0) {
        return { node: codeLine, offset: 0 };
    }
    let remaining = charOffset;
    const walker = document.createTreeWalker(codeLine, NodeFilter.SHOW_TEXT, null);
    let n;
    let lastText = null;
    while ((n = walker.nextNode())) {
        lastText = n;
        const len = n.nodeValue.length;
        if (remaining < len) {
            return { node: n, offset: remaining };
        }
        if (remaining === len) {
            return { node: n, offset: remaining };
        }
        remaining -= len;
    }
    if (charOffset === max && lastText) {
        return { node: lastText, offset: lastText.nodeValue.length };
    }
    return null;
}

function restoreCodeAreaSelectionSnapshot(snapshot) {
    if (!snapshot || !snapshot.segments || snapshot.segments.length === 0) {
        return false;
    }
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) {
        return false;
    }
    const first = snapshot.segments[0];
    const last = snapshot.segments[snapshot.segments.length - 1];
    if (!first.codeLine.isConnected || !last.codeLine.isConnected) {
        return false;
    }

    const startPoint = offsetToDomPointInCodeLine(first.codeLine, first.start);
    const endPoint = offsetToDomPointInCodeLine(last.codeLine, last.end);
    if (!startPoint || !endPoint) {
        return false;
    }

    const range = document.createRange();
    try {
        range.setStart(startPoint.node, startPoint.offset);
        range.setEnd(endPoint.node, endPoint.offset);
    } catch (e) {
        return false;
    }
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return true;
}

function processSelectionForHighlight() {
    if (IS_EXPORT_MODE) return;

    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) {
        return;
    }

    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) {
        if (_selectionHighlightAllowEmptyClear) {
            clearSelectionHighlightOnly();
        }
        return;
    }

    const anchor = sel.anchorNode;
    const focus = sel.focusNode;
    const anchorEl = anchor && (anchor.nodeType === Node.TEXT_NODE ? anchor.parentElement : anchor);
    if (anchorEl && anchorEl.closest && anchorEl.closest('#search-input')) {
        return;
    }
    if (!nodeInAllowedSelectRegion(anchor) || !nodeInAllowedSelectRegion(focus)) {
        return;
    }

    const text = sel.toString().replace(/\u00a0/g, ' ').trim();
    if (!text) {
        if (_selectionHighlightAllowEmptyClear) {
            clearSelectionHighlightOnly();
        }
        return;
    }
    if (text.indexOf('\n') >= 0 || text.indexOf('\r') >= 0) {
        clearSelectionHighlightOnly();
        return;
    }
    if (text.length > SELECTION_HIGHLIGHT_MAX_LEN) {
        clearSelectionHighlightOnly();
        return;
    }

    if (text === selectionHighlightQuery) {
        return;
    }

    applySelectionHighlightFromUser(text);
}

function initializeSelectionHighlightListener() {
    document.addEventListener('selectionchange', function () {
        if (_selectionHighlightDebounceTimer !== null) {
            clearTimeout(_selectionHighlightDebounceTimer);
        }
        _selectionHighlightDebounceTimer = setTimeout(function () {
            _selectionHighlightDebounceTimer = null;
            processSelectionForHighlight();
        }, 75);
    });
}

function highlightSearchText(windowId, query, markClass) {
    if (markClass === undefined) {
        markClass = 'search-text-highlight';
    }
    if (!query || !query.trim()) return;

    const windowEl = document.getElementById(windowId);
    if (!windowEl) return;

    const codeLines = windowEl.querySelectorAll('.code-line');
    const escapedQuery = escapeRegExp(query);
    const regex = new RegExp('(' + escapedQuery + ')', 'gi');

    codeLines.forEach(codeLine => {
        // Store original HTML if not already stored
        if (!codeLine.hasAttribute('data-original-html')) {
            codeLine.setAttribute('data-original-html', codeLine.innerHTML);
        }

        const originalHtml = codeLine.getAttribute('data-original-html');

        // Replace matches in the HTML, but not inside tags
        const highlightedHtml = highlightTextInHTML(originalHtml, query, regex, markClass);
        // Only touch lines that change: replacing a line's nodes under a pressed mouse button makes
        // the click land on .code-line instead of the token (Ctrl/⌘+click on a symbol-ref then does nothing)
        if (codeLine.innerHTML !== highlightedHtml) {
            codeLine.innerHTML = highlightedHtml;
        }
    });
}

function highlightTextInHTML(html, query, regex, markClass) {
    if (markClass === undefined) {
        markClass = 'search-text-highlight';
    }
    if (!query || !query.trim()) {
        return html;
    }
    // Split HTML into alternating tags and text (visible text only; tag names/attrs are never matched).
    const parts = [];
    let lastIndex = 0;
    const tagRegex = /<[^>]+>/g;
    let match;
    while ((match = tagRegex.exec(html)) !== null) {
        if (match.index > lastIndex) {
            parts.push({ type: 'text', content: html.substring(lastIndex, match.index) });
        }
        parts.push({ type: 'tag', content: match[0] });
        lastIndex = match.index + match[0].length;
    }
    if (lastIndex < html.length) {
        parts.push({ type: 'text', content: html.substring(lastIndex) });
    }

    const qLower = query.toLowerCase();
    const qLen = query.length;

    let full = '';
    const segments = [];
    for (let i = 0; i < parts.length; i++) {
        if (parts[i].type === 'text') {
            segments.push({ partIdx: i, globalStart: full.length, text: parts[i].content });
            full += parts[i].content;
        }
    }
    const fullLower = full.toLowerCase();
    const matches = [];
    let pos = 0;
    while (pos <= full.length - qLen) {
        const idx = fullLower.indexOf(qLower, pos);
        if (idx === -1) break;
        matches.push({ start: idx, end: idx + qLen });
        pos = idx + qLen;
    }
    if (matches.length === 0) {
        return html;
    }

    const bySegment = new Map();
    for (let mi = 0; mi < matches.length; mi++) {
        const m = matches[mi];
        for (let si = 0; si < segments.length; si++) {
            const seg = segments[si];
            const segEnd = seg.globalStart + seg.text.length;
            const overlapStart = Math.max(m.start, seg.globalStart);
            const overlapEnd = Math.min(m.end, segEnd);
            if (overlapStart >= overlapEnd) continue;
            const locStart = overlapStart - seg.globalStart;
            const locEnd = overlapEnd - seg.globalStart;
            if (!bySegment.has(si)) {
                bySegment.set(si, []);
            }
            bySegment.get(si).push({ locStart: locStart, locEnd: locEnd });
        }
    }

    for (const [si, ranges] of bySegment) {
        ranges.sort(function (a, b) {
            return b.locStart - a.locStart;
        });
        const seg = segments[si];
        let text = seg.text;
        for (let ri = 0; ri < ranges.length; ri++) {
            const r = ranges[ri];
            const mid = text.substring(r.locStart, r.locEnd);
            text = text.substring(0, r.locStart) + '<mark class="' + markClass + '">' + mid + '</mark>' + text.substring(r.locEnd);
        }
        parts[seg.partIdx].content = text;
    }

    return parts.map(function (p) {
        return p.content;
    }).join('');
}

function escapeRegExp(string) {
    // Escape special regex characters
    const specials = ['\\', '.', '*', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']'];
    let result = string;
    specials.forEach(char => {
        result = result.split(char).join('\\' + char);
    });
    return result;
}

function clearTextHighlight(windowId) {
    const windowEl = document.getElementById(windowId);
    if (!windowEl) return;
    
    const codeLines = windowEl.querySelectorAll('.code-line');
    codeLines.forEach(codeLine => {
        const originalHtml = codeLine.getAttribute('data-original-html');
        // Unchanged lines are left alone (see highlightSearchText): this runs on every click that
        // collapses the selection, i.e. between mousedown and mouseup of a Ctrl/⌘+click
        if (originalHtml && codeLine.innerHTML !== originalHtml) {
            codeLine.innerHTML = originalHtml;
        }
    });
}

// ========== Commit highlight functions ==========

function showCommitHighlightDialog() {
    vscode.postMessage({
        command: 'showCommitInputDialog'
    });
}

function showWorkbenchHighlight() {
    vscode.postMessage({
        command: 'getWorkbenchChanges'
    });
}

/**
 * Build a map from new-file line number → old-file line number for unchanged lines,
 * using hunk offset accumulation.
 */
function buildOldLineMap(code, hunks) {
    const sortedHunks = hunks.slice().sort((a, b) => a.newStart - b.newStart);
    let offset = 0;
    let hunkIdx = 0;
    const oldLineMap = {};
    for (const line of code) {
        if (line.diffType) continue;
        while (hunkIdx < sortedHunks.length) {
            const h = sortedHunks[hunkIdx];
            const hunkEnd = h.newCount > 0 ? h.newStart + h.newCount - 1 : h.newStart;
            if (hunkEnd < line.line) {
                offset += h.oldCount - h.newCount;
                hunkIdx++;
            } else {
                break;
            }
        }
        oldLineMap[line.line] = line.line + offset;
    }
    return oldLineMap;
}

/**
 * Find the coverage line map for the given window by suffix-matching the window's
 * filePath against keys in currentCoverage (format: "package/path/File.java").
 * Returns the line map object { [lineNr]: {mi,ci,mb,cb} } or null if not found.
 */
function findCoverageForWindow(windowData) {
    if (!currentCoverage || !windowData.filePath) {
        return null;
    }
    const normalizedPath = windowData.filePath.replace(/\\/g, '/');
    let bestKey = null;
    let bestLen = 0;
    for (const key of Object.keys(currentCoverage)) {
        // JaCoCo key example: "com/example/app/controller/OrderController.java"
        if (normalizedPath.endsWith(key) || normalizedPath.endsWith('/' + key)) {
            if (key.length > bestLen) {
                bestLen = key.length;
                bestKey = key;
            }
        }
    }
    return bestKey ? currentCoverage[bestKey] : null;
}

/** Apply coverage overlay received from extension host. */
function applyCoverageOverlay(coverage) {
    currentCoverage = coverage;
    if (!currentData) { return; }
    const container = document.querySelector('.container');
    if (!container) { return; }
    currentData.windows.forEach(windowData => {
        const windowEl = document.getElementById(windowData.id);
        if (!windowEl) { return; }
        const codeArea = windowEl.querySelector('.code-area');
        if (codeArea) {
            rerenderCodeArea(codeArea, windowData);
        }
    });
    showToast('カバレッジ表示を適用しました', 'info');
}

/** Remove coverage overlay and revert all windows to normal rendering. */
function clearCoverageOverlay() {
    currentCoverage = null;
    if (!currentData) { return; }
    currentData.windows.forEach(windowData => {
        const windowEl = document.getElementById(windowData.id);
        if (!windowEl) { return; }
        const codeArea = windowEl.querySelector('.code-area');
        if (codeArea) {
            rerenderCodeArea(codeArea, windowData);
        }
    });
    showToast('カバレッジ表示をクリアしました', 'info');
}

/** Returns the current viewport rectangle in canvas coordinates (with buffer). */
function getCanvasViewport(buffer = VIEWPORT_BUFFER_PX) {
    return {
        left:   window.scrollX / zoomLevel - buffer,
        top:    window.scrollY / zoomLevel - buffer,
        right:  (window.scrollX + window.innerWidth)  / zoomLevel + buffer,
        bottom: (window.scrollY + window.innerHeight) / zoomLevel + buffer,
    };
}

/** Returns true if the window's bounding box intersects the current viewport (+ buffer). */
function isWindowInViewport(windowData, buffer = VIEWPORT_BUFFER_PX) {
    const pos = windowData.position;
    if (!pos) return true; // safe fallback: always render if position unknown
    const vp = getCanvasViewport(buffer);
    const wLeft   = pos.left  || 0;
    const wTop    = pos.top   || 0;
    const wRight  = wLeft + (pos.width  || 600);
    const wBottom = wTop  + (pos.height || 300);
    return !(wRight < vp.left || wLeft > vp.right || wBottom < vp.top || wTop > vp.bottom);
}

/** Populate code content for any visible-but-not-yet-rendered windows. */
function renderViewportWindows() {
    if (!currentData) return;
    currentData.windows.forEach(windowData => {
        if (windowData.visible === false) return;
        const windowElement = document.getElementById(windowData.id);
        if (!windowElement) return;
        const codeArea = windowElement.querySelector('.code-area');
        if (!codeArea || codeArea.dataset.rendered === 'true') return;
        if (isWindowInViewport(windowData)) {
            rerenderCodeArea(codeArea, windowData);
        }
    });
}

/** Schedule renderViewportWindows() on the next animation frame (debounced). */
let _viewportCheckScheduled = false;
function scheduleViewportCheck() {
    if (_viewportCheckScheduled) return;
    _viewportCheckScheduled = true;
    requestAnimationFrame(() => {
        _viewportCheckScheduled = false;
        renderViewportWindows();
        updateArrowVisibility();
    });
}

/**
 * ビューポート外の矢印を display:none にして描画コストを削減する。
 * data-from / data-to のどちらかのウィンドウがビューポート内なら表示する。
 */
function updateArrowVisibility() {
    const container = document.querySelector('.container');
    if (!container) return;
    const arrows = container.querySelectorAll('.arrow');
    if (!arrows.length) return;

    const vp = getCanvasViewport(VIEWPORT_BUFFER_PX);

    // ビューポート内ウィンドウIDの Set を DOM スタイルから構築
    const inViewSet = new Set();
    container.querySelectorAll('.code-window').forEach(el => {
        const left   = parseInt(el.style.left)   || 0;
        const top    = parseInt(el.style.top)    || 0;
        const width  = parseInt(el.style.width)  || 300;
        const height = parseInt(el.style.height) || 200;
        if (left < vp.right && left + width > vp.left &&
            top  < vp.bottom && top  + height > vp.top) {
            inViewSet.add(el.id);
        }
    });

    arrows.forEach(arrow => {
        const fromId = arrow.getAttribute('data-from');
        const toId   = arrow.getAttribute('data-to');
        arrow.style.display = (inViewSet.has(fromId) || inViewSet.has(toId)) ? '' : 'none';
    });
}

/** Render (or re-render) a codeArea element for the given windowData. */
function rerenderCodeArea(codeArea, windowData) {
    _rerenderCodeAreaCore(codeArea, windowData, null);

    // Schedule async syntax highlighting via hljs (deferred to avoid blocking initial paint)
    const hasNestedOmitCard = windowData.code.some(function (l) { return l.nestedOmitCard; });
    if (typeof hljs !== 'undefined' && windowData.code.length > 0 && !hasNestedOmitCard) {
        const wid = windowData.id;
        const schedFn = typeof requestIdleCallback === 'function' ? requestIdleCallback : function(cb) { setTimeout(cb, 0); };
        schedFn(function () {
            // Guard: window may have been removed or re-rendered
            const el = document.getElementById(wid);
            if (!el) return;
            const ca = el.querySelector('.code-area');
            if (!ca || ca.dataset.hljsApplied === wid) return;
            const win = currentData?.windows?.find(function (w) { return w.id === wid; });
            if (!win) return;

            const lang = win.language || 'plaintext';
            const safeLang = hljs.getLanguage(lang) ? lang : 'plaintext';
            try {
                const fullCode = win.code.map(function (l) { return l.content; }).join(String.fromCharCode(10));
                const highlighted = hljs.highlight(fullCode, { language: safeLang }).value;
                const split = splitHighlightedLines(highlighted);
                if (split.length === win.code.length) {
                    _rerenderCodeAreaCore(ca, win, split);
                    ca.dataset.hljsApplied = wid;
                }
            } catch (e) { /* ignore hljs errors */ }
        });
    }
}

/**
 * Core rendering logic for code area. If highlightedLines is null, renders without hljs.
 */
function _rerenderCodeAreaCore(codeArea, windowData, highlightedLines) {
    const hasDiff = !!windowData._hasDiffOverlay;
    const oldLineMap = (hasDiff && windowData._diffHunks)
        ? buildOldLineMap(windowData.code, windowData._diffHunks)
        : {};

    const coverageLineMap = currentCoverage ? findCoverageForWindow(windowData) : null;
    const refsByLine = currentData?.symbols ? groupRefsByLine(windowData.refs) : null;

    codeArea.innerHTML = windowData.code.map((line, index) => {
        let classes = 'code-line';
        if (line.diffType === 'added') classes += ' diff-added';
        else if (line.diffType === 'removed') classes += ' diff-removed';
        else if (line.highlight) classes += ' highlighted';
        if (line.hasWarning) classes += ' warning';
        if (coverageLineMap && !line.diffType) {
            const cov = coverageLineMap[line.line];
            if (cov !== undefined) {
                if (cov.ci > 0 && cov.mi === 0) {
                    classes += ' coverage-covered';
                } else if (cov.ci === 0 && cov.mi > 0) {
                    classes += ' coverage-uncovered';
                } else if (cov.ci > 0 && cov.mi > 0) {
                    classes += ' coverage-partial';
                }
            }
        }

        let content = line.content;
        let nestedOmitTitleAttr = '';
        if (line.nestedOmitCard) {
            const rawFull = line.content != null && String(line.content) !== '' ? String(line.content) : '…';
            nestedOmitTitleAttr = ` title="${escapeHtml(rawFull.trim())}"`;
            // Leading spaces can collapse in HTML; use ch-based padding so text lines up with neighbors.
            const indentCols = rawFull === '…' ? 0 : measureLeadingIndentChUnits(rawFull, 4);
            const body = rawFull === '…' ? rawFull : stripLeadingWhitespaceChars(rawFull);
            const displayBody = body.length ? body : '…';
            const padStyle = indentCols > 0 ? ` style="padding-inline-start:${indentCols}ch"` : '';
            content = `<span class="nested-omit-card-box"${padStyle}${nestedOmitTitleAttr}>${escapeHtml(displayBody)}</span>`;
            classes += ' nested-omit-card';
        } else if (content === '' || content.trim() === '') {
            content = ' ';
        } else if (highlightedLines !== null && highlightedLines[index] !== undefined) {
            content = highlightedLines[index];
            if (!content || content.trim() === '') content = ' ';
        } else if (!content.includes('<span')) {
            content = applySyntaxHighlighting(content, line.isComment);
        }

        // Refs are skipped on comment lines and on diff-removed lines (old line numbers)
        const lineRefs = (refsByLine && !line.isComment && line.diffType !== 'removed')
            ? refsByLine.get(line.line) : null;
        if (!line.nestedOmitCard && (lineRefs || currentData?._symbolKeys?.length > 0)) {
            content = decorateCodeLineTokens(content, lineRefs, currentData.symbols,
                currentData.symbolIndex, currentData._symbolKeys || []);
        }

        const commentBubbleHtml = line.comment
            ? `<div class="line-comment-bubble" data-window-id="${windowData.id}" data-line-number="${line.line}"${line.diffType ? ` data-diff-type="${line.diffType}"` : ''}>${escapeHtml(line.comment)}</div>`
            : '';

        let lineNumHtml;
        if (!hasDiff) {
            lineNumHtml = `<div class="line-number">${line.line}</div>`;
        } else if (line.diffType === 'removed') {
            lineNumHtml = `<div class="line-number-old">${line.line}</div>`
                       + `<div class="line-number-new"></div>`
                       + `<div class="diff-marker diff-marker-remove">-</div>`;
        } else if (line.diffType === 'added') {
            lineNumHtml = `<div class="line-number-old"></div>`
                       + `<div class="line-number-new">${line.line}</div>`
                       + `<div class="diff-marker diff-marker-add">+</div>`;
        } else {
            const oldLine = oldLineMap[line.line] !== undefined ? oldLineMap[line.line] : line.line;
            lineNumHtml = `<div class="line-number-old">${oldLine}</div>`
                       + `<div class="line-number-new">${line.line}</div>`
                       + `<div class="diff-marker"></div>`;
        }

        const isDiffRemoved = line.diffType === 'removed';
        const diffTypeAttr = line.diffType ? ` data-diff-type="${line.diffType}"` : '';
        const omitAttr = line.nestedOmitCard && line.omitEndLine ? ` data-omit-end-line="${line.omitEndLine}"` : '';
        const nestedOmitRowClass = line.nestedOmitCard ? ' nested-omit-row' : '';
        return `
            <div class="code-line-row${isDiffRemoved ? ' diff-removed-row' : ''}${nestedOmitRowClass}" tabindex="0" data-line-number="${line.line}" data-window-id="${windowData.id}"${isDiffRemoved ? ' data-diff-removed="true"' : ''}${diffTypeAttr}${omitAttr}>
                ${lineNumHtml}
                <div class="${classes}">${content}</div>
                <span class="code-line-call-gutter" aria-hidden="true"></span>
            </div>
            ${commentBubbleHtml}
        `;
    }).join('');

    codeArea.dataset.rendered = 'true';  // mark as populated for virtualization

    if (selectionHighlightQuery) {
        const qLower = selectionHighlightQuery.toLowerCase();
        if (getWindowText(windowData).includes(qLower)) {
            armSelectionHighlightDomQuietPeriod();
            highlightSearchText(windowData.id, selectionHighlightQuery, 'selection-text-highlight');
        }
    }

    if (searchQuery && searchMatches.includes(windowData.id)) {
        highlightSearchText(windowData.id, searchQuery);
    }

    syncViewerCallTargetMarkers();

    // Re-apply bracket guide if a row is focused after re-render
    const focusedRow = codeArea.querySelector('.code-line-row:focus');
    if (focusedRow) updateBracketGuide(focusedRow);
}

/** Restore diff overlays from saved diffState on each window (called after renderVisualization). */
function restoreDiffStates() {
    if (!currentData || !currentData.windows) return;

    // Restore _savedDiffComments from persisted data (diff was cleared but comments were saved)
    currentData.windows.forEach(win => {
        if (win.savedDiffComments && Object.keys(win.savedDiffComments).length) {
            win._savedDiffComments = win.savedDiffComments;
            delete win.savedDiffComments;
        }
    });

    let restoredCount = 0;
    currentData.windows.forEach(win => {
        if (!win.diffState || !win.diffState.hunks) return;

        const savedDiffComments = win.diffState.diffComments || {};
        const hunks = win.diffState.hunks;
        const pendingDiffState = win.diffState;
        delete win.diffState; // consumed; will be re-created by buildSaveData

        // Build a synthetic diffs entry and apply overlay
        if (!applyDiffOverlayToWindow(win, hunks)) {
            // No hunk in the window's range: keep it so saving does not drop it
            win.diffState = pendingDiffState;
            return;
        }

        // Restore diff comments
        if (Object.keys(savedDiffComments).length > 0) {
            for (const line of win.code) {
                if (line.diffType) {
                    const key = `${line.diffType}:${line.line}`;
                    if (savedDiffComments[key]) {
                        line.comment = savedDiffComments[key];
                    }
                }
            }
            // Re-render to show comment bubbles
            const windowElement = document.getElementById(win.id);
            if (windowElement) {
                const codeArea = windowElement.querySelector('.code-area');
                if (codeArea) rerenderCodeArea(codeArea, win);
            }
        }

        restoredCount++;
    });

    if (restoredCount > 0) {
        const clearBtn = document.getElementById('clear-diff-button');
        if (clearBtn) clearBtn.style.display = '';
    }
}

/**
 * Apply diff overlay to a single window using the given hunks.
 * Returns true if the overlay was applied (relevant hunks found), false otherwise.
 */
function applyDiffOverlayToWindow(win, hunks) {
    if (!win._hasDiffOverlay) {
        win._originalCode = win.code.slice();
    }

    const baseCode = win._originalCode.slice();
    const sortedHunks = hunks.slice().sort((a, b) => a.newStart - b.newStart);

    const winFirstLine = baseCode.length > 0 ? baseCode[0].line : Infinity;
    const winLastLine = baseCode.length > 0 ? baseCode[baseCode.length - 1].line : -Infinity;

    // ウィンドウの行範囲と重なるハンクのみに絞り込む
    const relevantHunks = sortedHunks.filter(hunk => {
        const insertAt = hunk.newCount > 0 ? hunk.newStart : hunk.newStart + 1;
        const addEnd = hunk.newStart + Math.max(hunk.newCount, 0);
        return addEnd >= winFirstLine && insertAt <= winLastLine + 1;
    });

    if (relevantHunks.length === 0) return false;

    win._hasDiffOverlay = true;
    win._diffHunks = hunks;

    const addedLineNums = new Set();
    for (const hunk of relevantHunks) {
        for (let i = 0; i < hunk.newCount; i++) {
            addedLineNums.add(hunk.newStart + i);
        }
    }

    const newCode = [];
    let hunkIdx = 0;

    for (const line of baseCode) {
        while (hunkIdx < relevantHunks.length) {
            const hunk = relevantHunks[hunkIdx];
            const insertBeforeLine = hunk.newCount > 0 ? hunk.newStart : hunk.newStart + 1;
            if (line.line >= insertBeforeLine) {
                let oldLineNum = hunk.oldStart;
                for (const dl of hunk.lines) {
                    if (dl.type === 'remove') {
                        newCode.push({
                            line: oldLineNum++,
                            content: dl.content,
                            diffType: 'removed',
                            highlight: false,
                            hasWarning: false,
                            isComment: false,
                            comment: undefined
                        });
                    } else {
                        oldLineNum++;
                    }
                }
                hunkIdx++;
            } else {
                break;
            }
        }
        newCode.push(addedLineNums.has(line.line)
            ? { ...line, diffType: 'added' }
            : { ...line });
    }

    win.code = newCode;

    // Restore previously saved diff comments
    const saved = win._savedDiffComments;
    if (saved) {
        for (const line of win.code) {
            if (line.diffType) {
                const key = `${line.diffType}:${line.line}`;
                if (saved[key]) line.comment = saved[key];
            }
        }
        delete win._savedDiffComments;
    }

    const windowElement = document.getElementById(win.id);
    if (windowElement) {
        const codeArea = windowElement.querySelector('.code-area');
        if (codeArea) {
            rerenderCodeArea(codeArea, win);
            const newHeight = win.fullHeight
                ? calcFullHeightWindowHeight(win)
                : calcWindowHeight(win.code.length, true);
            win.position.height = newHeight;
            windowElement.style.height = newHeight + 'px';
        }
    }

    return true;
}

/** Apply before/after diff overlay to matching windows. */
function applyDiffOverlay(diffs) {
    if (!currentData || !currentData.windows) return;

    let matchedCount = 0;

    diffs.forEach(fileDiff => {
        const { filePath, hunks } = fileDiff;

        currentData.windows.forEach(win => {
            const normalizedWindowPath = win.filePath.replace(/\\/g, '/');
            const normalizedFilePath = filePath.replace(/\\/g, '/');
            if (!normalizedWindowPath.endsWith(normalizedFilePath) &&
                !normalizedFilePath.endsWith(normalizedWindowPath)) return;

            if (applyDiffOverlayToWindow(win, hunks)) {
                matchedCount++;
            }
        });
    });

    if (matchedCount > 0) {
        saveData();
        showToast(`${matchedCount}個のウィンドウに差分を表示しました`, 'success');
        const clearBtn = document.getElementById('clear-diff-button');
        if (clearBtn) clearBtn.style.display = '';
    } else {
        showToast('該当する変更行が見つかりませんでした', 'warning');
    }
}

/** Remove diff overlay and restore original code for all windows. */
function clearDiffOverlay() {
    if (!currentData || !currentData.windows) return;

    let clearedCount = 0;
    currentData.windows.forEach(win => {
        if (!win._hasDiffOverlay) return;

        // Save diff-line comments before clearing
        const diffComments = {};
        for (const line of win.code) {
            if (line.diffType && line.comment) {
                diffComments[`${line.diffType}:${line.line}`] = line.comment;
            }
        }
        if (Object.keys(diffComments).length) {
            win._savedDiffComments = diffComments;
        }

        win.code = win._originalCode.slice();
        delete win._originalCode;
        delete win._hasDiffOverlay;
        delete win._diffHunks;
        clearedCount++;

        const windowElement = document.getElementById(win.id);
        if (windowElement) {
            const codeArea = windowElement.querySelector('.code-area');
            if (codeArea) {
                rerenderCodeArea(codeArea, win);
                const newHeight = win.fullHeight
                    ? calcFullHeightWindowHeight(win)
                    : calcWindowHeight(win.code.length, true);
                win.position.height = newHeight;
                windowElement.style.height = newHeight + 'px';
            }
        }
    });

    const clearBtn = document.getElementById('clear-diff-button');
    if (clearBtn) clearBtn.style.display = 'none';

    if (clearedCount > 0) {
        saveData();
        showToast('差分表示をクリアしました', 'success');
    }
}

function goToNextMatch() {
    if (searchMatches.length === 0) return;
    
    currentMatchIndex = (currentMatchIndex + 1) % searchMatches.length;
    highlightMatches();
    updateSearchCount(currentMatchIndex + 1, searchMatches.length);
    updateSearchNavButtons();
    scrollToMatch(searchMatches[currentMatchIndex]);
}

function goToPreviousMatch() {
    if (searchMatches.length === 0) return;
    
    currentMatchIndex = currentMatchIndex <= 0 ? searchMatches.length - 1 : currentMatchIndex - 1;
    highlightMatches();
    updateSearchCount(currentMatchIndex + 1, searchMatches.length);
    updateSearchNavButtons();
    scrollToMatch(searchMatches[currentMatchIndex]);
}

function scrollToMatch(windowId) {
    const el = document.getElementById(windowId);
    if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    }
}

function updateSearchCount(current, total) {
    const searchCount = document.getElementById('search-count');
    if (searchCount) {
        if (total === 0) {
            searchCount.textContent = 'マッチなし';
        } else {
            searchCount.textContent = current + '/' + total;
        }
    }
}

function updateSearchNavButtons() {
    const prevButton = document.getElementById('search-prev-button');
    const nextButton = document.getElementById('search-next-button');
    
    if (prevButton && nextButton) {
        const hasMatches = searchMatches.length > 0;
        prevButton.disabled = !hasMatches;
        nextButton.disabled = !hasMatches;
    }
}

function initializeDragSelection() {
    const container = document.querySelector('.container');
    if (!container) return;

    container.addEventListener('mousedown', function(e) {
        // Only start drag selection if clicking on empty space (not on a window)
        // and not in connection mode
        if (connectionMode) return;
        if (e.target.closest('.code-window')) return;
        if (e.target.closest('.toolbar')) return;

        e.preventDefault();
        isSelecting = true;
        
        // Get coordinates relative to container
        const containerRect = container.getBoundingClientRect();
        selectionStart = {
            x: (e.clientX - containerRect.left) / zoomLevel,
            y: (e.clientY - containerRect.top) / zoomLevel
        };

        // Create selection box
        selectionBox = document.createElement('div');
        selectionBox.className = 'selection-box';
        selectionBox.style.left = selectionStart.x + 'px';
        selectionBox.style.top = selectionStart.y + 'px';
        selectionBox.style.width = '0px';
        selectionBox.style.height = '0px';
        container.appendChild(selectionBox);

        // Clear previous selection unless Shift is held
        if (!e.shiftKey) {
            clearSelection();
        }
    });

    document.addEventListener('mousemove', function(e) {
        if (!isSelecting || !selectionBox || !selectionStart) return;

        const containerRect = container.getBoundingClientRect();
        const currentX = (e.clientX - containerRect.left) / zoomLevel;
        const currentY = (e.clientY - containerRect.top) / zoomLevel;

        // Calculate selection box bounds
        const left = Math.min(selectionStart.x, currentX);
        const top = Math.min(selectionStart.y, currentY);
        const width = Math.abs(currentX - selectionStart.x);
        const height = Math.abs(currentY - selectionStart.y);

        selectionBox.style.left = left + 'px';
        selectionBox.style.top = top + 'px';
        selectionBox.style.width = width + 'px';
        selectionBox.style.height = height + 'px';

        // Check which windows are inside the selection box
        const selectionRect = {
            left: left,
            top: top,
            right: left + width,
            bottom: top + height
        };

        if (currentData) {
            currentData.windows.forEach(w => {
                const windowEl = document.getElementById(w.id);
                if (!windowEl) return;

                const wLeft = parseInt(windowEl.style.left) || 0;
                const wTop = parseInt(windowEl.style.top) || 0;
                const wWidth = parseInt(windowEl.style.width) || 0;
                const wHeight = windowEl.classList.contains('collapsed') ? 33 : (parseInt(windowEl.style.height) || 0);

                // Check if window intersects with selection box
                const intersects = !(
                    wLeft > selectionRect.right ||
                    wLeft + wWidth < selectionRect.left ||
                    wTop > selectionRect.bottom ||
                    wTop + wHeight < selectionRect.top
                );

                if (intersects) {
                    if (!selectedWindows.has(w.id)) {
                        selectedWindows.add(w.id);
                        windowEl.classList.add('selected');
                    }
                } else if (!e.shiftKey) {
                    // Only remove from selection if Shift is not held
                    if (selectedWindows.has(w.id)) {
                        selectedWindows.delete(w.id);
                        windowEl.classList.remove('selected');
                    }
                }
            });
            updateDeleteButtonState();
        }
    });

    document.addEventListener('mouseup', function(e) {
        if (isSelecting) {
            isSelecting = false;
            if (selectionBox && selectionBox.parentNode) {
                selectionBox.parentNode.removeChild(selectionBox);
            }
            selectionBox = null;
            selectionStart = null;
        }
    });
}

/**
 * Relayout windows to close gaps caused by collapsed windows
 * Groups windows by column (X position) and repositions them vertically
 */
function relayoutWindows() {
    if (!currentData || currentData.windows.length === 0) return;

    // Filter only visible windows
    const visibleWindows = currentData.windows.filter(w => w.visible !== false);
    if (visibleWindows.length === 0) return;

    if (hasCanvasGroups(currentData)) {
        // Change Set Canvas: per-group column layout, groups stacked in `groups` order
        layoutGroupedWindows(visibleWindows, currentData.connections, currentData.groups);
        visibleWindows.forEach(w => {
            const element = document.getElementById(w.id);
            if (element) {
                element.style.left = w.position.left + 'px';
                element.style.top = w.position.top + 'px';
            }
        });
    } else {
        relayoutColumnTops(visibleWindows, currentData.connections, currentData.windows);
        visibleWindows.forEach(w => {
            const element = document.getElementById(w.id);
            if (element) {
                element.style.top = w.position.top + 'px';
            }
        });
    }

    // Update arrows to follow window positions
    updateArrows();

    // Update container size after relayout
    updateContainerSize(false);
    scheduleViewportCheck();
}

/**
 * Column-based Y relayout (barycenter + call order). Mutates `position.top` of `visibleWindows`
 * (DOM is not touched). `allWindows` resolves the parents' _layoutOrderWithinLevel.
 */
function relayoutColumnTops(visibleWindows, connections, allWindows) {
    const COLLAPSED_HEIGHT = 33;
    const WINDOW_SPACING = 20;
    const COLUMN_TOLERANCE = 50; // Windows within this X range are considered same column

    // Build Map for O(1) lookups (avoids repeated O(n) find() calls)
    const windowMap = new Map(visibleWindows.map(w => [w.id, w]));

    // Build parent map from connections (from -> to means 'from' is parent of 'to')
    // Exclude self-references (recursive calls)
    const parentMap = new Map(); // windowId -> [parentWindowIds]
    const childMap = new Map(); // windowId -> [childWindowIds]
    const callOrderMap = new Map(); // parentId -> Map(childId -> order)

    // Break cycles the same way applyAutoLayout does. Without this, a mutual
    // recursion cycle (e.g. a framework base-class delegation that re-dispatches
    // back into the entry method) makes the root a "child" of a deep node, so the
    // barycenter / _minY logic drags the entry window far down instead of pinning
    // it at the top.
    const backEdgeSet = detectBackEdgeSet(visibleWindows.map(w => w.id), connections);

    if (connections) {
        connections.forEach((conn, idx) => {
            // Skip self-references and cycle-closing back edges
            if (conn.from === conn.to) return;
            if (backEdgeSet.has(conn.from + '\0' + conn.to)) return;


            if (!parentMap.has(conn.to)) {
                parentMap.set(conn.to, []);
            }
            parentMap.get(conn.to).push(conn.from);
            
            if (!childMap.has(conn.from)) {
                childMap.set(conn.from, []);
            }
            childMap.get(conn.from).push(conn.to);
            
            // Record call order: use callLine if available, otherwise use connection index
            const order = (typeof conn.callLine === 'number' && conn.callLine > 0)
                ? conn.callLine
                : idx + 1_000_000;
            if (!callOrderMap.has(conn.from)) {
                callOrderMap.set(conn.from, new Map());
            }
            callOrderMap.get(conn.from).set(conn.to, order);
        });
    }
    
    // Composite key: parent _layoutOrderWithinLevel (from applyAutoLayout) + callLine — not pixel top
    const PARENT_ORDER_SCALE = 100_000_000;
    const windowCallOrder = new Map();
    visibleWindows.forEach((w, originalIdx) => {
        const parents = parentMap.get(w.id) || [];
        let minCompositeOrder = Number.POSITIVE_INFINITY;
        for (const parentId of parents) {
            const parentChildMap = callOrderMap.get(parentId);
            if (parentChildMap) {
                const callLine = parentChildMap.get(w.id);
                if (callLine !== undefined) {
                    const parentWindow = allWindows.find(pw => pw.id === parentId);
                    let parentRank = parentWindow && typeof parentWindow._layoutOrderWithinLevel === 'number'
                        ? parentWindow._layoutOrderWithinLevel
                        : -1;
                    if (parentRank < 0) {
                        parentRank = allWindows.findIndex(pw => pw.id === parentId);
                        if (parentRank < 0) {
                            parentRank = 999999;
                        }
                    }
                    const compositeOrder = parentRank * PARENT_ORDER_SCALE + callLine;
                    if (compositeOrder < minCompositeOrder) {
                        minCompositeOrder = compositeOrder;
                    }
                }
            }
        }
        if (minCompositeOrder === Number.POSITIVE_INFINITY) {
            minCompositeOrder = originalIdx + 10_000_000;
        }
        windowCallOrder.set(w.id, minCompositeOrder);
    });

    // Helper function to get window's actual height
    const getWindowHeight = (window) => {
        if (window.collapsed === true) return COLLAPSED_HEIGHT;
        if (window.fullHeight === true) return calcFullHeightWindowHeight(window);
        return window.position?.height || SETTINGS.minWindowHeight;
    };

    // Helper function to get window's center Y position
    const getWindowCenterY = (window) => {
        const height = getWindowHeight(window);
        return (window.position.top || 0) + height / 2;
    };

    // Group visible windows by column (based on left position)
    // Use sorted array + binary search for O(n log n) instead of O(n × columns)
    const columns = new Map();
    const sortedColXs = [];  // kept sorted for binary search

    visibleWindows.forEach(window => {
        const left = window.position.left || 0;

        // Binary search for nearest column within tolerance
        let foundColumn = null;
        let lo = 0, hi = sortedColXs.length - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (Math.abs(sortedColXs[mid] - left) < COLUMN_TOLERANCE) {
                foundColumn = sortedColXs[mid];
                break;
            }
            if (sortedColXs[mid] < left) lo = mid + 1;
            else hi = mid - 1;
        }
        // Also check neighbours (tolerance may span the binary search boundary)
        if (foundColumn === null && lo < sortedColXs.length && Math.abs(sortedColXs[lo] - left) < COLUMN_TOLERANCE) {
            foundColumn = sortedColXs[lo];
        }
        if (foundColumn === null && lo > 0 && Math.abs(sortedColXs[lo - 1] - left) < COLUMN_TOLERANCE) {
            foundColumn = sortedColXs[lo - 1];
        }

        if (foundColumn !== null) {
            columns.get(foundColumn).push(window);
        } else {
            columns.set(left, [window]);
            // Insert into sorted array at correct position
            let ins = 0, ihi = sortedColXs.length;
            while (ins < ihi) {
                const m = (ins + ihi) >> 1;
                if (sortedColXs[m] < left) ins = m + 1;
                else ihi = m;
            }
            sortedColXs.splice(ins, 0, left);
        }
    });

    // Sort columns by X position (left to right)
    const sortedColumnKeys = [...columns.keys()].sort((a, b) => a - b);

    // Run multiple iterations with forward and backward passes to minimize crossings
    const ITERATIONS = 4;
    for (let iteration = 0; iteration < ITERATIONS; iteration++) {
    
    // Forward pass: left to right, use parent positions
    sortedColumnKeys.forEach((columnX, columnIndex) => {
        const windowsInColumn = columns.get(columnX);
        
        // For each window, calculate barycenter based on parent positions
        windowsInColumn.forEach(window => {
            const parents = parentMap.get(window.id) || [];
            
            if (parents.length > 0) {
                let totalCenterY = 0;
                let validParentCount = 0;
                
                parents.forEach(parentId => {
                    const parentWindow = windowMap.get(parentId);
                    if (parentWindow) {
                        totalCenterY += getWindowCenterY(parentWindow);
                        validParentCount++;
                    }
                });
                
                if (validParentCount > 0) {
                    window._barycenter = totalCenterY / validParentCount;
                } else {
                    window._barycenter = getWindowCenterY(window);
                }
            } else {
                window._barycenter = getWindowCenterY(window);
            }
        });

        // Sort by call order (primary) then barycenter (secondary)
        windowsInColumn.sort((a, b) => {
            const orderA = windowCallOrder.get(a.id) ?? Number.POSITIVE_INFINITY;
            const orderB = windowCallOrder.get(b.id) ?? Number.POSITIVE_INFINITY;
            if (orderA !== orderB) {
                return orderA - orderB;
            }
            return (a._barycenter || 0) - (b._barycenter || 0);
        });
    });

    // Backward pass: right to left, use child positions
    for (let i = sortedColumnKeys.length - 1; i >= 0; i--) {
        const columnX = sortedColumnKeys[i];
        const windowsInColumn = columns.get(columnX);
        
        // For each window, calculate barycenter based on child positions
        windowsInColumn.forEach(window => {
            const children = childMap.get(window.id) || [];
            const parents = parentMap.get(window.id) || [];
            
            let totalCenterY = 0;
            let count = 0;
            
            // Consider both parents and children for barycenter
            children.forEach(childId => {
                const childWindow = windowMap.get(childId);
                if (childWindow) {
                    totalCenterY += getWindowCenterY(childWindow);
                    count++;
                }
            });

            parents.forEach(parentId => {
                const parentWindow = windowMap.get(parentId);
                if (parentWindow) {
                    totalCenterY += getWindowCenterY(parentWindow);
                    count++;
                }
            });
            
            if (count > 0) {
                window._barycenter = totalCenterY / count;
                } else {
                window._barycenter = getWindowCenterY(window);
            }
        });

        // Sort by call order (primary) then barycenter (secondary)
        windowsInColumn.sort((a, b) => {
            const orderA = windowCallOrder.get(a.id) ?? Number.POSITIVE_INFINITY;
            const orderB = windowCallOrder.get(b.id) ?? Number.POSITIVE_INFINITY;
            if (orderA !== orderB) {
                return orderA - orderB;
            }
            return (a._barycenter || 0) - (b._barycenter || 0);
        });
    }

    // Apply positions based on sorted order
    sortedColumnKeys.forEach((columnX, columnIndex) => {
        const windowsInColumn = columns.get(columnX);
        
        // Calculate minimum Y for windows with parents (should not go above topmost parent)
        windowsInColumn.forEach(window => {
            const parents = parentMap.get(window.id) || [];
            if (parents.length > 0) {
                // Find the topmost parent's Y position
                let minParentY = Infinity;
                parents.forEach(parentId => {
                    const parentWindow = windowMap.get(parentId);
                    if (parentWindow) {
                        const parentTop = parentWindow.position.top || 40;
                        if (parentTop < minParentY) {
                            minParentY = parentTop;
                        }
                    }
                });
                if (minParentY !== Infinity) {
                    window._minY = minParentY;
                }
            }
        });
        
        // Sort windows by call order (primary), then effective position (secondary)
        windowsInColumn.sort((a, b) => {
            // Primary: call order
            const orderA = windowCallOrder.get(a.id) ?? Number.POSITIVE_INFINITY;
            const orderB = windowCallOrder.get(b.id) ?? Number.POSITIVE_INFINITY;
            if (orderA !== orderB) {
                return orderA - orderB;
            }
            
            // Secondary: effective position (considering minY constraint)
            const aMin = a._minY || 0;
            const bMin = b._minY || 0;
            const aBarycenter = a._barycenter || 0;
            const bBarycenter = b._barycenter || 0;
            
            // Use the effective position (max of minY and barycenter)
            const aEffective = Math.max(aMin, aBarycenter);
            const bEffective = Math.max(bMin, bBarycenter);
            
            return aEffective - bEffective;
        });
        
        // Align with applyAutoLayout START_Y (toolbar clearance)
        let currentY = 80;
        
        windowsInColumn.forEach((window, index) => {
            // Apply minimum Y constraint - don't go above any parent
            if (window._minY !== undefined) {
                currentY = Math.max(currentY, window._minY);
            }
            
            window.position.top = currentY;
            
            // Calculate next Y position
            const actualHeight = getWindowHeight(window);
            currentY = currentY + actualHeight + WINDOW_SPACING;
            
            // Clean up temporary properties
            delete window._barycenter;
            delete window._minY;
        });
    });
    
    } // End of iterations
}

function updateContainerSize(allowShift = true) {
    if (!currentData) return;

    const container = document.querySelector('.container');
    const PADDING = 100; // Extra padding around windows

    let minX = 0;
    let minY = 0;
    let maxX = 0;
    let maxY = 0;

    // Find the bounds of all windows
    currentData.windows.forEach(window => {
        const pos = window.position;
        const left = pos.left || 0;
        const top = pos.top || 0;
        const right = left + pos.width;
        const bottom = top + pos.height;

        minX = Math.min(minX, left);
        minY = Math.min(minY, top);
        maxX = Math.max(maxX, right);
        maxY = Math.max(maxY, bottom);
    });

    // Calculate required container size with padding
    const requiredWidth = maxX - minX + (PADDING * 2);
    const requiredHeight = maxY - minY + (PADDING * 2);

    // Set minimum size
    const finalWidth = Math.max(requiredWidth, 2400);
    const finalHeight = Math.max(requiredHeight, 1200);

    container.style.width = finalWidth + 'px';
    container.style.minHeight = finalHeight + 'px';

    // If windows are in negative coordinates, shift them (only if allowed)
    if (allowShift && (minX < 0 || minY < 0)) {
        const shiftX = minX < 0 ? -minX + PADDING : 0;
        const shiftY = minY < 0 ? -minY + PADDING : 0;

        currentData.windows.forEach(window => {
            if (shiftX > 0) {
                window.position.left = (window.position.left || 0) + shiftX;
                const element = document.getElementById(window.id);
                if (element) {
                    element.style.left = window.position.left + 'px';
                }
            }
            if (shiftY > 0) {
                window.position.top = window.position.top + shiftY;
                const element = document.getElementById(window.id);
                if (element) {
                    element.style.top = window.position.top + 'px';
                }
            }
        });

        // Update arrows after shifting
        updateArrows();
    }
}

/**
 * Detect back edges (cycle-closing edges) via iterative DFS so callers can
 * break cycles. `nodeIds` must be iterable in a stable order with the entry /
 * root node first, so the edge flagged as a "back edge" is the one that closes
 * the cycle onto an earlier-visited ancestor (e.g. a framework base-class
 * delegation that re-dispatches back into the entry method), not the forward
 * edge out of the root. Returns a Set of `${from}\0${to}` keys.
 */
function detectBackEdgeSet(nodeIds, connections) {
    const adjacencyMap = new Map();
    const nodeSet = new Set();
    nodeIds.forEach(id => {
        adjacencyMap.set(id, []);
        nodeSet.add(id);
    });
    if (connections) {
        connections.forEach(conn => {
            if (conn.from === conn.to) return; // self-recursion never closes a layout cycle
            if (!adjacencyMap.has(conn.from) || !nodeSet.has(conn.to)) return;
            adjacencyMap.get(conn.from).push(conn.to);
        });
    }

    const backEdgeSet = new Set();
    const dfsVisited = new Set();
    const dfsInStack = new Set();
    for (const startNode of nodeSet) {
        if (dfsVisited.has(startNode)) continue;
        const stack = [[startNode, 0]];
        dfsVisited.add(startNode);
        dfsInStack.add(startNode);
        while (stack.length > 0) {
            const top = stack[stack.length - 1];
            const node = top[0];
            const idx = top[1];
            const neighbors = adjacencyMap.get(node);
            if (idx >= neighbors.length) {
                stack.pop();
                dfsInStack.delete(node);
            } else {
                top[1]++;
                const neighbor = neighbors[idx];
                if (dfsInStack.has(neighbor)) {
                    backEdgeSet.add(node + '\0' + neighbor);
                } else if (!dfsVisited.has(neighbor)) {
                    dfsVisited.add(neighbor);
                    dfsInStack.add(neighbor);
                    stack.push([neighbor, 0]);
                }
            }
        }
    }
    return backEdgeSet;
}

/**
 * Apply automatic layout to windows based on connections
 */
function applyAutoLayout(data) {
    // Check if manual positioning is disabled or positions are missing
    const needsAutoLayout = data.windows.some(w => !w.position || data.autoLayout === true);

    if (!needsAutoLayout && data.autoLayout !== true) {
        return data;
    }

    // Normalize first so height / nestedOmissions match what relayout and stacking use
    const work = {
        ...data,
        windows: data.windows.map(w => normalizeWindowData({ ...w }))
    };

    // Change Set Canvas: column layout per group (island / block's direct windows), groups stacked
    if (hasCanvasGroups(work)) {
        layoutGroupedWindows(work.windows, work.connections, work.groups);
        return work;
    }

    // Build adjacency map from connections
    const adjacencyMap = new Map();
    const inDegree = new Map();
    const allNodes = new Set();
    const windowIndexMap = new Map();
    const childOrderMap = new Map(); // 親→子の呼び出し順（callLine優先）

    // Initialize
    work.windows.forEach((w, idx) => {
        adjacencyMap.set(w.id, []);
        inDegree.set(w.id, 0);
        allNodes.add(w.id);
        windowIndexMap.set(w.id, idx);
    });

    // Build graph and remember per-parent call order
    if (work.connections) {
        work.connections.forEach((conn, idx) => {
            // Skip self-references (recursive calls) - they don't affect level calculation
            if (conn.from === conn.to) return;

            adjacencyMap.get(conn.from).push(conn.to);
            inDegree.set(conn.to, inDegree.get(conn.to) + 1);

            // orderValue: callLine があればそれを優先、なければ connections の出現順
            const orderValue = (typeof conn.callLine === 'number' && conn.callLine > 0)
                ? conn.callLine
                : idx + 1_000_000; // callLine 未設定でも安定したソートになるようシフト
            if (!childOrderMap.has(conn.from)) {
                childOrderMap.set(conn.from, new Map());
            }
            childOrderMap.get(conn.from).set(conn.to, orderValue);
        });
    }

    // Detect back edges via iterative DFS to break cycles for Kahn's algorithm.
    // Node order (work.windows) puts the entry/root first so the cycle-closing
    // edge is the one flagged, keeping the root at level 0.
    const backEdgeSet = detectBackEdgeSet(work.windows.map(w => w.id), work.connections);

    // Recalculate inDegree excluding back edges
    if (backEdgeSet.size > 0) {
        work.windows.forEach(w => inDegree.set(w.id, 0));
        if (work.connections) {
            work.connections.forEach(conn => {
                if (conn.from === conn.to) return;
                if (!backEdgeSet.has(conn.from + '\0' + conn.to)) {
                    inDegree.set(conn.to, inDegree.get(conn.to) + 1);
                }
            });
        }
    }

    // Calculate levels using topological sort
    const levels = new Map();
    const queue = [];

    // Start with nodes that have no incoming edges
    for (const [node, degree] of inDegree) {
        if (degree === 0) {
            queue.push(node);
            levels.set(node, 0);
        }
    }

    // BFS to assign levels
    while (queue.length > 0) {
        const current = queue.shift();
        const currentLevel = levels.get(current);

        adjacencyMap.get(current).forEach(neighbor => {
            if (backEdgeSet.has(current + '\0' + neighbor)) return;

            const newLevel = currentLevel + 1;
            if (!levels.has(neighbor) || levels.get(neighbor) < newLevel) {
                levels.set(neighbor, newLevel);
            }

            inDegree.set(neighbor, inDegree.get(neighbor) - 1);
            if (inDegree.get(neighbor) === 0) {
                queue.push(neighbor);
            }
        });
    }

    // Handle disconnected nodes
    allNodes.forEach(node => {
        if (!levels.has(node)) {
            levels.set(node, 0);
        }
    });

    // Build reverse adjacency map (for incoming edges)
    const reverseAdjacencyMap = new Map();
    work.windows.forEach(w => {
        reverseAdjacencyMap.set(w.id, []);
    });
    if (work.connections) {
        work.connections.forEach(conn => {
            // Skip self-references
            if (conn.from === conn.to) return;
            if (reverseAdjacencyMap.has(conn.to)) {
            reverseAdjacencyMap.get(conn.to).push(conn.from);
            }
        });
    }

    // Group windows by level (using push to maintain reference)
    const windowsByLevel = new Map();
    work.windows.forEach(w => {
        const level = levels.get(w.id) || 0;
        if (!windowsByLevel.has(level)) {
            windowsByLevel.set(level, []);
        }
        windowsByLevel.get(level).push(w);
    });

    // Sort each level using parent's order-within-level (from previous passes) + callLine.
    // Avoid parentTop * scale — that made first layout differ from post-relayout (pixel-dependent).
    const windowSortKey = new Map();
    const orderWithinLevelById = new Map();
    const PARENT_ORDER_SCALE = 100_000_000; // > any callLine-based orderValue used above
    const maxLevels = Math.max(...levels.values(), 0);

    for (let level = 0; level <= maxLevels; level++) {
        const windowsInLevel = windowsByLevel.get(level);
        if (!windowsInLevel || windowsInLevel.length === 0) continue;

        windowsInLevel.forEach((w, originalIdx) => {
            const parents = reverseAdjacencyMap.get(w.id) || [];
            let minCompositeOrder = Number.POSITIVE_INFINITY;
            for (const parentId of parents) {
                const parentChildMap = childOrderMap.get(parentId);
                if (parentChildMap) {
                    const callLine = parentChildMap.get(w.id);
                    if (callLine !== undefined) {
                        const parentOrder = orderWithinLevelById.get(parentId);
                        if (parentOrder !== undefined) {
                            const compositeOrder = parentOrder * PARENT_ORDER_SCALE + callLine;
                            if (compositeOrder < minCompositeOrder) {
                                minCompositeOrder = compositeOrder;
                            }
                        }
                    }
                }
            }
            if (minCompositeOrder === Number.POSITIVE_INFINITY) {
                const windowIdx = windowIndexMap.get(w.id) ?? originalIdx;
                minCompositeOrder = windowIdx + 10_000_000;
            }
            windowSortKey.set(w.id, minCompositeOrder);
        });

        if (windowsInLevel.length > 1) {
            windowsInLevel.sort((a, b) => {
                const keyA = windowSortKey.get(a.id) ?? Number.POSITIVE_INFINITY;
                const keyB = windowSortKey.get(b.id) ?? Number.POSITIVE_INFINITY;
                if (keyA !== keyB) {
                    return keyA - keyB;
                }
                const idxA = windowIndexMap.get(a.id) ?? Number.POSITIVE_INFINITY;
                const idxB = windowIndexMap.get(b.id) ?? Number.POSITIVE_INFINITY;
                return idxA - idxB;
            });
        }
        windowsInLevel.forEach((w, idx) => {
            orderWithinLevelById.set(w.id, idx);
        });
    }

    // Layout parameters
    const DEFAULT_WIDTH = SETTINGS.windowWidth;
    const LEVEL_GAP = 100;  // Gap between columns
    const WINDOW_SPACING = 20;  // Vertical spacing between windows
    const START_X = 40;
    const START_Y = 80;  // Increased to avoid toolbar overlap
    const COLLAPSED_HEIGHT = 33;  // Height of collapsed window

    // Get actual window height based on collapsed state
    const getWindowHeight = (w) => {
        if (w.collapsed === true) return COLLAPSED_HEIGHT;
        if (w.fullHeight === true) return calcFullHeightWindowHeight(w);
        return w.position?.height || SETTINGS.minWindowHeight;
    };

    // Calculate maximum width for each level
    const levelMaxWidths = new Map();
    for (const [level, windows] of windowsByLevel) {
        const maxWidth = Math.max(...windows.map(w => w.position?.width || DEFAULT_WIDTH));
        levelMaxWidths.set(level, maxWidth);
    }

    // Calculate Y positions for each level, considering actual window heights
    const levelYPositions = new Map();  // level -> Map(windowId -> y)
    
    for (const [level, windows] of windowsByLevel) {
        const yPositions = new Map();
        let currentY = START_Y;
        
        windows.forEach((w, index) => {
            yPositions.set(w.id, currentY);
            currentY += getWindowHeight(w) + WINDOW_SPACING;
        });
        
        levelYPositions.set(level, yPositions);
    }

    // Calculate cumulative X positions for each level
    const levelXPositions = new Map();
    let cumulativeX = START_X;
    const maxLevelForX = Math.max(...levels.values(), 0);
    for (let level = 0; level <= maxLevelForX; level++) {
        levelXPositions.set(level, cumulativeX);
        const levelWidth = levelMaxWidths.get(level) || DEFAULT_WIDTH;
        cumulativeX += levelWidth + LEVEL_GAP;
    }

    // Apply positions
    const newWindows = work.windows.map((w, idx) => {
        const level = levels.get(w.id) || 0;
        const yPositions = levelYPositions.get(level);
        const y = yPositions?.get(w.id) ?? START_Y;

        // Calculate position using cumulative X
        const x = levelXPositions.get(level) ?? START_X;

        return {
            ...w,
            _layoutOrderWithinLevel: orderWithinLevelById.get(w.id),
            position: {
                top: y,
                left: x,
                width: w.position?.width || DEFAULT_WIDTH,  // Preserve existing width if set
                height: w.position?.height  // Height from normalizeWindowData above
            }
        };
    });

    return {
        ...work,
        windows: newWindows
    };
}

// ---- Change Set Canvas (groups / windowType / change) ----

/** True when the canvas carries Change Set groups (blocks / islands). */
function hasCanvasGroups(data) {
    return !!(data && Array.isArray(data.groups) && data.groups.length > 0);
}

/** Change Set Canvas (metadata.changeSet): not a call-hierarchy root, so it is never root re-analysed. */
function isChangeSetCanvas(data) {
    const meta = data && data.metadata;
    return !!(meta && typeof meta === 'object' && !Array.isArray(meta) &&
        meta.changeSet && typeof meta.changeSet === 'object');
}

/** Geometry shared by the grouped layout and the frame drawing (frames must enclose what the layout placed). */
function groupLayoutMetrics() {
    return {
        startX: 40,        // = applyAutoLayout START_X
        startY: 80,        // = applyAutoLayout START_Y
        pad: 16,           // frame padding (left / right / bottom)
        labelHeight: 28,   // frame label band above the members
        islandGap: 28,     // between units (islands / a block's direct windows) inside a block
        blockGap: 56,      // between blocks
        collapsedHeight: 33
    };
}

/**
 * Order the windows into blocks → units in `groups` order. A unit is an island (kind "island" whose
 * `parent` is a known non-island group) or the block's direct windows (`group` = block id), placed after
 * its islands. An island with an unknown parent is treated as a block of its own. Windows with no / an
 * unknown `group` go to a trailing unframed block. Units / blocks without windows are dropped.
 * @returns {Array<{group: object|null, units: Array<{group: object|null, windows: object[]}>}>}
 */
function buildGroupLayoutPlan(groups, windows) {
    const list = Array.isArray(groups) ? groups.filter(g => g && typeof g.id === 'string') : [];
    const byId = new Map(list.map(g => [g.id, g]));
    const isIsland = g => g.kind === 'island' && typeof g.parent === 'string' &&
        byId.has(g.parent) && byId.get(g.parent).kind !== 'island';
    const members = new Map();
    const ungrouped = [];
    windows.forEach(w => {
        if (w.group && byId.has(w.group)) {
            if (!members.has(w.group)) members.set(w.group, []);
            members.get(w.group).push(w);
        } else {
            ungrouped.push(w);
        }
    });
    const blocks = [];
    list.forEach(g => {
        if (isIsland(g)) return;
        const units = [];
        list.forEach(island => {
            if (!isIsland(island) || island.parent !== g.id) return;
            const ws = members.get(island.id) || [];
            if (ws.length > 0) units.push({ group: island, windows: ws });
        });
        const direct = members.get(g.id) || [];
        if (direct.length > 0) units.push({ group: null, windows: direct });
        if (units.length > 0) blocks.push({ group: g, units });
    });
    if (ungrouped.length > 0) blocks.push({ group: null, units: [{ group: null, windows: ungrouped }] });
    return blocks;
}

/** Rendered height of a window for grouped layout / frames (collapsed → title bar only). */
function groupWindowHeight(w, collapsedHeight) {
    if (w.collapsed === true) return collapsedHeight;
    if (w.fullHeight === true) return calcFullHeightWindowHeight(w);
    return (w.position && w.position.height) || SETTINGS.minWindowHeight;
}

/**
 * Lay out one unit with the existing column layout (applyAutoLayout levels → relayoutColumnTops),
 * then move it so its top-left is (left, top). Mutates the windows' position; returns the bottom edge.
 */
function layoutGroupUnit(unitWindows, connections, left, top) {
    const M = groupLayoutMetrics();
    const ids = new Set(unitWindows.map(w => w.id));
    const conns = (connections || []).filter(c => ids.has(c.from) && ids.has(c.to));
    const levelled = applyAutoLayout({
        windows: unitWindows.map(w => ({ ...w, position: { ...(w.position || {}) } })),
        connections: conns,
        autoLayout: true
    });
    // Heights stay the windows' own (resized / diff overlay); only level X and order come from applyAutoLayout
    const clones = unitWindows.map((w, i) => ({
        ...w,
        position: {
            ...(w.position || {}),
            left: levelled.windows[i].position.left,
            top: levelled.windows[i].position.top
        },
        _layoutOrderWithinLevel: levelled.windows[i]._layoutOrderWithinLevel
    }));
    relayoutColumnTops(clones, conns, clones);
    const minLeft = Math.min(...clones.map(c => c.position.left));
    const minTop = Math.min(...clones.map(c => c.position.top));
    let bottom = top;
    unitWindows.forEach((w, i) => {
        const c = clones[i];
        if (!w.position) w.position = {};
        w.position.left = left + (c.position.left - minLeft);
        w.position.top = top + (c.position.top - minTop);
        if (!w.position.width) w.position.width = SETTINGS.windowWidth;
        w._layoutOrderWithinLevel = c._layoutOrderWithinLevel;
        bottom = Math.max(bottom, w.position.top + groupWindowHeight(w, M.collapsedHeight));
    });
    return bottom;
}

/**
 * Change Set Canvas layout: each unit (island / a block's direct windows) gets the existing column
 * layout; units are stacked inside their block and blocks are stacked in `groups` order, leaving room
 * for the frames computeGroupFrames draws. Mutates the windows' position.
 */
function layoutGroupedWindows(windows, connections, groups) {
    const M = groupLayoutMetrics();
    const plan = buildGroupLayoutPlan(groups, windows);
    let y = M.startY;
    plan.forEach(block => {
        const framed = !!block.group;
        let cursor = framed ? y + M.labelHeight : y;
        let bottom = cursor;
        block.units.forEach(unit => {
            const islandFramed = !!unit.group;
            const left = M.startX + (framed ? M.pad : 0) + (islandFramed ? M.pad : 0);
            // island frames carry no label, so only the padding sits above their members
            const top = cursor + (islandFramed ? M.pad : 0);
            const unitBottom = layoutGroupUnit(unit.windows, connections, left, top);
            bottom = unitBottom + (islandFramed ? M.pad : 0);
            cursor = bottom + M.islandGap;
        });
        y = bottom + (framed ? M.pad : 0) + M.blockGap;
    });
    return windows;
}

/**
 * Frames for the visible windows' current positions: an island frame encloses its members, a block
 * frame encloses its direct windows and island frames. Blocks come before their islands (paint order).
 * @returns {Array<{id, kind, label, parent, depth, left, top, width, height, windowCount}>}
 */
function computeGroupFrames(groups, windows) {
    const M = groupLayoutMetrics();
    const visible = (windows || []).filter(w => w.visible !== false && w.position);
    const plan = buildGroupLayoutPlan(groups, visible);
    const union = (a, b) => !a ? b : {
        left: Math.min(a.left, b.left), top: Math.min(a.top, b.top),
        right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom)
    };
    const boxOf = ws => ws.reduce((acc, w) => union(acc, {
        left: w.position.left || 0,
        top: w.position.top || 0,
        right: (w.position.left || 0) + (w.position.width || SETTINGS.windowWidth),
        bottom: (w.position.top || 0) + groupWindowHeight(w, M.collapsedHeight)
    }), null);
    const frameOf = (g, box, depth, parent, count) => ({
        id: g.id,
        kind: g.kind,
        label: g.label != null ? String(g.label) : g.id,
        parent: parent,
        depth: depth,
        left: box.left - M.pad,
        top: box.top - (depth > 0 ? M.pad : M.labelHeight),
        width: box.right - box.left + M.pad * 2,
        height: box.bottom - box.top + (depth > 0 ? M.pad : M.labelHeight) + M.pad,
        windowCount: count
    });
    const frames = [];
    plan.forEach(block => {
        if (!block.group) return;
        const islands = [];
        let box = null;
        let count = 0;
        block.units.forEach(unit => {
            const ub = boxOf(unit.windows);
            count += unit.windows.length;
            if (unit.group) {
                const f = frameOf(unit.group, ub, 1, block.group.id, unit.windows.length);
                islands.push(f);
                box = union(box, { left: f.left, top: f.top, right: f.left + f.width, bottom: f.top + f.height });
            } else {
                box = union(box, ub);
            }
        });
        frames.push(frameOf(block.group, box, 0, null, count), ...islands);
    });
    return frames;
}

/** Draw the group frames behind the windows (re-run whenever window positions change). */
function renderGroupFrames() {
    const container = document.querySelector('.container');
    if (!container) return;
    container.querySelectorAll('.group-frame').forEach(el => el.remove());
    if (!currentData || !hasCanvasGroups(currentData)) return;
    const KNOWN_KINDS = ['java', 'clientside', 'xml', 'sql', 'other', 'island'];
    const fragment = document.createDocumentFragment();
    computeGroupFrames(currentData.groups, currentData.windows).forEach(f => {
        const kind = KNOWN_KINDS.includes(f.kind) ? f.kind : 'other';
        const frame = document.createElement('div');
        frame.className = 'group-frame group-kind-' + kind + (f.depth > 0 ? ' group-island' : ' group-block');
        frame.dataset.groupId = f.id;
        frame.style.left = f.left + 'px';
        frame.style.top = f.top + 'px';
        frame.style.width = f.width + 'px';
        frame.style.height = f.height + 'px';
        if (f.depth === 0) {   // islands are frame-only (no label)
            const label = document.createElement('div');
            label.className = 'group-frame-label';
            label.textContent = f.label;
            const count = document.createElement('span');
            count.className = 'group-frame-count';
            count.textContent = String(f.windowCount);
            label.appendChild(count);
            frame.appendChild(label);
        }
        fragment.appendChild(frame);
    });
    container.insertBefore(fragment, container.firstChild);
}

/**
 * Title-bar decoration of a Change Set window: CSS classes for the window and badges (text + tooltip)
 * for windowType (file / junction / via), change.status and change.label.
 */
function buildWindowChangeDecor(windowData) {
    const classes = [];
    const badges = [];
    const wt = windowData && windowData.windowType;
    if (wt === 'file') {
        classes.push('window-type-file');
        badges.push({ cls: 'wt-badge wt-file', text: 'FILE', title: 'ファイル単位のウィンドウ' });
    } else if (wt === 'junction') {
        classes.push('window-type-junction');
        badges.push({ cls: 'wt-badge wt-junction', text: '合流点', title: '未変更の合流点メソッド（変更メソッドの共通の呼び出し元）' });
    } else if (wt === 'via') {
        classes.push('window-type-via');
        badges.push({ cls: 'wt-badge wt-via', text: '経由', title: '未変更の中継メソッド（変更メソッドどうしの呼び出し経路の途中）' });
    }
    const change = windowData && windowData.change;
    if (change && typeof change === 'object') {
        const STATUS = { added: '追加', modified: '変更', deleted: '削除', renamed: '改名' };
        const flags = Array.isArray(change.flags) ? change.flags.filter(f => typeof f === 'string') : [];
        if (STATUS[change.status]) {
            classes.push('change-' + change.status);
            badges.push({
                cls: 'change-badge change-badge-' + change.status,
                text: STATUS[change.status],
                title: change.status === 'renamed' && change.oldPath ? '旧パス: ' + change.oldPath : 'ファイルの変更種別: ' + change.status
            });
        }
        flags.forEach(f => { if (/^[A-Za-z]+$/.test(f)) classes.push('change-flag-' + f); });
        if (typeof change.label === 'string' && change.label) {
            const warn = flags.includes('worktreeMismatch');
            const del = flags.includes('deleted') || flags.includes('deletedMethod') || change.status === 'deleted';
            badges.push({
                cls: 'change-label' + (warn ? ' change-label-warn' : '') + (del ? ' change-label-deleted' : ''),
                text: change.label,
                title: change.label
            });
        }
    }
    return { classes, badges };
}

/**
 * Collapse nested-local body lines in a parent window to one preview row per omission
 * (CallCanvas JSON `nestedOmissions` from TS call hierarchy).
 * @param {Array<{line:number,content:string,...}>} codeArray
 * @param {Array<{startLine:number,endLine:number,previewText:string}>} omissions
 */
function applyNestedOmissionsToCodeLines(codeArray, omissions) {
    if (!Array.isArray(omissions) || omissions.length === 0 || !Array.isArray(codeArray) || codeArray.length === 0) {
        return codeArray;
    }
    const minL = codeArray[0].line;
    const maxL = codeArray[codeArray.length - 1].line;
    const sorted = omissions.slice().sort(function (a, b) { return b.startLine - a.startLine; });
    let rows = codeArray.slice();
    for (let oi = 0; oi < sorted.length; oi++) {
        const om = sorted[oi];
        let sl = om.startLine;
        let el = om.endLine;
        if (el < minL || sl > maxL) {
            continue;
        }
        if (sl < minL) {
            sl = minL;
        }
        if (el > maxL) {
            el = maxL;
        }
        rows = rows.filter(function (r) {
            return !(r.line > sl && r.line <= el);
        });
        const idx = rows.findIndex(function (r) { return r.line === sl; });
        if (idx >= 0) {
            const origLine = String(rows[idx].content || '');
            const indent = (origLine.match(/^[\t ]*/) || [''])[0];
            const previewBody = (om.previewText && String(om.previewText).trim())
                ? String(om.previewText).trim()
                : '…';
            // Align with the first omitted source line (previewText from exporter is often trim-only).
            const preview = indent + previewBody;
            rows[idx] = Object.assign({}, rows[idx], {
                content: preview,
                nestedOmitCard: true,
                omitEndLine: el,
            });
        }
    }
    rows.sort(function (a, b) { return a.line - b.line; });
    return rows;
}

/**
 * Normalize window data - convert simple string format to detailed format
 */
function detectLanguage(filePath) {
    if (!filePath) return null;
    if (filePath.endsWith('.java')) return 'java';
    if (/.(ts|tsx)$/.test(filePath)) return 'typescript';
    if (/.(js|jsx|mjs|cjs)$/.test(filePath)) return 'javascript';
    return null;
}

function normalizeWindowData(windowData) {
    // Detect and set language field
    windowData.language = windowData.language || detectLanguage(windowData.filePath);

    // If code is already in array format, merge lineComments and return
    if (Array.isArray(windowData.code)) {
        const lineComments = windowData.lineComments || {};
        let code = windowData.code.map(line => ({
            ...line,
            comment: lineComments[String(line.line)] ?? line.comment
        }));
        const hasPrebuiltOmit = code.some(function (l) { return l.nestedOmitCard; });
        if (!hasPrebuiltOmit && Array.isArray(windowData.nestedOmissions) && windowData.nestedOmissions.length > 0) {
            code = applyNestedOmissionsToCodeLines(code, windowData.nestedOmissions);
        }
        const fullHeight = windowData.fullHeight === true;
        const normalized = {
            ...windowData,
            code,
            collapsed: windowData.collapsed === true,
            visible: windowData.visible !== false,
            fullHeight
        };
        const optimalHeight = fullHeight
            ? calcFullHeightWindowHeight(normalized)
            : calcWindowHeight(normalized.code.length, true);
        normalized.position = { ...windowData.position, height: optimalHeight };
        return normalized;
    }

    // Convert string code to array format (split by real newline)
    const lines = windowData.code.split(String.fromCharCode(10));
    const startLine = windowData.startLine || 1;
    const highlightLines = new Set(windowData.highlightLines || []);
    const warningLines = new Set(windowData.warningLines || []);
    const commentLines = new Set(windowData.commentLines || []);

    const lineCommentsMap = windowData.lineComments || {};
    const codeArray = lines.map((content, index) => {
        const lineNumber = startLine + index;
        const isComment = commentLines.has(lineNumber) || content.trim().startsWith('//') || content.trim().startsWith('/*') || content.trim().startsWith('*');

        return {
            line: lineNumber,
            content: content,
            highlight: highlightLines.has(lineNumber),
            hasWarning: warningLines.has(lineNumber),
            isComment: isComment,
            comment: lineCommentsMap[String(lineNumber)] ?? undefined
        };
    });

    let finalCode = codeArray;
    if (Array.isArray(windowData.nestedOmissions) && windowData.nestedOmissions.length > 0) {
        finalCode = applyNestedOmissionsToCodeLines(codeArray, windowData.nestedOmissions);
    }

    const fullHeight = windowData.fullHeight === true;
    const normalized = {
        ...windowData,
        code: finalCode,
        collapsed: windowData.collapsed === true,
        visible: windowData.visible !== false,
        fullHeight
    };
    const optimalHeight = fullHeight
        ? calcFullHeightWindowHeight(normalized)
        : calcWindowHeight(normalized.code.length, true);
    normalized.position = { ...windowData.position, height: optimalHeight };
    return normalized;
}

// --- Bracket Guide (ブラケットガイド) ---

/**
 * Find the matching brace for a given line index.
 * Returns { startIndex, endIndex, indentCol } or null.
 */
function findMatchingBrace(codeLines, focusedIndex) {
    const line = codeLines[focusedIndex];
    if (!line) return null;
    const text = line.content || '';

    // Count braces on the focused line
    let openCount = 0;
    let closeCount = 0;
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '{') openCount++;
        else if (text[i] === '}') closeCount++;
    }

    if (openCount === 0 && closeCount === 0) return null;

    // For `} else {` style lines, use the outer unmatched brace
    // If there's an unmatched '{' (openCount > closeCount), scan forward
    // If there's an unmatched '}' (closeCount > openCount), scan backward
    // If balanced, prefer forward scan (opening brace)
    const netOpen = openCount - closeCount;

    if (netOpen > 0 || (netOpen === 0 && openCount > 0)) {
        // Forward scan: find matching '}'
        let depth = 0;
        // Start from focused line, counting only the unmatched opens
        for (let i = 0; i < text.length; i++) {
            if (text[i] === '{') depth++;
            else if (text[i] === '}') depth--;
        }
        // depth now represents net open braces from focused line
        if (depth <= 0) {
            // All braces matched on same line or net closing - try backward
            return _scanBackward(codeLines, focusedIndex, text);
        }

        // Scan forward for the outermost unmatched open brace
        let remaining = depth;
        for (let i = focusedIndex + 1; i < codeLines.length; i++) {
            const t = codeLines[i].content || '';
            for (let j = 0; j < t.length; j++) {
                if (t[j] === '{') remaining++;
                else if (t[j] === '}') {
                    remaining--;
                    if (remaining === 0) {
                        if (i === focusedIndex) return null; // same line
                        const indent = text.search(/\S/);
                        return { startIndex: focusedIndex, endIndex: i, indentCol: indent >= 0 ? indent : 0 };
                    }
                }
            }
        }
        return null; // no match found (snippet boundary)
    } else {
        // Net closing braces: scan backward
        return _scanBackward(codeLines, focusedIndex, text);
    }
}

function _scanBackward(codeLines, focusedIndex, text) {
    // Count net closing braces on focused line
    let depth = 0;
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '}') depth++;
        else if (text[i] === '{') depth--;
    }
    if (depth <= 0) return null;

    let remaining = depth;
    for (let i = focusedIndex - 1; i >= 0; i--) {
        const t = codeLines[i].content || '';
        for (let j = t.length - 1; j >= 0; j--) {
            if (t[j] === '}') remaining++;
            else if (t[j] === '{') {
                remaining--;
                if (remaining === 0) {
                    const indent = t.search(/\S/);
                    return { startIndex: i, endIndex: focusedIndex, indentCol: indent >= 0 ? indent : 0 };
                }
            }
        }
    }
    return null;
}

/**
 * Clear bracket guide classes from a code area.
 */
function clearBracketGuides(codeArea) {
    const guided = codeArea.querySelectorAll('.bracket-guide-start, .bracket-guide-mid, .bracket-guide-end');
    guided.forEach(el => {
        el.classList.remove('bracket-guide-start', 'bracket-guide-mid', 'bracket-guide-end');
        el.style.removeProperty('--bracket-guide-left');
    });
}

/**
 * Show bracket guide for the focused row.
 */
function updateBracketGuide(focusedRow) {
    const codeArea = focusedRow.closest('.code-area');
    if (!codeArea) return;
    clearBracketGuides(codeArea);

    const windowId = focusedRow.getAttribute('data-window-id');
    const windowData = currentData?.windows?.find(w => w.id === windowId);
    if (!windowData) return;

    const rows = Array.from(codeArea.querySelectorAll('.code-line-row'));
    const focusedIdx = rows.indexOf(focusedRow);
    if (focusedIdx < 0) return;

    const result = findMatchingBrace(windowData.code, focusedIdx);
    if (!result) return;
    if (result.startIndex === result.endIndex) return; // same line

    const charWidth = 7.2; // approx width of monospace char at 12px
    const leftPx = (result.indentCol * charWidth + 4) + 'px'; // +4px small offset

    for (let i = result.startIndex; i <= result.endIndex; i++) {
        if (i >= rows.length) break;
        const row = rows[i];
        if (i === result.startIndex) {
            row.classList.add('bracket-guide-start');
        } else if (i === result.endIndex) {
            row.classList.add('bracket-guide-end');
        } else {
            row.classList.add('bracket-guide-mid');
        }
        row.style.setProperty('--bracket-guide-left', leftPx);
    }
}

function createWindow(windowData) {
    const windowDiv = document.createElement('div');
    windowDiv.className = 'code-window';
    windowDiv.id = windowData.id;

    // Apply position
    const pos = windowData.position;
    windowDiv.style.top = pos.top + 'px';
    if (pos.left !== undefined) {
        windowDiv.style.left = pos.left + 'px';
    } else if (pos.right !== undefined) {
        windowDiv.style.right = pos.right + 'px';
    }
    windowDiv.style.width = pos.width + 'px';
    windowDiv.style.height = pos.height + 'px';
    
    // Apply visible state
    if (windowData.visible === false) {
        windowDiv.style.display = 'none';
    }

    // Create title bar
    const titleBar = document.createElement('div');
    titleBar.className = 'title-bar';
    const displayTitle = windowData.displayName || windowData.filePath;
    const isCollapsed = windowData.collapsed === true; // Default to expanded
    const isFullHeight = windowData.fullHeight === true;
    // Change Set Canvas: windowType / change.status / change.label as title-bar badges
    const changeDecor = buildWindowChangeDecor(windowData);
    changeDecor.classes.forEach(cls => windowDiv.classList.add(cls));
    const changeBadgesHtml = changeDecor.badges.map(b =>
        `<span class="${b.cls}" title="${escapeHtmlAttr(b.title)}">${escapeHtml(b.text)}</span>`
    ).join('');
    titleBar.innerHTML = `
        <button class="collapse-button" title="折りたたみ/展開">${isCollapsed ? '▶' : '▼'}</button>
        <button class="full-height-button${isFullHeight ? ' active' : ''}" title="全行表示/通常表示">↕</button>
        <div class="file-path clickable" data-filepath="${windowData.filePath}" data-line="${windowData.startLine}">${displayTitle}</div>
        ${changeBadgesHtml}
        <button class="close-button" title="ウィンドウを閉じる">×</button>
    `;

    // Apply initial collapsed state
    if (isCollapsed) {
        windowDiv.classList.add('collapsed');
    }

    // Apply initial full height state
    if (isFullHeight) {
        windowDiv.classList.add('full-height');
    }

    // Add click handler to collapse button
    const collapseButton = titleBar.querySelector('.collapse-button');
    collapseButton.addEventListener('click', function(e) {
        e.stopPropagation();
        toggleCollapse(windowData.id);
    });

    // Add click handler to full height button
    const fullHeightButtonElement = titleBar.querySelector('.full-height-button');
    fullHeightButtonElement.addEventListener('click', function(e) {
        e.stopPropagation();
        toggleFullHeight(windowData.id);
    });

    // Add click handler to close button for window deletion
    const closeButton = titleBar.querySelector('.close-button');
    if (IS_EXPORT_MODE) {
        closeButton.style.display = 'none';
    } else {
        closeButton.addEventListener('click', function(e) {
            e.stopPropagation();
            deleteWindow(windowData.id);
        });
    }

    // Add double-click handler to file path (to avoid accidental clicks while dragging)
    if (!IS_EXPORT_MODE) {
        const filePathElement = titleBar.querySelector('.file-path');
        filePathElement.addEventListener('dblclick', function(e) {
            e.stopPropagation();
            const filePath = this.getAttribute('data-filepath');
            const line = parseInt(this.getAttribute('data-line'));
            vscode.postMessage({
                command: 'openFile',
                filePath: filePath,
                line: line
            });
        });

        titleBar.addEventListener('contextmenu', function(e) {
            e.preventDefault();
            e.stopPropagation();
            showTitleContextMenu(e, titleBar, windowData);
        });
    }

    // Create code content
    const codeContent = document.createElement('div');
    codeContent.className = 'code-content';

    // Code area (line numbers + code)
    const codeArea = document.createElement('div');
    codeArea.className = 'code-area';

    if (IS_EXPORT_MODE || isWindowInViewport(windowData)) {
        rerenderCodeArea(codeArea, windowData);
    } else {
        codeArea.dataset.rendered = 'false';
    }

    codeContent.appendChild(codeArea);

    // 非選択状態ではスクロールを無効化（not in export mode）
    if (!IS_EXPORT_MODE) {
        codeArea.addEventListener('wheel', function(e) {
            if (!windowDiv.classList.contains('selected')) {
                e.preventDefault();
                // Ctrl/Cmd+wheelはズーム用（bodyハンドラで処理）なので転送しない
                if (!e.ctrlKey && !e.metaKey) {
                    if (e.shiftKey) {
                        e.stopPropagation(); // bodyハンドラへの二重発火を防止
                        const dx = e.deltaX !== 0 ? e.deltaX : e.deltaY;
                        window.scrollBy(dx, 0);
                    } else {
                        window.scrollBy(e.deltaX, e.deltaY);
                    }
                }
            } else {
                // 選択時: Shift+ホイールでコードエリアを横スクロール（WindowsでdeltaXが0の環境に対応）
                if (e.shiftKey && !e.ctrlKey && !e.metaKey) {
                    e.preventDefault();
                    e.stopPropagation(); // bodyハンドラへの伝播を防止（ビューア全体が動かないようにする）
                    const dx = e.deltaX !== 0 ? e.deltaX : e.deltaY;
                    codeArea.scrollLeft += dx;
                }
            }
        }, { passive: false });

        // スクロールバードラッグ防止（getBoundingClientRectで正確に判定）
        codeArea.addEventListener('mousedown', function(e) {
            if (!windowDiv.classList.contains('selected')) {
                const rect = codeArea.getBoundingClientRect();
                if (e.clientX > rect.right - 10 || e.clientY > rect.bottom - 10) {
                    e.preventDefault();
                }
            }
        });

        // キーボードによるスクロール防止
        codeArea.addEventListener('keydown', function(e) {
            if (!windowDiv.classList.contains('selected')) {
                const scrollKeys = ['Space', 'PageUp', 'PageDown', 'Home', 'End'];
                if (scrollKeys.includes(e.code)) {
                    e.preventDefault();
                }
            }
        });
    }

    // Bracket guide: show/hide on row focus
    if (!IS_EXPORT_MODE) {
        codeArea.addEventListener('focusin', function(e) {
            const row = e.target.closest('.code-line-row');
            if (row) updateBracketGuide(row);
        });
        codeArea.addEventListener('focusout', function(e) {
            const ca = codeArea;
            setTimeout(() => {
                if (!ca.contains(document.activeElement) ||
                    !document.activeElement.classList.contains('code-line-row')) {
                    clearBracketGuides(ca);
                }
            }, 0);
        });
    }

    // Ctrl/⌘+click on a symbol reference → open its declaration (openFile). In export mode the click
    // is swallowed and does nothing (nowhere to open).
    // Decided on mouseup from the token remembered at mousedown, not on click: when the line's nodes
    // are replaced before mouseup (the selection/search highlight is cleared as the click collapses the
    // selection) or the window moves (hover transform), the click lands on .code-line or is not fired.
    let pressedSymbolRef = null;
    let swallowNextClick = false;
    codeArea.addEventListener('mousedown', function(e) {
        swallowNextClick = false;
        const token = e.button === 0 && (e.ctrlKey || e.metaKey) ? e.target.closest('.symbol-ref') : null;
        pressedSymbolRef = token ? { symbol: token.getAttribute('data-symbol'), x: e.clientX, y: e.clientY } : null;
    }, true);
    codeArea.addEventListener('mouseup', function(e) {
        const pressed = pressedSymbolRef;
        pressedSymbolRef = null;
        if (e.button !== 0 || !(e.ctrlKey || e.metaKey)) return;
        const token = e.target.closest('.symbol-ref');
        const symbolKey = resolveSymbolRefClick(token ? token.getAttribute('data-symbol') : null,
            pressed, { x: e.clientX, y: e.clientY });
        if (!symbolKey) return;
        swallowNextClick = true;   // the click that follows (if any) must not select the window
        goToDeclaration(symbolKey);
    });
    codeArea.addEventListener('click', function(e) {
        if (!swallowNextClick) return;
        swallowNextClick = false;
        e.preventDefault();
        e.stopPropagation();
    });

    // Add right-click context menu via event delegation on codeArea (not in export mode)
    // 個別行ではなく codeArea に1つ登録することで、rerenderCodeArea() 後も動作する
    if (!IS_EXPORT_MODE) {
        codeArea.addEventListener('contextmenu', function(e) {
            const lineRow = e.target.closest('.code-line-row');
            if (!lineRow) return;
            const lineNumber = parseInt(lineRow.getAttribute('data-line-number'));
            const windowId = lineRow.getAttribute('data-window-id');
            showLineContextMenu(e, lineRow, windowId, lineNumber);
        });
    }

    windowDiv.appendChild(titleBar);
    windowDiv.appendChild(codeContent);

    if (!IS_EXPORT_MODE) {
        // Add resize handles
        const resizeRight = document.createElement('div');
        resizeRight.className = 'resize-handle resize-right';

        const resizeBottom = document.createElement('div');
        resizeBottom.className = 'resize-handle resize-bottom';

        const resizeCorner = document.createElement('div');
        resizeCorner.className = 'resize-handle resize-corner';

        windowDiv.appendChild(resizeRight);
        windowDiv.appendChild(resizeBottom);
        windowDiv.appendChild(resizeCorner);

        // Add click handler for connection mode and selection
        windowDiv.addEventListener('click', function(e) {
            // Don't handle if clicking on interactive elements
            if (e.target.closest('.close-button') || e.target.closest('.resize-handle') || e.target.closest('.collapse-button')) {
                return;
            }

            // Connection mode takes priority
            if (connectionMode) {
                const handled = handleWindowClickForConnection(windowData.id);
                if (handled) {
                    e.stopPropagation();
                }
                return;
            }

            // Handle selection (Shift+click for multi-select)
            // Detect if the click originated from a code-line-row to preserve row focus
            const fromRowClick = !!e.target.closest('.code-line-row');
            selectWindow(windowData.id, e.shiftKey, fromRowClick);
            e.stopPropagation();
        });

        // Add resize functionality
        makeResizable(windowDiv);

        // Add drag functionality
        makeDraggable(windowDiv, titleBar, windowData);
    }

    return windowDiv;
}

function makeResizable(windowElement) {
    const MIN_WIDTH = 300;
    const MIN_HEIGHT = 200;

    let isResizing = false;
    let resizeType = null;
    let startX, startY, startWidth, startHeight;

    const resizeHandles = windowElement.querySelectorAll('.resize-handle');

    resizeHandles.forEach(handle => {
        handle.addEventListener('mousedown', function (e) {
            e.preventDefault();
            e.stopPropagation();

            isResizing = true;
            startX = e.clientX;
            startY = e.clientY;
            startWidth = parseInt(windowElement.style.width);
            startHeight = parseInt(windowElement.style.height);

            if (handle.classList.contains('resize-right')) {
                resizeType = 'right';
            } else if (handle.classList.contains('resize-bottom')) {
                resizeType = 'bottom';
            } else if (handle.classList.contains('resize-corner')) {
                resizeType = 'corner';
            }

            windowElement.classList.add('resizing');
            document.body.style.cursor = window.getComputedStyle(handle).cursor;
            document.body.style.userSelect = 'none';
        });
    });

    document.addEventListener('mousemove', function (e) {
        if (!isResizing) return;

        const deltaX = e.clientX - startX;
        const deltaY = e.clientY - startY;

        if (resizeType === 'right' || resizeType === 'corner') {
            const newWidth = Math.max(MIN_WIDTH, startWidth + deltaX);
            windowElement.style.width = newWidth + 'px';

            // Update window width in data
            if (currentData) {
                const windowData = currentData.windows.find(w => w.id === windowElement.id);
                if (windowData) {
                    windowData.position.width = newWidth;
                }
            }
        }

        if (resizeType === 'bottom' || resizeType === 'corner') {
            const newHeight = Math.max(MIN_HEIGHT, startHeight + deltaY);
            windowElement.style.height = newHeight + 'px';

            // Update window height in data
            if (currentData) {
                const windowData = currentData.windows.find(w => w.id === windowElement.id);
                if (windowData) {
                    windowData.position.height = newHeight;
                }
            }
        }

        // Update arrows when resizing (affects connection points)
        updateArrows();
    });

    document.addEventListener('mouseup', function () {
        if (isResizing) {
            // If height was manually resized, clear fullHeight state
            if (resizeType === 'bottom' || resizeType === 'corner') {
                const windowData = currentData.windows.find(w => w.id === windowElement.id);
                if (windowData && windowData.fullHeight) {
                    windowData.fullHeight = false;
                    windowElement.classList.remove('full-height');
                    const btn = windowElement.querySelector('.full-height-button');
                    if (btn) btn.classList.remove('active');
                }
            }

            isResizing = false;
            resizeType = null;
            windowElement.classList.remove('resizing');
            document.body.style.cursor = '';
            document.body.style.userSelect = '';

            // Update container size after resizing
            updateContainerSize();
        }
    });
}

function makeDraggable(windowElement, titleBar, windowData) {
    let isDragging = false;
    let dragStarted = false;
    let startX, startY, startLeft, startTop;
    const DRAG_THRESHOLD = 5; // Minimum pixels to move before starting drag

    titleBar.addEventListener('mousedown', function (e) {
        // Don't drag if clicking on close button or collapse button
        if (e.target.closest('.close-button') || e.target.closest('.collapse-button')) {
            return;
        }

        // Allow dragging from file path area too (but not on double-click)
        e.preventDefault();

        isDragging = true;
        dragStarted = false;
        startX = e.clientX;
        startY = e.clientY;
        startLeft = parseInt(windowElement.style.left) || 0;
        startTop = parseInt(windowElement.style.top) || 0;

        document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', function (e) {
        if (!isDragging) return;

        const deltaX = e.clientX - startX;
        const deltaY = e.clientY - startY;

        // Only start dragging if mouse has moved beyond threshold
        if (!dragStarted && (Math.abs(deltaX) > DRAG_THRESHOLD || Math.abs(deltaY) > DRAG_THRESHOLD)) {
            dragStarted = true;
            windowElement.classList.add('dragging');
            titleBar.style.cursor = 'grabbing';
        }

        if (dragStarted) {
            const newLeft = startLeft + deltaX;
            const newTop = startTop + deltaY;

            windowElement.style.left = newLeft + 'px';
            windowElement.style.top = newTop + 'px';

            // Update window position in data
            windowData.position.left = newLeft;
            windowData.position.top = newTop;

            // Update arrows in real-time
            updateArrows();
            
            // Update container size to extend scroll area if window moves out of bounds
            // Don't shift windows during drag to avoid unexpected jumps
            updateContainerSize(false);
        }
    });

    document.addEventListener('mouseup', function () {
        if (isDragging) {
            const wasDragging = dragStarted;
            
            isDragging = false;
            dragStarted = false;
            windowElement.classList.remove('dragging');
            titleBar.style.cursor = '';
            document.body.style.userSelect = '';

            // Update container size after dragging (with shift enabled)
            if (wasDragging) {
                updateContainerSize(true);
            }
        }
    });
}

function splitHighlightedLines(html) {
    const rawLines = html.split(String.fromCharCode(10));
    const result = [];
    let openTags = [];

    for (const rawLine of rawLines) {
        let line = openTags.join('') + rawLine;

        // Process <span> and </span> in document order so the stack matches actual nesting.
        // (Previously we did "all closes then all opens", which left a comment span on the stack
        // after a line like "<span class="hljs-comment">// Validate</span>", so the next line was wrapped in comment color.)
        const tagRegex = /<\/?span[^>]*>/g;
        let match;
        while ((match = tagRegex.exec(rawLine)) !== null) {
            if (match[0].startsWith('<\/')) {
                openTags.pop();
            } else {
                openTags.push(match[0]);
            }
        }

        line += '<\/span>'.repeat(openTags.length);
        result.push(line);
    }
    return result;
}

function wrapConstantTokens(htmlContent, symbolIndex, sortedKeys) {
    // Cache combined regex + tooltip map inside the function via closure-like static vars.
    // Rebuild only when sortedKeys reference changes (new data loaded).
    if (sortedKeys !== wrapConstantTokens._cachedKeys) {
        wrapConstantTokens._cachedKeys = sortedKeys;
        wrapConstantTokens._tipMap = new Map();
        var parts = [];
        for (var ki = 0; ki < sortedKeys.length; ki++) {
            var key = sortedKeys[ki];
            var entry = symbolIndex[key];
            if (!entry) continue;
            var tipPlain;
            if (entry.value != null && String(entry.value).length > 0) {
                tipPlain = key + ' = ' + entry.value + '  (' + entry.qualifier + ')';
            } else {
                var t = entry.type != null && String(entry.type).length > 0 ? entry.type : '?';
                tipPlain = key + ' : ' + t + '  (' + entry.qualifier + ')';
            }
            wrapConstantTokens._tipMap.set(key, encodeURIComponent(tipPlain));
            parts.push(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        }
        wrapConstantTokens._combinedRe = parts.length > 0
            ? new RegExp('\\b(?:' + parts.join('|') + ')\\b', 'g')
            : null;
    }
    if (!wrapConstantTokens._combinedRe) return htmlContent;
    wrapConstantTokens._combinedRe.lastIndex = 0;
    var tipMap = wrapConstantTokens._tipMap;
    return htmlContent.replace(wrapConstantTokens._combinedRe, function (m) {
        var tip = tipMap.get(m);
        if (!tip) return m;
        return '<span class="constant-token" data-tip="' + tip + '">' + m + '</span>';
    });
}

// ---- Go to Declaration (symbols / refs) ----
// JSON contract: top-level `symbols` { "<FQN>" (type) | "<FQN>#<name>" (field): { kind: 'type'|'field',
// displayName, filePath, line, typeKind | type, declaringClass, static, final, enumConstant, value } },
// window.refs [{ line, col, len, symbol }] (line = absolute 1-based, col = 0-based UTF-16 index in the raw
// source line, tab = 1). Refs become invisible tokens; Ctrl/⌘+click opens symbols[key].filePath:line.

function escapeHtmlAttr(text) {
    // split/join instead of a regex literal with a double quote (the golden-test extractor scans quotes)
    return String(text).replace(/&/g, '&amp;').split('"').join('&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** True for a field symbol that is a constant (compile-time value or enum constant). */
function isConstantSymbol(entry) {
    return !!entry && entry.kind === 'field'
        && (entry.enumConstant === true || (entry.value != null && String(entry.value).length > 0));
}

/**
 * Plain-text tooltip for a symbol ref: only constants get one ('' otherwise), e.g.
 * "static final int MAX = 100  (com.example.Foo)" / "enum constant OrderStatus PAID  (com.example.OrderStatus)".
 */
function buildSymbolTip(symbolKey, entry) {
    if (!isConstantSymbol(entry)) return '';
    const hashIdx = symbolKey.lastIndexOf('#');
    const name = hashIdx >= 0 ? symbolKey.slice(hashIdx + 1) : symbolKey;
    const declaringClass = entry.declaringClass || (hashIdx >= 0 ? symbolKey.slice(0, hashIdx) : '');
    const mods = [];
    if (entry.enumConstant) {
        mods.push('enum constant');
    } else {
        if (entry.static) mods.push('static');
        if (entry.final) mods.push('final');
    }
    let tip = (mods.length ? mods.join(' ') + ' ' : '') + (entry.type ? entry.type + ' ' : '') + name;
    if (entry.value != null && String(entry.value).length > 0) {
        tip += ' = ' + entry.value;
    }
    if (declaringClass) tip += '  (' + declaringClass + ')';
    return tip;
}

/** Group a window's refs by absolute line number (sorted by col). */
function groupRefsByLine(refs) {
    const byLine = new Map();
    if (!Array.isArray(refs)) return byLine;
    for (const ref of refs) {
        if (!ref || typeof ref.line !== 'number' || typeof ref.col !== 'number' || !(ref.len > 0) || !ref.symbol) continue;
        if (!byLine.has(ref.line)) byLine.set(ref.line, []);
        byLine.get(ref.line).push(ref);
    }
    byLine.forEach(list => list.sort((a, b) => a.col - b.col));
    return byLine;
}

/**
 * Wrap the [col, col+len) text ranges of one highlighted line in symbol-ref spans.
 * Walks the HTML counting text characters (an entity counts as one character), so it works on
 * hljs output, the fallback highlighter and plain escaped text alike. The token span only ever
 * contains text: if a range crosses a tag it is closed before the tag and reopened after it.
 * Ranges inside a comment span (hljs-comment / comment) are left alone. Refs whose symbol is not
 * in `symbols` are skipped (nothing to open). Only constants carry data-tip (tooltip).
 */
function wrapSymbolRefTokens(htmlContent, lineRefs, symbols) {
    if (!htmlContent || !Array.isArray(lineRefs) || lineRefs.length === 0 || !symbols) return htmlContent;
    const refs = lineRefs
        .filter(r => r && r.len > 0 && typeof r.col === 'number' && r.symbol && symbols[r.symbol])
        .sort((a, b) => a.col - b.col);
    if (refs.length === 0) return htmlContent;

    const openTagFor = ref => {
        const tip = buildSymbolTip(ref.symbol, symbols[ref.symbol]);
        return '<span class="symbol-ref" data-symbol="' + escapeHtmlAttr(ref.symbol) + '"'
            + (tip ? ' data-tip="' + encodeURIComponent(tip) + '"' : '') + '>';
    };
    const commentClassRe = /class="[^"]*\bcomment\b/;
    const tagStack = [];
    let commentDepth = 0;
    let out = '';
    let i = 0;
    let col = 0;
    let refIdx = 0;
    let openRef = null;

    while (i < htmlContent.length) {
        const ch = htmlContent[i];
        if (ch === '<') {
            const end = htmlContent.indexOf('>', i);
            if (end < 0) { out += htmlContent.slice(i); break; }
            const tag = htmlContent.slice(i, end + 1);
            if (openRef) { out += '</span>'; openRef = null; }
            if (tag.startsWith('</')) {
                const popped = tagStack.pop();
                if (popped) commentDepth--;
            } else if (!tag.endsWith('/>')) {
                const isComment = commentClassRe.test(tag);
                tagStack.push(isComment);
                if (isComment) commentDepth++;
            }
            out += tag;
            i = end + 1;
            continue;
        }

        let charHtml = ch;
        let units = 1;
        if (ch === '&') {
            const m = /^&(?:#(\d+)|#x([0-9a-fA-F]+)|[a-zA-Z][a-zA-Z0-9]*);/.exec(htmlContent.slice(i, i + 12));
            if (m) {
                charHtml = m[0];
                const cp = m[1] ? parseInt(m[1], 10) : (m[2] ? parseInt(m[2], 16) : 0);
                units = cp > 0xFFFF ? 2 : 1;
            }
        }

        while (refIdx < refs.length && refs[refIdx].col + refs[refIdx].len <= col) refIdx++;
        const ref = refs[refIdx];
        const inRef = !!ref && col >= ref.col && commentDepth === 0;
        if (inRef && openRef !== ref) {
            if (openRef) out += '</span>';
            out += openTagFor(ref);
            openRef = ref;
        } else if (!inRef && openRef) {
            out += '</span>';
            openRef = null;
        }
        out += charHtml;
        i += charHtml.length;
        col += units;
    }
    if (openRef) out += '</span>';
    return out;
}

/**
 * Symbol-ref tokens first, then constant tokens (symbolIndex name match) only outside them,
 * so a position covered by both becomes a symbol-ref (refs win over the name-based index).
 */
function decorateCodeLineTokens(htmlContent, lineRefs, symbols, symbolIndex, sortedKeys) {
    const html = wrapSymbolRefTokens(htmlContent, lineRefs, symbols);
    if (!symbolIndex || !Array.isArray(sortedKeys) || sortedKeys.length === 0) return html;
    if (html.indexOf('symbol-ref') < 0) {
        return wrapConstantTokens(html, symbolIndex, sortedKeys);
    }
    return html
        .split(/(<span class="symbol-ref"[^>]*>[^<]*<\/span>)/)
        .map((part, idx) => (idx % 2 === 1 ? part : wrapConstantTokens(part, symbolIndex, sortedKeys)))
        .join('');
}

/**
 * The symbol a Ctrl/⌘+click opens: the token under the click, else the token pressed at mousedown
 * when the button came up nearby (the click target fell back to .code-line because the token's
 * nodes were replaced or moved mid-click). `pressed` = { symbol, x, y } | null, `click` = { x, y }.
 */
function resolveSymbolRefClick(clickSymbol, pressed, click) {
    if (clickSymbol) return clickSymbol;
    if (!pressed || !pressed.symbol || !click) return null;
    const SLOP_PX = 12;  // pointer travel still treated as a click on the pressed token (not a drag)
    if (Math.abs(click.x - pressed.x) > SLOP_PX || Math.abs(click.y - pressed.y) > SLOP_PX) return null;
    return pressed.symbol;
}

/** The openFile message for a symbol's declaration, or null when the symbol is unknown. */
function buildOpenDeclarationMessage(symbols, symbolKey) {
    const entry = symbols && symbolKey ? symbols[symbolKey] : null;
    if (!entry || !entry.filePath) return null;
    return { command: 'openFile', filePath: entry.filePath, line: entry.line || 1 };
}

/**
 * Windows removed when `initialIds` are deleted: a child goes too once all of its parents are
 * deleted. Returns { deleteIds (sorted), connections }.
 */
function computeWindowDeletion(connections, initialIds) {
    const toDelete = new Set(initialIds);
    const conns = Array.isArray(connections) ? connections : [];
    const childToParents = new Map();
    conns.forEach(conn => {
        if (!childToParents.has(conn.to)) childToParents.set(conn.to, new Set());
        childToParents.get(conn.to).add(conn.from);
    });
    let changed = true;
    while (changed) {
        changed = false;
        conns.forEach(conn => {
            if (toDelete.has(conn.from) && !toDelete.has(conn.to)) {
                const parents = childToParents.get(conn.to);
                if (parents && [...parents].every(p => toDelete.has(p))) {
                    toDelete.add(conn.to);
                    changed = true;
                }
            }
        });
    }
    return {
        deleteIds: [...toDelete].sort(),
        connections: conns.filter(conn => !toDelete.has(conn.from) && !toDelete.has(conn.to))
    };
}

/**
 * Merge the analysis result's `symbols` (declarations) into the canvas data (in place). Incoming
 * entries win: a declaration's file/line is the freshest in the latest analysis. Returns the keys
 * that were added or changed.
 */
function mergeSymbols(data, newData) {
    const changed = [];
    if (!data || !newData) return changed;
    const incoming = newData.symbols;
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return changed;
    const current = (data.symbols && typeof data.symbols === 'object') ? data.symbols : {};
    Object.keys(incoming).forEach(key => {
        if (JSON.stringify(current[key]) === JSON.stringify(incoming[key])) return;
        current[key] = incoming[key];
        changed.push(key);
    });
    data.symbols = current;
    return changed;
}

/**
 * Windows already on the canvas adopt the analysis result's `refs` (in place).
 * idMapping: analysis window id → canvas window id (root → source window, duplicates → existing).
 * An existing window adopts refs only when it has none (never overwrites). Returns the updated ids.
 */
function adoptWindowRefs(data, newData, idMapping) {
    const updated = [];
    if (!data || !newData) return updated;
    const mapping = idMapping || {};
    (newData.windows || []).forEach(nw => {
        if (!Array.isArray(nw.refs) || nw.refs.length === 0) return;
        const targetId = mapping[nw.id];
        if (!targetId) return;
        const target = (data.windows || []).find(w => w.id === targetId);
        if (!target || (Array.isArray(target.refs) && target.refs.length > 0)) return;
        target.refs = nw.refs.map(r => ({ ...r }));
        updated.push(target.id);
    });
    return updated;
}

/**
 * Merge the analysis result's `symbolIndex` (constant name → qualifier/type/value) into the canvas
 * data (in place). Existing keys win: same-named constants from another class are ambiguous and the
 * canvas' entry is what its windows were already rendered with. Rebuilds `_symbolKeys` (new array →
 * wrapConstantTokens drops its regex cache) only when keys were added. Returns the added keys.
 */
function mergeSymbolIndex(data, newData) {
    const added = [];
    if (!data || !newData) return added;
    const incoming = newData.symbolIndex;
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return added;
    const current = (data.symbolIndex && typeof data.symbolIndex === 'object') ? data.symbolIndex : {};
    Object.keys(incoming).forEach(key => {
        if (Object.prototype.hasOwnProperty.call(current, key)) return;
        current[key] = incoming[key];
        added.push(key);
    });
    if (added.length > 0 || !Array.isArray(data._symbolKeys)) {
        data.symbolIndex = current;
        data._symbolKeys = Object.keys(current).sort((a, b) => b.length - a.length);
    }
    return added;
}

function applySyntaxHighlighting(code, isComment) {
    if (isComment) {
        return `<span class="comment">${escapeHtml(code)}</span>`;
    }

    // Simple syntax highlighting
    code = escapeHtml(code);

    // Protect strings first (before keyword replacement)
    const strings = [];
    code = code.replace(/(['"`])((?:\\.|(?!\1).)*?)\1/g, (match) => {
        const index = strings.length;
        strings.push(match);
        return `__STRING_${index}__`;
    });

    // Protect comments
    const comments = [];
    code = code.replace(/(\/\/.*$)/gm, (match) => {
        const index = comments.length;
        comments.push(match);
        return `__COMMENT_${index}__`;
    });

    // Keywords (after protecting strings and comments)
    code = code.replace(/\b(private|public|protected|async|await|if|else|return|const|let|var|function|class|extends|implements|import|export|from|new|this|super|void|interface|enum|static|final|throws|throw|try|catch|finally|boolean|int|long|double|float|String|void|@\w+|@Override|@Autowired|@Component|@Service|@Repository|@Controller|@RestController|@Entity|@Data|@NotNull|@Email|@GetMapping|@PostMapping|@PutMapping|@DeleteMapping|@RequestMapping|@Audited|@Valid|@ModelAttribute)\b/g,
        '<span class="keyword">$1</span>');

    // Restore strings with highlighting
    strings.forEach((str, index) => {
        code = code.replace(`__STRING_${index}__`, `<span class="string">${str}</span>`);
    });

    // Restore comments with highlighting
    comments.forEach((comment, index) => {
        code = code.replace(`__COMMENT_${index}__`, `<span class="comment">${comment}</span>`);
    });

    return code;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/** Display columns for leading spaces/tabs (for nested-omit padding; tab aligns like VS Code default). */
function measureLeadingIndentChUnits(text, tabSize) {
    const s = String(text || '');
    let cols = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === ' ') {
            cols += 1;
        } else if (c === '\t') {
            cols += tabSize - (cols % tabSize);
        } else {
            break;
        }
    }
    return cols;
}

function stripLeadingWhitespaceChars(s) {
    let i = 0;
    while (i < s.length && (s[i] === ' ' || s[i] === '\t')) {
        i++;
    }
    return s.slice(i);
}

function renderArrows(data, container, noAnimation = false) {
    if (!data.connections) return;

    // Pre-build maps for O(1) lookups
    const windowMap = new Map(data.windows.map(w => [w.id, w]));
    const elementMap = new Map();
    container.querySelectorAll('.code-window').forEach(el => elementMap.set(el.id, el));

    const fragment = document.createDocumentFragment();
    data.connections.forEach((conn, index) => {
        const fromWindow = windowMap.get(conn.from);
        const toWindow = windowMap.get(conn.to);

        if (!fromWindow || !toWindow) return;

        // Skip if either window is not visible (focus filter applied)
        if (fromWindow.visible === false || toWindow.visible === false) return;

        // Self-reference (recursive call) - draw a loop arrow
        const svg = conn.from === conn.to
            ? calculateSelfReferenceArrow(fromWindow, index, noAnimation, conn.from, elementMap)
            : calculateArrow(fromWindow, toWindow, index, noAnimation, conn.from, conn.to, elementMap);
        fragment.appendChild(svg);
    });
    container.appendChild(fragment);
}

function calculateSelfReferenceArrow(window, index, noAnimation = false, windowId = '', elementMap = null) {
    const COLLAPSED_HEIGHT = 33;
    const element = elementMap?.get(window.id) ?? document.getElementById(window.id);
    
    let left, top, width, height;
    if (element) {
        left = parseInt(element.style.left) || 0;
        top = parseInt(element.style.top) || 0;
        width = parseInt(element.style.width) || window.position.width;
        height = element.classList.contains('collapsed') ? COLLAPSED_HEIGHT : (parseInt(element.style.height) || window.position.height);
    } else {
        left = window.position.left || 0;
        top = window.position.top;
        width = window.position.width;
        height = window.collapsed === true ? COLLAPSED_HEIGHT : window.position.height;
    }

    // Loop arrow on the right side of the window
    const startX = left + width;
    const startY = top + height / 2 - 15;  // Start slightly above center
    const endY = top + height / 2 + 15;    // End slightly below center
    const loopWidth = 40;
    const loopHeight = 50;

    // Create SVG
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('arrow', `arrow-${index + 1}`, 'self-reference');
    svg.setAttribute('data-from', windowId);
    svg.setAttribute('data-to', windowId);
    svg.title = '再帰呼び出し（クリックで選択）';

    if (noAnimation) {
        svg.classList.add('no-animation');
    }

    svg.setAttribute('width', loopWidth + 20);
    svg.setAttribute('height', loopHeight + 30);
    svg.style.top = (startY - loopHeight / 2) + 'px';
    svg.style.left = startX + 'px';

    // Create marker (arrowhead)
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
    marker.setAttribute('id', `arrowhead-self-${index}`);
    marker.setAttribute('markerWidth', '10');
    marker.setAttribute('markerHeight', '10');
    marker.setAttribute('refX', '5');
    marker.setAttribute('refY', '3');
    marker.setAttribute('orient', 'auto');

    const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    polygon.setAttribute('points', '0 0, 10 3, 0 6');
    polygon.classList.add('arrow-head');

    marker.appendChild(polygon);
    defs.appendChild(marker);
    svg.appendChild(defs);

    // Create curved path for loop
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const svgStartY = loopHeight / 2;
    const svgEndY = loopHeight / 2 + (endY - startY);
    
    // Bezier curve: out to right, up, then back down
    const d = `M 0 ${svgStartY} C ${loopWidth} ${svgStartY - loopHeight/2}, ${loopWidth} ${svgEndY + loopHeight/2}, 0 ${svgEndY}`;
    path.setAttribute('d', d);
    path.classList.add('arrow-line');
    path.setAttribute('fill', 'none');
    path.setAttribute('marker-end', `url(#arrowhead-self-${index})`);

    // Calculate path length for animation
    const pathLength = path.getTotalLength ? path.getTotalLength() : 150;
    path.style.strokeDasharray = pathLength;
    path.style.strokeDashoffset = noAnimation ? 0 : pathLength;

    svg.appendChild(path);

    // Clickable overlay
    const clickablePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    clickablePath.setAttribute('d', d);
    clickablePath.setAttribute('stroke', 'transparent');
    clickablePath.setAttribute('stroke-width', '12');
    clickablePath.setAttribute('fill', 'none');
    clickablePath.setAttribute('class', 'arrow-clickable');
    clickablePath.style.cursor = 'pointer';
    clickablePath.style.pointerEvents = 'stroke';
    
    clickablePath.addEventListener('click', function(e) {
        e.stopPropagation();
        const connId = windowId + '->' + windowId;
        if (selectedConnections.has(connId)) {
            selectedConnections.delete(connId);
            svg.classList.remove('selected');
        } else {
            if (!e.shiftKey) {
                clearSelection(false);
            }
            selectedConnections.add(connId);
            svg.classList.add('selected');
        }
        updateDeleteButtonState();
    });
    
    svg.appendChild(clickablePath);

    return svg;
}

function calculateArrow(fromWindow, toWindow, index, noAnimation = false, fromId = '', toId = '', elementMap = null) {
    // Get actual positions from DOM elements for accuracy
    const fromElement = elementMap?.get(fromWindow.id) ?? document.getElementById(fromWindow.id);
    const toElement = elementMap?.get(toWindow.id) ?? document.getElementById(toWindow.id);
    
    // Fallback to data positions if elements not found
    let fromLeft, fromTop, fromWidth, fromHeight;
    let toLeft, toTop, toWidth, toHeight;
    
    const COLLAPSED_HEIGHT = 33;
    
    if (fromElement) {
        fromLeft = parseInt(fromElement.style.left) || 0;
        fromTop = parseInt(fromElement.style.top) || 0;
        fromWidth = parseInt(fromElement.style.width) || fromWindow.position.width;
        fromHeight = fromElement.classList.contains('collapsed') ? COLLAPSED_HEIGHT : (parseInt(fromElement.style.height) || fromWindow.position.height);
    } else {
        fromLeft = fromWindow.position.left || 0;
        fromTop = fromWindow.position.top;
        fromWidth = fromWindow.position.width;
        fromHeight = fromWindow.collapsed === true ? COLLAPSED_HEIGHT : fromWindow.position.height;
    }
    
    if (toElement) {
        toLeft = parseInt(toElement.style.left) || 0;
        toTop = parseInt(toElement.style.top) || 0;
        toWidth = parseInt(toElement.style.width) || toWindow.position.width;
        toHeight = toElement.classList.contains('collapsed') ? COLLAPSED_HEIGHT : (parseInt(toElement.style.height) || toWindow.position.height);
    } else {
        toLeft = toWindow.position.left || 0;
        toTop = toWindow.position.top;
        toWidth = toWindow.position.width;
        toHeight = toWindow.collapsed === true ? COLLAPSED_HEIGHT : toWindow.position.height;
    }

    // Calculate from point (right side of from window)
    const fromX = fromLeft + fromWidth;
    const fromY = fromTop + fromHeight / 2;

    // Calculate to point (left side of to window)
    const toX = toLeft;
    const toY = toTop + toHeight / 2;

    // Create SVG
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('arrow', `arrow-${index + 1}`);
    svg.setAttribute('data-from', fromId);
    svg.setAttribute('data-to', toId);

    svg.title = '接続を削除するにはクリック';

    // Disable animation if specified
    if (noAnimation) {
        svg.classList.add('no-animation');
    }

    const width = Math.abs(toX - fromX);
    const height = Math.abs(toY - fromY);
    const left = Math.min(fromX, toX);
    const top = Math.min(fromY, toY);

    svg.setAttribute('width', width);
    svg.setAttribute('height', height + 20);
    svg.style.top = (top - 10) + 'px';
    svg.style.left = left + 'px';

    // Create marker
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
    marker.setAttribute('id', `arrowhead-${index}`);
    marker.setAttribute('markerWidth', '10');
    marker.setAttribute('markerHeight', '10');
    marker.setAttribute('refX', '9');
    marker.setAttribute('refY', '3');
    marker.setAttribute('orient', 'auto');

    const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    polygon.setAttribute('points', '0 0, 10 3, 0 6');
    polygon.classList.add('arrow-head');

    marker.appendChild(polygon);
    defs.appendChild(marker);
    svg.appendChild(defs);

    // Create line
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    const x1 = fromX > toX ? width : 0;
    const y1 = fromY > toY ? height + 10 : 10;
    const x2 = toX > fromX ? width : 0;
    const y2 = toY > fromY ? height + 10 : 10;

    line.setAttribute('x1', x1);
    line.setAttribute('y1', y1);
    line.setAttribute('x2', x2);
    line.setAttribute('y2', y2);
    line.classList.add('arrow-line');
    line.setAttribute('marker-end', `url(#arrowhead-${index})`);

    // Calculate actual line length for animation
    const lineLength = Math.sqrt(Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2));
    line.style.strokeDasharray = lineLength;

    // Set dashoffset based on animation state
    if (noAnimation) {
        line.style.strokeDashoffset = 0;
    } else {
        line.style.strokeDashoffset = lineLength;
    }

    svg.appendChild(line);

    // Make arrow line clickable for selection
    // Use a transparent overlay stroke for easier clicking while keeping visual stroke thin
    const clickableStroke = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    clickableStroke.setAttribute('x1', x1);
    clickableStroke.setAttribute('y1', y1);
    clickableStroke.setAttribute('x2', x2);
    clickableStroke.setAttribute('y2', y2);
    clickableStroke.setAttribute('stroke', 'transparent');
    clickableStroke.setAttribute('stroke-width', '12');
    clickableStroke.setAttribute('class', 'arrow-clickable');
    clickableStroke.style.cursor = 'pointer';
    clickableStroke.style.pointerEvents = 'stroke';
    
    clickableStroke.addEventListener('click', function(e) {
        e.stopPropagation();
        
        // Toggle selection of this connection
        const connId = fromId + '->' + toId;
        if (selectedConnections.has(connId)) {
            // Deselect
            selectedConnections.delete(connId);
            svg.classList.remove('selected');
        } else {
            // Select (clear window selection)
            if (!e.shiftKey) {
                clearSelection(false);
            }
            selectedConnections.add(connId);
            svg.classList.add('selected');
        }
        
        updateDeleteButtonState();
    });
    
    svg.appendChild(clickableStroke);

    // Allow clicks on empty space to pass through to window
    svg.addEventListener('click', function(e) {
        // If click is not on the line element, let it pass through
        if (e.target !== line && !line.contains(e.target)) {
            // Don't stop propagation, allow click to reach window
            return;
        }
    });

    return svg;
}

console.log('CallCanvas Viewer loaded in VS Code WebView');
