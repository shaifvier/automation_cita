// Monitor de citas ICP+ — Autorización de regreso, provincia de Barcelona (Firefox).
// Datos personales: variables de entorno CITA_NIE y CITA_NOMBRE, o se piden por stdin.
// Nunca se escriben en disco ni en la salida (la salida se redacta).
const { firefox } = require('playwright');
const { createInterface } = require('node:readline/promises');
const { setTimeout: pause } = require('node:timers/promises');

const entry = 'https://icp.administracionelectronica.gob.es/icpplustieb/citar?p=8&locale=es';
const procedure = 'AUTORIZACIÓN DE REGRESO';
const anyOffice = 'Cualquier oficina';
// ICP+ devolvió HTTP 429 a ~13 s por consulta. Pausa base 25 s; sube 10 s con cada 429 (máx. 60 s).
let officeDelayMs = Number(process.argv.find(a => a.startsWith('--pausa='))?.slice(8) || 25) * 1000;
// Medido en el log: ICP+ tolera ~13-14 validaciones cada ~10 min (≈1/min). 10 en 11 min sin problema;
// 14 en 10 min (45 s de pausa) y 13 en 3 min dieron 429. Por eso el suelo es 50 s (+~10 s de consulta).
const maxOfficeDelayMs = 150_000; // 22/11: 429 incluso a 90 s; margen para que se adapte
// Con 50 s seguía saltando un 429 cada ~25-30 min (media tolerada ≈0,9 consultas/min). Suelo: 60 s.
// Con certificado cada consulta tarda ~4 s (no ~10 s): con 60 s el ciclo bajaba a ~64 s y volvía el 429.
// Estable medido: ciclo ≥70 s por consulta. Suelo: 70 s.
// 21-22/11: con 70 s volvían los 429 cada ~30-40 min (cupo acumulado). Suelo: 85 s.
const minOfficeDelayMs = 85_000;
const decayEvery = 10;               // consultas seguidas sin 429 antes de recortar la pausa 5 s
const recheckEvery = 10;             // cada N rondas se vuelven a comprobar las comisarías sin trámite

// Comisarías sin el trámite (solo nombres de oficina, ningún dato personal).
const fs = require('node:fs');
const noTramiteFile = require('node:path').join(__dirname, 'sin-tramite.json');
const noTramite = new Set((() => { try { return JSON.parse(fs.readFileSync(noTramiteFile, 'utf8')); } catch { return []; } })());
const saveNoTramite = () => fs.writeFileSync(noTramiteFile, JSON.stringify([...noTramite].sort(), null, 2));
const roundDelayMs = 60_000;
const backoffMs = [60_000, 120_000, 300_000]; // tope de 5 minutos (decisión del usuario)
const unavailable = /en este momento no hay citas disponibles/i;
const rejected = /requested URL was rejected|access denied|too many requests/i;
const expired = /su sesión ha caducado/i;
const captcha = /captcha|no soy un robot|verifica que eres humano/i;

const args = process.argv.slice(2);
const diagnostic = args.includes('--diagnostico');
const traceNet = diagnostic || args.includes('--red');
const onlyAny = args.includes('--solo-cualquiera'); // por defecto se recorren todas las comisarías
const useCert = args.includes('--certificado');      // entrar por «Presentación con Cl@ve» con certificado electrónico
const certOrigin = 'https://pasarela-ident.clave.gob.es';
// Certificado (PEM), clave privada cifrada (PEM) y archivo con la contraseña. Nunca se suben al repositorio.
const certPemFile = process.env.CITA_CERT_PEM || require('node:path').join(__dirname, 'cert.pem');
const keyPemFile = process.env.CITA_KEY_PEM || require('node:path').join(__dirname, 'key.pem');   // cifrada con AES-256
const certPassFile = process.env.CITA_CERT_PASS_FILE || require('node:path').join(__dirname, '.p12pass');
const resumeFrom = args.find(a => a.startsWith('--desde='))?.slice('--desde='.length).trim();

