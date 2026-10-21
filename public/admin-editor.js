(() => {
  const form = document.querySelector('form[enctype="multipart/form-data"]');
  const editor = document.getElementById('rich-editor');
  const source = document.getElementById('content');
  const toolbar = document.getElementById('editor-toolbar');
  if (!form || !editor || !source || !toolbar) return;

  const pageSelect = document.getElementById('page-link');
  const assetSelect = document.getElementById('asset-link');
  const sourceToggle = document.getElementById('toggle-html-source');
  const imageWidth = document.getElementById('image-width');
  const imageWidthUnit = document.getElementById('image-width-unit');
  const formulaPreview = document.getElementById('formula-preview');
  const formulaPreviewToggle = document.getElementById('toggle-formula-preview');
  const formulaDialog = document.getElementById('formula-dialog');
  const formulaSource = document.getElementById('formula-source');
  const formulaDialogPreview = document.getElementById('formula-dialog-preview');
  const formulaDialogError = document.getElementById('formula-dialog-error');
  let sourceMode = false;
  let savedRange = null;
  let savedSourceRange = null;
  let selectedImage = null;

  function safeImageWidth(style) {
    const match = String(style || '').match(/(?:^|;)\s*width\s*:\s*(\d+(?:\.\d{1,2})?)(px|%)\s*(?:;|$)/i);
    if (!match) return '';
    const value = Number(match[1]);
    const unit = match[2].toLowerCase();
    if (!Number.isFinite(value) || value <= 0 || (unit === '%' && value > 100) || (unit === 'px' && value > 2000)) {
      return '';
    }
    return `${value}${unit}`;
  }

  function rememberSelection() {
    const selection = window.getSelection();
    if (selection && selection.rangeCount && editor.contains(selection.anchorNode)) {
      savedRange = selection.getRangeAt(0).cloneRange();
    }
  }

  function restoreSelection() {
    editor.focus();
    if (!savedRange) return;
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(savedRange);
  }

  function insertHtml(html) {
    restoreSelection();
    document.execCommand('insertHTML', false, html);
    rememberSelection();
  }

  function escapeAttribute(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[character]);
  }

  // В режиме просмотра HTML-кода редактор (contenteditable) скрыт, поэтому
  // execCommand ничего не делает: вставляем прямо в textarea, оборачивая
  // выделенный текст ссылкой (или подставляя label, если выделения нет).
  function insertIntoSource(html, range) {
    const start = range?.start ?? source.selectionStart ?? source.value.length;
    const end = range?.end ?? source.selectionEnd ?? start;
    source.focus();
    source.setRangeText(html, start, end, 'end');
    source.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function insertLink(href, label) {
    if (sourceMode) {
      const start = source.selectionStart ?? source.value.length;
      const end = source.selectionEnd ?? start;
      const selectedText = source.value.slice(start, end) || label;
      insertIntoSource(`<a href="${escapeAttribute(href)}">${escapeAttribute(selectedText)}</a>`);
      return;
    }
    restoreSelection();
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && editor.contains(selection.anchorNode)) {
      document.execCommand('createLink', false, href);
    } else {
      insertHtml(`<a href="${escapeAttribute(href)}">${escapeAttribute(label)}</a>`);
    }
    rememberSelection();
  }

  function cleanPreview(html) {
    const documentCopy = new DOMParser().parseFromString(html, 'text/html');
    const allowed = new Set(['A', 'BLOCKQUOTE', 'BR', 'CODE', 'DIV', 'EM', 'FIGCAPTION', 'FIGURE', 'H2', 'H3', 'H4', 'HR', 'IMG', 'LI', 'OL', 'P', 'PRE', 'S', 'STRONG', 'U', 'UL']);
    for (const element of [...documentCopy.body.querySelectorAll('*')].reverse()) {
      if (!allowed.has(element.tagName)) {
        element.replaceWith(...element.childNodes);
        continue;
      }
      for (const attribute of [...element.attributes]) {
        if (element.tagName === 'A' && attribute.name === 'href'
          && (/^\/(?:[a-z0-9-]+)?$/.test(attribute.value) || /^\/uploads\/[a-f0-9]{32}\.(?:png|jpg|gif|webp|pdf)$/.test(attribute.value)
            || /^https:\/\/[^\s"'<>]+$/i.test(attribute.value) || /^mailto:[^\s"'<>]+$/i.test(attribute.value))) {
          continue;
        }
        if (element.tagName === 'IMG' && attribute.name === 'src'
          && /^\/uploads\/[a-f0-9]{32}\.(?:png|jpg|gif|webp)$/.test(attribute.value)) {
          continue;
        }
        if (element.tagName === 'IMG' && attribute.name === 'alt') continue;
        if (element.tagName === 'IMG' && attribute.name === 'style') {
          const width = safeImageWidth(attribute.value);
          if (width) element.setAttribute('style', `width: ${width}; max-width: 100%; height: auto`);
          else element.removeAttribute('style');
          continue;
        }
        if (attribute.name === 'title' && (element.tagName === 'A' || element.tagName === 'IMG')) continue;
        element.removeAttribute(attribute.name);
      }
    }
    return documentCopy.body.innerHTML;
  }

  editor.innerHTML = source.value;
  editor.hidden = false;
  source.hidden = true;
  toolbar.hidden = false;

  editor.addEventListener('mouseup', rememberSelection);
  editor.addEventListener('keyup', rememberSelection);
  editor.addEventListener('click', (event) => {
    const image = event.target.closest('img');
    if (selectedImage && selectedImage !== image) selectedImage.classList.remove('editor-image-selected');
    selectedImage = image && editor.contains(image) ? image : null;
    if (selectedImage) selectedImage.classList.add('editor-image-selected');
  });
  document.addEventListener('selectionchange', rememberSelection);

  toolbar.addEventListener('mousedown', (event) => {
    if (event.target.closest('button')) event.preventDefault();
  });

  toolbar.querySelectorAll('[data-command]').forEach((button) => {
    button.addEventListener('click', () => {
      restoreSelection();
      const value = button.dataset.command === 'formatBlock' ? `<${button.dataset.value}>` : button.dataset.value || null;
      document.execCommand(button.dataset.command, false, value);
      rememberSelection();
    });
  });

  document.getElementById('insert-page-link').addEventListener('click', () => {
    const option = pageSelect.selectedOptions[0];
    if (!option || !option.value) return;
    insertLink(option.value, option.textContent);
    pageSelect.selectedIndex = 0;
  });

  document.getElementById('insert-asset').addEventListener('click', () => {
    const option = assetSelect.selectedOptions[0];
    if (!option || !option.value) {
      window.alert('Сначала загрузите файл и сохраните страницу, затем выберите его в этом списке.');
      return;
    }
    const url = `/uploads/${option.value}`;
    if (option.dataset.type === 'application/pdf') {
      insertLink(url, option.textContent);
    } else {
      const name = escapeAttribute(option.textContent);
      const html = `<a href="${url}"><img src="${url}" alt="${name}"></a>`;
      if (sourceMode) insertIntoSource(html);
      else insertHtml(html);
    }
    assetSelect.selectedIndex = 0;
  });

  document.getElementById('apply-image-width').addEventListener('click', () => {
    if (sourceMode || !selectedImage || !editor.contains(selectedImage)) {
      window.alert('В визуальном редакторе сначала выберите изображение щелчком мыши.');
      return;
    }
    const value = Number(imageWidth.value);
    const unit = imageWidthUnit.value;
    const maximum = unit === '%' ? 100 : 2000;
    if (!Number.isFinite(value) || value <= 0 || value > maximum) {
      window.alert(unit === '%' ? 'Укажите ширину от 1 до 100%.' : 'Укажите ширину от 1 до 2000 пикселей.');
      imageWidth.focus();
      return;
    }
    selectedImage.style.width = `${value}${unit}`;
    selectedImage.style.maxWidth = '100%';
    selectedImage.style.height = 'auto';
  });

  function formulaText(display, latex) {
    return display ? `\\[${latex}\\]` : `\\(${latex}\\)`;
  }

  function openFormulaDialog(display) {
    rememberSelection();
    savedSourceRange = sourceMode
      ? { start: source.selectionStart ?? source.value.length, end: source.selectionEnd ?? source.value.length }
      : null;
    formulaSource.value = '';
    formulaDialogPreview.replaceChildren();
    formulaDialogError.textContent = '';
    formulaDialog.querySelector(`input[name="formula-mode"][value="${display ? 'display' : 'inline'}"]`).checked = true;
    formulaDialog.showModal();
    formulaSource.focus();
  }

  async function previewFormula() {
    const latex = formulaSource.value.trim();
    if (!latex) {
      formulaDialogError.textContent = 'Введите формулу для предпросмотра.';
      formulaSource.focus();
      return;
    }
    if (!window.MathJax) {
      formulaDialogError.textContent = 'Не удалось загрузить MathJax. Проверьте установку зависимостей и перезапустите сервер.';
      return;
    }
    const display = formulaDialog.querySelector('input[name="formula-mode"]:checked').value === 'display';
    window.MathJax.typesetClear([formulaDialogPreview]);
    formulaDialogPreview.replaceChildren();
    formulaDialogPreview.textContent = formulaText(display, latex);
    formulaDialogError.textContent = '';
    try {
      await window.MathJax.startup.promise;
      await window.MathJax.typesetPromise([formulaDialogPreview]);
    } catch (error) {
      console.error('Formula dialog preview failed:', error);
      formulaDialogError.textContent = 'Не удалось отобразить формулу. Подробности доступны в консоли браузера.';
    }
  }

  function insertFormula() {
    const latex = formulaSource.value.trim();
    if (!latex) {
      formulaDialogError.textContent = 'Введите формулу перед вставкой.';
      formulaSource.focus();
      return;
    }
    const display = formulaDialog.querySelector('input[name="formula-mode"]:checked').value === 'display';
    const formula = formulaText(display, latex);
    formulaDialog.close();
    if (sourceMode) {
      insertIntoSource(formula, savedSourceRange);
    } else {
      insertHtml(display ? `<p>${escapeAttribute(formula)}</p>` : escapeAttribute(formula));
    }
    savedSourceRange = null;
  }

  document.getElementById('insert-inline-math').addEventListener('click', () => openFormulaDialog(false));
  document.getElementById('insert-display-math').addEventListener('click', () => openFormulaDialog(true));
  document.getElementById('preview-formula').addEventListener('click', previewFormula);
  document.getElementById('insert-formula').addEventListener('click', insertFormula);
  document.getElementById('cancel-formula').addEventListener('click', () => formulaDialog.close());
  formulaDialog.addEventListener('close', () => {
    window.MathJax?.typesetClear([formulaDialogPreview]);
    formulaDialogPreview.replaceChildren();
    formulaDialogError.textContent = '';
    savedSourceRange = null;
  });

  formulaPreviewToggle.addEventListener('click', async () => {
    if (!formulaPreview.hidden) {
      window.MathJax?.typesetClear([formulaPreview]);
      formulaPreview.hidden = true;
      formulaPreviewToggle.textContent = 'Предпросмотр формул';
      return;
    }
    if (!window.MathJax) {
      window.alert('Не удалось загрузить MathJax. Проверьте установку зависимостей и перезапустите сервер.');
      return;
    }
    formulaPreview.innerHTML = sourceMode ? cleanPreview(source.value) : editor.innerHTML;
    formulaPreview.hidden = false;
    formulaPreviewToggle.disabled = true;
    try {
      await window.MathJax.startup.promise;
      await window.MathJax.typesetPromise([formulaPreview]);
      formulaPreviewToggle.textContent = 'Скрыть предпросмотр';
    } catch (error) {
      console.error('Formula preview failed:', error);
      window.alert('Не удалось отобразить предпросмотр формул. Подробности доступны в консоли браузера.');
    } finally {
      formulaPreviewToggle.disabled = false;
    }
  });

  document.getElementById('insert-external-link').addEventListener('click', () => {
    const href = window.prompt('Введите ссылку https:// или mailto:');
    if (!href) return;
    const normalized = href.trim();
    if (!/^https:\/\/[^\s"'<>]+$/i.test(normalized) && !/^mailto:[^\s"'<>]+$/i.test(normalized)) {
      window.alert('Разрешены только HTTPS-ссылки и адреса электронной почты.');
      return;
    }
    insertLink(normalized, normalized);
  });

  sourceToggle.addEventListener('click', () => {
    if (sourceMode) {
      editor.innerHTML = cleanPreview(source.value);
      source.value = editor.innerHTML;
      selectedImage = null;
      source.hidden = true;
      editor.hidden = false;
      sourceToggle.textContent = 'Редактировать HTML';
      sourceMode = false;
      return;
    }
    source.value = editor.innerHTML;
    editor.hidden = true;
    source.hidden = false;
    source.focus();
    sourceToggle.textContent = 'Предпросмотр редактора';
    sourceMode = true;
  });

  form.addEventListener('submit', () => {
    if (!sourceMode) source.value = editor.innerHTML;
  });
})();
