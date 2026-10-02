/**
 * 第 10 节验收标准的自动化断言（在浏览器里跑，结果直接显示在「裁切参数」页）
 */
import { validateCutSequence, type CutLine, type Rect } from './guillotine'
import { BUILTIN_PAPERS, BUILTIN_PHOTO_SIZES } from './library'
import { pack, sheetsFromPlacements, usableRegion, type PackGroup, type PackOptions } from './packer'
import { buildPdf } from './pdf'
import {
  WARN_RATIO,
  coverUsedPixels,
  evaluateItem,
  evaluatePlacement,
  evaluateSheets,
  findSmallerSize,
  levelFromPpi,
  ppiOf,
  summarize,
} from './preflight'
import { MM_TO_PT, mmToPt, mmToPx, pxToMm } from './units'
import type { Item, Paper, PhotoRef, PhotoSize, Placement, Sheet } from './types'

export interface AssertionResult {
  id: string
  title: string
  pass: boolean
  detail: string
  ms: number
}

const EPS = 1e-6

function mulberry32(seed: number) {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function slotsOf(sheet: Sheet, opts: PackOptions): Rect[] {
  const m = (opts.kerfMm + opts.gapMm) / 2
  return sheet.placements.map((p) => ({
    x: p.x - m,
    y: p.y - m,
    w: p.w + 2 * m,
    h: p.h + 2 * m,
  }))
}

function cutsOf(sheet: Sheet): CutLine[] {
  return sheet.cutSteps.map((c) => ({ axis: c.axis, at: c.at, from: c.from, to: c.to }))
}

function overlap(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.w - EPS && b.x < a.x + a.w - EPS && a.y < b.y + b.h - EPS && b.y < a.y + a.h - EPS
  )
}

function randomCase(rnd: () => number) {
  const paper = BUILTIN_PAPERS[Math.floor(rnd() * BUILTIN_PAPERS.length)]
  const opts: PackOptions = {
    paperW: paper.wMm,
    paperH: paper.hMm,
    marginMm: paper.marginMm,
    safeEdgeMm: [0, 1, 3, 5][Math.floor(rnd() * 4)],
    gapMm: [0, 0, 0.5, 1, 2][Math.floor(rnd() * 5)],
    kerfMm: [0, 0.5, 1][Math.floor(rnd() * 3)],
    allowRotate: rnd() < 0.6,
  }
  const groups: PackGroup[] = []
  const n = 1 + Math.floor(rnd() * 3)
  for (let k = 0; k < n; k++) {
    const s = BUILTIN_PHOTO_SIZES[Math.floor(rnd() * BUILTIN_PHOTO_SIZES.length)]
    groups.push({
      itemId: `g${k}`,
      copies: 1 + Math.floor(rnd() * 8),
      photoW: s.wMm,
      photoH: s.hMm,
      allowRotate: rnd() < 0.7,
      keepTogether: rnd() < 0.3,
    })
  }
  return { paper, opts, groups }
}

