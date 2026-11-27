'use strict';

const ICP_ORIGIN = 'https://icp.administracionelectronica.gob.es';

async function captureTelegramScreenshotResult(page, { secrets = [], origin = ICP_ORIGIN, timeoutMs = 5000 } = {}) {
  let timer;
  let source = 'other';
  try {
    if (page.isClosed?.()) return { status: 'page_unavailable', source };
    const url = page.url();
    const currentOrigin = new URL(url).origin;
    source = currentOrigin === origin ? 'icp' : 'other';
    if (source !== 'icp') return { status: 'origin_not_allowed', source };
    const mask = [page.locator('input:not([type]), input[type=text], input[type=email], input[type=tel], input[type=password], textarea')];
    for (const secret of [...new Set(secrets.filter(Boolean))]) {
      const pattern = new RegExp(String(secret).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      mask.push(page.getByText(pattern));
    }
    const capture = page.screenshot({ type: 'jpeg', quality: 65, fullPage: false, timeout: timeoutMs, mask, maskColor: '#222222' })
      .then(image => page.url() === url ? { status: 'captured', image, source } : { status: 'page_changed', source })
      .catch(error => ({ status: error?.name === 'TimeoutError' ? 'capture_timeout' : page.isClosed?.() ? 'page_unavailable' : 'capture_failed', source }));
    const deadline = new Promise(resolve => { timer = setTimeout(() => resolve({ status: 'capture_timeout', source }), timeoutMs); });
    return await Promise.race([capture, deadline]);
  } catch {
    // Never expose screenshot errors, DOM text, URLs or applicant values.
    return { status: 'capture_failed', source };
  } finally { clearTimeout(timer); }
}

async function captureTelegramScreenshot(page, options) {
  return (await captureTelegramScreenshotResult(page, options)).image || null;
}

module.exports = { captureTelegramScreenshot, captureTelegramScreenshotResult };
