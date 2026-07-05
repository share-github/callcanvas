function renderOrder(order) {
    var label = sanitize(order.name);
    var date = formatDate(order.createdAt);
    return label + ' (' + date + ')';
}
