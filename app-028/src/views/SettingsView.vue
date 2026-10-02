<script setup lang="ts">
import { computed, ref } from 'vue'
import { DEFAULT_SETTINGS, settings } from '../store'
import { runSelfTest, type AssertionResult } from '../logic/selfTest'

const results = ref<AssertionResult[]>([])
const running = ref(false)
const error = ref('')

const passed = computed(() => results.value.filter((r) => r.pass).length)
const totalMs = computed(() => results.value.reduce((a, r) => a + r.ms, 0))

async function run() {
  running.value = true
  error.value = ''
  results.value = []
  try {
    results.value = await runSelfTest()
  } catch (e) {
    error.value = `自检执行异常：${e instanceof Error ? e.message : String(e)}`
  } finally {
    running.value = false
  }
}

function reset() {
  settings.value = { ...DEFAULT_SETTINGS }
}
</script>

<template>
  <div class="stack">
    <div class="row">
      <h1 style="margin: 0">裁切参数</h1>
      <span class="badge brand">新建任务时的默认值</span>
      <div class="spacer"></div>
      <button class="btn" @click="reset">恢复默认</button>
    </div>

    <div class="grid cols-2">
      <div class="card">
        <h3>刀口与安全边</h3>
        <div class="card-sub">参数只影响新建任务的默认值，已有任务可在新建页单独调整</div>
        <div class="stack">
          <label class="field">
            相邻照片间距 gapMm：{{ settings.gapMm }} mm
            <input v-model.number="settings.gapMm" type="range" min="0" max="10" step="0.5" />
          </label>
          <div class="note">gap = 0 时相邻照片共边，切割线会自动合并成一条，减少裁切次数</div>
          <label class="field">
            最小裁切余量（刀宽补偿）kerfMm：{{ settings.kerfMm }} mm
            <input v-model.number="settings.kerfMm" type="range" min="0" max="3" step="0.1" />
          </label>
          <div class="note">
            刀宽补偿从照片外侧向内缩：每张照片分到的切块比照片大 kerf，切割线落在照片外 kerf/2 处，照片本身仍是标称尺寸
          </div>
          <label class="field">
            四周安全边 safeEdgeMm：{{ settings.safeEdgeMm }} mm
            <input v-model.number="settings.safeEdgeMm" type="range" min="0" max="20" step="0.5" />
          </label>
          <div class="note">
            所有照片必须落在 [纸边留白 + 安全边, 纸张尺寸 − 纸边留白 − 安全边] 范围内
          </div>
          <label class="check">
            <input v-model="settings.allowRotate" type="checkbox" />
            默认允许整体旋转 90°
          </label>
          <label class="field" style="max-width: 200px">
            默认位图导出 DPI
            <select v-model.number="settings.exportDpi">
              <option :value="150">150 dpi</option>
              <option :value="300">300 dpi</option>
              <option :value="600">600 dpi</option>
            </select>
          </label>
        </div>
      </div>

      <div class="card">
        <h3>印前清晰度预检</h3>
        <div class="card-sub">存为本机设置，下次新建任务自动沿用；预检只读取底片像素尺寸，不上传、不留副本</div>
        <div class="stack">
          <label class="field" style="max-width: 320px">
            目标清晰度：{{ settings.targetDpi }} dpi
            <select v-model.number="settings.targetDpi">
              <option :value="200">200 dpi · 远观/海报</option>
              <option :value="240">240 dpi · 报纸/普通冲印</option>
              <option :value="300">300 dpi · 标准冲印（推荐）</option>
              <option :value="350">350 dpi · 精印</option>
              <option :value="600">600 dpi · 特写/证件照精印</option>
            </select>
          </label>
          <div class="note">
            预检口径：底片按要印尺寸的长宽比先 cover 裁切，再算裁切后实际有效 DPI。
            有效 DPI ≥ 目标为达标；在目标的 85%~100% 之间标「偏低」（黄色）；低于 85% 标「严重不足」（红色）。
          </div>
          <label class="check">
            <input v-model="settings.blockOnPreflightFail" type="checkbox" />
            拦住不达标的项：新建任务排样、以及最终导出前，存在「偏低/严重不足」的照片时阻止继续（可在页面上单次跳过）
          </label>
        </div>
      </div>

      <div class="card">
        <h3>
          第 10 节验收自检
          <span class="row tight">
            <span v-if="results.length" class="badge" :class="passed === results.length ? 'ok' : 'danger'">
              {{ passed }}/{{ results.length }} 通过
            </span>
            <button class="btn primary small" :disabled="running" @click="run">
              {{ running ? '运行中…' : '运行全部断言' }}
            </button>
          </span>
        </h3>
        <div class="card-sub">
          在浏览器里真实跑 100 组随机排样、单位换算、导出几何与性能断言，全部在本地完成
        </div>
        <div v-if="error" class="note danger">{{ error }}</div>
        <div v-if="!results.length && !running" class="note">
          点击「运行全部断言」开始自检；结果会显示每条验收用例的通过情况与关键数据
        </div>
        <div v-if="results.length" class="stack">
          <div
            v-for="r in results"
            :key="r.id"
            class="note"
            :class="r.pass ? 'ok' : 'danger'"
          >
            <div class="row" style="justify-content: space-between">
              <strong>{{ r.pass ? '通过' : '失败' }} · {{ r.title }}</strong>
              <span class="mono" style="font-size: 11.5px">{{ r.ms }}ms</span>
            </div>
            <div style="margin-top: 4px">{{ r.detail }}</div>
          </div>
          <div class="note">自检总耗时 {{ totalMs }}ms</div>
        </div>
      </div>
    </div>

    <div class="card">
      <h3>实现说明</h3>
      <div class="kv">
        <dt>排样算法</dt>
        <dd>空闲矩形 + 整边切分（guillotine split）+ best-fit</dd>
        <dt>切割线生成</dt>
        <dd>递归二分拆解 → 共边合并 → 逐步重放校验</dd>
        <dt>单位</dt>
        <dd>内部一律 mm，仅导出时按 DPI 换算像素</dd>
        <dt>数据存储</dt>
        <dd>localStorage（任务/尺寸库/余料），照片只在本机内存</dd>
      </div>
    </div>
  </div>
</template>
