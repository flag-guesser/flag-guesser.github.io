(function () {
  "use strict";

  const TILE_COUNT = 6;
  const TILE_COORDS = ["A1", "B1", "C1", "A2", "B2", "C2"];

  /** @type {{slug:string,name:string,src:string}[]} */
  const MANIFEST = window.FLAG_MANIFEST || [];

  // ---- DOM refs ---------------------------------------------------------
  const flagLayer = document.getElementById("flag-layer");
  const tilesEl = document.getElementById("tiles");
  const guessForm = document.getElementById("guess-form");
  const guessInput = document.getElementById("guess-input");
  const guessBtn = document.getElementById("guess-btn");
  const suggestionsEl = document.getElementById("suggestions");
  const guessLog = document.getElementById("guess-log");
  const revealedCountEl = document.getElementById("revealed-count");
  const toastEl = document.getElementById("toast");
  const toastMessageEl = document.getElementById("toast-message");
  const newGameBtn = document.getElementById("new-game-btn");

  // ---- State --------------------------------------------------------------
  let pool = [];
  let current = null;
  let liftOrder = [];
  let liftedCount = 0;
  let roundOver = false;
  let fuse = null;
  let activeSuggestionIndex = -1;
  let toastTimer = null;
  let guessedSlugs = new Set(); // slugs already tried this round

  // ---- Setup: fuzzy matcher over the manifest ----------------------------
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
      .replace(/[\u0300-\u036f]/g, "") // strip accents
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

  // ---- Round lifecycle ----------------------------------------------------
  function startRound() {
    refillPoolIfNeeded();
    current = pool.pop();
    liftOrder = shuffle([...Array(TILE_COUNT).keys()]);
    liftedCount = 0;
    roundOver = false;
    activeSuggestionIndex = -1;
    guessedSlugs = new Set();

    guessLog.innerHTML = "";
    guessInput.value = "";
    guessInput.disabled = false;
    guessBtn.disabled = false;
    hideToast();

    revealedCountEl.textContent = "0";

    flagLayer.innerHTML = `<img src="${current.src}" alt="" draggable="false" />`;

    buildTiles();
    guessInput.focus({ preventScroll: true });
  }

  function buildTiles() {
    tilesEl.innerHTML = "";
    for (let i = 0; i < TILE_COUNT; i++) {
      const tile = document.createElement("div");
      tile.className = "tile";
      tile.dataset.index = String(i);
      const coord = document.createElement("span");
      coord.className = "tile-coord";
      coord.textContent = TILE_COORDS[i];
      const shade = document.createElement("span");
      shade.className = "tile-shade";
      tile.appendChild(coord);
      tile.appendChild(shade);
      tilesEl.appendChild(tile);
    }
  }

  function liftNextTile() {
    if (liftedCount >= TILE_COUNT) return;
    const tileIndex = liftOrder[liftedCount];
    const tileEl = tilesEl.querySelector(`[data-index="${tileIndex}"]`);
    const shadeEl = tileEl ? tileEl.querySelector(".tile-shade") : null;
    liftedCount++;
    revealedCountEl.textContent = String(liftedCount);

    if (window.anime && tileEl) {
      anime({
        targets: tileEl,
        rotateY: [0, -112],
        duration: 620,
        easing: "easeInOutQuad",
        complete: () => {
          tileEl.classList.add("is-lifted");
        },
      });
      if (shadeEl) {
        anime({
          targets: shadeEl,
          opacity: [0, 0.75],
          duration: 620,
          easing: "easeInQuad",
        });
      }
    } else if (tileEl) {
      tileEl.classList.add("is-lifted");
    }
  }

  function liftAllRemainingTiles() {
    for (let i = liftedCount; i < TILE_COUNT; i++) {
      const tileIndex = liftOrder[i];
      const tileEl = tilesEl.querySelector(`[data-index="${tileIndex}"]`);
      const shadeEl = tileEl ? tileEl.querySelector(".tile-shade") : null;
      const stagger = (i - liftedCount) * 60;
      if (tileEl) {
        if (window.anime) {
          anime({
            targets: tileEl,
            rotateY: [0, -112],
            duration: 560,
            delay: stagger,
            easing: "easeInOutQuad",
            complete: () => {
              tileEl.classList.add("is-lifted");
            },
          });
          if (shadeEl) {
            anime({
              targets: shadeEl,
              opacity: [0, 0.75],
              duration: 560,
              delay: stagger,
              easing: "easeInQuad",
            });
          }
        } else {
          tileEl.classList.add("is-lifted");
        }
      }
    }
    liftedCount = TILE_COUNT;
    revealedCountEl.textContent = String(TILE_COUNT);
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
    liftAllRemainingTiles();

    if (won) {
      showToast(`Correct — it was <strong>${current.name}</strong>.`, false);
      fireConfetti();
    } else {
      showToast(`It was <strong>${current.name}</strong>.`, true);
    }

    newGameBtn.hidden = false;
    newGameBtn.focus({ preventScroll: true });
  }

  newGameBtn.addEventListener("click", () => {
    newGameBtn.hidden = true;
    startRound();
  });

  // ---- Toast --------------------------------------------------------------
  function showToast(html, isFinalWrong) {
    clearTimeout(toastTimer);
    toastMessageEl.innerHTML = html;
    toastEl.classList.toggle("is-wrong-final", !!isFinalWrong);
    toastEl.classList.remove("is-repeat");
    toastEl.classList.add("is-visible");
  }

  function hideToast() {
    clearTimeout(toastTimer);
    toastEl.classList.remove("is-visible", "is-wrong-final", "is-repeat");
    newGameBtn.hidden = true;
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

    if (liftedCount + 1 >= TILE_COUNT) {
      liftNextTile();
      endRound(false);
    } else {
      liftNextTile();
    }
  }

  function flashUnknownWarning(value) {
    clearTimeout(toastTimer);
    toastMessageEl.innerHTML = `<strong>${escapeHtml(value)}</strong> isn't a flag in this deck — pick from the list.`;
    toastEl.classList.remove("is-wrong-final");
    toastEl.classList.add("is-visible", "is-repeat");
    toastTimer = setTimeout(() => {
      toastEl.classList.remove("is-visible", "is-repeat");
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
    toastTimer = setTimeout(() => {
      toastEl.classList.remove("is-visible", "is-repeat");
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

  // ---- Autocomplete suggestions -------------------------------------------
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
    results.forEach((r, i) => {
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
    items.forEach((li, i) => {
      li.classList.toggle("is-active", i === activeSuggestionIndex);
    });
    const active = items[activeSuggestionIndex];
    if (active) active.scrollIntoView({ block: "nearest" });
  }

  document.addEventListener("click", (e) => {
    if (!guessForm.contains(e.target)) hideSuggestions();
  });

  // ---- Boot -----------------------------------------------------------------
  function boot() {
    if (MANIFEST.length < TILE_COUNT + 1) {
      flagLayer.innerHTML = `<p style="color:#cfc3a4;font-family:var(--font-mono);font-size:13px;padding:20px;text-align:center;">
        Add at least ${TILE_COUNT + 1} entries to flags-manifest.js to start playing.
      </p>`;
      guessInput.disabled = true;
      guessBtn.disabled = true;
      return;
    }
    initFuse();
    startRound();
  }

  boot();
})();
