import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'

// Electron 内置 Chromium 原生支持 woff2，剔除仅用于旧浏览器的 KaTeX woff/ttf 冗余字体以缩小安装包体积
function stripRedundantKatexFonts(): Plugin {
  return {
    name: 'strip-redundant-katex-fonts',
    generateBundle(_options, bundle) {
      for (const fileName of Object.keys(bundle)) {
        if (/KaTeX_.*\.(woff|ttf)$/i.test(fileName)) {
          delete bundle[fileName]
        }
      }
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve('src/main/index.ts')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve('src/preload/index.ts'),
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs'
        }
      }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    plugins: [react(), stripRedundantKatexFonts()],
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    }
  }
})
