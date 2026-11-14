import { fileURLToPath } from 'node:url'
import { mergeConfig } from 'vite'
import config from '../../vite.config.ts'

export default mergeConfig(config, {
  build: {
    sourcemap: true,
    rollupOptions: {
      input: [
        fileURLToPath(new URL('./index.html', import.meta.url)),
        fileURLToPath(new URL('./scroll.html', import.meta.url)),
        // 画面检查页一并构建，供迁移前后的截图比对使用。
        fileURLToPath(new URL('../visual/liquid-glass.html', import.meta.url)),
        fileURLToPath(new URL('../visual/glass-content.html', import.meta.url)),
      ],
    },
  },
})
