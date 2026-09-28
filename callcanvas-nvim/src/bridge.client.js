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
    // Combos the browser would use to leave the page. Answering them with
    // jump-back keeps muscle memory from the VS Code build working.
    var BACK_ALIASES = ['alt+left', 'meta+left', 'meta+[', 'ctrl+['];

    document.addEventListener('keydown', function (e) {
        if (isTyping(e.target)) { return; }
        var binding = keyBinding(e);
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
        var jumpBackLabel = JUMP_BACK_KEY.replace(/\b\w/g, function (c) { return c.toUpperCase(); });
        var label = document.createElement('span');
        label.textContent = (FOLLOW ? 'following newest' : 'pinned') + ' · back: ' + jumpBackLabel + ' ';
        label.title = 'jump back in history: ' + JUMP_BACK_KEY
            + (SETTINGS.interceptBrowserBack !== false ? ' (alt+left also works)' : '');
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
