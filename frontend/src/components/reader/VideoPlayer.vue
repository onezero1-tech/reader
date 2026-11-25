<script setup lang="ts">
/**
 * 视频源播放器(legado `bookSourceType=4`)。
 *
 * 播放地址一律来自 `/media` 代理(见 `utils/mediaContent.ts`), 由后端携带书源
 * headers 转发, 分片与 AES-128 密钥请求也因此能通过防盗链校验。
 *
 * HLS(.m3u8): 桌面 WebView(WebKitGTK / WebView2)与浏览器都没有原生 HLS 支持,
 * 用 hls.js 承载; 静态 import 会让所有纯文本阅读用户多下载半兆字节, 这里走
 * 动态 import, 按需加载。mp4/webm 等直链容器直接交给 <video>。
 *
 * 签名播放地址有时效: 章节正文缓存里存的是**当时的**地址, 放久了会 403。
 * 网络层致命错误时自动用 `forceRefresh` 重取一次正文(父组件监听 retry 事件),
 * 不需要用户手动清理缓存。
 */
import { onBeforeUnmount, ref, watch } from 'vue'

const props = defineProps<{
  /** 已代理(/media)的播放地址。 */
  src: string
  kind: 'hls' | 'mp4'
}>()

const emit = defineEmits<{
  /** 播放自然结束(父组件用来「自动连播下一集」)。 */
  (e: 'ended'): void
  /** 网络层致命错误, 父组件应刷新正文(拿新的签名地址)后重试。 */
  (e: 'reload'): void
}>()

const videoRef = ref<HTMLVideoElement>()
const failed = ref(false)
const loading = ref(true)
const hint = ref('')
/** 左下角状态条: 下载速度 + 可缓冲秒数, 用来区分「网速慢」还是「实现有问题」。 */
const statusText = ref('')

/** hls.js 实例; 非空时必须在卸载/换源时 destroy, 否则媒体流与缓冲不释放。 */
let hlsInstance: { destroy(): void } | null = null
/** 防御动态 import 返回后 src 已变化/组件已卸载的竞态。 */
let generation = 0

// ── 下载速度 / 缓冲监测 ──
//
// 「缓冲久」有两种成因: 网速慢(速度低、缓冲爬不动)或链路有问题(速度高却
// 不起播)。把两个指标都摆出来, 用户一眼能分清。
//
// - HLS: hls.js 的 FRAG_BUFFERED 事件带每个分片的字节数, 最可靠;
// - mp4: 浏览器直接用 <video> 拉流, 借 Resource Timing 统计 /media 响应
//   的字节数(WebView 若不产出该条目, 就只显示缓冲秒数)。
const SPEED_WINDOW_MS = 8000
interface SpeedSample {
  at: number
  bytes: number
}
let speedSamples: SpeedSample[] = []
let speedTimer: ReturnType<typeof setInterval> | null = null
let perfObserver: PerformanceObserver | null = null

function recordBytes(bytes: number) {
  if (bytes <= 0) return
  const now = performance.now()
  speedSamples.push({ at: now, bytes })
  const cutoff = now - SPEED_WINDOW_MS
  while (speedSamples.length > 0 && speedSamples[0].at < cutoff) speedSamples.shift()
}

/** 滑动窗口内的平均下载速度(B/s); 窗口内没有采样时返回 null。 */
function computeSpeed(): number | null {
  const now = performance.now()
  const cutoff = now - SPEED_WINDOW_MS
  while (speedSamples.length > 0 && speedSamples[0].at < cutoff) speedSamples.shift()
  if (speedSamples.length === 0) return null
  const spanMs = now - speedSamples[0].at
  const bytes = speedSamples.reduce((sum, s) => sum + s.bytes, 0)
  if (spanMs < 300 || bytes <= 0) return null
  return bytes / (spanMs / 1000)
}

