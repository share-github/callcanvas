function renderTitle(item) {
    var safe = escapeHtml(item.title);
    return truncate(safe, 50);
}
