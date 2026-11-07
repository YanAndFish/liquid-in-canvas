<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useLocale } from '@/composables/useLocale'
import { useSpring } from '@/composables/useSpring'
import { useTheme } from '@/composables/useTheme'
import AppIcon from '../ui/AppIcon.vue'
import { clampSupportPosition, supportPanelPosition } from './position'

const props = defineProps<{
  /** 购物袋等模态界面打开时隐藏客服入口。 */
  disabled?: boolean
}>()

/** 一条只保存在当前页面内的演示消息。 */
interface Message {
  /** 用于列表更新的递增编号。 */
  id: number
  /** user 表示访客，assistant 表示演示客服。 */
  role: 'user' | 'assistant'
  /** 直接显示的纯文本。 */
  text: string
}

const { isChinese } = useLocale()
const { theme } = useTheme()
const root = ref<HTMLElement>()
const launcher = ref<HTMLButtonElement>()
const input = ref<HTMLInputElement>()
const messageList = ref<HTMLElement>()
const opened = ref(false)
const dragging = ref(false)
const draft = ref('')
const pending = ref(false)
const messages = ref<Message[]>([])
const viewport = ref({ x: window.innerWidth, y: window.innerHeight })
const position = ref({ x: viewport.value.x - 92, y: viewport.value.y - 92 })
const buttonSize = computed(() => viewport.value.x < 600
  ? 56
  : 64)
const panelSize = computed(() => ({
  x: Math.min(360, viewport.value.x - 24),
  y: Math.min(480, viewport.value.y - buttonSize.value - 48),
}))
const panelPosition = computed(() => supportPanelPosition(position.value, viewport.value, panelSize.value, buttonSize.value))
const progress = useSpring(() => opened.value ? 1 : 0)
const visible = computed(() => opened.value || progress.value > 0.002)
const ready = computed(() => opened.value && progress.value >= 0.98)
const panelStyle = computed(() => {
  const t = Math.max(0, Math.min(1, progress.value))
  return {
    left: `${position.value.x + (panelPosition.value.x - position.value.x) * t}px`,
    top: `${position.value.y + (panelPosition.value.y - position.value.y) * t}px`,
    width: `${buttonSize.value + (panelSize.value.x - buttonSize.value) * t}px`,
    height: `${buttonSize.value + (panelSize.value.y - buttonSize.value) * t}px`,
  }
})
const quickReplies = computed(() => isChinese.value
  ? ['配送方式', '材质护理', '挑选器物']
  : ['Delivery', 'Care tips', 'Find an object'])
let sequence = 0
let timer: ReturnType<typeof setTimeout> | undefined
let suppressClick = false
let gesture: { pointerId: number, startX: number, startY: number, left: number, top: number } | null = null

/** 在点击时切换对话框；拖动产生的 click 不触发展开。 */
function toggle(event: MouseEvent): void {
  if (suppressClick && event.detail !== 0) {
    suppressClick = false
    return
  }
  suppressClick = false
  opened.value = !opened.value
}

/** 收起对话框，并在键盘关闭时将焦点交回入口。 */
function close(restoreFocus = true): void {
  opened.value = false
  if (restoreFocus)
    launcher.value?.focus({ preventScroll: true })
}

/** 记录拖动起点，指针移出按钮后也能完成拖动。 */
function startDrag(event: PointerEvent): void {
  if (event.button !== 0 || gesture)
    return
  gesture = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    left: position.value.x,
    top: position.value.y,
  }
  suppressClick = false
  launcher.value?.setPointerCapture(event.pointerId)
}

/** 超过六像素后按拖动处理，并把按钮限制在可见范围。 */
function moveDrag(event: PointerEvent): void {
  if (!gesture || gesture.pointerId !== event.pointerId)
    return
  const dx = event.clientX - gesture.startX
  const dy = event.clientY - gesture.startY
  if (!dragging.value && Math.hypot(dx, dy) < 6)
    return
  dragging.value = true
  suppressClick = true
  position.value = clampSupportPosition({ x: gesture.left + dx, y: gesture.top + dy }, viewport.value, buttonSize.value)
}

/** 结束拖动；指针取消时也清理按下状态。 */
function endDrag(event: PointerEvent): void {
  if (gesture?.pointerId !== event.pointerId)
    return
  gesture = null
  dragging.value = false
  if (launcher.value?.hasPointerCapture(event.pointerId))
    launcher.value.releasePointerCapture(event.pointerId)
}

/** 使用方向键移动入口，按住 Shift 时增加移动距离。 */
function moveWithKeyboard(event: KeyboardEvent): void {
  const offsets: Record<string, [number, number]> = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  }
  const offset = offsets[event.key]
  if (!offset)
    return
  event.preventDefault()
  const step = event.shiftKey ? 40 : 16
  position.value = clampSupportPosition({ x: position.value.x + offset[0] * step, y: position.value.y + offset[1] * step }, viewport.value, buttonSize.value)
}

/** 调整窗口后将入口移回可见区域。 */
function resize(): void {
  viewport.value = { x: window.innerWidth, y: window.innerHeight }
  position.value = clampSupportPosition(position.value, viewport.value, buttonSize.value)
}

