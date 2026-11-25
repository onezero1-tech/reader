/**
 * mp4 直链的回环 HTTP 改写。
 *
 * `<video>` 在 WebKitGTK 上消费 `reader://` 自定义协议时, 媒体栈对 Range
 * 语义的处理不可靠: 嗅探请求(`bytes=0-1445`)成功后管线静默放弃, 不发任何
 * 后续请求 —— 起播永远转圈(详见 Rust `api::media_stream` 模块注释)。
 *
 * 解法: 桌面端启动一个仅媒体的回环 axum 服务(127.0.0.1 随机端口 + 随机
 * token), 处理逻辑与协议路径完全同源。这里经 IPC 拿到基址, 把 mp4 直链
 * 改写到真实 HTTP 上; 拿不到基址(非 Tauri 环境/服务未启动)时原样返回,
 * 走协议路径兜底。HLS 不改道(hls.js 用 fetch 拉完整响应, 协议路径一直正常)。
 */
import { invoke } from '@tauri-apps/api/core'
import { isTauriRuntime } from './transport'

let basePromise: Promise<string | null> | null = null

/** 回环媒体服务基址; 失败(null)后缓存结果, 不反复尝试。 */
function mediaStreamBase(): Promise<string | null> {
  if (basePromise === null) {
    basePromise = isTauriRuntime()
      ? invoke<string | null>('media_stream_base').catch(() => null)
      : Promise.resolve(null)
  }
  return basePromise
}

/**
 * 把媒体地址改写成回环 HTTP 地址。
 *
 * 输入是 `mediaProxyUrl()` 的产物(`reader://localhost/media?path=...` 或
 * Windows 的 `http://reader.localhost/media?...`), 输出
 * `http://127.0.0.1:{port}/{token}/media?<query 原样保留>`。
 * 查询串(含 `path`/`source`)逐字节保留, 后端解析逻辑对两者完全一致。
 */
export async function toLoopbackMediaUrl(url: string): Promise<string> {
  if (!url) return url
  const base = await mediaStreamBase()
  if (!base) return url
  const queryAt = url.indexOf('?')
  return queryAt >= 0 ? `${base}/media${url.slice(queryAt)}` : `${base}/media`
}
