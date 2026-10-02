/**
 * 印前清晰度预检（全部在浏览器本地计算，底片像素只来自内存中的 PhotoRef，绝不上传）。
 *
 * 基本口径：
 * - 照片按「填满裁切」（CSS object-fit: cover 的语义）裁到目标打印矩形的比例，
 *   即底片只取中间一块与目标宽高比一致的区域，裁掉的像素不参与清晰度。
 * - 实际清晰度 = 裁切后短边（取两轴 ppi 的最小值，即最糊的那根轴）的 ppi。
 * - ppi = 像素 / 英寸 = 像素 × 25.4 / mm。
 * - 评级：ppi ≥ 目标 → ok；0.8×目标 ≤ ppi < 目标 → warn（临界，可视距离远可接受）；
 *   ppi < 0.8×目标 → bad（印出来明显糊）。
 */
import { MM_PER_INCH, round } from './units'
import type { Item, PhotoRef, PhotoSize, Placement, Sheet } from './types'

export type SharpLevel = 'ok' | 'warn' | 'bad' | 'unknown'

/** 临界档阈值：达到目标 ppi 的 80% 算「临界可用」，低于才算「危险」 */
export const WARN_RATIO = 0.8
/**
 * 评级容差：底片是整数像素，而 cover 裁切在宽高比差零点几个百分点时会产生亚像素损失，
 * 0.1% 以内视为恰好踩线（1205px 喂 1204.7px 的槽位算达标）。
 */
const LEVEL_EPS = 1e-3

export interface SharpEval {
  level: SharpLevel
  /** 实际清晰度 ppi（裁切后两轴中的较小值）；无底片时为 undefined */
  ppi?: number
  targetPpi: number
  /** 裁切后实际参与打印的底片像素（宽/高） */
  usedWPx?: number
  usedHPx?: number
  /** 目标打印矩形 mm（新建页为尺寸库方向；落版复核为 placement 实际方向） */
  printWMm: number
  printHMm: number
  /** 目标尺寸所需的像素（宽/高，目标 ppi） */
  needWPx?: number
  needHPx?: number
  /** 按目标 ppi、保持当前打印宽高比，这张底片最多能印多大（mm，短边×长边） */
  maxWMm?: number
  maxHMm?: number
  /** 不做任何裁切、保持底片原比例铺满时，最多能印多大（mm） */
  nativeMaxWMm?: number
  nativeMaxHMm?: number
  /** 距目标差多少：ppi 缺口（目标−实际） */
  gapPpi?: number
  /** 距目标差多少：按较短轴计的像素缺口（需要补多少像素） */
  gapPx?: number
  /** 建议文案：调小到哪个尺寸 / 换更大底片 / 可放大 */
  advice: string
  /** 预检采用的方向：false=底片原方向，true=底片旋转 90° 后匹配打印矩形 */
  rotated: boolean
  /** cover 裁切是否损失了底片像素（打印比例与底片比例不一致） */
  cropped: boolean
}

export function levelFromPpi(ppi: number, targetPpi: number): SharpLevel {
  if (ppi >= targetPpi * (1 - LEVEL_EPS)) return 'ok'
  if (ppi >= targetPpi * WARN_RATIO * (1 - LEVEL_EPS)) return 'warn'
  return 'bad'
}

export function ppiOf(px: number, mm: number): number {
  return (px * MM_PER_INCH) / mm
}

/** cover 语义下，底片填满 rw×rh 打印矩形时实际用到的底片像素 */
export function coverUsedPixels(
  ref: { wPx: number; hPx: number },
  rw: number,
  rh: number,
): { wPx: number; hPx: number } {
  // 底片按原比例放大到刚好盖住目标矩形（k = mm/px，取两轴较大值），溢出的一边被裁
  const k = Math.max(rw / ref.wPx, rh / ref.hPx)
  return { wPx: round(rw / k, 2), hPx: round(rh / k, 2) }
}

interface OrientationInput {
  ref: PhotoRef
  /** 打印矩形（该方向下）的 mm */
  wMm: number
  hMm: number
  rotated: boolean
}

