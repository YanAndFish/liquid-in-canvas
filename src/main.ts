import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router'
import { CART_KEY, createCartStore } from './stores/cart'
import '@unocss/reset/tailwind.css'
import 'virtual:uno.css'
import './styles/main.css'

const app = createApp(App)

app.use(router)
app.provide(CART_KEY, createCartStore())
app.mount('#app')
