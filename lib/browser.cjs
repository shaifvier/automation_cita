'use strict';
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const path = require('node:path');
const fs = require('node:fs');
const { chromium, firefox } = require('playwright');

function certificateOptions(env = process.env) {
  const origin = 'https://pasarela-ident.clave.gob.es';
  const certPath = env.CITA_CERT_PEM || path.join(__dirname, '..', 'cert.pem');
  const keyPath = env.CITA_KEY_PEM || path.join(__dirname, '..', 'key.pem');
  const passFile = env.CITA_CERT_PASS_FILE || path.join(__dirname, '..', '.p12pass');
  try {
    const key = fs.readFileSync(keyPath, 'utf8');
    if (!/ENCRYPTED PRIVATE KEY|Proc-Type:\s*4,ENCRYPTED/.test(key)) throw new Error();
    const cert = fs.readFileSync(certPath, 'utf8');
    if (!/BEGIN CERTIFICATE/.test(cert)) throw new Error();
    const passphrase = fs.readFileSync(passFile, 'utf8').replace(/^\uFEFF/, '').replace(/[\r\n]+$/, '');
    if (!passphrase) throw new Error();
    return { clientCertificates: [{ origin, certPath, keyPath, passphrase }] };
  } catch { throw new Error('Certificado no disponible: revisa las tres rutas locales y la clave cifrada.'); }
}

function helperEnvironment(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.toUpperCase().startsWith('CITA_')));
}

function startBridge({ python, script, timeout = 60_000 } = {}) {
  const localPython = path.join(__dirname, '..', '.venv', 'Scripts', 'python.exe');
  const env = helperEnvironment();
  const child = spawn(python || process.env.CITA_PYTHON || (fs.existsSync(localPython) ? localPython : 'python'),
    ['-u', script || path.join(__dirname, '..', 'scripts', 'seleniumbase_bridge.py')],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], env: { ...env, PYTHONIOENCODING: 'utf-8' } });
  let nextId = 0;
  const pending = new Map();
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const timer = setTimeout(() => rejectReady(new Error('Tiempo de inicio de SeleniumBase agotado.')), timeout);
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.event === 'ready') {
      try {
        const endpoint = new URL(message.endpoint);
        if (!['http:', 'ws:'].includes(endpoint.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)) throw new Error();
        clearTimeout(timer); resolveReady(message.endpoint);
      } catch { rejectReady(new Error('Endpoint CDP local inválido.')); }
    } else if (message.event === 'error') {
      clearTimeout(timer); rejectReady(new Error('No se pudo iniciar SeleniumBase. Comprueba el entorno virtual.'));
    } else if (pending.has(message.id)) {
      const { resolve, reject, timer: requestTimer } = pending.get(message.id);
      pending.delete(message.id); clearTimeout(requestTimer);
      message.ok ? resolve() : reject(new Error('El manejador de CAPTCHA no pudo continuar.'));
    }
  });
  const fail = () => {
    clearTimeout(timer); rejectReady(new Error('El proceso SeleniumBase terminó.'));
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('El proceso SeleniumBase terminó.')); }
    pending.clear();
  };
  child.on('error', fail); child.on('exit', fail);
  child.stdin.on('error', () => {});
  return {
    ready,
    request(command, targetId, timeoutMs = 60_000) {
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('CAPTCHA: tiempo agotado.')); }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ id, command, targetId }) + '\n');
      });
    },
    async close() {
      clearTimeout(timer);
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.stdin.end(JSON.stringify({ command: 'quit' }) + '\n');
      await new Promise(resolve => {
        const timer = setTimeout(() => { child.kill(); resolve(); }, 5000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
      lines.close();
    },
  };
}

async function launchSession(mode, contextOptions = {}) {
  let bridge, browser, context;
  try {
    if (mode === 'seleniumbase') {
      bridge = startBridge();
      browser = await chromium.connectOverCDP(await bridge.ready, { timeout: 30_000 });
      context = contextOptions.clientCertificates ? await browser.newContext(contextOptions) : browser.contexts()[0];
      if (!context) throw new Error();
    } else if (mode === 'chrome') {
      browser = await chromium.launch({ channel: 'chrome', headless: false });
      context = await browser.newContext(contextOptions);
    } else {
      browser = await firefox.launch({ headless: false, firefoxUserPrefs: { 'security.enterprise_roots.enabled': true } });
      context = await browser.newContext(contextOptions);
    }
    const page = mode === 'seleniumbase' && !contextOptions.clientCertificates
      ? context.pages()[0] || await context.newPage() : await context.newPage();
    page.setDefaultTimeout(30_000);
    return {
      browser, context, page,
      async solveChallenge() {
        if (!bridge) return false;
        let cdp;
        try {
          cdp = await context.newCDPSession(page);
          const { targetInfo } = await cdp.send('Target.getTargetInfo');
          await page.bringToFront();
          await bridge.request('challenge', targetInfo.targetId);
          return true; // Caller must verify the page, not trust this return value.
        } catch { return false; }
        finally { if (cdp) await cdp.detach().catch(() => {}); }
      },
      async close() {
        await browser.close().catch(() => {});
        if (bridge) await bridge.close();
      },
    };
  } catch {
    if (browser) await browser.close().catch(() => {});
    if (bridge) await bridge.close();
    throw new Error(`No se pudo crear la sesión ${mode}${contextOptions.clientCertificates ? ' con certificado' : ''}. No se ha cambiado de autenticación.`);
  }
}
module.exports = { certificateOptions, helperEnvironment, startBridge, launchSession };
