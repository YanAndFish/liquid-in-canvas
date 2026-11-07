import { createRouter, createWebHistory } from 'vue-router'
import { getStageScroller } from '@/stage/scroll'
import { routes } from './routes'

const savedPositions = new Map<string, number>()

export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
  scrollBehavior(to, _from, savedPosition) {
    const scroller = getStageScroller()

    if (scroller) {
      if (savedPosition) {
        scroller.scrollTo({
          top: savedPositions.get(to.fullPath) ?? 0,
          behavior: 'instant',
        })
      }
      else if (to.hash) {
        const id = decodeURIComponent(to.hash.slice(1))
        const target = id
          ? document.getElementById(id)
          : null
        if (target) {
          const top = target.getBoundingClientRect().top
            - scroller.getBoundingClientRect().top
            + scroller.scrollTop
            - 96
          scroller.scrollTo({ top, behavior: 'smooth' })
        }
      }
      else {
        scroller.scrollTo({ top: 0, behavior: 'instant' })
      }
      return false
    }

    if (savedPosition)
      return savedPosition
    if (to.hash)
      return { el: to.hash, top: 96, behavior: 'smooth' }
    return { top: 0 }
  },
})

router.beforeEach((_to, from) => {
  const scroller = getStageScroller()
  if (scroller)
    savedPositions.set(from.fullPath, scroller.scrollTop)
})
