<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import { useLocale } from '@/composables/useLocale'
import { useSpring } from '@/composables/useSpring'
import { reducedMotionQuery } from '@/shared/motion'

const { t } = useLocale()
const frame = ref<HTMLElement | null>(null)
const video = ref<HTMLVideoElement | null>(null)
const settingsButton = ref<HTMLButtonElement | null>(null)
const settings = ref(false)
const scene = ref(0)
const variant = ref<'clear' | 'regular'>('clear')
const playing = ref(false)
const requestedPlayback = ref(true)
const progress = useSpring(() => settings.value ? 1 : 0)
const selection = useSpring(() => scene.value)
const panelStyle = computed(() => ({
  width: `calc(52px + (min(292px, 100vw - 56px) - 52px) * ${progress.value})`,
  height: `${52 + 192 * progress.value}px`,
}))
const optionsVisible = computed(() => settings.value && progress.value > 0.75)
const surface = computed(() => ({
  'data-glass-variant': variant.value,
  'data-glass-blur': variant.value === 'clear'
    ? 3
    : 22,
  'data-glass-tint': '#131b20',
  'data-glass-tint-alpha': variant.value === 'clear'
    ? 0.1
    : 0.3,
  'data-glass-refraction': 16,
  'data-glass-dispersion': 0.18,
  'data-glass-specular': 0.85,
  'data-glass-shadow': 0.18,
  'data-glass-shadow-size': 20,
}))
let observer: IntersectionObserver | undefined
let motion: MediaQueryList | undefined
let inView = true

/** 按用户选择和可见性播放视频，离屏时停止上传视频帧。 */
function syncPlayback(): void {
  const media = video.value
  if (!media)
    return
  if (requestedPlayback.value && inView && scene.value === 0) {
    try {
      void media.play()?.catch(() => {
        playing.value = false
      })
    }
    catch {
      playing.value = false
    }
  }
  else {
    media.pause()
  }
}

/** 切换背景，保留用户的播放偏好。 */
function selectScene(index: number): void {
  scene.value = index
  syncPlayback()
}

/** 显式播放操作允许用户在减少动态效果模式下观看视频。 */
function togglePlayback(): void {
  requestedPlayback.value = !playing.value
  syncPlayback()
}

/** 关闭设置并把键盘焦点还给触发按钮。 */
function closeSettings(): void {
  settings.value = false
  settingsButton.value?.focus()
}

function onOutside(event: PointerEvent): void {
  if (event.target instanceof Element && !event.target.closest('.scene-settings'))
    settings.value = false
}

function onMotionChange(): void {
  requestedPlayback.value = !motion?.matches
  syncPlayback()
}

onMounted(() => {
  motion = reducedMotionQuery() ?? undefined
  requestedPlayback.value = !motion?.matches
  motion?.addEventListener('change', onMotionChange)
  document.addEventListener('pointerdown', onOutside)
  if (typeof IntersectionObserver === 'function' && frame.value) {
    observer = new IntersectionObserver(([entry]) => {
      inView = entry?.isIntersecting ?? false
      syncPlayback()
    }, { threshold: 0.05 })
    observer.observe(frame.value)
  }
  syncPlayback()
})
onBeforeUnmount(() => {
  observer?.disconnect()
  motion?.removeEventListener('change', onMotionChange)
  document.removeEventListener('pointerdown', onOutside)
  video.value?.pause()
})
</script>

