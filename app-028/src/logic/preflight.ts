/**
 * 印前清晰度预检（纯本地计算，无任何网络请求）
 *
 * 判定口径：
 * - 照片按「填满不拉伸」（cover）方式裁成要印的长宽比，先算裁切后还剩多少像素；
 * - 实际有效 DPI = min(裁切后宽 / 印件宽, 裁切后高 / 印件高) × 25.4；
 * - 与目标清晰度（DPI）比较：>= 目标 合格；[目标×0.85, 目标) 偏低（警告）；< 目标×0.85 严重不足。
 *
 * 底片只读取像素尺寸，全部在浏览器内存中完成，不上传、不留副本。
 */
import { findPhotoSize } from './library'
import type { Item, PhotoRef, PhotoSize, Placement, Sheet, Task } from './types'

export type PreflightLevel = 'pass' | 'warn' | 'danger'

export type PreflightAdviceKind = 'keep' | 'shrink' | 'enlarge-source'

export interface PreflightAdvice {
  kind: PreflightAdviceKind
  /** 一句话建议（换更大的原片 / 把这张调小 / 可直接印） */
  summary: string
  /** 建议改印的尺寸（kind = shrink 时存在） */
  shrinkTo?: PhotoSize
  /** 建议细节说明 */
  detail: string
}

export interface PreflightVerdict {
  /** 参与预检的底片（未导入底片时为 undefined） */
  photo: PhotoRef | undefined
  /** 要印的物理尺寸（含旋转后的方向），mm */
  printWMm: number
  printHMm: number
  rotated: boolean
  /** cover 裁切后用于印刷的像素区域 */
  cropWPx: number
  cropHPx: number
  /** 实际有效 DPI（裁切后短边口径） */
  effectiveDpi: number
  targetDpi: number
  /** 有效 DPI / 目标 DPI */
  ratio: number
  level: PreflightLevel
  pass: boolean
  /** 离目标差多少 DPI（达标时为 0） */
  dpiShortfall: number
  /** 还缺多少像素（宽、高，按印件方向） */
  pxShortfallW: number
  pxShortfallH: number
  /** cover 裁掉的像素比例 0~1（长宽比失配造成的损耗） */
  cropLoss: number
  /** 这张底片在目标 DPI 下最多能印多大（保持与印件同长宽比），mm */
  maxPrintWMm: number
  maxPrintHMm: number
  /** 不裁切（保留整张底片、允许留白）时的最大边长 mm */
  maxNativeLongMm: number
  advice: PreflightAdvice
}

export interface PlacementPreflight {
  seq: number
  itemId: string
  sheetIndex: number
  verdict: PreflightVerdict | undefined
  /** 未导入底片：无法预检，不算合格也不算不合格 */
  noSource: boolean
}

export interface PreflightSummary {
  /** 有底片、实际参与预检的印件数 */
  checked: number
  /** 未导入底片、未参与预检的印件数 */
  noSource: number
  passed: number
  warned: number
  dangers: number
  /** 未达标（warn + danger）的印件数 */
  toHandle: number
  total: number
  blocked: boolean
  worst: PreflightLevel
}

const MM_PER_INCH = 25.4
/** warn 阈值：有效 DPI 达到目标的 85% 只给警告，低于此为严重不足 */
export const WARN_RATIO = 0.85

/** 可选旋转中 cover 裁切后有效像素较短边的最大值对应的方案 */
function bestCoverCrop(
  ref: PhotoRef,
  printWMm: number,
  printHMm: number,
  allowRotate: boolean,
): { cropW: number; cropH: number; rotated: boolean } {
  const options: Array<[number, number, boolean]> = [
    [printWMm, printHMm, false],
    ...(allowRotate ? ([[printHMm, printWMm, true]] as Array<[number, number, boolean]>) : []),
  ]
  let best = { cropW: 0, cropH: 0, rotated: false, min: -1 }
  for (const [wMm, hMm, rotated] of options) {
    const s = Math.max(wMm / ref.wPx, hMm / ref.hPx)
    const cropW = Math.min(ref.wPx, wMm / s)
    const cropH = Math.min(ref.hPx, hMm / s)
    const min = Math.min(cropW / wMm, cropH / hMm)
    if (min > best.min) best = { cropW, cropH, rotated, min }
  }
  return { cropW: best.cropW, cropH: best.cropH, rotated: best.rotated }
}

