function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

function truncate(str, len) {
    return str.length > len ? str.substring(0, len) + '...' : str;
}
