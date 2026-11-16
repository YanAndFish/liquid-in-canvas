import { defineConfig } from 'bumpp'

// `pnpm release`：同时修改工作区根与库的版本号，提交、打 `v*` 标签并推送；
// 标签推送后由 `.github/workflows/release.yml` 发布到 npm。演示与内部工具是私有包，版本不随之变化。
export default defineConfig({
  files: [
    'package.json',
    'packages/liquid-in-canvas/package.json',
  ],
  commit: 'chore: release v%s',
  tag: 'v%s',
  push: true,
})
