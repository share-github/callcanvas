function padLeft(str, len, ch) {
    ch = ch || ' ';
    while (str.length < len) { str = ch + str; }
    return str;
}

function formatCurrency(amount) {
    return '$' + padLeft(amount.toFixed(2), 8);
}
