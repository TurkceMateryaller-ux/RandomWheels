import {
  auth,
  db,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  collection,
  collectionGroup,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
  query,
  where
} from './firebase.js';

document.addEventListener('DOMContentLoaded', () => {
  const palette = [
    { fill: '#082D5A', text: '#FFFFFF' },
    { fill: '#0B839A', text: '#FFFFFF' },
    { fill: '#F14F54', text: '#082D5A' },
    { fill: '#D7EDF3', text: '#082D5A' },
    { fill: '#E3B341', text: '#082D5A' },
    { fill: '#76558F', text: '#FFFFFF' },
    { fill: '#347858', text: '#FFFFFF' },
    { fill: '#E68136', text: '#082D5A' }
  ];
  const maxFileSize = 5 * 1024 * 1024;
  const maxProcessedImageSize = 100 * 1024;
  const imageDimensionSteps = [512, 384, 320, 256];
  const imageQualitySteps = [.82, .75, .68, .61, .54, .47, .4];
  const imageCache = new Map();
  let nextOptionId = 1;

  const createOption = text => ({
    id: `option-${nextOptionId++}`,
    text,
    imageBlob: null,
    imageUrl: '',
    imageName: '',
    imageId: null
  });
  const defaultOptions = () => [1, 2, 3, 4].map(number => createOption(`Вариант ${number}`));
  const wheels = Array.from({ length: 4 }, (_, index) => ({
    title: `Колесо ${index + 1}`,
    options: defaultOptions(),
    rotation: 0,
    spinning: false,
    result: null
  }));

  const setupView = document.getElementById('setup-view');
  const gameView = document.getElementById('game-view');
  const setupToolbar = document.getElementById('setup-toolbar');
  const gameToolbar = document.getElementById('game-toolbar');
  const editorsContainer = document.getElementById('editors-container');
  const wheelsContainer = document.getElementById('wheels-container');
  const editorTemplate = document.getElementById('editor-template');
  const wheelTemplate = document.getElementById('wheel-template');
  const startButton = document.getElementById('start-game');
  const editButton = document.getElementById('edit');
  const spinAllButton = document.getElementById('spin-all');
  const errorMessage = document.getElementById('setup-error');
  const countInputs = [...document.querySelectorAll('input[name="count"]')];
  const signInButton = document.getElementById('google-sign-in');
  const signOutButton = document.getElementById('sign-out');
  const userProfile = document.getElementById('user-profile');
  const userAvatar = document.getElementById('user-avatar');
  const userName = document.getElementById('user-name');
  const saveSetButton = document.getElementById('save-set');
  const mySetsButton = document.getElementById('my-sets');
  const publicSetsButton = document.getElementById('public-sets');
  const setsDialog = document.getElementById('sets-dialog');
  const closeSetsButton = document.getElementById('close-sets');
  const newSetButton = document.getElementById('new-set');
  const setsLoading = document.getElementById('sets-loading');
  const setsList = document.getElementById('sets-list');
  const appMessage = document.getElementById('app-message');
  const saveDialog = document.getElementById('save-dialog');
  const setNameInput = document.getElementById('set-name');
  const confirmSaveButton = document.getElementById('confirm-save');
  const publicDialog = document.getElementById('public-dialog');
  const publicSearch = document.getElementById('public-search');
  const publicLoading = document.getElementById('public-loading');
  const publicList = document.getElementById('public-list');
  let visibleCount = 1;
  let currentUser = null;
  let currentSetId = null;
  let currentSetName = '';
  let currentVisibility = 'private';
  let currentCopiedFrom = null;
  let openedPublicSource = null;
  let publicDocuments = [];
  let messageTimer = 0;

  function clearError() {
    errorMessage.hidden = true;
    errorMessage.textContent = '';
  }

  function showError(message) {
    errorMessage.textContent = message;
    errorMessage.hidden = false;
  }

  function revokeOptionUrl(option) {
    if (option.imageUrl && option.imageUrl.startsWith('blob:')) URL.revokeObjectURL(option.imageUrl);
    imageCache.delete(option.imageUrl);
    option.imageUrl = '';
  }

  function releaseImage(option) {
    revokeOptionUrl(option);
    option.imageBlob = null;
    option.imageName = '';
    option.imageId = null;
  }

  function canvasToWebP(canvas, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(blob => {
        if (blob?.type === 'image/webp') resolve(blob);
        else reject(new Error('Этот браузер не поддерживает преобразование изображений в WebP.'));
      }, 'image/webp', quality);
    });
  }

  async function decodeImageFile(file) {
    if ('createImageBitmap' in window) {
      try {
        const bitmap = await createImageBitmap(file);
        return {
          source: bitmap,
          width: bitmap.width,
          height: bitmap.height,
          release: () => bitmap.close()
        };
      } catch (error) {
        console.info('createImageBitmap недоступен для этого файла, используется резервное декодирование.');
      }
    }
    const sourceUrl = URL.createObjectURL(file);
    const image = new Image();
    try {
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error('Не удалось декодировать выбранное изображение.'));
        image.src = sourceUrl;
      });
      return {
        source: image,
        width: image.naturalWidth,
        height: image.naturalHeight,
        release: () => URL.revokeObjectURL(sourceUrl)
      };
    } catch (error) {
      URL.revokeObjectURL(sourceUrl);
      throw error;
    }
  }

  async function processSelectedImage(file) {
    const decoded = await decodeImageFile(file);
    try {
      if (!decoded.width || !decoded.height) throw new Error('Изображение имеет некорректный размер.');
      const originalMaxSide = Math.max(decoded.width, decoded.height);
      const limits = imageDimensionSteps.filter((limit, index) => index === 0 || originalMaxSide > limit);
      let lastResult = null;

      for (const maxSide of limits) {
        const scale = Math.min(1, maxSide / originalMaxSide);
        const width = Math.max(1, Math.round(decoded.width * scale));
        const height = Math.max(1, Math.round(decoded.height * scale));
        if (lastResult && lastResult.width === width && lastResult.height === height) continue;
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Браузер не поддерживает обработку изображения через Canvas.');
        context.drawImage(decoded.source, 0, 0, width, height);

        for (const quality of imageQualitySteps) {
          const blob = await canvasToWebP(canvas, quality);
          lastResult = { blob, width, height };
          if (blob.size <= maxProcessedImageSize) return lastResult;
        }
      }
      if (lastResult && lastResult.blob.size <= maxProcessedImageSize) return lastResult;
      throw new Error('Не удалось уменьшить изображение примерно до 100 КБ. Выберите менее детализированный файл.');
    } finally {
      decoded.release();
    }
  }

  function webPFileName(originalName) {
    const baseName = originalName.replace(/\.[^.]+$/, '').trim() || 'image';
    return `${baseName}.webp`;
  }

  function createImageTools(option, wheelIndex) {
    const tools = document.createElement('div');
    tools.className = 'image-tools';
    const fileId = `image-${wheelIndex}-${option.id}`;
    const fileInput = document.createElement('input');
    fileInput.className = 'file-input';
    fileInput.id = fileId;
    fileInput.type = 'file';
    fileInput.accept = 'image/png,image/jpeg,image/webp';
    const picker = document.createElement('label');
    picker.className = 'image-picker';
    picker.htmlFor = fileId;
    picker.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg><span>Добавить картинку</span>';
    fileInput.addEventListener('change', async event => {
      const file = event.target.files[0];
      if (!file) return;
      if (file.size > maxFileSize) {
        showError(`Файл «${file.name}» больше 5 МБ. Выберите изображение меньшего размера.`);
        fileInput.value = '';
        return;
      }
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
        showError('Можно выбрать изображение в формате PNG, JPEG или WebP.');
        fileInput.value = '';
        return;
      }
      const pickerText = picker.querySelector('span:last-child');
      fileInput.disabled = true;
      picker.classList.add('processing');
      picker.setAttribute('aria-disabled', 'true');
      pickerText.textContent = 'Обработка…';
      try {
        const processed = await processSelectedImage(file);
        const existingImageId = option.imageId || null;
        revokeOptionUrl(option);
        option.imageBlob = processed.blob;
        option.imageUrl = URL.createObjectURL(processed.blob);
        option.imageName = webPFileName(file.name);
        option.imageId = existingImageId;
        wheels[wheelIndex].result = null;
        clearError();
        console.info('Изображение обработано:', {
          width: processed.width,
          height: processed.height,
          sizeKB: Math.round(processed.blob.size / 1024)
        });
        renderEditors();
      } catch (error) {
        console.error('Ошибка обработки изображения:', error);
        showError(error?.message || 'Не удалось обработать изображение. Попробуйте другой файл.');
        fileInput.value = '';
        fileInput.disabled = false;
        picker.classList.remove('processing');
        picker.removeAttribute('aria-disabled');
        pickerText.textContent = 'Добавить картинку';
      }
    });
    tools.append(fileInput, picker);

    if (option.imageUrl) {
      const preview = document.createElement('span');
      preview.className = 'image-preview';
      const image = document.createElement('img');
      image.className = 'option-thumbnail';
      image.src = option.imageUrl;
      image.alt = option.imageName ? `Миниатюра ${option.imageName}` : 'Миниатюра варианта';
      const remove = document.createElement('button');
      remove.className = 'remove-image';
      remove.type = 'button';
      remove.textContent = '×';
      remove.setAttribute('aria-label', 'Удалить картинку');
      remove.addEventListener('click', () => {
        releaseImage(option);
        wheels[wheelIndex].result = null;
        clearError();
        renderEditors();
      });
      preview.append(image, remove);
      tools.appendChild(preview);
    }
    return tools;
  }

  function renderEditors() {
    editorsContainer.innerHTML = '';
    editorsContainer.classList.toggle('single', visibleCount === 1);
    wheels.slice(0, visibleCount).forEach((wheel, wheelIndex) => {
      const card = editorTemplate.content.firstElementChild.cloneNode(true);
      const titleInput = card.querySelector('.wheel-title-input');
      const titleLabel = card.querySelector('.field-label');
      const optionsList = card.querySelector('.options-list');
      const titleId = `wheel-title-${wheelIndex}`;
      titleInput.id = titleId;
      titleInput.value = wheel.title;
      titleLabel.htmlFor = titleId;
      titleInput.addEventListener('input', event => {
        wheel.title = event.target.value;
        clearError();
      });

      wheel.options.forEach((option, optionIndex) => {
        const row = document.createElement('div');
        row.className = 'option-row';
        const dot = document.createElement('span');
        dot.className = 'color-dot';
        dot.setAttribute('aria-hidden', 'true');
        dot.style.background = palette[optionIndex % palette.length].fill;
        const content = document.createElement('div');
        content.className = 'option-content';
        const input = document.createElement('input');
        input.className = 'option-input';
        input.type = 'text';
        input.maxLength = 80;
        input.value = option.text;
        input.placeholder = option.imageUrl ? 'Текст необязателен' : 'Введите текст или добавьте картинку';
        input.setAttribute('aria-label', `Вариант ${optionIndex + 1} колеса ${wheelIndex + 1}`);
        input.addEventListener('input', event => {
          option.text = event.target.value;
          wheel.result = null;
          clearError();
        });
        content.append(input, createImageTools(option, wheelIndex));
        const removeButton = document.createElement('button');
        removeButton.className = 'delete-option';
        removeButton.type = 'button';
        removeButton.textContent = '×';
        removeButton.setAttribute('aria-label', `Удалить вариант ${optionIndex + 1}`);
        removeButton.addEventListener('click', () => {
          releaseImage(option);
          wheel.options.splice(optionIndex, 1);
          wheel.result = null;
          clearError();
          renderEditors();
        });
        row.append(dot, content, removeButton);
        optionsList.appendChild(row);
      });

      card.querySelector('.add-option').addEventListener('click', () => {
        wheel.options.push(createOption(''));
        wheel.result = null;
        clearError();
        renderEditors();
        editorsContainer.children[wheelIndex].querySelector('.option-row:last-child .option-input').focus();
      });
      editorsContainer.appendChild(card);
    });
  }

  function loadCanvasImage(url, redraw) {
    if (!url) return null;
    if (imageCache.has(url)) return imageCache.get(url);
    const image = new Image();
    image.onload = redraw;
    image.src = url;
    imageCache.set(url, image);
    return image;
  }

  function drawCroppedImage(context, image, x, y, size) {
    if (!image || !image.complete || !image.naturalWidth) return;
    const sourceSize = Math.min(image.naturalWidth, image.naturalHeight);
    const sourceX = (image.naturalWidth - sourceSize) / 2;
    const sourceY = (image.naturalHeight - sourceSize) / 2;
    context.save();
    context.beginPath();
    context.arc(x, y, size / 2, 0, Math.PI * 2);
    context.clip();
    context.drawImage(image, sourceX, sourceY, sourceSize, sourceSize, x - size / 2, y - size / 2, size, size);
    context.restore();
    context.beginPath();
    context.arc(x, y, size / 2, 0, Math.PI * 2);
    context.strokeStyle = 'rgba(255,255,255,.92)';
    context.lineWidth = Math.max(2, size * .045);
    context.stroke();
  }

  function shortenLine(context, text, maxWidth) {
    if (context.measureText(text).width <= maxWidth) return text;
    let shortened = text;
    while (shortened.length > 1 && context.measureText(`${shortened}…`).width > maxWidth) {
      shortened = shortened.slice(0, -1);
    }
    return `${shortened.trimEnd()}…`;
  }

  function wrapText(context, text, maxWidth) {
    const normalized = text.trim().replace(/\s+/g, ' ');
    if (!normalized) return [];
    if (context.measureText(normalized).width <= maxWidth) return [normalized];
    const words = normalized.split(' ');
    let firstLine = '';
    while (words.length) {
      const candidate = firstLine ? `${firstLine} ${words[0]}` : words[0];
      if (context.measureText(candidate).width > maxWidth) break;
      firstLine = candidate;
      words.shift();
    }
    if (!firstLine) return [shortenLine(context, normalized, maxWidth)];
    if (!words.length) return [firstLine];
    return [firstLine, shortenLine(context, words.join(' '), maxWidth)];
  }

  function getCanvasFontSize(canvas, optionCount, textLength, hasImage) {
    const displayedSize = canvas.getBoundingClientRect().width || 300;
    const displayFactor = Math.max(.82, Math.min(1.15, displayedSize / 300));
    const countSizes = { 2: 16, 3: 15, 4: 14, 6: 12.5, 8: 11.5, 12: 10.5 };
    const closestCount = [2, 3, 4, 6, 8, 12].find(count => optionCount <= count) || 12;
    const lengthReduction = Math.min(2.5, Math.max(0, textLength - 14) * .1);
    const cssPixels = Math.max(9.5, (countSizes[closestCount] - lengthReduction - (hasImage ? .5 : 0)) * displayFactor);
    return cssPixels * (canvas.width / displayedSize);
  }

  function drawWheel(canvas, options) {
    const context = canvas.getContext('2d');
    const size = canvas.width;
    const center = size / 2;
    const radius = center - 8;
    const slice = Math.PI * 2 / options.length;
    context.clearRect(0, 0, size, size);

    options.forEach((option, index) => {
      const start = -Math.PI / 2 + index * slice;
      const color = palette[index % palette.length];
      context.beginPath();
      context.moveTo(center, center);
      context.arc(center, center, radius, start, start + slice);
      context.closePath();
      context.fillStyle = color.fill;
      context.globalAlpha = .9;
      context.fill();
      context.globalAlpha = 1;
      context.strokeStyle = 'rgba(255,255,255,.9)';
      context.lineWidth = 4;
      context.stroke();
    });

    options.forEach((option, index) => {
      const start = -Math.PI / 2 + index * slice;
      const middle = start + slice / 2;
      const color = palette[index % palette.length];
      const text = typeof option.text === 'string' ? option.text.trim() : '';
      const hasText = Boolean(text);
      const hasImage = Boolean(option.imageUrl);
      context.save();
      context.beginPath();
      context.moveTo(center, center);
      context.arc(center, center, radius - 3, start, start + slice);
      context.closePath();
      context.clip();

      const contentRadius = radius * (hasImage && hasText ? .56 : .63);
      const contentX = center + Math.cos(middle) * contentRadius;
      const contentY = center + Math.sin(middle) * contentRadius;
      const arcSpace = 2 * contentRadius * Math.sin(Math.min(slice / 2, Math.PI / 2));
      const displayedSize = canvas.getBoundingClientRect().width || 300;
      const displayScale = canvas.width / displayedSize;
      const contentScale = Math.max(.82, Math.min(1.2, displayedSize / 300));
      const requestedImageSize = (hasText ? 34 : 50) * contentScale * displayScale;
      const imageSize = Math.max(16 * contentScale * displayScale, Math.min(requestedImageSize, arcSpace * .52));
      if (hasImage) {
        const imageRadius = radius * (hasText ? .46 : .63);
        const imageX = center + Math.cos(middle) * imageRadius;
        const imageY = center + Math.sin(middle) * imageRadius;
        const image = loadCanvasImage(option.imageUrl, () => {
          if (canvas.isConnected) drawWheel(canvas, options);
        });
        drawCroppedImage(context, image, imageX, imageY, imageSize);
      }
      if (hasText) {
        const textRadius = radius * (hasImage ? .72 : .63);
        const textX = center + Math.cos(middle) * textRadius;
        const textY = center + Math.sin(middle) * textRadius;
        const fontSize = getCanvasFontSize(canvas, options.length, text.length, hasImage);
        const maxWidth = Math.max(fontSize * 1.8, Math.min(radius * (hasImage ? .42 : .68), arcSpace * .78));
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillStyle = color.text;
        context.shadowColor = color.text === '#FFFFFF' ? 'rgba(0,0,0,.35)' : 'rgba(255,255,255,.35)';
        context.shadowBlur = 4;
        context.font = `700 ${fontSize}px system-ui, sans-serif`;
        const lines = wrapText(context, text, maxWidth);
        const lineHeight = fontSize * 1.08;
        const firstY = textY - ((lines.length - 1) * lineHeight) / 2;
        lines.forEach((line, lineIndex) => {
          context.fillText(line, textX, firstY + lineIndex * lineHeight, maxWidth);
        });
      }
      context.restore();
    });
  }

  function showResult(element, option) {
    element.replaceChildren();
    if (!option) {
      element.textContent = 'Результат появится здесь';
      element.classList.remove('has-result');
      return;
    }
    const label = document.createElement('span');
    label.textContent = option.text.trim() ? `Выпало: ${option.text.trim()}` : 'Выпало изображение';
    element.appendChild(label);
    if (option.imageUrl) {
      const image = document.createElement('img');
      image.className = 'result-thumbnail';
      image.src = option.imageUrl;
      image.alt = option.imageName ? `Выбрано: ${option.imageName}` : 'Выбранное изображение';
      element.appendChild(image);
    }
    element.classList.add('has-result');
  }

  function renderGame() {
    wheelsContainer.innerHTML = '';
    wheelsContainer.className = `wheels-grid count-${visibleCount}`;
    wheels.slice(0, visibleCount).forEach((wheel, index) => {
      const card = wheelTemplate.content.firstElementChild.cloneNode(true);
      const canvas = card.querySelector('.wheel-canvas');
      card.querySelector('.wheel-title').textContent = wheel.title.trim() || `Колесо ${index + 1}`;
      canvas.style.transform = `rotate(${wheel.rotation}deg)`;
      showResult(card.querySelector('.result'), wheel.result);
      card.querySelector('.spin-one').addEventListener('click', () => spinWheel(index));
      wheelsContainer.appendChild(card);
      drawWheel(canvas, wheel.options);
    });
    updateGameControls();
  }

  function validationError() {
    for (let wheelIndex = 0; wheelIndex < visibleCount; wheelIndex += 1) {
      const wheel = wheels[wheelIndex];
      const emptyIndex = wheel.options.findIndex(option => !option.text.trim() && !option.imageUrl);
      if (emptyIndex !== -1) return `В колесе «${wheel.title.trim() || `Колесо ${wheelIndex + 1}`}» вариант ${emptyIndex + 1} пуст. Добавьте текст или картинку.`;
      if (wheel.options.length < 2) return `В колесе «${wheel.title.trim() || `Колесо ${wheelIndex + 1}`}» должно быть минимум два варианта.`;
    }
    return '';
  }

  function showGame() {
    const error = validationError();
    if (error) {
      showError(error);
      errorMessage.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    wheels.slice(0, visibleCount).forEach(wheel => {
      wheel.options.forEach(option => { option.text = option.text.trim(); });
      wheel.title = wheel.title.trim();
      wheel.result = null;
    });
    setupView.hidden = true;
    setupToolbar.hidden = true;
    gameView.hidden = false;
    gameToolbar.hidden = false;
    renderGame();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function showSetup() {
    if (wheels.some(wheel => wheel.spinning)) return;
    gameView.hidden = true;
    gameToolbar.hidden = true;
    setupView.hidden = false;
    setupToolbar.hidden = false;
    clearError();
    renderEditors();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function updateGameControls() {
    const anySpinning = wheels.slice(0, visibleCount).some(wheel => wheel.spinning);
    spinAllButton.disabled = anySpinning;
    editButton.disabled = anySpinning;
    [...wheelsContainer.children].forEach((card, index) => {
      card.querySelector('.spin-one').disabled = wheels[index].spinning;
    });
  }

  function spinWheel(index) {
    const wheel = wheels[index];
    if (!wheel || wheel.spinning) return;
    const card = wheelsContainer.children[index];
    const canvas = card.querySelector('.wheel-canvas');
    const result = card.querySelector('.result');
    const chosenIndex = Math.floor(Math.random() * wheel.options.length);
    const sliceDegrees = 360 / wheel.options.length;
    const normalized = ((wheel.rotation % 360) + 360) % 360;
    const targetNormalized = -(chosenIndex + .5) * sliceDegrees;
    let delta = ((targetNormalized - normalized) % 360 + 360) % 360;
    delta += 360 * (5 + Math.floor(Math.random() * 3));
    wheel.rotation += delta;
    wheel.spinning = true;
    wheel.result = null;
    result.classList.remove('has-result');
    result.textContent = 'Колесо вращается…';
    updateGameControls();
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    canvas.style.transition = reducedMotion ? 'transform .01s linear' : 'transform 4.2s cubic-bezier(.12,.65,.16,1)';
    requestAnimationFrame(() => { canvas.style.transform = `rotate(${wheel.rotation}deg)`; });
    window.setTimeout(() => {
      wheel.spinning = false;
      wheel.result = wheel.options[chosenIndex];
      showResult(result, wheel.result);
      updateGameControls();
    }, reducedMotion ? 20 : 4250);
  }

  function showAppMessage(message, isError = false) {
    window.clearTimeout(messageTimer);
    appMessage.textContent = message;
    appMessage.classList.toggle('error', isError);
    appMessage.hidden = false;
    messageTimer = window.setTimeout(() => { appMessage.hidden = true; }, 5000);
  }

  function authErrorMessage(error) {
    const messages = {
      'auth/popup-closed-by-user': 'Окно входа было закрыто до завершения авторизации.',
      'auth/popup-blocked': 'Браузер заблокировал окно входа. Разрешите всплывающие окна для этого сайта.',
      'auth/cancelled-popup-request': 'Вход уже выполняется. Дождитесь завершения.',
      'auth/network-request-failed': 'Не удалось связаться с Firebase. Проверьте подключение к интернету.',
      'auth/unauthorized-domain': 'Этот адрес сайта не добавлен в разрешённые домены Firebase Authentication.'
    };
    return messages[error?.code] || 'Не удалось выполнить вход через Google. Попробуйте ещё раз.';
  }

  async function runBusy(button, busyText, action) {
    if (button.disabled) return;
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = busyText;
    try {
      await action();
    } finally {
      button.disabled = false;
      button.textContent = originalText;
    }
  }

  function setVisibleCount(count) {
    visibleCount = Math.max(1, Math.min(4, Number(count) || 1));
    const input = document.querySelector(`input[name="count"][value="${visibleCount}"]`);
    if (input) input.checked = true;
  }

  function clearAllLocalImages() {
    wheels.flatMap(wheel => wheel.options).forEach(option => releaseImage(option));
  }

  function resetToNewSet() {
    clearAllLocalImages();
    wheels.splice(0, wheels.length, ...Array.from({ length: 4 }, (_, index) => ({
      title: `Колесо ${index + 1}`,
      options: defaultOptions(),
      rotation: 0,
      spinning: false,
      result: null
    })));
    currentSetId = null;
    currentSetName = '';
    currentVisibility = 'private';
    currentCopiedFrom = null;
    openedPublicSource = null;
    setVisibleCount(1);
    showSetup();
    renderEditors();
  }

  function serializeWheels() {
    return wheels.slice(0, visibleCount).map(wheel => ({
      title: wheel.title,
      options: wheel.options.map(option => ({
        id: option.id,
        text: option.text,
        imageId: option.imageId || null,
        imageUrl: null,
        imageName: option.imageName || ''
      }))
    }));
  }

  function hasLocalImages() {
    return wheels.slice(0, visibleCount).some(wheel => wheel.options.some(option => option.imageUrl || option.imageName));
  }

  async function saveCurrentSet() {
    if (!currentUser) {
      showAppMessage('Сначала войдите через Google, чтобы сохранить набор.', true);
      return;
    }
    if (openedPublicSource && openedPublicSource.ownerId !== currentUser.uid) {
      if (window.confirm('Чужой общедоступный оригинал нельзя изменить. Добавить его копию в «Мои наборы»?')) {
        await copyPublicSet(openedPublicSource.path, {
          ...openedPublicSource.data,
          name: currentSetName,
          wheelCount: visibleCount,
          wheels: serializeWheels()
        });
      }
      return;
    }
    const validationMessage = validationError();
    if (validationMessage) {
      showAppMessage(validationMessage, true);
      return;
    }
    setNameInput.value = currentSetName || 'Мой набор';
    const visibility = currentVisibility === 'public' ? 'public' : 'private';
    saveDialog.querySelector(`input[name="visibility"][value="${visibility}"]`).checked = true;
    saveDialog.showModal();
    setNameInput.focus();
  }

  async function persistCurrentSet() {
    const name = setNameInput.value.trim();
    if (!name) {
      showAppMessage('Название набора не может быть пустым.', true);
      return;
    }
    const visibility = saveDialog.querySelector('input[name="visibility"]:checked').value;
    if (hasLocalImages()) {
      window.alert('Текстовые данные будут сохранены. Облачное хранение картинок будет подключено позднее');
    }

    await runBusy(confirmSaveButton, 'Сохранение…', async () => {
      try {
        const setRef = currentSetId
          ? doc(db, 'users', currentUser.uid, 'wheelSets', currentSetId)
          : doc(collection(db, 'users', currentUser.uid, 'wheelSets'));
        const data = {
          name,
          wheelCount: visibleCount,
          wheels: serializeWheels(),
          ownerId: currentUser.uid,
          authorName: currentUser.displayName || 'Пользователь',
          visibility,
          updatedAt: serverTimestamp()
        };
        if (currentCopiedFrom) data.copiedFrom = currentCopiedFrom;
        if (!currentSetId) data.createdAt = serverTimestamp();
        await setDoc(setRef, data, { merge: Boolean(currentSetId) });
        currentSetId = setRef.id;
        currentSetName = name;
        currentVisibility = visibility;
        openedPublicSource = null;
        saveDialog.close();
        showAppMessage('Набор сохранён.');
      } catch (error) {
        console.error('Ошибка сохранения набора:', error);
        showAppMessage('Не удалось сохранить набор. Проверьте подключение и правила доступа Firestore.', true);
      }
    });
  }

  function formatSetDate(timestamp) {
    if (!timestamp || typeof timestamp.toDate !== 'function') return 'Дата изменения недоступна';
    return `Изменён: ${timestamp.toDate().toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' })}`;
  }

  function deserializeOption(rawOption) {
    if (typeof rawOption === 'string') return createOption(rawOption);
    return {
      id: rawOption?.id || `option-${nextOptionId++}`,
      text: typeof rawOption?.text === 'string' ? rawOption.text : '',
      imageBlob: null,
      imageUrl: '',
      imageName: typeof rawOption?.imageName === 'string' ? rawOption.imageName : '',
      imageId: rawOption?.imageId || null
    };
  }

  function applySetData(setId, data, publicSource = null) {
    clearAllLocalImages();
    const savedWheels = Array.isArray(data.wheels) ? data.wheels.slice(0, 4) : [];
    const restored = Array.from({ length: 4 }, (_, index) => {
      const savedWheel = savedWheels[index];
      return savedWheel ? {
        title: typeof savedWheel.title === 'string' ? savedWheel.title : `Колесо ${index + 1}`,
        options: Array.isArray(savedWheel.options) ? savedWheel.options.map(deserializeOption) : defaultOptions(),
        rotation: 0,
        spinning: false,
        result: null
      } : {
        title: `Колесо ${index + 1}`,
        options: defaultOptions(),
        rotation: 0,
        spinning: false,
        result: null
      };
    });
    wheels.splice(0, wheels.length, ...restored);
    currentSetId = setId;
    currentSetName = typeof data.name === 'string' ? data.name : '';
    currentVisibility = data.visibility === 'public' ? 'public' : 'private';
    currentCopiedFrom = typeof data.copiedFrom === 'string' ? data.copiedFrom : null;
    openedPublicSource = publicSource;
    setVisibleCount(data.wheelCount);
    showSetup();
    renderEditors();
  }

  async function openSet(setId, button) {
    if (!currentUser) return;
    await runBusy(button, 'Загрузка…', async () => {
      try {
        const snapshot = await getDoc(doc(db, 'users', currentUser.uid, 'wheelSets', setId));
        if (!snapshot.exists()) {
          showAppMessage('Набор не найден. Возможно, он уже удалён.', true);
          return;
        }
        applySetData(snapshot.id, snapshot.data());
        setsDialog.close();
        showAppMessage(`Набор «${currentSetName || 'Без названия'}» загружен.`);
      } catch (error) {
        console.error('Ошибка загрузки набора:', error);
        showAppMessage('Не удалось загрузить набор. Попробуйте ещё раз.', true);
      }
    });
  }

  async function removeSet(setId, name, button) {
    if (!currentUser || !window.confirm(`Удалить набор «${name}»? Это действие нельзя отменить.`)) return;
    await runBusy(button, 'Удаление…', async () => {
      try {
        await deleteDoc(doc(db, 'users', currentUser.uid, 'wheelSets', setId));
        if (currentSetId === setId) {
          currentSetId = null;
          currentSetName = '';
          currentVisibility = 'private';
          currentCopiedFrom = null;
        }
        await loadSets();
        showAppMessage('Набор удалён.');
      } catch (error) {
        console.error('Ошибка удаления набора:', error);
        showAppMessage('Не удалось удалить набор. Попробуйте ещё раз.', true);
      }
    });
  }

  async function changeSetVisibility(setId, visibility, select) {
    if (!currentUser || select.disabled) return;
    const previous = select.dataset.previous || 'private';
    select.disabled = true;
    try {
      await setDoc(doc(db, 'users', currentUser.uid, 'wheelSets', setId), {
        ownerId: currentUser.uid,
        authorName: currentUser.displayName || 'Пользователь',
        visibility,
        updatedAt: serverTimestamp()
      }, { merge: true });
      select.dataset.previous = visibility;
      if (currentSetId === setId) currentVisibility = visibility;
      showAppMessage(visibility === 'public' ? 'Набор теперь доступен всем.' : 'Набор теперь виден только вам.');
    } catch (error) {
      console.error('Ошибка изменения видимости:', error);
      select.value = previous;
      showAppMessage('Не удалось изменить видимость набора.', true);
    } finally {
      select.disabled = false;
    }
  }

  function renderSets(documents) {
    setsList.replaceChildren();
    if (!documents.length) {
      const empty = document.createElement('p');
      empty.className = 'sets-empty';
      empty.textContent = 'У вас пока нет сохранённых наборов.';
      setsList.appendChild(empty);
      return;
    }
    documents.forEach(snapshot => {
      const data = snapshot.data();
      const item = document.createElement('article');
      item.className = 'set-item';
      const info = document.createElement('div');
      info.className = 'set-info';
      const name = document.createElement('p');
      name.className = 'set-name';
      name.textContent = data.name || 'Без названия';
      const date = document.createElement('p');
      date.className = 'set-date';
      date.textContent = formatSetDate(data.updatedAt);
      const visibility = data.visibility === 'public' ? 'public' : 'private';
      const visibilitySelect = document.createElement('select');
      visibilitySelect.className = 'visibility-select';
      visibilitySelect.setAttribute('aria-label', `Видимость набора ${data.name || 'Без названия'}`);
      visibilitySelect.innerHTML = '<option value="private">🔒 Только мне</option><option value="public">🌐 Доступно всем</option>';
      visibilitySelect.value = visibility;
      visibilitySelect.dataset.previous = visibility;
      visibilitySelect.addEventListener('change', () => changeSetVisibility(snapshot.id, visibilitySelect.value, visibilitySelect));
      info.append(name, date, visibilitySelect);
      const actions = document.createElement('div');
      actions.className = 'set-actions';
      const openButton = document.createElement('button');
      openButton.className = 'button secondary compact';
      openButton.type = 'button';
      openButton.textContent = 'Открыть';
      openButton.addEventListener('click', () => openSet(snapshot.id, openButton));
      const deleteButton = document.createElement('button');
      deleteButton.className = 'button secondary compact set-delete';
      deleteButton.type = 'button';
      deleteButton.textContent = 'Удалить';
      deleteButton.addEventListener('click', () => removeSet(snapshot.id, data.name || 'Без названия', deleteButton));
      actions.append(openButton, deleteButton);
      item.append(info, actions);
      setsList.appendChild(item);
    });
  }

  async function loadSets() {
    if (!currentUser) {
      showAppMessage('Сначала войдите через Google, чтобы открыть свои наборы.', true);
      return;
    }
    setsLoading.hidden = false;
    setsList.hidden = true;
    mySetsButton.disabled = true;
    newSetButton.disabled = true;
    try {
      const snapshot = await getDocs(collection(db, 'users', currentUser.uid, 'wheelSets'));
      const documents = [...snapshot.docs].sort((left, right) => {
        const leftTime = left.data().updatedAt?.toMillis?.() || 0;
        const rightTime = right.data().updatedAt?.toMillis?.() || 0;
        return rightTime - leftTime;
      });
      renderSets(documents);
    } catch (error) {
      console.error('Ошибка загрузки списка наборов:', error);
      renderSets([]);
      showAppMessage('Не удалось загрузить наборы. Проверьте подключение и правила доступа Firestore.', true);
    } finally {
      setsLoading.hidden = true;
      setsList.hidden = false;
      mySetsButton.disabled = false;
      newSetButton.disabled = false;
    }
  }

  function sanitizeStoredWheels(data) {
    return (Array.isArray(data.wheels) ? data.wheels : []).slice(0, 4).map((wheel, wheelIndex) => ({
      title: typeof wheel?.title === 'string' ? wheel.title : `Колесо ${wheelIndex + 1}`,
      options: (Array.isArray(wheel?.options) ? wheel.options : []).map(rawOption => {
        const option = typeof rawOption === 'string' ? { text: rawOption } : (rawOption || {});
        return {
          id: option.id || `copied-${nextOptionId++}`,
          text: typeof option.text === 'string' ? option.text : '',
          imageId: null,
          imageUrl: null,
          imageName: typeof option.imageName === 'string' ? option.imageName : ''
        };
      })
    }));
  }

  async function copyPublicSet(sourcePath, data, button = null) {
    if (!currentUser) {
      showAppMessage('Сначала войдите через Google, чтобы добавить набор в свои.', true);
      return;
    }
    const action = async () => {
      try {
        const copyName = `Копия — ${data.name || 'Без названия'}`;
        const copiedData = {
          name: copyName,
          wheelCount: Math.max(1, Math.min(4, Number(data.wheelCount) || 1)),
          wheels: sanitizeStoredWheels(data),
          ownerId: currentUser.uid,
          authorName: currentUser.displayName || 'Пользователь',
          visibility: 'private',
          copiedFrom: sourcePath,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        };
        const copyRef = doc(collection(db, 'users', currentUser.uid, 'wheelSets'));
        await setDoc(copyRef, copiedData);
        applySetData(copyRef.id, copiedData);
        currentCopiedFrom = sourcePath;
        if (publicDialog.open) publicDialog.close();
        showAppMessage('Набор добавлен в “Мои наборы”.');
      } catch (error) {
        console.error('Ошибка копирования набора:', error);
        showAppMessage('Не удалось добавить набор в «Мои наборы».', true);
      }
    };
    if (button) await runBusy(button, 'Добавление…', action);
    else await action();
  }

  function openPublicSet(snapshot) {
    const data = snapshot.data();
    const isOwner = Boolean(currentUser && data.ownerId === currentUser.uid);
    applySetData(isOwner ? snapshot.id : null, data, isOwner ? null : {
      path: snapshot.ref.path,
      ownerId: data.ownerId || '',
      data
    });
    publicDialog.close();
    showGame();
    if (!isOwner) showAppMessage('Открыт общедоступный набор. Чтобы изменить и сохранить его, сначала добавьте копию в свои.');
  }

  function renderPublicSets() {
    const search = publicSearch.value.trim().toLocaleLowerCase('ru-RU');
    const filtered = publicDocuments.filter(snapshot => (snapshot.data().name || '').toLocaleLowerCase('ru-RU').includes(search));
    publicList.replaceChildren();
    if (!filtered.length) {
      const empty = document.createElement('p');
      empty.className = 'sets-empty';
      empty.textContent = search ? 'Наборы с таким названием не найдены.' : 'Общих наборов пока нет.';
      publicList.appendChild(empty);
      return;
    }
    filtered.forEach(snapshot => {
      const data = snapshot.data();
      const item = document.createElement('article');
      item.className = 'set-item';
      const info = document.createElement('div');
      info.className = 'set-info';
      const name = document.createElement('p');
      name.className = 'set-name';
      name.textContent = data.name || 'Без названия';
      const date = document.createElement('p');
      date.className = 'set-date';
      date.textContent = formatSetDate(data.updatedAt);
      const meta = document.createElement('div');
      meta.className = 'set-meta';
      const author = document.createElement('span');
      author.textContent = `Автор: ${data.authorName || 'Пользователь'}`;
      const count = document.createElement('span');
      count.textContent = `Колёс: ${Math.max(1, Math.min(4, Number(data.wheelCount) || 1))}`;
      meta.append(author, count);
      info.append(name, date, meta);
      const actions = document.createElement('div');
      actions.className = 'set-actions';
      const openButton = document.createElement('button');
      openButton.className = 'button secondary compact';
      openButton.type = 'button';
      openButton.textContent = 'Открыть';
      openButton.addEventListener('click', () => openPublicSet(snapshot));
      const copyButton = document.createElement('button');
      copyButton.className = 'button primary compact';
      copyButton.type = 'button';
      copyButton.textContent = 'Добавить в мои';
      copyButton.addEventListener('click', () => copyPublicSet(snapshot.ref.path, data, copyButton));
      actions.append(openButton, copyButton);
      item.append(info, actions);
      publicList.appendChild(item);
    });
  }

  async function openPublicDialog() {
    publicDialog.showModal();
    publicSearch.value = '';
    publicLoading.hidden = false;
    publicList.hidden = true;
    publicSetsButton.disabled = true;
    try {
      const publicQuery = query(collectionGroup(db, 'wheelSets'), where('visibility', '==', 'public'));
      const snapshot = await getDocs(publicQuery);
      publicDocuments = [...snapshot.docs].sort((left, right) => (right.data().updatedAt?.toMillis?.() || 0) - (left.data().updatedAt?.toMillis?.() || 0));
      renderPublicSets();
    } catch (error) {
      console.error('Ошибка загрузки общих наборов:', error);
      publicDocuments = [];
      publicList.replaceChildren();
      const message = document.createElement('p');
      message.className = 'sets-empty';
      message.textContent = 'Не удалось загрузить общие наборы. Проверьте подключение и правила Firestore.';
      publicList.appendChild(message);
    } finally {
      publicLoading.hidden = true;
      publicList.hidden = false;
      publicSetsButton.disabled = false;
    }
  }

  async function openSetsDialog() {
    if (!currentUser) {
      showAppMessage('Сначала войдите через Google, чтобы открыть свои наборы.', true);
      return;
    }
    setsDialog.showModal();
    await loadSets();
  }

  countInputs.forEach(input => input.addEventListener('change', event => {
    visibleCount = Number(event.target.value);
    clearError();
    renderEditors();
  }));
  startButton.addEventListener('click', showGame);
  editButton.addEventListener('click', showSetup);
  spinAllButton.addEventListener('click', () => {
    for (let index = 0; index < visibleCount; index += 1) spinWheel(index);
  });
  signInButton.addEventListener('click', () => runBusy(signInButton, 'Вход…', async () => {
    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
    } catch (error) {
      console.error('Ошибка входа:', error);
      showAppMessage(authErrorMessage(error), true);
    }
  }));
  signOutButton.addEventListener('click', () => runBusy(signOutButton, 'Выход…', async () => {
    try {
      await signOut(auth);
      showAppMessage('Вы вышли из аккаунта.');
    } catch (error) {
      console.error('Ошибка выхода:', error);
      showAppMessage('Не удалось выйти из аккаунта. Попробуйте ещё раз.', true);
    }
  }));
  saveSetButton.addEventListener('click', saveCurrentSet);
  mySetsButton.addEventListener('click', openSetsDialog);
  publicSetsButton.addEventListener('click', openPublicDialog);
  confirmSaveButton.addEventListener('click', persistCurrentSet);
  publicSearch.addEventListener('input', renderPublicSets);
  closeSetsButton.addEventListener('click', () => setsDialog.close());
  document.querySelectorAll('[data-close-dialog]').forEach(button => {
    button.addEventListener('click', () => document.getElementById(button.dataset.closeDialog).close());
  });
  newSetButton.addEventListener('click', () => {
    setsDialog.close();
    resetToNewSet();
    showAppMessage('Создан новый набор со стандартными вариантами.');
  });
  setsDialog.addEventListener('click', event => {
    if (event.target === setsDialog) setsDialog.close();
  });
  onAuthStateChanged(auth, user => {
    if (currentUser?.uid !== user?.uid) {
      currentSetId = null;
      currentSetName = '';
      currentVisibility = 'private';
      currentCopiedFrom = null;
    }
    currentUser = user;
    signInButton.hidden = Boolean(user);
    userProfile.hidden = !user;
    if (user) {
      userName.textContent = user.displayName || 'Пользователь';
      userAvatar.hidden = !user.photoURL;
      userAvatar.src = user.photoURL || '';
      userAvatar.alt = user.displayName ? `Аватар ${user.displayName}` : 'Аватар пользователя';
    } else {
      userName.textContent = '';
      userAvatar.src = '';
      if (setsDialog.open) setsDialog.close();
      if (saveDialog.open) saveDialog.close();
    }
  });
  window.addEventListener('beforeunload', () => {
    wheels.flatMap(wheel => wheel.options).forEach(option => releaseImage(option));
  });

  renderEditors();
});
