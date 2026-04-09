import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import fs from 'fs';
import {defineConfig, loadEnv} from 'vite';

// Collect all HTML files at root level for multi-page build
function getHtmlEntries() {
  const root = __dirname;
  const entries: Record<string, string> = {};
  fs.readdirSync(root).forEach(file => {
    if (file.endsWith('.html')) {
      const name = file.replace('.html', '');
      entries[name] = path.resolve(root, file);
    }
  });
  return entries;
}

// Plugin to copy static assets that are not imported via ES modules
function copyStaticAssets() {
  const assetFiles = [
    'styles.css',
    'app.js',
    'aura.js',
    'blink-detection.js',
    'cam_0.jpg',
    'cam_2.jpg',
    'camera_check.jpg',
  ];
  return {
    name: 'copy-static-assets',
    writeBundle() {
      const outDir = path.resolve(__dirname, 'dist');
      for (const file of assetFiles) {
        const src = path.resolve(__dirname, file);
        const dest = path.resolve(outDir, file);
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, dest);
        }
      }
    },
  };
}

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  return {
    plugins: [react(), tailwindcss(), copyStaticAssets()],
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    build: {
      rollupOptions: {
        input: getHtmlEntries(),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify - file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
    },
  };
});
