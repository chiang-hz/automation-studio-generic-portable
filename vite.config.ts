import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/modern/',
  define: {'process.env.NODE_ENV': JSON.stringify('production')},
  publicDir: false,
  build: { outDir: 'public/modern', emptyOutDir: true, sourcemap: false,
    lib: { entry: 'frontend/src/main.tsx', formats: ['es'], fileName: () => 'studio.js', cssFileName: 'studio' },
    rollupOptions: { output: { assetFileNames: 'assets/[name][extname]' } } },
  worker: { format: 'es' }
});
