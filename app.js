let OUTPUT_WIDTH = 1200;
let OUTPUT_HEIGHT = 2000;
const MIN_CELL_RATIO = 0.12;
const HANDLE_HIT_SIZE = 16;
const BACKGROUND_COLOR = "#f3f5fb";
const MAX_WORKING_IMAGE_EDGE = 2400;
const IMPORT_CONCURRENCY = 2;
const DEFAULT_WATERMARK = `MOREALITYPHOTOGRAPH@${new Date().getFullYear()}`;
const PREFERENCES_KEY = "concatphoto.preferences.v1";
const RATIO_PRESETS = ["15:9", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "1:1", "21:9"];

const state = {
  images: [],
  selectedImageId: null,
  rows: [],
  ratioHeight: 15,
  ratioWidth: 9,
  watermarkEnabled: true,
  watermarkText: DEFAULT_WATERMARK,
  importTotal: 0,
  importDone: 0,
  importResetTimer: null,
  interaction: null,
  dragTargetIndex: null,
  renderFrame: null,
  layoutDirty: false,
  thumbsDirty: false,
};

const canvas = document.querySelector("#previewCanvas");
const ctx = canvas.getContext("2d");
const fileInput = document.querySelector("#fileInput");
const thumbGrid = document.querySelector("#thumbGrid");
const imageCount = document.querySelector("#imageCount");
const copyButton = document.querySelector("#copyButton");
const exportButton = document.querySelector("#exportButton");
const dropOverlay = document.querySelector("#dropOverlay");
const ratioPreset = document.querySelector("#ratioPreset");
const customRatioFields = document.querySelector("#customRatioFields");
const customRatioHeight = document.querySelector("#customRatioHeight");
const customRatioWidth = document.querySelector("#customRatioWidth");
const watermarkEnabled = document.querySelector("#watermarkEnabled");
const watermarkText = document.querySelector("#watermarkText");
const uploadProgress = document.querySelector("#uploadProgress");
const uploadProgressBar = document.querySelector("#uploadProgressBar");
const uploadProgressText = document.querySelector("#uploadProgressText");

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalize(values) {
  const total = values.reduce((sum, value) => sum + value, 0) || 1;
  return values.map((value) => value / total);
}

function getRatioPresetValue(height, width) {
  const value = `${height}:${width}`;
  return RATIO_PRESETS.includes(value) ? value : "custom";
}

function loadPreferences() {
  try {
    const raw = window.localStorage.getItem(PREFERENCES_KEY);
    if (!raw) return;
    const preferences = JSON.parse(raw);

    state.ratioHeight = clamp(Number(preferences.ratioHeight) || state.ratioHeight, 1, 99);
    state.ratioWidth = clamp(Number(preferences.ratioWidth) || state.ratioWidth, 1, 99);
    state.watermarkEnabled =
      typeof preferences.watermarkEnabled === "boolean"
        ? preferences.watermarkEnabled
        : state.watermarkEnabled;
    state.watermarkText =
      typeof preferences.watermarkText === "string" ? preferences.watermarkText : state.watermarkText;
  } catch {
    window.localStorage.removeItem(PREFERENCES_KEY);
  }
}

function savePreferences() {
  const preferences = {
    ratioHeight: state.ratioHeight,
    ratioWidth: state.ratioWidth,
    watermarkEnabled: state.watermarkEnabled,
    watermarkText: state.watermarkText,
  };
  window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
}

function syncControlsFromState() {
  const presetValue = getRatioPresetValue(state.ratioHeight, state.ratioWidth);
  ratioPreset.value = presetValue;
  customRatioFields.hidden = presetValue !== "custom";
  customRatioHeight.value = state.ratioHeight;
  customRatioWidth.value = state.ratioWidth;
  watermarkEnabled.checked = state.watermarkEnabled;
  watermarkText.value = state.watermarkText;
}

