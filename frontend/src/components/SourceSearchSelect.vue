<script setup lang="ts">
/**
 * 可搜索的书源选择器（「发现书海」旁的下拉框）。
 *
 * 聚合类书源列表常有几十上百个源, 原生 <select> 无法检索, 找一个源要靠肉眼
 * 滚动。这里是"输入即过滤"的组合框: 触发按钮样式与原 .field 下拉一致, 展开
 * 后顶部是搜索框, 下方为按 名称/分组/URL 过滤后的候选列表。
 *
 * 交互:
 *  - 打开时自动聚焦搜索框, 直接打字即可过滤;
 *  - ↑/↓ 移动高亮, Enter 选中, Esc 关闭, Tab 关闭不选中;
 *  - 点击面板外部自动关闭;
 *  - 列表为空时给出可操作的提示, 不留白板。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { BookSource } from '../types'

const props = defineProps<{
  sources: BookSource[]
  /** 当前选中的 bookSourceUrl。 */
  modelValue: string
  disabled?: boolean
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
  (e: 'change', value: string): void
}>()

const open = ref(false)
const keyword = ref('')
/** 键盘 ↑/↓ 的高亮下标（指向过滤后的列表）。 */
const highlightIndex = ref(0)
const rootRef = ref<HTMLElement>()
const searchRef = ref<HTMLInputElement>()
const listRef = ref<HTMLElement>()

/** 不区分大小写地按 名称/分组/URL 过滤。 */
const filtered = computed(() => {
  const key = keyword.value.trim().toLowerCase()
  if (!key) return props.sources
  return props.sources.filter((src) => {
    const name = src.bookSourceName?.toLowerCase() ?? ''
    const group = src.bookSourceGroup?.toLowerCase() ?? ''
    const url = src.bookSourceUrl?.toLowerCase() ?? ''
    return name.includes(key) || group.includes(key) || url.includes(key)
  })
})

const currentSource = computed(() =>
  props.sources.find((src) => src.bookSourceUrl === props.modelValue),
)

function select(src: BookSource) {
  if (src.bookSourceUrl === props.modelValue) {
    open.value = false
    return
  }
  emit('update:modelValue', src.bookSourceUrl)
  emit('change', src.bookSourceUrl)
  open.value = false
}

function toggle() {
  if (props.disabled) return
  open.value = !open.value
  if (open.value) {
    keyword.value = ''
    highlightIndex.value = Math.max(
      0,
      filtered.value.findIndex((src) => src.bookSourceUrl === props.modelValue),
    )
    void nextTick(() => searchRef.value?.focus())
  }
}

/** 重新过滤后把高亮拉回合法区间。 */
watch(filtered, (list) => {
  if (highlightIndex.value >= list.length) highlightIndex.value = Math.max(0, list.length - 1)
})

/** 高亮项滚进可视区，长列表键盘导航时保持可见。 */
watch(highlightIndex, async (index) => {
  await nextTick()
  const list = listRef.value
  if (!list) return
  const item = list.querySelector<HTMLElement>(`[data-index="${index}"]`)
  if (!item) return
  const offsetTop = item.offsetTop
  const offsetBottom = offsetTop + item.offsetHeight
  if (offsetTop < list.scrollTop) {
    list.scrollTop = offsetTop
  } else if (offsetBottom > list.scrollTop + list.clientHeight) {
    list.scrollTop = offsetBottom - list.clientHeight
  }
})

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    open.value = false
    return
  }
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    if (filtered.value.length > 0) {
      highlightIndex.value = Math.min(highlightIndex.value + 1, filtered.value.length - 1)
    }
    return
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault()
    highlightIndex.value = Math.max(highlightIndex.value - 1, 0)
    return
  }
  if (event.key === 'Enter') {
    event.preventDefault()
    const src = filtered.value[highlightIndex.value]
    if (src) select(src)
  }
}

