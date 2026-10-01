function init() {
  renderCart(document.getElementById('cart'));
  document.getElementById('checkout').addEventListener('click', function () {
    submitOrder('book', cartCount());
  });
}

function submitOrder(item, quantity) {
  return fetch('/orders', {
    method: 'POST',
    body: JSON.stringify({ item: item, quantity: quantity })
  });
}

document.addEventListener('DOMContentLoaded', init);
