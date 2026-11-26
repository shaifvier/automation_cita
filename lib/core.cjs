'use strict';

const patterns = {
  unavailable: /en este momento no hay citas disponibles/i,
  rejected: /requested URL was rejected|request rejected|access denied|too many requests/i,
  expired: /su sesi[oó]n ha caducado|sesi[oó]n expirada/i,
  temporary: /se ha producido un error en el sistema[\s,.;:]*por favor[\s,]*int[eé]ntelo de nuevo/i,
  captcha: /captcha|no soy un robot|verifica que eres humano|verify you are human/i,
};

function codeOf(text) {
  const flat = text.replace(/\s+/g, ' ');
  return flat.match(/no hay citas disponibles\.?\s*(\d{4})\b/i)?.[1]
    || flat.match(/\d{2}:\d{2}:\d{2}(\d{4})\b/)?.[1]
    || flat.match(/\b(0\d{3})\b\s*Cod\. Oper/i)?.[1] || null;
}

function classify({ text = '', httpStatus = 0, challenge = false,
  selectionStage = false, choices = [], contactForm = false }) {
  if ([403, 429].includes(httpStatus) || patterns.rejected.test(text)) return 'rechazo';
  if (httpStatus >= 500 || patterns.temporary.test(text)) return 'fallo temporal';
  if (challenge || patterns.captcha.test(text)) return 'captcha';
  if (patterns.expired.test(text)) return 'sesión caducada';
  // A generic control is not evidence. Require appointment wording and a
  // usable office/date/time choice, or a fully recognized contact form.
  const appointmentText = /seleccion(?:a|e|ar)\s+(?:la\s+|una?\s+)?(?:oficina|fecha|d[ií]a|hora)|citas? disponibles|calendario/i.test(text);
  const appointmentChoice = choices.some(c => c.usable && !/tr[aá]mites|provincia|tipo de documento/i.test(c.label)
    && /oficina|sede|fecha|\bd[ií]a\b|hora|\bcitas?\b|calendario/i.test(c.label));
  if (selectionStage && ((appointmentText && appointmentChoice) || (contactForm && !patterns.unavailable.test(text)))) return 'posible disponibilidad';
  if (patterns.unavailable.test(text)) return 'sin citas';
  return 'revisión';
}

function intervalMs(value = 120) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('Pausa inválida.');
  return Math.max(85_000, seconds * 1000);
}

function retryAfterMs(value, now = Date.now()) {
  if (!value) return 0;
  if (/^\d+$/.test(value.trim())) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

function backoffDelay(failures, interval, retryAfter = 0) {
  return Math.max(interval, [60_000, 120_000, 300_000][Math.min(failures, 2)], retryAfter);
}

function cooldownDelay(failedProbes, interval, retryAfter = 0) {
  return Math.max(interval, 15 * 60_000 * 2 ** Math.min(failedProbes, 2), retryAfter);
}

const actions = Object.freeze({
  entry: ['office', 'procedure', 'accept'],
  presentation: ['authenticate'],
  certificate: ['eidentifier'],
  form: ['close-info', 'nie-type', 'identity', 'submit-identity'],
  request: ['request-availability'],
  selection: [],
  hold: [],
});
function assertAction(stage, action) {
  if (!actions[stage]?.includes(action)) throw new Error('Acción fuera del flujo de consulta.');
}

function safeRecord(record) {
  // Never accept arbitrary fields, URLs, body text, exception messages or IDs.
  const allowed = ['time', 'browser', 'authentication', 'office', 'stage', 'httpStatus', 'result', 'code', 'reason', 'waitSeconds', 'retryAt'];
  return Object.fromEntries(allowed.filter(k => record[k] !== undefined).map(k => [k, record[k]]));
}

function redact(text, secrets = []) {
  let out = String(text);
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '[privado]');
  }
  return out;
}

module.exports = { patterns, codeOf, classify, intervalMs, retryAfterMs, backoffDelay, cooldownDelay, assertAction, safeRecord, redact };
