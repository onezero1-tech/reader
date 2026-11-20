import { describe, expect, it } from 'vitest'
import { detectMediaContent, mediaProxyUrl } from './mediaContent'

describe('detectMediaContent', () => {
  it('识别 m3u8 播放地址(含签名 query)', () => {
    const url =
      'https://liz04.com/api/v1/cdn/video/f705005e-56a9/manifest.m3u8?t=1795170596&sign=978d6d34'
    expect(detectMediaContent(url)).toEqual({ url, kind: 'hls' })
  })

  it('识别带首尾空白与换行的 m3u8 地址', () => {
    expect(detectMediaContent('  \nhttps://h.com/v/playlist.m3u8\n ')).toEqual({
      url: 'https://h.com/v/playlist.m3u8',
      kind: 'hls',
    })
  })

  it('识别一层引号包裹的 mp4 直链', () => {
    expect(detectMediaContent('"https://h.com/movie.mp4"')).toEqual({
      url: 'https://h.com/movie.mp4',
      kind: 'mp4',
    })
  })

  it('识别 query 前置扩展名的直链', () => {
    expect(detectMediaContent('https://h.com/video.mp4?sign=abc')).toEqual({
      url: 'https://h.com/video.mp4?sign=abc',
      kind: 'mp4',
    })
  })

  it('普通小说正文不误判', () => {
    expect(
      detectMediaContent(
        '第一章 试炼\n\n他推开门, 走进了那座荒废已久的宅院。\n这里的一切都透着说不出的诡异。'
      )
    ).toBeNull()
  })

  it('含 HTML 标签的富文本不误判', () => {
    expect(
      detectMediaContent('<p>https://h.com/v/manifest.m3u8</p>')
    ).toBeNull()
  })

  it('多行内容(正文里带一个 URL 行)不误判', () => {
    expect(
      detectMediaContent('播放地址:\nhttps://h.com/v/manifest.m3u8\n\n请复制到浏览器打开')
    ).toBeNull()
  })

  it('URL 后没有扩展名时(动态接口)不误判', () => {
    expect(detectMediaContent('https://h.com/api/play?id=1')).toBeNull()
  })

  it('非 http 协议不误判', () => {
    expect(detectMediaContent('ftp://h.com/v/manifest.m3u8')).toBeNull()
  })

  it('空串与 undefined 返回 null', () => {
    expect(detectMediaContent('')).toBeNull()
    expect(detectMediaContent(undefined)).toBeNull()
    expect(detectMediaContent(null)).toBeNull()
  })

  it('超长文本返回 null', () => {
    expect(detectMediaContent('https://h.com/v/manifest.m3u8\n' + 'x'.repeat(5000))).toBeNull()
  })
})

describe('mediaProxyUrl', () => {
  it('带书源时构造 /media 代理地址(单测环境为 reader.localhost)', () => {
    const out = mediaProxyUrl(
      'https://liz04.com/api/v1/cdn/video/x/manifest.m3u8?t=1&sign=a',
      'https://liz04.com'
    )
    expect(out).toBe(
      'http://reader.localhost/media?path=https%3A%2F%2Fliz04.com%2Fapi%2Fv1%2Fcdn%2Fvideo%2Fx%2Fmanifest.m3u8%3Ft%3D1%26sign%3Da&source=https%3A%2F%2Fliz04.com'
    )
  })

  it('缺省书源时不带 source 参数', () => {
    const out = mediaProxyUrl('https://h.com/v/playlist.m3u8')
    expect(out).toBe('http://reader.localhost/media?path=https%3A%2F%2Fh.com%2Fv%2Fplaylist.m3u8')
  })

  it('空白书源视同缺省', () => {
    const out = mediaProxyUrl('https://h.com/v/playlist.m3u8', '   ')
    expect(out).toBe('http://reader.localhost/media?path=https%3A%2F%2Fh.com%2Fv%2Fplaylist.m3u8')
  })
})
