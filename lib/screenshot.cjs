'use strict';

const ICP_ORIGIN = 'https://icp.administracionelectronica.gob.es';

async function captureTelegramScreenshot(page, { secrets = [], origin = ICP_ORIGIN, timeoutMs = 2000 } = {}) {
  let timer;
  try {
    const url = page.url();
    if (new URL(url).origin !== origin) return null;
    const mask = [page.locator('input:not([type]), input[type=text], input[type=email], input[type=tel], input[type=password], textarea')];
    for (const secret of [...new Set(secrets.filter(Boolean))]) {
      const pattern = new RegExp(String(secret).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      mask.push(page.getByText(pattern));
    }
    const capture = page.screenshot({ type: 'jpeg', quality: 65, fullPage: false, timeout: timeoutMs, mask, maskColor: '#222222' })
      .then(bytes => page.url() === url ? bytes : null).catch(() => null);
    const deadline = new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); });
    return await Promise.race([capture, deadline]);
  } catch {
    // Never expose screenshot errors, DOM text, URLs or applicant values.
    return null;
  } finally { clearTimeout(timer); }
}

module.exports = { captureTelegramScreenshot };