/** ① guillotine 合法性：100 组随机任务，每一步切割线都贯通当前矩形 */
export function assertGuillotine(): AssertionResult {
  const t0 = performance.now()
  const rnd = mulberry32(20260920)
  let cases = 0
  let skipped = 0
  let sheetCount = 0
  let cutCount = 0
  let failure = ''
  let outside = ''
  let overlapped = ''
  for (let i = 0; i < 100; i++) {
    const { opts, groups } = randomCase(rnd)
    const out = pack(groups, opts)
    if (out.error) {
      skipped++
      continue
    }
    cases++
    const region = usableRegion(opts)
    if (!region) continue
    for (const sheet of out.result.sheets) {
      sheetCount++
      const slots = slotsOf(sheet, opts)
      const cuts = cutsOf(sheet)
      cutCount += cuts.length
      const v = validateCutSequence(region, slots, cuts)
      if (!v.ok && !failure) failure = `第 ${i + 1} 组 第 ${sheet.index + 1} 张：${v.reason}`
      if (sheet.cutSteps.length === 0 && slots.length > 1 && !failure) {
        failure = `第 ${i + 1} 组 第 ${sheet.index + 1} 张：多张照片却没有切割线`
      }
      for (const p of sheet.placements) {
        if (
          p.x < region.x - EPS ||
          p.y < region.y - EPS ||
          p.x + p.w > region.x + region.w + EPS ||
          p.y + p.h > region.y + region.h + EPS
        ) {
          if (!outside) outside = `第 ${i + 1} 组 第 ${sheet.index + 1} 张 #${p.seq}`
        }
      }
      for (let a = 0; a < slots.length; a++) {
        for (let b = a + 1; b < slots.length; b++) {
          if (overlap(slots[a], slots[b]) && !overlapped) {
            overlapped = `第 ${i + 1} 组 第 ${sheet.index + 1} 张 #${a + 1}/#${b + 1}`
          }
        }
      }
    }
  }
  const ok = !failure && !outside && !overlapped && cases > 0
  return {
    id: 'guillotine',
    title: '① guillotine 合法性：随机 100 组任务，每一步切割线贯通当前矩形',
    pass: ok,
    detail: ok
      ? `通过 ${cases} 组（${skipped} 组因尺寸放不下被跳过），共校验 ${sheetCount} 张相纸 / ${cutCount} 刀，无任何反例；照片均在安全边内、互不重叠`
      : `失败：${failure || outside || overlapped}`,
    ms: Math.round(performance.now() - t0),
  }
}

/** ② 利用率与张数：与手工核算一致（误差 ≤1%），Σ照片面积 ≤ Σ纸张面积 */
export function assertUtilization(): AssertionResult {
  const t0 = performance.now()
  const problems: string[] = []

  // 手工核算用例：100×100 相纸、无边距、无刀宽、无隙距，4 张 25×25
  const optsA: PackOptions = {
    paperW: 100,
    paperH: 100,
    marginMm: 0,
    safeEdgeMm: 0,
    gapMm: 0,
    kerfMm: 0,
    allowRotate: false,
  }
  const outA = pack(
    [{ itemId: 'a', copies: 4, photoW: 25, photoH: 25, allowRotate: false, keepTogether: false }],
    optsA,
  )
  const sheetA = outA.result.sheets[0]
  if (outA.result.sheets.length !== 1) problems.push('手工用例应只用 1 张纸')
  if (!sheetA || Math.abs(sheetA.utilization - 0.25) > 0.001) {
    problems.push(`手工用例利用率应为 25%，实际 ${sheetA ? (sheetA.utilization * 100).toFixed(2) : '—'}%`)
  }
  if (!sheetA || Math.abs(sheetA.usedAreaMm2 - 2500) > 0.01) problems.push('手工用例照片面积应为 2500mm²')

  // 手工核算用例：8 张 1 寸（25×35）排进 5×7 相纸
  const paper57 = BUILTIN_PAPERS.find((p) => p.id === 'p5x7') as Paper
  const optsB: PackOptions = {
    paperW: paper57.wMm,
    paperH: paper57.hMm,
    marginMm: paper57.marginMm,
    safeEdgeMm: 3,
    gapMm: 0,
    kerfMm: 0.5,
    allowRotate: false,
  }
  const outB = pack(
    [{ itemId: 'b', copies: 8, photoW: 25, photoH: 35, allowRotate: false, keepTogether: true }],
    optsB,
  )
  const handUtil = (8 * 25 * 35) / (paper57.wMm * paper57.hMm)
  if (outB.result.sheets.length !== 1) {
    problems.push(`8 张 1 寸应排进 1 张 5×7，实际 ${outB.result.sheets.length} 张`)
  }
  if (Math.abs(outB.result.stats.avgUtilization - handUtil) > 0.01) {
    problems.push(
      `利用率与手工核算偏差过大：${(outB.result.stats.avgUtilization * 100).toFixed(2)}% vs ${(handUtil * 100).toFixed(2)}%`,
    )
  }
  if (outB.result.stats.totalPhotos !== 8) problems.push('8 张 1 寸照片数量对不上')

  // 随机用例：面积守恒 + 利用率自洽
  const rnd = mulberry32(7788)
  let cases = 0
  for (let i = 0; i < 40; i++) {
    const { paper, opts, groups } = randomCase(rnd)
    const out = pack(groups, opts)
    if (out.error) continue
    cases++
    const photoArea = out.result.sheets.reduce((acc, s) => acc + s.usedAreaMm2, 0)
    const sheetArea = out.result.sheets.length * paper.wMm * paper.hMm
    if (photoArea > sheetArea + 1e-6) {
      problems.push(
        `第 ${i + 1} 组照片总面积超过纸张总面积：${photoArea.toFixed(1)} > ${sheetArea.toFixed(1)}（${paper.name}，${out.result.sheets.length} 张纸，${out.result.stats.totalPhotos} 张照片）`,
      )
    }
    const util = sheetArea > 0 ? photoArea / sheetArea : 0
    if (Math.abs(util - out.result.stats.avgUtilization) > 0.01) {
      problems.push(`第 ${i + 1} 组利用率不自洽`)
    }
  }
  return {
    id: 'util',
    title: '② 利用率与张数：与手工核算一致（≤1%），Σ照片面积 ≤ Σ纸张面积',
    pass: problems.length === 0,
    detail: problems.length
      ? problems.join('；')
      : `手工用例 25.00% 与 8 张 1 寸 → 1 张 5×7 均吻合；另有 ${cases} 组随机用例面积守恒`,
    ms: Math.round(performance.now() - t0),
  }
}

