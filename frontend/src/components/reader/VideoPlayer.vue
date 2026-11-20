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

/** hls.js 实例; 非空时必须在卸载/换源时 destroy, 否则媒体流与缓冲不释放。 */
let hlsInstance: { destroy(): void } | null = null
/** 防御动态 import 返回后 src 已变化/组件已卸载的竞态。 */
let generation = 0

async function attach() {
  destroy()
  const el = videoRef.value
  if (!el || !props.src) return
  failed.value = false
  hint.value = ''
  loading.value = true
  const gen = ++generation

  if (props.kind === 'mp4') {
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
    const hls = new Hls({ maxBufferLength: 30, maxMaxBufferLength: 60 })
    hlsInstance = hls
    hls.loadSource(props.src)
    hls.attachMedia(el)
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      void el.play().catch(() => {})
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
