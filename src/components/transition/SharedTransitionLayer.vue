<script setup lang="ts">
import type { BagFlight, ProductFlight, RectLike, SharedLayer } from '@/composables/sharedTransition'
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { registerSharedLayer } from '@/composables/sharedTransition'

const host = ref<HTMLDivElement | null>(null)

function relative(rect: RectLike): RectLike {
  const base = host.value?.getBoundingClientRect()
  if (!base)
    return rect
  return {
    left: rect.left - base.left,
    top: rect.top - base.top,
    width: rect.width,
    height: rect.height,
  }
}

function createClone(image: string, rect: RectLike, radius: number): HTMLImageElement | null {
  if (!host.value)
    return null
  if (typeof Element === 'undefined' || typeof Element.prototype.animate !== 'function')
    return null
  if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)
    return null

  const local = relative(rect)
  const clone = document.createElement('img')
  clone.src = image
  clone.alt = ''
  clone.draggable = false
  clone.style.position = 'fixed'
  clone.style.left = `${local.left}px`
  clone.style.top = `${local.top}px`
  clone.style.width = `${local.width}px`
  clone.style.height = `${local.height}px`
  clone.style.objectFit = 'cover'
  clone.style.borderRadius = `${radius}px`
  clone.style.transformOrigin = 'top left'
  clone.style.pointerEvents = 'none'
  clone.style.willChange = 'transform, opacity, border-radius'
  host.value.appendChild(clone)
  return clone
}

interface PendingFlight {
  clone: HTMLImageElement
  flight: ProductFlight
  timer: number
}

let pending: PendingFlight | null = null

function clearPending(): void {
  if (!pending)
    return
  window.clearTimeout(pending.timer)
  pending.clone.remove()
  pending = null
}

function startProductFlight(flight: ProductFlight): void {
  clearPending()
  const clone = createClone(flight.image, flight.from, flight.radius)
  if (!clone)
    return
  const timer = window.setTimeout(() => {
    if (pending?.clone === clone) {
      clone.remove()
      pending = null
    }
  }, 1200)
  pending = { clone, flight, timer }
}

function completeProductFlight(target: () => RectLike | null, toRadius: number, onDone: () => void): boolean {
  const current = pending
  if (!current)
    return false

  pending = null
  window.clearTimeout(current.timer)
  const clone = current.clone
  const flight = current.flight
  const started = performance.now()

  const animate = () => {
    const to = target()
    if (!to) {
      if (performance.now() - started > 260) {
        clone.remove()
        onDone()
        return
      }
      requestAnimationFrame(animate)
      return
    }

    const from = relative(flight.from)
    const destination = relative(to)
    const dx = destination.left - from.left
    const dy = destination.top - from.top
    const scaleX = destination.width / from.width
    const scaleY = destination.height / from.height

    const animation = clone.animate([
      {
        transform: 'translate3d(0, 0, 0) scale(1, 1)',
        borderRadius: `${flight.radius}px`,
      },
      {
        transform: `translate3d(${dx}px, ${dy}px, 0) scale(${scaleX}, ${scaleY})`,
        borderRadius: `${toRadius}px`,
      },
    ], {
      duration: 480,
      easing: 'cubic-bezier(0.22, 0.61, 0.36, 1)',
      fill: 'forwards',
    })

    animation.onfinish = () => {
      clone.remove()
      onDone()
    }
    animation.oncancel = () => {
      clone.remove()
      onDone()
    }
  }

  requestAnimationFrame(animate)
  return true
}

function flyToBag(flight: BagFlight, to: RectLike | null): void {
  if (!to)
    return
  const clone = createClone(flight.image, flight.from, 18)
  if (!clone)
    return

  const from = relative(flight.from)
  const target = relative(to)
  const size = Math.min(28, target.width || 28)
  const scaleX = size / from.width
  const scaleY = size / from.height
  const endX = target.left + target.width / 2 - from.left - (from.width * scaleX) / 2
  const endY = target.top + target.height / 2 - from.top - (from.height * scaleY) / 2
  const midX = endX * 0.55
  const midY = endY * 0.55 - 70
  const midScale = Math.max(scaleX, scaleY) * 1.25

  const animation = clone.animate([
    {
      transform: 'translate3d(0, 0, 0) scale(1, 1)',
      opacity: 1,
      borderRadius: '18px',
      offset: 0,
    },
    {
      transform: `translate3d(${midX}px, ${midY}px, 0) scale(${midScale}, ${midScale})`,
      opacity: 1,
      borderRadius: '50%',
      offset: 0.5,
    },
    {
      transform: `translate3d(${endX}px, ${endY}px, 0) scale(${scaleX}, ${scaleY})`,
      opacity: 0.15,
      borderRadius: '50%',
      offset: 1,
    },
  ], {
    duration: 620,
    easing: 'cubic-bezier(0.3, 0.7, 0.2, 1)',
    fill: 'forwards',
  })

  animation.onfinish = () => {
    clone.remove()
    const bag = typeof document === 'undefined'
      ? null
      : document.querySelector<HTMLElement>('[data-bag-target]')
    if (bag && typeof bag.animate === 'function') {
      bag.animate([
        { transform: 'scale(1)' },
        { transform: 'scale(1.16)' },
        { transform: 'scale(1)' },
      ], { duration: 320, easing: 'ease-out' })
    }
  }
  animation.oncancel = () => clone.remove()
}

const layer: SharedLayer = { startProductFlight, completeProductFlight, flyToBag }

onMounted(() => registerSharedLayer(layer))
onBeforeUnmount(() => {
  clearPending()
  registerSharedLayer(null)
})
</script>

<template>
  <div ref="host" class="shared-layer" aria-hidden="true" />
</template>