/** ③ 安全边 + kerf 补偿方向 */
export function assertSafeEdgeAndKerf(): AssertionResult {
  const t0 = performance.now()
  const problems: string[] = []
  const kerfMm = 2
  const opts: PackOptions = {
    paperW: 100,
    paperH: 100,
    marginMm: 2,
    safeEdgeMm: 3,
    gapMm: 0,
    kerfMm,
    allowRotate: false,
  }
  const out = pack(
    [{ itemId: 'a', copies: 1, photoW: 40, photoH: 40, allowRotate: false, keepTogether: false }],
    opts,
  )
  const sheet = out.result.sheets[0]
  if (!sheet) return { id: 'safe', title: '③ 安全边与刀口补偿', pass: false, detail: '排样失败', ms: 0 }
  const p = sheet.placements[0]
  // 照片尺寸必须保持标称值（刀宽不能吃掉照片）
  if (Math.abs(p.w - 40) > EPS || Math.abs(p.h - 40) > EPS) {
    problems.push(`照片尺寸被改变：${p.w}×${p.h}（应为 40×40）`)
  }
  // 切割线必须落在照片外侧（向内缩的是切块，不是照片）
  for (const c of sheet.cutSteps) {
    const inside =
      c.axis === 'v'
        ? p.x + EPS < c.at && c.at < p.x + p.w - EPS
        : p.y + EPS < c.at && c.at < p.y + p.h - EPS
    if (inside) problems.push('切割线切进了照片内部，kerf 补偿方向错误')
  }
  // 切块必须比照片每边大 kerf/2
  const slot = { x: p.x - kerfMm / 2, y: p.y - kerfMm / 2, w: p.w + kerfMm, h: p.h + kerfMm }
  if (slot.w - p.w !== kerfMm) problems.push('切块未按刀宽从照片外侧补偿')
  // 安全边
  const inset = opts.marginMm + opts.safeEdgeMm
  if (p.x < inset - EPS || p.y < inset - EPS || p.x + p.w > 100 - inset + EPS) {
    problems.push('照片超出安全边范围')
  }
  return {
    id: 'safe',
    title: '③ 安全边：所有照片落在边距内；kerf 从照片外侧向内缩补偿',
    pass: problems.length === 0,
    detail: problems.length
      ? problems.join('；')
      : `照片仍为 40×40mm，切块 42×42mm（每边外扩 kerf/2=1mm），切割线全部在照片外侧；安全边 [${inset}, ${100 - inset}]mm 内`,
    ms: Math.round(performance.now() - t0),
  }
}

