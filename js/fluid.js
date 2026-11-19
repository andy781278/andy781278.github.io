// Page background: 2D incompressible fluid (Jos Stam's "Stable Fluids") with vorticity confinement.
// Moving the pointer pushes the fluid and injects dye; the dye is advected by the velocity field.
(() => {
  const canvas = document.getElementById("fluid");
  const ctx = canvas.getContext("2d");
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce) return;

  const css = getComputedStyle(document.documentElement);
  const hex = name => {
    const h = css.getPropertyValue(name).trim().replace("#", "");
    return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
  };
  const palette = [hex("--teal"), hex("--gold"), hex("--rose")];

  const DT = 1.0;          // time step in frames
  const VORTICITY = 0.6;  // strength of vorticity confinement (swirl)
  const VEL_DECAY = 0.995;
  const DYE_DECAY = 0.991;
  const ITER = 16;         // Gauss-Seidel iterations for the pressure solve

  let N, M, W2, cell, u, v, u0, v0, p, div, curl, dye, dye0, off, octx, img;

  function alloc() {
    const W = window.innerWidth, H = window.innerHeight;
    const dpr = 1;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    N = Math.max(64, Math.min(180, Math.round(W / 8)));
    M = Math.max(36, Math.round(N * H / W));
    W2 = N + 2;
    cell = W / N;
    const size = W2 * (M + 2);
    const f = () => new Float32Array(size);
    u = f(); v = f(); u0 = f(); v0 = f(); p = f(); div = f(); curl = f();
    dye = [f(), f(), f()];
    dye0 = [f(), f(), f()];
    off = document.createElement("canvas");
    off.width = N; off.height = M;
    octx = off.getContext("2d");
    img = octx.createImageData(N, M);
  }

  const IX = (i, j) => i + W2 * j;

  function setBnd(b, x) {
    for (let i = 1; i <= N; i++) {
      x[IX(i, 0)] = b === 2 ? -x[IX(i, 1)] : x[IX(i, 1)];
      x[IX(i, M + 1)] = b === 2 ? -x[IX(i, M)] : x[IX(i, M)];
    }
    for (let j = 1; j <= M; j++) {
      x[IX(0, j)] = b === 1 ? -x[IX(1, j)] : x[IX(1, j)];
      x[IX(N + 1, j)] = b === 1 ? -x[IX(N, j)] : x[IX(N, j)];
    }
    x[IX(0, 0)] = 0.5 * (x[IX(1, 0)] + x[IX(0, 1)]);
    x[IX(0, M + 1)] = 0.5 * (x[IX(1, M + 1)] + x[IX(0, M)]);
    x[IX(N + 1, 0)] = 0.5 * (x[IX(N, 0)] + x[IX(N + 1, 1)]);
    x[IX(N + 1, M + 1)] = 0.5 * (x[IX(N, M + 1)] + x[IX(N + 1, M)]);
  }

  // Make the velocity field divergence-free (incompressible).
  function project() {
    for (let j = 1; j <= M; j++) for (let i = 1; i <= N; i++) {
      const k = IX(i, j);
      div[k] = -0.5 * (u[k + 1] - u[k - 1] + v[k + W2] - v[k - W2]);
      p[k] = 0;
    }
    setBnd(0, div); setBnd(0, p);
    for (let it = 0; it < ITER; it++) {
      for (let j = 1; j <= M; j++) for (let i = 1; i <= N; i++) {
        const k = IX(i, j);
        p[k] = (div[k] + p[k - 1] + p[k + 1] + p[k - W2] + p[k + W2]) * 0.25;
      }
      setBnd(0, p);
    }
    for (let j = 1; j <= M; j++) for (let i = 1; i <= N; i++) {
      const k = IX(i, j);
      u[k] -= 0.5 * (p[k + 1] - p[k - 1]);
      v[k] -= 0.5 * (p[k + W2] - p[k - W2]);
    }
    setBnd(1, u); setBnd(2, v);
  }

  // Semi-Lagrangian advection: trace each cell backward along the velocity and sample.
  function advect(b, d, d0, uu, vv) {
    for (let j = 1; j <= M; j++) for (let i = 1; i <= N; i++) {
      const k = IX(i, j);
      let x = i - DT * uu[k], y = j - DT * vv[k];
      if (x < 0.5) x = 0.5; else if (x > N + 0.5) x = N + 0.5;
      if (y < 0.5) y = 0.5; else if (y > M + 0.5) y = M + 0.5;
      const i0 = x | 0, j0 = y | 0, s1 = x - i0, t1 = y - j0, s0 = 1 - s1, t0 = 1 - t1;
      const a = IX(i0, j0);
      d[k] = s0 * (t0 * d0[a] + t1 * d0[a + W2]) + s1 * (t0 * d0[a + 1] + t1 * d0[a + 1 + W2]);
    }
    setBnd(b, d);
  }

  // Vorticity confinement: re-adds small-scale swirl that the solver smooths away.
  function confine() {
    for (let j = 1; j <= M; j++) for (let i = 1; i <= N; i++) {
      const k = IX(i, j);
      curl[k] = 0.5 * ((v[k + 1] - v[k - 1]) - (u[k + W2] - u[k - W2]));
    }
    for (let j = 2; j < M; j++) for (let i = 2; i < N; i++) {
      const k = IX(i, j);
      const gx = 0.5 * (Math.abs(curl[k + 1]) - Math.abs(curl[k - 1]));
      const gy = 0.5 * (Math.abs(curl[k + W2]) - Math.abs(curl[k - W2]));
      const len = Math.hypot(gx, gy) + 1e-5;
      const w = curl[k];
      u[k] += VORTICITY * (gy / len) * w * DT;
      v[k] -= VORTICITY * (gx / len) * w * DT;
    }
  }

  // Push the fluid and add dye around a point (pixel coordinates, pixel velocity).
  function splat(px, py, dx, dy, color, amount) {
    const ci = px / cell + 1, cj = py / cell + 1;
    const R = Math.max(2, N / 64);
    const reach = Math.ceil(R * 2.5);
    const fx = dx / cell, fy = dy / cell;
    for (let j = Math.max(1, (cj - reach) | 0); j <= Math.min(M, (cj + reach) | 0); j++) {
      for (let i = Math.max(1, (ci - reach) | 0); i <= Math.min(N, (ci + reach) | 0); i++) {
        const d2 = (i - ci) ** 2 + (j - cj) ** 2;
        const w = Math.exp(-d2 / (R * R));
        if (w < 0.01) continue;
        const k = IX(i, j);
        u[k] += fx * w * 0.5;
        v[k] += fy * w * 0.5;
        dye[color][k] = Math.min(1.5, dye[color][k] + amount * w);
      }
    }
  }

  function step() {
    confine();
    project();
    u0.set(u); v0.set(v);
    advect(1, u, u0, u0, v0);
    advect(2, v, v0, u0, v0);
    project();
    for (let c = 0; c < 3; c++) {
      dye0[c].set(dye[c]);
      advect(0, dye[c], dye0[c], u, v);
    }
    for (let k = 0; k < u.length; k++) {
      u[k] *= VEL_DECAY; v[k] *= VEL_DECAY;
      dye[0][k] *= DYE_DECAY; dye[1][k] *= DYE_DECAY; dye[2][k] *= DYE_DECAY;
    }
  }

  function render() {
    const data = img.data;
    let o = 0;
    for (let j = 1; j <= M; j++) for (let i = 1; i <= N; i++) {
      const k = IX(i, j);
      const a = dye[0][k], b = dye[1][k], c = dye[2][k];
      const sum = a + b + c;
      if (sum < 0.004) { data[o + 3] = 0; o += 4; continue; }
      const col = a >= b && a >= c ? palette[0] : (b >= c ? palette[1] : palette[2]);
      data[o] = col[0]; data[o + 1] = col[1]; data[o + 2] = col[2];
      data[o + 3] = Math.min(1, sum * 1.4) * 70;
      o += 4;
    }
    octx.putImageData(img, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(off, 0, 0, canvas.width, canvas.height);
  }

  // Pointer input
  let last = null, lastMove = -1e9, colorIndex = 0, colorDist = 0;
  window.addEventListener("pointermove", e => {
    const x = e.clientX, y = e.clientY;
    if (last) {
      const dx = x - last.x, dy = y - last.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 0) {
        colorDist += dist;
        if (colorDist > 420) { colorDist = 0; colorIndex = (colorIndex + 1) % 3; }
        const steps = Math.min(8, Math.ceil(dist / (cell * 2)));
        for (let s = 1; s <= steps; s++) {
          const t = s / steps;
          splat(last.x + dx * t, last.y + dy * t, dx / steps, dy / steps, colorIndex, 0.35 / steps + 0.06);
        }
      }
    }
    last = { x, y };
    lastMove = performance.now();
  });
  document.addEventListener("pointerleave", () => { last = null; });

  // When nobody is moving the pointer, a slow stirrer keeps the fluid alive.
  let t = 0, prevStir = null;
  function idleStir(now) {
    if (now - lastMove < 2500) { prevStir = null; return; }
    t += 0.008;
    const W = window.innerWidth, H = window.innerHeight;
    const x = W * (0.5 + 0.38 * Math.sin(t * 1.3));
    const y = H * (0.32 + 0.22 * Math.sin(t * 2.1 + 1.0));
    if (prevStir) splat(x, y, x - prevStir.x, y - prevStir.y, Math.floor(t / 2.2) % 3, 0.05);
    prevStir = { x, y };
  }


  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(alloc, 200);
  });

  alloc();
  function loop(now) {
    idleStir(now); step(); render();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
})();