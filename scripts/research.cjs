'use strict';
// Run with: node --env-file=.env scripts/research.cjs --repeticiones=1
// Live ICP+ traffic: sequential checks, >=120s apart, <=45min automatic work.
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const { options, runMonitor, holdForUser } = require('../cita-regreso.cjs');
const { safeRecord } = require('../lib/core.cjs');

async function main() {
  const args = process.argv.slice(2);
  const known = arg => /^--repeticiones=[12]$/.test(arg) || /^--browser=(firefox|chrome|seleniumbase)$/.test(arg)
    || ['--humo', '--sin-certificado', '--solo-certificado'].includes(arg);
  if (args.some(arg => !known(arg)) || (args.includes('--sin-certificado') && args.includes('--solo-certificado'))) throw new Error('Opciones de investigacion invalidas.');
  const smoke = args.includes('--humo');
  if (smoke && args.length > 1) throw new Error('--humo no admite otras opciones.');
  const repeats = Number(args.find(arg => arg.startsWith('--repeticiones='))?.split('=')[1] || 2);
  const selectedBrowser = args.find(arg => arg.startsWith('--browser='))?.split('=')[1];
  const dir = path.join(__dirname, '..', 'artifacts');
  fs.mkdirSync(dir, { recursive: true });
  const journal = path.join(dir, `research-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
  const began = Date.now();
  // Carry the cooldown across separate invocations of this research runner.
  let completedAt = 0, nextAllowedAt = 0;
  for (const name of fs.readdirSync(dir).filter(name => /^research-.*\.jsonl$/.test(name))) {
    for (const line of fs.readFileSync(path.join(dir, name), 'utf8').split('\n')) {
      try {
        const record = JSON.parse(line);
        const time = Date.parse(record.time);
        if (record.result !== 'navegaci\u00f3n' && Number.isFinite(time) && time <= Date.now()) {
          completedAt = Math.max(completedAt, time);
          const scheduled = Date.parse(record.retryAt);
          if (Number.isFinite(scheduled)) nextAllowedAt = Math.max(nextAllowedAt, scheduled);
        }
      } catch { /* Ignore partial or malformed local records. */ }
    }
  }
  const authModes = args.includes('--sin-certificado') ? [false] : args.includes('--solo-certificado') ? [true] : [false, true];
  const cases = (selectedBrowser ? [selectedBrowser] : ['firefox', 'chrome', 'seleniumbase']).flatMap(browser => authModes.map(certificate => [browser, certificate]));
  const recordResult = record => {
    const scheduled = Date.parse(record.retryAt);
    if (Number.isFinite(scheduled)) nextAllowedAt = Math.max(nextAllowedAt, scheduled);
    const line = JSON.stringify(safeRecord(record));
    fs.appendFileSync(journal, line + '\n');
    console.log(line);
  };
  if (smoke) {
    const wait = Math.max(0, completedAt + 120000 - Date.now(), nextAllowedAt - Date.now());
    if (Date.now() + wait - began >= 45 * 60000) { console.log('Limite de investigacion alcanzado.'); return; }
    if (wait) await sleep(wait);
    await runMonitor({ ...options(['--browser=seleniumbase', '--certificado', '--solo-cualquiera', '--max-consultas=3']), deadline: began + 45 * 60000 }, {
      output: recordResult,
    });
    console.log('Prueba periodica terminada; tres intentos como maximo en una misma sesion.');
    return;
  }
  for (const [browser, certificate] of cases) {
    for (let i = 0; i < repeats; i++) {
      const wait = Math.max(0, completedAt + 120000 - Date.now(), nextAllowedAt - Date.now());
      if (Date.now() + wait - began >= 45 * 60000) { console.log('Límite de investigación alcanzado.'); return; }
      if (wait) await sleep(wait);
      let handedOff = false;
      const opts = { ...options([`--browser=${browser}`, '--una-consulta']), certificate, deadline: began + 45 * 60000 };
      const result = await runMonitor(opts, {
        output: recordResult,
        async holdForUser(...args) { handedOff = true; await holdForUser(...args); },
      });
      completedAt = Date.now();
      if (handedOff || result.result === 'detenido') { console.log('Comparación detenida tras entrega al usuario.'); return; }
    }
  }
  console.log('Comparación terminada. Evidencia local en artifacts (ignorada por Git).');
}
if (require.main === module) main().catch(() => { console.error('Investigación detenida: revisa la configuración local y el navegador. No se imprimen excepciones privadas.'); process.exitCode = 1; })
  .finally(() => process.stdout.write('', () => process.stderr.write('', () => process.exit(process.exitCode || 0))));
