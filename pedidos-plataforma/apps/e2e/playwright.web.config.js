// @ts-check
// E2E de la app REAL del cliente (apps/web) contra la API real con base en memoria y pago simulado.
// Los E2E de los prototipos siguen en playwright.config.js.
const { defineConfig, devices } = require('@playwright/test');

const API = 'http://127.0.0.1:3100';
const WEB = 'http://localhost:5174';

module.exports = defineConfig({
  testDir: './web-tests',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,                      // un solo servidor de pruebas compartido
  reporter: [['list']],
  use: { baseURL: WEB, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'movil', use: { ...devices['Pixel 7'] } }],
  webServer: [
    {
      command: 'node --import tsx scripts/e2e-server.ts',
      cwd: '../api',
      url: `${API}/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { E2E_API_PORT: '3100', E2E_WEB_ORIGIN: WEB },
    },
    {
      command: 'npx vite --port 5174 --strictPort',
      cwd: '../web',
      url: WEB,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { VITE_API_TARGET: API },
    },
  ],
});
