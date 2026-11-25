'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classify, codeOf, intervalMs, retryAfterMs, backoffDelay, assertAction, safeRecord, redact } = require('../lib/core.cjs');
const { options, runMonitor, readIdentity, officeQueue, holdForUser } = require('../cita-regreso.cjs');
const { notification, notify } = require('../lib/notify.cjs');
const { certificateOptions, helperEnvironment } = require('../lib/browser.cjs');
const { EventEmitter } = require('node:events');

const fixtures = [
  ['available office', { text: 'Selecciona Oficina: Cita previa', selectionStage: true, choices: [{ label: 'Oficina', usable: true }] }, 'posible disponibilidad'],
  ['calendar', { text: 'Selecciona una fecha', selectionStage: true, choices: [{ label: 'Fecha de cita', usable: true }] }, 'posible disponibilidad'],
  ['warning beside choices', { text: 'Selecciona Oficina: En este momento no hay citas disponibles', selectionStage: true, choices: [{ label: 'Oficina', usable: true }] }, 'posible disponibilidad'],
  ['disabled choices', { text: 'Selecciona Oficina', selectionStage: true, choices: [{ label: 'Oficina', usable: false }] }, 'revisión'],
  ['entry screen is not availability', { text: 'Selecciona Oficina', selectionStage: false, choices: [{ label: 'Oficina', usable: true }] }, 'revisión'],
  ['applicant is not an appointment control', { text: 'Selecciona Oficina', selectionStage: true, choices: [{ label: 'solicitante', usable: true }] }, 'revisión'],
  ['generic controls', { text: 'Selecciona Oficina', selectionStage: true, choices: [{ label: 'Idioma', usable: true }] }, 'revisión'],
  ['unrelated radio with warning', { text: 'En este momento no hay citas disponibles 0017', selectionStage: true, choices: [{ label: 'Tipo de documento', usable: true }] }, 'sin citas'],
  ['unknown final page', { text: 'Servicio diferente', selectionStage: true }, 'revisión'],
  ['0501', { text: 'En este momento no hay citas disponibles. 0501' }, 'sin citas'],
  ['captcha precedes availability', { text: 'Selecciona Oficina', challenge: true, selectionStage: true, choices: [{ label: 'Oficina', usable: true }] }, 'captcha'],
  ['captcha text', { text: 'Verifica que eres humano' }, 'captcha'],
  ['expired', { text: 'Su sesión ha caducado' }, 'sesión caducada'],
  ['rejection text', { text: 'The requested URL was rejected' }, 'rechazo'],
  ['429', { text: 'En este momento no hay citas disponibles', httpStatus: 429 }, 'rechazo'],
  ['403', { httpStatus: 403 }, 'rechazo'],
  ['503', { httpStatus: 503 }, 'fallo temporal'],
];
for (const [name, input, expected] of fixtures) test(name, () => assert.equal(classify(input), expected));

test('codes are observations, not evidence of filtering', () => {
  assert.equal(codeOf('En este momento no hay citas disponibles 0017'), '0017');
  assert.equal(codeOf('10:31:590501 Cod. Oper'), '0501');
  assert.equal(codeOf('En breve, la Oficina'), null);
});
test('interval validation and Retry-After', () => {
  assert.equal(intervalMs(), 120000); assert.equal(intervalMs(25), 85000);
  assert.throws(() => intervalMs('no')); assert.throws(() => intervalMs(-1));
  assert.equal(retryAfterMs('600'), 600000);
  assert.equal(retryAfterMs('Wed, 25 Nov 2026 10:10:00 GMT', Date.parse('2026-11-25T10:00:00Z')), 600000);
  assert.equal(retryAfterMs('invalid'), 0);
  assert.equal(backoffDelay(0, 120000, 600000), 600000);
  assert.equal(backoffDelay(3, 120000), 300000);
});
test('booking and handoff stages allow no actions', () => {
  assert.doesNotThrow(() => assertAction('request', 'request-availability'));
  for (const stage of ['selection', 'hold', 'unknown']) for (const action of ['office', 'submit-identity', 'request-availability', 'book']) {
    assert.throws(() => assertAction(stage, action));
  }
});
test('metadata excludes bodies and secrets; redaction is case insensitive', () => {
  assert.deepEqual(safeRecord({ result: 'sin citas', body: 'PRIVATE', url: 'secret', passphrase: 'PRIVATE' }), { result: 'sin citas' });
  assert.equal(redact('x1234567a Name.A Name.A', ['X1234567A', 'NAME.A']), '[privado] [privado] [privado]');
});
test('CLI defaults and invalid options', () => {
  assert.equal(options([]).browser, 'firefox'); assert.equal(options([]).interval, 120000);
  assert.equal(options(['--una-consulta']).maxChecks, 1);
  assert.throws(() => options(['--browser=bad'])); assert.throws(() => options(['--max-consultas=0']));
  assert.throws(() => options(['--unknown'])); assert.throws(() => options(['--browser'])); assert.throws(() => options(['--pausa=']));
});
test('placeholders and certificate errors never echo input', async () => {
  await assert.rejects(readIdentity({ CITA_NIE: 'REEMPLAZAR_NIE', CITA_NOMBRE: 'REEMPLAZAR' }), /marcadores/);
  assert.throws(() => certificateOptions({ CITA_KEY_PEM: 'PRIVATE-PATH' }), error => !error.message.includes('PRIVATE-PATH'));
});
test('notifications distinguish availability, review, challenge and test', async () => {
  const titles = ['posible disponibilidad', 'revisión', 'captcha', 'prueba'].map(kind => notification(kind).title);
  assert.equal(new Set(titles).size, 4);
  assert.equal(await notify('prueba', undefined, { notify: (_, callback) => callback(null) }), true);
  assert.equal(await notify('prueba', undefined, { notify: () => { throw new Error(); } }), false);
});
test('resume and office interleaving', () => {
  assert.deepEqual(officeQueue(['Cualquier oficina', 'A', 'B'], { once: true, onlyAny: true, resume: 'B' }, new Set(), 1), ['B']);
  assert.throws(() => officeQueue(['AB', 'AC'], { resume: 'A' }, new Set(), 1));
});

