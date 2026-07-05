function renderPrice(product) {
    highlightActive(document.querySelectorAll('.menu-item'));
    return formatCurrency(product.price);
}