let nie = '', name = '';
const ts = () => new Date().toLocaleTimeString('es-ES');
function redact(text) {
  let out = String(text);
  for (const secret of [nie, name, ...name.split(/\s+/)].filter(s => s && s.length > 2)) {
    out = out.split(secret).join('[…]').split(secret.toLowerCase()).join('[…]');
  }
  return out;
}
const log = (...parts) => console.log(redact([ts(), ...parts].join(' ')));
const beep = (n = 3) => process.stdout.write('\x07'.repeat(n));

function tracePortal(page, getStep) {
  const origin = new URL(entry).origin;
  const routes = /^\/(icpplustieb)\/\/?(index|citar|selectSede|procesarRespuestaClave|ac[A-Z][A-Za-z]{0,24}|infogenerica)?\/?$/;
  const route = raw => {
    const u = new URL(raw);
    if (u.origin !== origin) return null;
    return routes.test(u.pathname) ? u.pathname : '[otra ruta de ICP+]';
  };
  const out = ev => console.log(JSON.stringify({ time: new Date().toISOString(), step: redact(getStep()), ...ev }));
  page.on('response', async response => {
    const req = response.request();
    if (!req.isNavigationRequest() || req.frame() !== page.mainFrame()) return;
    const path = route(response.url());
    if (!path) return;
    const sec = await response.securityDetails().catch(() => null);
    const prev = req.redirectedFrom();
    out({ path, method: req.method(), status: response.status(),
      redirectedFrom: prev ? route(prev.url()) : null, tls: sec?.protocol ?? null });
  });
  page.on('requestfailed', req => {
    if (!req.isNavigationRequest() || req.frame() !== page.mainFrame()) return;
    const path = route(req.url());
    if (!path) return;
    out({ path, method: req.method(), failure: (req.failure()?.errorText ?? 'error de red').slice(0, 80) });
  });
}

async function readCredentials() {
  nie = (process.env.CITA_NIE || '').trim().toUpperCase();
  name = (process.env.CITA_NOMBRE || '').trim().toUpperCase();
  if (!nie || !name) {
    const input = createInterface({ input: process.stdin, output: process.stdout });
    try {
      if (!nie) nie = (await input.question('NIE: ')).trim().toUpperCase();
      if (!name) name = (await input.question('Nombre y apellidos: ')).trim().toUpperCase();
    } finally { input.close(); }
  }
  if (!/^[XYZ]\d{7}[A-Z]$/.test(nie) || !name) throw new Error('Revisa el formato del NIE y el nombre.');
}

class Hold extends Error {} // pantalla que el usuario debe ver: hueco, CAPTCHA o desconocida

