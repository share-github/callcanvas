function buildQuery(params) {
    return Object.keys(params).map(function(k) {
        return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
    }).join('&');
}

function parseQuery(str) {
    var result = {};
    str.split('&').forEach(function(pair) {
        var kv = pair.split('=');
        result[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || '');
    });
    return result;
}