/** 评估单个方向（底片 → 指定打印矩形）的清晰度，不含建议文案 */
function evalOrientation(input: OrientationInput, targetPpi: number): Omit<SharpEval, 'advice'> {
  const { ref, wMm, hMm, rotated } = input
  const used = coverUsedPixels(ref, wMm, hMm)
  const ppiX = ppiOf(used.wPx, wMm)
  const ppiY = ppiOf(used.hPx, hMm)
  const ppi = Math.min(ppiX, ppiY)
  const needWPx = (targetPpi * wMm) / MM_PER_INCH
  const needHPx = (targetPpi * hMm) / MM_PER_INCH
  const cropped = used.wPx < ref.wPx - 0.5 || used.hPx < ref.hPx - 0.5

  // 保持「打印矩形宽高比」、按目标 ppi 最多能印多大：
  // cover 后等比放大打印矩形，直到裁切区触及底片短边那一轴
  const scale = Math.min(ref.wPx / needWPx, ref.hPx / needHPx)
  const maxWMm = wMm * scale
  const maxHMm = hMm * scale

  // 不裁切（保持底片原比例）时最多能印多大
  const nativeMaxWMm = (ref.wPx * MM_PER_INCH) / targetPpi
  const nativeMaxHMm = (ref.hPx * MM_PER_INCH) / targetPpi

  const gapPpi = Math.max(0, targetPpi - ppi)
  // 像素缺口按「最糊的那根轴」计
  const gapPx =
    ppiX <= ppiY ? Math.max(0, needWPx - used.wPx) : Math.max(0, needHPx - used.hPx)

  return {
    level: levelFromPpi(ppi, targetPpi),
    ppi: round(ppi, 0),
    targetPpi,
    usedWPx: round(used.wPx, 0),
    usedHPx: round(used.hPx, 0),
    printWMm: wMm,
    printHMm: hMm,
    needWPx: Math.ceil(needWPx),
    needHPx: Math.ceil(needHPx),
    maxWMm: round(maxWMm, 1),
    maxHMm: round(maxHMm, 1),
    nativeMaxWMm: round(nativeMaxWMm, 1),
    nativeMaxHMm: round(nativeMaxHMm, 1),
    gapPpi: round(gapPpi, 0),
    gapPx: Math.ceil(gapPx),
    rotated,
    cropped,
  }
}

function unknownEval(wMm: number, hMm: number, targetPpi: number): SharpEval {
  return {
    level: 'unknown',
    targetPpi,
    printWMm: wMm,
    printHMm: hMm,
    advice: '未导入底片，无法预检清晰度（照片只在本机内存读取，不会上传）',
    rotated: false,
    cropped: false,
  }
}

/** 「调小」建议：在备选尺寸里找这张底片在当前方向下仍能达到目标 ppi 的最大一档 */
export function findSmallerSize(
  ref: PhotoRef,
  cur: PhotoSize,
  candidates: PhotoSize[],
  targetPpi: number,
  allowRotate: boolean,
): PhotoSize | undefined {
  let best: { size: PhotoSize; area: number } | undefined
  for (const s of candidates) {
    const area = s.wMm * s.hMm
    if (area >= cur.wMm * cur.hMm - 1e-6) continue // 只考虑更小的
    const variants: Array<{ w: number; h: number }> = [{ w: s.wMm, h: s.hMm }]
    if (allowRotate && Math.abs(s.wMm - s.hMm) > 1e-6) variants.push({ w: s.hMm, h: s.wMm })
    let pass = false
    for (const v of variants) {
      const used = coverUsedPixels(ref, v.w, v.h)
      if (ppiOf(used.wPx, v.w) + 1e-9 >= targetPpi && ppiOf(used.hPx, v.h) + 1e-9 >= targetPpi) {
        pass = true
        break
      }
    }
    if (pass && (!best || area > best.area)) best = { size: s, area }
  }
  return best?.size
}

function buildAdvice(
  e: Omit<SharpEval, 'advice'>,
  ref: PhotoRef,
  cur: PhotoSize | undefined,
  candidates: PhotoSize[],
  allowRotate: boolean,
): string {
  if (e.level === 'unknown') return unknownEval(e.printWMm, e.printHMm, e.targetPpi).advice
  if (!cur) return ''
  const smaller = findSmallerSize(ref, cur, candidates, e.targetPpi, allowRotate)
  const fmt = (w: number, h: number) => `${round(Math.min(w, h), 0)}×${round(Math.max(w, h), 0)}mm`

  if (e.level === 'bad') {
    if (smaller) {
      return `建议把这张调小为「${smaller.name}」（${fmt(smaller.wMm, smaller.hMm)}）即可达到 ${e.targetPpi}ppi；换更大的纸仍印原尺寸不会变清楚`
    }
    return `尺寸库里没有更小的规格能达标：即使保持底片原比例不裁切，最多也只能印 ${fmt(
      e.nativeMaxWMm ?? 0,
      e.nativeMaxHMm ?? 0,
    )}。请向客户要更大像素的底片（约缺 ${e.gapPx}px），换更大的纸解决不了发糊`
  }
  if (e.level === 'warn') {
    if (smaller) {
      return `临界可用（近看会略糊）；要稳妥达标建议调小为「${smaller.name}」（${fmt(
        smaller.wMm,
        smaller.hMm,
      )}），或换更大像素的底片`
    }
    return `临界可用：离目标 ${e.targetPpi}ppi 只差 ${e.gapPpi}ppi（约 ${e.gapPx}px），近看会略糊、远看可接受；不建议再放大`
  }
  // ok：富余很多时提示可以放大（升级销售）
  if (cur && e.ppi !== undefined && e.ppi >= e.targetPpi * 1.35) {
    return `清晰度富余（${e.ppi}ppi），客户要更大的照片时可换更大一档的纸/尺寸，这张底片吃得下`
  }
  return '清晰度达标'
}

