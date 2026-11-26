'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classify, codeOf, intervalMs, retryAfterMs, backoffDelay, cooldownDelay, assertAction, safeRecord, redact } = require('../lib/core.cjs');
const { options, runMonitor, readIdentity, officeQueue, holdForUser } = require('../cita-regreso.cjs');
const { notification, notify } = require('../lib/notify.cjs');
const { certificateOptions, helperEnvironment } = require('../lib/browser.cjs');
const { readContact, contactPlan } = require('../lib/contact.cjs');
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
  ['HTTP 200 portal system error', { text: 'Se ha producido un error en el sistema, por favor inténtelo de nuevo. En el caso de que el error persista...', httpStatus: 200, selectionStage: true, choices: [{ label: 'Oficina', usable: true }] }, 'fallo temporal'],
  ['unrecognized validation error still needs review', { text: 'Error: revisa los datos del formulario.', httpStatus: 200 }, 'revisión'],
  ['recognized contact form after availability request', { selectionStage: true, contactForm: true }, 'posible disponibilidad'],
  ['contact fields before availability are not a candidate', { contactForm: true }, 'revisión'],
  ['expired contact form is not a candidate', { text: 'Su sesión ha caducado', selectionStage: true, contactForm: true }, 'sesión caducada'],
  ['contact fields do not override no appointments', { text: 'En este momento no hay citas disponibles', selectionStage: true, contactForm: true }, 'sin citas'],
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

test('optional contact configuration validates both fields without exposing values', () => {
  assert.equal(readContact({}), null);
  assert.deepEqual(readContact({ CITA_TELEFONO: ' 600 000 001 ', CITA_EMAIL: ' synthetic@example.invalid ' }), { phone: '600000001', email: 'synthetic@example.invalid' });
  for (const env of [{ CITA_TELEFONO: '600000001' }, { CITA_EMAIL: 'synthetic@example.invalid' }, { CITA_TELEFONO: 'private-input', CITA_EMAIL: 'private-input' }]) {
    assert.throws(() => readContact(env), error => /CITA_TELEFONO/.test(error.message) && !error.message.includes('private-input'));
  }
});

test('contact planning requires three unambiguous fields in the same form', () => {
  const fields = [{ form: 0, id: 'txtTelefono' }, { form: 0, id: 'emailUNO' }, { form: 0, id: 'emailDOS' }];
  assert.deepEqual(Object.keys(contactPlan(fields)), ['phone', 'email', 'confirmation']);
  assert.equal(contactPlan(fields.slice(0, 2)), null);
  assert.equal(contactPlan([...fields, { form: 0, label: 'Correo electrónico alternativo' }]), null);
  assert.equal(contactPlan(fields.map((field, index) => ({ ...field, form: index }))), null);
  assert.ok(contactPlan([{ form: 0, label: 'Teléfono móvil' }, { form: 0, label: 'Correo electrónico' }, { form: 0, label: 'Confirmación del correo electrónico' }]));
  assert.ok(contactPlan([{ form: 0, label: 'Teléfono' }, { form: 0, label: 'E-mail' }, { form: 0, label: 'Repita e-mail' }]));
});

