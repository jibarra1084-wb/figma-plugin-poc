import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  root: '.',
  base: '', // Use empty base for Figma plugin compatibility
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: false,
    rollupOptions: {
      input: resolve(__dirname, 'ui.html'),
      output: {
        entryFileNames: 'ui.js',
        assetFileNames: '[name].[ext]',
        format: 'iife',
        inlineDynamicImports: true, // Bundle everything into one file
      },
    },
  },
});
