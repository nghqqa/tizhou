import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: { reporter: ['text', 'html'] },
    // 仓库级默认 5s/10s 钩子超时在 GitHub 慢速 runner 上会让重初始化钩子
    // （如 VaultService.ensureBuiltinVault 建内建库）偶发超时误报，全局放宽
    hookTimeout: 60_000,
    testTimeout: 60_000
  }
})
