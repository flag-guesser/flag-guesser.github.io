(function () {
  "use strict";

  const REVEAL_SECONDS = 5;

  /** @type {{slug:string,name:string,src:string}[]} */
  const MANIFEST = window.FLAG_MANIFEST || [];

  // ---- DOM refs -------------------------------------------------------------
  const boardEl = document.getElementById("board");
  const flagLayer = document.getElementById("flag-layer");
  const canvas = document.getElementById("draw-canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const revealOverlay = document.getElementById("reveal-overlay");
  const revealCount = document.getElementById("reveal-count");
  const scoreOverlay = document.getElementById("score-overlay");
  const scoreBig = document.getElementById("score-big");
  const scoreCaption = document.getElementById("score-caption");
  const drawStatus = document.getElementById("draw-status");
  const toolbar = document.getElementById("draw-toolbar");
  const swatchRow = document.getElementById("swatch-row");
  const colorPicker = document.getElementById("color-picker");
  const brushSize = document.getElementById("brush-size");
  const undoBtn = document.getElementById("undo-btn");
  const clearBtn = document.getElementById("clear-btn");
  const submitBtn = document.getElementById("submit-drawing-btn");
  const roundScoreEl = document.getElementById("round-score");
  const roundTotalEl = document.getElementById("round-total");
  const toastEl = document.getElementById("toast");
  const toastMessageEl = document.getElementById("toast-message");
  const nextBtn = document.getElementById("next-btn");

  // Tool buttons
  const toolBrush = document.getElementById("tool-brush");
  const toolRect = document.getElementById("tool-rect");
  const toolCircle = document.getElementById("tool-circle");
  const toolStar = document.getElementById("tool-star");
  const toolFill = document.getElementById("tool-fill");
  const toolButtons = [toolBrush, toolRect, toolCircle, toolStar, toolFill];

  const FALLBACK_SWATCHES = ["#f0e6d2", "#0f1b2d", "#cf142b", "#003893", "#046a38", "#c9a227", "#ffffff", "#000000"];
  const MAX_PALETTE_SWATCHES = 8;
  const MIN_PALETTE_SWATCHES = 3;
  const SAMPLE_SIZE = 400; // rasterization size used purely for colour extraction

  // ---- State ------------------------------------------------------------
  let pool = [];
  let current = null;
  let currentFlagRatio = 3 / 2;
  let phase = "idle"; // idle | reveal | draw | scored
  let revealTimer = null;
  let revealRemaining = REVEAL_SECONDS;

  let scores = []; // history of round scores (0-100)
  let played = 0;

  let activeSwatches = FALLBACK_SWATCHES;
  let activeColor = FALLBACK_SWATCHES[0];
  let activeSize = Number(brushSize.value);
  let activeTool = "brush"; // "brush" | "rect" | "circle" | "star" | "fill"
  let strokes = []; // array of stroke/shape/fill objects for undo
  let currentStroke = null;
  let drawing = false;
  let dpr = Math.max(1, window.devicePixelRatio || 1);
  const paletteCache = new Map();

  function setActiveTool(tool, btn) {
    activeTool = tool;
    toolButtons.forEach((b) => b?.classList.remove("is-active"));
    if (btn) btn.classList.add("is-active");
  }

  if (toolBrush) toolBrush.addEventListener("click", () => setActiveTool("brush", toolBrush));
  if (toolRect) toolRect.addEventListener("click", () => setActiveTool("rect", toolRect));
  if (toolCircle) toolCircle.addEventListener("click", () => setActiveTool("circle", toolCircle));
  if (toolStar) toolStar.addEventListener("click", () => setActiveTool("star", toolStar));
  if (toolFill) toolFill.addEventListener("click", () => setActiveTool("fill", toolFill));

  const eyedropperBtn = document.getElementById("eyedropper-btn");

  if (eyedropperBtn) {
    if ("EyeDropper" in window) {
      eyedropperBtn.addEventListener("click", async () => {
        try {
          const eyeDropper = new EyeDropper();
          const result = await eyeDropper.open();
          activeColor = result.sRGBHex;
          colorPicker.value = activeColor;
          updateActiveSwatch();
        } catch (err) {
          // User canceled the eyedropper prompt
        }
      });
    } else {
      // Hide button on browsers that don't support the EyeDropper API
      eyedropperBtn.style.display = "none";
    }
  }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function refillPoolIfNeeded() {
    if (pool.length === 0) {
      pool = shuffle(MANIFEST);
    }
  }

  // ---- Palette extraction (dominant colours from the flag's own SVG) --------
  async function extractPalette(entry) {
    if (paletteCache.has(entry.slug)) return paletteCache.get(entry.slug);
    const hexes = await extractShades(entry.src);
    paletteCache.set(entry.slug, hexes);
    return hexes;
  }

  async function extractShades(src) {
    const res = await fetch(src);
    let svgText = await res.text();

    if (svgText.includes("<svg")) {
      svgText = svgText.replace(/<svg([^>]*)>/i, '<svg$1 shape-rendering="crispEdges">');
    }

    const blob = new Blob([svgText], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);

    try {
      const img = await loadImage(url);
      const off = document.createElement("canvas");

      let ratio = img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : currentFlagRatio;
      if (!Number.isFinite(ratio) || ratio <= 0) ratio = 3 / 2;

      let dw = SAMPLE_SIZE;
      let dh = SAMPLE_SIZE;
      if (ratio > 1) {
        dh = SAMPLE_SIZE / ratio;
      } else {
        dw = SAMPLE_SIZE * ratio;
      }

      off.width = Math.round(dw);
      off.height = Math.round(dh);

      const octx = off.getContext("2d", { willReadFrequently: true });
      octx.imageSmoothingEnabled = false;
      octx.clearRect(0, 0, off.width, off.height);
      octx.drawImage(img, 0, 0, off.width, off.height);

      const { data } = octx.getImageData(0, 0, off.width, off.height);
      const counts = new Map();

      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 128) continue; // ignore transparent pixels
        const key = `${data[i]},${data[i + 1]},${data[i + 2]}`;
        counts.set(key, (counts.get(key) || 0) + 1);
      }

      let shades = Array.from(counts.entries()).map(([key, count]) => {
        const [r, g, b] = key.split(",").map(Number);
        return { hex: rgbToHex(r, g, b), count };
      });

      shades = mergeCloseShades(shades, 20);
      shades.sort((a, b) => b.count - a.count);
      return shades.map((s) => s.hex);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function mergeCloseShades(shades, distance = 20) {
    const sorted = shades.slice().sort((a, b) => b.count - a.count);
    const merged = [];

    for (const shade of sorted) {
      const [r, g, b] = hexToRgb(shade.hex);
      const target = merged.find((m) => {
        const [mr, mg, mb] = hexToRgb(m.hex);
        return Math.abs(mr - r) + Math.abs(mg - g) + Math.abs(mb - b) <= distance;
      });
      if (target) {
        target.count += shade.count;
      } else {
        merged.push({ hex: shade.hex, count: shade.count });
      }
    }
    return merged;
  }

  function rgbToHex(r, g, b) {
    return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("")}`;
  }

  function hexToRgb(hex) {
    const n = Number.parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = url;
    });
  }

  function buildPaletteFor(hexes) {
    const picked = hexes.slice(0, MAX_PALETTE_SWATCHES);
    if (picked.length < MIN_PALETTE_SWATCHES) {
      for (const fallback of FALLBACK_SWATCHES) {
        if (picked.length >= MIN_PALETTE_SWATCHES) break;
        const already = picked.some((hex) => {
          const [r, g, b] = hexToRgb(hex);
          const [fr, fg, fb] = hexToRgb(fallback);
          return Math.abs(r - fr) + Math.abs(g - fg) + Math.abs(b - fb) <= 20;
        });
        if (!already) picked.push(fallback);
      }
    }
    return picked;
  }

  // ---- Round lifecycle ----------------------------------------------------
  function startRound() {
    refillPoolIfNeeded();
    current = pool.pop();
    const roundEntry = current;
    phase = "reveal";
    strokes = [];
    currentStroke = null;
    hideToast();
    scoreOverlay.hidden = true;
    toolbar.hidden = true;
    submitBtn.hidden = true;
    canvas.hidden = true;
    flagLayer.hidden = false;

    activeSwatches = FALLBACK_SWATCHES;
    activeColor = activeSwatches[0];
    colorPicker.value = activeColor;
    buildSwatches();

    extractPalette(roundEntry)
      .then((hexes) => {
        if (current !== roundEntry) return;
        activeSwatches = buildPaletteFor(hexes);
        activeColor = activeSwatches[0];
        colorPicker.value = activeColor;
        buildSwatches();
      })
      .catch(() => {});

    loadFlag(current.src);
  }

  function loadFlag(src) {
    const img = new Image();
    img.alt = "";
    img.draggable = false;

    img.addEventListener("load", () => {
      getIntrinsicRatio(src, img).then((ratio) => {
        applyBoardRatio(ratio);
        sizeCanvas();
        beginReveal();
      });
    });

    flagLayer.innerHTML = "";
    flagLayer.appendChild(img);
    img.src = src;
  }

  function applyBoardRatio(ratio) {
    if (!ratio || !Number.isFinite(ratio) || ratio <= 0) ratio = 3 / 2;
    currentFlagRatio = ratio;
    boardEl.style.setProperty("--flag-ratio", String(ratio));

    const maxHeight = window.innerHeight * 0.6;
    const containerWidth = boardEl.parentElement.getBoundingClientRect().width;
    const heightAtFullWidth = containerWidth / ratio;
    if (heightAtFullWidth > maxHeight) {
      boardEl.style.setProperty("--flag-max-width", `${Math.round(maxHeight * ratio)}px`);
    } else {
      boardEl.style.setProperty("--flag-max-width", "100%");
    }
  }

  async function getIntrinsicRatio(src, imgEl) {
    if (imgEl.naturalWidth > 0 && imgEl.naturalHeight > 0) {
      return imgEl.naturalWidth / imgEl.naturalHeight;
    }
    if (/\.svg($|\?)/i.test(src)) {
      try {
        const res = await fetch(src);
        const text = await res.text();
        const doc = new DOMParser().parseFromString(text, "image/svg+xml");
        const svg = doc.documentElement;
        const viewBox = svg.getAttribute("viewBox");
        if (viewBox) {
          const parts = viewBox.trim().split(/[\s,]+/).map(Number);
          if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
            return parts[2] / parts[3];
          }
        }
        const w = Number.parseFloat(svg.getAttribute("width"));
        const h = Number.parseFloat(svg.getAttribute("height"));
        if (w > 0 && h > 0) return w / h;
      } catch (err) {
        // network or parse failure — fall through to default ratio
      }
    }
    return 3 / 2;
  }

  // ---- Canvas sizing --------------------------------------------------------
  function sizeCanvas() {
    dpr = Math.max(1, window.devicePixelRatio || 1);
    const rect = boardEl.getBoundingClientRect();
    const cssW = rect.width;
    const cssH = rect.height;

    if (cssW === 0 || cssH === 0) return;

    const targetW = Math.round(cssW * dpr);
    const targetH = Math.round(cssH * dpr);

    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      redrawStrokes();
    }
  }

  if (typeof ResizeObserver !== "undefined") {
    const resizeObserver = new ResizeObserver(() => {
      sizeCanvas();
    });
    resizeObserver.observe(boardEl);
  }

  // ---- Reveal countdown -----------------------------------------------------
  function beginReveal() {
    phase = "reveal";
    revealRemaining = REVEAL_SECONDS;
    revealOverlay.hidden = false;
    revealCount.textContent = String(revealRemaining);
    drawStatus.textContent = "Memorise the flag";

    clearInterval(revealTimer);
    revealTimer = setInterval(() => {
      revealRemaining--;
      if (revealRemaining <= 0) {
        clearInterval(revealTimer);
        beginDrawPhase();
      } else {
        revealCount.textContent = String(revealRemaining);
      }
    }, 1000);
  }

  function beginDrawPhase() {
    phase = "draw";
    revealOverlay.hidden = true;
    flagLayer.hidden = true;
    canvas.hidden = false;
    toolbar.hidden = false;
    submitBtn.hidden = false;
    drawStatus.textContent = "Draw it from memory";
    sizeCanvas();
    clearCanvas();
  }

  // ---- Drawing --------------------------------------------------------------
  function pointerPos(e) {
    const rect = canvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  function startStroke(e) {
    if (phase !== "draw") return;
    e.preventDefault();
    drawing = true;
    const p = pointerPos(e);

    if (activeTool === "fill") {
      strokes.push({ type: "fill", color: activeColor, x: p.x, y: p.y });
      redrawStrokes();
      drawing = false;
      return;
    }

    if (activeTool === "brush") {
      currentStroke = { type: "brush", color: activeColor, size: activeSize, points: [p] };
      strokes.push(currentStroke);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = activeColor;
      ctx.lineWidth = activeSize;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
    } else {
      currentStroke = { type: activeTool, color: activeColor, size: activeSize, x1: p.x, y1: p.y, x2: p.x, y2: p.y };
      strokes.push(currentStroke);
    }
  }

  function extendStroke(e) {
    if (!drawing || phase !== "draw") return;
    e.preventDefault();
    const p = pointerPos(e);

    if (activeTool === "brush") {
      currentStroke.points.push(p);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    } else if (activeTool === "rect" || activeTool === "circle" || activeTool === "star") {
      currentStroke.x2 = p.x;
      currentStroke.y2 = p.y;
      redrawStrokes();
    }
  }

  function endStroke() {
    drawing = false;
    currentStroke = null;
  }

  canvas.addEventListener("mousedown", startStroke);
  canvas.addEventListener("mousemove", extendStroke);
  window.addEventListener("mouseup", endStroke);
  canvas.addEventListener("touchstart", startStroke, { passive: false });
  canvas.addEventListener("touchmove", extendStroke, { passive: false });
  canvas.addEventListener("touchend", endStroke);
  canvas.addEventListener("touchcancel", endStroke);

  function drawStarPath(targetCtx, cx, cy, spikes, outerRadius, innerRadius) {
    let rot = (Math.PI / 2) * 3;
    let x = cx;
    let y = cy;
    const step = Math.PI / spikes;

    targetCtx.beginPath();
    targetCtx.moveTo(cx, cy - outerRadius);

    for (let i = 0; i < spikes; i++) {
      x = cx + Math.cos(rot) * outerRadius;
      y = cy + Math.sin(rot) * outerRadius;
      targetCtx.lineTo(x, y);
      rot += step;

      x = cx + Math.cos(rot) * innerRadius;
      y = cy + Math.sin(rot) * innerRadius;
      targetCtx.lineTo(x, y);
      rot += step;
    }
    targetCtx.lineTo(cx, cy - outerRadius);
    targetCtx.closePath();
  }

  function performFloodFill(startX, startY, fillColorHex) {
    const px = Math.floor(startX * dpr);
    const py = Math.floor(startY * dpr);
    const w = canvas.width;
    const h = canvas.height;

    if (px < 0 || px >= w || py < 0 || py >= h) return;

    const imgData = ctx.getImageData(0, 0, w, h);
    const data = imgData.data;
    const [fillR, fillG, fillB] = hexToRgb(fillColorHex);

    const startPos = (py * w + px) * 4;
    const targetR = data[startPos];
    const targetG = data[startPos + 1];
    const targetB = data[startPos + 2];
    const targetA = data[startPos + 3];

    if (targetR === fillR && targetG === fillG && targetB === fillB && targetA === 255) return;

    const TOLERANCE = 45;
    const colorsMatch = (p) => {
      return Math.abs(data[p] - targetR) <= TOLERANCE &&
             Math.abs(data[p + 1] - targetG) <= TOLERANCE &&
             Math.abs(data[p + 2] - targetB) <= TOLERANCE &&
             Math.abs(data[p + 3] - targetA) <= TOLERANCE;
    };

    const mask = new Uint8Array(w * h);
    const pixelStack = [[px, py]];

    while (pixelStack.length > 0) {
      const [x, y] = pixelStack.pop();
      let curY = y;

      while (curY >= 0 && colorsMatch((curY * w + x) * 4) && !mask[curY * w + x]) curY--;
      curY++;

      let reachLeft = false;
      let reachRight = false;

      while (curY < h && colorsMatch((curY * w + x) * 4) && !mask[curY * w + x]) {
        const idx = curY * w + x;
        mask[idx] = 1;

        if (x > 0) {
          if (colorsMatch((curY * w + (x - 1)) * 4) && !mask[curY * w + (x - 1)]) {
            if (!reachLeft) { pixelStack.push([x - 1, curY]); reachLeft = true; }
          } else if (reachLeft) { reachLeft = false; }
        }

        if (x < w - 1) {
          if (colorsMatch((curY * w + (x + 1)) * 4) && !mask[curY * w + (x + 1)]) {
            if (!reachRight) { pixelStack.push([x + 1, curY]); reachRight = true; }
          } else if (reachRight) { reachRight = false; }
        }

        curY++;
      }
    }

    // Expand mask boundary by 2px to bleed under anti-aliased stroke outlines
    const dilated = new Uint8Array(mask);
    const DILATE_RADIUS = 2;

    for (let pass = 0; pass < DILATE_RADIUS; pass++) {
      const temp = new Uint8Array(dilated);
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x;
          if (temp[i] === 1) {
            dilated[i - 1] = 1;
            dilated[i + 1] = 1;
            dilated[i - w] = 1;
            dilated[i + w] = 1;
          }
        }
      }
    }

    // Write final dilated pixels to canvas buffer
    for (let i = 0; i < w * h; i++) {
      if (dilated[i] === 1) {
        const p = i * 4;
        data[p] = fillR;
        data[p + 1] = fillG;
        data[p + 2] = fillB;
        data[p + 3] = 255;
      }
    }

    ctx.putImageData(imgData, 0, 0);
  }

  function redrawStrokes() {
    ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);

    strokes.forEach((s) => {
      const type = s.type || "brush";

      if (type === "fill") {
        performFloodFill(s.x, s.y, s.color);
        return;
      }

      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.size;

      if (type === "brush") {
        if (!s.points || s.points.length === 0) return;
        if (s.points.length === 1) {
          ctx.beginPath();
          ctx.arc(s.points[0].x, s.points[0].y, s.size / 2, 0, Math.PI * 2);
          ctx.fillStyle = s.color;
          ctx.fill();
          return;
        }
        ctx.beginPath();
        ctx.moveTo(s.points[0].x, s.points[0].y);
        for (let i = 1; i < s.points.length; i++) {
          ctx.lineTo(s.points[i].x, s.points[i].y);
        }
        ctx.stroke();
      } else if (type === "rect") {
        const x = Math.min(s.x1, s.x2);
        const y = Math.min(s.y1, s.y2);
        const w = Math.abs(s.x2 - s.x1);
        const h = Math.abs(s.y2 - s.y1);
        ctx.beginPath();
        ctx.rect(x, y, w, h);
        ctx.stroke();
      } else if (type === "circle") {
        const radius = Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
        ctx.beginPath();
        ctx.arc(s.x1, s.y1, radius, 0, Math.PI * 2);
        ctx.stroke();
      } else if (type === "star") {
        const outerRadius = Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
        drawStarPath(ctx, s.x1, s.y1, 5, outerRadius, outerRadius * 0.4);
        ctx.stroke();
      }
    });
  }

  function clearCanvas() {
    strokes = [];
    currentStroke = null;
    ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
  }

  undoBtn.addEventListener("click", () => {
    if (phase !== "draw") return;
    strokes.pop();
    redrawStrokes();
  });

  clearBtn.addEventListener("click", () => {
    if (phase !== "draw") return;
    clearCanvas();
  });

  // ---- Colour + brush controls ------------------------------------------
  function buildSwatches() {
    swatchRow.innerHTML = "";
    activeSwatches.forEach((hex) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "swatch-btn";
      btn.style.background = hex;
      btn.dataset.hex = hex;
      if (hex === activeColor) btn.classList.add("is-active");
      btn.addEventListener("click", () => {
        activeColor = hex;
        colorPicker.value = hex;
        updateActiveSwatch();
      });
      swatchRow.appendChild(btn);
    });
  }

  function updateActiveSwatch() {
    swatchRow.querySelectorAll(".swatch-btn").forEach((b) => {
      b.classList.toggle("is-active", b.dataset.hex.toLowerCase() === activeColor.toLowerCase());
    });
  }

  colorPicker.addEventListener("input", () => {
    activeColor = colorPicker.value;
    updateActiveSwatch();
  });

  brushSize.addEventListener("input", () => {
    activeSize = Number(brushSize.value);
  });

  // ---- Scoring ------------------------------------------------------------
  async function scoreDrawing() {
    submitBtn.disabled = true;
    submitBtn.textContent = "Scoring…";

    const w = canvas.width;
    const h = canvas.height;

    try {
      const refCanvas = await rasterizeReference(current.src, w, h);
      const refCtx = refCanvas.getContext("2d");
      const refData = refCtx.getImageData(0, 0, w, h).data;
      const drawData = ctx.getImageData(0, 0, w, h).data;

      const pct = compareImages(refData, drawData, w, h);
      finishScoring(pct);
    } catch (err) {
      finishScoring(null);
    }
  }

  function rasterizeReference(src, w, h) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        const off = document.createElement("canvas");
        off.width = w;
        off.height = h;
        const octx = off.getContext("2d");
        const ratio = img.naturalWidth / img.naturalHeight || currentFlagRatio;
        let dw = w, dh = w / ratio;
        if (dh > h) { dh = h; dw = h * ratio; }
        const dx = (w - dw) / 2;
        const dy = (h - dh) / 2;
        octx.drawImage(img, dx, dy, dw, dh);
        resolve(off);
      };
      img.onerror = reject;
      img.src = src;
    });
  }

  function compareImages(refData, drawData, w, h) {
    let total = 0;
    let sum = 0;
    const SAMPLE_STEP = 2;

    for (let y = 0; y < h; y += SAMPLE_STEP) {
      for (let x = 0; x < w; x += SAMPLE_STEP) {
        const i = (y * w + x) * 4;
        const refA = refData[i + 3];
        if (refA < 16) continue;

        total++;
        const drawA = drawData[i + 3];

        if (drawA < 16) continue;

        const dr = refData[i] - drawData[i];
        const dg = refData[i + 1] - drawData[i + 1];
        const db = refData[i + 2] - drawData[i + 2];
        const dist = Math.hypot(dr, dg, db);

        const similarity = Math.max(0, 1 - dist / 260);
        sum += similarity;
      }
    }

    if (total === 0) return 0;
    return Math.round((sum / total) * 100);
  }

  function finishScoring(pct) {
    phase = "scored";
    submitBtn.disabled = false;
    submitBtn.textContent = "Reveal & compare";
    submitBtn.hidden = true;
    toolbar.hidden = true;

    played++;
    if (pct !== null) {
      scores.push(pct);
    }
    updateScoreline();

    if (pct === null) {
      drawStatus.textContent = "Couldn't score that drawing";
      showToast(`Couldn't score this one — the flag image failed to load. It was <strong>${current.name}</strong>.`, true);
    } else {
      scoreBig.textContent = `${pct}%`;
      scoreCaption.textContent = `Match to ${current.name}`;
      scoreOverlay.hidden = false;
      canvas.hidden = true;
      flagLayer.hidden = false;

      showToast(`<strong>${pct}%</strong> match — it was <strong>${current.name}</strong>.`, pct < 30);
      if (pct >= 80) fireConfetti();
    }

    nextBtn.hidden = false;
    nextBtn.focus({ preventScroll: true });
  }

  function updateScoreline() {
    const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;
    roundScoreEl.textContent = `${avg}%`;
    roundTotalEl.textContent = String(played);
  }

  submitBtn.addEventListener("click", () => {
    if (phase !== "draw") return;
    scoreDrawing();
  });

  nextBtn.addEventListener("click", () => {
    nextBtn.hidden = true;
    startRound();
  });

  // ---- Toast --------------------------------------------------------------
  function showToast(html, isWrong) {
    toastMessageEl.innerHTML = html;
    toastEl.classList.toggle("is-wrong-final", !!isWrong);
    toastEl.classList.remove("is-repeat");
    toastEl.classList.add("is-visible");
  }

  function hideToast() {
    toastEl.classList.remove("is-visible", "is-wrong-final", "is-repeat");
    nextBtn.hidden = true;
  }

  function fireConfetti() {
    if (typeof confetti !== "function") return;
    confetti({
      particleCount: 90,
      spread: 70,
      startVelocity: 34,
      gravity: 1.1,
      ticks: 170,
      origin: { y: 0.35 },
      colors: ["#c9a227", "#e6c34f", "#f0e6d2", "#5b7a99"],
      disableForReducedMotion: true,
    });
  }

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      applyBoardRatio(currentFlagRatio);
      sizeCanvas();
    }, 120);
  });

  // ---- Boot -----------------------------------------------------------------
  function boot() {
    if (MANIFEST.length < 1) {
      drawStatus.textContent = "Add flags to flags-manifest.js to start playing.";
      return;
    }
    startRound();
  }

  boot();
})();
