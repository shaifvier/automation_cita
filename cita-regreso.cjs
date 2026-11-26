'use strict';
// Monitor ICP+: hands off selection and booking; optional contact-only prefilling.
const fs = require('node:fs');
const path = require('node:path');
const { createInterface } = require('node:readline/promises');
const { setTimeout: pause } = require('node:timers/promises');
const { intervalMs, retryAfterMs, backoffDelay, cooldownDelay, safeRecord, redact } = require('./lib/core.cjs');
const { certificateOptions, launchSession } = require('./lib/browser.cjs');
const { createPortal, ANY_OFFICE } = require('./lib/portal.cjs');
const { notifyAll } = require('./lib/notify.cjs');
const { sendTelegram, telegramStatus } = require('./lib/telegram.cjs');
const { readContact } = require('./lib/contact.cjs');
const { captureTelegramScreenshot } = require('./lib/screenshot.cjs');

function options(args = process.argv.slice(2)) {
  const flags = new Set(['--diagnostico', '--red', '--solo-cualquiera', '--certificado', '--una-consulta', '--probar-aviso', '--probar-telegram', '--telegram', '--telegram-screenshot', '--help']);
  const values = new Set(['--browser', '--pausa', '--desde', '--max-consultas']);
  for (const arg of args) {
    if (!flags.has(arg) && !values.has(arg.split('=')[0])) throw new Error('Opcion desconocida. Usa --help.');
    if (values.has(arg.split('=')[0]) && (!arg.includes('=') || !arg.split('=').slice(1).join('='))) throw new Error('La opcion requiere un valor.');
  }
  const value = name => args.find(arg => arg.startsWith(name + '='))?.slice(name.length + 1);
  const browser = value('--browser') || 'firefox';
  if (!['firefox', 'chrome', 'seleniumbase'].includes(browser)) throw new Error('Navegador inválido.');
  const diagnostic = args.includes('--diagnostico');
  if (args.includes('--telegram-screenshot') && !args.includes('--telegram')) throw new Error('--telegram-screenshot requiere --telegram.');
  const once = args.includes('--una-consulta');
  const maxChecks = once ? 1 : Number(value('--max-consultas') || (diagnostic ? 1 : Infinity));
  if (maxChecks !== Infinity && (!Number.isInteger(maxChecks) || maxChecks < 1)) throw new Error('Número de consultas inválido.');
  return { browser, diagnostic, once, maxChecks, interval: intervalMs(value('--pausa')),
    onlyAny: args.includes('--solo-cualquiera') || once || diagnostic,
    certificate: args.includes('--certificado'), trace: args.includes('--red'), telegram: args.includes('--telegram'), telegramScreenshot: args.includes('--telegram-screenshot'),
    resume: value('--desde'), testNotification: args.includes('--probar-aviso'), testTelegram: args.includes('--probar-telegram'), help: args.includes('--help') };
}

async function readIdentity(env = process.env) {
  let nie = (env.CITA_NIE || '').trim().toUpperCase();
  let name = (env.CITA_NOMBRE || '').trim().toUpperCase();
  if (!nie || !name) {
    if (!process.stdin.isTTY) throw new Error('Configura los datos en .env; consulta .env.example.');
    const input = createInterface({ input: process.stdin, output: process.stdout });
    try {
      if (!nie) nie = (await input.question('NIE (entrada local): ')).trim().toUpperCase();
      if (!name) name = (await input.question('Nombre y apellidos (entrada local): ')).trim().toUpperCase();
    } finally { input.close(); }
  }
  if (!/^[XYZ]\d{7}[A-Z]$/.test(nie) || !name || /REEMPLAZAR/.test(name)) throw new Error('Sustituye los marcadores de .env por datos válidos.');
  return { nie, name };
}

