import { describe, expect, it } from 'vitest'
import {
  buildProxiedImageUrl,
  ensureSvgNamespace,
  parseSourceImageOptions,
  processSourceImageOptions,
  reserveImageSpace,
} from './sourceImageOptions'

// 取自真实插件(addComment)产生的 src: 段评图标 + 配置面板 click
const REAL_SRC =
  'data:image/svg+xml;base64,PHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiPjwvc3ZnPg==,' +
  '{"style":"text","type":"qd","click":"showConfigPanel()"}'

/** 齿轮图标(打开控制面板的入口): 真实数据, 根标签缺少 xmlns。 */
const GEAR_SVG =
  '<svg viewBox="0 0 24 24" width="800" height="800" stroke="#757575" stroke-width="2" fill="none">' +
  '<circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82z"></path></svg>'

/** 段评气泡图标: 真实数据, 自带 xmlns(所以它一直显示正常)。 */
const COMMENT_SVG =
  '<svg class="icon" viewBox="-150 0 1224 1224" version="1.1" xmlns="http://www.w3.org/2000/svg" width="800" height="800">' +
  '<path d="M512 938.667z"></path></svg>'

function toDataUri(svg: string) {
  const bytes = new TextEncoder().encode(svg)
  let binary = ''
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte)
  })
  return `data:image/svg+xml;base64,${btoa(binary)}`
}

function decodeDataUri(url: string) {
  const payload = url.slice(url.indexOf(';base64,') + ';base64,'.length)
  const binary = atob(payload)
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  return new TextDecoder('utf-8').decode(bytes)
}

describe('parseSourceImageOptions', () => {
  it('剥离 ,{json} 后缀并取出 click（修复破损图标的关键）', () => {
    const parsed = parseSourceImageOptions(REAL_SRC)
    expect(parsed).not.toBeNull()
    // 剥离后的地址不能残留 JSON 部分，否则图片会 404 成破损图标
    expect(parsed!.url).toBe('data:image/svg+xml;base64,PHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiPjwvc3ZnPg==')
    expect(parsed!.url).not.toContain('{')
    expect(parsed!.style).toBe('text')
    expect(parsed!.click).toBe('showConfigPanel()')
  })

  it('普通图片（无参数）原样返回 null', () => {
    expect(parseSourceImageOptions('https://cdn.example/a.jpg')).toBeNull()
    expect(parseSourceImageOptions('')).toBeNull()
  })

  it('JSON 非法时不剥离，避免误伤普通图片', () => {
    expect(parseSourceImageOptions('https://cdn.example/a.jpg,{bad json')).toBeNull()
  })

  it('逗号后不是花括号时不当作参数（legado 语义）', () => {
    // URL 自身含逗号是合法的
    expect(parseSourceImageOptions('https://cdn.example/a,b.jpg')).toBeNull()
  })

  it('支持 width 与 displayText', () => {
    const parsed = parseSourceImageOptions(
      'https://cdn.example/a.jpg,{"style":"TEXT","displayText":"12","width":"2em"}',
    )
    expect(parsed!.url).toBe('https://cdn.example/a.jpg')
    expect(parsed!.style).toBe('text')
    expect(parsed!.label).toBe('12')
    expect(parsed!.width).toBe('2em')
  })
})

describe('processSourceImageOptions（用最小 DOM 桩，不依赖 jsdom）', () => {
  /** 只实现被测代码用到的那几个 DOM 接口，避免为一个测试引入 jsdom 依赖。 */
  function makeFakeImage(rawSrc: string) {
    const classes = new Set<string>()
    const attrs = new Map<string, string>([['src', rawSrc]])
    const image = {
      dataset: {} as Record<string, string>,
      style: {} as Record<string, string>,
      classList: {
        add: (name: string) => classes.add(name),
        contains: (name: string) => classes.has(name),
      },
      getAttribute: (name: string) => attrs.get(name) ?? null,
      setAttribute: (name: string, value: string) => attrs.set(name, value),
    }
    return { image, classes, attrs }
  }

  function runOn(rawSrc: string) {
    const { image, classes, attrs } = makeFakeImage(rawSrc)
    const root = {
      querySelectorAll: () => [image],
    } as unknown as HTMLElement
    processSourceImageOptions(root)
    return { image, classes, attrs }
  }

  it('把破损图标修成可点击气泡并保留原始 src', () => {
    const { image, classes, attrs } = runOn(REAL_SRC)

    // 关键：src 里的 JSON 部分必须被剥离，否则图片加载失败显示破损图标
    const produced = attrs.get('src') || ''
    expect(produced).not.toContain('{')
    expect(produced.startsWith('data:image/svg+xml;base64,')).toBe(true)
    // 缺 xmlns 的 SVG 会被补上命名空间(这正是齿轮图标破损的原因)
    expect(decodeDataUri(produced)).toContain('xmlns="http://www.w3.org/2000/svg"')
    expect(image.dataset.sourceClick).toBe('showConfigPanel()')
    expect(classes.has('source-clickable')).toBe(true)
    expect(classes.has('source-inline-bubble')).toBe(true)
    // 原始 src 保留给 click 脚本的 `result`
    expect(image.dataset.sourceRawSrc).toBe(REAL_SRC)
  })

  it('不影响没有参数的普通图片', () => {
    const { classes, attrs, image } = runOn('https://cdn.example/a.jpg')

    expect(attrs.get('src')).toBe('https://cdn.example/a.jpg')
    expect(image.dataset.sourceClick).toBeUndefined()
    expect(classes.has('source-clickable')).toBe(false)
  })

  it('JSON 非法时保持原样', () => {
    const bad = 'https://cdn.example/a.jpg,{oops'
    const { classes, attrs } = runOn(bad)
    expect(attrs.get('src')).toBe(bad)
    expect(classes.has('source-clickable')).toBe(false)
  })
})

