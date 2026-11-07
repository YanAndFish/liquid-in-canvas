import { createApp } from 'vue'
import { CART_KEY, createCartStore } from '@/composables/useCart'
import App from './App.vue'
import '@unocss/reset/tailwind.css'
import 'virtual:uno.css'
import './styles/main.css'

const app = createApp(App)

app.provide(CART_KEY, createCartStore())
app.mount('#app')
