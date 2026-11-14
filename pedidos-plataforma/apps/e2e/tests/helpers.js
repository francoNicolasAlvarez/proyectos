const path = require('path');
const { pathToFileURL } = require('url');
const { expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;

const proto = (name) =>
  pathToFileURL(path.resolve(__dirname, '../../../docs/ux/prototype', name, 'index.html')).href;

/**
 * Falla ante violaciones WCAG A/AA serias o críticas (excluye la barra de demostración).
 * Espera a que terminen los avisos animados: medir su contraste a mitad del desvanecimiento da falsos positivos.
 */
async function expectAccessible(page, label) {
  await page.waitForFunction(() => !document.querySelector('#toast.show'), undefined, { timeout: 5000 });
  await page.waitForTimeout(350);
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).exclude('.demo-bar').analyze();
  const bad = results.violations.filter((v) => ['serious', 'critical'].includes(v.impact));
  const report = bad.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
  expect(report, `${label}: ${report.join('\n')}`).toEqual([]);
}

module.exports = {
  customerUrl: proto('customer-app'),
  panelUrl: proto('venue-panel'),
  expectAccessible,
};
