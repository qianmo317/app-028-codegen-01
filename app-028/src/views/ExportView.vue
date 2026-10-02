<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import RulerScale from '../components/RulerScale.vue'
import SheetView from '../components/SheetView.vue'
import {
  allPapers,
  allSizes,
  getTask,
  getItemPhotoRef,
  makePhotoResolver,
  makeThumbResolver,
  photoVersion,
  settings,
  sheetsOf,
} from '../store'
import { computeCost } from '../logic/cost'
import { cutListRows, csvBlob } from '../logic/csv'
import { downloadBlob } from '../logic/image'
import { findPhotoSize, resolvePaper } from '../logic/library'
import { buildPdf } from '../logic/pdf'
import { buildSheetPng } from '../logic/png'
import { preflightSheets, type PreflightLevel } from '../logic/preflight'
import { formatCents, formatPercent } from '../logic/units'
import type { Placement, Task } from '../logic/types'

const route = useRoute()
const router = useRouter()

const task = computed<Task | undefined>(() => getTask(String(route.params.id)))
const paper = computed(() => (task.value ? resolvePaper(task.value, allPapers.value) : allPapers.value[0]))
const sheets = computed(() => (task.value ? sheetsOf(task.value) : []))
const valid = computed(() => !task.value?.manual || task.value.manual.valid)
const cost = computed(() => (task.value?.result ? computeCost(paper.value, task.value.result) : undefined))
const dpi = ref(300)
const busy = ref(false)
const message = ref('')

const thumbs = computed(() => {
  void photoVersion.value
  return task.value ? makeThumbResolver(task.value, sheets.value) : () => undefined
})

function photoResolver() {
  void photoVersion.value
  return task.value ? makePhotoResolver(task.value, sheets.value) : () => undefined
}

/** 导出前最后一次印前复核：按最终纸面与实际印成尺寸汇总 */
const preflight = computed(() => {
  void photoVersion.value
  if (!task.value) return undefined
  return preflightSheets(
    task.value,
    sheets.value,
    allSizes.value,
    settings.value.targetDpi,
    settings.value.blockOnPreflightFail,
    getItemPhotoRef,
  )
})

const pfSummary = computed(() => preflight.value?.summary)
/** 拦截生效（本机设置开关且存在不达标项）；用户可勾选「我已知情，仍要导出」单次放行 */
const pfOverride = ref(false)
const pfBlocked = computed(() => (pfSummary.value?.blocked ?? false) && !pfOverride.value)

function severityOf(p: Placement): PreflightLevel | undefined {
  return preflight.value?.bySeq.get(p.seq)?.verdict?.level
}

const flagged = computed(() =>
  (preflight.value?.list ?? []).filter((r) => r.verdict && !r.verdict.pass),
)

watch(
  () => route.params.id,
  () => {
    pfOverride.value = false
  },
)

function sizeLabelOf(p: Placement): string {
  const t = task.value
  if (!t) return ''
  const item = t.items.find((i) => i.id === p.itemId)
  const s = item ? findPhotoSize(allSizes.value, item.sizeId) : undefined
  return s ? `${s.name} ${s.wMm}x${s.hMm}` : `${p.w.toFixed(1)}x${p.h.toFixed(1)}`
}

function guard(): boolean {
  if (!task.value) return false
  if (!valid.value) {
    message.value = '手工微调后的排样不满足 guillotine 贯通裁切，请先修正或恢复自动排样'
    return false
  }
  if (!sheets.value.length) {
    message.value = '没有可导出的版面'
    return false
  }
  if (pfBlocked.value) {
    message.value =
      '印前预检未通过：存在清晰度不达标的照片。请先处理（换更大的原片 / 调小尺寸），或勾选下方「我已知情，仍要导出」'
    return false
  }
  return true
}

async function exportPdf() {
  if (!guard() || busy.value) return
  busy.value = true
  message.value = '正在生成 PDF…'
  try {
    const blob = await buildPdf({
      task: task.value!,
      paper: paper.value,
      sheets: sheets.value,
      photoOf: photoResolver(),
      sizeLabelOf,
      onProgress: (m) => (message.value = m),
    })
    downloadBlob(blob, `${task.value!.name}-1to1.pdf`)
    message.value = `PDF 已导出（${(blob.size / 1024).toFixed(0)}KB，${sheets.value.length + 1} 页）`
  } catch (e) {
    message.value = `PDF 导出失败：${e instanceof Error ? e.message : String(e)}`
  } finally {
    busy.value = false
  }
}