describe('buildProxiedImageUrl / 正文插图代理改写', () => {
  /** 与上面同一套 DOM 桩，但允许传入 source。 */
  function runOnWithSource(rawSrc: string, source?: string) {
    const classes = new Set<string>()
    const attrs = new Map<string, string>([['src', rawSrc]])
    const image = {
      dataset: {} as Record<string, string>,
      style: {} as Record<string, string>,
      classList: {
        add: (name: string) => classes.add(name),
        contains: (name: string) => classes.has(name),
      },
      getAttribute: (name: string) => attrs.get(name) ?? null,
      setAttribute: (name: string, value: string) => attrs.set(name, value),
    }
    const root = {
      querySelectorAll: () => [image],
    } as unknown as HTMLElement
    processSourceImageOptions(root, source)
    return { image, classes, attrs }
  }

  // 楠楠漫画的正文图片形态: 远程地址 + 书源 headers 选项
  const MANGA_SRC =
    'https://img.example/book/1/1.jpg,' +
    '{"headers":{"Referer":"https://site.example/"}}'

  it('远程图片改写成 /img 代理，path 保留原始 src(含选项)', () => {
    const proxied = buildProxiedImageUrl(MANGA_SRC, 'https://img.example/book/1/1.jpg', 'https://site.example/')
    expect(proxied).not.toBeNull()
    expect(proxied!).toContain('/img?')
    expect(proxied!).toContain('path=' + encodeURIComponent(MANGA_SRC))
    expect(proxied!).toContain('&source=' + encodeURIComponent('https://site.example/'))
  })

  it('data: URI(段评气泡)不进代理', () => {
    expect(buildProxiedImageUrl(REAL_SRC, 'data:image/svg+xml;base64,AAAA', 'https://site.example/')).toBeNull()
  })

  it('processSourceImageOptions 带 source 时把远程图片 src 改写为代理地址', () => {
    const { attrs, image } = runOnWithSource(MANGA_SRC, 'https://site.example/')
    const produced = attrs.get('src') || ''
    expect(produced).toContain('/img?')
    expect(produced).toContain('path=' + encodeURIComponent(MANGA_SRC))
    // 原始 src 保留给 click 脚本的 result
    expect(image.dataset.sourceRawSrc).toBe(MANGA_SRC)
  })

  it('processSourceImageOptions 不带 source 时仍改写(后端按地址反查)', () => {
    const { attrs } = runOnWithSource(MANGA_SRC)
    const produced = attrs.get('src') || ''
    expect(produced).toContain('/img?')
    expect(produced).not.toContain('source=')
  })

  it('data: 气泡的处理不受影响(仍剥离 JSON 并补 xmlns)', () => {
    const { attrs, image, classes } = runOnWithSource(REAL_SRC, 'https://site.example/')
    const produced = attrs.get('src') || ''
    expect(produced.startsWith('data:image/svg+xml;base64,')).toBe(true)
    expect(produced).not.toContain('/img?')
    expect(image.dataset.sourceClick).toBe('showConfigPanel()')
    expect(classes.has('source-inline-bubble')).toBe(true)
  })
})

