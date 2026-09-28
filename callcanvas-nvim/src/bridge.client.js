/* eslint-env browser */
/**
 * Browser-side bridge, injected into the viewer page BEFORE media/viewer.js loads.
 *
 * viewer.js is used completely unmodified: it calls `acquireVsCodeApi()` at load
 * time, so defining that function here is the whole integration. Messages travel
 * over fetch (browser -> host) and SSE (host -> browser), and host messages are
 * re-dispatched as `window.postMessage` so viewer.js's existing
 * `window.addEventListener('message', ...)` handler sees them untouched.
 */
(function () {
    'use strict';

    var BRIDGE = window.__CALLCANVAS_BRIDGE__ || {};
    var TOKEN = BRIDGE.token;
    var CANVAS_ID = BRIDGE.canvasId || '';
    var FOLLOW = BRIDGE.follow === true;
    var SETTINGS = BRIDGE.settings || {};
    // The browser is self-contained by default: opening a file shows it here, and
    // Neovim is left alone. `callcanvas.nvimJump` turns the editor jump back on.
    var NVIM_JUMP = SETTINGS.nvimJump === true;

    function url(pathname) {
        return pathname + (pathname.indexOf('?') < 0 ? '?' : '&') + 't=' + encodeURIComponent(TOKEN);
    }

    function post(pathname, body) {
        return fetch(url(pathname), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        }).catch(function (err) {
            console.error('[callcanvas-bridge] post failed', pathname, err);
        });
    }

    // --- the vscode webview API surface viewer.js expects -------------------
    window.acquireVsCodeApi = function () {
        return {
            postMessage: function (message) {
                // A double-click on a window title asks the host to open the file. In a
                // browser there is no editor pane, so also (or instead) show the file
                // here — see callcanvas.openFileMode.
                if (message && message.command === 'openFile') {
                    showFile(message.filePath, message.line);
                    if (!NVIM_JUMP) {
                        return;   // nothing to ask the host for
                    }
                }
                // canvasId keeps several open canvases apart on the host side.
                post('/api/message', { message: message, canvasId: CANVAS_ID });
            },
            getState: function () {
                try {
                    return JSON.parse(sessionStorage.getItem('callcanvas:state:' + CANVAS_ID) || 'null');
                } catch (e) {
                    return null;
                }
            },
            setState: function (state) {
                try {
                    sessionStorage.setItem('callcanvas:state:' + CANVAS_ID, JSON.stringify(state));
                } catch (e) { /* private mode — state is optional */ }
                return state;
            }
        };
    };

    // --- toasts / progress --------------------------------------------------
    function toast(text, level) {
        if (typeof window.showToast === 'function') {
            window.showToast(text, level === 'warning' ? 'warning' : level, level === 'error' ? 6000 : 3000);
        } else {
            console.log('[callcanvas] ' + level + ': ' + text);
        }
    }

    var progressBox = null;
    function progress(text, active) {
        if (!progressBox) {
            progressBox = document.createElement('div');
            progressBox.setAttribute('style', [
                'position:fixed', 'left:12px', 'bottom:12px', 'z-index:99999',
                'padding:6px 12px', 'border-radius:4px', 'font:12px/1.4 sans-serif',
                'background:rgba(30,30,30,0.92)', 'color:#eee', 'display:none',
                'box-shadow:0 2px 8px rgba(0,0,0,0.4)', 'pointer-events:none'
            ].join(';'));
            (document.body || document.documentElement).appendChild(progressBox);
        }
        if (active) {
            progressBox.textContent = '⏳ ' + text;
            progressBox.style.display = 'block';
        } else {
            progressBox.style.display = 'none';
        }
    }

    // --- host-driven dialogs ------------------------------------------------
    function answerUi(request) {
        var payload = request.payload || {};
        var value = null;

        if (request.type === 'input') {
            var label = payload.prompt || 'Input';
            if (payload.placeHolder) {
                label += '\n(' + payload.placeHolder + ')';
            }
            if (payload.error) {
                label = '⚠ ' + payload.error + '\n\n' + label;
            }
            value = window.prompt(label, payload.value || '');
        } else if (request.type === 'pick') {
            var items = payload.items || [];
            var lines = items.map(function (item, i) {
                return (i + 1) + ') ' + item.label + (item.description ? '  — ' + item.description : '');
            });
            var answer = window.prompt((payload.placeHolder || 'Select') + '\n' + lines.join('\n'), '1');
            var index = parseInt(answer, 10);
            value = (!isNaN(index) && index >= 1 && index <= items.length) ? index - 1 : null;
        } else if (request.type === 'openPath' || request.type === 'savePath') {
            value = window.prompt(payload.title || 'Path', payload.defaultPath || '');
        } else if (request.type === 'message') {
            var choices = payload.items || [];
            var text = payload.message + '\n\n' + choices.map(function (c, i) {
                return (i + 1) + ') ' + c;
            }).join('\n');
            var picked = window.prompt(text, '1');
            var idx = parseInt(picked, 10);
            value = (!isNaN(idx) && idx >= 1 && idx <= choices.length) ? idx - 1 : null;
        }
        post('/api/ui-reply', { id: request.id, value: value });
    }

    // --- file panel ---------------------------------------------------------
    // A devtools-style pane on the right showing the whole file, with the target
    // line highlighted. viewer.js only ever shows the analysed fragment, and in a
    // browser there is no editor to fall back on.
    var filePanel = null;
    var filePanelParts = null;

    function buildFilePanel() {
        var panel = document.createElement('div');
        panel.setAttribute('style', [
            'position:fixed', 'top:0', 'right:0', 'bottom:0', 'width:46vw', 'min-width:320px',
            'z-index:99997', 'display:none', 'flex-direction:column',
            'background:#1e1e1e', 'color:#d4d4d4', 'border-left:1px solid #444',
            'box-shadow:-4px 0 16px rgba(0,0,0,0.45)', 'font:12px/1.5 ui-monospace,Menlo,Consolas,monospace'
        ].join(';'));

        var header = document.createElement('div');
        header.setAttribute('style', [
            'flex:0 0 auto', 'display:flex', 'align-items:center', 'gap:8px',
            'padding:6px 10px', 'background:#252526', 'border-bottom:1px solid #444',
            'font:12px/1.6 sans-serif'
        ].join(';'));

        var title = document.createElement('span');
        title.setAttribute('style', 'flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap');
        header.appendChild(title);

        var openInNvim = document.createElement('a');
        openInNvim.href = '#';
        openInNvim.textContent = 'open in Neovim';
        openInNvim.setAttribute('style', 'color:#7fb9ff;text-decoration:none;flex:0 0 auto');
        if (NVIM_JUMP) {
            header.appendChild(openInNvim);
        }

        var close = document.createElement('a');
        close.href = '#';
        close.textContent = '✕';
        close.title = 'close (Esc / ' + CLOSE_KEY + ')';
        close.setAttribute('style', 'color:#ddd;text-decoration:none;flex:0 0 auto;padding:0 2px');
        header.appendChild(close);

        var body = document.createElement('div');
        // viewer.css scopes every .hljs-* colour under .code-area, so reuse that class
        // to get exactly the same palette as the canvas windows.
        body.className = 'code-area';
        body.setAttribute('style', 'flex:1 1 auto;overflow:auto;padding:8px 0;height:auto');

        var grip = document.createElement('div');
        grip.setAttribute('style', [
            'position:absolute', 'left:-3px', 'top:0', 'bottom:0', 'width:6px',
            'cursor:col-resize'
        ].join(';'));

        panel.appendChild(grip);
        panel.appendChild(header);
        panel.appendChild(body);
        (document.body || document.documentElement).appendChild(panel);

        close.addEventListener('click', function (e) {
            e.preventDefault();
            hideFile();
        });

        // Drag the left edge to resize.
        grip.addEventListener('mousedown', function (down) {
            down.preventDefault();
            var move = function (e) {
                var width = Math.min(Math.max(window.innerWidth - e.clientX, 280), window.innerWidth - 120);
                panel.style.width = width + 'px';
            };
            var up = function () {
                document.removeEventListener('mousemove', move);
                document.removeEventListener('mouseup', up);
            };
            document.addEventListener('mousemove', move);
            document.addEventListener('mouseup', up);
        });

        filePanel = panel;
        filePanelParts = { title: title, body: body, openInNvim: openInNvim, current: null };
        return filePanelParts;
    }

    function hideFile() {
        if (filePanel) {
            filePanel.style.display = 'none';
        }
    }

    // The viewer ships a custom highlight.js bundle with java / javascript /
    // typescript / xml only; anything else falls back to plaintext (which hljs core
    // always provides). Same check viewer.js does before highlighting.
    function languageFor(path) {
        var ext = String(path).toLowerCase().split('.').pop();
        var map = {
            java: 'java',
            js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
            ts: 'typescript', tsx: 'typescript',
            html: 'xml', htm: 'xml', jsp: 'xml', xml: 'xml', xsd: 'xml'
        };
        var lang = map[ext] || 'plaintext';
        if (window.hljs && typeof window.hljs.getLanguage === 'function') {
            return window.hljs.getLanguage(lang) ? lang : 'plaintext';
        }
        return lang;
    }

    /**
     * Split highlighted HTML into one string per source line, closing and
     * re-opening the spans that straddle a newline (block comments, strings).
     * Highlighting line by line would break exactly those.
     */
    function splitHighlightedLines(html) {
        var lines = [];
        var open = [];
        var buffer = '';
        var i = 0;
        while (i < html.length) {
            var c = html.charAt(i);
            if (c === '<') {
                var end = html.indexOf('>', i);
                if (end < 0) {
                    buffer += html.slice(i);
                    break;
                }
                var tag = html.slice(i, end + 1);
                if (tag.charAt(1) === '/') {
                    open.pop();
                } else if (tag.charAt(tag.length - 2) !== '/') {
                    open.push(tag);
                }
                buffer += tag;
                i = end + 1;
            } else if (c === '\n') {
                for (var n = 0; n < open.length; n++) { buffer += '</span>'; }
                lines.push(buffer);
                buffer = open.join('');
                i += 1;
            } else {
                var nextTag = html.indexOf('<', i);
                var nextNl = html.indexOf('\n', i);
                var stop = Math.min(
                    nextTag < 0 ? html.length : nextTag,
                    nextNl < 0 ? html.length : nextNl
                );
                buffer += html.slice(i, stop);
                i = stop;
            }
        }
        lines.push(buffer);
        return lines;
    }

    /** Highlighted HTML per line, or null to render plain text. */
    function highlightLines(text, path) {
        if (!window.hljs || typeof window.hljs.highlight !== 'function') {
            return null;
        }
        try {
            var result = window.hljs.highlight(String(text), {
                language: languageFor(path),
                ignoreIllegals: true
            });
            var split = splitHighlightedLines(result.value);
            // If the split did not line up, fall back rather than garble the file.
            return split.length === String(text).split(/\r?\n/).length ? split : null;
        } catch (e) {
            return null;
        }
    }

    /** Render the file with the target line highlighted and scrolled into view. */
    function renderFile(data) {
        var parts = filePanelParts || buildFilePanel();
        parts.current = { path: data.relPath || data.path, line: data.line };
        parts.title.textContent = (data.relPath || data.path) + ':' + data.line;
        parts.title.title = data.path;
        parts.body.textContent = '';

        var lines = String(data.text).split(/\r?\n/);
        var highlighted = highlightLines(data.text, data.relPath || data.path);
        var table = document.createElement('div');
        table.setAttribute('style', 'display:table;width:100%;border-collapse:collapse');
        var target = null;
        var gutterWidth = String(lines.length).length;

        lines.forEach(function (text, index) {
            var nr = index + 1;
            var row = document.createElement('div');
            row.setAttribute('style', 'display:table-row'
                + (nr === data.line ? ';background:#3a3d41' : ''));

            var gutter = document.createElement('span');
            gutter.setAttribute('style', [
                'display:table-cell', 'text-align:right', 'padding:0 8px',
                'color:' + (nr === data.line ? '#ffd479' : '#6b6b6b'),
                'user-select:none', 'width:' + (gutterWidth + 1) + 'ch', 'vertical-align:top'
            ].join(';'));
            gutter.textContent = String(nr);
            row.appendChild(gutter);

            var code = document.createElement('span');
            code.setAttribute('style', 'display:table-cell;white-space:pre-wrap;word-break:break-word;padding-right:10px');
            if (highlighted) {
                code.innerHTML = highlighted[index];
            } else {
                code.textContent = text;
            }
            row.appendChild(code);

            // Double-clicking a line jumps Neovim there, when that is enabled.
            if (NVIM_JUMP) {
                row.addEventListener('dblclick', function () {
                    post('/api/message', {
                        canvasId: CANVAS_ID,
                        message: { command: 'openFile', filePath: data.path, line: nr }
                    });
                });
            }

            if (nr === data.line) { target = row; }
            table.appendChild(row);
        });

        parts.body.appendChild(table);
        filePanel.style.display = 'flex';
        if (target && target.scrollIntoView) {
            target.scrollIntoView({ block: 'center' });
        }

        parts.openInNvim.onclick = function (e) {
            e.preventDefault();
            post('/api/message', {
                canvasId: CANVAS_ID,
                message: { command: 'openFile', filePath: data.path, line: data.line }
            });
        };
    }

    function showFile(filePath, line) {
        if (!filePath) { return; }
        if (!filePanelParts) { buildFilePanel(); }
        filePanelParts.title.textContent = 'loading ' + filePath + ' …';
        filePanel.style.display = 'flex';
        fetch(url('/api/file') + '&p=' + encodeURIComponent(filePath) + '&line=' + (line || 1))
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (data && data.ok) {
                    renderFile(data);
                } else {
                    filePanelParts.title.textContent = 'could not read ' + filePath;
                    toast((data && data.error) || 'could not read the file', 'error');
                }
            })
            .catch(function (err) {
                filePanelParts.title.textContent = 'could not read ' + filePath;
                toast('could not read the file: ' + err, 'error');
            });
    }

    // The window title text (.file-path) is the only element viewer.js binds a
    // double-click to. Make the whole title bar work, which is what people aim at.
    document.addEventListener('dblclick', function (e) {
        if (!e.target || !e.target.closest) { return; }
        if (e.target.closest('.file-path')) { return; }   // viewer.js handles that one
        var titleBar = e.target.closest('.title-bar');
        if (!titleBar) { return; }
        var pathElement = titleBar.querySelector('.file-path');
        if (!pathElement) { return; }
        var filePath = pathElement.getAttribute('data-filepath');
        var line = parseInt(pathElement.getAttribute('data-line'), 10) || 1;
        if (!filePath) { return; }
        showFile(filePath, line);
        if (NVIM_JUMP) {
            post('/api/message', {
                canvasId: CANVAS_ID,
                message: { command: 'openFile', filePath: filePath, line: line }
            });
        }
    }, true);

    /**
     * One key that closes whatever is in front: the file panel, else the selected
     * windows. Deleting goes through viewer.js's own Delete handling (cascade,
     * connections, autosave) rather than reimplementing it here.
     */
    function closeTopmost() {
        if (filePanel && filePanel.style.display !== 'none') {
            hideFile();
            return true;
        }
        var selected = document.querySelector('.code-window.selected')
            || document.querySelector('svg.selected');
        if (selected) {
            var target = document.body || document.documentElement;
            target.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Delete', bubbles: true, cancelable: true
            }));
            return true;
        }
        toast('閉じるものがありません（ウィンドウを選択するか、ファイルパネルを開いてください）', 'info');
        return false;
    }

    // --- keyboard: jump back ------------------------------------------------
    // The VSIX binds `callcanvas.jumpBack` to alt+left via VS Code's keybinding
    // layer; in a browser nothing is bound and alt+left is the browser's Back
    // button. viewer.js exposes jumpBack() globally, so bind it here instead of
    // touching viewer.js.
    var ARROW_ALIASES = {
        arrowleft: 'left', arrowright: 'right', arrowup: 'up', arrowdown: 'down'
    };

    function keyBinding(e) {
        var parts = [];
        if (e.ctrlKey) { parts.push('ctrl'); }
        if (e.altKey) { parts.push('alt'); }
        if (e.metaKey) { parts.push('meta'); }
        if (e.shiftKey) { parts.push('shift'); }
        var key = (e.key && e.key.length === 1) ? e.key.toLowerCase() : String(e.key || '').toLowerCase();
        if (ARROW_ALIASES[key]) { key = ARROW_ALIASES[key]; }
        if (key) { parts.push(key); }
        return parts.join('+');
    }

    function normalizeBinding(value) {
        return String(value || '').toLowerCase().split('+').map(function (part) {
            part = part.trim();
            return ARROW_ALIASES[part] || part;
        }).filter(Boolean).join('+');
    }

    function isTyping(target) {
        if (!target) { return false; }
        var tag = target.tagName;
        return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable === true;
    }

    var JUMP_BACK_KEY = normalizeBinding(SETTINGS.jumpBackKey || 'shift+o');
    // ctrl+w / cmd+w are reserved by the browser (preventDefault is ignored), so the
    // canvas gets its own close key.
    var CLOSE_KEY = normalizeBinding(SETTINGS.closeKey || 'shift+w');
    // Combos the browser would use to leave the page. Answering them with
    // jump-back keeps muscle memory from the VS Code build working.
    var BACK_ALIASES = ['alt+left', 'meta+left', 'meta+[', 'ctrl+['];

    document.addEventListener('keydown', function (e) {
        if (isTyping(e.target)) { return; }
        if (e.key === 'Escape' && filePanel && filePanel.style.display !== 'none') {
            hideFile();
            e.stopPropagation();
            return;
        }
        var binding = keyBinding(e);

        if (binding === CLOSE_KEY) {
            e.preventDefault();
            e.stopPropagation();
            closeTopmost();
            return;
        }

        var isJumpBack = binding === JUMP_BACK_KEY
            || (SETTINGS.interceptBrowserBack !== false && BACK_ALIASES.indexOf(binding) >= 0);
        if (!isJumpBack) { return; }
        if (typeof window.jumpBack !== 'function') { return; }
        // Stop the browser from navigating away from the canvas.
        e.preventDefault();
        e.stopPropagation();
        window.jumpBack();
    }, true);

    // --- host -> browser stream ---------------------------------------------
    var stream = new EventSource(
        url('/api/events') + '&c=' + encodeURIComponent(CANVAS_ID) + '&follow=' + (FOLLOW ? '1' : '0')
    );

    function handle(payload) {
        switch (payload.kind) {
            case 'post':
                window.postMessage(payload.message, '*');
                break;
            case 'toast':
                toast(payload.text, payload.level || 'info');
                break;
            case 'progress':
                progress(payload.text, payload.active);
                break;
            case 'title':
                document.title = payload.title;
                break;
            case 'navigate':
                location.reload();
                break;
            case 'ui':
                answerUi(payload);
                break;
            case 'show-file':
                showFile(payload.path, payload.line);
                break;
            case 'canvas-added':
                announceCanvas(payload);
                break;
            case 'batch':
                (payload.events || []).forEach(handle);
                break;
            case 'shutdown':
                stream.close();
                toast('CallCanvas host stopped', 'warning');
                break;
        }
    }

    stream.onmessage = function (event) {
        var payload;
        try {
            payload = JSON.parse(event.data);
        } catch (e) {
            return;
        }
        handle(payload);
    };

    stream.onerror = function () {
        // EventSource retries on its own; surface a hint if the host is gone.
        if (stream.readyState === 2) {
            toast('CallCanvas host connection lost', 'error');
        }
    };

    // --- canvas switcher ----------------------------------------------------
    // Several canvases can be open at once. A link clicked here is a user gesture,
    // so it may open a new tab — which is how a second canvas gets its own tab.
    var switcherBox = null;
    var switcherList = null;
    var switcherOpen = false;

    function anchor(text, href, style) {
        var a = document.createElement('a');
        a.href = href;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = text;
        a.setAttribute('style', 'color:#7fb9ff;text-decoration:none;' + (style || ''));
        return a;
    }

    function renderCanvasList() {
        if (!switcherList) { return; }
        fetch(url('/api/canvases'))
            .then(function (r) { return r.json(); })
            .then(function (data) {
                switcherList.textContent = '';
                (data.canvases || []).forEach(function (canvas) {
                    var row = document.createElement('div');
                    row.setAttribute('style', 'white-space:nowrap;padding:1px 0');
                    if (canvas.id === CANVAS_ID) {
                        var here = document.createElement('span');
                        here.textContent = '● ' + canvas.title + ' (this tab)';
                        here.setAttribute('style', 'color:#fff');
                        row.appendChild(here);
                    } else {
                        row.appendChild(anchor('○ ' + canvas.title, canvas.url));
                        if (canvas.latest) {
                            var tag = document.createElement('span');
                            tag.textContent = ' newest';
                            tag.setAttribute('style', 'color:#888');
                            row.appendChild(tag);
                        }
                    }
                    switcherList.appendChild(row);
                });
                if (!(data.canvases || []).length) {
                    switcherList.textContent = 'no canvases';
                }
            })
            .catch(function () { switcherList.textContent = 'could not load the list'; });
    }

    function addBadge() {
        switcherBox = document.createElement('div');
        switcherBox.setAttribute('style', [
            'position:fixed', 'right:10px', 'bottom:10px', 'z-index:99998',
            'font:11px/1.6 sans-serif', 'background:rgba(30,30,30,0.88)', 'color:#ddd',
            'padding:5px 9px', 'border-radius:4px', 'max-width:46vw'
        ].join(';'));

        var head = document.createElement('div');
        var pretty = function (binding) {
            return binding.replace(/\b\w/g, function (c) { return c.toUpperCase(); });
        };
        var label = document.createElement('span');
        label.textContent = (FOLLOW ? 'following newest' : 'pinned')
            + ' · back ' + pretty(JUMP_BACK_KEY) + ' · close ' + pretty(CLOSE_KEY) + ' ';
        label.title = 'back in jump history: ' + JUMP_BACK_KEY
            + (SETTINGS.interceptBrowserBack !== false ? ' (alt+left also works)' : '')
            + '\nclose the file panel / selected windows: ' + CLOSE_KEY
            + ' (ctrl+w cannot be used: the browser reserves it)';
        head.appendChild(label);

        if (BRIDGE.permalink && FOLLOW) {
            head.appendChild(anchor('pin this canvas', BRIDGE.permalink));
            head.appendChild(document.createTextNode(' · '));
        }

        var toggle = document.createElement('a');
        toggle.href = '#';
        toggle.textContent = 'canvases ▾';
        toggle.setAttribute('style', 'color:#7fb9ff;text-decoration:none');
        head.appendChild(toggle);
        switcherBox.appendChild(head);

        switcherList = document.createElement('div');
        switcherList.setAttribute('style', 'margin-top:4px;border-top:1px solid #555;padding-top:4px');
        // Keep the open/closed state in a variable rather than reading it back out
        // of the style attribute.
        switcherList.style.display = 'none';
        switcherBox.appendChild(switcherList);

        toggle.addEventListener('click', function (e) {
            e.preventDefault();
            switcherOpen = !switcherOpen;
            switcherList.style.display = switcherOpen ? 'block' : 'none';
            toggle.textContent = switcherOpen ? 'canvases ▴' : 'canvases ▾';
            if (switcherOpen) { renderCanvasList(); }
        });

        (document.body || document.documentElement).appendChild(switcherBox);
    }

    /** A new canvas was analysed elsewhere: offer it without stealing this tab. */
    function announceCanvas(payload) {
        var notice = document.createElement('div');
        notice.setAttribute('style', [
            'position:fixed', 'right:10px', 'bottom:46px', 'z-index:99999',
            'font:12px/1.6 sans-serif', 'background:rgba(20,70,130,0.95)', 'color:#fff',
            'padding:8px 12px', 'border-radius:4px', 'box-shadow:0 2px 8px rgba(0,0,0,0.4)'
        ].join(';'));
        notice.appendChild(document.createTextNode('new canvas: ' + payload.title + ' '));
        notice.appendChild(anchor('open in a new tab', payload.url, 'color:#cfe6ff;text-decoration:underline'));
        var close = document.createElement('a');
        close.href = '#';
        close.textContent = ' ✕';
        close.setAttribute('style', 'color:#cfe6ff;text-decoration:none');
        close.addEventListener('click', function (e) {
            e.preventDefault();
            if (notice.parentNode) { notice.parentNode.removeChild(notice); }
        });
        notice.appendChild(close);
        (document.body || document.documentElement).appendChild(notice);
        setTimeout(function () {
            if (notice.parentNode) { notice.parentNode.removeChild(notice); }
        }, 15000);
        if (switcherOpen) { renderCanvasList(); }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', addBadge);
    } else {
        addBadge();
    }

    window.addEventListener('beforeunload', function () {
        stream.close();
    });
})();