/** 点击客服区域之外时收起非模态对话框。 */
function outside(event: PointerEvent): void {
  if (opened.value && event.target instanceof Node && !root.value?.contains(event.target))
    close(false)
}

/** 把最新消息滚入对话框的可见区域。 */
async function scrollMessages(): Promise<void> {
  await nextTick()
  const element = messageList.value
  if (element)
    element.scrollTop = element.scrollHeight
}

/** 返回演示商店的固定回复，不连接真实客服或保存聊天内容。 */
function reply(question: string, chinese: boolean): string {
  if (/配送|运费|delivery|shipping/i.test(question))
    return chinese ? '演示购物袋会计算运费：商品满 $150 免运费。你可以加入几件器物试试看，这里不会生成真实订单。' : 'The demo bag includes shipping calculations, with free shipping from $150. Try adding a few objects; no real orders are placed.'
  if (/材质|护理|care|material/i.test(question))
    return chinese ? '每件器物的详情页都有材质、尺寸和护理说明。木器、织物和陶器的照料方式不同，可以先打开你喜欢的那一件看看。' : 'Each product page includes materials, dimensions and care instructions. Open an object you like to find its specific guidance.'
  return chinese ? '可以从“家居、厨房、日用”三个分类开始挑选。喜欢的器物可以先加入购物袋。这个对话是本地演示，我不会连接真人客服。' : 'Explore Home, Kitchen or Everyday, then add favorites to your bag. This is a local demo conversation, without a live support connection.'
}

/** 添加消息并显示一条延迟回复，空输入和等待中的重复提交会被忽略。 */
function send(value = draft.value): void {
  const text = value.trim().slice(0, 500)
  if (!text || pending.value)
    return
  const chinese = isChinese.value
  messages.value.push({ id: ++sequence, role: 'user', text })
  draft.value = ''
  pending.value = true
  void scrollMessages()
  timer = setTimeout(() => {
    messages.value.push({
      id: ++sequence,
      role: 'assistant',
      text: reply(text, chinese),
    })
    pending.value = false
    void scrollMessages()
  }, 550)
}

watch(ready, async (value) => {
  if (value) {
    await nextTick()
    if (ready.value)
      input.value?.focus({ preventScroll: true })
  }
})
watch(() => props.disabled, (disabled) => {
  if (disabled)
    close(false)
})
onMounted(() => {
  resize()
  window.addEventListener('resize', resize, { passive: true })
  document.addEventListener('pointerdown', outside)
})
onBeforeUnmount(() => {
  clearTimeout(timer)
  window.removeEventListener('resize', resize)
  document.removeEventListener('pointerdown', outside)
})
</script>

<template>
  <div v-show="!disabled" ref="root" class="support-root" @keydown.esc.stop.prevent="close()">
    <div v-if="visible" class="support-dialog-anchor" :style="panelStyle">
      <section
        data-liquid-glass
        data-glass-layer="0"
        data-glass-radius="28"
        data-glass-fusion="40"
        data-glass-variant="regular"
        :data-glass-blur="1 + Math.min(1, progress) * 27"
        data-glass-refraction="20"
        :data-glass-tint="theme === 'dark' ? '#10191a' : '#f5f5ef'"
        :data-glass-tint-alpha="0.04 + Math.min(1, progress) * (theme === 'dark' ? 0.64 : 0.62)"
        class="support-dialog"
        role="dialog"
        aria-modal="false"
        aria-labelledby="support-title"
        :aria-hidden="!ready"
        :inert="!ready"
      >
        <div class="support-content" :style="{ opacity: ready ? 1 : 0 }">
          <header class="support-heading">
            <div>
              <h2 id="support-title">
                {{ isChinese ? '在线客服' : 'Here to help' }}
              </h2>
              <p><span class="support-status" />{{ isChinese ? 'STILL · 演示会话' : 'STILL · Demo conversation' }}</p>
            </div>
            <button type="button" class="support-close" :aria-label="isChinese ? '关闭客服对话' : 'Close support'" @click="close()">
              <AppIcon name="close" :size="18" />
            </button>
          </header>
          <div ref="messageList" class="support-messages" role="log" aria-live="polite" :aria-label="isChinese ? '客服消息' : 'Support messages'">
            <div class="support-message is-assistant">
              {{ isChinese ? '你好，欢迎来到 STILL。关于器物、配送或日常养护，都可以在这里聊聊。' : 'Welcome to STILL. Let’s talk about objects, delivery or everyday care.' }}
            </div>
            <div class="support-suggestions">
              <button v-for="question in quickReplies" :key="question" type="button" :disabled="pending" @click="send(question)">
                {{ question }}<AppIcon name="arrow" :size="13" />
              </button>
            </div>
            <div v-for="message in messages" :key="message.id" class="support-message" :class="message.role === 'user' ? 'is-user' : 'is-assistant'">
              {{ message.text }}
            </div>
            <p v-if="pending" class="support-typing">
              {{ isChinese ? '正在回复…' : 'Typing…' }}
            </p>
          </div>
          <form class="support-composer" @submit.prevent="send()">
            <input ref="input" v-model="draft" type="text" maxlength="500" autocomplete="off" :aria-label="isChinese ? '输入客服消息' : 'Message support'" :placeholder="isChinese ? '想了解些什么？' : 'What’s on your mind?'">
            <button type="submit" :disabled="!draft.trim() || pending" :aria-label="isChinese ? '发送消息' : 'Send message'">
              <AppIcon name="arrow" :size="19" />
            </button>
          </form>
          <p class="support-note">
            {{ isChinese ? '拖动圆形按钮，可以把对话放在喜欢的位置。' : 'Drag the round button to move this conversation.' }}
          </p>
        </div>
      </section>
    </div>
    <div class="support-launcher-anchor" :style="{ left: `${position.x}px`, top: `${position.y}px`, width: `${buttonSize}px`, height: `${buttonSize}px` }">
      <button
        ref="launcher"
        type="button"
        data-liquid-glass
        data-glass-layer="0"
        data-glass-radius="999"
        data-glass-fusion="40"
        data-glass-variant="clear"
        data-glass-blur="1"
        data-glass-refraction="16"
        :data-glass-tint="theme === 'dark' ? '#10191a' : '#f5f5ef'"
        data-glass-tint-alpha="0.04"
        class="support-launcher"
        :class="{ 'is-dragging': dragging }"
        :aria-label="isChinese ? '在线客服' : 'Support'"
        :aria-expanded="opened"
        :title="isChinese ? '拖动移动，点击咨询；方向键也可以移动' : 'Drag to move, click to chat; arrow keys also move'"
        @pointerdown="startDrag"
        @pointermove="moveDrag"
        @pointerup="endDrag"
        @pointercancel="endDrag"
        @lostpointercapture="endDrag"
        @keydown="moveWithKeyboard"
        @click="toggle"
      >
        <AppIcon :name="opened ? 'close' : 'chat'" :size="25" />
        <span v-if="!opened" class="support-online" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.support-root { position: fixed; inset: 0; z-index: 44; pointer-events: none; }