export interface EvalItemOptions {
  targetPpi: number
  /** 该清单项是否允许把底片转 90°（全局允许旋转 且 该尺寸允许旋转） */
  allowRotate: boolean
  /** 「调小」建议的备选尺寸库（内置 + 自定义） */
  candidates: PhotoSize[]
}

/**
 * 新建任务页预检：对清单项的标称尺寸评估。
 * 允许旋转时把「底片原方向」与「旋转 90°」两种摆法都算一遍，取实际 ppi 更高的方向
 * （排样器在允许旋转时也会自动选择摆法）。
 */
export function evaluateItem(item: Item, size: PhotoSize, opts: EvalItemOptions): SharpEval {
  const ref = item.photo
  if (!ref) return unknownEval(size.wMm, size.hMm, opts.targetPpi)
  const variants: OrientationInput[] = [{ ref, wMm: size.wMm, hMm: size.hMm, rotated: false }]
  if (opts.allowRotate && Math.abs(size.wMm - size.hMm) > 1e-6) {
    variants.push({ ref, wMm: size.hMm, hMm: size.wMm, rotated: true })
  }
  let best = evalOrientation(variants[0], opts.targetPpi)
  for (let i = 1; i < variants.length; i++) {
    const cand = evalOrientation(variants[i], opts.targetPpi)
    if ((cand.ppi ?? 0) > (best.ppi ?? 0)) best = cand
  }
  return { ...best, advice: buildAdvice(best, ref, size, opts.candidates, opts.allowRotate) }
}

/**
 * 落版复核：按照片最终落在纸上的实际矩形（placement.w/h，已含实际旋转方向）
 * 重新计算清晰度。底片按 copyIndex 解析（「只出现一次」时每张各是一张底片）。
 */
export function evaluatePlacement(
  ref: PhotoRef | undefined,
  p: Placement,
  targetPpi: number,
): SharpEval {
  if (!ref) return unknownEval(p.w, p.h, targetPpi)
  const e = evalOrientation({ ref, wMm: p.w, hMm: p.h, rotated: p.rotated }, targetPpi)
  return { ...e, advice: adviceForPlacement(e.level) }
}

function adviceForPlacement(level: SharpLevel): string {
  if (level === 'bad') return '落版尺寸下达不到目标清晰度：请换更大像素的底片，或回到清单把这张调小'
  if (level === 'warn') return '落版尺寸下清晰度临界：近看会略糊，建议换底片或调小后再印'
  if (level === 'ok') return '落版尺寸下清晰度达标'
  return '未导入底片，无法复核清晰度'
}

export interface PreflightSummary {
  checked: number
  ok: number
  warn: number
  bad: number
  unknown: number
  /** 要处理 = 不达标（warn + bad）的有底片照片数 */
  action: number
  /** 是否存在被拦住的项（blockBelowTarget 开启时存在 bad/warn 即拦截；unknown 不拦） */
  blocked: boolean
}

/**
 * 汇总一批落版复核结果。
 * block 语义：开启「拦住不达标」时，warn 与 bad 都视为不达标而拦住导出/继续；
 * 未导入底片（unknown）只是信息提示，不拦截。
 */
export function summarize(evals: SharpEval[], blockBelowTarget: boolean): PreflightSummary {
  const s: PreflightSummary = {
    checked: 0,
    ok: 0,
    warn: 0,
    bad: 0,
    unknown: 0,
    action: 0,
    blocked: false,
  }
  for (const e of evals) {
    s[e.level]++
    if (e.level !== 'unknown') s.checked++
  }
  s.action = s.warn + s.bad
  s.blocked = blockBelowTarget && s.action > 0
  return s
}

/** 便捷：一组 sheets 上每个 placement 的复核结果（按 seq 索引） */
export function evaluateSheets(
  sheets: Sheet[],
  refOf: (p: Placement) => PhotoRef | undefined,
  targetPpi: number,
): Map<number, SharpEval> {
  const map = new Map<number, SharpEval>()
  for (const sheet of sheets) {
    for (const p of sheet.placements) {
      map.set(p.seq, evaluatePlacement(refOf(p), p, targetPpi))
    }
  }
  return map
}

/* ---------- 文案格式 ---------- */

export function formatMmPair(w: number, h: number): string {
  return `${round(Math.min(w, h), 1)}×${round(Math.max(w, h), 1)}mm`
}

export function levelLabel(level: SharpLevel): string {
  switch (level) {
    case 'ok':
      return '达标'
    case 'warn':
      return '临界'
    case 'bad':
      return '不达标'
    case 'unknown':
      return '无底片'
  }
}

export function gapText(e: SharpEval): string {
  if (e.level === 'unknown' || e.ppi === undefined) return '—'
  if (e.level === 'ok') return `富余 ${round(e.ppi - e.targetPpi, 0)}ppi`
  return `差 ${e.gapPpi}ppi（约 ${e.gapPx}px）`
}
