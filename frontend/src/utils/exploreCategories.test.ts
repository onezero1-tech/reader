import { describe, expect, it } from 'vitest'
import {
  getExploreCategoryKey,
  getInitialExploreCategoryUrl,
  isExploreCategorySection,
  isJsExploreUrl,
  parseExploreCategories,
} from './exploreCategories'

describe('exploreCategories', () => {
  it('keeps Legado section headers while selecting the first real category', () => {
    const categories = parseExploreCategories(JSON.stringify([
      { title: '排行🏷榜单', url: '' },
      { title: '总排行榜', url: '/rank/' },
      { title: '月排行榜', url: '/rank/monthvisit/' },
      { title: '标签🏷分类', url: '' },
      { title: '全部分类', url: '/fenlei/{{page}}.html' },
    ]))

    expect(categories.map((item) => item.title)).toEqual([
      '排行🏷榜单',
      '总排行榜',
      '月排行榜',
      '标签🏷分类',
      '全部分类',
    ])
    expect(isExploreCategorySection(categories[0])).toBe(true)
    expect(isExploreCategorySection(categories[1])).toBe(false)
    expect(getInitialExploreCategoryUrl(categories)).toBe('/rank/')
  })

  it('creates stable unique keys for repeated empty-url section headers', () => {
    const categories = parseExploreCategories(JSON.stringify([
      { title: '排行🏷榜单', url: '' },
      { title: '标签🏷分类', url: '' },
    ]))

    expect(getExploreCategoryKey(categories[0], 0)).not.toBe(getExploreCategoryKey(categories[1], 1))
  })

  it('parses relaxed json categories with angle bracket style objects', () => {
    const categories = parseExploreCategories(
      '[{"title":"排行🏷榜单","url":"","style":<"layout_flexBasisPercent":1,"layout_flexGrow":1>},{"title":"总排行榜","url":"/rank/","style":<"layout_flexBasisPercent":0.4,"layout_flexGrow":1>}]'
    )

    expect(categories).toEqual([
      { title: '排行🏷榜单', url: '' },
      { title: '总排行榜', url: '/rank/' },
    ])
    expect(getInitialExploreCategoryUrl(categories)).toBe('/rank/')
  })

  it('parses relaxed json categories with angle bracket item objects', () => {
    const categories = parseExploreCategories(
      '[<"style":<"layout_flexBasisPercent":1.0,"layout_flexGrow":1>,"title":"书 库","url":"/book/category/catalog.html">,<"style":<"layout_flexBasisPercent":0.25,"layout_flexGrow":1>,"title":"排 行","url":"/book/ranking.html">,<"style":<"layout_flexBasisPercent":0.25,"layout_flexGrow":1>,"title":">","url":"/ranking/hits/2.html">]'
    )

    expect(categories).toEqual([
      { title: '书 库', url: '/book/category/catalog.html' },
      { title: '排 行', url: '/book/ranking.html' },
      { title: '>', url: '/ranking/hits/2.html' },
    ])
    expect(getInitialExploreCategoryUrl(categories)).toBe('/book/category/catalog.html')
  })

  it('recovers double-escaped explore json (newlines stored as literal \\n)', () => {
    // 导入链路二次转义的存储形态：真实换行/引号全部变成字面 \n 与 \"。
    const inner = JSON.stringify(
      [
        { title: '🔖排行🔖', url: '' },
        { title: '总排行', url: 'https://a.example/{{page}}/popular' },
        { title: '周排行', url: 'https://a.example/popular-weekly' },
      ],
      null,
      2,
    )
    const doubleEscaped = JSON.stringify(inner).slice(1, -1)

    const categories = parseExploreCategories(doubleEscaped)
    expect(categories).toEqual([
      { title: '🔖排行🔖', url: '' },
      { title: '总排行', url: 'https://a.example/{{page}}/popular' },
      { title: '周排行', url: 'https://a.example/popular-weekly' },
    ])
    expect(getInitialExploreCategoryUrl(categories)).toBe('https://a.example/{{page}}/popular')
  })

  it('never emits an unparseable json blob as a single giant category', () => {
    // JSON 解析失败时，整段 blob 会落到文本切分兜底；没有真实换行时它就是
    // "一行"，没有守卫的话会被当成一个标题为几千字符的巨型"分类"。
    const blob = '[' + 'x'.repeat(300) + ']::https://a.example/1'
    const categories = parseExploreCategories(blob)
    expect(categories).toEqual([])
  })
})

describe('isJsExploreUrl', () => {
  it('detects the js rule forms used by the failing aggregate sources', () => {
    expect(isJsExploreUrl('@js:QMA_DISC.explore.call(this)')).toBe(true)
    expect(isJsExploreUrl('@JS:  upper case')).toBe(true)
    expect(isJsExploreUrl('<js>\nlet config = getConfig.call(this);\n</js>')).toBe(true)
    expect(isJsExploreUrl('  <js>padded</js>')).toBe(true)
  })

  it('leaves plain text and json rules to the local parser', () => {
    expect(isJsExploreUrl('玄幻::https://m.gamma.example.com/xuanhuan/{{page}}/')).toBe(false)
    expect(isJsExploreUrl('[{"title":"书 库","url":"/x"}]')).toBe(false)
    expect(isJsExploreUrl('')).toBe(false)
    expect(isJsExploreUrl(null)).toBe(false)
    expect(isJsExploreUrl(undefined)).toBe(false)
  })
})
