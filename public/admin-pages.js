(() => {
  const form = document.getElementById('page-order-form');
  const list = document.getElementById('page-list');
  if (!form || !list) return;

  let draggedItem = null;

  function updateMoveButtons() {
    const items = [...list.querySelectorAll('[data-page-item]')];
    items.forEach((item, index) => {
      item.querySelector('.move-page-up').disabled = index === 0;
      item.querySelector('.move-page-down').disabled = index === items.length - 1;
    });
  }

  list.addEventListener('dragstart', (event) => {
    const item = event.target.closest('[data-page-item]');
    if (!item || event.target.closest('a, button')) {
      event.preventDefault();
      return;
    }
    draggedItem = item;
    item.classList.add('is-dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', item.querySelector('input[name="order"]').value);
  });

  list.addEventListener('dragover', (event) => {
    if (!draggedItem) return;
    event.preventDefault();
    const target = event.target.closest('[data-page-item]');
    if (!target || target === draggedItem) return;
    const insertAfter = event.clientY > target.getBoundingClientRect().top + target.offsetHeight / 2;
    list.insertBefore(draggedItem, insertAfter ? target.nextElementSibling : target);
  });

  list.addEventListener('drop', (event) => {
    if (!draggedItem) return;
    event.preventDefault();
    updateMoveButtons();
  });

  list.addEventListener('dragend', () => {
    if (draggedItem) draggedItem.classList.remove('is-dragging');
    draggedItem = null;
    updateMoveButtons();
  });

  list.addEventListener('click', (event) => {
    const item = event.target.closest('[data-page-item]');
    if (!item) return;
    if (event.target.closest('.move-page-up') && item.previousElementSibling) {
      list.insertBefore(item, item.previousElementSibling);
    } else if (event.target.closest('.move-page-down') && item.nextElementSibling) {
      list.insertBefore(item.nextElementSibling, item);
    } else {
      return;
    }
    updateMoveButtons();
  });
})();
