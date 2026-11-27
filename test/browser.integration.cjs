'use strict';
// Local fixtures only: this suite never contacts ICP+ or reads .env.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { options, runMonitor, holdForUser } = require('../cita-regreso.cjs');
const { launchSession, certificateOptions } = require('../lib/browser.cjs');
const { createPortal, ANY_OFFICE } = require('../lib/portal.cjs');
const { captureTelegramScreenshot, captureTelegramScreenshotResult } = require('../lib/screenshot.cjs');

const CONTACT = { phone: '600000001', email: 'synthetic@example.invalid' };
const contactForm = '<h1>Datos de contacto para la cita</h1><form action="/reserve" method="post"><label for="txtTelefono">Teléfono</label><input id="txtTelefono" type="tel"><label for="emailUNO">Correo electrónico</label><input id="emailUNO" type="email"><label for="emailDOS">Confirmar correo electrónico</label><input id="emailDOS" type="email"><button>Continuar</button></form>';
const observerSnapshot = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'watch_monitor.py'), 'utf8').match(/SNAPSHOT_JS = r'''([\s\S]*?)'''/)[1];

async function fixture() {
  let final = 'available', reservations = 0, validations = 0, certificateLabel = ' Access   eIdentifier ', blocks = 0;
  const cookies = [];
  let finalSequence = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/slow-font.woff') {
      setTimeout(() => { res.writeHead(200, { 'content-type': 'font/woff' }); res.end(Buffer.alloc(0)); }, 3000);
      return;
    }
    if (req.url === '/') {
      cookies.push(req.headers.cookie || '');
      if (blocks-- > 0) { res.writeHead(429, { 'Retry-After': '1' }); res.end('Too many requests'); return; }
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    let body;
    switch (req.url) {
      case '/': body = `<label for="office">Selecciona Oficina:</label><select id="office"><option value="any">Cualquier oficina</option></select>
        <label for="procedure">TRÁMITES POLICÍA NACIONAL</label><select id="procedure"><option value="regreso">AUTORIZACIÓN DE REGRESO</option></select>
        <button onclick="location='/presentation'">Aceptar</button>`; break;
      case '/presentation': body = `<a href="/form">Presentación sin Cl@ve</a><a href="/clave">Presentación con Cl@ve</a>`; break;
      case '/clave': body = `<input type="button" value="${certificateLabel}" onclick="location='/form'">`; break;
      case '/form': body = `<form action="/validated" method="post"><input id="txtIdCitado" required><input id="txtDesCitado" required><button id="btnEnviar">Aceptar</button></form>`; break;
      case '/validated': validations++; body = `<button onclick="location='/selection'">Solicitar Cita</button>`; break;
      case '/selection': {
        const view = finalSequence.length ? finalSequence.shift() : final;
        body = view === 'available'
        ? `<h1>Selecciona Oficina</h1><label for="sede">Oficina</label><select id="sede" onchange="location='/reserve'"><option value="">Selecciona</option><option value="1">Oficina de prueba</option></select><button onclick="location='/reserve'">Confirmar reserva</button>`
        : view === 'unavailable' ? '<p>En este momento no hay citas disponibles. 0501</p><label>Idioma<select><option value="es">Español</option></select></label>'
        : view === 'contact' ? contactForm
        : view === 'temporary' ? '<p>Se ha producido un error en el sistema, por favor inténtelo de nuevo. En el caso de que el error persista, puede obtener ayuda.</p><button onclick="location=\'/reserve\'">Aceptar</button>'
        : view === 'expired' ? '<p>Su sesión ha caducado por permanecer demasiado tiempo inactiva.</p><p>Deberás iniciar de nuevo la solicitud de la cita previa.</p><button onclick="location=\'/reserve\'">Aceptar</button>'
        : '<p>Página desconocida</p><button onclick="location=\'/reserve\'">Continuar</button>'; break;
      }
      case '/contact': body = contactForm; break;
      case '/contact-expired': body = '<p>Su sesión ha caducado</p>' + contactForm; break;
      case '/slow-screenshot': body = '<style>@font-face{font-family:latefont;src:url(/slow-font.woff)}h1{font:22px latefont}</style><h1>Slow local screenshot fixture</h1>'; break;
      case '/reserve': reservations++; body = 'ERROR: booking boundary crossed'; break;
      default: body = '<p>Fixture</p>';
    }
    res.end(`<!doctype html><meta charset="utf-8">${body}`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { entry: `http://127.0.0.1:${server.address().port}/`, setFinal: value => { final = value; }, setCertificateLabel: value => { certificateLabel = value; },
    setFinalSequence: values => { finalSequence = [...values]; },
    setBlocks: value => { blocks = value; }, counts: () => ({ reservations, validations, cookies: [...cookies] }), close: () => new Promise(resolve => server.close(resolve)) };
}

for (const mode of ['firefox', 'chrome', 'seleniumbase']) {
  test(`${mode}: full fixture flow stops before reservation and classifies pages`, { timeout: 180000 }, async () => {
    const site = await fixture();
    let session;
    try {
      session = await launchSession(mode);
      const portal = createPortal(session, { entry: site.entry, stepDelayMs: 0, sleep: async () => {}, identity: { nie: 'X0000000X', name: 'SYNTHETIC FIXTURE' } });
      for (const [final, expected] of [['available', 'posible disponibilidad'], ['unavailable', 'sin citas'], ['unknown', 'revisión'], ['expired', 'sesión caducada'], ['temporary', 'fallo temporal']]) {
        site.setFinal(final);
        assert.equal((await portal.open()).result, 'ok');
        const result = await portal.checkOffice(ANY_OFFICE);
        assert.equal(result.result, expected);
        if (final === 'unavailable') assert.equal(result.code, '0501');
        assert.equal(site.counts().reservations, 0);
      }
      assert.equal(site.counts().validations, 5);
      site.setFinal('available');
      let certPortal;
      for (const label of [' Access   eIdentifier ', 'Acceso DNIe / Certificado electrónico']) {
        site.setCertificateLabel(label);
        certPortal = createPortal(session, { entry: site.entry, certificate: true, stepDelayMs: 0, sleep: async () => {}, identity: { nie: 'X0000000X', name: 'SYNTHETIC FIXTURE' } });
        assert.equal((await certPortal.open()).result, 'ok');
        assert.equal((await certPortal.checkOffice(ANY_OFFICE)).result, 'posible disponibilidad');
        assert.equal(site.counts().reservations, 0);
      }
      if (mode === 'seleniumbase') assert.equal(await session.solveChallenge(), true, 'bridge selects exact CDP target');
      certPortal.hold();
      const before = site.counts();
      assert.equal((await certPortal.open()).reason, 'human_handoff');
      assert.equal((await certPortal.checkOffice(ANY_OFFICE)).reason, 'human_handoff');
      assert.deepEqual(site.counts(), before);

      site.setFinal('contact');
      const contactPortal = createPortal(session, { entry: site.entry, stepDelayMs: 0, sleep: async () => {}, identity: { nie: 'X0000000X', name: 'SYNTHETIC FIXTURE' } });
      assert.equal((await contactPortal.open()).result, 'ok');
      assert.equal((await contactPortal.checkOffice(ANY_OFFICE)).result, 'posible disponibilidad');
      assert.equal(await contactPortal.prefillContact(CONTACT), 'stopped', 'contact writes require an availability handoff');
      contactPortal.hold('posible disponibilidad');
      assert.equal(await contactPortal.prefillContact(CONTACT), 'filled');
      assert.deepEqual(await session.page.locator('form input').evaluateAll(inputs => inputs.map(input => input.value)), [CONTACT.phone, CONTACT.email, CONTACT.email]);
      assert.equal(await contactPortal.prefillContact(CONTACT), 'ready');
      assert.equal(site.counts().reservations, 0, 'filling never submits the form');

      await session.page.goto(site.entry + 'contact');
      await session.page.locator('#txtTelefono').fill('MANUAL EDIT');
      assert.equal(await contactPortal.prefillContact(CONTACT), 'existing_contact');
      assert.equal(await session.page.locator('#emailUNO').inputValue(), '');
      assert.equal(await session.page.locator('#txtTelefono').inputValue(), 'MANUAL EDIT');
      await session.page.goto(site.entry + 'contact-expired');
      assert.equal(await contactPortal.prefillContact(CONTACT), 'blocked');
      assert.equal(await session.page.locator('#txtTelefono').inputValue(), '');
      await session.page.goto(site.entry + 'contact');
      await session.page.locator('#emailDOS').evaluate(el => { el.readOnly = true; });
      assert.equal(await contactPortal.prefillContact(CONTACT), 'waiting');
      assert.equal(await session.page.locator('#txtTelefono').inputValue(), '');
      const other = await fixture();
      try {
        await session.page.goto(other.entry + 'contact');
        assert.equal(await contactPortal.prefillContact(CONTACT), 'stopped', 'no contact data on another origin');
        assert.equal(await session.page.locator('#txtTelefono').inputValue(), '');
        assert.equal(other.counts().reservations, 0);
      } finally { await other.close(); }
      assert.equal(site.counts().reservations, 0);
    } finally { if (session) await session.close(); await site.close(); }
  });
}

test('contact handoff waits for manual navigation, fills once, and leaves submission to the user', { timeout: 60000 }, async () => {
  const site = await fixture();
  let session;
  const controller = new AbortController();
  try {
    session = await launchSession('chrome');
    const portal = createPortal(session, { entry: site.entry, stepDelayMs: 0, sleep: async () => {}, identity: { nie: 'X0000000X', name: 'SYNTHETIC FIXTURE' } });
    await portal.open();
    assert.equal((await portal.checkOffice(ANY_OFFICE)).result, 'posible disponibilidad');
    let statusReady;
    const filled = new Promise(resolve => { statusReady = resolve; });
    const statuses = [];
    const pending = holdForUser(session, portal, 'posible disponibilidad', ANY_OFFICE, {
      contact: CONTACT, signal: controller.signal, sendNotification: async () => true,
      reportContact: status => { statuses.push(status); if (status === 'filled') statusReady(); },
    });
    try {
      await new Promise(resolve => setTimeout(resolve, 200));
      assert.equal(session.page.url(), site.entry + 'selection', 'handoff never clicks the office or date');
      // Simulate the person continuing to the contact page; the monitor never navigates here.
      await session.page.goto(site.entry + 'contact');
      await Promise.race([filled, new Promise((_, reject) => setTimeout(() => reject(new Error('No contact prefill')), 7000))]);
      assert.deepEqual(statuses, ['waiting', 'filled']);
      const observed = await session.page.evaluate(observerSnapshot);
      assert.equal(observed.candidate, true, 'observer recognizes contact-only availability too');
      assert.equal(JSON.stringify(observed).includes(CONTACT.email), false, 'observer flags never contain contact values');
      await session.page.locator('#emailUNO').fill('manual@example.invalid');
      await new Promise(resolve => setTimeout(resolve, 1200));
      assert.equal(await session.page.locator('#emailUNO').inputValue(), 'manual@example.invalid');
      await session.page.locator('#emailUNO').evaluate(el => el.parentNode.appendChild(el.cloneNode()));
      assert.equal((await session.page.evaluate(observerSnapshot)).candidate, false, 'ambiguous duplicate email is not a contact-form candidate');
      assert.equal(site.counts().reservations, 0);
    } finally { controller.abort(); await pending; }
  } finally { if (session) await session.close(); await site.close(); }
});

test('Telegram screenshot captures a masked local browser view without submitting or changing values', { timeout: 60000 }, async () => {
  const site = await fixture();
  let session;
  try {
    session = await launchSession('chrome');
    await session.page.goto(site.entry + 'contact');
    await session.page.locator('#txtTelefono').fill(CONTACT.phone);
    await session.page.locator('#emailUNO').fill(CONTACT.email);
    await session.page.locator('#emailDOS').fill(CONTACT.email);
    const image = await captureTelegramScreenshot(session.page, { secrets: [CONTACT.phone, CONTACT.email], origin: new URL(site.entry).origin });
    assert.ok(Buffer.isBuffer(image)); assert.equal(image.subarray(0, 3).toString('hex'), 'ffd8ff');
    assert.equal(await session.page.locator('#txtTelefono').inputValue(), CONTACT.phone);
    assert.equal(await session.page.locator('#emailUNO').inputValue(), CONTACT.email);
    assert.equal(site.counts().reservations, 0);
    await session.page.goto(site.entry + 'slow-screenshot', { waitUntil: 'domcontentloaded' });
    await session.page.evaluate(() => { void document.fonts.load('22px latefont'); });
    const origin = new URL(site.entry).origin;
    assert.equal((await captureTelegramScreenshotResult(session.page, { origin, timeoutMs: 2000 })).status, 'capture_timeout');
    assert.equal((await captureTelegramScreenshotResult(session.page, { origin })).status, 'captured', 'five-second budget tolerates a slow font');
    assert.equal(site.counts().reservations, 0);
  } finally { if (session) await session.close(); await site.close(); }
});

test('SeleniumBase CDP: encrypted PEM context presents a client certificate', { timeout: 180000 }, async () => {
  fs.mkdirSync(path.join(__dirname, '..', 'artifacts'), { recursive: true });
  const dir = fs.mkdtempSync(path.join(__dirname, '..', 'artifacts', 'mtls-'));
  const cert = path.join(dir, 'cert.pem'), key = path.join(dir, 'key.pem'), pass = path.join(dir, 'pass.txt');
  fs.writeFileSync(pass, 'synthetic-fixture-only');
  const config = path.join(dir, 'openssl.cnf'); fs.writeFileSync(config, '');
  const openssl = process.env.OPENSSL || 'C:/Strawberry/c/bin/openssl.exe';
  execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-config', config, '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=synthetic-fixture', '-passout', 'pass:synthetic-fixture-only'], { stdio: 'ignore' });
  let presented = false;
  const server = https.createServer({ cert: fs.readFileSync(cert), key: fs.readFileSync(key), passphrase: 'synthetic-fixture-only', ca: fs.readFileSync(cert), requestCert: true, rejectUnauthorized: true }, (req, res) => {
    presented = req.socket.authorized && req.socket.getPeerCertificate().subject?.CN === 'synthetic-fixture';
    res.end('fixture');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let session;
  try {
    const opts = certificateOptions({ CITA_CERT_PEM: cert, CITA_KEY_PEM: key, CITA_CERT_PASS_FILE: pass });
    opts.clientCertificates[0].origin = `https://127.0.0.1:${server.address().port}`;
    // The fixture has a self-signed SERVER certificate. Production never enables this.
    opts.ignoreHTTPSErrors = true;
    session = await launchSession('seleniumbase', opts);
    await session.page.goto(opts.clientCertificates[0].origin);
    assert.equal(presented, true);
    assert.equal(await session.solveChallenge(), true, 'helper can address certificate-context tab');
  } finally {
    if (session) await session.close();
    await new Promise(resolve => server.close(resolve));
    // Remove only the exact synthetic files created by this test.
    for (const file of [cert, key, pass, config]) fs.unlinkSync(file);
    fs.rmdirSync(dir);
  }
});

test('rate-limit recovery retains actual browser cookies and stops before booking', { timeout: 60000 }, async () => {
  const site = await fixture();
  site.setBlocks(3); site.setFinal('unavailable');
  let clock = Date.now(), launches = 0;
  const waits = [], notifications = [];
  try {
    const result = await runMonitor(options(['--browser=chrome', '--solo-cualquiera', '--max-consultas=4']), {
      readIdentity: async () => ({ nie: 'X0000000X', name: 'SYNTHETIC FIXTURE' }),
      launchSession: async mode => {
        launches++;
        const session = await launchSession(mode);
        await session.context.addCookies([{ name: 'probe-session', value: 'synthetic-retained-cookie', url: site.entry }]);
        return session;
      },
      createPortal: (session, opts) => createPortal(session, { ...opts, entry: site.entry, stepDelayMs: 0, sleep: async () => {} }),
      now: () => clock, sleep: async ms => { waits.push(ms); clock += ms; },
      output: () => {}, notify: async kind => notifications.push(kind),
    });
    assert.equal(result.checks, 4);
    assert.deepEqual(waits, [130000, 130000, 900000]);
    assert.deepEqual(notifications, ['enfriamiento', 'reanudado']);
    assert.equal(launches, 1);
    assert.equal(site.counts().cookies.length, 4);
    assert.ok(site.counts().cookies.every(cookie => cookie.includes('probe-session=synthetic-retained-cookie')));
    assert.equal(site.counts().reservations, 0);
    assert.equal(site.counts().validations, 1);
  } finally { await site.close(); }
});

test('an expired check after cooldown restarts the request with cookies intact', { timeout: 60000 }, async () => {
  const site = await fixture();
  site.setBlocks(3); site.setFinalSequence(['expired', 'unavailable']);
  let clock = Date.now(), launches = 0;
  const waits = [], notices = [], records = [];
  try {
    const result = await runMonitor(options(['--browser=chrome', '--solo-cualquiera', '--max-consultas=5']), {
      readIdentity: async () => ({ nie: 'X0000000X', name: 'SYNTHETIC FIXTURE' }),
      launchSession: async mode => {
        launches++;
        const session = await launchSession(mode);
        await session.context.addCookies([{ name: 'expiry-session', value: 'synthetic-retained-cookie', url: site.entry }]);
        return session;
      },
      createPortal: (session, opts) => createPortal(session, { ...opts, entry: site.entry, stepDelayMs: 0, sleep: async () => {} }),
      now: () => clock, sleep: async ms => { waits.push(ms); clock += ms; },
      output: record => records.push(record), notify: async kind => notices.push(kind),
    });
    assert.equal(result.checks, 5);
    assert.deepEqual(waits, [130000, 130000, 900000, 130000]);
    assert.deepEqual(notices, ['enfriamiento', 'sesion_caducada', 'reanudado']);
    assert.equal(records.find(r => r.result === 'sesión caducada').reason, 'session_restart_scheduled');
    assert.equal(launches, 1); assert.equal(site.counts().cookies.length, 5);
    assert.ok(site.counts().cookies.every(cookie => cookie.includes('expiry-session=synthetic-retained-cookie')));
    assert.equal(site.counts().validations, 2); assert.equal(site.counts().reservations, 0);
  } finally { await site.close(); }
});
