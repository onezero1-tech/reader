import { assetUrl } from '../api/scheme'
import { readSourceLiteral } from './sourceLiteral'

/**
 * legado `img` 的 `,{json}` 参数协议。
 *
 * 正文里的图片可以是 `src='data:image/svg+xml;base64,...==,{"style":"text","type":"qd","click":"showConfigPanel()"}'`，
 * 逗号后的 JSON 是渲染选项而非 URL 的一部分（legado `AnalyzeUrl.paramPattern` 为 `\s*,\s*(?=\{)`）。
 * 不剥离这段后缀，浏览器会把整串当 URL 加载，图标必然显示为破损图片。
 */

/** 与 legado `AnalyzeUrl.paramPattern` 一致：逗号 + 可空白 + 左花括号。 */
export const SOURCE_IMG_OPTION_RE = /\s*,\s*(?=\{)/

export interface SourceImageOption {
  /** 剥离参数后的真实图片地址。 */
  url: string
  /** `style`，如 `text`。 */
  style: string
  /** `click` 脚本（在书源 jsLib 作用域执行）。 */
  click: string
  /** `width`。 */
  width: string
  /** 用于提示的显示文本（`displayText` / `num` / `text`）。 */
  label: string
}

const SVG_BASE64_MARKER = ';base64,'

/**
 * 给缺少命名空间的 SVG data URI 补上 `xmlns`。
 *
 * 插件的图标有两种：段评气泡自带 `xmlns="http://www.w3.org/2000/svg"`，
 * 而"打开控制面板"的齿轮图标没有。作为 `data:image/svg+xml` 独立文档加载时，
 * 缺少命名空间声明的 SVG 会解析失败，浏览器只能显示破损图片占位符。
 * 这里在本地补上命名空间，不改动远程 jsLib。
 */
export function ensureSvgNamespace(url: string): string {
  if (!url.startsWith('data:image/svg+xml')) return url
  const markerIndex = url.indexOf(SVG_BASE64_MARKER)
  if (markerIndex < 0) return url

  const header = url.slice(0, markerIndex + SVG_BASE64_MARKER.length)
  const payload = url.slice(markerIndex + SVG_BASE64_MARKER.length)
  try {
    // base64 → UTF-8 文本（不能直接用 atob 的二进制串，图标里有中文会被破坏）
    const binary = atob(payload)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    const svg = new TextDecoder('utf-8').decode(bytes)

    if (/\sxmlns\s*=/.test(svg)) return url

    const fixed = svg.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"')
    if (fixed === svg) return url

    const outBytes = new TextEncoder().encode(fixed)
    let outBinary = ''
    outBytes.forEach((byte) => {
      outBinary += String.fromCharCode(byte)
    })
    return header + btoa(outBinary)
  } catch {
    // 解码/编码失败时保持原样（宁可显示破损，也不要弄坏能用的图标）
    return url
  }
}

/**
 * 拆分图片 `src` 与其 `,{json}` 选项。
 * 没有选项或 JSON 非法时返回 `null`（保持原始 src 不动，避免误伤普通图片）。
 */
export function parseSourceImageOptions(rawSrc: string): SourceImageOption | null {
  if (!rawSrc) return null
  const separators = [...rawSrc.matchAll(new RegExp(SOURCE_IMG_OPTION_RE.source, 'g'))].reverse()
  for (const separator of separators) {
    const parsed = readSourceLiteral(rawSrc, separator.index + separator[0].length)
    if (!parsed || rawSrc.slice(parsed.end).trim()) continue
    const option = parsed.value
    if (!option || typeof option !== 'object' || Array.isArray(option)) continue
    const asText = (key: string) => {
      const value = option[key]
      return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
    }
    return {
      url: rawSrc.slice(0, separator.index).trim(),
      style: asText('style').toLowerCase(),
      click: asText('click'),
      width: asText('width'),
      label: asText('displayText') || asText('num') || asText('text'),
    }
  }
  return null
}

/** 给正文插图补上占位尺寸, 避免加载完成前后高度变化导致的正文跳动。
 *
 *  只处理「正文插图」: 段评气泡(`source-inline-bubble`)与设了 `style.width`
 *  的图标有自己明确的尺寸, 不参与占位。
 *
 *  `width: 100%` 和 `aspect-ratio` **必须成对出现**才有效:
 *  未加载的图片固有尺寸是 0, 没有确定宽度时宽高比无从换算, 高度照样是 0。
 *  只有先靠 `width: 100%` 把宽度钉到列宽, `aspect-ratio` 才能算出占位高度。
 *  实测(700px 列宽): 只写 aspect-ratio 时加载前高度 0; 加上 width:100% 后
 *  加载前后都是 393.75px, 位移 0。
 *
 *  比例取常见横图 16:9。真实图片比例不同, 加载后由 `height: auto` 与图片
 *  自身比例接管 —— 这一层只负责「先把位置占住」。 */
const FALLBACK_IMAGE_ASPECT = '16 / 9'

export function reserveImageSpace(root: HTMLElement) {
  const images = Array.from(root.querySelectorAll('img')) as HTMLImageElement[]
  images.forEach((image) => {
    if (image.classList.contains('source-inline-bubble')) return
    if (image.hasAttribute('width') && image.hasAttribute('height')) return
    if (image.style.width || image.style.height || image.style.aspectRatio) return
    image.style.width = '100%'
    image.style.aspectRatio = FALLBACK_IMAGE_ASPECT
    image.style.height = 'auto'
  })
}

/**
 * 把书源正文图片地址改写成后端 `/img` 代理地址。
 *
 * WebView 直接加载远程图片时无法携带 `,{json}` 里的 Referer/UA —— 有防盗链
 * 的图床（如楠楠漫画的 img.yidanmh.xyz，不带站内 Referer 一律 403）在阅读页
 * 必然整章裂图。改写成 `/img?path=<原始src>&source=<书源地址>` 后由后端
 * 解析请求选项、与书源级 header 合并后下载，与 legado 手机端（Glide 可带
 * headers）同一语义。
 *
 * `path` 传**原始 src**（含 `,{json}`）：后端要用它解析请求选项。
 * `data:` URI（段评气泡）与已本地化的资源不进代理，返回 null。
 */
export function buildProxiedImageUrl(rawSrc: string, url: string, source?: string): string | null {
  if (!/^https?:\/\//i.test(url.trim())) return null
  const query = `path=${encodeURIComponent(rawSrc)}`
  const origin = source?.trim()
  return origin
    ? assetUrl(`/img?${query}&source=${encodeURIComponent(origin)}`)
    : assetUrl(`/img?${query}`)
}

/**
 * 处理正文容器里的所有图片：剥离 `,{json}`、改写远程图片为 `/img` 代理、
 * 标记可点击、按 `style:text` 呈现为行内气泡。
 * 直接修改传入的 DOM（与 `formatChapterHtml` 的其余后处理一致）。
 *
 * `source` 是书籍所属书源的 `bookSourceUrl`（`book.origin`），后端拿它
 * 反查书源以合并书源级 header；缺省时后端也能按地址反查，只是多一次查找。
 */
export function processSourceImageOptions(root: HTMLElement, source?: string) {
  const images = Array.from(root.querySelectorAll('img')) as HTMLImageElement[]
  images.forEach((image) => {
    const rawSrc = image.getAttribute('src') || ''
    const parsed = parseSourceImageOptions(rawSrc)
    if (!parsed) return

    image.dataset.sourceRawSrc = rawSrc
    // 远程书源图片改走后端代理（带书源 headers）；data: 等其余地址保持直读。
    image.setAttribute(
      'src',
      buildProxiedImageUrl(rawSrc, parsed.url, source) ?? ensureSvgNamespace(parsed.url),
    )

    if (parsed.click) {
      image.dataset.sourceClick = parsed.click
      image.classList.add('source-clickable')
    }
    // style:text 的图标按行内文本气泡呈现（段评图标通常就是这个形态）
    if (parsed.style === 'text') {
      image.classList.add('source-inline-bubble')
      if (parsed.label) {
        image.setAttribute('title', parsed.label)
        image.setAttribute('alt', parsed.label)
      }
    }
    if (parsed.width) {
      image.style.width = parsed.width
    }
  })
}