.support-launcher-anchor, .support-dialog-anchor { position: absolute; }
.support-launcher { position: absolute; inset: 0; width: 100%; height: 100%; display: grid; place-items: center; border-radius: 50%; pointer-events: auto; touch-action: none; user-select: none; cursor: grab; color: var(--text); }
.support-launcher.is-dragging { cursor: grabbing; }
.support-online { position: absolute; width: 7px; height: 7px; border-radius: 50%; right: 12px; bottom: 13px; background: #8bc8a1; }
.support-dialog { position: absolute; inset: 0; width: 100%; height: 100%; border-radius: 28px; overflow: clip; pointer-events: auto; color: var(--text); }
.support-content { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.support-heading { display: flex; justify-content: space-between; align-items: center; padding: 22px 20px 17px; border-bottom: 1px solid var(--line); }
.support-heading h2 { font-size: 18px; font-weight: 600; letter-spacing: -0.03em; }
.support-heading p { display: flex; gap: 6px; align-items: center; margin-top: 6px; font-size: 10px; color: var(--text-soft); }
.support-status { width: 5px; height: 5px; border-radius: 50%; background: #8bc8a1; }
.support-close { width: 36px; height: 36px; display: grid; place-items: center; border-radius: 50%; cursor: pointer; }
.support-close:hover { background: var(--hover); }
.support-messages { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 18px 18px 8px; display: flex; flex-direction: column; gap: 14px; }
.support-message { max-width: 90%; padding: 12px 14px; font-size: 13px; line-height: 1.7; overflow-wrap: anywhere; border-radius: 18px; flex-shrink: 0; }
.is-assistant { align-self: flex-start; background: var(--hover); border-bottom-left-radius: 5px; }
.is-user { align-self: flex-end; background: #c8ddc8; color: #1c3325; border-bottom-right-radius: 5px; }
.support-suggestions { display: flex; gap: 7px; flex-wrap: wrap; }
.support-suggestions button { display: inline-flex; align-items: center; gap: 7px; border: 1px solid var(--line); border-radius: 20px; padding: 7px 9px; font-size: 10px; cursor: pointer; }
.support-suggestions button:hover { background: var(--hover); }
.support-typing { font-size: 11px; color: var(--text-soft); }
.support-composer { margin: 10px 16px 0; padding: 6px; display: flex; align-items: center; gap: 8px; border-radius: 22px; background: var(--hover); border: 1px solid var(--line); }
.support-composer input { min-width: 0; flex: 1; padding: 8px 8px; background: transparent; font-size: 13px; outline: none; }
.support-composer:focus-within { border-color: var(--text-soft); }
.support-composer button { width: 34px; height: 34px; display: grid; place-items: center; border-radius: 50%; background: var(--text); color: var(--bg); cursor: pointer; }
.support-composer button:disabled { opacity: 0.25; cursor: default; }
.support-note { margin: 10px 18px 16px; font-size: 9px; line-height: 1.5; text-align: center; color: var(--text-soft); }
</style>