test('contact handoff fills before notification callback and stops after one attempt', async () => {
  const page = new EventEmitter(), browser = new EventEmitter(), controller = new AbortController();
  page.bringToFront = async () => {};
  let finishNotification, calls = 0, heldKind;
  const statuses = [];
  const pending = holdForUser({ page, browser }, {
    hold: kind => { heldKind = kind; }, alive: () => true,
    prefillContact: async () => { calls++; return 'filled'; },
  }, 'posible disponibilidad', 'Barcelona', {
    contact: { phone: '600000001', email: 'synthetic@example.invalid' }, signal: controller.signal,
    sendNotification: () => new Promise(resolve => { finishNotification = resolve; }),
    reportContact: status => statuses.push(status),
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(heldKind, 'posible disponibilidad'); assert.equal(calls, 1); assert.deepEqual(statuses, ['filled']);
  controller.abort(); finishNotification(true); await pending;
  assert.equal(page.listenerCount('close'), 0); assert.equal(browser.listenerCount('disconnected'), 0);
});

test('review, CAPTCHA and expired handoffs never prefill contact details', async () => {
  for (const kind of ['revisión', 'captcha', 'sesión caducada']) {
    const page = new EventEmitter(), browser = new EventEmitter(), controller = new AbortController();
    page.bringToFront = async () => {};
    let calls = 0;
    const pending = holdForUser({ page, browser }, { hold() {}, alive: () => true,
      prefillContact: async () => { calls++; return 'filled'; },
    }, kind, 'Barcelona', { contact: { phone: '600000001', email: 'synthetic@example.invalid' },
      sendNotification: async () => true, signal: controller.signal });
    await new Promise(resolve => setImmediate(resolve));
    controller.abort(); await pending; assert.equal(calls, 0);
  }
});
test('notifications distinguish availability, review, challenge and test', async () => {
  const titles = ['posible disponibilidad', 'revisión', 'captcha', 'prueba', 'enfriamiento', 'reanudado', 'sesion_caducada'].map(kind => notification(kind).title);
  assert.equal(new Set(titles).size, 7);
  assert.match(notification('enfriamiento', 'Barcelona', { waitSeconds: 3600 }).message, /60 min/);
  assert.equal(await notify('prueba', undefined, { notify: (_, callback) => callback(null) }), true);
  assert.equal(await notify('prueba', undefined, { notify: () => { throw new Error(); } }), false);
});
test('resume and office interleaving', () => {
  assert.deepEqual(officeQueue(['Cualquier oficina', 'A', 'B'], { once: true, onlyAny: true, resume: 'B' }, new Set(), 1), ['B']);
  assert.throws(() => officeQueue(['AB', 'AC'], { resume: 'A' }, new Set(), 1));
});

function harness(states, opts = {}) {
  let index = 0, closed = false, solved = 0, held = 0, reads = 0, launches = 0;
  let clock = Date.now();
  const waits = [], records = [], notifications = [];
  const page = new EventEmitter(), browser = new EventEmitter();
  const portal = { alive: () => !closed, open: async () => ({ result: 'ok' }), offices: async () => ['Cualquier oficina'],
    checkOffice: async () => ({ stage: 'selection', httpStatus: 200, ...states[index++] }),
    handleChallenge: async () => { solved++; return { result: 'captcha' }; } };
  return { waits, records, notifications, result: () => ({ closed, solved, held, reads, launches }),
    run: () => runMonitor({ ...options(['--solo-cualquiera', '--max-consultas=3']), ...opts }, {
      readIdentity: async () => { reads++; return { nie: 'X0000000X', name: 'PRIVATE NAME' }; },
      launchSession: async () => { launches++; return { page, browser, close: async () => { closed = true; } }; },
      readContact: () => null, createPortal: () => portal, now: () => clock,
      sleep: async ms => { waits.push(ms); clock += ms; if (opts.interruptCooldown && ms >= 900000) process.emit('SIGINT'); if (opts.closeDuringCooldown && ms >= 900000) page.emit('close'); },
      notify: async (kind, office, details) => { notifications.push({ kind, office, ...details }); if (opts.failNotifications) throw new Error('synthetic failure'); },
      output: record => records.push(record),
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
test('unknown pages still stop for review', async () => {
  for (const result of ['revisión']) {
    const h = harness([{ result }]); await h.run(); assert.equal(h.records.length, 1); assert.equal(h.result().held, 1);
  }
});
test('unresolved challenge is handed off', async () => {
  const h = harness([{ result: 'captcha' }]); await h.run(); assert.equal(h.result().solved, 1); assert.equal(h.result().held, 1);
});
test('bounded runs still stop at max checks, with no cooldown notification or handoff', async () => {
  const h = harness(Array(3).fill({ result: 'rechazo', httpStatus: 429, retryAfter: '600' }));
  assert.equal((await h.run()).result, 'completado'); assert.deepEqual(h.waits, [600000, 600000]);
  assert.equal(h.result().held, 0); assert.deepEqual(h.notifications, []);
});

test('three failures enter cooldown and a successful single probe resumes the same session', async () => {
  const h = harness([...Array(3).fill({ result: 'rechazo', httpStatus: 429 }), { result: 'sin citas' }, { result: 'sin citas' }], { maxChecks: 5 });
  assert.equal((await h.run()).result, 'completado');
  assert.deepEqual(h.waits, [130000, 130000, 900000, 130000]);
  assert.deepEqual(h.notifications.map(n => n.kind), ['enfriamiento', 'reanudado']);
  const cooldown = h.records.find(r => r.result === 'enfriamiento');
  assert.equal(cooldown.waitSeconds, 900);
  assert.equal(Date.parse(cooldown.retryAt) - Date.parse(cooldown.time), 900000);
  assert.equal(h.result().launches, 1); assert.equal(h.result().held, 0);
});

test('failed cooldown probes double the delay up to an hour and honor longer Retry-After', async () => {
  const h = harness([...Array(6).fill({ result: 'rechazo', httpStatus: 429 }), { result: 'rechazo', httpStatus: 429, retryAfter: '7200' }, { result: 'sin citas' }], { maxChecks: 8 });
  await h.run();
  assert.deepEqual(h.waits, [130000, 130000, 900000, 1800000, 3600000, 3600000, 7200000]);
  assert.equal(h.result().launches, 1);
  assert.deepEqual(h.notifications.map(n => n.kind), [...Array(5).fill('enfriamiento'), 'reanudado']);
});

test('HTTP-date Retry-After is honored at the cooldown transition', async () => {
  const retryAfter = new Date(Date.now() + 3 * 60 * 60000).toUTCString();
  const h = harness([{ result: 'rechazo', httpStatus: 429 }, { result: 'rechazo', httpStatus: 429 }, { result: 'rechazo', httpStatus: 429, retryAfter }, { result: 'sin citas' }], { maxChecks: 4 });
  await h.run();
  assert.equal(h.waits[0], 130000); assert.ok(h.waits[2] > 10000000);
  assert.equal(h.notifications[0].waitSeconds, Math.ceil(h.waits[2] / 1000));
});

test('a new failure episode restarts at the initial cooldown after recovery', async () => {
  const failed = { result: 'fallo temporal', httpStatus: 503 };
  const h = harness([failed, failed, failed, { result: 'sin citas' }, failed, failed, failed, { result: 'sin citas' }], { maxChecks: 8 });
  await h.run();
  assert.deepEqual(h.waits, [120000, 120000, 900000, 120000, 120000, 120000, 900000]);
  assert.deepEqual(h.notifications.map(n => n.kind), ['enfriamiento', 'reanudado', 'enfriamiento', 'reanudado']);
});

test('CAPTCHA or unknown page after cooldown still hands off without announcing recovery', async () => {
  for (const result of ['captcha', 'revisión', 'posible disponibilidad']) {
    const h = harness([...Array(3).fill({ result: 'rechazo', httpStatus: 403 }), { result }], { maxChecks: 5 });
    await h.run(); assert.equal(h.result().held, 1);
    assert.deepEqual(h.waits, [120000, 120000, 900000]);
    assert.deepEqual(h.notifications.map(n => n.kind), ['enfriamiento']);
    assert.equal(h.result().launches, 1);
  }
});

test('cooldown is interruptible and notification failures do not stop recovery', async () => {
  const states = [...Array(3).fill({ result: 'rechazo', httpStatus: 429 }), { result: 'sin citas' }];
  const interrupted = harness(states, { maxChecks: 4, interruptCooldown: true });
  assert.equal((await interrupted.run()).result, 'detenido');
  assert.equal(interrupted.records.filter(r => r.stage === 'selection').length, 3);
  assert.equal(interrupted.result().closed, true);
  const failedNotice = harness(states, { maxChecks: 4, failNotifications: true });
  assert.equal((await failedNotice.run()).result, 'completado');
  assert.equal(failedNotice.records.filter(r => r.stage === 'selection').length, 4);
});

test('research deadline prevents entering a cooldown it cannot complete', async () => {
  const h = harness(Array(3).fill({ result: 'rechazo', httpStatus: 429 }), { maxChecks: 4, deadline: Date.now() + 600000 });
  assert.equal((await h.run()).result, 'limite de investigacion');
  assert.deepEqual(h.waits, [130000, 130000]); assert.deepEqual(h.notifications, []);
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
  assert.deepEqual(helperEnvironment({ PATH: 'synthetic-path', CITA_NIE: 'PRIVATE', cita_nombre: 'PRIVATE', CiTa_CERT_PASS_FILE: 'PRIVATE', CITA_TELEFONO: 'PRIVATE', cita_email: 'PRIVATE' }), { PATH: 'synthetic-path' });
});

test('research deadline stops before a Retry-After exceeding the remaining budget', async () => {
  const h = harness([{ result: 'rechazo', httpStatus: 429, retryAfter: '7200' }], { deadline: Date.now() + 1000 });
  assert.equal((await h.run()).result, 'limite de investigacion');
  assert.deepEqual(h.waits, []); assert.equal(h.records.length, 1); assert.equal(h.result().closed, true);
});

test('closing the browser page interrupts cooldown without another probe', async () => {
  const h = harness([...Array(3).fill({ result: 'rechazo', httpStatus: 429 }), { result: 'sin citas' }], { maxChecks: 4, closeDuringCooldown: true });
  assert.equal((await h.run()).result, 'detenido');
  assert.equal(h.records.filter(r => r.stage === 'selection').length, 3);
  assert.equal(h.result().closed, true);
});

test('screenshot inactivity message is expired even with stale appointment controls', () => {
  assert.equal(classify({ text: 'Su sesión ha caducado por permanecer demasiado tiempo inactiva. Deberás iniciar de nuevo la solicitud de la cita previa.', httpStatus: 200, selectionStage: true, choices: [{ label: 'Oficina', usable: true }] }), 'sesión caducada');
});

test('an expired request restarts at the normal interval in the same browser', async () => {
  const h = harness([{ result: 'sesión caducada' }, { result: 'sin citas' }, { result: 'sin citas' }]);
  await h.run();
  assert.deepEqual(h.waits, [120000, 120000]);
  assert.deepEqual(h.notifications.map(n => n.kind), ['sesion_caducada', 'reanudado']);
  assert.equal(h.records[0].reason, 'session_restart_scheduled');
  assert.equal(h.records.find(r => r.result === 'reanudado').reason, 'session_recovered');
  assert.equal(h.result().launches, 1); assert.equal(h.result().held, 0);
});

test('a third expiry hands off after at most two request restarts', async () => {
  const h = harness(Array(3).fill({ result: 'sesión caducada' }), { maxChecks: 5 });
  assert.equal((await h.run()).result, 'sesión caducada');
  assert.deepEqual(h.waits, [120000, 120000]);
  assert.equal(h.records.at(-1).reason, 'session_restart_limit');
  assert.equal(h.result().held, 1); assert.equal(h.result().launches, 1);
});

test('expiry during rate-limit recovery does not reset the block cooldown progression', async () => {
  const failure = { result: 'rechazo', httpStatus: 429 };
  const h = harness([failure, failure, failure, { result: 'sesión caducada' }, failure, { result: 'sin citas' }], { maxChecks: 6 });
  await h.run();
  assert.deepEqual(h.waits, [130000, 130000, 900000, 130000, 1800000]);
  assert.deepEqual(h.notifications.map(n => n.kind), ['enfriamiento', 'sesion_caducada', 'enfriamiento', 'reanudado']);
  assert.equal(h.result().held, 0); assert.equal(h.result().launches, 1);
});

test('successful queries reset the request-restart allowance', async () => {
  const expired = { result: 'sesión caducada' }, success = { result: 'sin citas' };
  const h = harness([expired, success, expired, success, expired, success], { maxChecks: 6 });
  await h.run();
  assert.equal(h.result().held, 0);
  assert.equal(h.notifications.filter(n => n.kind === 'sesion_caducada').length, 3);
});

test('expiry restart respects Retry-After and bounded-run limits', async () => {
  const h = harness([{ result: 'sesión caducada', retryAfter: '600' }, { result: 'sin citas' }], { maxChecks: 2 });
  await h.run(); assert.deepEqual(h.waits, [600000]);
  const single = harness([{ result: 'sesión caducada' }], { maxChecks: 1, once: true });
  await single.run(); assert.deepEqual(single.waits, []); assert.equal(single.result().held, 1);
  assert.equal(single.records[0].reason, 'session_restart_bound');
});
