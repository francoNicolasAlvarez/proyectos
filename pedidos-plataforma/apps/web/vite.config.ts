import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// En desarrollo la app y la API comparten origen (localhost:5173): /api se reenvía a la API.
// Así la cookie de sesión funciona sin CORS y la comprobación CSRF de la API ve un origen permitido.
const api = process.env.VITE_API_TARGET ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': { target: api, changeOrigin: false, rewrite: (p) => p.replace(/^\/api/, '') } } },
  test: { environment: 'jsdom', globals: true, setupFiles: ['./test/setup.ts'], css: false },
});
