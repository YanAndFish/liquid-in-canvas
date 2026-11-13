import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    target: 'es2023',
    sourcemap: true,
    // 保留可读的输出，压缩交给使用方的构建工具。
    minify: false,
    lib: {
      entry: {
        index: fileURLToPath(new URL('./src/index.ts', import.meta.url)),
        canvas: fileURLToPath(new URL('./src/canvas.ts', import.meta.url)),
        motion: fileURLToPath(new URL('./src/motion.ts', import.meta.url)),
      },
      formats: ['es'],
    },
    rolldownOptions: {
      // three.js 由使用方提供，避免页面中出现两份渲染器。
      external: [/^three(\/.*)?$/],
    },
  },
})
