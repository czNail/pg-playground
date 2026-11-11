import { defineConfig } from 'vite';

export default defineConfig({
  base: '/pg-playground/',
  server: {allowedHosts: ['terminal.local']},
  preview: {allowedHosts: ['terminal.local']},
  optimizeDeps: { exclude: ['@electric-sql/pglite'] },
  worker: { format: 'es' },
  build: {assetsInlineLimit: 0},
  plugins: [{
    name: 'content-security-policy',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace('<meta charset="UTF-8" />', '<meta charset="UTF-8" /><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\' \'wasm-unsafe-eval\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data:; worker-src \'self\' blob:; connect-src \'self\'; object-src \'none\'; base-uri \'self\'; form-action \'none\'" />');
    }
  }]
});