describe('reserveImageSpace（用最小 DOM 桩，不依赖 jsdom）', () => {
  function makeImage(opts: {
    attrs?: Record<string, string>
    classes?: string[]
    style?: Record<string, string>
    complete?: boolean
    naturalWidth?: number
    naturalHeight?: number
  }) {
    const attrs = new Map<string, string>(Object.entries(opts.attrs ?? {}))
    const classes = new Set(opts.classes ?? [])
    const style: Record<string, string> = { ...(opts.style ?? {}) }
    const loadHandlers: Array<() => void> = []
    const image = {
      style,
      classList: { contains: (name: string) => classes.has(name) },
      hasAttribute: (name: string) => attrs.has(name),
      complete: opts.complete,
      naturalWidth: opts.naturalWidth,
      naturalHeight: opts.naturalHeight,
      addEventListener: (type: string, handler: () => void) => {
        if (type === 'load') loadHandlers.push(handler)
      },
    }
    return { image, loadHandlers }
  }

  function runOn(images: Array<ReturnType<typeof makeImage>['image']>) {
    const root = { querySelectorAll: () => images } as unknown as HTMLElement
    reserveImageSpace(root)
    return images
  }

  it('leaves an image that already declares width and height alone', () => {
    // 书源插图常带这两个属性, 浏览器据此即可在加载前按比例占位。
    const [image] = runOn([makeImage({ attrs: { width: '1024', height: '576' } }).image])

    expect(image.style.aspectRatio).toBeUndefined()
  })

  it('reserves space when the image has no intrinsic size', () => {
    const [image] = runOn([makeImage({ attrs: { src: 'a.jpg' } }).image])

    // width 与 aspect-ratio 必须成对: 未加载的图片固有宽度是 0,
    // 没有确定宽度就换算不出占位高度。
    expect(image.style.width).toBe('100%')
    expect(image.style.aspectRatio).toBe('16 / 9')
    expect(image.style.height).toBe('auto')
  })

  it('reserves space when only one dimension is given', () => {
    const [image] = runOn([makeImage({ attrs: { width: '1024' } }).image])

    expect(image.style.width).toBe('100%')
    expect(image.style.aspectRatio).toBe('16 / 9')
  })

  it('leaves commentary bubbles alone', () => {
    // 气泡有自己固定的行内尺寸, 再套宽高比会把它撑成整段高图。
    const [image] = runOn([makeImage({ classes: ['source-inline-bubble'] }).image])

    expect(image.style.aspectRatio).toBeUndefined()
  })

  it('does not override a size the source already set', () => {
    const [image] = runOn([makeImage({ style: { width: '110px' } }).image])

    expect(image.style.aspectRatio).toBeUndefined()
  })

  it('load 完成后把 16:9 占位换成图片固有比例(修复竖图拉伸)', () => {
    // 竖版漫画页: 元素盒子若一直是 16:9, 位图会被压成横条。
    const { image, loadHandlers } = makeImage({ attrs: { src: 'p1.jpg' } })
    runOn([image])
    expect(image.style.aspectRatio).toBe('16 / 9')

    image.naturalWidth = 800
    image.naturalHeight = 1200
    loadHandlers.forEach((handler) => handler())

    expect(image.style.aspectRatio).toBe('800 / 1200')
    expect(image.style.width).toBe('100%')
    expect(image.style.height).toBe('auto')
  })

  it('缓存命中的 complete 图片同步结算固有比例, 不等 load 事件', () => {
    const { image } = makeImage({
      attrs: { src: 'cached.jpg' },
      complete: true,
      naturalWidth: 1080,
      naturalHeight: 360,
    })
    runOn([image])

    expect(image.style.aspectRatio).toBe('1080 / 360')
  })

  it('加载失败(naturalWidth 为 0)时保留 16:9 占位', () => {
    const { image, loadHandlers } = makeImage({
      attrs: { src: 'broken.jpg' },
      complete: true,
      naturalWidth: 0,
      naturalHeight: 0,
    })
    runOn([image])

    loadHandlers.forEach((handler) => handler())
    expect(image.style.aspectRatio).toBe('16 / 9')
  })
})

describe('ensureSvgNamespace', () => {
  it('给缺少 xmlns 的 SVG 补上命名空间(修复控制面板齿轮图标)', () => {
    const fixed = ensureSvgNamespace(toDataUri(GEAR_SVG))
    const svg = decodeDataUri(fixed)

    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"')
    // 其余内容必须原样保留
    expect(svg).toContain('<circle cx="12" cy="12" r="3">')
    expect(svg).toContain('#757575')
  })

  it('已带 xmlns 的 SVG 不动(段评气泡一直正常)', () => {
    const original = toDataUri(COMMENT_SVG)
    expect(ensureSvgNamespace(original)).toBe(original)
  })

  it('非 SVG 与非法 base64 原样返回', () => {
    const jpg = 'data:image/jpeg;base64,AAAA'
    expect(ensureSvgNamespace(jpg)).toBe(jpg)
    const broken = 'data:image/svg+xml;base64,!!!not-base64!!!'
    expect(ensureSvgNamespace(broken)).toBe(broken)
    const httpUrl = 'https://cdn.example/a.svg'
    expect(ensureSvgNamespace(httpUrl)).toBe(httpUrl)
  })

  it('中文内容编码往返不丢失', () => {
    const svgWithCjk =
      '<svg viewBox="0 0 10 10"><text>段评</text></svg>'
    const fixed = decodeDataUri(ensureSvgNamespace(toDataUri(svgWithCjk)))
    expect(fixed).toContain('段评')
    expect(fixed).toContain('xmlns=')
  })
})