// 点击组件外部关闭面板（mousedown 先于 click，避免面板内点击被误判）。
// 带 DOM 环境守卫, 便于在无 document 的环境里安全导入。
function onGlobalPointerDown(event: PointerEvent) {
  if (!open.value) return
  if (rootRef.value && event.target instanceof Node && rootRef.value.contains(event.target)) return
  open.value = false
}

if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', onGlobalPointerDown, true)
  onBeforeUnmount(() => document.removeEventListener('pointerdown', onGlobalPointerDown, true))
}
</script>

<template>
  <div ref="rootRef" class="source-search-select">
    <button
      type="button"
      class="field source-select-trigger"
      :disabled="disabled"
      :aria-expanded="open"
      :title="currentSource?.bookSourceName ?? ''"
      @click="toggle"
    >
      <span class="trigger-label">{{ currentSource?.bookSourceName ?? '选择书源' }}</span>
      <svg
        class="trigger-chevron"
        :class="{ 'is-open': open }"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        width="12"
        height="12"
      >
        <path d="M6 9l6 6 6-6" />
      </svg>
    </button>

    <div v-if="open" class="selector-panel" @keydown="onKeydown">
      <div class="panel-search">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          width="13"
          height="13"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="M21 21l-4.35-4.35" />
        </svg>
        <input
          ref="searchRef"
          v-model="keyword"
          class="panel-search-input"
          type="text"
          placeholder="搜索书源名称 / 分组 / 网址"
          spellcheck="false"
        />
        <span class="panel-count">{{ filtered.length }}/{{ sources.length }}</span>
      </div>

      <div ref="listRef" class="panel-list" role="listbox">
        <button
          v-for="(src, index) in filtered"
          :key="src.bookSourceUrl"
          type="button"
          class="panel-option"
          :class="{
            active: src.bookSourceUrl === modelValue,
            highlighted: index === highlightIndex,
          }"
          :data-index="index"
          role="option"
          :aria-selected="src.bookSourceUrl === modelValue"
          @click="select(src)"
          @pointerenter="highlightIndex = index"
        >
          <span class="option-name">{{ src.bookSourceName }}</span>
          <span v-if="src.bookSourceGroup" class="option-group">{{ src.bookSourceGroup }}</span>
        </button>
        <div v-if="filtered.length === 0" class="panel-empty">没有匹配“{{ keyword }}”的书源</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.source-search-select {
  position: relative;
  width: 100%;
  min-width: 0;
  display: flex;
}

.source-select-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-1);
  width: 100%;
  min-width: 0;
  cursor: pointer;
  font-weight: 500;
  text-align: left;
}

.trigger-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.trigger-chevron {
  flex-shrink: 0;
  transition: transform var(--duration-fast) var(--ease-out);
}

.trigger-chevron.is-open {
  transform: rotate(180deg);
}

.selector-panel {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 60;
  width: 100%;
  min-width: 220px;
  max-width: 360px;
  display: flex;
  flex-direction: column;
  background: var(--color-bg-elevated, var(--color-bg));
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md, 8px);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
  overflow: hidden;
}

.panel-search {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-2);
  border-bottom: 1px solid var(--color-border);
  color: var(--color-text-tertiary);
  flex-shrink: 0;
}

.panel-search-input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--color-text);
  font-size: var(--text-sm);
  font-family: inherit;
}

.panel-search-input::placeholder {
  color: var(--color-text-tertiary);
}

.panel-count {
  flex-shrink: 0;
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  white-space: nowrap;
}

.panel-list {
  max-height: 260px;
  overflow-y: auto;
  padding: var(--space-1);
}

.panel-option {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  width: 100%;
  padding: 6px var(--space-2);
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text);
  font-size: var(--text-sm);
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}

.panel-option.highlighted {
  background: var(--color-primary-bg);
}

.panel-option.active {
  color: var(--color-primary);
  font-weight: 500;
}

.option-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.option-group {
  flex-shrink: 0;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}

.panel-empty {
  padding: var(--space-3);
  font-size: var(--text-sm);
  color: var(--color-text-tertiary);
  text-align: center;
}
</style>
