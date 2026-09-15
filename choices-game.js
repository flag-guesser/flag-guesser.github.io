(function () {
  "use strict";

  const CHOICE_COUNT = 4;

  /** @type {{slug:string,name:string,src:string}[]} */
  const MANIFEST = window.FLAG_MANIFEST || [];

  // ---- DOM refs ---------------------------------------------------------
  const boardEl = document.getElementById("board");
  const flagLayer = document.getElementById("flag-layer");
  const choiceGrid = document.getElementById("choice-grid");
  const roundScoreEl = document.getElementById("round-score");
  const roundTotalEl = document.getElementById("round-total");
  const toastEl = document.getElementById("toast");
  const toastMessageEl = document.getElementById("toast-message");
  const nextBtn = document.getElementById("next-btn");

  // ---- State --------------------------------------------------------------
  let pool = [];
  let current = null;
  let options = [];
  let roundOver = false;
  let score = 0;
  let played = 0;
  let currentFlagRatio = 3 / 2;

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

  function pickDistractors(correct, count) {
    const rest = MANIFEST.filter((f) => f.slug !== correct.slug);
    return shuffle(rest).slice(0, count);
  }

  // ---- Round lifecycle ----------------------------------------------------
  function startRound() {
    refillPoolIfNeeded();
    current = pool.pop();
    roundOver = false;
    hideToast();

    const distractors = pickDistractors(current, CHOICE_COUNT - 1);
    options = shuffle([current, ...distractors]);

    loadFlag(current.src);
    buildChoices();
  }

  function loadFlag(src) {
    const img = new Image();
    img.alt = "";
    img.draggable = false;

    img.addEventListener("load", () => {
      getIntrinsicRatio(src, img).then((ratio) => {
        applyBoardRatio(ratio);
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

  function buildChoices() {
    choiceGrid.innerHTML = "";
    options.forEach((opt) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "choice-btn";
      btn.dataset.slug = opt.slug;
      btn.textContent = opt.name;
      btn.addEventListener("click", () => selectChoice(opt, btn));
      choiceGrid.appendChild(btn);
    });
  }

  function selectChoice(opt, btnEl) {
    if (roundOver) return;
    roundOver = true;
    played++;

    const isCorrect = opt.slug === current.slug;
    if (isCorrect) score++;
    updateScoreline();

    const buttons = choiceGrid.querySelectorAll(".choice-btn");
    buttons.forEach((b) => {
      b.disabled = true;
      if (b.dataset.slug === current.slug) {
        b.classList.add("is-correct");
      } else if (b === btnEl && !isCorrect) {
        b.classList.add("is-wrong");
      }
    });

    if (isCorrect) {
      showToast(`Correct — it was <strong>${current.name}</strong>.`, false);
      fireConfetti();
    } else {
      showToast(`Not quite — it was <strong>${current.name}</strong>.`, true);
    }

    nextBtn.hidden = false;
    nextBtn.focus({ preventScroll: true });
  }

  function updateScoreline() {
    roundScoreEl.textContent = String(score);
    roundTotalEl.textContent = String(played);
  }

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

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => applyBoardRatio(currentFlagRatio), 120);
  });

  // ---- Boot -----------------------------------------------------------------
  function boot() {
    if (MANIFEST.length < CHOICE_COUNT) {
      flagLayer.innerHTML = `<p style="color:#cfc3a4;font-family:var(--font-mono);font-size:13px;padding:20px;text-align:center;">
        Add at least ${CHOICE_COUNT} entries to flags-manifest.js to start playing.
      </p>`;
      return;
    }
    startRound();
  }

  boot();
})();
