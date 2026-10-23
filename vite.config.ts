import { defineConfig } from 'vite';
import { headerMarkup, footerMarkup } from './vendor/site-ui/shell.mjs';

export default defineConfig(({command}) => ({
  base: '/pg-playground/',
  server: {allowedHosts: ['terminal.local']},
  preview: {allowedHosts: ['terminal.local']},
  optimizeDeps: { exclude: ['@electric-sql/pglite'] },
  worker: { format: 'es' },
  plugins: [{
    name: 'site-shell',
    transformIndexHtml(html) {
      if (command === 'build') html = html.replace('<meta charset="UTF-8" />', '<meta charset="UTF-8" /><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\' \'wasm-unsafe-eval\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data:; worker-src \'self\' blob:; connect-src \'self\'; object-src \'none\'; base-uri \'self\'; form-action \'none\'" />');
      return html.replace('<!-- SITE_HEADER -->', headerMarkup({active: 'pg-playground', tools: [
        {id: 'pg-playground', name: 'PostgreSQL 实验台', url: '/pg-playground/', description: '在浏览器里运行 SQL，探索执行计划。'},
        {id: 'totp', name: 'TOTP 验证器', url: '/totp/', description: '在浏览器里管理动态验证码。'},
        {id: 'portfolio-pilot', name: '仓位助手', url: '/portfolio-pilot/', description: '记录仓位与目标比例。'}
      ]})).replace('<!-- SITE_FOOTER -->', footerMarkup());
    }
  }]
}));
