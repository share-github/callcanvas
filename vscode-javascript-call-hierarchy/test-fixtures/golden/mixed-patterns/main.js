// 無名関数コールバック + 内部でコールバック引き渡し + 通常呼び出しの複合
$(function() {
    initialize();
    document.addEventListener("DOMContentLoaded", onReady);
});

function initialize() {
    setupConfig();
}

function onReady() {
    renderApp();
}
