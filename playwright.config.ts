import { defineConfig, devices } from '@playwright/test'

const PORT = 4173

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000, // сценарии ходят в реальный бэкенд по сети
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${PORT}/first-logic/`, trace: 'retain-on-failure' },
  // dist должен быть собран заранее: npm run test:e2e делает это сам
  webServer: {
    command: 'node e2e/pages-server.mjs',
    port: PORT,
    env: { PORT: String(PORT) },
    reuseExistingServer: true,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, grepInvert: /@desktop-only/ },
  ],
})
