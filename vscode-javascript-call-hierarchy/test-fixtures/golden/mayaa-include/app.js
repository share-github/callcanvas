function submitSearch(form) {
    var params = { q: form.query.value, page: 1 };
    var qs = buildQuery(params);
    window.location.href = '/search?' + qs;
}