function harness(states, opts = {}) {
  let index = 0, closed = false, solved = 0, held = 0, reads = 0;
  const waits = [], records = [];
  const portal = { alive: () => !closed, open: async () => ({ result: 'ok' }), offices: async () => ['Cualquier oficina'],
    checkOffice: async () => ({ stage: 'selection', httpStatus: 200, ...states[index++] }),
    handleChallenge: async () => { solved++; return { result: 'captcha' }; } };
  return { waits, records, result: () => ({ closed, solved, held, reads }),
    run: () => runMonitor({ ...options(['--solo-cualquiera', '--max-consultas=3']), ...opts }, {
      readIdentity: async () => { reads++; return { nie: 'X0000000X', name: 'PRIVATE NAME' }; },
      launchSession: async () => ({ close: async () => { closed = true; } }),
      createPortal: () => portal, sleep: async ms => waits.push(ms), output: record => records.push(record),
      holdForUser: async () => { held++; },
    }) };
}
test('three recurring cycles respect interval and close browser', async () => {
  const h = harness(Array(3).fill({ result: 'sin citas', code: '0501' }));
  assert.deepEqual(await h.run(), { checks: 3, result: 'completado' });
  assert.deepEqual(h.waits, [120000, 120000]); assert.equal(h.result().closed, true);
  assert.equal(JSON.stringify(h.records).includes('PRIVATE'), false);
});
test('potential availability stops immediately and hands off once', async () => {
  const h = harness([{ result: 'posible disponibilidad' }]);
  await h.run(); assert.equal(h.records.length, 1); assert.equal(h.result().held, 1); assert.deepEqual(h.waits, []);
});
test('unknown page and certificate expiry stop rather than retry authentication', async () => {
  for (const result of ['revisión', 'sesión caducada']) {
    const h = harness([{ result }]); await h.run(); assert.equal(h.records.length, 1); assert.equal(h.result().held, 1);
  }
});
test('unresolved challenge is handed off', async () => {
  const h = harness([{ result: 'captcha' }]); await h.run(); assert.equal(h.result().solved, 1); assert.equal(h.result().held, 1);
});
test('Retry-After is honored and repeated rejection terminates', async () => {
  const h = harness(Array(3).fill({ result: 'rechazo', httpStatus: 429, retryAfter: '600' }));
  assert.equal((await h.run()).result, 'rechazo persistente'); assert.deepEqual(h.waits, [600000, 600000]);
  assert.equal(h.result().held, 1);
});
test('diagnostic never reads applicant details', async () => {
  const h = harness([{ result: 'formulario disponible' }], { diagnostic: true, maxChecks: 1 });
  await h.run(); assert.equal(h.result().reads, 0);
});
test('handoff preserves context until the user closes the page', async () => {
  const page = new EventEmitter(), browser = new EventEmitter();
  let alive = true, held = false, front = 0;
  page.bringToFront = async () => { front++; };
  const pending = holdForUser({ page, browser }, { hold: () => { held = true; }, alive: () => alive }, 'revisión', 'Barcelona', {
    sendNotification: async () => true,
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(held, true); assert.equal(front, 1);
  alive = false; page.emit('close'); await pending;
});

test('browser closes if portal setup fails; exception details are hidden', async () => {
  let closed = false;
  await assert.rejects(runMonitor(options(['--diagnostico']), {
    launchSession: async () => ({ close: async () => { closed = true; } }),
    createPortal: () => { throw new Error('PRIVATE CERTIFICATE PATH'); },
  }), error => !error.message.includes('PRIVATE'));
  assert.equal(closed, true);
});

test('helper environment excludes applicant variables case-insensitively', () => {
  assert.deepEqual(helperEnvironment({ PATH: 'synthetic-path', CITA_NIE: 'PRIVATE', cita_nombre: 'PRIVATE', CiTa_CERT_PASS_FILE: 'PRIVATE' }), { PATH: 'synthetic-path' });
});

test('research deadline stops before a Retry-After exceeding the remaining budget', async () => {
  const h = harness([{ result: 'rechazo', httpStatus: 429, retryAfter: '7200' }], { deadline: Date.now() + 1000 });
  assert.equal((await h.run()).result, 'limite de investigacion');
  assert.deepEqual(h.waits, []); assert.equal(h.records.length, 1); assert.equal(h.result().closed, true);
});
