/* ══════════════════════════════════════════════════════════════════
   THE INFERENCE ENGINE — machine driver

   One pass of the head = one token. Every pass re-reads the whole
   tape from the beginning, so passes get longer as the run goes on.
   Tape already inferred (the KV cache) is re-read at 4x.
   ══════════════════════════════════════════════════════════════════ */

(() => {
  "use strict";

  const $ = (s) => document.querySelector(s);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  /* ── geometry of the apparatus (SVG user units) ───────────────── */
  const REEL_L = { cx: 335, cy: 336 };
  const REEL_R = { cx: 865, cy: 336 };
  const HUB = 32;
  const PACK_FULL = 100;
  const PACK_AREA = PACK_FULL * PACK_FULL - HUB * HUB;
  const ROLLER_R = 20;
  const CELL = 26;          // one tape cell, in user units
  const TRAVEL_MAX = 520;   // longest possible pass across the window
  const HEAD_DROP = 22;     // how far the head lowers onto the tape

  /* ── mechanism limits ─────────────────────────────────────────── */
  const MIN_NOMINAL = 110;  // ms; below this the linkage can't keep up
  const MIN_CYCLE = 45;
  const MAX_CYCLE = 6000;
  const KV_SPEEDUP = 4;

  /* ── speed dial (log scale: dial position 0-100 -> RATE_MIN-RATE_MAX tok/s) */
  const RATE_MIN = 0.2;   // dial floor — slow enough to watch each light blink
  const RATE_MAX = 100;   // dial ceiling
  const dialToRate = (pos) =>
    RATE_MIN * Math.pow(RATE_MAX / RATE_MIN, clamp(pos, 0, 100) / 100);

  /* ── elements ─────────────────────────────────────────────────── */
  const cells = $("#tape-cells");
  const spinL = $("#spin-l");
  const spinR = $("#spin-r");
  const packL = document.querySelector('.reel[data-reel="l"] .pack');
  const packR = document.querySelector('.reel[data-reel="r"] .pack');
  const seamsL = [...spinL.querySelectorAll(".seam")];
  const seamsR = [...spinR.querySelectorAll(".seam")];
  const rollerL = $("#roller-l");
  const rollerR = $("#roller-r");
  const head = $("#head");
  const slit = $("#head-slit");
  const headGlow = $("#head-glow");
  const maskDoor = $("#mask-door");

  const promptEl = $("#prompt");
  const rateEl = $("#rate");
  const rateOut = $("#rate-readout");
  const volumeEl = $("#volume");
  const volumeOut = $("#volume-readout");
  const inferBtn = $("#infer");
  const loremBtn = $("#lorem");
  const clearBtn = $("#clear");
  const maskBtn = $("#mask");
  const noticeEl = $("#notice");
  const printout = $("#printout");
  const emptyEl = $("#empty");
  const gTape = $("#g-tape");
  const gPass = $("#g-pass");
  const gRate = $("#g-rate");
  const gAudio = $("#g-audio");
  const canvas = $("#dust");
  const ctx = canvas.getContext("2d");

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ── state ────────────────────────────────────────────────────── */
  const state = {
    tapeX: 0, lastX: 0, maxX: TRAVEL_MAX,
    angL: 0, angR: 0, angRoll: 0,
    running: false, abort: false, masked: false,
    kvTokens: 0, printed: 0,
    seamAngles: [22, 205],
  };

  let tween = null;
  const timers = new Set();

  /* ══ TAPE MARKINGS ═══════════════════════════════════════════════ */
  function drawCells() {
    const NS = "http://www.w3.org/2000/svg";
    const frag = document.createDocumentFragment();
    let seed = 20260724;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

    for (let x = -420; x < 1020; x += CELL) {
      const tick = document.createElementNS(NS, "rect");
      tick.setAttribute("class", "cell-tick");
      tick.setAttribute("x", x); tick.setAttribute("y", 246);
      tick.setAttribute("width", 2); tick.setAttribute("height", 26);
      frag.appendChild(tick);

      for (let b = 0; b < 3; b++) {
        if (rnd() > 0.52) continue;
        const bit = document.createElementNS(NS, "rect");
        bit.setAttribute("class", "cell-bit");
        bit.setAttribute("x", x + 6 + b * 6);
        bit.setAttribute("y", 251 + Math.floor(rnd() * 3));
        bit.setAttribute("width", 3.4);
        bit.setAttribute("height", 4 + rnd() * 12);
        bit.setAttribute("rx", 1);
        frag.appendChild(bit);
      }
    }
    cells.appendChild(frag);
  }

  /* ══ RENDER LOOP ═════════════════════════════════════════════════ */
  function setPack(el, outer) {
    el.setAttribute("r", (HUB + outer) / 2);
    el.style.strokeWidth = Math.max(0.5, outer - HUB);
  }

  function setSeams(list, reel, outer) {
    list.forEach((el, i) => {
      const a = (state.seamAngles[i] * Math.PI) / 180;
      el.setAttribute("x1", reel.cx + HUB * Math.cos(a));
      el.setAttribute("y1", reel.cy + HUB * Math.sin(a));
      el.setAttribute("x2", reel.cx + outer * Math.cos(a));
      el.setAttribute("y2", reel.cy + outer * Math.sin(a));
    });
  }

  function frame(now) {
    requestAnimationFrame(frame);

    if (tween) {
      const p = clamp((now - tween.start) / tween.dur, 0, 1);
      state.tapeX = tween.from + (tween.to - tween.from) * p;
      if (p >= 1) { const done = tween.done; tween = null; done(); }
    }

    const x = state.tapeX;
    const dx = x - state.lastX;
    state.lastX = x;

    const p = state.maxX > 0 ? clamp(x / state.maxX, 0, 1) : 0;
    const outerL = Math.sqrt(HUB * HUB + (1 - p) * PACK_AREA);
    const outerR = Math.sqrt(HUB * HUB + p * PACK_AREA);

    if (dx !== 0) {
      const deg = (dx * 180) / Math.PI;
      state.angL += deg / ((outerL + HUB) / 2);
      state.angR += deg / ((outerR + HUB) / 2);
      state.angRoll += deg / ROLLER_R;
    }

    cells.setAttribute("transform", `translate(${x.toFixed(2)} 0)`);
    spinL.setAttribute("transform", `rotate(${state.angL.toFixed(2)} ${REEL_L.cx} ${REEL_L.cy})`);
    spinR.setAttribute("transform", `rotate(${state.angR.toFixed(2)} ${REEL_R.cx} ${REEL_R.cy})`);
    rollerL.setAttribute("transform", `rotate(${state.angRoll.toFixed(2)} 475 292)`);
    rollerR.setAttribute("transform", `rotate(${state.angRoll.toFixed(2)} 725 292)`);

    setPack(packL, outerL);
    setPack(packR, outerR);
    setSeams(seamsL, REEL_L, outerL);
    setSeams(seamsR, REEL_R, outerR);
  }

  /* ══ TIMING PRIMITIVES ═══════════════════════════════════════════ */
  function wait(ms) {
    return new Promise((res) => {
      if (ms <= 0) return res();
      const entry = {};
      entry.id = setTimeout(() => { timers.delete(entry); res(); }, ms);
      entry.res = res;                 // so a halt can release the await
      timers.add(entry);
    });
  }

  function moveTape(to, dur) {
    return new Promise((res) => {
      if (tween) { const d = tween.done; tween = null; d(); }
      if (dur <= 0 || Math.abs(to - state.tapeX) < 0.01) {
        state.tapeX = to; return res();
      }
      tween = { from: state.tapeX, to, start: performance.now(), dur, done: res };
    });
  }

  function cancelAll() {
    timers.forEach((entry) => { clearTimeout(entry.id); entry.res(); });
    timers.clear();
    if (tween) { const d = tween.done; tween = null; d(); }
  }

  /* ══ AUDIO ═══════════════════════════════════════════════════════ */
  const SOUND_NAMES = ["tape_forward", "tape_rewind", "head_down", "head_up", "head_read", "head_write"];
  const audio = { live: {}, pools: {}, loops: {}, masterVolume: 0.7 };

  function initAudio(report) {
    let liveCount = 0;
    SOUND_NAMES.forEach((name) => {
      const has = !!(report && report[name + ".mp3"]);
      audio.live[name] = has;
      if (!has) return;
      liveCount++;
      const src = `/audio/${name}.mp3`;
      audio.pools[name] = Array.from({ length: 3 }, () => {
        const a = new Audio(src);
        a.preload = "auto";
        a.volume = audio.masterVolume;
        return a;
      });
      const loop = new Audio(src);
      loop.loop = true;
      loop.volume = audio.masterVolume;
      audio.loops[name] = loop;
    });
    gAudio.textContent = `${liveCount} / 6 live`;
    gAudio.title = liveCount
      ? "Sound files found in the project root."
      : "Silent templates only — drop real MP3s into the project root.";
  }

  let poolIdx = 0;
  function play(name) {
    if (!audio.live[name]) return;
    const pool = audio.pools[name];
    const a = pool[poolIdx++ % pool.length];
    try { a.currentTime = 0; a.play().catch(() => {}); } catch (e) { /* silent */ }
  }

  function loopOn(name) {
    if (!audio.live[name]) return;
    const a = audio.loops[name];
    try { a.currentTime = 0; a.play().catch(() => {}); } catch (e) { /* silent */ }
  }

  function loopOff(name) {
    if (!audio.live[name]) return;
    try { audio.loops[name].pause(); } catch (e) { /* silent */ }
  }

  function allSoundOff() { SOUND_NAMES.forEach(loopOff); }

  /* ══ LAMPS & HEAD ════════════════════════════════════════════════ */
  function led(name, on) {
    document.querySelector(`.lamp[data-led="${name}"]`).classList.toggle("on", on);
  }
  function ledsOff() { ["read", "write", "kv", "infer"].forEach((n) => led(n, false)); }

  function headTo(down, dur) {
    head.style.transition = `transform ${Math.max(30, dur)}ms cubic-bezier(.4,.05,.25,1)`;
    head.style.transform = down ? `translateY(${HEAD_DROP}px)` : "translateY(0)";
  }

  /* ══ PRINT-OUT ═══════════════════════════════════════════════════ */
  function currentRun() {
    let run = printout.querySelector(".run:last-child");
    if (!run) {
      run = document.createElement("span");
      run.className = "run";
      printout.appendChild(run);
    }
    return run;
  }

  function coolRun({ animate = true } = {}) {
    const run = printout.querySelector(".run");
    if (!run || !run.textContent.trim()) { if (run) run.remove(); return; }
    const block = document.createElement("div");
    block.className = "kv-block" + (animate && !reduceMotion ? " chilling" : "");
    block.textContent = run.textContent;
    printout.replaceChild(block, run);
  }

  function addCachedBlock(text) {
    const block = document.createElement("div");
    block.className = "kv-block";
    block.textContent = text;
    printout.appendChild(block);
  }

  function stamp(token) {
    emptyEl.classList.add("gone");
    const span = document.createElement("span");
    span.className = "tok hot";
    span.textContent = token;
    span.addEventListener("animationend", () => span.classList.remove("hot"), { once: true });
    currentRun().appendChild(span);
  }

  /* ══ ONE READ + WRITE PASS ═══════════════════════════════════════ */
  async function pass(i, total, kvTokens, unit) {
    const kvCost = kvTokens / KV_SPEEDUP;
    const inferCost = i + 1;
    const cost = kvCost + inferCost;
    const costFinal = kvCost + total;

    const target = dialToRate(Number(rateEl.value));
    const nominal = Math.max(MIN_NOMINAL, 1000 / target);
    const T = clamp(nominal * (cost / costFinal), MIN_CYCLE, MAX_CYCLE);

    const tDown = Math.max(24, T * 0.11);
    const tRead = T * 0.44;
    const tWrite = Math.max(20, T * 0.09);
    const tUp = Math.max(24, T * 0.11);
    const tRewind = Math.max(30, T * 0.25);

    const kvDist = kvTokens * unit;
    const inferDist = inferCost * unit;
    const tKv = kvCost > 0 ? tRead * (kvCost / cost) : 0;
    const tInfer = tRead - tKv;

    /* head down */
    play("head_down");
    headTo(true, tDown);
    await wait(tDown);
    if (state.abort) return;

    /* read forward — cached tape first, at 4x */
    led("read", true);
    slit.classList.add("live");
    play("head_read");
    loopOn("tape_forward");

    if (tKv > 0) {
      led("kv", true);
      await moveTape(kvDist, tKv);
      led("kv", false);
      if (state.abort) return;
    }

    led("infer", true);
    await moveTape(kvDist + inferDist, tInfer);
    led("infer", false);
    loopOff("tape_forward");
    slit.classList.remove("live");
    led("read", false);
    if (state.abort) return;

    /* write the one cell that follows */
    led("write", true);
    slit.classList.add("writing");
    play("head_write");
    if (!reduceMotion) {
      headGlow.style.transition = "opacity 90ms linear";
      headGlow.style.opacity = "0.9";
    }
    await wait(tWrite);
    slit.classList.remove("writing");
    led("write", false);
    if (state.abort) return;

    /* head up — the cell cools on the sheet */
    play("head_up");
    headTo(false, tUp);
    if (!reduceMotion) {
      headGlow.style.transition = `opacity ${tUp + 260}ms ease-out`;
      headGlow.style.opacity = "0";
    }
    stamp(state.tokens[i]);
    state.printed++;
    gTape.textContent = `${kvTokens + state.printed} cells`;
    gPass.textContent = `${i + 1} / ${total}`;
    await wait(tUp);
    if (state.abort) return;

    /* rewind to the head of the tape */
    loopOn("tape_rewind");
    await moveTape(0, tRewind);
    loopOff("tape_rewind");
  }

  /* ══ A FULL RUN ══════════════════════════════════════════════════ */
  async function run(tokens, kvTokens) {
    state.tokens = tokens;
    state.kvTokens = kvTokens;
    state.printed = 0;
    state.running = true;
    state.abort = false;

    const total = tokens.length;
    const totalCells = kvTokens + total;
    const unit = Math.min(2.2, TRAVEL_MAX / Math.max(1, totalCells));
    state.maxX = totalCells * unit;

    inferBtn.textContent = "Halt";
    inferBtn.classList.add("halting");
    loremBtn.disabled = clearBtn.disabled = true;

    const target = dialToRate(Number(rateEl.value));
    notice(
      1000 / target < MIN_NOMINAL
        ? `${total} tokens to write. Above ~9 tok/s the linkage is the limit — watch the measured rate.`
        : `${total} tokens to write, each one after a full re-read.`
    );

    const started = performance.now();
    for (let i = 0; i < total; i++) {
      await pass(i, total, kvTokens, unit);
      if (state.abort) break;
      const secs = (performance.now() - started) / 1000;
      gRate.textContent = `${(state.printed / Math.max(secs, 0.001)).toFixed(1)} tok/s`;
    }

    /* park the mechanism */
    cancelAll();
    allSoundOff();
    ledsOff();
    slit.classList.remove("live", "writing");
    headTo(false, 180);
    headGlow.style.opacity = "0";
    await moveTape(0, 260);

    state.running = false;
    inferBtn.textContent = "Infer";
    inferBtn.classList.remove("halting");
    loremBtn.disabled = clearBtn.disabled = false;
    gPass.textContent = state.abort ? "halted" : "idle";
    if (state.abort) notice(`Halted after ${state.printed} of ${total} tokens. What was written stays on the tape.`);
  }

  function halt() {
    state.abort = true;
    cancelAll();
  }

  /* ══ DUST ════════════════════════════════════════════════════════ */
  function sizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(window.innerWidth * dpr);
    canvas.height = Math.floor(window.innerHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function samplePoints(text, rect) {
    const padX = 14, padY = 12;
    const w = Math.max(40, rect.width - padX * 2);
    const font = '13.5px "Space Mono", ui-monospace, monospace';
    const lineH = 22;

    const off = document.createElement("canvas");
    const dpr = 1;
    const measure = off.getContext("2d");
    measure.font = font;

    const lines = [];
    text.split("\n").forEach((para) => {
      let line = "";
      para.split(/(\s+)/).forEach((chunk) => {
        if (measure.measureText(line + chunk).width > w && line) {
          lines.push(line); line = chunk.replace(/^\s+/, "");
        } else line += chunk;
      });
      lines.push(line);
    });

    // Only the lines the feed box actually shows become dust — the rest of
    // the text was scrolled out of sight and has nothing to lift off.
    const maxLines = Math.max(1, Math.floor((rect.height - padY * 2) / lineH));
    if (lines.length > maxLines) lines.length = maxLines;

    const h = Math.max(lineH, lines.length * lineH);
    off.width = Math.ceil(w * dpr);
    off.height = Math.ceil(h * dpr);
    const g = off.getContext("2d");
    g.font = font;
    g.fillStyle = "#fff";
    g.textBaseline = "top";
    lines.forEach((line, i) => g.fillText(line, 0, i * lineH + 4));

    const data = g.getImageData(0, 0, off.width, off.height).data;
    const pts = [];
    const visibleH = rect.height - padY * 2;
    for (let y = 0; y < off.height; y += 2) {
      for (let x = 0; x < off.width; x += 2) {
        if (data[(y * off.width + x) * 4 + 3] > 110) {
          pts.push([rect.left + padX + x, rect.top + padY + Math.min(y, visibleH)]);
        }
      }
    }
    // thin out to something the frame budget can carry
    const cap = 1300;
    if (pts.length > cap) {
      for (let i = pts.length - 1; i > 0; i--) {
        const j = (Math.random() * (i + 1)) | 0;
        [pts[i], pts[j]] = [pts[j], pts[i]];
      }
      pts.length = cap;
    }
    return pts;
  }

  function dustify(text) {
    return new Promise((resolve) => {
      if (reduceMotion) { setTimeout(resolve, 220); return; }

      const rect = promptEl.getBoundingClientRect();
      const pts = samplePoints(text, rect);
      if (!pts.length) { setTimeout(resolve, 200); return; }

      const hr = head.getBoundingClientRect();
      const tx = hr.left + hr.width / 2;
      const ty = hr.top + hr.height / 2;

      sizeCanvas();
      const DUR = 780;
      const parts = pts.map(([x, y]) => ({
        x, y,
        dx: tx + (Math.random() - 0.5) * 90,
        dy: ty + (Math.random() - 0.5) * 40,
        lift: 40 + Math.random() * 130,
        delay: Math.random() * 300,
        r: 0.7 + Math.random() * 1.1,
      }));

      const t0 = performance.now();
      (function tick(now) {
        const t = now - t0;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        let alive = 0;

        for (const p of parts) {
          const local = t - p.delay;
          if (local < 0) { alive++; ctx.globalAlpha = 0.9; ctx.fillStyle = "#d5cfbe";
            ctx.fillRect(p.x, p.y, p.r, p.r); continue; }
          const k = clamp(local / DUR, 0, 1);
          if (k < 1) alive++;
          const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
          const x = p.x + (p.dx - p.x) * e;
          const y = p.y + (p.dy - p.y) * e - Math.sin(e * Math.PI) * p.lift;
          ctx.globalAlpha = (1 - k * k) * 0.95;
          ctx.fillStyle = k < 0.45 ? "#d5cfbe" : "#ff9a4a";
          ctx.fillRect(x, y, p.r + k, p.r + k);
        }

        ctx.globalAlpha = 1;
        if (alive) requestAnimationFrame(tick);
        else { ctx.clearRect(0, 0, canvas.width, canvas.height); resolve(); }
      })(t0);
    });
  }

  /* ══ ACTIONS ═════════════════════════════════════════════════════ */
  function notice(msg) { noticeEl.textContent = msg || ""; }

  async function onInfer() {
    if (state.running) { halt(); return; }

    const text = promptEl.value;
    if (!text.trim()) {
      notice("Nothing to infer. Paste some text first.");
      promptEl.focus();
      return;
    }

    inferBtn.disabled = true;
    promptEl.classList.add("emptying");
    const flying = dustify(text);
    promptEl.value = "";

    let data;
    try {
      const res = await fetch("/api/infer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      data = await res.json();
      if (!res.ok) throw new Error(data.error || "The machine refused the feed.");
    } catch (err) {
      promptEl.value = text;
      promptEl.classList.remove("emptying");
      inferBtn.disabled = false;
      notice(err.message || "Lost the server. Is app.py still running?");
      return;
    }

    coolRun();
    await flying;
    promptEl.classList.remove("emptying");
    inferBtn.disabled = false;
    await run(data.tokens, data.kv_tokens);
  }

  async function onClear() {
    if (state.running) return;
    try {
      await fetch("/api/clear", { method: "POST" });
    } catch (err) {
      notice("Lost the server. Is app.py still running?");
      return;
    }
    printout.innerHTML = "";
    emptyEl.classList.remove("gone");
    state.kvTokens = 0;
    state.printed = 0;
    state.maxX = TRAVEL_MAX;
    await moveTape(0, 220);
    gTape.textContent = "0 cells";
    gPass.textContent = "idle";
    gRate.textContent = "— tok/s";
    notice("Tape wiped. The next run starts with nothing behind it.");
  }

  function onMask() {
    state.masked = !state.masked;
    maskDoor.classList.toggle("down", state.masked);
    maskBtn.textContent = state.masked ? "Unmask" : "Mask";
    maskBtn.setAttribute("aria-pressed", String(state.masked));
  }

  const LOREM = `Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum. Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque laudantium, totam rem aperiam, eaque ipsa quae ab illo inventore veritatis et quasi architecto beatae vitae dicta sunt explicabo. Nemo enim ipsam voluptatem quia voluptas sit aspernatur aut odit aut fugit, sed quia consequuntur magni dolores eos qui ratione voluptatem sequi nesciunt. Neque porro quisquam est, qui dolorem ipsum quia dolor sit amet, consectetur, adipisci velit, sed quia non numquam eius modi tempora incidunt ut labore et dolore magnam aliquam quaerat voluptatem.`;

  function onLorem() {
    let s = LOREM.slice(0, 1000);
    if (!/\s/.test(LOREM.charAt(1000))) s = s.replace(/\S+$/, "").trimEnd() + ".";
    promptEl.value = s;
    promptEl.focus();
    notice(`${s.length} characters loaded into the feed.`);
  }

  function updateRateReadout() {
    const rate = dialToRate(Number(rateEl.value));
    rateOut.textContent = `${rate < 10 ? rate.toFixed(1) : Math.round(rate)} tok/s`;
  }

  function updateVolumeReadout() {
    const v = clamp(Number(volumeEl.value), 0, 100) / 100;
    volumeOut.textContent = `${Math.round(v * 100)}%`;

    audio.masterVolume = v;
    SOUND_NAMES.forEach((name) => {
      if (audio.pools[name]) audio.pools[name].forEach((a) => { a.volume = v; });
      if (audio.loops[name]) audio.loops[name].volume = v;
    });

    try { localStorage.setItem("itm-volume", volumeEl.value); } catch (e) { /* ignore */ }
  }

  /* ══ BOOT ════════════════════════════════════════════════════════ */
  async function boot() {
    drawCells();
    setPack(packL, HUB);
    setPack(packR, PACK_FULL);
    requestAnimationFrame(frame);

    inferBtn.addEventListener("click", onInfer);
    loremBtn.addEventListener("click", onLorem);
    clearBtn.addEventListener("click", onClear);
    maskBtn.addEventListener("click", onMask);
    rateEl.addEventListener("input", updateRateReadout);
    volumeEl.addEventListener("input", updateVolumeReadout);
    promptEl.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); onInfer(); }
    });
    window.addEventListener("resize", sizeCanvas);
    sizeCanvas();
    updateRateReadout();

    try {
      const saved = localStorage.getItem("itm-volume");
      if (saved !== null) volumeEl.value = saved;
    } catch (e) { /* ignore */ }
    updateVolumeReadout();

    try {
      const res = await fetch("/api/state");
      const data = await res.json();
      initAudio(data.sounds);
      if (data.messages.length) {
        data.messages.forEach((m) => addCachedBlock(m.text));
        emptyEl.classList.add("gone");
        state.kvTokens = data.kv_tokens;
        gTape.textContent = `${data.kv_tokens} cells`;
        notice(`${data.kv_tokens} cells already on the tape. They will be re-read at 4x.`);
      }
    } catch (err) {
      gAudio.textContent = "offline";
      notice("Can't reach the server. Is app.py still running?");
    }
  }

  boot();
})();
