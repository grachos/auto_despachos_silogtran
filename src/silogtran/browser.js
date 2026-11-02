// Headless Chromium launcher used only to solve the AWS WAF challenge.
// On Vercel (or when WAF_CHROME_PATH is unset) uses @sparticuz/chromium; locally set WAF_CHROME_PATH.
import puppeteer from 'puppeteer-core';

export async function launchBrowser() {
  const localPath = process.env.WAF_CHROME_PATH;
  if (localPath && !process.env.VERCEL) {
    return puppeteer.launch({
      executablePath: localPath,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
  }
  const chromium = (await import('@sparticuz/chromium')).default;
  return puppeteer.launch({
    executablePath: await chromium.executablePath(),
    headless: true,
    args: chromium.args,
  });
}
