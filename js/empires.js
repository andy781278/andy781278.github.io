// Circle Empires simulation at the top of the page. Empires drift, collide, and may go to war.
// Two Perlin noise fields set how fast each empire researches (teal) and expands (gold).
(() => {
  const hero = document.querySelector(".hero");
  const canvas = document.getElementById("empires");
  const ctx = canvas.getContext("2d");
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const css = getComputedStyle(document.documentElement);
  const hex = name => {
    const h = css.getPropertyValue(name).trim().replace("#", "");
    return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
  };
  const TEAL = hex("--teal"), GOLD = hex("--gold"), ROSE = hex("--rose");
  const INK = css.getPropertyValue("--ink").trim();

  // ----- Perlin noise -----
  function rng(seed) {
    return () => {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function perlin(seed) {
    const rand = rng(seed);
    const p = Array.from({ length: 256 }, (_, i) => i);
    for (let i = 255; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
    const perm = new Uint8Array(512);
    for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
    const G = [[1, 1], [-1, 1], [1, -1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]];
    const fade = t => t * t * t * (t * (t * 6 - 15) + 10);
    const dot = (h, x, y) => { const g = G[h & 7]; return g[0] * x + g[1] * y; };
    return (x, y) => {
      const X = Math.floor(x) & 255, Y = Math.floor(y) & 255;
      const xf = x - Math.floor(x), yf = y - Math.floor(y);
      const u = fade(xf), v = fade(yf);
      const aa = perm[perm[X] + Y], ab = perm[perm[X] + Y + 1];
      const ba = perm[perm[X + 1] + Y], bb = perm[perm[X + 1] + Y + 1];
      const x1 = dot(aa, xf, yf) + u * (dot(ba, xf - 1, yf) - dot(aa, xf, yf));
      const x2 = dot(ab, xf, yf - 1) + u * (dot(bb, xf - 1, yf - 1) - dot(ab, xf, yf - 1));
      return x1 + v * (x2 - x1);
    };
  }
  const seed = Math.floor(Math.random() * 1e9);
  const noiseTech = perlin(seed), noisePop = perlin(seed + 7919);
  const SCALE = 1 / 240;
  const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const raw = (n, x, y) => 0.5 + 0.9 * (0.65 * n(x * SCALE, y * SCALE) + 0.35 * n(x * SCALE * 2 + 5.2, y * SCALE * 2 + 1.3));
  const techField = (x, y) => smooth(0.5, 0.82, raw(noiseTech, x, y));
  const popField = (x, y) => smooth(0.5, 0.82, raw(noisePop, x, y));
  // Base growth per second at a location, before an empire's own modifiers.
  const researchGain = (x, y) => 0.02 + 0.45 * techField(x, y);
  const populationGain = (x, y) => 30 + 420 * popField(x, y);

  // ----- Canvas and field images -----
  let W = 0, H = 0, techImg = null, popImg = null;
  function fieldImage(fn, color) {
    const s = 6, bw = Math.ceil(W / s), bh = Math.ceil(H / s);
    const c = document.createElement("canvas");
    c.width = bw; c.height = bh;
    const b = c.getContext("2d"), im = b.createImageData(bw, bh);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      const o = (y * bw + x) * 4, f = fn(x * s, y * s);
      im.data[o] = color[0]; im.data[o + 1] = color[1]; im.data[o + 2] = color[2];
      im.data[o + 3] = f * (dark ? 70 : 85);
    }
    b.putImageData(im, 0, 0);
    return c;
  }
  function resize() {
    W = hero.clientWidth; H = hero.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    techImg = fieldImage(techField, TEAL);
    popImg = fieldImage(popField, GOLD);
    for (const e of empires) { e.x = Math.min(Math.max(e.x, 20), W - 20); e.y = Math.min(Math.max(e.y, 20), H - 20); }
  }

  // ----- Empires -----
  const MAX = 10, MIN_R = 7;
  const rCap = () => Math.min(W, H) * 0.09;
  const radius = e => Math.sqrt(Math.max(0, e.area) / Math.PI);
  const MIN_POP = Math.PI * MIN_R * MIN_R;
  // Actual growth per second for an empire: the base rate at its center, slowed by its tech level
  // (diminishing returns) and by its size (growth stops at the maximum radius).
  const empireResearch = e => researchGain(e.x, e.y) / (1 + 0.15 * e.tech);
  const empirePopulation = e => populationGain(e.x, e.y) * Math.max(0, 1 - radius(e) / rCap());
  const rand = (a, b) => a + Math.random() * (b - a);
  const COLORS = Array.from({ length: MAX }, (_, i) =>
    `hsl(${(i * 36 + 190) % 360} ${dark ? 45 : 40}% ${dark ? 60 : 47}%)`);
  let empires = [], nextId = 0, spawnTimer = 0, clock = 0;
  const byId = id => empires.find(e => e.id === id);

  const NAME_START = ["Val", "Kor", "Ash", "Bel", "Dor", "Eld", "Fen", "Gal", "Hal", "Ith", "Jor", "Kal",
    "Lor", "Mar", "Nor", "Os", "Pel", "Quen", "Ros", "Sar", "Tor", "Ul", "Ver", "Wyn", "Zan"];
  const NAME_MID = ["", "", "a", "e", "i", "o", "an", "en", "or"];
  const NAME_END = ["ria", "mar", "dor", "land", "heim", "gard", "via", "thos", "vale", "mor", "stan", "nia"];
  function makeName() {
    const taken = new Set(empires.filter(e => !e.dead).map(e => e.name));
    for (let i = 0; i < 50; i++) {
      const pick = a => a[Math.floor(Math.random() * a.length)];
      const name = pick(NAME_START) + pick(NAME_MID) + pick(NAME_END);
      if (!taken.has(name)) return name;
    }
    return "Empire " + nextId;
  }

  function spawn() {
    const used = new Set(empires.filter(e => !e.dead).map(e => e.colorIndex));
    let colorIndex = 0;
    while (used.has(colorIndex)) colorIndex++;
    for (let tries = 0; tries < 40; tries++) {
      const r = rand(9, 13);
      const x = rand(r + 12, W - r - 12), y = rand(r + 12, H - r - 12);
      if (empires.every(o => o.dead || Math.hypot(o.x - x, o.y - y) > r + radius(o) + 10)) {
        empires.push({
          id: nextId++, name: makeName(), x, y, vx: rand(-8, 8), vy: rand(-8, 8),
          area: Math.PI * r * r, tech: 1, colorIndex, heading: rand(0, Math.PI * 2),
          wars: new Set(), met: new Map(), lastHit: new Map(),
          grow: 0, fade: 1, dead: false, flash: 0
        });
        return;
      }
    }
  }

  function endWar(a, b) { a.wars.delete(b.id); b.wars.delete(a.id); }

  function kill(e, by) {
    e.dead = true;
    if (by && !by.dead) by.area += Math.max(0, e.area) * 0.5;
    for (const id of e.wars) { const o = byId(id); if (o) o.wars.delete(e.id); }
    e.wars.clear();
  }

  function battle(a, b) {
    const sa = Math.pow(a.tech, 2.2) * radius(a), sb = Math.pow(b.tech, 2.2) * radius(b);
    const base = 160 + 0.3 * Math.min(a.area, b.area);
    const lossA = base * sb / (sa + sb), lossB = base * sa / (sa + sb);
    a.area += lossB * 0.3 - lossA;
    b.area += lossA * 0.3 - lossB;
    a.flash = b.flash = 1;
    if (!(a.area > MIN_POP)) kill(a, b);
    if (!(b.area > MIN_POP)) kill(b, a);
  }

  function update(dt) {
    clock += dt;
    const alive = empires.filter(e => !e.dead);
    spawnTimer += dt;
    if (alive.length < MAX && spawnTimer > 1.1) { spawnTimer = 0; spawn(); }

    for (const e of empires) {
      e.flash = Math.max(0, e.flash - dt * 3);
      if (e.dead) { e.fade -= dt * 1.8; continue; }
      e.grow = Math.min(1, e.grow + dt * 2);
      e.tech += dt * empireResearch(e);
      e.area += dt * empirePopulation(e);

      e.heading += (Math.random() - 0.5) * 2.5 * dt;
      e.vx += Math.cos(e.heading) * 10 * dt;
      e.vy += Math.sin(e.heading) * 10 * dt;
      for (const id of [...e.wars]) {
        const o = byId(id);
        if (!o || o.dead) { e.wars.delete(id); continue; }
        if (Math.random() < dt * 0.03) { endWar(e, o); continue; }
        const dx = o.x - e.x, dy = o.y - e.y, d = Math.hypot(dx, dy) || 1;
        e.vx += dx / d * 30 * dt; e.vy += dy / d * 30 * dt;
      }
      e.vx *= 1 - 0.5 * dt; e.vy *= 1 - 0.5 * dt;
      const sp = Math.hypot(e.vx, e.vy), max = e.wars.size ? 40 : 14, min = 5;
      if (sp > max) { e.vx *= max / sp; e.vy *= max / sp; }
      else if (sp < min && sp > 0) { e.vx *= min / sp; e.vy *= min / sp; }
      e.x += e.vx * dt; e.y += e.vy * dt;
      const r = radius(e);
      if (e.x < r) { e.x = r; e.vx = Math.abs(e.vx); e.heading = Math.PI - e.heading; }
      if (e.x > W - r) { e.x = W - r; e.vx = -Math.abs(e.vx); e.heading = Math.PI - e.heading; }
      if (e.y < r) { e.y = r; e.vy = Math.abs(e.vy); e.heading = -e.heading; }
      if (e.y > H - r) { e.y = H - r; e.vy = -Math.abs(e.vy); e.heading = -e.heading; }
    }

    // Collisions: elastic bounce weighted by area; may start a war or fight a battle.
    for (let i = 0; i < empires.length; i++) for (let j = i + 1; j < empires.length; j++) {
      const a = empires[i], b = empires[j];
      if (a.dead || b.dead) continue;
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy), rs = radius(a) + radius(b);
      if (d >= rs || d === 0) continue;
      const nx = dx / d, ny = dy / d, overlap = rs - d, ma = a.area, mb = b.area;
      a.x -= nx * overlap * mb / (ma + mb); a.y -= ny * overlap * mb / (ma + mb);
      b.x += nx * overlap * ma / (ma + mb); b.y += ny * overlap * ma / (ma + mb);
      const rv = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
      if (rv < 0) {
        const imp = -1.9 * rv / (1 / ma + 1 / mb);
        a.vx -= imp * nx / ma; a.vy -= imp * ny / ma;
        b.vx += imp * nx / mb; b.vy += imp * ny / mb;
      }
      if (!a.wars.has(b.id)) {
        if (clock - (a.met.get(b.id) ?? -99) > 3) {
          a.met.set(b.id, clock);
          if (Math.random() < 0.45) { a.wars.add(b.id); b.wars.add(a.id); a.flash = b.flash = 1; }
        }
      } else if (clock - (a.lastHit.get(b.id) ?? -99) > 0.35) {
        a.lastHit.set(b.id, clock);
        battle(a, b);
      }
    }
    empires = empires.filter(e => !e.dead || e.fade > 0);
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(techImg, 0, 0, W, H);
    ctx.drawImage(popImg, 0, 0, W, H);

    // War lines
    ctx.save();
    ctx.setLineDash([5, 5]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = `rgb(${ROSE.join(",")})`;
    ctx.globalAlpha = 0.75;
    for (const a of empires) for (const id of a.wars) {
      if (id < a.id) continue;
      const b = byId(id);
      if (!b) continue;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    ctx.restore();

    for (const e of empires) {
      const ease = e.grow * e.grow * (3 - 2 * e.grow);
      const r = radius(e) * ease * (e.dead ? Math.max(0, e.fade) : 1);
      if (r <= 0.5) continue;
      ctx.globalAlpha = e.dead ? Math.max(0, e.fade) : 0.92;
      ctx.fillStyle = COLORS[e.colorIndex];
      ctx.beginPath(); ctx.arc(e.x, e.y, r, 0, Math.PI * 2); ctx.fill();
      if (e.wars.size) {
        ctx.lineWidth = 2; ctx.strokeStyle = `rgb(${ROSE.join(",")})`;
        ctx.stroke();
      }
      if (e.flash > 0) {
        ctx.globalAlpha = e.flash * 0.8;
        ctx.lineWidth = 2; ctx.strokeStyle = `rgb(${ROSE.join(",")})`;
        ctx.beginPath(); ctx.arc(e.x, e.y, r + 3 + (1 - e.flash) * 8, 0, Math.PI * 2); ctx.stroke();
      }
      if (e === hovered && !e.dead) {
        ctx.globalAlpha = 1; ctx.lineWidth = 2; ctx.strokeStyle = INK;
        ctx.beginPath(); ctx.arc(e.x, e.y, r + 2, 0, Math.PI * 2); ctx.stroke();
      }
      if (!e.dead && e.grow > 0.6) {
        ctx.globalAlpha = 1;
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        // Largest font (up to 16px) at which the name fits inside the circle.
        // The name goes inside whenever that size is at least 10px, so it returns to the middle as soon as the circle is big enough again.
        ctx.font = "700 16px Archivo, system-ui, sans-serif";
        const size = Math.min(16, 16 * (r * 1.7) / ctx.measureText(e.name).width);
        if (size >= 10) {
          ctx.font = `700 ${size}px Archivo, system-ui, sans-serif`;
          ctx.fillStyle = "#ffffff";
          ctx.fillText(e.name, e.x, e.y + 1);
        } else {
          ctx.font = "600 11px Archivo, system-ui, sans-serif";
          ctx.fillStyle = INK;
          ctx.fillText(e.name, e.x, e.y + r + 10);
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  // Tooltip: hovering over an empire shows its stats.
  // Holding the left mouse button shows the base growth rates at that spot.
  let pointer = null, hovered = null, holding = false;
  const tip = document.createElement("div");
  tip.className = "emp-tip";
  tip.hidden = true;
  hero.appendChild(tip);
  const UI = "a, button, .lb";
  const setPointer = e => {
    if (e.target.closest(UI)) { pointer = null; hovered = null; tip.hidden = true; return; }
    pointer = { cx: e.clientX, cy: e.clientY };
  };
  hero.addEventListener("pointermove", setPointer);
  hero.addEventListener("pointerdown", e => {
    if (e.button !== 0 || e.target.closest(UI)) return;
    holding = true;
    setPointer(e);
  });
  // Stop text selection while holding the button on the map (links still work).
  hero.addEventListener("mousedown", e => { if (e.button === 0 && !e.target.closest(UI)) e.preventDefault(); });
  window.addEventListener("pointerup", () => { holding = false; });
  window.addEventListener("pointercancel", () => { holding = false; });
  hero.addEventListener("pointerleave", () => { pointer = null; hovered = null; tip.hidden = true; });

  function updateTip() {
    if (!pointer) return;
    const rect = hero.getBoundingClientRect();
    const x = pointer.cx - rect.left, y = pointer.cy - rect.top;
    hovered = null;
    for (const e of empires) {
      if (!e.dead && Math.hypot(e.x - x, e.y - y) <= radius(e)) hovered = e;
    }
    if (!hovered && !holding) { tip.hidden = true; return; }
    let html = "";
    if (hovered) {
      html += `<strong>${hovered.name}</strong><br>Population: ${Math.round(hovered.area).toLocaleString()}<br>Tech level: ${hovered.tech.toFixed(2)}`;
      if (hovered.wars.size) html += `<br>At war with ${[...hovered.wars].map(id => byId(id)?.name).filter(Boolean).join(", ")}`;
    }
    if (holding) {
      // Over an empire: its actual rates. On open map: the base rates at that spot.
      const research = hovered ? empireResearch(hovered) : researchGain(x, y);
      const population = hovered ? empirePopulation(hovered) : populationGain(x, y);
      if (hovered) html += "<hr>";
      html += `<span class="t">Research gain: ${research.toFixed(2)} per second</span><br>` +
              `<span class="g">Population gain: ${Math.round(population)} per second</span>`;
      if (hovered && hovered.wars.size) html += "<br>War losses are not included.";
    }
    tip.innerHTML = html;
    tip.hidden = false;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    tip.style.left = Math.min(x + 16, W - tw - 8) + "px";
    tip.style.top = (y + 16 + th > H ? y - th - 12 : y + 16) + "px";
  }

  // Leaderboard: a toggle button in the top-left corner opens a sortable table of living empires.
  // Power = population x tech level.
  const lbBtn = document.createElement("button");
  lbBtn.type = "button";
  lbBtn.className = "lb-toggle";
  lbBtn.setAttribute("aria-expanded", "false");
  lbBtn.setAttribute("aria-label", "Show empire leaderboard");
  lbBtn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M9 5l7 7-7 7" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const lb = document.createElement("div");
  lb.className = "lb";
  lb.hidden = true;
  hero.append(lbBtn, lb);

  const COLS = [["name", "Empire"], ["pop", "Population"], ["tech", "Tech"], ["power", "Power"]];
  let sortKey = "power", sortDir = -1, lbTimer = 0;
  lbBtn.addEventListener("click", () => {
    const open = lb.hidden;
    lb.hidden = !open;
    lbBtn.setAttribute("aria-expanded", String(open));
    lbBtn.setAttribute("aria-label", open ? "Hide empire leaderboard" : "Show empire leaderboard");
    if (open) renderLeaderboard();
  });
  lb.addEventListener("click", e => {
    const b = e.target.closest("[data-key]");
    if (!b) return;
    const key = b.dataset.key;
    if (key === sortKey) sortDir *= -1;
    else { sortKey = key; sortDir = key === "name" ? 1 : -1; }
    renderLeaderboard();
  });

  function renderLeaderboard() {
    const rows = empires.filter(e => !e.dead).map(e => ({ e, name: e.name, pop: e.area, tech: e.tech, power: e.area * e.tech }));
    rows.sort((a, b) => sortKey === "name" ? sortDir * a.name.localeCompare(b.name) : sortDir * (a[sortKey] - b[sortKey]));
    const mark = k => k === sortKey ? (sortDir < 0 ? " ▼" : " ▲") : "";
    lb.innerHTML =
      `<table><thead><tr><th>#</th>${COLS.map(([k, label]) =>
        `<th><button type="button" data-key="${k}">${label}${mark(k)}</button></th>`).join("")}</tr></thead><tbody>` +
      rows.map((r, i) =>
        `<tr${r.e === hovered ? ' class="hl"' : ""}><td>${i + 1}</td>` +
        `<td><span class="lb-dot" style="background:${COLORS[r.e.colorIndex]}"></span>${r.name}` +
        `${r.e.wars.size ? ' <span class="lb-war">at war</span>' : ""}</td>` +
        `<td>${Math.round(r.pop).toLocaleString()}</td><td>${r.tech.toFixed(2)}</td>` +
        `<td>${Math.round(r.power).toLocaleString()}</td></tr>`).join("") +
      "</tbody></table>";
  }

  resize();
  let resizeTimer;
  window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(resize, 200); });

  if (reduce) {
    for (let i = 0; i < 60 * 40; i++) update(1 / 60);
    draw();
    return;
  }

  let visible = true;
  new IntersectionObserver(entries => { visible = entries[0].isIntersecting; }).observe(hero);
  let prev = performance.now();
  function loop(now) {
    const dt = Math.min(0.05, (now - prev) / 1000);
    prev = now;
    if (visible) {
      update(dt); updateTip(); draw();
      lbTimer += dt;
      if (!lb.hidden && lbTimer > 0.5) { lbTimer = 0; renderLeaderboard(); }
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
})();