function updateCanvasSize() {
  OUTPUT_WIDTH = 1200;
  OUTPUT_HEIGHT = Math.round(OUTPUT_WIDTH * (state.ratioHeight / state.ratioWidth));
  canvas.width = OUTPUT_WIDTH;
  canvas.height = OUTPUT_HEIGHT;
  canvas.style.setProperty("--canvas-aspect", `${state.ratioWidth} / ${state.ratioHeight}`);
  canvas.style.setProperty("--canvas-width-ratio", String(state.ratioWidth / state.ratioHeight));
}

function scheduleRender({ layout = false, thumbs = false } = {}) {
  state.layoutDirty ||= layout;
  state.thumbsDirty ||= thumbs;
  if (state.renderFrame) return;

  state.renderFrame = window.requestAnimationFrame(() => {
    state.renderFrame = null;
    if (state.layoutDirty) {
      rebuildLayout();
      state.layoutDirty = false;
    }
    if (state.thumbsDirty) {
      renderThumbs();
      state.thumbsDirty = false;
    }
    render(ctx, true);
  });
}

function distributeRows(count) {
  if (count <= 0) return [];
  if (count <= 2) return Array.from({ length: count }, () => 1);

  const rows = [];
  let remaining = count;
  if (count % 2 === 1) {
    rows.push(1);
    remaining -= 1;
  }
  while (remaining > 0) {
    rows.push(Math.min(2, remaining));
    remaining -= 2;
  }
  return rows;
}

function rebuildLayout() {
  const rowCounts = distributeRows(state.images.length);
  const oldRows = state.rows;
  state.rows = rowCounts.map((cellCount, rowIndex) => {
    const oldRow = oldRows[rowIndex];
    return {
      height: oldRow?.height ?? 1 / rowCounts.length,
      widths:
        oldRow?.widths?.length === cellCount
          ? [...oldRow.widths]
          : Array.from({ length: cellCount }, () => 1 / cellCount),
    };
  });
  state.rows = normalizeRowHeights(state.rows);
}

function normalizeRowHeights(rows) {
  const heights = normalize(rows.map((row) => row.height));
  return rows.map((row, index) => ({
    ...row,
    height: heights[index],
    widths: normalize(row.widths),
  }));
}

function layoutCells(width = OUTPUT_WIDTH, height = OUTPUT_HEIGHT) {
  const cells = [];
  let imageIndex = 0;
  let y = 0;

  state.rows.forEach((row, rowIndex) => {
    const rowHeight = row.height * height;
    let x = 0;
    row.widths.forEach((cellWidthRatio, cellIndex) => {
      const cellWidth = cellWidthRatio * width;
      cells.push({
        rowIndex,
        cellIndex,
        imageIndex,
        x,
        y,
        w: cellWidth,
        h: rowHeight,
      });
      x += cellWidth;
      imageIndex += 1;
    });
    y += rowHeight;
  });

  return cells;
}

function getCanvasPoint(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * OUTPUT_WIDTH,
    y: ((event.clientY - rect.top) / rect.height) * OUTPUT_HEIGHT,
  };
}

function cellRectWithGap(cell) {
  return {
    x: Math.round(cell.x),
    y: Math.round(cell.y),
    w: Math.max(1, Math.round(cell.w)),
    h: Math.max(1, Math.round(cell.h)),
  };
}

function imageSourceRect(image, rect, sourceWidth = image.width, sourceHeight = image.height) {
  const imageRatio = sourceWidth / sourceHeight;
  const rectRatio = rect.w / rect.h;
  let cropWidth = sourceWidth;
  let cropHeight = sourceHeight;

  if (imageRatio > rectRatio) {
    cropWidth = sourceHeight * rectRatio;
  } else {
    cropHeight = sourceWidth / rectRatio;
  }

  const overflowX = sourceWidth - cropWidth;
  const overflowY = sourceHeight - cropHeight;
  const sourceX = overflowX * image.cropX;
  const sourceY = overflowY * image.cropY;

  return {
    sourceX,
    sourceY,
    sourceWidth: cropWidth,
    sourceHeight: cropHeight,
    overflowX,
    overflowY,
  };
}

