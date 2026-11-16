import { defineConfig } from 'bumpp'

export default defineConfig({
  files: [
    'package.json',
    'packages/liquid-in-canvas/package.json',
  ],
  commit: 'chore: release v%s',
  tag: 'v%s',
  push: true,
})
