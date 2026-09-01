(function () {
  "use strict";

  const MAX_GUESSES = 5;
  const TRACE_THRESHOLD = 1;
  const SAMPLE_SIZE = 600;

  /** @type {{slug:string,name:string,src:string}[]} */
  const MANIFEST = window.FLAG_MANIFEST || [];

  // ---- DOM refs -----------------------------------------------------------
  const chartFrame = document.getElementById("chart-frame");
  const chartLegend = document.getElementById("chart-legend");
  const traceLine = document.getElementById("trace-line");
  const guessesLeftEl = document.getElementById("guesses-left");
  const guessForm = document.getElementById("guess-form");
  const guessInput = document.getElementById("guess-input");
  const guessBtn = document.getElementById("guess-btn");
  const suggestionsEl = document.getElementById("suggestions");
  const guessLog = document.getElementById("guess-log");
  const toastEl = document.getElementById("toast");
  const toastMessageEl = document.getElementById("toast-message");
  const newGameBtn = document.getElementById("new-game-btn");
  const toastSpacer = document.getElementById("toast-spacer");

  // ---- State ----------------------------------------------------------------
  let pool = [];
  let current = null;
  let guessesRemaining = MAX_GUESSES;
  let roundOver = false;
  let fuse = null;
  let activeSuggestionIndex = -1;
  let toastTimer = null;
  let guessedSlugs = new Set();
  const shadeCache = new Map();

  // ---- Setup: fuzzy matcher over the manifest ------------------------------
  function initFuse() {
    if (typeof Fuse === "undefined" || MANIFEST.length === 0) return;
    fuse = new Fuse(MANIFEST, {
      keys: ["name", "aliases"],
      threshold: 0.35,
      ignoreLocation: true,
    });
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

  function normalize(str) {
    return str
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function resolveGuess(raw) {
    const n = normalize(raw);
    return (
      MANIFEST.find((f) => {
        if (normalize(f.name) === n) return true;
        const aliases = Array.isArray(f.aliases) ? f.aliases : [];
        return aliases.some((alias) => normalize(alias) === n);
      }) || null
    );
  }

  // ---- Rasterization with Crisp Edges (No Anti-Aliasing) --------------------
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
      const canvas = document.createElement("canvas");

      let ratio = img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : 3 / 2;
      if (!isFinite(ratio) || ratio <= 0) ratio = 3 / 2;

      let dw = SAMPLE_SIZE;
      let dh = SAMPLE_SIZE;
      if (ratio > 1) {
        dh = SAMPLE_SIZE / ratio;
      } else {
        dw = SAMPLE_SIZE * ratio;
      }

      canvas.width = Math.round(dw);
      canvas.height = Math.round(dh);

      const ctx = canvas.getContext("2d", { willReadFrequently: true });

      ctx.imageSmoothingEnabled = false;
      ctx.webkitImageSmoothingEnabled = false;
      ctx.mozImageSmoothingEnabled = false;

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const counts = new Map();
      let totalOpaque = 0;

      for (let i = 0; i < data.length; i += 4) {
        const a = data[i + 3];
        if (a < 128) continue; // ignore transparent pixels

        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];

        const key = `${r},${g},${b}`;
        counts.set(key, (counts.get(key) || 0) + 1);
        totalOpaque++;
      }

      let shades = Array.from(counts.entries()).map(([key, count]) => {
        const [r, g, b] = key.split(",").map(Number);
        return { hex: rgbToHex(r, g, b), pct: totalOpaque > 0 ? (count / totalOpaque) * 100 : 0 };
      });

      shades = mergeCloseShades(shades, 20);
      shades.sort((a, b) => b.pct - a.pct);
      return shades;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function mergeCloseShades(shades, distance = 20) {
    const sorted = shades.slice().sort((a, b) => b.pct - a.pct);
    const merged = [];

    for (const shade of sorted) {
      const [r, g, b] = hexToRgb(shade.hex);
      const target = merged.find((m) => {
        const [mr, mg, mb] = hexToRgb(m.hex);
        return Math.abs(mr - r) + Math.abs(mg - g) + Math.abs(mb - b) <= distance;
      });
      if (target) {
        target.pct += shade.pct;
      } else {
        merged.push({ hex: shade.hex, pct: shade.pct });
      }
    }
    return merged;
  }

  function rgbToHex(r, g, b) {
    return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("")}`;
  }

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
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

  async function getShades(entry) {
    if (shadeCache.has(entry.slug)) return shadeCache.get(entry.slug);
    const shades = await extractShades(entry.src);
    shadeCache.set(entry.slug, shades);
    return shades;
  }

  // ---- Chart rendering --------------------------------------------------

  function renderChart(shades) {
    const chartable = shades.filter((s) => s.pct > TRACE_THRESHOLD);
    const trace = shades.filter((s) => s.pct <= TRACE_THRESHOLD);

    const chartableTotal = chartable.reduce((sum, s) => sum + s.pct, 0) || 1;

    const cx = 50;
    const cy = 50;
    const r = 49;
    let angle = -Math.PI / 2;

    const pathParts = chartable.map((shade) => {
      const fraction = shade.pct / chartableTotal;
      const sweep = fraction * Math.PI * 2;
      const x1 = cx + r * Math.cos(angle);
      const y1 = cy + r * Math.sin(angle);
      angle += sweep;
      const x2 = cx + r * Math.cos(angle);
      const y2 = cy + r * Math.sin(angle);
      const largeArc = sweep > Math.PI ? 1 : 0;

      if (fraction >= 0.999) {
        return {
          hex: shade.hex,
          d: `M ${cx - r} ${cy} A ${r} ${r} 0 1 1 ${cx + r} ${cy} A ${r} ${r} 0 1 1 ${cx - r} ${cy} Z`,
        };
      }

      return {
        hex: shade.hex,
        d: `M ${cx} ${cy} L ${x1.toFixed(3)} ${y1.toFixed(3)} A ${r} ${r} 0 ${largeArc} 1 ${x2.toFixed(3)} ${y2.toFixed(3)} Z`,
      };
    });

    const svgSlices = pathParts
      .map((p) => `<path class="pie-slice" d="${p.d}" fill="${p.hex}"></path>`)
      .join("");

    chartFrame.innerHTML = `<svg viewBox="0 0 100 100" role="img" aria-label="Colour breakdown of the hidden flag">${svgSlices}</svg>`;

    chartLegend.innerHTML = "";
/*    chartable.forEach((shade) => {
      const li = document.createElement("li");
      const swatch = document.createElement("span");
      swatch.className = "swatch";
      swatch.style.background = shade.hex;
      const pct = document.createElement("span");
      pct.className = "pct";
      pct.textContent = `${Math.round(shade.pct)}%`;
      li.appendChild(swatch);
      li.appendChild(pct);
      chartLegend.appendChild(li);
    });*/

    const visibleTrace = trace.filter((s) => s.pct > 0.1);

    if (visibleTrace.length > 0) {
      traceLine.innerHTML =
        `<strong>Also present:</strong> ` +
        visibleTrace
          .map((s) => `<span class="swatch" style="background:${s.hex}"></span>`)
          .join("&nbsp;");
      traceLine.hidden = false;
    } else {
      traceLine.hidden = true;
      traceLine.innerHTML = "";
    }
  }

  function renderLoadingChart() {
    chartFrame.innerHTML = `<svg viewBox="0 0 100 100" role="img" aria-label="Loading colour chart">
      <circle cx="50" cy="50" r="49" fill="var(--ink-700)"></circle>
    </svg>`;
    chartLegend.innerHTML = "";
    traceLine.hidden = true;
    traceLine.innerHTML = "";
  }

  // ---- Round lifecycle --------------------------------------------------

  async function startRound() {
    refillPoolIfNeeded();
    const roundEntry = pool.pop();
    current = roundEntry;

/*    let debugFlag = document.getElementById("debug-flag");
    if (!debugFlag) {
      debugFlag = document.createElement("img");
      debugFlag.id = "debug-flag";
      debugFlag.style.cssText = "position: fixed; top: 20px; right: 20px; width: 350px; z-index: 9999; border: 2px solid var(--brass); border-radius: var(--radius-sm); box-shadow: var(--shadow-panel);";
      document.body.appendChild(debugFlag);
    }
    debugFlag.src = current.src;*/

    guessesRemaining = MAX_GUESSES;
    roundOver = false;
    activeSuggestionIndex = -1;
    guessedSlugs = new Set();

    guessLog.innerHTML = "";
    guessInput.value = "";
    guessInput.disabled = true;
    guessBtn.disabled = true;
    hideToast();
    updateGuessesLeft();
    renderLoadingChart();

    try {
      const shades = await getShades(roundEntry);
      if (current !== roundEntry) return;
      renderChart(shades);
    } catch (err) {
      if (current !== roundEntry) return;
      chartFrame.innerHTML = `<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="49" fill="var(--ink-700)"></circle></svg>`;
      chartLegend.innerHTML = `<li style="color:var(--brick)">Couldn't load this flag's colours — try New game.</li>`;
    }

    if (current !== roundEntry) return;
    guessInput.disabled = false;
    guessBtn.disabled = false;
    guessInput.focus({ preventScroll: true });
  }

  function updateGuessesLeft() {
    guessesLeftEl.textContent = String(guessesRemaining);
  }

  function logGuess(text, status) {
    const li = document.createElement("li");
    li.className = status;
    const mark = document.createElement("span");
    mark.className = "mark";
    mark.textContent = status === "correct" ? "✓" : status === "repeat" ? "↺" : "✕";
    const guessText = document.createElement("span");
    guessText.className = "guess-text";
    guessText.textContent = text;
    li.appendChild(mark);
    li.appendChild(guessText);
    guessLog.prepend(li);
  }

  function endRound(won) {
    roundOver = true;
    guessInput.disabled = true;
    guessBtn.disabled = true;

    const flagImgHtml = `<img src="${current.src}" alt="${current.name}" style="height: 32px; object-fit: cover; vertical-align: middle; margin-right: 10px; border-radius: 2px; border: 1px solid var(--brass);">`;

    if (won) {
      showToast(`${flagImgHtml} Correct — it was <strong>${current.name}</strong>.`, false);
      fireConfetti();
    } else {
      showToast(`${flagImgHtml} Out of guesses — it was <strong>${current.name}</strong>.`, true);
    }

    newGameBtn.hidden = false;
    newGameBtn.focus({ preventScroll: true });
  }

  newGameBtn.addEventListener("click", () => {
    newGameBtn.hidden = true;
    startRound();
  });

  // ---- Toast ------------------------------------------------------------

  function showToast(html, isFinalWrong) {
    clearTimeout(toastTimer);
    toastMessageEl.innerHTML = html;
    toastEl.classList.toggle("is-wrong-final", !!isFinalWrong);
    toastEl.classList.remove("is-repeat");
    toastEl.classList.add("is-visible");
    reserveSpaceForToast();
  }

  function hideToast() {
    clearTimeout(toastTimer);
    toastEl.classList.remove("is-visible", "is-wrong-final", "is-repeat");
    newGameBtn.hidden = true;
    toastSpacer.style.height = "0px";
  }

  function reserveSpaceForToast() {
    requestAnimationFrame(() => {
      const height = toastEl.getBoundingClientRect().height;
      toastSpacer.style.height = `${Math.ceil(height) + 16}px`;
      const latest = guessLog.firstElementChild;
      if (latest) latest.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  }

  function fireConfetti() {
    if (typeof confetti !== "function") return;
    confetti({
      particleCount: 70,
      spread: 65,
      startVelocity: 32,
      gravity: 1.1,
      ticks: 160,
      origin: { y: 0.35 },
      colors: ["#c9a227", "#e6c34f", "#f0e6d2", "#5b7a99"],
      disableForReducedMotion: true,
    });
  }

  // ---- Guess submission -----------------------------------------------------

  function submitGuess(rawValue) {
    if (roundOver) return;
    const value = rawValue.trim();
    if (!value) return;

    const match = resolveGuess(value);

    if (!match) {
      flashUnknownWarning(value);
      return;
    }

    if (guessedSlugs.has(match.slug)) {
      logGuess(match.name, "repeat");
      flashRepeatWarning(match.name);
      guessInput.value = "";
      hideSuggestions();
      return;
    }

    const isCorrect = match.slug === current.slug;
    guessedSlugs.add(match.slug);

    logGuess(match.name, isCorrect ? "correct" : "wrong");
    guessInput.value = "";
    hideSuggestions();

    if (isCorrect) {
      endRound(true);
      return;
    }

    guessesRemaining--;
    updateGuessesLeft();

    if (guessesRemaining <= 0) {
      endRound(false);
    }
  }

  function flashUnknownWarning(value) {
    clearTimeout(toastTimer);
    toastMessageEl.innerHTML = `<strong>${escapeHtml(value)}</strong> isn't a flag in this deck — pick from the list.`;
    toastEl.classList.remove("is-wrong-final");
    toastEl.classList.add("is-visible", "is-repeat");
    reserveSpaceForToast();
    toastTimer = setTimeout(() => {
      toastEl.classList.remove("is-visible", "is-repeat");
      toastSpacer.style.height = "0px";
    }, 1800);
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function flashRepeatWarning(name) {
    clearTimeout(toastTimer);
    toastMessageEl.innerHTML = `Already guessed <strong>${name}</strong> — try another.`;
    toastEl.classList.remove("is-wrong-final");
    toastEl.classList.add("is-visible", "is-repeat");
    reserveSpaceForToast();
    toastTimer = setTimeout(() => {
      toastEl.classList.remove("is-visible", "is-repeat");
      toastSpacer.style.height = "0px";
    }, 1800);
  }

  guessForm.addEventListener("submit", (e) => {
    e.preventDefault();
    if (activeSuggestionIndex >= 0) {
      const items = suggestionsEl.querySelectorAll("li");
      const active = items[activeSuggestionIndex];
      if (active) {
        submitGuess(active.dataset.name);
        return;
      }
    }
    submitGuess(guessInput.value);
  });

  // ---- Autocomplete suggestions ---------------------------------------------

  function renderSuggestions(query) {
    const q = query.trim();
    if (!q || !fuse) {
      hideSuggestions();
      return;
    }

    const results = fuse.search(q).filter((r) => !guessedSlugs.has(r.item.slug)).slice(0, 6);
    if (results.length === 0) {
      hideSuggestions();
      return;
    }

    suggestionsEl.innerHTML = "";
    results.forEach((r) => {
      const li = document.createElement("li");
      li.setAttribute("role", "option");
      li.dataset.name = r.item.name;
      li.textContent = r.item.name;
      li.addEventListener("mousedown", (e) => {
        e.preventDefault();
        submitGuess(r.item.name);
      });
      suggestionsEl.appendChild(li);
    });
    activeSuggestionIndex = -1;
    suggestionsEl.hidden = false;
  }

  function hideSuggestions() {
    suggestionsEl.hidden = true;
    suggestionsEl.innerHTML = "";
    activeSuggestionIndex = -1;
  }

  guessInput.addEventListener("input", () => {
    renderSuggestions(guessInput.value);
  });

  guessInput.addEventListener("keydown", (e) => {
    const items = suggestionsEl.querySelectorAll("li");
    if (suggestionsEl.hidden || items.length === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeSuggestionIndex = Math.min(activeSuggestionIndex + 1, items.length - 1);
      updateActiveSuggestion(items);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      activeSuggestionIndex = Math.max(activeSuggestionIndex - 1, 0);
      updateActiveSuggestion(items);
    } else if (e.key === "Escape") {
      hideSuggestions();
    }
  });

  function updateActiveSuggestion(items) {
    items.forEach?.((li, i) => {
      li.classList.toggle("is-active", i === activeSuggestionIndex);
    });
    const active = items[activeSuggestionIndex];
    if (active) active.scrollIntoView({ block: "nearest" });
  }

  document.addEventListener("click", (e) => {
    if (!guessForm.contains(e.target)) hideSuggestions();
  });

  // ---- Boot -------------------------------------------------------------------

  function boot() {
    if (MANIFEST.length === 0) {
      chartLegend.innerHTML = `<li style="color:var(--parchment-dim)">Add entries to flags-manifest.js to start playing.</li>`;
      guessInput.disabled = true;
      guessBtn.disabled = true;
      return;
    }
    initFuse();
    startRound();
  }

  boot();
})();