/** cover 裁切比例（与朝向无关，只用长宽比） */
function coverScale(refW: number, refH: number, targetW: number, targetH: number): number {
  return Math.max(targetW / refW, targetH / refH)
}

/** 按目标 DPI 反推：这张底片保持指定长宽比时最多能印的物理尺寸（mm） */
export function maxPrintSizeMm(
  ref: PhotoRef,
  aspectWMm: number,
  aspectHMm: number,
  targetDpi: number,
): { wMm: number; hMm: number } {
  // 先取整张底片在目标 DPI 下的物理尺寸
  const fullWMm = (ref.wPx * MM_PER_INCH) / targetDpi
  const fullHMm = (ref.hPx * MM_PER_INCH) / targetDpi
  // 再按目标长宽比 cover 收缩（比例失配时向内缩）
  const s = coverScale(fullWMm, fullHMm, aspectWMm, aspectHMm)
  return { wMm: aspectWMm / s, hMm: aspectHMm / s }
}

function levelOf(ratio: number): PreflightLevel {
  if (ratio >= 1) return 'pass'
  if (ratio >= WARN_RATIO) return 'warn'
  return 'danger'
}

function fmtMm(n: number): string {
  return `${n.toFixed(0)}mm`
}

/**
 * 给出处理建议：
 * - 合格：可直接印；
 * - 不达标时优先看「调小」：尺寸库里存在更小尺寸，且换过去后这张底片能达标 → 建议把这张调小；
 * - 否则只能换更大的原片（更大的底片/原始文件），并给出原片最少要多少像素。
 */
function buildAdvice(
  ref: PhotoRef,
  printWMm: number,
  printHMm: number,
  allowRotate: boolean,
  targetDpi: number,
  ratio: number,
  maxW: number,
  maxH: number,
  sizes: PhotoSize[],
  currentSizeId: string,
): PreflightAdvice {
  if (ratio >= 1) {
    return { kind: 'keep', summary: '可直接印，清晰度达标', detail: '' }
  }

  // 找「调小」候选：比当前印件面积小、换印后能达标，取其中面积最大（最接近原尺寸）的一个
  // （直接用纯数值 core 评估候选，避免递归；是否允许旋转由候选自身朝向决定）
  const current = findPhotoSize(sizes, currentSizeId)
  const currentArea = current ? current.wMm * current.hMm : printWMm * printHMm
  let candidate: PhotoSize | undefined
  let candidateRatio = 0
  for (const s of sizes) {
    if (s.id === currentSizeId || s.wMm * s.hMm >= currentArea * 0.999) continue
    const v = evaluateCore(ref, s.wMm, s.hMm, allowRotate, targetDpi)
    if (v.ratio >= 1 && s.wMm * s.hMm > (candidate ? candidate.wMm * candidate.hMm : 0)) {
      candidate = s
      candidateRatio = v.ratio
    }
  }
  if (candidate) {
    return {
      kind: 'shrink',
      summary: `建议把这张调小到「${candidate.name}」（${candidate.wMm}×${candidate.hMm}mm）`,
      shrinkTo: candidate,
      detail: `调小后有效清晰度约 ${(candidateRatio * targetDpi).toFixed(0)}dpi，可达标；当前尺寸最多只能印 ${fmtMm(maxW)}×${fmtMm(maxH)}。`,
    }
  }

  // 无法通过调小解决 → 必须换更大的原片
  const needW = Math.ceil((printWMm / MM_PER_INCH) * targetDpi)
  const needH = Math.ceil((printHMm / MM_PER_INCH) * targetDpi)
  const cropPct = Math.round(coverCropLoss(ref, printWMm, printHMm, allowRotate) * 100)
  const ratioHint =
    cropPct >= 8
      ? `当前底片与要印的长宽比不一致，cover 裁掉了约 ${cropPct}% 的像素；换更大的纸/更大原片时请优先选长宽比接近 ${printWMm}:${printHMm} 的底片。`
      : '当前底片总像素不够，裁切损耗不大，换一张像素更高的原片即可。'
  return {
    kind: 'enlarge-source',
    summary: `建议换更大的原片：至少需要 ${needW}×${needH}px（${targetDpi}dpi）`,
    detail: `这张即便不裁切，最多也只能印 ${fmtMm(maxW)}×${fmtMm(maxH)}（整张保留边长约 ${fmtMm(
      (Math.max(ref.wPx, ref.hPx) * MM_PER_INCH) / targetDpi,
    )}）；调小到尺寸库内任何更小尺寸仍不达标。${ratioHint}`,
  }
}

