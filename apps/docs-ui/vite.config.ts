import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * The docs UI ships inside the npm package as static files, so the build must
 * stay fully self-contained: relative asset paths, no CDN references, and no
 * runtime dependency on a dev server (spec sections 10 and 142).
 */
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5173,
    strictPort: false,
  },
});
