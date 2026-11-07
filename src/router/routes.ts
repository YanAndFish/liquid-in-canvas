import type { RouteRecordRaw } from 'vue-router'
import HomeView from '@/pages/HomeView.vue'

export const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'home',
    component: HomeView,
  },
  {
    path: '/product/:slug',
    name: 'product',
    component: () => import('@/pages/ProductView.vue'),
    props: true,
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('@/pages/NotFoundView.vue'),
  },
]