async function exportPng(index: number) {
  if (!guard() || busy.value) return
  busy.value = true
  try {
    const sheet = sheets.value[index]
    const blob = await buildSheetPng({
      task: task.value!,
      paper: paper.value,
      sheet,
      dpi: dpi.value,
      photoOf: photoResolver(),
      sizeLabelOf,
    })
    downloadBlob(blob, `${task.value!.name}-sheet${index + 1}-${dpi.value}dpi.png`)
    message.value = `第 ${index + 1} 张 PNG 已导出（${dpi.value}dpi，1:1）`
  } catch (e) {
    message.value = `PNG 导出失败：${e instanceof Error ? e.message : String(e)}`
  } finally {
    busy.value = false
  }
}

async function exportAllPng() {
  if (!guard() || busy.value) return
  busy.value = true
  try {
    for (let i = 0; i < sheets.value.length; i++) {
      message.value = `正在导出第 ${i + 1}/${sheets.value.length} 张…`
      const blob = await buildSheetPng({
        task: task.value!,
        paper: paper.value,
        sheet: sheets.value[i],
        dpi: dpi.value,
        photoOf: photoResolver(),
        sizeLabelOf,
      })
      downloadBlob(blob, `${task.value!.name}-sheet${i + 1}-${dpi.value}dpi.png`)
      await new Promise((r) => setTimeout(r, 250))
    }
    message.value = `已导出 ${sheets.value.length} 张 1:1 PNG（${dpi.value}dpi）`
  } catch (e) {
    message.value = `PNG 导出失败：${e instanceof Error ? e.message : String(e)}`
  } finally {
    busy.value = false
  }
}

function exportCutList() {
  if (!guard()) return
  const rows = cutListRows(task.value!, paper.value, sheets.value, (seq) => {
    for (const s of sheets.value) {
      const p = s.placements.find((x) => x.seq === seq)
      if (p) return sizeLabelOf(p)
    }
    return ''
  })
  downloadBlob(csvBlob(rows), `${task.value!.name}-切割清单.csv`)
  message.value = '切割清单 CSV 已导出'
}

function exportCost() {
  const t = task.value
  const c = cost.value
  if (!t || !c) return
  const rows: Array<Array<string | number>> = [
    ['任务', t.name],
    ['相纸', c.paperName],
    ['相纸单价（元）', (paper.value.priceCents / 100).toFixed(2)],
    ['用纸张数', c.sheets],
    ['照片总数', c.totalPhotoCount],
    ['总材料成本（元）', (c.totalCents / 100).toFixed(2)],
    ['每张照片摊薄成本（元）', (c.perPhotoCents / 100).toFixed(4)],
    ['本方案利用率', formatPercent(t.result?.stats.avgUtilization ?? 0)],
    ['本方案浪费率', formatPercent(c.wasteRate)],
    ['不排样逐张打印成本（元）', (c.naiveTotalCents / 100).toFixed(2)],
    ['不排样逐张打印浪费率', formatPercent(c.naiveWasteRate)],
    ['节省（元）', (c.savedCents / 100).toFixed(2)],
    [],
    ['照片编号', '所在相纸', '尺寸', '宽 mm', '高 mm', '旋转'],
  ]
  for (const s of sheets.value) {
    for (const p of s.placements) {
      rows.push([p.seq, s.index + 1, sizeLabelOf(p), p.w, p.h, p.rotated ? '90°' : '无'])
    }
  }
  downloadBlob(csvBlob(rows), `${task.value!.name}-成本表.csv`)
  message.value = '成本表 CSV 已导出'
}

function printView() {
  if (!guard()) return
  window.print()
}
</script>

