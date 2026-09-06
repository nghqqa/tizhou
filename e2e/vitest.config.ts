import { defineConfig } from 'vitest/config'

// UI E2E 专用配置：与单元测试（tests/**/*.test.ts）完全隔离，不进入 npm test。
// 运行：npm run test:e2e
export default defineConfig({
  test: {
    environment: 'node',
    include: ['e2e/**/*.e2e.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    // Electron 实例有状态，文件内串行、多文件也不并行
    fileParallelism: false
  }
})
