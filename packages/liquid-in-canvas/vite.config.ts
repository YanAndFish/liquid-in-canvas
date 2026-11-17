import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    target: 'es2023',
    sourcemap: true,
    minify: false,
    lib: {
      entry: {
        index: fileURLToPath(new URL('./src/index.ts', import.meta.url)),
        canvas: fileURLToPath(new URL('./src/canvas.ts', import.meta.url)),
        motion: fileURLToPath(new URL('./src/motion.ts', import.meta.url)),
        tuner: fileURLToPath(new URL('./src/tuner.ts', import.meta.url)),
      },
      formats: ['es'],
    },
  },
})