/** cover 裁掉的像素占比（考虑可选旋转） */
export function coverCropLoss(
  ref: PhotoRef,
  printWMm: number,
  printHMm: number,
  allowRotate: boolean,
): number {
  const opts: Array<[number, number]> = [
    [printWMm, printHMm],
    ...(allowRotate ? ([[printHMm, printWMm]] as Array<[number, number]>) : []),
  ]
  let bestLoss = 1
  for (const [w, h] of opts) {
    const s = Math.max(w / ref.wPx, h / ref.hPx)
    const used = Math.min(ref.wPx, w / s) * Math.min(ref.hPx, h / s)
    bestLoss = Math.min(bestLoss, 1 - used / (ref.wPx * ref.hPx))
  }
  return bestLoss
}

/** 纯数值预检（不含建议、不依赖尺寸库） */
function evaluateCore(
  ref: PhotoRef,
  printWMm: number,
  printHMm: number,
  allowRotate: boolean,
  targetDpi: number,
): Omit<PreflightVerdict, 'advice' | 'photo'> {
  const { cropW, cropH, rotated } = bestCoverCrop(ref, printWMm, printHMm, allowRotate)
  const dpiW = (cropW / printWMm) * MM_PER_INCH
  const dpiH = (cropH / printHMm) * MM_PER_INCH
  const effectiveDpi = Math.min(dpiW, dpiH)
  const ratio = targetDpi > 0 ? effectiveDpi / targetDpi : 1
  const level = levelOf(ratio)
  const pass = level === 'pass'
  const needW = (printWMm / MM_PER_INCH) * targetDpi
  const needH = (printHMm / MM_PER_INCH) * targetDpi
  const max = maxPrintSizeMm(ref, printWMm, printHMm, targetDpi)
  const used = cropW * cropH
  return {
    printWMm,
    printHMm,
    rotated,
    cropWPx: Math.round(cropW),
    cropHPx: Math.round(cropH),
    effectiveDpi,
    targetDpi,
    ratio,
    level,
    pass,
    dpiShortfall: pass ? 0 : targetDpi - effectiveDpi,
    pxShortfallW: pass ? 0 : Math.max(0, Math.ceil(needW - cropW)),
    pxShortfallH: pass ? 0 : Math.max(0, Math.ceil(needH - cropH)),
    cropLoss: 1 - used / (ref.wPx * ref.hPx),
    maxPrintWMm: max.wMm,
    maxPrintHMm: max.hMm,
    maxNativeLongMm: (Math.max(ref.wPx, ref.hPx) * MM_PER_INCH) / targetDpi,
  }
}

/**
 * 单张底片 vs 一个要印的物理尺寸 → 预检结论。
 * sizes/currentSizeId 仅用于生成「调小」建议，纯数值场景可不传。
 */
export function evaluatePhoto(
  ref: PhotoRef,
  printWMm: number,
  printHMm: number,
  allowRotate: boolean,
  targetDpi: number,
  sizes: PhotoSize[] = [],
  currentSizeId = '',
): PreflightVerdict {
  const core = evaluateCore(ref, printWMm, printHMm, allowRotate, targetDpi)
  const advice = core.pass
    ? ({ kind: 'keep', summary: '可直接印，清晰度达标', detail: '' } satisfies PreflightAdvice)
    : buildAdvice(
        ref,
        printWMm,
        printHMm,
        allowRotate,
        targetDpi,
        core.ratio,
        core.maxPrintWMm,
        core.maxPrintHMm,
        sizes,
        currentSizeId,
      )
  return { photo: ref, ...core, advice }
}

