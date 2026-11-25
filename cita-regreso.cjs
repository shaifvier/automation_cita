'use strict';
// Monitor ICP+: stops at the first appointment-selection page. No booking actions.
const fs = require('node:fs');
const path = require('node:path');
const { createInterface } = require('node:readline/promises');
const { setTimeout: pause } = require('node:timers/promises');
const { intervalMs, retryAfterMs, backoffDelay, safeRecord, redact } = require('./lib/core.cjs');
const { certificateOptions, launchSession } = require('./lib/browser.cjs');
const { createPortal, ANY_OFFICE } = require('./lib/portal.cjs');
const { notify } = require('./lib/notify.cjs');

function options(args = process.argv.slice(2)) {
  const flags = new Set(['--diagnostico', '--red', '--solo-cualquiera', '--certificado', '--una-consulta', '--probar-aviso', '--help']);
  const values = new Set(['--browser', '--pausa', '--desde', '--max-consultas']);
  for (const arg of args) {
    if (!flags.has(arg) && !values.has(arg.split('=')[0])) throw new Error('Opcion desconocida. Usa --help.');
    if (values.has(arg.split('=')[0]) && (!arg.includes('=') || !arg.split('=').slice(1).join('='))) throw new Error('La opcion requiere un valor.');
  }
  const value = name => args.find(arg => arg.startsWith(name + '='))?.slice(name.length + 1);
  const browser = value('--browser') || 'firefox';
  if (!['firefox', 'chrome', 'seleniumbase'].includes(browser)) throw new Error('Navegador inválido.');
  const diagnostic = args.includes('--diagnostico');
  const once = args.includes('--una-consulta');
  const maxChecks = once ? 1 : Number(value('--max-consultas') || (diagnostic ? 1 : Infinity));
  if (maxChecks !== Infinity && (!Number.isInteger(maxChecks) || maxChecks < 1)) throw new Error('Número de consultas inválido.');
  return { browser, diagnostic, once, maxChecks, interval: intervalMs(value('--pausa')),
    onlyAny: args.includes('--solo-cualquiera') || once || diagnostic,
    certificate: args.includes('--certificado'), trace: args.includes('--red'),
    resume: value('--desde'), testNotification: args.includes('--probar-aviso'), help: args.includes('--help') };
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

async function holdForUser(session, portal, kind, office, { sendNotification = notify, signal } = {}) {
  portal.hold(); // No portal interaction or challenge solving after this point.
  const delivered = await sendNotification(kind, office);
  console.log(delivered ? 'Aviso enviado a Windows; revisa el navegador.' : 'Aviso de Windows no confirmado; revisa el navegador.');
  if (!portal.alive() || signal?.aborted) return;
  await session.page.bringToFront().catch(() => {});
  await new Promise(resolve => {
    let count = 0;
    const tick = () => {
      if (!portal.alive() || signal?.aborted) return finish();
      if (count++ < 30) process.stdout.write('\x07\x07\x07');
    };
    const timer = setInterval(tick, 20_000);
    const finish = () => {
      clearInterval(timer);
      session.page.off('close', finish); session.browser.off('disconnected', finish);
      signal?.removeEventListener('abort', finish); resolve();
    };
    session.page.once('close', finish); session.browser.once('disconnected', finish);
    signal?.addEventListener('abort', finish, { once: true });
    tick();
  });
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
  const secrets = [identity.nie, identity.name, ...(identity.name || '').split(/\s+/)].filter(s => s && s.length > 2);
  const output = dependencies.output || (record => console.log(JSON.stringify(record)));
  const report = (state, office = ANY_OFFICE) => output(safeRecord({ time: new Date().toISOString(),
    browser: opts.browser, authentication: opts.certificate ? 'certificado' : 'sin Cl@ve',
    office: redact(office, secrets), stage: state.stage, httpStatus: state.httpStatus,
    result: state.result, code: state.code, reason: state.reason }));
  const contextOptions = opts.certificate ? (dependencies.certificateOptions || certificateOptions)() : {};
  const session = await (dependencies.launchSession || launchSession)(opts.browser, contextOptions);
  const controller = new AbortController();
  const onInterrupt = () => controller.abort();
  process.once('SIGINT', onInterrupt); process.once('SIGTERM', onInterrupt);
  const sleep = dependencies.sleep || (ms => pause(ms, undefined, { signal: controller.signal }));
  let portal;
  try {
    portal = (dependencies.createPortal || createPortal)(session, { diagnostic: opts.diagnostic,
      certificate: opts.certificate, identity, sleep, onNavigation: opts.trace ? report : undefined });
  } catch {
    process.off('SIGINT', onInterrupt); process.off('SIGTERM', onInterrupt);
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
  let delay = 0, failures = 0, cleanStreak = 0, interval = opts.interval;
  let queue = [], round = 0, checks = 0, resume = opts.resume;
  try {
    while (portal.alive() && !controller.signal.aborted && checks < opts.maxChecks) {
      if (opts.deadline && Date.now() + delay >= opts.deadline) return { checks, result: 'limite de investigacion' };
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
      report(state, label);
      const handoff = ['posible disponibilidad', 'captcha', 'revisión', 'sesión caducada'].includes(state.result);
      if (handoff) {
        // Diagnostic mode never submitted identity and is a bounded public probe.
        if (!opts.diagnostic) await (dependencies.holdForUser || holdForUser)(session, portal, state.result, label, { signal: controller.signal });
        return { checks, result: state.result };
      }
      if (['rechazo', 'fallo temporal'].includes(state.result)) {
        if (state.httpStatus === 429 && failures === 0) interval = Math.min(Math.max(interval, 85_000) + 10_000, Math.max(opts.interval, 150_000));
        delay = backoffDelay(failures++, interval, retryAfterMs(state.retryAfter));
        cleanStreak = 0;
        if (failures >= 3) {
          if (!opts.diagnostic) await (dependencies.holdForUser || holdForUser)(session, portal, 'rechazo', label, { signal: controller.signal });
          return { checks, result: 'rechazo persistente' };
        }
      } else {
        failures = 0;
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
    return { checks, result: 'completado' };
  } catch (error) {
    if (controller.signal.aborted || !portal.alive()) return { checks, result: 'detenido' };
    // Exceptions may contain URLs, request bodies or certificate paths.
    throw new Error('Monitor detenido por un fallo interno. No se ha continuado la consulta.');
  } finally {
    process.off('SIGINT', onInterrupt); process.off('SIGTERM', onInterrupt);
    await session.close();
  }
}

async function main() {
  const opts = options();
  if (opts.help) {
    console.log('node [--env-file=.env] cita-regreso.cjs [--browser=firefox|chrome|seleniumbase] [--certificado] [--una-consulta] [--diagnostico] [--solo-cualquiera] [--desde=OFICINA] [--pausa=120] [--max-consultas=N] [--red] [--probar-aviso]');
    return;
  }
  if (opts.testNotification) {
    process.stdout.write('\x07\x07\x07');
    const delivered = await notify('prueba');
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