<template>
  <section ref="frame" class="showcase-frame" data-glass-clip aria-labelledby="glass-title">
    <video
      ref="video"
      class="showcase-media"
      :class="{ 'is-hidden': scene !== 0 }"
      src="/media/liquid-glass-flower.mp4"
      poster="/media/liquid-glass-flower-poster.jpg"
      muted loop playsinline preload="metadata" aria-hidden="true"
      @play="playing = true" @pause="playing = false"
    />
    <img class="showcase-media showcase-object" :class="{ 'is-hidden': scene !== 1 }" src="/products/paper-lantern.webp" alt="" aria-hidden="true">
    <div class="showcase-media showcase-light" :class="{ 'is-hidden': scene !== 2 }" aria-hidden="true" />
    <div class="showcase-shade" aria-hidden="true" />

    <div class="showcase-copy">
      <p class="showcase-eyebrow">
        STILL — {{ t('glass.eyebrow') }}
      </p>
      <h1 id="glass-title">
        {{ t('hero.titleLine1') }}<br><span>{{ t('hero.titleLine2') }}</span>
      </h1>
      <p class="showcase-description">
        {{ t('glass.body') }}
      </p>
    </div>

    <div class="scene-settings" @keydown.esc.stop.prevent="closeSettings">
      <div
        class="scene-settings-surface" data-liquid-glass data-glass-radius="26"
        v-bind="surface" :style="panelStyle"
        :data-glass-blur="3 + progress * 22"
        :data-glass-tint-alpha="0.12 + progress * 0.22"
      >
        <button
          ref="settingsButton" type="button" class="scene-settings-toggle"
          :aria-label="t('glass.settings')" :aria-expanded="settings" aria-controls="glass-settings"
          @click="settings = !settings"
        >
          <AppIcon :name="settings ? 'close' : 'adjust'" :size="21" />
        </button>
        <div id="glass-settings" class="scene-settings-content" :class="{ 'is-visible': optionsVisible }" :inert="!optionsVisible" :aria-hidden="!optionsVisible">
          <h2>{{ t('glass.material') }}</h2>
          <p>{{ t('glass.materialHint') }}</p>
          <div class="material-options" role="group" :aria-label="t('glass.material')">
            <button type="button" :aria-pressed="variant === 'clear'" @click="variant = 'clear'">
              {{ t('glass.clear') }}<AppIcon v-if="variant === 'clear'" name="check" :size="16" />
            </button>
            <button type="button" :aria-pressed="variant === 'regular'" @click="variant = 'regular'">
              {{ t('glass.regular') }}<AppIcon v-if="variant === 'regular'" name="check" :size="16" />
            </button>
          </div>
          <span class="settings-footnote">{{ t('glass.touchHint') }}</span>
        </div>
      </div>
    </div>

    <div class="showcase-action-anchor">
      <a href="#collection" class="showcase-action" data-liquid-glass data-glass-radius="999" v-bind="surface">
        <span>{{ t('hero.cta') }}</span><AppIcon name="arrow" :size="22" />
      </a>
      <p>{{ t('glass.actionHint') }}</p>
    </div>

    <div class="showcase-bottom">
      <div class="scene-caption">
        <span class="scene-dot" />{{ t(scene === 0 ? 'glass.sceneNature' : scene === 1 ? 'glass.sceneObjects' : 'glass.sceneLight') }}<span class="scene-index">0{{ scene + 1 }} / 03</span>
      </div>
      <div class="scene-controls-anchor">
        <div class="scene-controls" data-liquid-glass data-glass-radius="999" v-bind="surface" role="group" :aria-label="t('glass.background')">
          <span class="scene-selection" :style="{ transform: `translateX(${selection * 100}%)` }" aria-hidden="true" />
          <button v-for="(key, index) in (['glass.nature', 'glass.objects', 'glass.light'] as const)" :key="key" type="button" :aria-pressed="scene === index" @click="selectScene(index)">
            {{ t(key) }}
          </button>
        </div>
      </div>
      <div class="scene-play-anchor">
        <button
          type="button" class="scene-play" data-liquid-glass data-glass-radius="999" v-bind="surface"
          :disabled="scene !== 0" :aria-label="t(playing ? 'glass.pause' : 'glass.play')"
          @click="togglePlayback"
        >
          <AppIcon :name="playing ? 'pause' : 'play'" :size="19" />
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.showcase-frame { position: relative; height: min(790px, calc(100svh - 116px)); min-height: 570px; overflow: clip; border-radius: 36px; color: white; isolation: isolate; }
.showcase-media { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: 1; transition: opacity 600ms ease; }
.showcase-media.is-hidden { opacity: 0; }
.showcase-object { object-position: center 58%; }
.showcase-light { background: radial-gradient(ellipse at 70% 20%, #c6c9d2, transparent 55%), radial-gradient(ellipse at 20% 90%, #8fa6bd, transparent 45%), linear-gradient(130deg, #181d23, #5a6672 48%, #d6d5d0); }
.showcase-light::after { content: ''; position: absolute; inset: -30%; background: repeating-linear-gradient(115deg, transparent 0 90px, #ffffff18 92px 94px, transparent 96px 160px); }
.showcase-shade { position: absolute; inset: 0; background: linear-gradient(90deg, #08110970, transparent 75%), linear-gradient(0deg, #06130f75, transparent 32%); pointer-events: none; }
.showcase-copy { position: absolute; left: clamp(28px, 5vw, 72px); top: clamp(48px, 8vh, 90px); max-width: 620px; pointer-events: none; }
.showcase-eyebrow { font-size: 11px; font-weight: 550; letter-spacing: .22em; text-transform: uppercase; }
.showcase-copy h1 { margin: 24px 0; font-size: clamp(52px, 6.8vw, 90px); font-weight: 550; line-height: 1.06; letter-spacing: -.055em; text-wrap: balance; }
.showcase-copy h1 span { color: #ffffffe0; }
.showcase-description { max-width: 30ch; font-size: 16px; line-height: 1.8; color: #ffffffe0; }
.showcase-action-anchor { position: absolute; left: 55%; top: 57%; width: 292px; height: 120px; }
.showcase-action { display: flex; align-items: center; justify-content: space-between; padding: 0 30px; height: 76px; width: 100%; font-size: 19px; font-weight: 600; border-radius: 999px; }
.showcase-action-anchor > p { margin-top: 18px; text-align: center; font-size: 11px; color: #ffffffb8; letter-spacing: .08em; }
.scene-settings { position: absolute; top: 28px; right: 28px; width: 292px; height: 244px; pointer-events: none; z-index: 2; }
.scene-settings-surface { position: absolute; right: 0; top: 0; overflow: clip; pointer-events: auto; border-radius: 26px; }
.scene-settings-toggle { position: absolute; right: 0; top: 0; width: 52px; height: 52px; display: grid; place-items: center; border-radius: 50%; }
.scene-settings-content { padding: 24px; opacity: 0; width: min(292px, calc(100vw - 56px)); transition: opacity 120ms ease; }
.scene-settings-content.is-visible { opacity: 1; }
.scene-settings-content h2 { font-size: 17px; font-weight: 600; }
.scene-settings-content p { margin: 12px 0 16px; color: #ffffffb8; font-size: 12px; line-height: 1.6; max-width: 24ch; }
.material-options { display: flex; padding: 4px; gap: 4px; border-radius: 15px; background: #ffffff12; }
.material-options button { height: 42px; flex: 1; border-radius: 11px; display: flex; justify-content: center; gap: 6px; align-items: center; font-size: 13px; }
.material-options button[aria-pressed='true'] { background: #ffffff28; }
.settings-footnote { display: block; margin-top: 16px; font-size: 11px; color: #ffffffb8; }
.showcase-bottom { position: absolute; bottom: 28px; left: 32px; right: 32px; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.scene-caption { display: flex; align-items: center; gap: 10px; font-size: 11px; letter-spacing: .08em; width: 270px; }
.scene-dot { width: 5px; height: 5px; background: #d4f2d8; border-radius: 50%; }
.scene-index { margin-left: 8px; font-variant-numeric: tabular-nums; color: #ffffff80; }
.scene-controls-anchor { position: relative; width: 246px; height: 56px; }
.scene-controls { display: flex; align-items: center; width: 100%; height: 56px; padding: 6px; border-radius: 999px; }
.scene-controls button { position: relative; flex: 1; height: 44px; border-radius: 999px; z-index: 1; font-size: 13px; font-weight: 550; }
.scene-selection { position: absolute; top: 6px; left: 6px; width: calc((100% - 12px) / 3); height: 44px; background: #ffffff25; border-radius: 999px; box-shadow: inset 0 1px 1px #ffffff38; }
.scene-play-anchor { position: relative; width: 270px; height: 52px; }
.scene-play { position: absolute; right: 0; top: 0; width: 52px; height: 52px; border-radius: 50%; display: grid; place-items: center; }
.scene-play:disabled { color: #ffffff50; cursor: default; }
button { cursor: pointer; }
button:hover { background-color: #ffffff12; }
a:focus-visible, button:focus-visible { outline-color: white; outline-offset: -5px; }
@media (max-width: 700px) {
  .showcase-frame { min-height: 650px; height: calc(100svh - 108px); border-radius: 28px; }
  .showcase-copy { left: 26px; top: 84px; right: 24px; }
  .showcase-copy h1 { font-size: clamp(46px, 10vw, 64px); }
  .showcase-description { font-size: 14px; max-width: 26ch; }
  .scene-settings { top: 16px; right: 16px; }
  .showcase-action-anchor { left: 20px; right: 20px; width: auto; max-width: 292px; margin-inline: auto; top: auto; bottom: 148px; }
  .showcase-bottom { left: 18px; right: 18px; bottom: 22px; flex-wrap: wrap; }
  .scene-caption { width: 100%; margin-bottom: 6px; font-size: 10px; }
  .scene-play-anchor { width: 52px; }
  .scene-controls-anchor { width: min(246px, calc(100vw - 128px)); }
}
</style>