/** 取某个排样印件实际使用的底片（重复排 → 第 0 张；只出现一次 → 按序号取） */
export function refForPlacement(
  task: Task,
  p: Placement,
  copyIndex: number,
  getRef: (key: string) => PhotoRef | undefined,
): PhotoRef | undefined {
  const item = task.items.find((i) => i.id === p.itemId)
  if (!item) return undefined
  const idx = item.repeatSamePhoto ? 0 : copyIndex
  return getRef(`${item.id}#${idx}`) ?? item.photo
}

/** 新建任务页：清单一行（item）在当前尺寸下的预检结论 */
export function evaluateItem(
  item: Item,
  size: PhotoSize,
  allowRotateGlobal: boolean,
  targetDpi: number,
  sizes: PhotoSize[],
  ref?: PhotoRef,
): PreflightVerdict | undefined {
  if (!ref) return undefined
  const allowRotate = allowRotateGlobal && item.rotateAllowed
  return evaluatePhoto(ref, size.wMm, size.hMm, allowRotate, targetDpi, sizes, item.sizeId)
}

/** 排样定稿后：按每张照片实际落在哪张纸、实际印成多大（含旋转）复核 */
export function evaluatePlacement(
  p: Placement,
  ref: PhotoRef | undefined,
  targetDpi: number,
  sizes: PhotoSize[],
  sizeId: string,
): PreflightVerdict | undefined {
  if (!ref) return undefined
  // 排样方向已定：不允许在复核阶段再换方向，按 p.w/p.h 的实际朝向评估
  return evaluatePhoto(ref, p.w, p.h, false, targetDpi, sizes, sizeId)
}

export interface PreflightBundle {
  bySeq: Map<number, PlacementPreflight>
  list: PlacementPreflight[]
  summary: PreflightSummary
}

/** 汇总一批印件的预检结论 */
export function summarizePlacements(
  entries: Array<{ verdict?: PreflightVerdict }>,
  blockOnFail: boolean,
): PreflightSummary {
  let checked = 0
  let noSource = 0
  let passed = 0
  let warned = 0
  let dangers = 0
  for (const e of entries) {
    if (!e.verdict) {
      noSource++
      continue
    }
    checked++
    if (e.verdict.level === 'pass') passed++
    else if (e.verdict.level === 'warn') warned++
    else dangers++
  }
  const toHandle = warned + dangers
  const blocked = blockOnFail && toHandle > 0
  const worst: PreflightLevel = dangers > 0 ? 'danger' : warned > 0 ? 'warn' : 'pass'
  return {
    checked,
    noSource,
    passed,
    warned,
    dangers,
    toHandle,
    total: entries.length,
    blocked,
    worst,
  }
}

/** 对整套排样做印前复核（sheets 为最终生效版面） */
export function preflightSheets(
  task: Task,
  sheets: Sheet[],
  sizes: PhotoSize[],
  targetDpi: number,
  blockOnFail: boolean,
  getRef: (key: string) => PhotoRef | undefined,
): PreflightBundle {
  const counter = new Map<string, number>()
  const bySeq = new Map<number, PlacementPreflight>()
  const list: PlacementPreflight[] = []
  for (const sheet of sheets) {
    for (const p of sheet.placements) {
      const ci = counter.get(p.itemId) ?? 0
      counter.set(p.itemId, ci + 1)
      const item = task.items.find((i) => i.id === p.itemId)
      const ref = refForPlacement(task, p, ci, getRef)
      const verdict = item
        ? evaluatePlacement(
            p,
            ref,
            targetDpi,
            sizes,
            item.sizeId,
          )
        : undefined
      const row: PlacementPreflight = {
        seq: p.seq,
        itemId: p.itemId,
        sheetIndex: p.sheetIndex,
        verdict,
        noSource: !verdict,
      }
      bySeq.set(p.seq, row)
      list.push(row)
    }
  }
  const summary = summarizePlacements(list, blockOnFail)
  return { bySeq, list, summary }
}
