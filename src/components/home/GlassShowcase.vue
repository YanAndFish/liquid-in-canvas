<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useLocale } from '@/composables/useLocale'

const { t } = useLocale()
const frame = ref<HTMLElement | null>(null)
const video = ref<HTMLVideoElement | null>(null)
let observer: IntersectionObserver | null = null
let reduced = false

onMounted(() => {
  reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  if (reduced)
    return

  const element = frame.value
  const media = video.value
  if (!element || !media)
    return

  if (typeof IntersectionObserver === 'function') {
    observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1]
      if (!entry)
        return
      if (entry.isIntersecting)
        play(media)
      else
        pause(media)
    }, { rootMargin: '240px' })
    observer.observe(element)
  }
  play(media)
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
  if (video.value)
    pause(video.value)
})

function play(media: HTMLVideoElement): void {
  try {
    const result = media.play()
    if (result)
      void result.catch(() => {})
  }
  catch {}
}

function pause(media: HTMLVideoElement): void {
  try {
    media.pause()
  }
  catch {}
}
</script>

<template>
  <section class="relative py-14 sm:py-20" aria-labelledby="glass-title">
    <div class="showcase-track">
      <div ref="frame" class="showcase-frame">
        <video
          ref="video"
          class="showcase-video"
          src="/media/liquid-glass.mp4"
          poster="/media/liquid-glass-poster.jpg"
          muted
          loop
          playsinline
          preload="metadata"
          aria-hidden="true"
        />
        <div class="showcase-shade" aria-hidden="true" />

        <div class="showcase-copy">
          <p class="eyebrow text-white/55">
            {{ t('glass.eyebrow') }}
          </p>
          <h2 id="glass-title" class="mt-4 max-w-[12ch] text-[clamp(2.6rem,6vw,5.6rem)] text-white leading-[0.92] font-display">
            {{ t('glass.title') }}
          </h2>
          <p class="mt-5 max-w-[38ch] text-sm text-white/72 leading-relaxed sm:text-[15px]">
            {{ t('glass.body') }}
          </p>
        </div>

        <div
          data-liquid-glass
          data-glass-anchor=".showcase-frame"
          data-glass-radius="28"
          data-glass-blur="18"
          data-glass-refraction="22"
          data-glass-specular="0.75"
          data-glass-shadow="0.4"
          data-glass-shadow-size="32"
          class="showcase-card bottom-5 left-5 sm:bottom-8 sm:left-8"
        >
          <p class="eyebrow text-white/55">
            {{ t('glass.lens.label') }}
          </p>
          <h3 class="mt-3 text-2xl text-white font-display">
            {{ t('glass.lens.title') }}
          </h3>
          <p class="mt-2 max-w-[24ch] text-xs text-white/70 leading-relaxed">
            {{ t('glass.lens.body') }}
          </p>
        </div>

        <div
          data-liquid-glass
          data-glass-variant="clear"
          data-glass-anchor=".showcase-frame"
          data-glass-radius="999"
          data-glass-blur="8"
          data-glass-refraction="16"
          data-glass-specular="0.95"
          data-glass-shadow="0.3"
          data-glass-shadow-size="26"
          class="showcase-pill right-5 top-5 hidden sm:right-8 sm:top-8 sm:inline-flex"
        >
          <span class="h-1.5 w-1.5 rounded-full bg-mint" />
          <span class="text-[10px] text-white tracking-[0.18em] font-mono uppercase">{{ t('glass.live') }}</span>
        </div>

        <div
          data-liquid-glass
          data-glass-anchor=".showcase-frame"
          data-glass-radius="24"
          data-glass-blur="14"
          data-glass-refraction="20"
          data-glass-dispersion="0.3"
          data-glass-specular="0.7"
          data-glass-shadow="0.34"
          data-glass-shadow-size="28"
          class="showcase-card bottom-5 right-5 hidden sm:bottom-8 sm:right-8 sm:block"
        >
          <p class="eyebrow text-white/55">
            {{ t('glass.specular.label') }}
          </p>
          <h3 class="mt-3 text-2xl text-white font-display">
            {{ t('glass.specular.title') }}
          </h3>
          <p class="mt-2 max-w-[24ch] text-xs text-white/70 leading-relaxed">
            {{ t('glass.specular.body') }}
          </p>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.showcase-track {
  height: 138vh;
}

.showcase-frame {
  position: sticky;
  top: 5.5rem;
  height: min(76vh, 46rem);
  overflow: hidden;
  border-radius: 2rem;
  isolation: isolate;
}

.showcase-video {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.showcase-shade {
  position: absolute;
  inset: 0;
  background:
    linear-gradient(105deg, rgba(4, 8, 12, 0.62), rgba(4, 8, 12, 0.08) 52%, rgba(4, 8, 12, 0.26)),
    linear-gradient(0deg, rgba(4, 8, 12, 0.52), transparent 42%);
}

.showcase-copy {
  position: absolute;
  left: clamp(1.25rem, 4vw, 3rem);
  top: clamp(1.5rem, 5vw, 3.5rem);
  max-width: 36rem;
}

.showcase-card {
  position: absolute;
  width: min(17rem, calc(100% - 2.5rem));
  padding: 1.25rem 1.35rem;
  pointer-events: none;
}

.showcase-pill {
  position: absolute;
  align-items: center;
  gap: 0.55rem;
  padding: 0.7rem 0.95rem;
  pointer-events: none;
}

@media (max-width: 640px) {
  .showcase-track {
    height: 120vh;
  }

  .showcase-frame {
    top: 4.8rem;
    height: 66vh;
  }
}
</style>
