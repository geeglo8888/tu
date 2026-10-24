/* ================================================================
   qipan.js — 全自动棋盘检测 & 提取（纯前端，无外部依赖）v3

   v3 主算法：自底向上 + 正方形校验（利用「行数 = 列数」→ 棋盘是正方形）
   1. 色度掩码：棋盘格子都是彩色（RGB max-min 大），而米色背景、
      白色卡片、灰色文字的色度极低 → 天然排除顶部规则卡/图例等 UI
   2. 行扫描：色度占比 ≥ 阈值的连续行段（允许 ≤maxGap 的格线间断合并，
      maxGap 按格子尺寸估算 = 1.4% 图宽，适配最多 10×10）
   3. 自底向上逐个候选行段验证：
      - 行段高度 ≥ 15% 图高（排除猫头图例、按钮行等小块）
      - 段内列扫描取最长列段，宽度 ≥ 30% 图宽
      - |宽 - 高| / max(宽,高) ≤ 15% → 正方形 → 判定为棋盘
   4. 多档色度阈值重试；全部失败回退 v2 主背景色法

   v2 回退算法：主背景色占比法
   1. 统计全图 15-bit 颜色直方图，取最高频颜色 = 背景
   2. 逐像素标记「非背景」，行/列扫描找最长密集带
   3. 多档阈值重试 + 端部收紧

   用法：
     qipan.detectBoard(dataUrl).then(res => {
       // res = { x, y, w, h, croppedDataUrl, debug }
     }).catch(err => { ... err.debug ... });
================================================================ */
(function (global) {
  'use strict';

  const qipan = {};

  const DEFAULTS = {
    maxWorkWidth: 600,     // 处理宽度上限（小图不放大）
    // ---- v3 ----
    bandThr: 0.5,          // 行/列视为「彩色内容」的占比阈值
    chromaTry: [26, 20, 32], // 色度阈值（max-min），逐档重试
    gapRatio: 0.014,       // 格线间断宽度上限 ≈ 1.4% 图宽（按 10×10 估算）
    minBandRatio: 0.15,    // 候选行段最小高度占比
    minColRatio: 0.30,     // 列段最小宽度占比
    squareTol: 0.15,       // 正方形判定容差 |w-h|/max
    // ---- v2 回退 ----
    bgDist: 28,            // 与背景色 RGB 距离超过此值 = 非背景像素
    bandThresholds: [0.45, 0.35, 0.55, 0.30], // 占比阈值，逐档重试
    minBandRatioV2: 0.12,  // 棋盘带至少占该维度的比例
    maxGapRatio: 0.05,     // 允许带内小间断（格线）占比
    tightenAt: 0.55,       // 端部收紧阈值（去掉零散 UI 行）
  };

  qipan.detectBoard = function (imageDataUrl, options) {
    const opts = Object.assign({}, DEFAULTS, options || {});
    return loadImage(imageDataUrl).then(img => runPipeline(img, opts));
  };

  /** 给定坐标直接裁剪（调试用） */
  qipan.crop = function (imageDataUrl, x, y, w, h) {
    return loadImage(imageDataUrl).then(img => {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, x, y, w, h, 0, 0, w, h);
      return { x, y, w, h, croppedDataUrl: c.toDataURL('image/png') };
    });
  };

  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('图片加载失败'));
      img.src = dataUrl;
    });
  }

  function fail(msg, debug) {
    const e = new Error(msg);
    e.debug = debug;
    return e;
  }

  /** 缩放到位工作画布并取出 RGB 平面数组 */
  function analyzeImage(img, opts) {
    const scale = Math.min(1, opts.maxWorkWidth / img.naturalWidth);
    const W = Math.max(1, Math.round(img.naturalWidth * scale));
    const H = Math.max(1, Math.round(img.naturalHeight * scale));

    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, W, H);
    const data = ctx.getImageData(0, 0, W, H).data;

    const N = W * H;
    const R = new Uint8Array(N), G = new Uint8Array(N), B = new Uint8Array(N);
    for (let i = 0, p = 0; p < N; i += 4, p++) {
      R[p] = data[i]; G[p] = data[i + 1]; B[p] = data[i + 2];
    }
    return { W, H, scale, R, G, B };
  }

  function runPipeline(img, opts) {
    const A = analyzeImage(img, opts);
    const dbg = { workW: A.W, workH: A.H, scale: A.scale, tries: [] };

    // ---- v3：自底向上 + 正方形校验 ----
    const box = detectSquareBottomUp(A, opts, dbg);
    if (box) return emitCrop(img, A, dbg, box, 'v3-square-bottomup');

    // ---- v2 回退：主背景色法 ----
    return runV2(img, A, opts, dbg);
  }

  /** v3 主体：返回 {x0,y0,x1,y1}（工作坐标）或 null */
  function detectSquareBottomUp(A, opts, dbg) {
    const { W, H, R, G, B } = A;
    const N = W * H;
    const minH = Math.max(24, Math.round(H * opts.minBandRatio));
    const minW = Math.max(24, Math.round(W * opts.minColRatio));
    const maxGap = Math.max(4, Math.round(W * opts.gapRatio));

    for (const chroma of opts.chromaTry) {
      // 色度掩码：彩色像素 = 1
      const mask = new Uint8Array(N);
      for (let p = 0; p < N; p++) {
        const mx = Math.max(R[p], G[p], B[p]);
        const mn = Math.min(R[p], G[p], B[p]);
        if (mx - mn >= chroma) mask[p] = 1;
      }

      const rowFrac = fracByRow(mask, W, H);
      const rowBands = findBands(rowFrac, opts.bandThr, maxGap);

      // 自底向上逐个候选验证
      for (let i = rowBands.length - 1; i >= 0; i--) {
        const y0 = rowBands[i][0], y1 = rowBands[i][1];
        const h = y1 - y0 + 1;
        if (h < minH) continue;

        const colFrac = fracByCol(mask, W, y0, y1);
        const colBands = findBands(colFrac, opts.bandThr, maxGap);
        let best = null;
        for (const cb of colBands) {
          if (!best || cb[1] - cb[0] > best[1] - best[0]) best = cb;
        }
        if (!best) continue;
        const w = best[1] - best[0] + 1;
        if (w < minW) continue;

        const dev = Math.abs(w - h) / Math.max(w, h);
        dbg.tries.push({
          chroma, maxGap,
          rowBand: [y0, y1], colBand: best, w, h,
          squareDev: +dev.toFixed(3),
        });
        if (dev <= opts.squareTol) {
          return { x0: best[0], y0, x1: best[1], y1 };
        }
      }
    }
    return null;
  }

  /** 每行彩色像素占比 */
  function fracByRow(mask, W, H) {
    const fr = new Float32Array(H);
    for (let y = 0; y < H; y++) {
      let c = 0;
      const base = y * W;
      for (let x = 0; x < W; x++) c += mask[base + x];
      fr[y] = c / W;
    }
    return fr;
  }

  /** [y0,y1] 范围内每列彩色像素占比 */
  function fracByCol(mask, W, y0, y1) {
    const h = y1 - y0 + 1;
    const fr = new Float32Array(W);
    for (let x = 0; x < W; x++) {
      let c = 0;
      for (let y = y0; y <= y1; y++) c += mask[y * W + x];
      fr[x] = c / h;
    }
    return fr;
  }

  /**
   * 找「占比 ≥ thr 的连续段」，允许 ≤maxGap 的间断合并，返回全部合并段
   */
  function findBands(fracs, thr, maxGap) {
    const n = fracs.length;
    const segs = [];
    let i = 0;
    while (i < n) {
      if (fracs[i] >= thr) {
        let j = i;
        while (j < n && fracs[j] >= thr) j++;
        segs.push([i, j - 1]);
        i = j;
      } else i++;
    }
    if (!segs.length) return [];
    const merged = [segs[0].slice()];
    for (let s = 1; s < segs.length; s++) {
      const last = merged[merged.length - 1];
      if (segs[s][0] - last[1] - 1 <= maxGap) last[1] = segs[s][1];
      else merged.push(segs[s].slice());
    }
    return merged;
  }

  /** 合并段中取最长且 ≥ minLen 的一段 */
  function pickLongest(bands, minLen) {
    let best = null;
    for (const [a, b] of bands) {
      if (b - a + 1 >= minLen && (!best || b - a > best[1] - best[0])) best = [a, b];
    }
    return best;
  }

  /** 按工作坐标框裁剪并输出原图坐标结果 */
  function emitCrop(img, A, dbg, box, method) {
    const inv = 1 / A.scale;
    const rx = Math.round(box.x0 * inv);
    const ry = Math.round(box.y0 * inv);
    const rw = Math.max(1, Math.round((box.x1 - box.x0 + 1) * inv));
    const rh = Math.max(1, Math.round((box.y1 - box.y0 + 1) * inv));

    const out = document.createElement('canvas');
    out.width = rw; out.height = rh;
    out.getContext('2d').drawImage(img, rx, ry, rw, rh, 0, 0, rw, rh);

    dbg.method = method;
    dbg.result = { x: rx, y: ry, w: rw, h: rh };
    return {
      x: rx, y: ry, w: rw, h: rh,
      croppedDataUrl: out.toDataURL('image/png'),
      debug: dbg,
    };
  }

  /** v2 回退：主背景色占比法（旧逻辑，保持兼容） */
  function runV2(img, A, opts, dbg) {
    const { W, H, R, G, B } = A;
    const N = W * H;

    // 1. 主背景色（15-bit 直方图最高频）
    const hist = new Map();
    for (let p = 0; p < N; p++) {
      const key = ((R[p] >> 3) << 10) | ((G[p] >> 3) << 5) | (B[p] >> 3);
      hist.set(key, (hist.get(key) || 0) + 1);
    }
    let bestKey = 0, bestCount = 0;
    hist.forEach((c, k) => { if (c > bestCount) { bestCount = c; bestKey = k; } });
    const bg = {
      r: ((bestKey >> 10) & 31) * 8 + 4,
      g: ((bestKey >> 5) & 31) * 8 + 4,
      b: (bestKey & 31) * 8 + 4,
    };
    dbg.bg = bg;

    // 2. 非背景掩码
    const nonBg = new Uint8Array(N);
    const t2 = opts.bgDist * opts.bgDist;
    for (let p = 0; p < N; p++) {
      const dr = R[p] - bg.r, dg = G[p] - bg.g, db = B[p] - bg.b;
      if (dr * dr + dg * dg + db * db > t2) nonBg[p] = 1;
    }

    // 3. 行占比 + 多档阈值找纵向带
    const rowFrac = new Float32Array(H);
    for (let y = 0; y < H; y++) {
      let c = 0;
      const base = y * W;
      for (let x = 0; x < W; x++) c += nonBg[base + x];
      rowFrac[y] = c / W;
    }

    let rowBand = null, usedRowThr = null;
    for (const thr of opts.bandThresholds) {
      rowBand = pickLongest(
        findBands(rowFrac, thr, Math.max(2, Math.round(H * opts.maxGapRatio))),
        Math.max(8, Math.round(H * opts.minBandRatioV2)));
      dbg.tries.push({ dim: 'row', thr, band: rowBand });
      if (rowBand) { usedRowThr = thr; break; }
    }
    if (!rowBand) throw fail('未能定位棋盘的纵向范围（找不到密集色块带）', dbg);

    // 4. 带内列占比 → 横向带
    const bandH = rowBand[1] - rowBand[0] + 1;
    const colFrac = new Float32Array(W);
    for (let x = 0; x < W; x++) {
      let c = 0;
      for (let y = rowBand[0]; y <= rowBand[1]; y++) c += nonBg[y * W + x];
      colFrac[x] = c / bandH;
    }

    let colBand = null, usedColThr = null;
    for (const thr of opts.bandThresholds) {
      colBand = pickLongest(
        findBands(colFrac, thr, Math.max(2, Math.round(W * opts.maxGapRatio))),
        Math.max(8, Math.round(W * opts.minBandRatioV2)));
      dbg.tries.push({ dim: 'col', thr, band: colBand });
      if (colBand) { usedColThr = thr; break; }
    }
    if (!colBand) throw fail('未能定位棋盘的横向范围', dbg);

    // 5. 端部收紧（去掉占比偏低的零散 UI 行/列）
    let top = rowBand[0], bottom = rowBand[1];
    let left = colBand[0], right = colBand[1];
    while (top < bottom && rowFrac[top] < opts.tightenAt) top++;
    while (bottom > top && rowFrac[bottom] < opts.tightenAt) bottom--;
    while (left < right && colFrac[left] < opts.tightenAt) left++;
    while (right > left && colFrac[right] < opts.tightenAt) right--;

    Object.assign(dbg, {
      usedRowThr, usedColThr,
      rowBandTight: { start: top, end: bottom },
      colBandTight: { start: left, end: right },
    });

    return emitCrop(img, A, dbg, { x0: left, y0: top, x1: right, y1: bottom }, 'v2-bg-band');
  }

  global.qipan = qipan;

})(typeof window !== 'undefined' ? window : globalThis);