<template>
  <div v-if="!task" class="card">
    <h2>任务不存在</h2>
    <p>请回到<a href="/">新建任务</a>页重新创建。</p>
  </div>
  <div v-else class="stack">
    <div class="row no-print">
      <h1 style="margin: 0">导出与打印</h1>
      <span class="badge brand">{{ task.name }}</span>
      <span class="badge">{{ sheets.length }} 张相纸</span>
      <div class="spacer"></div>
      <button class="btn" @click="router.push(`/cut/${task.id}`)">← 裁切步骤</button>
    </div>

    <div
      v-if="message"
      class="note no-print"
      :class="!valid ? 'danger' : pfBlocked ? 'warn' : 'ok'"
    >
      {{ message }}
    </div>
    <div v-if="!valid" class="note danger no-print">
      手工微调后的排样不满足 guillotine 贯通裁切，导出已停用：{{ task.manual?.message }}
    </div>

    <div class="card no-print">
      <h3>
        导出前 · 印前预检汇总
        <span class="row tight">
          <span class="badge ok">过关 {{ pfSummary?.passed ?? 0 }}</span>
          <span class="badge warn">偏低 {{ pfSummary?.warned ?? 0 }}</span>
          <span class="badge danger">不足 {{ pfSummary?.dangers ?? 0 }}</span>
          <span v-if="(pfSummary?.noSource ?? 0) > 0" class="badge">未导底片 {{ pfSummary?.noSource }}</span>
        </span>
      </h3>
      <div class="card-sub">
        按每张照片最终落在哪张纸、实际印成多大复核；目标清晰度 {{ settings.targetDpi }}dpi，全部在本机计算，底片不上传
      </div>
      <div v-if="!pfSummary || pfSummary.checked === 0" class="note">
        本批 {{ sheets.reduce((a, s) => a + s.placements.length, 0) }} 张照片均未导入底片，未做清晰度预检
      </div>
      <div v-else-if="pfSummary.toHandle === 0" class="note ok">
        本批共 {{ pfSummary.total }} 张：{{ pfSummary.checked }} 张已检并全部过关{{ pfSummary.noSource ? `，${pfSummary.noSource} 张未导底片未检` : '' }}，可以导出。
      </div>
      <template v-else>
        <div class="note" :class="pfSummary.dangers > 0 ? 'danger' : 'warn'">
          本批共 {{ pfSummary.total }} 张：{{ pfSummary.passed }} 张能过关，{{ pfSummary.toHandle }} 张要处理
          （偏低 {{ pfSummary.warned }}、严重不足 {{ pfSummary.dangers }}）
          <template v-if="pfSummary.noSource">，另 {{ pfSummary.noSource }} 张未导底片未检</template>。
        </div>
        <table class="data" style="margin-top: 8px">
          <thead>
            <tr>
              <th class="num">#</th>
              <th class="num">纸</th>
              <th class="num">实际印成 mm</th>
              <th class="num">有效/目标 dpi</th>
              <th class="num">最多能印 mm</th>
              <th>建议</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in flagged" :key="r.seq">
              <td class="num">{{ r.seq }}</td>
              <td class="num">{{ r.sheetIndex + 1 }}</td>
              <td class="num">{{ r.verdict!.printWMm.toFixed(0) }}×{{ r.verdict!.printHMm.toFixed(0) }}</td>
              <td class="num">
                <strong :style="{ color: r.verdict!.level === 'danger' ? 'var(--danger)' : 'var(--warn)' }">
                  {{ r.verdict!.effectiveDpi.toFixed(0) }}
                </strong>
                /{{ r.verdict!.targetDpi }}
              </td>
              <td class="num">{{ r.verdict!.maxPrintWMm.toFixed(0) }}×{{ r.verdict!.maxPrintHMm.toFixed(0) }}</td>
              <td>
                <strong>{{ r.verdict!.advice.summary }}</strong>
                <div v-if="r.verdict!.advice.detail" style="font-size: 12px; color: var(--ink-2)">
                  {{ r.verdict!.advice.detail }}
                </div>
              </td>
            </tr>
          </tbody>
        </table>
        <label v-if="settings.blockOnPreflightFail" class="check" style="margin-top: 10px">
          <input v-model="pfOverride" type="checkbox" />
          我已知情，仍要按当前版面导出（只本次放行，不改本机设置）
        </label>
      </template>
    </div>

    <div class="grid sidebar no-print">
      <div class="stack">
        <div class="card">
          <h3>导出文件</h3>
          <div class="card-sub">所有文件都在本机生成并直接下载，不上传任何数据</div>
          <div class="stack">
            <label class="field">
              位图导出 DPI
              <select v-model.number="dpi">
                <option :value="150">150 dpi</option>
                <option :value="300">300 dpi（推荐）</option>
                <option :value="600">600 dpi</option>
              </select>
            </label>
            <div class="row">
              <button class="btn primary" :disabled="busy" @click="exportPdf">
                导出 1:1 PDF（每张相纸一页 + 校验尺）
              </button>
            </div>
            <div class="row">
              <button class="btn" :disabled="busy" @click="exportAllPng">导出全部 1:1 PNG</button>
              <button class="btn" :disabled="busy" @click="exportPng(0)">仅当前第 1 张 PNG</button>
            </div>
            <div class="row">
              <button class="btn" @click="exportCutList">导出切割清单 CSV</button>
              <button class="btn" @click="exportCost">导出成本表 CSV</button>
              <button class="btn" @click="printView">打印视图（含校验尺）</button>
            </div>
          </div>
        </div>

        <div class="card">
          <h3>打印须知</h3>
          <div class="note warn">
            打印时必须在打印对话框里<strong>关闭「适应页面 / Fit to page」</strong>，选择「实际大小 / 100%」；
            否则尺寸会被整体缩放，1:1 不成立。打印后先用直尺量页面上的 100mm 校验尺确认。
          </div>
          <div class="kv" style="margin-top: 10px">
            <dt>相纸</dt>
            <dd>{{ paper.wMm }}×{{ paper.hMm }} mm</dd>
            <dt>页数</dt>
            <dd>{{ sheets.length }} 张相纸 + 1 页校验/清单</dd>
            <dt>含照片</dt>
            <dd>{{ sheets.reduce((a, s) => a + s.placements.length, 0) }} 张（有导入底片时嵌入）</dd>
          </div>
        </div>

        <div class="card">
          <h3>成本表</h3>
          <div v-if="cost" class="kv">
            <dt>相纸单价</dt>
            <dd>{{ formatCents(paper.priceCents) }}/张</dd>
            <dt>用纸张数</dt>
            <dd>{{ cost.sheets }}</dd>
            <dt>总材料成本</dt>
            <dd>{{ formatCents(cost.totalCents) }}</dd>
            <dt>每张照片摊薄</dt>
            <dd>{{ formatCents(cost.perPhotoCents) }}</dd>
            <dt>本方案浪费率</dt>
            <dd>{{ formatPercent(cost.wasteRate) }}</dd>
            <dt>逐张打印浪费率</dt>
            <dd>{{ formatPercent(cost.naiveWasteRate) }}</dd>
            <dt>对比逐张打印节省</dt>
            <dd>{{ formatCents(cost.savedCents) }}</dd>
          </div>
        </div>
      </div>

      <div class="card">
        <h3>排样示意图（带编号）</h3>
        <div class="card-sub">每张照片都有编号，和清单一一对应，方便对号入座</div>
        <div v-for="s in sheets" :key="s.index" style="margin-bottom: 16px">
          <div class="row" style="margin-bottom: 6px">
            <span class="badge">第 {{ s.index + 1 }} 张</span>
            <span class="badge">{{ s.cutSteps.length }} 刀</span>
            <span class="badge">利用率 {{ formatPercent(s.utilization) }}</span>
          </div>
          <div class="sheet-wrap">
            <SheetView
              :sheet="s"
              :paper="paper"
              :safe-edge-mm="task.safeEdgeMm"
              :scale="Math.max(0.5, Math.min(2.2, 700 / paper.wMm))"
              :thumb-of="thumbs"
              :severity-of="severityOf"
            />
          </div>
        </div>
      </div>
    </div>

    <!-- 打印版：每张相纸一页，尺寸按毫米精确渲染 -->
    <div class="print-only">
      <div v-for="s in sheets" :key="s.index" class="print-sheet" :style="{ width: `${paper.wMm}mm`, height: `${paper.hMm}mm` }">
        <SheetView
          :sheet="s"
          :paper="paper"
          :safe-edge-mm="0"
          unit="mm"
          :show-safe-area="false"
          :show-grid="false"
          :show-cut-labels="true"
          :header-text="task.headerText"
          :footer-text="task.footerText"
          :thumb-of="thumbs"
          :severity-of="severityOf"
        />
      </div>
      <div class="print-sheet" style="width: 210mm; height: 297mm; padding: 15mm 0 0 15mm">
        <h2 style="font-size: 16pt">打印校验页</h2>
        <p style="font-size: 9pt">
          请选择「实际大小 / 100%」打印，<strong>不要勾选「适应页面」</strong>。用直尺量下面这条线，必须正好 100mm。
        </p>
        <RulerScale unit="mm" :length-mm="100" />
        <p style="font-size: 9pt; margin-top: 10mm">
          相纸：{{ paper.name }} {{ paper.wMm }}×{{ paper.hMm }}mm ｜ 隙距 {{ task.gapMm }}mm ｜ 刀宽补偿
          {{ task.kerfMm }}mm ｜ 安全边 {{ task.safeEdgeMm }}mm
        </p>
      </div>
    </div>
  </div>
</template>