function drawImageFitted(context, image, rect, useOriginal = false) {
  const element = useOriginal ? image.originalElement : image.previewElement;
  const width = useOriginal ? image.originalWidth : image.previewWidth;
  const height = useOriginal ? image.originalHeight : image.previewHeight;
  const source = imageSourceRect(image, rect, width, height);
  context.drawImage(
    element,
    source.sourceX,
    source.sourceY,
    source.sourceWidth,
    source.sourceHeight,
    rect.x,
    rect.y,
    rect.w,
    rect.h,
  );
}

function drawCell(context, cell, image, showControls, useOriginal = false) {
  const rect = cellRectWithGap(cell);

  context.save();
  context.beginPath();
  context.rect(rect.x, rect.y, rect.w, rect.h);
  context.clip();

  if (image) {
    drawImageFitted(context, image, rect, useOriginal);
  } else {
    context.fillStyle = "#e8edf5";
    context.fillRect(rect.x, rect.y, rect.w, rect.h);
  }

  if (showControls && image?.id === state.selectedImageId) {
    context.strokeStyle = "rgba(31, 122, 140, 0.95)";
    context.lineWidth = 6;
    context.strokeRect(rect.x + 3, rect.y + 3, rect.w - 6, rect.h - 6);
  }

  if (showControls && state.dragTargetIndex === cell.imageIndex) {
    context.fillStyle = "rgba(31, 122, 140, 0.16)";
    context.fillRect(rect.x, rect.y, rect.w, rect.h);
    context.strokeStyle = "rgba(31, 122, 140, 0.95)";
    context.lineWidth = 10;
    context.strokeRect(rect.x + 5, rect.y + 5, rect.w - 10, rect.h - 10);
  }

  context.restore();
}

function drawHandles(context) {
  context.save();
  context.lineCap = "round";
  context.strokeStyle = "rgba(255,255,255,0.82)";
  context.lineWidth = 8;
  context.setLineDash([18, 14]);

  let y = 0;
  state.rows.slice(0, -1).forEach((row) => {
    y += row.height * OUTPUT_HEIGHT;
    context.beginPath();
    context.moveTo(18, y);
    context.lineTo(OUTPUT_WIDTH - 18, y);
    context.stroke();
  });

  y = 0;
  state.rows.forEach((row) => {
    const rowHeight = row.height * OUTPUT_HEIGHT;
    let x = 0;
    row.widths.slice(0, -1).forEach((widthRatio) => {
      x += widthRatio * OUTPUT_WIDTH;
      context.beginPath();
      context.moveTo(x, y + 18);
      context.lineTo(x, y + rowHeight - 18);
      context.stroke();
    });
    y += rowHeight;
  });

  context.setLineDash([]);
  context.strokeStyle = "rgba(31, 122, 140, 0.96)";
  context.lineWidth = 3;
  y = 0;
  state.rows.slice(0, -1).forEach((row) => {
    y += row.height * OUTPUT_HEIGHT;
    context.beginPath();
    context.moveTo(18, y);
    context.lineTo(OUTPUT_WIDTH - 18, y);
    context.stroke();
  });
  context.restore();
}

function drawWatermark(context) {
  const text = state.watermarkText.trim().toUpperCase();
  if (!state.watermarkEnabled || !text) return;

  context.save();
  const fontSize = clamp(Math.round(OUTPUT_HEIGHT * 0.011), 10, 22);
  const tracking = Math.max(2, Math.round(fontSize * 0.2));
  context.font = `500 ${fontSize}px Optima, "Avenir Next", "Helvetica Neue", Arial, sans-serif`;
  context.textBaseline = "alphabetic";
  context.fillStyle = "rgba(255,255,255,0.88)";
  context.shadowColor = "rgba(0,0,0,0.42)";
  context.shadowBlur = 5;
  context.shadowOffsetY = 1;

  const y = OUTPUT_HEIGHT - Math.round(OUTPUT_HEIGHT * 0.026);
  drawTrackedText(context, text, OUTPUT_WIDTH / 2, y, tracking);
  context.restore();
}