async function holdForUser(session, portal, kind, office, {
  sendNotification = notifyAll, signal, contact, reportContact = () => {},
} = {}) {
  portal.hold(kind); // No navigation, selection, submission or challenge solving after handoff.
  // Start the alert immediately; its delivery callback must not delay contact filling.
  const notificationTask = Promise.resolve().then(() => sendNotification(kind, office)).catch(() => false)
    .then(delivered => console.log(delivered ? 'Aviso enviado a Windows; revisa el navegador.' : 'Aviso de Windows no confirmado; revisa el navegador.'));
  if (!portal.alive() || signal?.aborted) { await notificationTask; return; }
  const prefillController = new AbortController();
  let contactTask = Promise.resolve(), filling = false, lastContactStatus;
  let watchContact = kind === 'posible disponibilidad' && Boolean(contact) && typeof portal.prefillContact === 'function';
  const tryContact = () => {
    if (!watchContact || filling || prefillController.signal.aborted) return;
    filling = true;
    contactTask = (async () => {
      let status;
      try { status = await portal.prefillContact(contact, { signal: prefillController.signal }); }
      catch { status = 'failed'; }
      if (prefillController.signal.aborted) return;
      if (status !== 'waiting') watchContact = false; // Never refill after manual edits or a completed attempt.
      if (status !== lastContactStatus) {
        lastContactStatus = status;
        try { reportContact(status); } catch { /* Reporting must not close a manual booking window. */ }
      }
    })().finally(() => { filling = false; });
  };
  await new Promise(resolve => {
    let count = 0;
    const tick = () => {
      if (!portal.alive() || signal?.aborted) return finish();
      if (count++ < 30) process.stdout.write('\x07\x07\x07');
    };
    const timer = setInterval(tick, 20_000);
    const contactTimer = watchContact ? setInterval(tryContact, 1000) : null;
    const finish = () => {
      clearInterval(timer); clearInterval(contactTimer); prefillController.abort();
      session.page.off('close', finish); session.browser.off('disconnected', finish);
      signal?.removeEventListener('abort', finish); resolve();
    };
    session.page.once('close', finish); session.browser.once('disconnected', finish);
    signal?.addEventListener('abort', finish, { once: true });
    void session.page.bringToFront().catch(() => {});
    tryContact();
    tick();
  });
  await Promise.all([contactTask, notificationTask]);
}

function officeQueue(offices, opts, excluded, round) {
  if (opts.onlyAny && !opts.resume) return [ANY_OFFICE];
  let active = offices.filter(label => label !== ANY_OFFICE && (round % 10 === 0 || !excluded.has(label)));
  if (opts.resume) {
    const exact = active.filter(label => label === opts.resume);
    const hits = exact.length ? exact : active.filter(label => label.toLocaleLowerCase('es').includes(opts.resume.toLocaleLowerCase('es')));
    if (hits.length !== 1) throw new Error('La oficina --desde debe coincidir con una única oficina.');
    active = active.slice(active.indexOf(hits[0]));
    if (opts.once) return [active[0]];
  }
  return active.reduce((out, label, index) => {
    out.push(label);
    if ((index + 1) % 5 === 0 && index < active.length - 1) out.push(ANY_OFFICE);
    return out;
  }, [ANY_OFFICE]);
}