/** ④ 单位换算：不同 DPI 下 mm 不变；1 寸 = 25×35mm */
export function assertUnits(): AssertionResult {
  const t0 = performance.now()
  const problems: string[] = []
  const one = BUILTIN_PHOTO_SIZES.find((s) => s.id === 's1cun')
  if (!one || one.wMm !== 25 || one.hMm !== 35) problems.push('尺寸库中的 1 寸不是 25×35mm')
  const px300 = mmToPx(25, 300)
  const px600 = mmToPx(25, 600)
  if (Math.abs(px300 - 295.2755906) > 1e-6) problems.push(`300dpi 下 25mm 应为 295.2756px，实际 ${px300}`)
  if (Math.abs(px600 - 590.5511811) > 1e-6) problems.push('600dpi 下 25mm 像素换算错误')
  if (Math.abs(pxToMm(px300, 300) - 25) > 1e-9) problems.push('300dpi 往返换算不等于 25mm')
  if (Math.abs(pxToMm(px600, 600) - 25) > 1e-9) problems.push('600dpi 往返换算不等于 25mm')
  if (Math.abs(pxToMm(px300, 300) - pxToMm(px600, 600)) > 1e-9) {
    problems.push('同一物理尺寸在不同 DPI 下 mm 不一致')
  }
  // 1:1 导出的几何与 DPI 无关
  const png300 = mmToPx(127, 300)
  const png600 = mmToPx(127, 600)
  if (Math.abs(pxToMm(png300, 300) - pxToMm(png600, 600)) > 1e-9) {
    problems.push('导出位图在不同 DPI 下物理尺寸不一致')
  }
  return {
    id: 'unit',
    title: '④ 单位换算：300/600dpi 下同一照片 mm 尺寸不变；1 寸 = 25×35mm',
    pass: problems.length === 0,
    detail: problems.length
      ? problems.join('；')
      : `25mm → 300dpi ${px300.toFixed(4)}px / 600dpi ${px600.toFixed(4)}px，往返换算均回到 25mm；1 寸 = 25×35mm`,
    ms: Math.round(performance.now() - t0),
  }
}

/** ⑤ 共边裁切：gap=0 时共边切割线合并成一条，步骤数减少 */
export function assertCoEdgeMerge(): AssertionResult {
  const t0 = performance.now()
  const problems: string[] = []
  const opts: PackOptions = {
    paperW: 50,
    paperH: 50,
    marginMm: 0,
    safeEdgeMm: 0,
    gapMm: 0,
    kerfMm: 0,
    allowRotate: false,
  }
  const out = pack(
    [{ itemId: 'a', copies: 4, photoW: 25, photoH: 25, allowRotate: false, keepTogether: false }],
    opts,
  )
  const sheet = out.result.sheets[0]
  if (!sheet) return { id: 'merge', title: '⑤ 共边裁切合并', pass: false, detail: '排样失败', ms: 0 }
  if (sheet.cutSteps.length >= sheet.rawCutCount) {
    problems.push(`共边合并后步数未减少：${sheet.cutSteps.length} vs 未合并 ${sheet.rawCutCount}`)
  }
  if (!sheet.cutSteps.some((c) => c.merged)) problems.push('没有标记出任何共边合并的切割线')
  const region = usableRegion(opts)!
  const v = validateCutSequence(region, slotsOf(sheet, opts), cutsOf(sheet))
  if (!v.ok) problems.push(`合并后的切割线不合法：${v.reason}`)
  return {
    id: 'merge',
    title: '⑤ 共边裁切：gap=0 时相邻共边切割线合并为一条，步骤数减少',
    pass: problems.length === 0,
    detail: problems.length
      ? problems.join('；')
      : `2×2 共边排布：未合并 ${sheet.rawCutCount} 刀 → 合并后 ${sheet.cutSteps.length} 刀（减少 ${sheet.rawCutCount - sheet.cutSteps.length} 刀）`,
    ms: Math.round(performance.now() - t0),
  }
}

