function highlightActive(menuItems) {
    var current = window.location.pathname;
    menuItems.forEach(function(item) {
        if (item.href === current) {
            item.classList.add('active');
        }
    });
}