function formatSpeed(bytesPerSecond: number): string {
  if (bytesPerSecond >= 1024 * 1024) {
    return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`
  }
  if (bytesPerSecond >= 1024) {
    return `${Math.round(bytesPerSecond / 1024)} KB/s`
  }
  return `${Math.round(bytesPerSecond)} B/s`
}

/** 当前播放点之后的可缓冲秒数; 元数据未就绪时返回 null。 */
function bufferedAhead(el: HTMLVideoElement): number | null {
  if (el.readyState === 0 || el.buffered.length === 0) return null
  const t = el.currentTime
  for (let i = 0; i < el.buffered.length; i++) {
    if (t >= el.buffered.start(i) - 0.01 && t <= el.buffered.end(i)) {
      return Math.max(0, el.buffered.end(i) - t)
    }
  }
  return null
}

function updateStatusText() {
  const el = videoRef.value
  if (!el || failed.value) {
    statusText.value = ''
    return
  }
  const parts: string[] = []
  const speed = computeSpeed()
  if (speed !== null) parts.push(`↓ ${formatSpeed(speed)}`)
  const ahead = bufferedAhead(el)
  if (ahead !== null) parts.push(`缓冲 ${Math.round(ahead)}s`)
  statusText.value = parts.join(' · ')
}

function startStatusTimer() {
  stopStatusTimer()
  speedSamples = []
  updateStatusText()
  speedTimer = setInterval(updateStatusText, 1000)
}

function stopStatusTimer() {
  if (speedTimer !== null) {
    clearInterval(speedTimer)
    speedTimer = null
  }
}

/** mp4 直链的字节统计: 观察 /media 响应的 Resource Timing 条目。 */
function observeResourceTiming() {
  if (perfObserver !== null) return
  try {
    perfObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const resource = entry as PerformanceResourceTiming
        if (!resource.name.includes('/media?')) continue
        const size = resource.transferSize || resource.encodedBodySize || resource.decodedBodySize || 0
        if (size > 0) recordBytes(size)
      }
    })
    perfObserver.observe({ type: 'resource', buffered: true } as PerformanceObserverInit)
  } catch {
    perfObserver = null
  }
}

function stopResourceTiming() {
  if (perfObserver !== null) {
    perfObserver.disconnect()
    perfObserver = null
  }
}

async function attach() {
  destroy()
  const el = videoRef.value
  if (!el || !props.src) return
  failed.value = false
  hint.value = ''
  loading.value = true
  const gen = ++generation
  startStatusTimer()

  if (props.kind === 'mp4') {
    // mp4 由 <video> 直接拉流(后端分块 Range 回传, 见 book_service
    // MEDIA_CHUNK_LIMIT), 速度靠 Resource Timing 统计 /media 响应。
    observeResourceTiming()
    el.src = props.src
    void el.play().catch(() => {})
    return
  }
  try {
    const mod = await import('hls.js')
    if (gen !== generation) return
    const Hls = mod.default
    if (!Hls.isSupported()) {
      // 极少数带原生 HLS 的 WebView(Safari 系)直接用 video.src。
      if (el.canPlayType('application/vnd.apple.mpegurl')) {
        el.src = props.src
        void el.play().catch(() => {})
      } else {
        loading.value = false
        failed.value = true
        hint.value = '当前环境不支持 HLS 播放'
      }
      return
    }
    const hls = new Hls({
      // 起播后尽量多缓冲: 网络抖动/慢 CDN 时不易卡顿。上限同时受
      // maxMaxBufferLength 与 maxBufferSize 约束, 内存不会无限增长。
      enableWorker: true,
      maxBufferLength: 60,
      maxMaxBufferLength: 180,
      maxBufferSize: 120 * 1000 * 1000,
      // 已播过的分片只留 30s, 避免长视频的内存膨胀。
      backBufferLength: 30,
    })
    hlsInstance = hls
    hls.loadSource(props.src)
    hls.attachMedia(el)
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      void el.play().catch(() => {})
    })
    // 分片缓冲完成事件带本分片字节数, 是下载速度最直接的来源。
    hls.on(Hls.Events.FRAG_BUFFERED, (_event, data) => {
      recordBytes(data.stats?.loaded ?? 0)
    })
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (!data.fatal || gen !== generation) return
      loading.value = false
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        // 签名过期的典型表现: 播放列表/分片 403。让父组件刷新正文再重试。
        emit('reload')
        return
      }
      failed.value = true
      hint.value = '视频加载失败，请点击重试'
      hls.destroy()
      if (hlsInstance === hls) hlsInstance = null
    })
  } catch {
    if (gen === generation) {
      loading.value = false
      failed.value = true
      hint.value = '播放组件加载失败'
    }
  }
}

function destroy() {
  generation++
  if (hlsInstance) {
    hlsInstance.destroy()
    hlsInstance = null
  }
  const el = videoRef.value
  if (el) {
    el.removeAttribute('src')
    el.load()
  }
  stopStatusTimer()
  stopResourceTiming()
  speedSamples = []
  statusText.value = ''
}

function retry() {
  emit('reload')
}

watch(() => props.src, attach, { immediate: true })
onBeforeUnmount(destroy)
</script>

<template>
  <div class="video-player">
    <div class="player-frame">
      <video
        ref="videoRef"
        controls
        playsinline
        preload="metadata"
        class="player-video"
        @ended="emit('ended')"
        @canplay="loading = false"
        @error="loading = false"
      ></video>
      <div v-if="loading && !failed" class="player-loading">
        <span class="player-spinner" aria-hidden="true"></span>
        <span>正在加载视频…</span>
      </div>
      <div v-if="statusText && !failed && !loading" class="player-status">{{ statusText }}</div>
      <div v-if="failed" class="player-error">
        <p>{{ hint || '视频加载失败' }}</p>
        <button type="button" class="player-retry" @click="retry">重试</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.video-player {
  width: 100%;
}

.player-frame {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  background: #000;
  border-radius: 8px;
  overflow: hidden;
}

.player-video {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: contain;
}

/* 下载速度/缓冲指示: 半透明贴在左下角, 不挡控制条(控制条在底部整行)。 */
.player-status {
  position: absolute;
  left: 10px;
  bottom: 44px;
  padding: 3px 10px;
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.55);
  color: #ddd;
  font-size: 12px;
  line-height: 1.6;
  pointer-events: none;
  z-index: 1;
}

.player-loading,
.player-error {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: #eee;
  font-size: 14px;
  background: rgba(0, 0, 0, 0.55);
}

.player-error p {
  margin: 0;
}

.player-spinner {
  width: 28px;
  height: 28px;
  border: 3px solid rgba(255, 255, 255, 0.25);
  border-top-color: #fff;
  border-radius: 50%;
  animation: player-spin 0.9s linear infinite;
}

@keyframes player-spin {
  to {
    transform: rotate(360deg);
  }
}

.player-retry {
  padding: 6px 22px;
  border: 1px solid rgba(255, 255, 255, 0.4);
  border-radius: 6px;
  background: transparent;
  color: #fff;
  font-size: 14px;
  cursor: pointer;
}

.player-retry:hover {
  background: rgba(255, 255, 255, 0.12);
}
</style>