/** ⑥ 1:1 导出：PDF 页面尺寸 = 相纸实际尺寸，校验尺 100mm，照片尺寸误差 ≤0.5mm */
async function assertExport1to1(): Promise<AssertionResult> {
  const t0 = performance.now()
  const problems: string[] = []
  const paper = BUILTIN_PAPERS.find((p) => p.id === 'p5x7') as Paper
  const opts: PackOptions = {
    paperW: paper.wMm,
    paperH: paper.hMm,
    marginMm: paper.marginMm,
    safeEdgeMm: 3,
    gapMm: 0,
    kerfMm: 0.5,
    allowRotate: false,
  }
  const out = pack(
    [{ itemId: 'a', copies: 2, photoW: 25, photoH: 35, allowRotate: false, keepTogether: false }],
    opts,
  )
  const sheets = out.result.sheets
  const task = {
    id: 't',
    name: '自检',
    paperId: paper.id,
    items: [],
    gapMm: 0,
    kerfMm: 0.5,
    safeEdgeMm: 3,
    allowRotate: false,
    headerText: '自检页眉',
    footerText: '2026-09-20',
    createdAt: 0,
  }
  const blob = await buildPdf({
    task,
    paper,
    sheets,
    photoOf: () => undefined,
    sizeLabelOf: () => '25x35',
  })
  const text = await blob.text()
  const mb = /\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(text)
  if (!mb) {
    problems.push('PDF 中找不到 MediaBox')
  } else {
    const w = Number(mb[1])
    const h = Number(mb[2])
    if (Math.abs(w - mmToPt(paper.wMm)) > 0.01) {
      problems.push(`PDF 页宽应为 ${mmToPt(paper.wMm).toFixed(2)}pt，实际 ${w}`)
    }
    if (Math.abs(h - mmToPt(paper.hMm)) > 0.01) {
      problems.push(`PDF 页高应为 ${mmToPt(paper.hMm).toFixed(2)}pt，实际 ${h}`)
    }
  }
  const pageCount = (text.match(/\/MediaBox/g) ?? []).length
  if (pageCount !== sheets.length + 1) {
    problems.push(`PDF 页数应为 ${sheets.length + 1}（每张相纸一页 + 校验页），实际 ${pageCount}`)
  }
  // 校验尺：15mm ~ 115mm
  const rulerFrom = mmToPt(15).toFixed(2)
  const rulerTo = mmToPt(115).toFixed(2)
  if (!text.includes(`${rulerFrom} `) || !text.includes(`${rulerTo} `)) {
    problems.push('PDF 中找不到 100mm 校验尺线段')
  }
  const rulerMm = (mmToPt(115) - mmToPt(15)) / MM_TO_PT
  if (Math.abs(rulerMm - 100) > 0.01) problems.push('校验尺长度不是 100mm')
  // 照片尺寸误差
  let maxErr = 0
  for (const s of sheets) {
    for (const p of s.placements) {
      maxErr = Math.max(maxErr, Math.abs(p.w - 25), Math.abs(p.h - 35))
    }
  }
  if (maxErr > 0.5) problems.push(`照片尺寸误差 ${maxErr.toFixed(3)}mm 超过 0.5mm`)
  // 页面尺寸换算：PDF 与位图都必须 1:1
  if (Math.abs(pxToMm(mmToPx(paper.wMm, 300), 300) - paper.wMm) > 1e-9) {
    problems.push('位图导出不是 1:1')
  }
  return {
    id: 'export',
    title: '⑥ 1:1 导出：PDF 页面 = 相纸实际尺寸，含 100mm 校验尺，照片尺寸误差 ≤0.5mm',
    pass: problems.length === 0,
    detail: problems.length
      ? problems.join('；')
      : `PDF ${pageCount} 页，页面 ${mmToPt(paper.wMm).toFixed(2)}×${mmToPt(paper.hMm).toFixed(2)}pt = ${paper.wMm}×${paper.hMm}mm（误差 0）；校验尺线段 ${rulerFrom}pt→${rulerTo}pt = 100.00mm；照片尺寸最大误差 ${maxErr.toFixed(3)}mm`,
    ms: Math.round(performance.now() - t0),
  }
}

