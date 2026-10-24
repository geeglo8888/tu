/* ================================================================
   solver.js — 猫咪数独：网格分析 + 分批约束传播标注

   规则：
     1. 每行每列只能有一只猫
     2. 每种颜色只能有一只猫
     3. 猫不能相邻（含对角线，8 向）

   接口：
     catSolver.analyze(boardDataUrl, {N})
       → Promise<{
           N, clusters, colorG, isCat, isX,
           batches, finalCat, solved, contradiction
         }>
================================================================ */
(function (global) {
  'use strict';

  const catSolver = {};

  /* ---------- 工具 ---------- */
  function loadImage(dataUrl) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error('图片加载失败'));
      img.src = dataUrl;
    });
  }
  const rgbDist = (a, b) => Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
  const mk2 = N => Array.from({ length: N }, () => new Array(N).fill(false));

  /* ---------- 网格大小检测：浅色格线投影 ---------- */
  const isLight = (r, g, b) => r > 200 && g > 200 && b > 200 && (Math.max(r, g, b) - Math.min(r, g, b)) < 40;

  function detectN(data, W, H) {
    const rowLight = new Float32Array(H), colLight = new Float32Array(W);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        if (isLight(data[i], data[i + 1], data[i + 2])) { rowLight[y]++; colLight[x]++; }
      }
    for (let y = 0; y < H; y++) rowLight[y] /= W;
    for (let x = 0; x < W; x++) colLight[x] /= W;
    const minR = Math.max(4, H * 0.03), minC = Math.max(4, W * 0.03);
    const nr = countBands(rowLight, 0.5, minR);
    const nc = countBands(colLight, 0.5, minC);
    return (nr >= 4 && nr <= 10 && nr === nc) ? nr : null;
  }

  /** 统计「值 < thr 的连续带」数量 */
  function countBands(frac, thr, minLen) {
    let count = 0, run = 0;
    for (let i = 0; i < frac.length; i++) {
      if (frac[i] < thr) run++;
      else { if (run >= minLen) count++; run = 0; }
    }
    if (run >= minLen) count++;
    return count;
  }

  /* ---------- 单格分析：内部统计 + 边框取色 ---------- */
  function analyzeCell(data, W, H, x0, y0, x1, y1) {
    const w = x1 - x0, h = y1 - y0;
    const ix0 = Math.round(x0 + w * 0.18), ix1 = Math.round(x1 - w * 0.18);
    const iy0 = Math.round(y0 + h * 0.18), iy1 = Math.round(y1 - h * 0.18);
    let dark = 0, white = 0, total = 0;
    for (let y = iy0; y < iy1; y++)
      for (let x = ix0; x < ix1; x++) {
        const i = (y * W + x) * 4, r = data[i], g = data[i + 1], b = data[i + 2];
        total++;
        if (0.299 * r + 0.587 * g + 0.114 * b < 90) dark++;      // 猫头是深色的
        if (r > 215 && g > 215 && b > 215) white++;               // ✕ 是白色笔画
      }
    // 边框环取色（避开猫脸/✕，拿到格子底色）
    const counts = new Map();
    const fx0 = Math.round(x0 + 3), fy0 = Math.round(y0 + 3);
    const fx1 = Math.round(x1 - 3), fy1 = Math.round(y1 - 3);
    const bx0 = Math.round(x0 + w * 0.14), bx1 = Math.round(x1 - w * 0.14);
    const by0 = Math.round(y0 + h * 0.14), by1 = Math.round(y1 - h * 0.14);
    for (let y = fy0; y < fy1; y++)
      for (let x = fx0; x < fx1; x++) {
        if (x >= bx0 && x < bx1 && y >= by0 && y < by1) continue;
        const i = (y * W + x) * 4, r = data[i], g = data[i + 1], b = data[i + 2];
        const key = (r >> 4) * 256 + (g >> 4) * 16 + (b >> 4);
        let e = counts.get(key);
        if (!e) { e = { n: 0, r: 0, g: 0, b: 0 }; counts.set(key, e); }
        e.n++; e.r += r; e.g += g; e.b += b;
      }
    let mode = null;
    counts.forEach(e => { if (!mode || e.n > mode.n) mode = e; });
    const ring = mode ? { r: mode.r / mode.n, g: mode.g / mode.n, b: mode.b / mode.n }
                      : { r: 200, g: 200, b: 200 };
    return {
      darkFrac: total ? dark / total : 0,
      whiteFrac: total ? white / total : 0,
      ring,
    };
  }

  /* ---------- 颜色聚类（强制收敛到 K 种） ---------- */
  const centroidOf = (colors, g) => {
    let r = 0, gg = 0, b = 0;
    for (const i of g) { r += colors[i].r; gg += colors[i].g; b += colors[i].b; }
    return { r: r / g.length, g: gg / g.length, b: b / g.length };
  };

  function fineCluster(colors, thr) {
    const groups = [];
    for (let i = 0; i < colors.length; i++) {
      let hit = null;
      for (const g of groups)
        if (rgbDist(colors[i], centroidOf(colors, g)) < thr) { hit = g; break; }
      if (hit) hit.push(i); else groups.push([i]);
    }
    return groups;
  }

  function clusterToK(colors, K) {
    const groups = fineCluster(colors, 40);
    // 簇太多 → 合并质心最近的两簇
    while (groups.length > K) {
      let bi = 0, bj = 1, bd = Infinity;
      for (let i = 0; i < groups.length; i++)
        for (let j = i + 1; j < groups.length; j++) {
          const d = rgbDist(centroidOf(colors, groups[i]), centroidOf(colors, groups[j]));
          if (d < bd) { bd = d; bi = i; bj = j; }
        }
      groups[bi] = groups[bi].concat(groups[bj]);
      groups.splice(bj, 1);
    }
    // 簇太少 → 拆分内部散得最开的一簇（2-means）
    while (groups.length < K) {
      let bi = -1, bfar = 0, pa = 0, pb = 0;
      for (let i = 0; i < groups.length; i++) {
        const g = groups[i];
        if (g.length < 2) continue;
        for (let a = 0; a < g.length; a++)
          for (let b = a + 1; b < g.length; b++) {
            const d = rgbDist(colors[g[a]], colors[g[b]]);
            if (d > bfar) { bfar = d; bi = i; pa = g[a]; pb = g[b]; }
          }
      }
      if (bi < 0) break;
      const g1 = [], g2 = [];
      for (const idx of groups[bi])
        (rgbDist(colors[idx], colors[pa]) <= rgbDist(colors[idx], colors[pb]) ? g1 : g2).push(idx);
      if (!g1.length || !g2.length) break;
      groups.splice(bi, 1, g1, g2);
    }
    return groups;
  }

  /* ---------- 单元构造 ---------- */
  function buildUnits(N, colorG, colorNames) {
    const units = [];
    for (let r = 0; r < N; r++)
      units.push({ type: 'row', name: `第${r + 1}行`, cells: Array.from({ length: N }, (_, c) => [r, c]) });
    for (let c = 0; c < N; c++)
      units.push({ type: 'col', name: `第${c + 1}列`, cells: Array.from({ length: N }, (_, r) => [r, c]) });
    for (let k = 0; k < colorNames.length; k++) {
      const cells = [];
      for (let r = 0; r < N; r++)
        for (let c = 0; c < N; c++)
          if (colorG[r][c] === k) cells.push([r, c]);
      if (cells.length) units.push({ type: 'color', name: colorNames[k], cells });
    }
    return units;
  }

  /* ---------- 裁掉四周近白 padding ---------- */
  function trimBounds(data, W, H) {
    const rowLight = new Float32Array(H), colLight = new Float32Array(W);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        if (isLight(data[i], data[i + 1], data[i + 2])) { rowLight[y]++; colLight[x]++; }
      }
    let y0 = 0, y1 = H - 1, x0 = 0, x1 = W - 1;
    while (y0 < y1 && rowLight[y0] >= W * 0.92) y0++;
    while (y1 > y0 && rowLight[y1] >= W * 0.92) y1--;
    while (x0 < x1 && colLight[x0] >= H * 0.92) x0++;
    while (x1 > x0 && colLight[x1] >= H * 0.92) x1--;
    return { x0, y0, x1: x1 + 1, y1: y1 + 1 };
  }

  /* ---------- 分批约束传播 ---------- */
  function propagate(N, colorG, catG0, xG0, colorNames, exactLines) {
    const cat = mk2(N), elim = mk2(N), processed = mk2(N);
    for (let r = 0; r < N; r++)
      for (let c = 0; c < N; c++) { cat[r][c] = catG0[r][c]; elim[r][c] = xG0[r][c]; }

    const units = buildUnits(N, colorG, colorNames);

    const batches = [];
    let contradiction = null;

    while (true) {
      // 1) 展开所有未处理的猫 → 排除标记（同轮去重）
      const E = [];
      const eSeen = new Set();
      const tryElim = (r, c, reason) => {
        if (r < 0 || r >= N || c < 0 || c >= N) return;
        const k = r * N + c;
        if (cat[r][c] || elim[r][c] || eSeen.has(k)) return;
        eSeen.add(k);
        E.push({ r, c, reason });
      };
      for (let r = 0; r < N; r++)
        for (let c = 0; c < N; c++) {
          if (!cat[r][c] || processed[r][c]) continue;
          processed[r][c] = true;
          const tag = `猫(${r + 1},${c + 1})`;
          for (let cc = 0; cc < N; cc++) if (cc !== c) tryElim(r, cc, `与${tag}同行`);
          for (let rr = 0; rr < N; rr++) if (rr !== r) tryElim(rr, c, `与${tag}同列`);
          const k = colorG[r][c];
          for (let rr = 0; rr < N; rr++)
            for (let cc = 0; cc < N; cc++)
              if ((rr !== r || cc !== c) && colorG[rr][cc] === k) tryElim(rr, cc, `与${tag}同色`);
          for (let dr = -1; dr <= 1; dr++)
            for (let dc = -1; dc <= 1; dc++) {
              if (!dr && !dc) continue;
              tryElim(r + dr, c + dc, `与${tag}相邻(含对角)`);
            }
        }
      for (const e of E) elim[e.r][e.c] = true;

      // 2) 唯一位置法：颜色单元始终参与；行/列仅在「颜色数=网格数」时参与
      const P = [];
      for (const u of units) {
        if (!exactLines && u.type !== 'color') continue;
        if (u.cells.some(([r, c]) => cat[r][c])) continue;
        const cands = u.cells.filter(([r, c]) => !cat[r][c] && !elim[r][c]);
        if (cands.length === 0) { if (!contradiction) contradiction = `${u.name}已无可用格，识别可能有误`; }
        else if (cands.length === 1) P.push({ r: cands[0][0], c: cands[0][1], reason: `${u.name}仅剩此格` });
      }

      // 应用前做冲突校验（同批放置互斥：同行/同列/同色/相邻）
      const applied = [];
      for (const p of P) {
        let ok = true;
        for (let i = 0; i < N && ok; i++)
          if (cat[p.r][i] || cat[i][p.c]) ok = false;
        const k = colorG[p.r][p.c];
        for (let rr = 0; rr < N && ok; rr++)
          for (let cc = 0; cc < N && ok; cc++)
            if (colorG[rr][cc] === k && cat[rr][cc]) ok = false;
        for (let dr = -1; dr <= 1 && ok; dr++)
          for (let dc = -1; dc <= 1 && ok; dc++) {
            if (!dr && !dc) continue;
            const rr = p.r + dr, cc = p.c + dc;
            if (rr >= 0 && rr < N && cc >= 0 && cc < N && cat[rr][cc]) ok = false;
          }
        if (!ok) continue;
        cat[p.r][p.c] = true;
        applied.push(p);
      }
      if (!E.length && !applied.length) break;
      batches.push({ E, P: applied });
      if (contradiction) break;
    }
    return { cat, elim, batches, contradiction };
  }

  /* ---------- 回溯补全（传播卡住时，按颜色 MRV 搜索） ---------- */
  function complete(N, colorG, cat0, elim0, K) {
    const cat = mk2(N);
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) cat[r][c] = cat0[r][c];
    const usedCol = new Array(N).fill(false);
    const usedRow = new Array(N).fill(false);
    const done = new Array(K).fill(false);
    for (let r = 0; r < N; r++)
      for (let c = 0; c < N; c++)
        if (cat[r][c]) { usedCol[c] = true; usedRow[r] = true; done[colorG[r][c]] = true; }
    const colorCells = [];
    for (let k = 0; k < K; k++) {
      const cells = [];
      for (let r = 0; r < N; r++)
        for (let c = 0; c < N; c++)
          if (colorG[r][c] === k) cells.push([r, c]);
      colorCells.push(cells);
    }
    function can(r, c) {
      if (cat[r][c] || elim0[r][c] || usedCol[c] || usedRow[r]) return false;
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++) {
          if (!dr && !dc) continue;
          const rr = r + dr, cc = c + dc;
          if (rr >= 0 && rr < N && cc >= 0 && cc < N && cat[rr][cc]) return false;
        }
      return true;
    }
    function go() {
      let bk = -1, bc = null, bn = Infinity;
      for (let k = 0; k < K; k++) {
        if (done[k]) continue;
        const cands = colorCells[k].filter(([r, c]) => can(r, c));
        if (cands.length < bn) { bn = cands.length; bk = k; bc = cands; }
        if (bn === 0) break;
      }
      if (bk < 0) return true;     // 所有颜色都有猫了
      if (bn === 0) return false;  // 该颜色无处可放
      for (const [r, c] of bc) {
        cat[r][c] = true; usedCol[c] = true; usedRow[r] = true; done[bk] = true;
        if (go()) return true;
        cat[r][c] = false; usedCol[c] = false; usedRow[r] = false; done[bk] = false;
      }
      return false;
    }
    if (!go()) return null;
    const placements = [];
    for (let r = 0; r < N; r++)
      for (let c = 0; c < N; c++)
        if (cat[r][c] && !cat0[r][c]) placements.push({ r, c, reason: '回溯搜索补全' });
    return placements;
  }

  /* ---------- 主入口 ---------- */
  catSolver.analyze = function (dataUrl, opts) {
    opts = opts || {};
    return loadImage(dataUrl).then(img => {
      const W = img.naturalWidth, H = img.naturalHeight;
      const cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);

      // 裁掉提取结果可能带的近白 padding，保证切格对齐
      const raw = ctx.getImageData(0, 0, W, H).data;
      const tb = trimBounds(raw, W, H);
      const tw = tb.x1 - tb.x0, th = tb.y1 - tb.y0;
      let data, BW = W, BH = H;
      if (tw >= 40 && th >= 40 && (tw !== W || th !== H)) {
        const cv2 = document.createElement('canvas');
        cv2.width = tw; cv2.height = th;
        const ctx2 = cv2.getContext('2d', { willReadFrequently: true });
        ctx2.putImageData(ctx.getImageData(tb.x0, tb.y0, tw, th), 0, 0);
        data = ctx2.getImageData(0, 0, tw, th).data;
        BW = tw; BH = th;
      } else {
        data = raw;
      }

      const N = opts.N || detectN(data, BW, BH);
      if (!N) {
        const e = new Error('无法自动检测网格大小，请手动指定');
        e.needN = true;
        throw e;
      }

      // 每格分析
      const stats = [];
      const cw = BW / N, ch = BH / N;
      for (let r = 0; r < N; r++)
        for (let c = 0; c < N; c++)
          stats.push(analyzeCell(data, BW, BH, c * cw, r * ch, (c + 1) * cw, (r + 1) * ch));

      const catG0 = mk2(N), xG0 = mk2(N);
      stats.forEach((s, i) => {
        const r = (i / N) | 0, c = i % N;
        catG0[r][c] = s.darkFrac > 0.12;                                     // 猫头
        xG0[r][c] = s.darkFrac <= 0.12 && s.whiteFrac > 0.15;                // 图中已标 ✕
      });

      // 颜色聚类：自然聚类；只有偏多时才收敛到 N（颜色数可以小于网格数）
      const ringColors = stats.map(s => s.ring);
      let groups = fineCluster(ringColors, 45);
      if (groups.length > N) groups = clusterToK(ringColors, N);
      const K = groups.length;
      const exactLines = K === N;
      const clusters = groups.map(g => {
        let r = 0, g2 = 0, b = 0;
        for (const i of g) { r += ringColors[i].r; g2 += ringColors[i].g; b += ringColors[i].b; }
        return { n: g.length, mean: { r: r / g.length, g: g2 / g.length, b: b / g.length } };
      });
      const colorG = Array.from({ length: N }, () => new Array(N).fill(0));
      stats.forEach((s, i) => {
        const r = (i / N) | 0, c = i % N;
        let bi = 0, bd = Infinity;
        clusters.forEach((cl, ci) => { const d = rgbDist(s.ring, cl.mean); if (d < bd) { bd = d; bi = ci; } });
        colorG[r][c] = bi;
      });
      const colorNames = clusters.map((_, k) => `颜色${k + 1}`);

      // 传播求解
      const prop = propagate(N, colorG, catG0, xG0, colorNames, exactLines);
      const countCats = () => {
        let n = 0;
        for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) if (prop.cat[r][c]) n++;
        return n;
      };
      if (!prop.contradiction && countCats() < K) {
        const sol = complete(N, colorG, prop.cat, prop.elim, K);
        if (sol) {
          for (const p of sol) prop.cat[p.r][p.c] = true;
          prop.batches.push({ E: [], P: sol });
        } else prop.contradiction = '回溯也找不到完整解（识别可能有误）';
      }

      const solved = countCats() === K && !prop.contradiction;

      // 卡点诊断：没解完时，列出每个无猫单元的剩余候选
      let stall = null;
      if (!solved && !prop.contradiction) {
        stall = buildUnits(N, colorG, colorNames)
          .filter(u => (exactLines || u.type === 'color') && !u.cells.some(([r, c]) => prop.cat[r][c]))
          .map(u => ({
            name: u.name,
            cands: u.cells.filter(([r, c]) => !prop.cat[r][c] && !prop.elim[r][c]),
          }));
      }

      return {
        N,
        clusters,
        colorG,
        isCat: catG0,
        isX: xG0,
        batches: prop.batches,
        finalCat: prop.cat,
        solved,
        contradiction: prop.contradiction,
        stall,
      };
    });
  };

  global.catSolver = catSolver;
})(typeof window !== 'undefined' ? window : globalThis);