async function runMonitor(opts, dependencies = {}) {
  const identity = opts.diagnostic ? {} : await (dependencies.readIdentity || readIdentity)();
  const contact = opts.diagnostic ? null : (dependencies.readContact || readContact)();
  const secrets = [identity.nie, identity.name, contact?.phone, contact?.email, ...(identity.name || '').split(/\s+/)].filter(s => s && s.length > 2);
  const now = dependencies.now || Date.now;
  const sendNotification = dependencies.notify || ((kind, office, details) => (dependencies.notifyAll || notifyAll)(kind, office, details, {
    enableTelegram: opts.telegram,
    ...(opts.telegramScreenshot ? { screenshot: () => captureTelegramScreenshot(session.page, { secrets }) } : {}),
  }));
  const signalStatus = async (kind, office, details) => {
    if (!opts.diagnostic) { try { await sendNotification(kind, office, details); } catch { /* A notification failure must not stop recovery. */ } }
  };
  const output = dependencies.output || (record => console.log(JSON.stringify(record)));
  const report = (state, office = ANY_OFFICE) => output(safeRecord({ time: new Date(now()).toISOString(),
    browser: opts.browser, authentication: opts.certificate ? 'certificado' : 'sin Cl@ve',
    office: redact(office, secrets), stage: state.stage, httpStatus: state.httpStatus,
    result: state.result, code: state.code, reason: state.reason, waitSeconds: state.waitSeconds, retryAt: state.retryAt }));
  const contextOptions = opts.certificate ? (dependencies.certificateOptions || certificateOptions)() : {};
  const session = await (dependencies.launchSession || launchSession)(opts.browser, contextOptions);
  const controller = new AbortController();
  const onInterrupt = () => controller.abort();
  process.once('SIGINT', onInterrupt); process.once('SIGTERM', onInterrupt);
  session.page?.once('close', onInterrupt); session.browser?.once('disconnected', onInterrupt);
  const removeStopListeners = () => {
    process.off('SIGINT', onInterrupt); process.off('SIGTERM', onInterrupt);
    session.page?.off('close', onInterrupt); session.browser?.off('disconnected', onInterrupt);
  };
  const sleep = dependencies.sleep || (async ms => {
    // Chunk long Retry-After waits to avoid overflowing Node's timer limit.
    while (ms > 0) {
      const chunk = Math.min(ms, 60_000);
      await pause(chunk, undefined, { signal: controller.signal });
      ms -= chunk;
    }
  });
  let portal;
  try {
    portal = (dependencies.createPortal || createPortal)(session, { diagnostic: opts.diagnostic,
      certificate: opts.certificate, identity, sleep, onNavigation: opts.trace ? report : undefined });
  } catch {
    removeStopListeners();
    await session.close();
    throw new Error('No se pudo preparar el flujo de consulta.');
  }
  const cachePath = path.join(__dirname, 'artifacts', 'sin-tramite.json');
  const excluded = new Set();
  if (!opts.once && !opts.diagnostic) {
    try {
      const cached = JSON.parse(fs.readFileSync(fs.existsSync(cachePath) ? cachePath : path.join(__dirname, 'sin-tramite.json'), 'utf8'));
      for (const label of cached) if (typeof label === 'string') excluded.add(label);
    } catch { /* Cache is optional; empty means check every office. */ }
  }
  let delay = 0, failures = 0, sessionRestarts = 0, cleanStreak = 0, interval = opts.interval;
  let queue = [], round = 0, checks = 0, resume = opts.resume;
  try {
    while (portal.alive() && !controller.signal.aborted && checks < opts.maxChecks) {
      if (opts.deadline && now() + delay >= opts.deadline) return { checks, result: 'limite de investigacion' };
      if (delay) await sleep(delay);
      if (!portal.alive() || controller.signal.aborted) break;
      let label = queue[0] || ANY_OFFICE;
      let state = await portal.open();
      if (state.result === 'ok') {
        if (!queue.length) {
          queue = officeQueue(await portal.offices(), { ...opts, resume }, excluded, ++round);
          resume = undefined;
          label = queue[0] || ANY_OFFICE;
        }
        state = await portal.checkOffice(label);
      }
      if (state.result === 'captcha') {
        state = await portal.handleChallenge();
      }
      checks++;
      const failed = ['rechazo', 'fallo temporal'].includes(state.result);
      if (failed) {
        if (state.httpStatus === 429 && failures === 0) interval = Math.min(Math.max(interval, 85_000) + 10_000, Math.max(opts.interval, 150_000));
        const retryAfter = retryAfterMs(state.retryAfter, now());
        failures++;
        delay = failures >= 3 ? cooldownDelay(failures - 3, interval, retryAfter) : backoffDelay(failures - 1, interval, retryAfter);
        cleanStreak = 0;
        state = { ...state, waitSeconds: Math.ceil(delay / 1000), retryAt: new Date(now() + delay).toISOString() };
      }
      const expired = state.result === 'sesión caducada';
      let restartSession = false;
      if (expired) {
        cleanStreak = 0;
        const restartDelay = Math.max(interval, retryAfterMs(state.retryAfter, now()));
        restartSession = sessionRestarts < 2 && checks < opts.maxChecks && (!opts.deadline || now() + restartDelay < opts.deadline);
        if (restartSession) {
          sessionRestarts++;
          delay = restartDelay;
          state = { ...state, reason: 'session_restart_scheduled', waitSeconds: Math.ceil(delay / 1000), retryAt: new Date(now() + delay).toISOString() };
        } else {
          state = { ...state, reason: sessionRestarts >= 2 ? 'session_restart_limit' : 'session_restart_bound' };
        }
      }
      report(state, label);
      if (restartSession) {
        await signalStatus('sesion_caducada', label, { waitSeconds: state.waitSeconds });
        // The next portal.open() starts a new ICP+ request in the SAME context.
        // Do not clear cookies or reset the rate-limit failure count here.
        continue;
      }
      const handoff = ['posible disponibilidad', 'captcha', 'revisión', 'sesión caducada'].includes(state.result);
      if (handoff) {
        // Diagnostic mode never submitted identity and is a bounded public probe.
        if (!opts.diagnostic) await (dependencies.holdForUser || holdForUser)(session, portal, state.result, label, {
          signal: controller.signal, sendNotification, contact,
          reportContact: status => report({ stage: 'hold', result: ['filled', 'ready'].includes(status) ? 'contacto preparado' : 'contacto pendiente',
            reason: `contact_prefill_${status}` }, label),
        });
        return { checks, result: state.result };
      }
      if (failed) {
        const canRetry = checks < opts.maxChecks && (!opts.deadline || now() + delay < opts.deadline);
        if (failures >= 3 && canRetry) {
          report({ ...state, stage: 'cooldown', result: 'enfriamiento', reason: 'repeated_failures' }, label);
          await signalStatus('enfriamiento', label, { waitSeconds: state.waitSeconds });
        }
      } else {
        if (failures >= 3 || sessionRestarts > 0) {
          report({ stage: 'monitor', httpStatus: state.httpStatus, result: 'reanudado', reason: sessionRestarts > 0 ? 'session_recovered' : 'service_recovered' }, label);
          await signalStatus('reanudado', label);
        }
        failures = 0;
        sessionRestarts = 0;
        if (++cleanStreak >= 10) { interval = Math.max(opts.interval, interval - 5000); cleanStreak = 0; }
        delay = interval;
        queue.shift();
        if (!opts.once && !opts.diagnostic && label !== ANY_OFFICE) {
          if (state.result === 'sin trámite') excluded.add(label);
          if (state.result === 'sin citas') excluded.delete(label);
          fs.mkdirSync(path.dirname(cachePath), { recursive: true });
          fs.writeFileSync(cachePath, JSON.stringify([...excluded].sort(), null, 2));
        }
      }
    }
    return { checks, result: controller.signal.aborted || !portal.alive() ? 'detenido' : 'completado' };
  } catch (error) {
    if (controller.signal.aborted || !portal.alive()) return { checks, result: 'detenido' };
    // Exceptions may contain URLs, request bodies or certificate paths.
    throw new Error('Monitor detenido por un fallo interno. No se ha continuado la consulta.');
  } finally {
    removeStopListeners();
    await session.close();
  }
}

