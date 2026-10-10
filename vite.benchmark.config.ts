import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import {
  fileURLToPath,
  URL
} from 'node:url';

export default defineConfig({
  // 让Vite能够编译.vue文件
  plugins: [vue()],

  // 保持和正式项目相同的@路径别名
  resolve: {
    alias: {
      '@': fileURLToPath(
        new URL('./src', import.meta.url)
      )
    }
  },

  build: {
    // 测试产物单独输出，
    // 不覆盖正式项目的dist目录
    outDir: 'dist-benchmark',

    // 每次构建前清空旧测试产物
    emptyOutDir: true,

    rollupOptions: {
      input: {
        // 只构建我们的性能测试页面
        benchmark: fileURLToPath(
          new URL(
            './benchmark.html',
            import.meta.url
          )
        )
      }
    }
  }
});