function drawTrackedText(context, text, centerX, y, tracking) {
  const letters = [...text];
  const measuredWidth =
    letters.reduce((width, letter) => width + context.measureText(letter).width, 0) +
    tracking * Math.max(0, letters.length - 1);
  let x = centerX - measuredWidth / 2;

  letters.forEach((letter) => {
    context.fillText(letter, x, y);
    x += context.measureText(letter).width + tracking;
  });
}

function render(context, showControls = true, useOriginal = false) {
  context.fillStyle = BACKGROUND_COLOR;
  context.fillRect(0, 0, OUTPUT_WIDTH, OUTPUT_HEIGHT);

  const cells = layoutCells();
  cells.forEach((cell) => {
    drawCell(context, cell, state.images[cell.imageIndex], showControls, useOriginal);
  });

  drawWatermark(context);

  if (showControls && state.images.length > 1) {
    drawHandles(context);
  }
}

function drawPreview() {
  scheduleRender();
}

function renderThumbs() {
  imageCount.textContent = `${state.images.length} ${state.images.length === 1 ? "photo" : "photos"}`;
  thumbGrid.innerHTML = "";
  state.images.forEach((image) => {
    const item = document.createElement("div");
    item.className = `thumb${state.selectedImageId === image.id ? " is-selected" : ""}`;
    item.draggable = true;
    item.dataset.id = image.id;

    const img = document.createElement("img");
    img.src = image.url;
    img.alt = image.name;

    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Remove ${image.name}`);
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      removeImage(image.id);
    });

    item.addEventListener("click", () => {
      state.selectedImageId = image.id;
      renderThumbs();
      drawPreview();
    });

    item.addEventListener("dragstart", (event) => {
      event.dataTransfer.setData("text/plain", image.id);
    });

    item.addEventListener("dragover", (event) => {
      event.preventDefault();
    });

    item.addEventListener("drop", (event) => {
      event.preventDefault();
      const sourceId = event.dataTransfer.getData("text/plain");
      reorderImage(sourceId, image.id);
    });

    item.append(img, remove);
    thumbGrid.append(item);
  });
}

function reorderImage(sourceId, targetId) {
  if (!sourceId || sourceId === targetId) return;
  const sourceIndex = state.images.findIndex((image) => image.id === sourceId);
  const targetIndex = state.images.findIndex((image) => image.id === targetId);
  if (sourceIndex < 0 || targetIndex < 0) return;
  const [source] = state.images.splice(sourceIndex, 1);
  state.images.splice(targetIndex, 0, source);
  rebuildLayout();
  renderThumbs();
  drawPreview();
}

function moveImageToIndex(sourceIndex, targetIndex) {
  if (sourceIndex === targetIndex || sourceIndex < 0 || targetIndex < 0) return;
  const [source] = state.images.splice(sourceIndex, 1);
  state.images.splice(targetIndex, 0, source);
  state.selectedImageId = source.id;
  rebuildLayout();
  renderThumbs();
  drawPreview();
}

function removeImage(id) {
  const image = state.images.find((item) => item.id === id);
  if (image) URL.revokeObjectURL(image.url);
  state.images = state.images.filter((item) => item.id !== id);
  if (state.selectedImageId === id) {
    state.selectedImageId = state.images[0]?.id ?? null;
  }
  rebuildLayout();
  renderThumbs();
  drawPreview();
}

function addFiles(fileList) {
  const files = [...fileList].filter((file) => file.type.startsWith("image/"));
  if (!files.length) return;
  beginImport(files.length);
  processImportQueue(files);
}

async function processImportQueue(files) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(IMPORT_CONCURRENCY, files.length) }, async () => {
    while (cursor < files.length) {
      const file = files[cursor];
      cursor += 1;
      await importOneFile(file);
    }
  });

  await Promise.all(workers);
}

async function importOneFile(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const workingImage = makeWorkingImage(img);
    state.images.push({
      id: crypto.randomUUID(),
      name: file.name || "clipboard-image",
      url,
      width: workingImage.width,
      height: workingImage.height,
      previewWidth: workingImage.width,
      previewHeight: workingImage.height,
      previewElement: workingImage,
      originalWidth: img.naturalWidth || img.width,
      originalHeight: img.naturalHeight || img.height,
      originalElement: img,
      cropX: 0.5,
      cropY: 0.5,
    });
    state.selectedImageId = state.images.at(-1).id;
    scheduleRender({ layout: true, thumbs: true });
  } catch {
    URL.revokeObjectURL(url);
  } finally {
    markImportDone();
  }
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

function makeWorkingImage(image) {
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  const largestEdge = Math.max(width, height);

  if (largestEdge <= MAX_WORKING_IMAGE_EDGE) {
    image.width = width;
    image.height = height;
    return image;
  }

  const scale = MAX_WORKING_IMAGE_EDGE / largestEdge;
  const canvasElement = document.createElement("canvas");
  canvasElement.width = Math.round(width * scale);
  canvasElement.height = Math.round(height * scale);
  const context = canvasElement.getContext("2d");
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, canvasElement.width, canvasElement.height);
  return canvasElement;
}

function beginImport(count) {
  if (state.importResetTimer) {
    window.clearTimeout(state.importResetTimer);
    state.importResetTimer = null;
  }
  if (!state.importTotal) {
    state.importDone = 0;
  }
  state.importTotal += count;
  updateImportProgress();
}

function markImportDone() {
  state.importDone += 1;
  updateImportProgress();
  if (state.importDone >= state.importTotal) {
    state.importResetTimer = window.setTimeout(() => {
      state.importTotal = 0;
      state.importDone = 0;
      state.importResetTimer = null;
      updateImportProgress();
    }, 600);
  }
}

function updateImportProgress() {
  if (!state.importTotal) {
    uploadProgress.hidden = true;
    uploadProgressBar.style.width = "0%";
    uploadProgressText.textContent = "Processing photos";
    return;
  }

  const percent = Math.round((state.importDone / state.importTotal) * 100);
  uploadProgress.hidden = false;
  uploadProgressBar.style.width = `${percent}%`;
  uploadProgressText.textContent = `Processing photos ${state.importDone}/${state.importTotal}`;
}

async function pasteImages() {
  if (navigator.clipboard?.read) {
    try {
      const items = await navigator.clipboard.read();
      const files = [];
      for (const item of items) {
        const imageType = item.types.find((type) => type.startsWith("image/"));
        if (imageType) files.push(await item.getType(imageType));
      }
      if (files.length) addFiles(files);
    } catch {
      fileInput.click();
    }
  } else {
    fileInput.click();
  }
}

function hitTestHandles(point) {
  let y = 0;
  for (let rowIndex = 0; rowIndex < state.rows.length - 1; rowIndex += 1) {
    y += state.rows[rowIndex].height * OUTPUT_HEIGHT;
    if (Math.abs(point.y - y) <= HANDLE_HIT_SIZE) {
      return { type: "row", rowIndex };
    }
  }

  y = 0;
  for (let rowIndex = 0; rowIndex < state.rows.length; rowIndex += 1) {
    const row = state.rows[rowIndex];
    const rowHeight = row.height * OUTPUT_HEIGHT;
    if (point.y >= y && point.y <= y + rowHeight) {
      let x = 0;
      for (let cellIndex = 0; cellIndex < row.widths.length - 1; cellIndex += 1) {
        x += row.widths[cellIndex] * OUTPUT_WIDTH;
        if (Math.abs(point.x - x) <= HANDLE_HIT_SIZE) {
          return { type: "column", rowIndex, cellIndex };
        }
      }
    }
    y += rowHeight;
  }

  return null;
}

function hitTestCell(point) {
  return layoutCells().find(
    (cell) =>
      point.x >= cell.x &&
      point.x <= cell.x + cell.w &&
      point.y >= cell.y &&
      point.y <= cell.y + cell.h,
  );
}

function resizeRows(rowIndex, pointY) {
  const before = state.rows.slice(0, rowIndex).reduce((sum, row) => sum + row.height, 0);
  const pairTotal = state.rows[rowIndex].height + state.rows[rowIndex + 1].height;
  const targetTop = clamp(pointY / OUTPUT_HEIGHT - before, MIN_CELL_RATIO, pairTotal - MIN_CELL_RATIO);
  state.rows[rowIndex].height = targetTop;
  state.rows[rowIndex + 1].height = pairTotal - targetTop;
  state.rows = normalizeRowHeights(state.rows);
}

function resizeColumns(rowIndex, cellIndex, pointX) {
  const row = state.rows[rowIndex];
  const before = row.widths.slice(0, cellIndex).reduce((sum, width) => sum + width, 0);
  const pairTotal = row.widths[cellIndex] + row.widths[cellIndex + 1];
  const targetLeft = clamp(pointX / OUTPUT_WIDTH - before, MIN_CELL_RATIO, pairTotal - MIN_CELL_RATIO);
  row.widths[cellIndex] = targetLeft;
  row.widths[cellIndex + 1] = pairTotal - targetLeft;
  row.widths = normalize(row.widths);
}

function moveCrop(interaction, point) {
  const image = state.images[interaction.imageIndex];
  const dx = point.x - interaction.lastPoint.x;
  const dy = point.y - interaction.lastPoint.y;
  const rect = cellRectWithGap(interaction.cell);

  const source = imageSourceRect(image, rect, image.previewWidth, image.previewHeight);
  if (source.overflowX > 0) {
    image.cropX = clamp(image.cropX - dx / rect.w, 0, 1);
  }
  if (source.overflowY > 0) {
    image.cropY = clamp(image.cropY - dy / rect.h, 0, 1);
  }

  interaction.lastPoint = point;
}

function updateCanvasDragTarget(interaction, point) {
  const targetCell = hitTestCell(point);
  const nextTargetIndex =
    targetCell && targetCell.imageIndex !== interaction.imageIndex ? targetCell.imageIndex : null;

  if (state.dragTargetIndex !== nextTargetIndex) {
    state.dragTargetIndex = nextTargetIndex;
    drawPreview();
  }
}

function updateCursor(event) {
  const point = getCanvasPoint(event);
  const handle = hitTestHandles(point);
  if (handle?.type === "row") {
    canvas.style.cursor = "ns-resize";
  } else if (handle?.type === "column") {
    canvas.style.cursor = "ew-resize";
  } else if (hitTestCell(point)) {
    canvas.style.cursor = "grab";
  } else {
    canvas.style.cursor = "default";
  }
}

function createExportCanvas() {
  const exportCanvasElement = document.createElement("canvas");
  exportCanvasElement.width = OUTPUT_WIDTH;
  exportCanvasElement.height = OUTPUT_HEIGHT;
  render(exportCanvasElement.getContext("2d"), false, true);
  return exportCanvasElement;
}

function exportCanvas() {
  const exportCanvasElement = createExportCanvas();
  const link = document.createElement("a");
  link.download = `concat-photo-${Date.now()}.png`;
  link.href = exportCanvasElement.toDataURL("image/png");
  link.click();
}

async function copyCanvasToClipboard() {
  const previousLabel = copyButton.textContent;

  try {
    if (!navigator.clipboard?.write || !window.ClipboardItem) {
      throw new Error("Clipboard image writes are not supported.");
    }

    const exportCanvasElement = createExportCanvas();
    const blob = await new Promise((resolve, reject) => {
      exportCanvasElement.toBlob((result) => {
        if (result) {
          resolve(result);
        } else {
          reject(new Error("Unable to create PNG blob."));
        }
      }, "image/png");
    });

    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    copyButton.textContent = "Copied";
  } catch {
    exportCanvas();
    copyButton.textContent = "Downloaded";
  } finally {
    window.setTimeout(() => {
      copyButton.textContent = previousLabel;
    }, 1400);
  }
}

function setRatio(height, width, shouldSave = true) {
  state.ratioHeight = clamp(Number(height) || 15, 1, 99);
  state.ratioWidth = clamp(Number(width) || 9, 1, 99);
  updateCanvasSize();
  if (shouldSave) savePreferences();
  drawPreview();
}

fileInput.addEventListener("change", (event) => {
  addFiles(event.target.files);
  fileInput.value = "";
});

document.addEventListener("paste", (event) => {
  const files = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
  if (files.length) addFiles(files);
});

copyButton.addEventListener("click", copyCanvasToClipboard);
exportButton.addEventListener("click", exportCanvas);

watermarkEnabled.addEventListener("change", () => {
  state.watermarkEnabled = watermarkEnabled.checked;
  savePreferences();
  drawPreview();
});

watermarkText.addEventListener("input", () => {
  state.watermarkText = watermarkText.value;
  savePreferences();
  drawPreview();
});

ratioPreset.addEventListener("change", () => {
  customRatioFields.hidden = ratioPreset.value !== "custom";
  if (ratioPreset.value === "custom") {
    setRatio(customRatioHeight.value, customRatioWidth.value);
    return;
  }
  const [height, width] = ratioPreset.value.split(":").map(Number);
  customRatioHeight.value = height;
  customRatioWidth.value = width;
  setRatio(height, width);
});

[customRatioHeight, customRatioWidth].forEach((input) => {
  input.addEventListener("input", () => {
    ratioPreset.value = "custom";
    customRatioFields.hidden = false;
    setRatio(customRatioHeight.value, customRatioWidth.value);
  });
});

canvas.addEventListener("pointerdown", (event) => {
  const point = getCanvasPoint(event);
  const handle = hitTestHandles(point);
  canvas.setPointerCapture(event.pointerId);

  if (handle) {
    state.interaction = { ...handle };
    return;
  }

  const cell = hitTestCell(point);
  if (cell) {
    const nextSelectedId = state.images[cell.imageIndex]?.id ?? null;
    const selectionChanged = state.selectedImageId !== nextSelectedId;
    state.selectedImageId = nextSelectedId;
    state.interaction = {
      type: "crop",
      cell,
      imageIndex: cell.imageIndex,
      startPoint: point,
      lastPoint: point,
    };
    canvas.style.cursor = "grabbing";
    if (selectionChanged) {
      renderThumbs();
    }
    drawPreview();
  }
});

canvas.addEventListener("pointermove", (event) => {
  const point = getCanvasPoint(event);
  const interaction = state.interaction;

  if (!interaction) {
    updateCursor(event);
    return;
  }

  if (interaction.type === "row") {
    resizeRows(interaction.rowIndex, point.y);
  } else if (interaction.type === "column") {
    resizeColumns(interaction.rowIndex, interaction.cellIndex, point.x);
  } else if (interaction.type === "crop") {
    moveCrop(interaction, point);
    updateCanvasDragTarget(interaction, point);
  }

  drawPreview();
});

canvas.addEventListener("pointerup", (event) => {
  if (state.interaction?.type === "crop") {
    const point = getCanvasPoint(event);
    const targetCell = hitTestCell(point);
    if (targetCell && targetCell.imageIndex !== state.interaction.imageIndex) {
      moveImageToIndex(state.interaction.imageIndex, targetCell.imageIndex);
    }
  }
  state.dragTargetIndex = null;
  state.interaction = null;
  canvas.style.cursor = "default";
  drawPreview();
});

canvas.addEventListener("pointercancel", () => {
  state.dragTargetIndex = null;
  state.interaction = null;
  canvas.style.cursor = "default";
  drawPreview();
});

["dragenter", "dragover"].forEach((name) => {
  window.addEventListener(name, (event) => {
    event.preventDefault();
    dropOverlay.classList.add("is-visible");
  });
});

["dragleave", "drop"].forEach((name) => {
  window.addEventListener(name, (event) => {
    event.preventDefault();
    if (name === "drop") addFiles(event.dataTransfer.files);
    dropOverlay.classList.remove("is-visible");
  });
});

rebuildLayout();
loadPreferences();
syncControlsFromState();
updateCanvasSize();
drawPreview();