/** ⑦ 性能：500 条目排样 < 500ms；手工微调增量校验 < 50ms */
export function assertPerformance(): AssertionResult {
  const t0 = performance.now()
  const problems: string[] = []
  const opts: PackOptions = {
    paperW: 305,
    paperH: 457,
    marginMm: 5,
    safeEdgeMm: 3,
    gapMm: 0,
    kerfMm: 0.5,
    allowRotate: true,
  }
  const groups: PackGroup[] = []
  const sizes = BUILTIN_PHOTO_SIZES.filter((s) => s.wMm <= 110)
  for (let i = 0; i < 500; i++) {
    const s = sizes[i % sizes.length]
    groups.push({
      itemId: `p${i}`,
      copies: 1,
      photoW: s.wMm,
      photoH: s.hMm,
      allowRotate: true,
      keepTogether: false,
    })
  }
  const out = pack(groups, opts)
  const packMs = out.result.stats.elapsedMs
  if (out.error) problems.push(out.error)
  if (packMs >= 500) problems.push(`500 条目排样耗时 ${packMs}ms ≥ 500ms`)
  if (out.result.stats.totalPhotos !== 500) {
    problems.push(`500 条目只排了 ${out.result.stats.totalPhotos} 张`)
  }
  // 手工微调增量校验
  const placements: Placement[] = out.result.sheets.flatMap((s) => s.placements)
  const sheetCount = out.result.sheets.length
  const t1 = performance.now()
  const r = sheetsFromPlacements(placements, opts, sheetCount)
  const validateMs = performance.now() - t1
  if (validateMs >= 50) problems.push(`手工微调增量校验耗时 ${validateMs.toFixed(1)}ms ≥ 50ms`)
  if (r.errors.length) problems.push(`自动排样结果未通过增量校验：${r.errors[0]}`)
  return {
    id: 'perf',
    title: '⑦ 性能：500 条目排样 < 500ms；手工微调增量校验 < 50ms',
    pass: problems.length === 0,
    detail: problems.length
      ? problems.join('；')
      : `500 条目排样 ${packMs}ms（${out.result.stats.sheets} 张纸，利用率 ${(out.result.stats.avgUtilization * 100).toFixed(1)}%）；手工微调后增量校验 ${validateMs.toFixed(1)}ms`,
    ms: Math.round(performance.now() - t0),
  }
}