async function main() {
  const opts = options();
  if (opts.help) {
    console.log('node [--env-file=.env] cita-regreso.cjs [--browser=firefox|chrome|seleniumbase] [--certificado] [--una-consulta] [--diagnostico] [--solo-cualquiera] [--desde=OFICINA] [--pausa=120] [--max-consultas=N] [--red] [--telegram] [--telegram-screenshot] [--probar-aviso] [--probar-telegram]');
    return;
  }
  if (opts.testTelegram) {
    const status = await sendTelegram('prueba');
    console.log(telegramStatus(status));
    if (status !== 'accepted') process.exitCode = 1;
    return;
  }
  if (opts.testNotification) {
    process.stdout.write('\x07\x07\x07');
    const delivered = await notifyAll('prueba', undefined, {}, { enableTelegram: opts.telegram });
    console.log(delivered ? 'Aviso de prueba enviado. Comprueba si Windows lo ha mostrado.' : 'Windows no confirmó el aviso de prueba.');
    return;
  }
  await runMonitor(opts);
}
// The certificate TLS proxy can retain Node handles after browser.close().
// Exit only after cleanup and flushing output; imports used by tests never exit.
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; })
  .finally(() => process.stdout.write('', () => process.stderr.write('', () => process.exit(process.exitCode || 0))));
module.exports = { options, readIdentity, holdForUser, officeQueue, runMonitor };