async function main() {
  if (!diagnostic) await readCredentials();

  // El servidor de ICP+ no envía el certificado intermedio (RapidSSL TLS RSA CA G1).
  // Con enterprise_roots, Firefox usa el almacén de Windows, que sí lo tiene. La validación TLS sigue activa.
  const browser = await firefox.launch({ headless: false,
    firefoxUserPrefs: { 'security.enterprise_roots.enabled': true } });
  // --certificado: Playwright presenta el certificado SOLO a la pasarela de identificación de Cl@ve.
  // La clave está cifrada (AES-256); la contraseña se lee de un archivo y nunca se muestra.
  let contextOptions = {};
  if (useCert) {
    const passphrase = fs.readFileSync(certPassFile, 'utf8').replace(/^﻿/, '').replace(/[\r\n]+$/, '');
    contextOptions = { clientCertificates: [{ origin: certOrigin, certPath: certPemFile, keyPath: keyPemFile, passphrase }] };
  }
  let lastStatus = 0;
  let step = 'abrir Barcelona';
  let context, page, officeMenu, policeMenu, accept;
  // Sesión de navegador nueva (cookies y caché limpias, como cerrar y abrir Firefox).
  // Solo se usa tras un fallo de la identificación con Cl@ve; NUNCA tras 429/«Request Rejected»/CAPTCHA.
  async function newSession() {
    if (context) await context.close().catch(() => {});
    context = await browser.newContext(contextOptions);
    page = await context.newPage();
    page.setDefaultTimeout(30_000);
    page.on('response', r => {
      const req = r.request();
      if (req.isNavigationRequest() && req.frame() === page.mainFrame()) lastStatus = r.status();
    });
    if (traceNet) tracePortal(page, () => step);
    officeMenu = page.getByRole('combobox', { name: 'Selecciona Oficina:' });
    policeMenu = page.getByRole('combobox', { name: 'TRÁMITES POLICÍA NACIONAL' });
    accept = page.getByRole('button', { name: 'Aceptar', exact: true });
  }
  await newSession();
  const bodyText = () => page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  const alive = () => browser.isConnected() && !page.isClosed();

  async function openBarcelona() {
    lastStatus = 0;
    step = 'abrir Barcelona';
    let response;
    try {
      response = await page.goto(entry, { waitUntil: 'domcontentloaded' });
    } catch (error) { // timeout o error de red al abrir: no es motivo para detener el monitor
      log('Detalle:', error.message.split('\n')[0]);
      return 'fallo temporal';
    }
    if (response && [403, 429].includes(response.status())) return 'rechazo';
    if (response && response.status() >= 500) return 'fallo temporal';
    // La página hace una comprobación JS (TSPD) y vuelve a cargarse. Si se elige oficina antes de esa
    // recarga, la página se rehace a mitad y «Aceptar» no responde: esperar a que la red quede quieta.
    try {
      await officeMenu.waitFor();
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(800);
      await officeMenu.waitFor();
    } catch {
      const body = await bodyText();
      if (rejected.test(body) || [403, 429].includes(lastStatus)) {
        if (body) log('Página de rechazo:', body.replace(/\s+/g, ' ').slice(0, 300));
        return 'rechazo';
      }
      if (captcha.test(body)) return 'captcha';
      return 'fallo temporal';
    }
    return 'ok';
  }

  // Clic con diagnóstico: si algo tapa el botón (banner, aviso), registrar por qué y pulsarlo desde la página.
  async function clickRobust(locator, name) {
    try {
      await locator.click({ timeout: 10_000 });
    } catch (error) {
      const why = String(error.message).split('\n')
        .filter(l => /intercepts|not visible|not enabled|not stable|outside of the viewport|detached|waiting for/i.test(l))
        .slice(-2).map(l => l.trim()).join(' | ');
      log(`Clic en «${name}» bloqueado (${why || error.message.split('\n')[0]}). Pulso el botón desde la página.`);
      await locator.evaluate(el => el.click());
    }
  }
  let loggedFirstResponse = false;
  // Cada consulta va primero con certificado. Si Cl@ve falla en esa consulta, se repite ESA MISMA consulta
  // sin Cl@ve en el acto; la siguiente vuelve a intentarlo con certificado (decisión del usuario, 23/11).
  let lastViaCert = false, forceNoCert = false;
  let citarLogs = 0;
  // Pausa fija entre pasos (24/11, a petición del usuario): no ir tan deprisa entre clic y clic.
  // No oculta la automatización ni cambia nada del navegador; solo espacia los pasos (~10-12 s por consulta).
  const stepPause = () => page.waitForTimeout(3000);
  // Código que acompaña al «no hay citas» (0017, 0501…), para comparar con la respuesta manual (sin código).
  let lastCode = '';
  const codeOf = text => {
    const flat = text.replace(/\s+/g, ' ');
    const m = flat.match(/no hay citas disponibles\.?\s*(\d{4})\b/i)   // «… disponibles 0017»
      || flat.match(/\d{2}:\d{2}:\d{2}(\d{4})\b/)                     // «10:31:590501» (código pegado a la hora)
      || flat.match(/\b(0\d{3})\b\s*Cod\. Oper/i);
    if (m) return m[1];
    return /En breve, la Oficina/i.test(flat) ? 'ninguno, mensaje «En breve…» como el manual' : 'ninguno';
  };
  async function checkOffice(label) {
    lastViaCert = false;
    lastCode = '';
    step = 'seleccionar ' + label;
    // Elegir oficina hace un POST a /selectSede que recarga la página: esperar a que termine.
    const current = await officeMenu.evaluate(e => e.options[e.selectedIndex]?.text.trim());
    if (current !== label) {
      const nav = page.waitForEvent('framenavigated',
        { predicate: f => f === page.mainFrame(), timeout: 8000 }).catch(() => null);
      await officeMenu.selectOption({ label });
      await nav;
      await page.waitForLoadState('domcontentloaded');
    }
    await officeMenu.waitFor();
    const nowSelected = await officeMenu.evaluate(e => e.options[e.selectedIndex]?.text.trim());
    if (nowSelected !== label) return 'fallo temporal';
    await policeMenu.locator('option', { hasText: procedure }).first()
      .waitFor({ state: 'attached', timeout: 10_000 }).catch(() => {});
    const options = await policeMenu.locator('option').allTextContents();
    // Solo es «sin trámite» si el desplegable cargó de verdad. Cada comisaría trae su propia lista y puede
    // ser corta (Guadalajara: 3), así que solo vacío o con únicamente el texto inicial cuenta como fallo.
    if (options.filter(o => o.trim() && !/^Despliega/i.test(o.trim())).length === 0) return 'fallo temporal';
    if (!options.some(o => o.trim() === procedure)) return 'sin trámite';
    await policeMenu.selectOption({ label: procedure });
    await stepPause();
    await clickRobust(accept, 'Aceptar');

    // Ruta de esta consulta: con certificado, salvo en el reintento inmediato sin Cl@ve.
    const viaCert = useCert && !forceNoCert;
    lastViaCert = viaCert;
    const entryLabel = viaCert ? /^Presentación con Cl@ve$/ : /^Presentación sin Cl@ve$/;
    step = viaCert ? 'abrir Presentación con Cl@ve' : 'abrir Presentación sin Cl@ve';
    const entryButton = page.getByText(entryLabel).first();
    const interruption = page.getByText(expired).or(page.getByText(rejected));
    await entryButton.or(interruption).first().waitFor();
    if (await interruption.first().isVisible()) {
      return expired.test(await interruption.first().innerText()) ? 'sesión caducada' : 'rechazo';
    }
    await stepPause();
    await clickRobust(entryButton, 'Presentación con/sin Cl@ve');

    const nieBox = page.locator('#txtIdCitado');
    const nameBox = page.locator('#txtDesCitado');
    const formMsg = page.getByText(expired).or(page.getByText(rejected));
    if (viaCert) {
      // Pasarela Cl@ve: elegir «eIdentifier» (certificado). Durante 60 min la sesión puede saltarse este paso.
      step = 'identificación con certificado';
      const eid = page.getByText(/^(Access eIdentifier|Acceder eIdentificador|Acceder a eIdentificador)$/i).first();
      await eid.or(nieBox).or(formMsg).first().waitFor({ timeout: 60_000 });
      if (await eid.isVisible().catch(() => false)) {
        await clickRobust(eid, 'eIdentifier');
        await nieBox.or(formMsg).first().waitFor({ timeout: 60_000 });
      }
    }
    step = 'formulario';
    await nieBox.or(formMsg).first().waitFor();
    if (await formMsg.first().isVisible()) {
      return expired.test(await formMsg.first().innerText()) ? 'sesión caducada' : 'rechazo';
    }
    // OJO: con Cl@ve, ICP+ muestra aquí un aviso «En este momento no hay citas disponibles» ANTES de enviar
    // el formulario. No es la respuesta: hay que rellenar NIE y nombre, pulsar Aceptar y evaluar la página siguiente.
    // Campos obligatorios inesperados → no inventar valores.
    const extra = await page.$$eval('input[required], select[required]', els =>
      els.filter(e => !['txtIdCitado', 'txtDesCitado'].includes(e.id)).map(e => e.id || e.name));
    if (extra.length) { log('Campos obligatorios nuevos:', extra.join(', ')); return 'revisión'; }
    if (diagnostic) return 'formulario disponible';

    // Cerrar el aviso «INFORMACIÓN» (X) si tapa el formulario y bajar hasta los campos.
    const closeInfo = page.locator('.modal.show .close, .modal.in .close, [role="dialog"] .close, button[aria-label="Close"], button[aria-label="Cerrar"]').first();
    if (await closeInfo.isVisible().catch(() => false)) await closeInfo.click().catch(() => {});
    await nieBox.scrollIntoViewIfNeeded();

    const nieRadio = page.locator('#rdbTipoDocNie');
    if (await nieRadio.count() && !(await nieRadio.isChecked())) await nieRadio.check();
    // Con certificado, hacer lo mismo que una persona: «Copiar a datos solicitante» (datos del certificado).
    // Solo si ese botón no existe o no rellena nada, se escriben NIE y nombre a mano.
    const copyButton = page.locator('#btnCopiar');
    let copied = false;
    // 24/11: probado y DESACTIVADO. Con «Copiar a datos solicitante» el filtro anti-bots rechazó 2 de 2 envíos
    // (antes, 0 rechazos en ~4.500 envíos escribiendo NIE y nombre). Se mantiene el código por si se revisa.
    const useCopyButton = false;
    if (useCopyButton && viaCert && await copyButton.isVisible().catch(() => false)) {
      await clickRobust(copyButton, 'Copiar a datos solicitante');
      await page.waitForTimeout(500);
      copied = !!(await nieBox.inputValue().catch(() => '')) && !!(await nameBox.inputValue().catch(() => ''));
      if (!copied) log('«Copiar a datos solicitante» no rellenó el formulario; escribo NIE y nombre.');
    }
    if (!copied) {
      await nieBox.fill(nie);
      await nameBox.fill(name);
    }
    await stepPause();
    const sendButton = page.locator('#btnEnviar');
    await sendButton.scrollIntoViewIfNeeded();
    // Evaluar SOLO la página que llega tras enviar (la actual contiene el aviso previo de «no hay citas»).
    const formUrl = page.url();
    const navigated = page.waitForEvent('framenavigated',
      { predicate: f => f === page.mainFrame(), timeout: 30_000 }).then(() => true).catch(() => false);
    await clickRobust(sendButton, 'Aceptar (formulario)');
    if (!(await navigated)) {
      log('El formulario no avanzó tras pulsar Aceptar (URL igual: ' + (page.url() === formUrl) + ').');
      return 'fallo temporal';
    }
    await page.waitForLoadState('domcontentloaded');

    step = 'validar datos';
    if (!loggedFirstResponse) {
      loggedFirstResponse = true;
      log('Respuesta tras enviar el formulario (' + new URL(page.url()).pathname.replace(/;.*/, '') + '): ' +
        (await bodyText()).replace(/\s+/g, ' ').slice(0, 600));
    }
    const request = page.getByRole('button', { name: 'Solicitar Cita', exact: true });
    const msg = page.getByText(unavailable).or(page.getByText(expired)).or(page.getByText(rejected))
      .or(page.getByText(captcha));
    await request.or(msg).first().waitFor();
    let text = await bodyText();
    if (rejected.test(text)) return 'rechazo';
    if (expired.test(text)) return 'sesión caducada';
    if (unavailable.test(text)) { lastCode = codeOf(text); return 'sin citas'; }
    if (captcha.test(text)) return 'captcha';

    step = 'solicitar cita';
    await stepPause();
    await clickRobust(request, 'Solicitar Cita');
    await request.waitFor({ state: 'hidden' });
    await page.waitForLoadState('domcontentloaded');
    await page.getByRole('heading', { name: /cita previa extranjería/i }).first().waitFor().catch(() => {});
    await page.waitForTimeout(1500);
    text = await bodyText();
    // Dejar constancia de la pantalla tras «Solicitar Cita» (fragmento alrededor del mensaje) para verificarla.
    if (citarLogs < 3) {
      citarLogs++;
      const flat = text.replace(/\s+/g, ' ');
      const at = flat.search(unavailable);
      log('Pantalla tras «Solicitar Cita» (' + new URL(page.url()).pathname.replace(/;.*/, '') + '), ' +
        (await page.locator('select:visible, input[type=radio]:visible').count()) + ' controles de elección visibles: ' +
        (at >= 0 ? flat.slice(Math.max(0, at - 200), at + 200) : flat.slice(0, 500)));
    }
    if (rejected.test(text)) return 'rechazo';
    if (expired.test(text)) return 'sesión caducada';
    // Si hay desplegables/opciones para elegir oficina u hora, NO es «sin citas» aunque aparezca la frase en otra parte.
    const choices = await page.locator('select:visible, input[type=radio]:visible').count();
    if (unavailable.test(text) && choices === 0) { lastCode = codeOf(text); return 'sin citas'; }
    if (captcha.test(text)) return 'captcha';
    return 'hueco';
  }

  async function holdForUser(kind, label) {
    const banner = kind === 'hueco'
      ? `*** HUECO DETECTADO (${label}) — termina la reserva en la ventana de Firefox ***`
      : `*** REVISIÓN NECESARIA: ${kind} (${label}) — mira la ventana de Firefox ***`;
    log(banner);
    log('URL:', new URL(page.url()).pathname);
    log('Texto de la página:\n' + redact((await bodyText()).replace(/\n{2,}/g, '\n').slice(0, 2500)));
    // Pitar cada 20 s durante 10 min; la ventana sigue abierta hasta que el usuario la cierre.
    for (let i = 0; i < 30 && alive(); i++) { beep(3); await pause(20_000); }
    log('Ventana conservada. Cierra Firefox para terminar.');
    await new Promise(resolve => { page.once('close', resolve); browser.once('disconnected', resolve); });
  }

  let failures = 0;
  let cleanStreak = 0;
  function onSuccess() {
    failures = 0;
    if (++cleanStreak >= decayEvery && officeDelayMs > minOfficeDelayMs) {
      officeDelayMs = Math.max(officeDelayMs - 5_000, minOfficeDelayMs);
      cleanStreak = 0;
      log(`${decayEvery} consultas sin 429: pausa entre comisarías ahora ${officeDelayMs / 1000} s.`);
    }
  }
  async function backoff(reason) {
    const wait = backoffMs[Math.min(failures, backoffMs.length - 1)];
    const firstOfEpisode = failures === 0; // los reintentos del mismo bloqueo no vuelven a subir la pausa
    failures++;
    cleanStreak = 0;
    if (lastStatus === 429 && firstOfEpisode && officeDelayMs < maxOfficeDelayMs) {
      officeDelayMs = Math.min(officeDelayMs + 10_000, maxOfficeDelayMs);
      log(`HTTP 429: pausa entre comisarías ahora ${officeDelayMs / 1000} s.`);
    }
    log(`${reason} (último HTTP ${lastStatus || '—'}, paso: ${step}). Reintento en ${wait / 1000} s.`);
    await pause(wait);
  }

  try {
    if (diagnostic) {
      for (const label of ['CNP GUADALAJARA, Guadalajara, 1, Barcelona', anyOffice]) {
        const opened = await openBarcelona();
        if (opened !== 'ok') { log(label, '—', opened); continue; }
        log(label, '—', await checkOffice(label).catch(e => 'paso sin verificar: ' + step + ' (' + e.message.split('\n')[0] + ')'));
      }
      return;
    }

    let round = 0;
    let pending = resumeFrom || null;
    // «Cualquier oficina» al inicio y cada `anyEvery` comisarías: cubre toda la provincia con el mismo cupo.
    const anyEvery = 5;
    const interleave = list => list.reduce((out, l, i) => {
      out.push(l);
      if ((i + 1) % anyEvery === 0 && i < list.length - 1) out.push(anyOffice);
      return out;
    }, [anyOffice]);

    while (alive()) {
     try {
      const opened = await openBarcelona();
      if (opened === 'captcha') throw new Hold('captcha');
      if (opened !== 'ok') { await backoff(opened); continue; }

      const offices = (await officeMenu.locator('option').allTextContents())
        .map(l => l.trim()).filter(l => l && l !== anyOffice);
      if (!offices.length) { await backoff('el desplegable no muestra oficinas'); continue; }
      round++;
      const recheck = round % recheckEvery === 0;
      let active = recheck ? offices : offices.filter(l => !noTramite.has(l));
      if (!onlyAny && !recheck && active.length < offices.length) {
        log(`ronda ${round}: se saltan ${offices.length - active.length} comisarías sin trámite (se revisan cada ${recheckEvery} rondas).`);
      }
      if (pending) {
        const q = pending.toLocaleLowerCase('es');
        // Coincidencia exacta primero (reanudación interna); si no, por texto, que debe ser única.
        let hits = offices.flatMap((l, i) => l === pending ? [i] : []);
        if (!hits.length) hits = offices.flatMap((l, i) => l.toLocaleLowerCase('es').includes(q) ? [i] : []);
        if (hits.length === 1) active = active.filter(l => offices.indexOf(l) >= hits[0]);
        else log(`«${pending}» coincide con ${hits.length} oficinas: empiezo la ronda desde el principio.`);
      }
      const labels = onlyAny ? [anyOffice] : interleave(active);
      pending = null;
      if (!onlyAny) log(`ronda ${round}: ${labels.length} consultas, empezando por ${labels[0]}`);

      let problem = null;
      const nextOffice = i => labels.slice(i).find(l => l !== anyOffice) || null;
      for (const [i, label] of labels.entries()) {
        if (i > 0) {
          await pause(officeDelayMs);
          if (!alive()) return;
          const again = await openBarcelona();
          if (again === 'captcha') throw new Hold('captcha');
          if (again !== 'ok') { problem = again; pending = nextOffice(i); break; }
        }
        const runCheck = async () => {
          try {
            return await checkOffice(label);
          } catch (error) {
            const body = await bodyText();
            const s = rejected.test(body) || [403, 429].includes(lastStatus) ? 'rechazo'
              : captcha.test(body) ? 'captcha'
              : expired.test(body) ? 'sesión caducada'
              : 'fallo temporal';
            if (s === 'fallo temporal') log('Detalle:', error.message.split('\n')[0]);
            return s;
          }
        };
        let status = await runCheck();
        // Si falló la ruta con certificado (no por 429), repetir AHORA esta consulta sin Cl@ve.
        if (useCert && lastViaCert && ['fallo temporal', 'sesión caducada'].includes(status) && lastStatus !== 429) {
          log(`ronda ${round}`, label, '—', status, '(con certificado): reinicio la sesión del navegador (cookies y caché limpias) y repito la consulta sin Cl@ve.');
          await newSession(); // la siguiente consulta con certificado empezará también con sesión limpia
          const reopened = await openBarcelona();
          if (reopened === 'captcha') throw new Hold('captcha');
          if (reopened === 'ok') {
            forceNoCert = true;
            try { status = await runCheck(); } finally { forceNoCert = false; }
          } else status = reopened;
        }
        log(`ronda ${round}`, label, '—', status + (status === 'sin citas' ? ` (código ${lastCode || 'ninguno'})` : '') + (useCert && status !== 'sin trámite' && !lastViaCert ? ' [sin Cl@ve]' : ''));
        if (status === 'hueco') throw new Hold('hueco', { cause: label });
        if (status === 'captcha' || status === 'revisión') throw new Hold(status, { cause: label });
        if (['rechazo', 'fallo temporal', 'sesión caducada'].includes(status)) {
          problem = status;
          pending = nextOffice(i); // reanudar en la primera comisaría pendiente tras la espera
          break;
        }
        if (label !== anyOffice) {
          if (status === 'sin trámite' && !noTramite.has(label)) { noTramite.add(label); saveNoTramite(); }
          if (status === 'sin citas' && noTramite.delete(label)) { saveNoTramite(); log(label, 'vuelve a ofrecer el trámite.'); }
        }
        onSuccess();
      }
      if (problem) { await backoff(problem); continue; }
      // --solo-cualquiera: una consulta por «ronda»; usar la pausa adaptativa (85-150 s), no los 60 s fijos.
      await pause(onlyAny ? officeDelayMs : roundDelayMs);
     } catch (error) {
      // Hueco/CAPTCHA/pantalla a revisar: salir y conservar la ventana. Cualquier otro error: esperar y seguir.
      if (error instanceof Hold || !alive()) throw error;
      log('Error inesperado (' + step + '):', String(error.message || error).split('\n')[0]);
      await backoff('fallo temporal');
     }
    }
  } catch (error) {
    if (error instanceof Hold && alive()) {
      await holdForUser(error.message, error.cause || '—');
    } else {
      beep(1);
      console.error(redact('Monitor detenido. ' + (error.message || error)));
      process.exitCode = 1;
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

// Salida explícita: con certificado, el proxy TLS de Playwright mantiene vivo el proceso tras cerrar.
main().catch(e => { console.error(redact(e.message)); process.exitCode = 1; })
  .finally(() => process.exit(process.exitCode || 0));
