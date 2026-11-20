/**
 * 视频源(legado `bookSourceType=4`)正文识别与代理地址构造。
 *
 * 视频书源的 ruleContent 返回的不是正文文本, 而是**播放地址**(m3u8/mp4 等)。
 * 旧版把它当正文渲染 —— 用户点开一集, 看到的就是一行裸 http 链接。这里负责
 * 把"正文恰好是一段媒体地址"识别出来, 交给阅读页的播放器组件。
 *
 * 识别刻意保守:
 *   - 内容必须是单条 URL(允许首尾空白与一层引号), 出现 HTML 标签或大段文本
 *     直接放弃 —— 绝不能把普通正文误判成媒体;
 *   - 扩展名白名单: `.m3u8`(HLS) 与常见直链视频容器;
 *   - 长度上限 4096, 防 URL 行外多行正文碰巧含 URL 被误判。
 */
import { assetUrl } from '../api/scheme'

export interface DetectedMedia {
  /** 原始播放地址(未代理)。 */
  url: string
  kind: 'hls' | 'mp4'
}

const HLS_RE = /\.m3u8(?=$|[?#])/i
const MP4_RE = /\.(mp4|m4v|mov|webm|ogv|mkv)(?=$|[?#])/i
const URL_RE = /^https?:\/\/[^\s'"<>]+$/i

/** 剥掉一层成对引号(有的书源把地址包在引号里返回)。 */
function stripQuotes(text: string): string {
  if (text.length >= 2) {
    const head = text[0]
    const tail = text[text.length - 1]
    if ((head === '"' && tail === '"') || (head === "'" && tail === "'")) {
      return text.slice(1, -1)
    }
  }
  return text
}

/**
 * 判断正文是否为一段可播放的媒体地址。
 *
 * 返回 null 表示按普通正文处理; 返回对象时 `url` 是原始地址。
 * 空串/加载中占位文本也返回 null, 由调用方的其它渲染分支处理。
 */
export function detectMediaContent(content: string | null | undefined): DetectedMedia | null {
  const text = String(content ?? '').trim()
  if (!text || text.length > 4096) return null
  // 出现任何 HTML 标签都视为富文本正文(漫画/小说), 与媒体无关。
  if (/<[a-z!][^>]*>/i.test(text)) return null
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0)
  if (lines.length !== 1) return null
  const candidate = stripQuotes(lines[0])
  if (!URL_RE.test(candidate)) return null
  if (HLS_RE.test(candidate)) return { url: candidate, kind: 'hls' }
  if (MP4_RE.test(candidate)) return { url: candidate, kind: 'mp4' }
  return null
}

/**
 * 把原始播放地址包进后端 `/media` 代理。
 *
 * 与 `/img` 同理: WebView 直接请求远程媒体无法携带书源 headers, 有防盗链的
 * CDN 不带站内 Referer 一律 403。`source` 是书籍所属书源的 `bookSourceUrl`
 * (`book.origin`), 后端拿它反查书源、合并书源级 header。
 */
export function mediaProxyUrl(rawUrl: string, source?: string): string {
  const query = `path=${encodeURIComponent(rawUrl)}`
  const origin = source?.trim()
  return origin
    ? assetUrl(`/media?${query}&source=${encodeURIComponent(origin)}`)
    : assetUrl(`/media?${query}`)
}