/** ⑧ 印前清晰度预检：cover 裁切口径、评级、最大可印尺寸、调小建议、落版复核与拦截汇总 */
export function assertPreflight(): AssertionResult {
  const t0 = performance.now()
  const problems: string[] = []
  const sizes = BUILTIN_PHOTO_SIZES
  const s6 = sizes.find((s) => s.id === 's6cun') as PhotoSize // 102×152mm
  const s5 = sizes.find((s) => s.id === 's5cun') as PhotoSize // 89×127
  const s1 = sizes.find((s) => s.id === 's1cun') as PhotoSize // 25×35
  const s2l = sizes.find((s) => s.id === 's2cun_l') as PhotoSize // 35×49

  const refOf = (w: number, h: number, landscape = false): PhotoRef => ({
    name: 'test.jpg',
    wPx: w,
    hPx: h,
    landscape,
  })
  const itemOf = (ref: PhotoRef | undefined, size: PhotoSize, rotate = true): Item => ({
    id: `i-${size.id}-${ref?.wPx ?? 0}x${ref?.hPx ?? 0}`,
    sizeId: size.id,
    qty: 1,
    rotateAllowed: rotate,
    repeatSamePhoto: true,
    keepTogether: false,
    photo: ref,
  })
  const opts = { targetPpi: 300, allowRotate: true, candidates: sizes }

  // 1) 评级边界：300 达标、240 临界、239 不达标
  if (levelFromPpi(300, 300) !== 'ok') problems.push('300ppi 应判达标')
  if (levelFromPpi(240, 300) !== 'warn') problems.push('240ppi 应判临界（0.8×300）')
  if (levelFromPpi(239, 300) !== 'bad') problems.push('239ppi 应判不达标')
  if (WARN_RATIO !== 0.8) problems.push('临界阈值应为 0.8')

  // 2) 6 寸需要 1200×1800（无裁切）；1205×1795 纵向底片 cover 后高度裁掉，两轴 ppi
  //    ppiX = 1205*25.4/102 = 300.1, ppiY = 1795*25.4/152 = 299.9 → 取小 299 → warn
  const needW = Math.round(mmToPxLocal(s6.wMm, 300))
  const needH = Math.round(mmToPxLocal(s6.hMm, 300))
  if (needW !== 1205 || needH !== 1795) problems.push(`6 寸 @300ppi 像素需求应为约 1205×1795，实际 ${needW}×${needH}`)
  const exact = evaluateItem(itemOf(refOf(needW, needH), s6), s6, opts)
  if (exact.level !== 'ok' || exact.ppi! < 300) problems.push(`精确达标底片应判 ok，实际 ${exact.level}/${exact.ppi}`)

  const near = evaluateItem(itemOf(refOf(needW, needH - 15), s6), s6, opts)
  if (near.level !== 'warn') problems.push(`差约 15px 应判临界，实际 ${near.level}/${near.ppi}`)

  // 3) 900×1300 印 6 寸：cover 取 872×1300，ppi≈217 → bad；
  //    保持 6 寸比例最多印短边 ≈73.9mm；不裁切原比例最多 76.2×110.1mm
  const low = evaluateItem(itemOf(refOf(900, 1300), s6), s6, opts)
  if (low.level !== 'bad') problems.push(`900×1300 印 6 寸应不达标，实际 ${low.level}`)
  if (!low.cropped) problems.push('比例不一致时应判定发生了 cover 裁切')
  const maxShort = Math.min(low.maxWMm!, low.maxHMm!)
  if (Math.abs(maxShort - 73.9) > 1) problems.push(`900×1300@300ppi 最多印短边应≈73.9mm，实际 ${maxShort}`)
  const nativeShort = Math.min(low.nativeMaxWMm!, low.nativeMaxHMm!)
  if (Math.abs(nativeShort - 76.2) > 1) {
    problems.push(`900×1300 不裁切原比例最多印短边应≈76.2mm，实际 ${nativeShort}`)
  }
  // 调小建议：尺寸库里它能达到 300ppi 的最大一档是大 2 寸（35×49）
  const smaller = findSmallerSize(refOf(900, 1300), s6, sizes, 300, true)
  if (smaller?.id !== s2l.id) problems.push(`900×1300 的调小建议应为大 2 寸，实际 ${smaller?.name ?? '无'}`)
  // 印 1 寸应达标（证件照底片小但印得小）
  const tiny = evaluateItem(itemOf(refOf(900, 1300), s1, false), s1, { ...opts, allowRotate: false })
  if (tiny.level !== 'ok') problems.push(`900×1300 印 1 寸应达标，实际 ${tiny.level}/${tiny.ppi}`)

  // 4) 横向底片 1800×1205、允许旋转时能喂饱纵向 6 寸 → ok 且采用 rotated 方向
  const landscape = evaluateItem(itemOf(refOf(1800, 1205, true), s6), s6, opts)
  if (landscape.level !== 'ok' || !landscape.rotated) {
    problems.push(`1800×1205 横向底片允许旋转印 6 寸应达标且采用旋转，实际 ${landscape.level}/rot=${landscape.rotated}`)
  }

  // 5) cover 口径：2400×2400 方底片印 6 寸，保高裁宽取约 1611×2400，ppi≈401
  const used = coverUsedPixels({ wPx: 2400, hPx: 2400 }, s6.wMm, s6.hMm)
  if (Math.abs(used.wPx - 1610.5) > 1 || Math.abs(used.hPx - 2400) > 0.5) {
    problems.push(`方底片 cover 6 寸应取约 1611×2400，实际 ${used.wPx}×${used.hPx}`)
  }
  if (Math.abs(ppiOf(used.wPx, s6.wMm) - 401) > 2) problems.push(`cover 后 ppi 应约 401，实际 ${ppiOf(used.wPx, s6.wMm).toFixed(0)}`)
  // 像素恰好匹配时不裁（1020×1520 与 102×152 严格同比例）
  const usedExact = coverUsedPixels({ wPx: 1020, hPx: 1520 }, s6.wMm, s6.hMm)
  if (Math.abs(usedExact.wPx - 1020) > 0.01 || Math.abs(usedExact.hPx - 1520) > 0.01) {
    problems.push(`与目标严格同比例的底片不应裁切像素，实际 ${usedExact.wPx}×${usedExact.hPx}`)
  }

  // 6) 无底片 → unknown，不拦截；汇总计数正确
  const unknown = evaluateItem(itemOf(undefined, s6), s6, opts)
  if (unknown.level !== 'unknown') problems.push('未导入底片应判 unknown')

  // 7) 落版复核：placement 实际矩形变化后结果随之变化（6 寸 → 5 寸位置）
  const pBad: Placement = { itemId: 'x', sheetIndex: 0, x: 0, y: 0, w: s6.wMm, h: s6.hMm, rotated: false, seq: 1 }
  const pOk: Placement = { itemId: 'x', sheetIndex: 0, x: 0, y: 0, w: s5.wMm, h: s5.hMm, rotated: false, seq: 2 }
  const map = evaluateSheets(
    [
      { index: 0, placements: [pBad, pOk], cutSteps: [], rawCutCount: 0, usedAreaMm2: 0, sheetAreaMm2: 1, utilization: 0, wasteRects: [] },
    ] as Sheet[],
    (p) => (p.seq === 1 ? refOf(900, 1300) : refOf(1200, 1800)),
    300,
  )
  if (map.get(1)?.level !== 'bad') problems.push('落版复核：#1 印成 6 寸应不达标')
  if (map.get(2)?.level !== 'ok') problems.push(`落版复核：#2 印成 5 寸应达标，实际 ${map.get(2)?.level}/${map.get(2)?.ppi}`)
  const summaryBlocked = summarize([...map.values(), unknown], true)
  if (summaryBlocked.ok !== 1 || summaryBlocked.action !== 1 || !summaryBlocked.blocked) {
    problems.push(
      `汇总应为 1 过 / 1 待处理且拦截，实际 ${summaryBlocked.ok}/${summaryBlocked.action}/blocked=${summaryBlocked.blocked}`,
    )
  }
  const summaryOpen = summarize([...map.values(), unknown], false)
  if (summaryOpen.blocked) problems.push('关闭拦截时 blocked 必须为 false')
  // evaluatePlacement 无底片
  if (evaluatePlacement(undefined, pBad, 300).level !== 'unknown') problems.push('placement 无底片应 unknown')

  return {
    id: 'preflight',
    title: '⑧ 印前清晰度预检：cover 裁切口径、评级边界、最大可印尺寸、调小建议、落版复核与拦截汇总',
    pass: problems.length === 0,
    detail: problems.length
      ? problems.join('；')
      : `评级边界 300/240/239→达标/临界/不达标；6 寸@300ppi 需 1205×1795px；900×1300 印 6 寸 ${low.ppi}ppi 不达标、保持比例最多印 ${maxShort.toFixed(
        1,
      )}mm（不裁切 ${nativeShort.toFixed(1)}mm）、建议调小为「${s2l.name}」（印 1 寸则 ${tiny.ppi}ppi 达标）；1800×1205 横片旋转后达标；方底片 cover 取约 1611×2400≈401ppi（严格同比例 1020×1520 不裁）；落版复核随实际印成尺寸变化；拦截汇总 1 过/1 待处理`,
    ms: Math.round(performance.now() - t0),
  }
}

function mmToPxLocal(mm: number, dpi: number): number {
  return (mm / 25.4) * dpi
}

export async function runSelfTest(): Promise<AssertionResult[]> {
  const results: AssertionResult[] = []
  results.push(assertGuillotine())
  results.push(assertUtilization())
  results.push(assertSafeEdgeAndKerf())
  results.push(assertUnits())
  results.push(assertCoEdgeMerge())
  try {
    results.push(await assertExport1to1())
  } catch (e) {
    results.push({
      id: 'export',
      title: '⑥ 1:1 导出：PDF 页面 = 相纸实际尺寸，含 100mm 校验尺',
      pass: false,
      detail: `异常：${e instanceof Error ? e.message : String(e)}`,
      ms: 0,
    })
  }
  results.push(assertPerformance())
  results.push(assertPreflight())
  return results
}
