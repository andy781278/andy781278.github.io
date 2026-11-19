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
  const MAX = 20;
  // Drawn radius per population. 1.5 makes circles and spheres 50% wider for the same population and power.
  const R_SCALE = 1.5;
  // Growth stops at this radius. Scaled with R_SCALE so the population cap stays the same.
  const rCap = () => Math.min(W, H) * 0.09 * R_SCALE;
  const radius = e => R_SCALE * Math.sqrt(Math.max(0, e.area) / Math.PI);
  const MIN_POP = Math.PI * 7 * 7;  // an empire dies below this population
  // Actual growth per second for an empire: the base rate at its center, slowed by its tech level
  // (diminishing returns) and by its size (growth stops at the maximum radius).
  const empireResearch = e => researchGain(e.x, e.y) / (1 + 0.15 * e.tech);
  // ----- Random events state (Plague, Dark Ages, Pax Romana) -----
  let pax = 0;                     // seconds of Pax Romana left
  let eventTimer = 100 + Math.random() * 100;  // seconds until the next random event (100 to 200)
  let darkZone = null;             // last Dark Ages circle, drawn while it fades
  let nextPlagueId = 0;
  const PAX_GROWTH = 2;
  const PEACE_RATE = 0.15;         // chance per second that a war ends in peace
  // War attrition (0 to 100). Each battle adds about 1 for the winner and about 5 for the loser,
  // more when the enemy is stronger. It falls by 2 per second while the empire is at peace.
  // Each point lowers battle strength by 0.5%. At 80 or more, the empire cannot start wars,
  // and rebellions against it succeed without a fight.
  const ATTRITION_WIN = 1, ATTRITION_LOSS = 5, ATTRITION_DECAY = 2, ATTRITION_LOCK = 80;
  const BATTLE_PEACE = 0.25;       // chance that a war ends right after each battle
  const BATTLE_KICK = 70;          // extra push apart after each battle, so fighting empires bounce
  const canStartWar = e => e.attrition < ATTRITION_LOCK;            // population growth multiplier during Pax Romana
  const empirePopulation = e => populationGain(e.x, e.y) * Math.max(0, 1 - radius(e) / rCap()) * (pax > 0 ? PAX_GROWTH : 1);
  const power = e => e.area * e.tech;
  // Great powers: the top 5 empires by power, if they have at least 10,000 power.
  // Each great power has a sphere of influence whose area is proportional to its power.
  const GP_COUNT = 5, GP_MIN = 10000;
  const SPHERE_K = 1;  // sphere area per point of power
  const SPHERE_WAR_CHANCE = 0.85;  // chance of war when two spheres first touch
  const sphereTarget = e => R_SCALE * Math.sqrt(SPHERE_K * power(e) / Math.PI);
  let greatPowers = new Set();
  // Stability: -5 to +5. It moves 1 step up or down at random every 1 to 15 seconds.
  // Losing a war costs 1. In a battle, each point of stability above the enemy adds 5% strength.
  const STAB_MIN = -5, STAB_MAX = 5, STAB_BONUS = 0.05;
  const clampStab = v => Math.max(STAB_MIN, Math.min(STAB_MAX, v));
  const fmtStab = v => (v > 0 ? "+" : "") + v;

  // Alliances. Every empire has an invisible proximity range, the same size as a sphere of influence.
  // Two empires whose ranges overlap may ally. Allies share wars and never fight each other.
  // Cohesion (0 to 100) walks 5 every 1 to 5 seconds. Larger alliances drift down more often.
  // At 0 the alliance breaks. At 100 the members combine into one empire.
  const ALLY_RATE = 0.04;      // chance per second for two empires in range to ally
  const ALLY_PULL = 8;         // pull between allies whose ranges no longer overlap
  // Light, saturated colors so alliance names stay readable over a dark outline. Red is left out because it marks war.
  const ALLY_COLORS = ["#ffd23f", "#8ef26b", "#4cd8ff", "#8fb0ff", "#c9a3ff", "#ffa94d", "#3ef0c0", "#ff8ae6", "#e8c39e", "#ffffff"];
  const ALLY_ADJ = ["Iron", "Silver", "Golden", "Northern", "Southern", "Eastern", "Western", "Azure", "Emerald",
    "Ivory", "Obsidian", "Sun", "Moon", "Storm", "Twin", "High", "Old", "Free"];
  const ALLY_NOUN = ["Pact", "League", "Accord", "Concord", "Union", "Compact", "Covenant", "Coalition", "Entente"];
  let alliances = [], nextAllianceId = 0;
  const proximity = e => R_SCALE * Math.sqrt(SPHERE_K * power(e) / Math.PI);
  // Puppets. A winner at least 3 times the loser's power may turn the loser into a puppet (8% per battle won).
  // A puppet is part of its master's side: it shares the master's wars, alliance, color, and tech.
  // It does not count as an alliance member for cohesion. When the master leaves an alliance, its puppets go with it.
  // Each puppet may revolt at 1% per second if its master has 1 puppet, doubling with each extra puppet
  // (2% with 2, 4% with 3, 8% with 4). A puppet with at least half its master's power revolts right away.
  // Winning that war frees it.
  const PUPPET_RATIO = 3, PUPPET_CHANCE = 0.08, PUPPET_REVOLT_RATIO = 0.5, PUPPET_REVOLT_RATE = 0.01;
  const root = e => (e.master !== null && byId(e.master)) || e;
  const allianceOf = e => root(e).alliance;
  const colorOf = e => COLORS[root(e).colorIndex];  // puppets show the master's color and keep their own colorIndex
  // Side key: empires with the same key are allies (same alliance, or a master and its puppets).
  const sideKey = e => { const r = root(e); return r.alliance ? "a" + r.alliance.id : "e" + r.id; };
  // Coalition: a temporary alliance of great powers against one dominant great power (see update()).
  let coalition = null;  // { target: empire id, members: Set of great power ids }
  // An empire is in the coalition if it is on the same side as any coalition member (its alliance and puppets count).
  const inCoalition = e => !!coalition && [...coalition.members].some(id => {
    const m = byId(id);
    return m && !m.dead && sideKey(m) === sideKey(e);
  });
  const allied = (a, b) => a !== b && (sideKey(a) === sideKey(b) || (inCoalition(a) && inCoalition(b)));
  // An empire's power plus the power of all its puppets.
  const blocPower = e => power(e) + empires.reduce((sum, x) => sum + (!x.dead && x.master === e.id ? power(x) : 0), 0);
  const membersOf = e => { const k = sideKey(e); return empires.filter(x => !x.dead && sideKey(x) === k); };
  const rand = (a, b) => a + Math.random() * (b - a);
  // Hues step by the golden angle so empires that exist at the same time get well-separated colors.
  // Alternate lightness to separate the 20 colors further.
  // Random spawns stop at MAX. Rebellions and revolutions can add empires up to SPLIT_MAX.
  const SPLIT_MAX = 30;
  const COLORS = Array.from({ length: SPLIT_MAX }, (_, i) =>
    `hsl(${Math.round(190 + i * 137.5) % 360} ${dark ? 45 : 40}% ${(dark ? 60 : 47) + (i % 2 ? (dark ? -10 : 8) : 0)}%)`);
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

  function freeColor() {
    const used = new Set(empires.filter(e => !e.dead).map(e => e.colorIndex));
    let colorIndex = 0;
    while (used.has(colorIndex) && colorIndex < SPLIT_MAX - 1) colorIndex++;
    return colorIndex;
  }
  // name = prefix + baseName. An empire has at most one prefix (from a revolution).
  function makeEmpire({ name, baseName = name, prefix = null, x, y, area, tech, colorIndex }) {
    return {
      id: nextId++, name, baseName, prefix, x, y, vx: rand(-8, 8), vy: rand(-8, 8),
      area, tech, colorIndex, heading: rand(0, Math.PI * 2),
      wars: new Set(), met: new Map(), lastHit: new Map(), touching: new Set(),
      warNet: new Map(), stability: 0, stabTimer: rand(1, 15), alliance: null,
      rebelOf: null, revRivals: new Set(), revPeace: false, master: null, revoltFrom: null,
      plagued: new Set(), contagious: 0, plagueId: null, attrition: 0,
      grow: 0, fade: 1, dead: false, flash: 0, sphere: 0
    };
  }

  function spawn() {
    const colorIndex = freeColor();
    for (let tries = 0; tries < 40; tries++) {
      const r = rand(9, 13), dr = r * R_SCALE;  // starting population is pi * r^2; dr is its drawn radius
      const x = rand(dr + 12, W - dr - 12), y = rand(dr + 12, H - dr - 12);
      if (empires.every(o => o.dead || Math.hypot(o.x - x, o.y - y) > dr + radius(o) + 10)) {
        empires.push(makeEmpire({ name: makeName(), x, y, area: Math.PI * r * r, tech: 1, colorIndex }));
        return;
      }
    }
  }

  function pairWar(a, b) {
    if (pax > 0) return;  // no wars can start during Pax Romana
    a.wars.add(b.id); b.wars.add(a.id);
    a.warNet.set(b.id, 0); b.warNet.set(a.id, 0);
    a.flash = b.flash = 1;
  }
  // A war between two empires pulls in both of their alliances. Every member of one side is at war with every member of the other.
  function startWar(a, b) {
    if (allied(a, b)) return;
    for (const x of membersOf(a)) for (const y of membersOf(b)) {
      if (x !== y && !allied(x, y) && !x.wars.has(y.id)) pairWar(x, y);
    }
  }
  const changeCohesion = (e, amount) => {
    if (e && e.alliance) e.alliance.cohesion = Math.max(0, Math.min(100, e.alliance.cohesion + amount));
  };

  // Peace. The side whose population changed less favorably during the war lost it and loses 1 stability.
  // If no battles were fought, neither side lost.
  // With scored = false the war ends with no winner or loser.
  function endWar(a, b, scored = true) {
    const na = a.warNet.get(b.id) ?? 0, nb = b.warNet.get(a.id) ?? 0;
    const loser = !scored ? null : na < nb ? a : nb < na ? b : null;
    if (loser) {
      const winner = loser === a ? b : a;
      loser.stability = clampStab(loser.stability - 1);
      changeCohesion(loser, -10);
      changeCohesion(winner, 10);
    }
    a.wars.delete(b.id); b.wars.delete(a.id);
    a.warNet.delete(b.id); b.warNet.delete(a.id);
    // Rebels that survive their war of independence take a new name.
    if (a.rebelOf === b.id) renameRebels(a);
    if (b.rebelOf === a.id) renameRebels(b);
    // A puppet's war of independence: losing makes it a puppet again. Winning, or peace with no result, frees it.
    for (const [x, y] of [[a, b], [b, a]]) {
      if (x.revoltFrom !== y.id) continue;
      x.revoltFrom = null;
      if (loser === x && !x.dead && !y.dead) makePuppet(x, root(y));
    }
    // Revolution factions that make peace keep their prefixes.
    if (a.revRivals.has(b.id)) {
      a.revRivals.delete(b.id); b.revRivals.delete(a.id);
      a.revPeace = b.revPeace = true;
      finishRevolution(a); finishRevolution(b);
    }
  }

  function kill(e, by) {
    e.dead = true;
    if (by && !by.dead) by.area += Math.max(0, e.area) * 0.5;
    removeEmpire(e);
  }
  // Takes an empire off the map: ends its wars without a result, leaves its alliance, and resolves rebellions and revolutions.
  function removeEmpire(e) {
    e.dead = true;
    leaveAlliance(e);
    for (const id of e.wars) { const o = byId(id); if (o) { o.wars.delete(e.id); o.warNet.delete(e.id); } }
    e.wars.clear();
    for (const x of empires) {
      if (x.dead) continue;
      if (x.rebelOf === e.id) renameRebels(x);  // the empire they rebelled against is gone, so their war is over
      if (x.revRivals.delete(e.id)) finishRevolution(x);
      if (x.master === e.id) x.master = null;          // the master is gone, so its puppets are free
      if (x.revoltFrom === e.id) x.revoltFrom = null;
    }
  }

  // Turns p into a puppet of m. p leaves its alliance, its wars end, and its own puppets now belong to m.
  // winner is the empire that won the battle; that war is scored normally. Other wars end with no result.
  function makePuppet(p, m, winner = null) {
    if (p === m || p.dead || m.dead) return;
    leaveAlliance(p);
    for (const x of empires) if (!x.dead && x.master === p.id) x.master = m.id;
    if (winner && p.wars.has(winner.id)) endWar(p, winner);
    for (const id of [...p.wars]) { const o = byId(id); if (o) endWar(p, o, false); }
    p.master = m.id;
    p.revoltFrom = null;
    p.tech = m.tech;
    p.flash = 1;
  }

  function leaveAlliance(e) {
    if (e.alliance) { e.alliance.members.delete(e.id); e.alliance = null; }
  }
  function newAllianceName() {
    const taken = new Set(alliances.map(a => a.name));
    for (let i = 0; i < 50; i++) {
      const pick = arr => arr[Math.floor(Math.random() * arr.length)];
      const name = `${pick(ALLY_ADJ)} ${pick(ALLY_NOUN)}`;
      if (!taken.has(name)) return name;
    }
    return "Alliance " + nextAllianceId;
  }
  function tryAlly(a, b) {
    if (a.master !== null || b.master !== null) return;  // puppets follow their master's alliance
    if (a.alliance && b.alliance) return;  // two existing alliances do not join each other
    if (!a.alliance && !b.alliance) {
      const used = new Set(alliances.map(al => al.color));
      const color = ALLY_COLORS.find(c => !used.has(c));
      if (!color) return;  // every alliance color is in use
      const al = { id: nextAllianceId++, name: newAllianceName(), color, cohesion: 50, timer: rand(1, 5), members: new Set([a.id, b.id]) };
      alliances.push(al);
      a.alliance = b.alliance = al;
      return;
    }
    const al = a.alliance || b.alliance, joiner = a.alliance ? b : a;
    const members = [...al.members].map(byId).filter(Boolean);
    if (members.some(m => m.wars.has(joiner.id))) return;  // cannot join an alliance it is fighting
    // The new member brings 50 cohesion, averaged in: (n * cohesion + 50) / (n + 1).
    const n = al.members.size;
    al.cohesion = (n * al.cohesion + 50) / (n + 1);
    al.members.add(joiner.id);
    joiner.alliance = al;
  }
  function dissolve(al) {
    for (const id of al.members) { const m = byId(id); if (m) m.alliance = null; }
    al.members.clear();
  }
  // Cohesion 100: all members combine into the most populous member.
  // It gets the combined population, the average tech level, and every war its members were fighting.
  function unify(al) {
    const members = [...al.members].map(byId).filter(m => m && !m.dead);
    dissolve(al);
    if (members.length < 2) return;
    const core = members.reduce((best, m) => m.area > best.area ? m : best);
    const enemies = new Set();
    let area = 0, tech = 0;
    for (const m of members) {
      area += Math.max(0, m.area); tech += m.tech;
      for (const id of m.wars) enemies.add(id);
    }
    core.area = area;
    core.tech = tech / members.length;
    core.flash = 1;
    for (const m of members) {
      if (m === core) continue;
      for (const x of empires) if (!x.dead && x.master === m.id) x.master = core.id;
      removeEmpire(m);  // fades out without giving population to anyone
    }
    for (const id of enemies) {
      const o = byId(id);
      if (o && !o.dead && o !== core && !members.includes(o) && !core.wars.has(o.id)) pairWar(core, o);
    }
  }

  // ----- Rebellion and revolution -----
  // Below 0 stability, an uprising can happen: 0.4% per second at -1, up to 2% per second at -5.
  // 80% of uprisings are rebellions and 20% are revolutions.
  const REBEL_RATE = 0.02, REVOLUTION_CHANCE = 0.2;
  const PREFIXES = ["Nationalist", "Monarchist", "Republican", "Socialist", "Imperial", "Federal",
    "Theocratic", "Democratic", "People's", "Free", "United", "Restored"];
  const aliveCount = () => empires.filter(e => !e.dead).length;
  const clampX = (x, r) => Math.min(Math.max(x, r), W - r);
  const clampY = (y, r) => Math.min(Math.max(y, r), H - r);

  function renameRebels(x) {
    if (x.dead || x.rebelOf === null) return;
    x.rebelOf = null;
    x.prefix = null;
    x.name = x.baseName = makeName();
  }
  // When a faction has no revolution rivals left: if every rival was destroyed, it won and takes the original name.
  // If it made peace with any rival, it keeps its prefix.
  function finishRevolution(x) {
    if (x.dead || x.revRivals.size) return;
    if (!x.revPeace && x.prefix) { x.prefix = null; x.name = x.baseName; }
    x.revPeace = false;
  }

  // Rebellion: 10% to 30% of the population splits off next to the empire, with the same tech, and is at war with it.
  function rebellion(e) {
    if (aliveCount() >= SPLIT_MAX) return;
    const area = e.area * rand(0.1, 0.3);
    if (area < MIN_POP * 2) return;
    e.area -= area;
    const R = radius(e), r = R_SCALE * Math.sqrt(area / Math.PI), ang = rand(0, Math.PI * 2);
    const cos = Math.cos(ang), sin = Math.sin(ang), d = R + r + 2;
    const base = e.name.replace(/ Rebels$/, "");
    const reb = makeEmpire({ name: `${base} Rebels`, x: clampX(e.x + cos * d, r), y: clampY(e.y + sin * d, r),
      area, tech: e.tech, colorIndex: freeColor() });
    reb.grow = 1;
    reb.rebelOf = e.id;
    reb.vx = cos * 20; reb.vy = sin * 20;
    empires.push(reb);
    if (e.attrition >= ATTRITION_LOCK) renameRebels(reb);  // too worn out to fight: the rebels are free right away
    else startWar(reb, e);
  }

  // Revolution: the empire breaks into 2 to 4 factions with random shares of its population and the same tech.
  // The original empire is gone. Each faction gets a different prefix and all factions are at war with each other.
  function revolution(e) {
    let n = Math.min(2 + Math.floor(Math.random() * 3), SPLIT_MAX - aliveCount() + 1);
    while (n >= 2 && e.area / n < MIN_POP * 2) n--;
    if (n < 2) return;
    const weights = Array.from({ length: n }, () => rand(0.5, 1.5));
    const total = weights.reduce((a, b) => a + b, 0);
    const prefixes = PREFIXES.filter(p => p !== e.prefix).sort(() => Math.random() - 0.5).slice(0, n);
    const R = radius(e), start = rand(0, Math.PI * 2), area = e.area, tech = e.tech, cx = e.x, cy = e.y;
    removeEmpire(e);
    const factions = [];
    for (let k = 0; k < n; k++) {
      const a = area * weights[k] / total, r = R_SCALE * Math.sqrt(a / Math.PI);
      const ang = start + k * Math.PI * 2 / n, cos = Math.cos(ang), sin = Math.sin(ang);
      const f = makeEmpire({ name: `${prefixes[k]} ${e.baseName}`, baseName: e.baseName, prefix: prefixes[k],
        x: clampX(cx + cos * R * 0.55, r), y: clampY(cy + sin * R * 0.55, r), area: a, tech, colorIndex: freeColor() });
      f.grow = 1; f.flash = 1;
      f.vx = cos * 25; f.vy = sin * 25;
      empires.push(f);
      factions.push(f);
    }
    for (const a of factions) for (const b of factions) {
      if (a === b) continue;
      a.revRivals.add(b.id);
      if (!a.wars.has(b.id)) pairWar(a, b);
    }
  }

  // ----- Random events -----
  // One random event every 100 to 200 seconds (a new countdown after every event). E, R, and T trigger them by hand.
  const PLAGUE_LOSS = [0.1, 0.3], PLAGUE_CONTAGIOUS = 1, PLAGUE_SPREAD = 0.15, PLAGUE_TICK = 0.1;
  const DARK_LOSS = [0.1, 0.5], PAX_LENGTH = 10;
  const banner = document.createElement("div");
  banner.className = "sim-event";
  banner.hidden = true;
  hero.appendChild(banner);
  let bannerTime = 0;
  const announce = text => { banner.textContent = text; banner.hidden = false; bannerTime = 4; };

  // Plague: the empire loses 10% to 30% of its population and is contagious for 1 second.
  // While contagious, every 0.1 seconds each neighbor (overlapping proximity ranges) has a 15% chance to catch it.
  // Over the full second that is a 1 - 0.85^10 = 80% chance per neighbor.
  // An empire can catch each plague only once.
  function infect(e, id) {
    if (e.dead || e.plagued.has(id)) return;
    e.plagued.add(id);
    e.area *= 1 - rand(PLAGUE_LOSS[0], PLAGUE_LOSS[1]);
    e.flash = 1;
    if (!(e.area > MIN_POP)) { kill(e, null); return; }
    e.contagious = PLAGUE_CONTAGIOUS;
    e.plagueTick = PLAGUE_TICK;
    e.plagueId = id;
  }
  function plague(target) {
    const alive = empires.filter(e => !e.dead);
    const e = target && !target.dead ? target : alive[Math.floor(Math.random() * alive.length)];
    if (!e) return;
    announce(`Plague breaks out in ${e.name}`);
    infect(e, nextPlagueId++);
  }

  // Dark Ages: a circle covering half the map's area. Each empire inside loses 10% to 50% of its tech (minimum 1).
  function darkAges(at) {
    const r = Math.sqrt(0.5 * W * H / Math.PI);
    const x = at ? at.x : rand(0, W), y = at ? at.y : rand(0, H);
    darkZone = { x, y, r, t: 1 };
    for (const e of empires) {
      if (e.dead || Math.hypot(e.x - x, e.y - y) > r) continue;
      e.tech = Math.max(1, e.tech * (1 - rand(DARK_LOSS[0], DARK_LOSS[1])));
    }
    announce("The Dark Ages begin");
  }

  // Pax Romana: 10 seconds. All wars end with no result and none can start. No uprisings, puppet revolts,
  // or other events happen, and plagues stop spreading. Population growth is doubled. Alliances can still form.
  function paxRomana() {
    pax = PAX_LENGTH;
    for (const e of empires) {
      e.contagious = 0;
      for (const id of [...e.wars]) { const o = byId(id); if (o) endWar(e, o, false); else e.wars.delete(id); }
    }
  }

  function triggerEvent(type, opts = {}) {
    if (pax > 0 && type !== "pax") return;  // no other events during Pax Romana
    eventTimer = rand(100, 200);
    if (type === "plague") plague(opts.target);
    else if (type === "dark") darkAges(opts.at);
    else paxRomana();
  }

  // One hit of a war: a dice roll decides the winner, weighted by strength (tech^2.2 x radius).
  // The more stable side gets +5% strength per point of stability difference.
  // War attrition lowers strength by 0.5% per point.
  // The loser takes 75% of the losses and the winner 25%. The winner captures 10% of the loser's losses,
  // so the winner still ends each hit with a net loss of 17.5% of the base loss.
  // (nx, ny) points from a to b; both empires are pushed apart afterward.
  function battle(a, b, nx, ny) {
    const diff = a.stability - b.stability;
    const sa = Math.pow(a.tech, 2.2) * radius(a) * (1 + STAB_BONUS * Math.max(0, diff)) * (1 - 0.005 * a.attrition);
    const sb = Math.pow(b.tech, 2.2) * radius(b) * (1 + STAB_BONUS * Math.max(0, -diff)) * (1 - 0.005 * b.attrition);
    const aWins = Math.random() < sa / (sa + sb);
    const winner = aWins ? a : b, loser = aWins ? b : a;
    // Attrition: scaled by the square root of (enemy strength / own strength), limited to 0.5x to 2x.
    const sw = aWins ? sa : sb, sl = aWins ? sb : sa;
    const scale = r => Math.min(2, Math.max(0.5, Math.sqrt(r)));
    winner.attrition = Math.min(100, winner.attrition + ATTRITION_WIN * scale(sl / sw));
    loser.attrition = Math.min(100, loser.attrition + ATTRITION_LOSS * scale(sw / sl));
    // Bounce apart. The lighter empire is pushed harder.
    const ma = Math.max(1, a.area), mb = Math.max(1, b.area);
    a.vx -= nx * BATTLE_KICK * mb / (ma + mb); a.vy -= ny * BATTLE_KICK * mb / (ma + mb);
    b.vx += nx * BATTLE_KICK * ma / (ma + mb); b.vy += ny * BATTLE_KICK * ma / (ma + mb);
    const base = 160 + 0.3 * Math.min(a.area, b.area);
    const loserLoss = base * 0.75, winnerLoss = base * 0.25;
    loser.area -= loserLoss;
    winner.area += loserLoss * 0.1 - winnerLoss;
    loser.warNet.set(winner.id, (loser.warNet.get(winner.id) ?? 0) - loserLoss);
    winner.warNet.set(loser.id, (winner.warNet.get(loser.id) ?? 0) + loserLoss * 0.1 - winnerLoss);
    loser.flash = 1;
    if (!(a.area > MIN_POP)) kill(a, b);
    if (!(b.area > MIN_POP)) kill(b, a);
    if (!loser.dead && !winner.dead && power(winner) >= PUPPET_RATIO * power(loser) && Math.random() < PUPPET_CHANCE) {
      makePuppet(loser, root(winner), winner);
    }
    if (!a.dead && !b.dead && a.wars.has(b.id) && Math.random() < BATTLE_PEACE) endWar(a, b);
  }

  function update(dt) {
    clock += dt;
    if (pax > 0) {
      pax = Math.max(0, pax - dt);
      announce(pax > 0 ? `Pax Romana: ${Math.ceil(pax)} s left` : "Pax Romana ends");
    } else {
      eventTimer -= dt;
      if (eventTimer <= 0) triggerEvent(["plague", "dark", "pax"][Math.floor(Math.random() * 3)]);
    }
    bannerTime -= dt;
    if (bannerTime <= 0) banner.hidden = true;
    if (darkZone) { darkZone.t -= dt / 4; if (darkZone.t <= 0) darkZone = null; }
    for (const e of empires) {
      if (e.dead || e.contagious <= 0) continue;
      e.contagious -= dt;
      e.plagueTick -= dt;
      while (e.plagueTick <= 0) {
        e.plagueTick += PLAGUE_TICK;
        for (const o of empires) {
          if (o === e || o.dead || o.plagued.has(e.plagueId)) continue;
          if (Math.hypot(o.x - e.x, o.y - e.y) < proximity(e) + proximity(o) && Math.random() < PLAGUE_SPREAD) infect(o, e.plagueId);
        }
      }
    }
    const alive = empires.filter(e => !e.dead);
    spawnTimer += dt;
    if (alive.length < MAX && spawnTimer > 1.1) { spawnTimer = 0; spawn(); }

    // Alliance cohesion: a step of 5 every 1 to 5 seconds.
    // The weight of stepping down doubles with each member past 2. Up has weight 1.
    // 2 members: 1 to 1 (50% down). 3 members: 2 to 1 (67%). 4 members: 4 to 1 (80%). 5 members: 8 to 1 (89%).
    for (const al of alliances) {
      al.timer -= dt;
      if (al.timer > 0) continue;
      al.timer = rand(1, 5);
      const w = Math.pow(2, al.members.size - 2), down = w / (w + 1);
      al.cohesion = Math.max(0, Math.min(100, al.cohesion + (Math.random() < down ? -5 : 5)));
    }

    // Pick the great powers, then grow or shrink each sphere toward its target size.
    greatPowers = new Set(alive.filter(e => power(e) >= GP_MIN)
      .sort((a, b) => power(b) - power(a)).slice(0, GP_COUNT).map(e => e.id));
    for (const e of empires) {
      const target = !e.dead && greatPowers.has(e.id) ? sphereTarget(e) : 0;
      e.sphere += (target - e.sphere) * Math.min(1, dt * 3);
    }

    // Coalition. With 5 great powers: if one great power (not a puppet) plus its puppets has more than double
    // the average power of the other great powers, there is a 5% chance per second that those great powers
    // form a temporary alliance and all go to war with it. Great powers on the strong empire's side are not counted.
    const gps = [...greatPowers].map(byId).filter(e => e && !e.dead);
    if (coalition) {
      const g = byId(coalition.target);
      for (const id of [...coalition.members]) { const m = byId(id); if (!m || m.dead) coalition.members.delete(id); }
      // The coalition ends early once its target is no longer the strongest great power.
      const notStrongest = !g || g.dead || !greatPowers.has(g.id) ||
        gps.some(o => o !== g && o.master !== g.id && blocPower(o) > blocPower(g));
      const gSide = g && !g.dead ? membersOf(g) : [];
      const fighting = gSide.some(x => [...x.wars].some(id => { const o = byId(id); return o && !o.dead && inCoalition(o); }));
      if (notStrongest || !fighting || !coalition.members.size) {
        if (notStrongest && g && !g.dead) {
          // End the coalition's wars with the former target. These are scored like any other peace.
          for (const x of gSide) for (const id of [...x.wars]) {
            const o = byId(id);
            if (o && !o.dead && inCoalition(o)) endWar(x, o);
          }
        }
        announce(`The coalition against ${g ? g.name : "a fallen empire"} ends`);
        coalition = null;
      }
    } else if (pax <= 0 && gps.length === GP_COUNT) {
      const g = gps.filter(e => e.master === null).sort((a, b) => blocPower(b) - blocPower(a))[0];
      const rest = g ? gps.filter(o => o !== g && sideKey(o) !== sideKey(g)) : [];
      if (rest.length) {
        const avg = rest.reduce((sum, o) => sum + power(o), 0) / rest.length;
        if (blocPower(g) > 2 * avg && Math.random() < dt * 0.05) {
          coalition = { target: g.id, members: new Set(rest.map(o => o.id)) };
          announce(`Coalition forms against ${g.name}`);
          for (const m of rest) if (canStartWar(m)) startWar(m, g);
        }
      }
    }

    for (const e of empires) {
      e.flash = Math.max(0, e.flash - dt * 3);
      if (e.dead) { e.fade -= dt * 1.8; continue; }
      e.grow = Math.min(1, e.grow + dt * 2);
      e.tech += dt * empireResearch(e);
      e.area += dt * empirePopulation(e);
      if (!e.wars.size) e.attrition = Math.max(0, e.attrition - dt * ATTRITION_DECAY);
      e.stabTimer -= dt;
      if (e.stabTimer <= 0) {
        // At peace, a step toward 0 gets 20% more weight per point of stability away from 0.
        // Example: at -5 the weights are 2 (up) to 1 (down), so 67% up. At war, or at 0, it is 50/50.
        const pull = e.wars.size ? 1 : 1 + 0.2 * Math.abs(e.stability);
        const towardZero = Math.random() < pull / (pull + 1);
        const dir = e.stability === 0 ? (Math.random() < 0.5 ? -1 : 1) : -Math.sign(e.stability) * (towardZero ? 1 : -1);
        e.stability = clampStab(e.stability + dir);
        e.stabTimer = rand(1, 15);
      }

      e.heading += (Math.random() - 0.5) * 2.5 * dt;
      e.vx += Math.cos(e.heading) * 10 * dt;
      e.vy += Math.sin(e.heading) * 10 * dt;
      for (const id of [...e.wars]) {
        const o = byId(id);
        if (!o || o.dead) { e.wars.delete(id); continue; }
        // Peace: each war has a 15% chance per second to end (rolled once per pair, by the empire with the lower id).
        if (e.id < o.id && Math.random() < dt * PEACE_RATE) { endWar(e, o); continue; }
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

    // Allies never stay at war. If a side change (joining an alliance, becoming a puppet) put two enemies on the
    // same side, their war ends with no result.
    for (const e of empires) {
      if (e.dead) continue;
      for (const id of [...e.wars]) { const o = byId(id); if (o && !o.dead && allied(e, o)) endWar(e, o, false); }
    }

    // Puppets: tech follows the master. Revolt chance doubles with each extra puppet the master has.
    // A puppet with at least half its master's power revolts right away.
    const puppetCount = new Map();
    for (const e of empires) if (!e.dead && e.master !== null) puppetCount.set(e.master, (puppetCount.get(e.master) || 0) + 1);
    for (const e of empires) {
      if (e.dead || e.master === null) continue;
      const m = byId(e.master);
      if (!m || m.dead) { e.master = null; continue; }
      e.tech = m.tech;
      const rate = PUPPET_REVOLT_RATE * Math.pow(2, (puppetCount.get(m.id) || 1) - 1);
      if (pax <= 0 && (power(e) >= PUPPET_REVOLT_RATIO * power(m) || Math.random() < dt * rate)) {
        if (m.attrition >= ATTRITION_LOCK) e.master = null;  // the master is too worn out to fight: free right away
        else if (canStartWar(e)) {
          e.master = null;
          e.revoltFrom = m.id;
          startWar(e, m);
        }
      }
    }

    // Uprisings: chance per second grows linearly as stability falls below 0.
    for (const e of alive) {
      if (pax > 0 || e.dead || e.stability >= 0) continue;
      if (Math.random() < dt * REBEL_RATE * (-e.stability) / 5) {
        if (Math.random() < REVOLUTION_CHANCE) revolution(e); else rebellion(e);
      }
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
          if (Math.random() < 0.45 && (canStartWar(a) || canStartWar(b))) startWar(a, b);
        }
      } else if (clock - (a.lastHit.get(b.id) ?? -99) > 0.35) {
        a.lastHit.set(b.id, clock);
        battle(a, b, nx, ny);
      }
    }
    // Spheres of influence: when two spheres start touching, there is a high chance of war.
    // The roll happens once per contact. The spheres must separate before another roll.
    for (let i = 0; i < empires.length; i++) for (let j = i + 1; j < empires.length; j++) {
      const a = empires[i], b = empires[j];
      if (a.dead || b.dead) continue;
      const touching = greatPowers.has(a.id) && greatPowers.has(b.id) &&
        Math.hypot(b.x - a.x, b.y - a.y) < a.sphere + b.sphere;
      if (!touching) { a.touching.delete(b.id); continue; }
      if (a.touching.has(b.id)) continue;
      a.touching.add(b.id);
      if (!a.wars.has(b.id) && Math.random() < SPHERE_WAR_CHANCE && (canStartWar(a) || canStartWar(b))) startWar(a, b);
    }
    // Alliances: empires whose proximity ranges overlap may ally. Allies whose ranges separate are pulled back together.
    for (let i = 0; i < empires.length; i++) for (let j = i + 1; j < empires.length; j++) {
      const a = empires[i], b = empires[j];
      if (a.dead || b.dead) continue;
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
      const inRange = d < proximity(a) + proximity(b);
      if (allied(a, b)) {
        if (!inRange) {
          a.vx += dx / d * ALLY_PULL * dt; a.vy += dy / d * ALLY_PULL * dt;
          b.vx -= dx / d * ALLY_PULL * dt; b.vy -= dy / d * ALLY_PULL * dt;
        }
      } else if (inRange && !a.wars.has(b.id)) {
        // Joining an existing alliance of n members is half as likely for each member: 1/4 for 2 members, 1/8 for 3, and so on.
        const n = Math.max(a.alliance ? a.alliance.members.size : 1, b.alliance ? b.alliance.members.size : 1);
        if (Math.random() < dt * ALLY_RATE * Math.pow(0.5, n === 1 ? 0 : n)) tryAlly(a, b);
      }
    }
    for (const al of alliances) {
      for (const id of [...al.members]) { const m = byId(id); if (!m || m.dead) al.members.delete(id); }
      if (al.cohesion >= 100) unify(al);
      else if (al.cohesion <= 0 || al.members.size < 2) dissolve(al);
    }
    alliances = alliances.filter(al => al.members.size >= 2);
    empires = empires.filter(e => !e.dead || e.fade > 0);
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(techImg, 0, 0, W, H);
    ctx.drawImage(popImg, 0, 0, W, H);

    // Spheres of influence
    for (const e of empires) {
      if (e.sphere <= 1) continue;
      const a = e.dead ? Math.max(0, e.fade) : 1;
      ctx.fillStyle = colorOf(e);
      ctx.globalAlpha = 0.1 * a;
      ctx.beginPath(); ctx.arc(e.x, e.y, e.sphere, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 0.3 * a;
      ctx.lineWidth = 1; ctx.strokeStyle = colorOf(e);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Dark Ages circle, fading out over 4 seconds
    if (darkZone) {
      ctx.globalAlpha = 0.28 * darkZone.t;
      ctx.fillStyle = "#0b1016";
      ctx.beginPath(); ctx.arc(darkZone.x, darkZone.y, darkZone.r, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
    }

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
      ctx.fillStyle = colorOf(e);
      ctx.beginPath(); ctx.arc(e.x, e.y, r, 0, Math.PI * 2); ctx.fill();
      if (e.wars.size) {
        ctx.lineWidth = 2; ctx.strokeStyle = `rgb(${ROSE.join(",")})`;
        ctx.stroke();
      }
      // Alliance ring, just inside the circle's edge.
      const al = allianceOf(e);
      if (al && !e.dead && r > 6) {
        ctx.globalAlpha = 1; ctx.lineWidth = 2.5; ctx.strokeStyle = al.color;
        ctx.beginPath(); ctx.arc(e.x, e.y, r - 2.5, 0, Math.PI * 2); ctx.stroke();
      }
      if (e.flash > 0) {
        ctx.globalAlpha = e.flash * 0.8;
        ctx.lineWidth = 2; ctx.strokeStyle = `rgb(${ROSE.join(",")})`;
        ctx.beginPath(); ctx.arc(e.x, e.y, r + 3 + (1 - e.flash) * 8, 0, Math.PI * 2); ctx.stroke();
      }
      // Contagious with plague: a dashed sickly green ring.
      if (e.contagious > 0 && !e.dead) {
        ctx.save();
        ctx.globalAlpha = 0.9; ctx.lineWidth = 2; ctx.strokeStyle = "#8a9a1f"; ctx.setLineDash([3, 4]);
        ctx.beginPath(); ctx.arc(e.x, e.y, r + 5, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
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
        const inside = size >= 10;
        const allySize = inside ? Math.max(9, size * 0.62) : 9.5;
        // With an alliance, the empire name moves down slightly to make room for the alliance name above it.
        const nameSize = inside ? size : 11;
        const nameY = inside ? e.y + 1 + (al ? allySize * 0.5 : 0) : e.y + r + 10;
        if (inside) {
          ctx.font = `700 ${size}px Archivo, system-ui, sans-serif`;
          ctx.fillStyle = "#ffffff";
        } else {
          ctx.font = "600 11px Archivo, system-ui, sans-serif";
          ctx.fillStyle = INK;
        }
        ctx.fillText(e.name, e.x, nameY);
        if (al) {
          const y = nameY - nameSize * 0.55 - allySize * 0.6;
          ctx.font = `700 ${allySize}px Archivo, system-ui, sans-serif`;
          ctx.lineJoin = "round"; ctx.lineWidth = 3.5; ctx.strokeStyle = "rgba(0, 0, 0, 0.75)";
          ctx.strokeText(al.name, e.x, y);
          ctx.fillStyle = al.color;
          ctx.fillText(al.name, e.x, y);
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
  const UI = "a, button, .lb, .speed, .how-panel, .sim-note";

  // "How it works" panel: opened by the button next to the sim note, closed by its X button or Escape.
  const howBtn = hero.querySelector(".how-btn"), howPanel = hero.querySelector(".how-panel");
  if (howBtn && howPanel) {
    const setHow = open => {
      howPanel.hidden = !open;
      howBtn.setAttribute("aria-expanded", String(open));
    };
    howBtn.addEventListener("click", () => setHow(howPanel.hidden));
    howPanel.querySelector(".how-close")?.addEventListener("click", () => { setHow(false); howBtn.focus(); });
    window.addEventListener("keydown", e => { if (e.key === "Escape" && !howPanel.hidden) { setHow(false); howBtn.focus(); } });
  }
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
      html += `<strong>${hovered.name}</strong><br>Population: ${Math.round(hovered.area).toLocaleString()}<br>Tech level: ${hovered.tech.toFixed(2)}<br>Stability: ${fmtStab(hovered.stability)}` +
        `<br>War attrition: ${Math.round(hovered.attrition)} (−${Math.round(hovered.attrition * 0.5)}% strength)` +
        `<br><span class="bar${hovered.attrition >= ATTRITION_LOCK ? " high" : ""}"><span style="width:${hovered.attrition.toFixed(1)}%"></span></span>`;
      if (hovered.attrition >= ATTRITION_LOCK) html += "<br>Too worn out to start wars";
      if (greatPowers.has(hovered.id)) html += "<br>Great power";
      const hal = allianceOf(hovered);
      if (hovered.master !== null) html += `<br>Puppet of ${root(hovered).name}`;
      if (hovered.contagious > 0) html += "<br>Plague: contagious";
      if (coalition && coalition.target === hovered.id) html += "<br>Target of a coalition";
      else if (coalition && inCoalition(hovered)) html += `<br>In the coalition against ${byId(coalition.target)?.name}`;
      const puppets = empires.filter(x => !x.dead && x.master === hovered.id).length;
      if (puppets) html += `<br>Puppets: ${puppets}`;
      if (hal) html += `<br>Alliance: <strong class="ally" style="color:${hal.color}">${hal.name}</strong>` +
        ` (${hal.members.size} members, cohesion ${Math.round(hal.cohesion)})`;
      if (hovered.wars.size) html += `<br>At war with ${[...hovered.wars].map(id => byId(id)?.name).filter(Boolean).join(", ")}`;
    }
    if (holding) {
      // Over an empire: its actual rates. On open map: the base rates at that spot.
      // A puppet's tech copies its master, so its research gain is the master's.
      const research = hovered ? empireResearch(root(hovered)) : researchGain(x, y);
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

  const COLS = [["name", "Empire"], ["pop", "Population"], ["tech", "Tech"], ["stab", "Stability"], ["power", "Power"]];
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
    const rows = empires.filter(e => !e.dead).map(e => ({ e, name: e.name, pop: e.area, tech: e.tech, stab: e.stability, power: power(e) }));
    rows.sort((a, b) => sortKey === "name" ? sortDir * a.name.localeCompare(b.name) : sortDir * (a[sortKey] - b[sortKey]));
    const mark = k => k === sortKey ? (sortDir < 0 ? " ▼" : " ▲") : "";
    lb.innerHTML =
      `<table><thead><tr><th>#</th>${COLS.map(([k, label]) =>
        `<th><button type="button" data-key="${k}">${label}${mark(k)}</button></th>`).join("")}</tr></thead><tbody>` +
      rows.map((r, i) =>
        `<tr${r.e === hovered ? ' class="hl"' : ""}><td>${i + 1}</td>` +
        `<td><span class="lb-dot" style="background:${colorOf(r.e)}"></span>${r.name}` +
        `${greatPowers.has(r.e.id) ? ' <span class="lb-gp">great power</span>' : ""}` +
        `${r.e.master !== null ? ' <span class="lb-gp">puppet</span>' : ""}` +
        `${coalition && coalition.target === r.e.id ? ' <span class="lb-war">coalition target</span>' : coalition && inCoalition(r.e) ? ' <span class="lb-gp">coalition</span>' : ""}` +
        `${allianceOf(r.e) ? ` <span class="lb-ally" style="color:${allianceOf(r.e).color}">${allianceOf(r.e).name}</span>` : ""}` +
        `${r.e.wars.size ? ' <span class="lb-war">at war</span>' : ""}</td>` +
        `<td>${Math.round(r.pop).toLocaleString()}</td><td>${r.tech.toFixed(2)}</td><td>${fmtStab(r.stab)}</td>` +
        `<td>${Math.round(r.power).toLocaleString()}</td></tr>`).join("") +
      "</tbody></table>";
  }

  // Debug keys:
  // Q (hovering over an empire) combines its alliance into one empire right away.
  // W (hovering over an empire) forces an uprising (80% rebellion, 20% revolution).
  // E starts a plague in the hovered empire, or a random one.
  // R starts the Dark Ages centered on the cursor, or a random spot.
  // T starts Pax Romana.
  // During Pax Romana only T works. Keys pressed with Ctrl, Cmd, or Alt are ignored so browser shortcuts are not affected.
  const pointerPos = () => {
    if (!pointer) return null;
    const rect = hero.getBoundingClientRect();
    return { x: pointer.cx - rect.left, y: pointer.cy - rect.top };
  };
  window.addEventListener("keydown", e => {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target.closest("input, textarea, [contenteditable]")) return;
    const key = e.key.toLowerCase();
    if (key === "e" || key === "r" || key === "t") {
      e.preventDefault();
      if (key === "e") triggerEvent("plague", { target: hovered });
      else if (key === "r") triggerEvent("dark", { at: pointerPos() });
      else triggerEvent("pax");
      return;
    }
    if (!hovered || hovered.dead || pax > 0) return;
    if (key === "q" && allianceOf(hovered)) {
      e.preventDefault();
      unify(allianceOf(hovered));
      alliances = alliances.filter(al => al.members.size >= 2);
    } else if (key === "w") {
      e.preventDefault();
      if (Math.random() < REVOLUTION_CHANCE) revolution(hovered); else rebellion(hovered);
    }
  });

  // Arrow at the bottom center of the simulation that hides or shows the name, description, and links.
  const heroText = hero.querySelector(".hero-text");
  const textBtn = document.createElement("button");
  textBtn.type = "button";
  textBtn.className = "text-toggle";
  textBtn.setAttribute("aria-expanded", "true");
  textBtn.setAttribute("aria-label", "Hide intro text");
  textBtn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M5 9l7 7 7-7" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  hero.appendChild(textBtn);
  textBtn.addEventListener("click", () => {
    const hide = !hero.classList.contains("text-hidden");
    hero.classList.toggle("text-hidden", hide);
    if (heroText) heroText.inert = hide;  // hidden links cannot be focused or clicked
    textBtn.setAttribute("aria-expanded", String(!hide));
    textBtn.setAttribute("aria-label", hide ? "Show intro text" : "Hide intro text");
  });

  // Time speed control at the top center.
  const SPEEDS = [1, 2, 3, 5, 10];
  let speed = 1;
  const speedBar = document.createElement("div");
  speedBar.className = "speed";
  speedBar.setAttribute("role", "group");
  speedBar.setAttribute("aria-label", "Simulation speed");
  speedBar.innerHTML = SPEEDS.map(v =>
    `<button type="button" data-speed="${v}" aria-pressed="${v === speed}">${v}x</button>`).join("");
  hero.appendChild(speedBar);
  speedBar.addEventListener("click", e => {
    const b = e.target.closest("[data-speed]");
    if (!b) return;
    speed = Number(b.dataset.speed);
    for (const x of speedBar.children) x.setAttribute("aria-pressed", String(x === b));
  });

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
      // Faster speeds run more simulation steps per frame. Each step is at most 1/60 s so the physics stays stable.
      const simTime = dt * speed, steps = Math.ceil(simTime / (1 / 60));
      for (let i = 0; i < steps; i++) update(simTime / steps);
      updateTip(); draw();
      lbTimer += dt;
      if (!lb.hidden && lbTimer > 0.5) { lbTimer = 0; renderLeaderboard(); }
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
})();