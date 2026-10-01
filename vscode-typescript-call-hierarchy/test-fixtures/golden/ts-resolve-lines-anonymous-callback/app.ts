function init(): void {
  renderCart(document.getElementById('cart'));
  document.getElementById('checkout')!.addEventListener('click', function () {
    submitOrder('book', 1);
  });
}

function submitOrder(item: string, quantity: number): Promise<Response> {
  return fetch('/orders', {
    method: 'POST',
    body: JSON.stringify({ item: item, quantity: quantity })
  });
}

function renderCart(el: HTMLElement | null): void {
  if (el) el.textContent = '0';
}

document.addEventListener('DOMContentLoaded', init);
