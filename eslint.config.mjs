import antfu from '@antfu/eslint-config'

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
)
