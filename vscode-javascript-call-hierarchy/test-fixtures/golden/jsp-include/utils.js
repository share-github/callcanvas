function formatDate(date) {
    return date.toISOString().split('T')[0];
}

function sanitize(str) {
    return str.replace(/[<>&"]/g, '');
}
