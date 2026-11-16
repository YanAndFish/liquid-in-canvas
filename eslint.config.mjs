import antfu from '@antfu/eslint-config'
import hot from './tools/eslint-plugin-hot/index.js'

export default antfu(
  {
    vue: true,
    typescript: true,
    unocss: true,
    ignores: [
      '**/dist',
      '**/coverage',
      '**/node_modules',
      '.vscode',
      'docs/HTML_IN_CANVAS_NOTES.md',
      'docs/performance/**/tools',
    ],
  },
  {
    settings: {
      unocss: {
        configPath: './apps/demo/uno.config.ts',
      },
    },
    rules: {
      'vue/multi-word-component-names': 'off',
    },
  },
  {
    name: 'liquid-in-canvas/hot-path',
    files: ['**/*.hot.ts'],
    plugins: { hot },
    rules: {
      'hot/no-alloc': 'error',
      'hot/no-closure': 'error',
      'eslint-comments/require-description': 'error',
    },
  },
)
