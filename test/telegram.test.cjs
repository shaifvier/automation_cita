'use strict';
// All network calls are injected fixtures. These tests never contact Telegram.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { readTelegramConfig, telegramRequest, sendTelegram, telegramText, telegramStatus } = require('../lib/telegram.cjs');
const { notifyAll } = require('../lib/notify.cjs');
const { findLinkedChat, setupTelegram } = require('../scripts/setup-telegram.cjs');
const token = '123456789:synthetic_token_for_local_tests_only';
const env = { CITA_TELEGRAM_TOKEN: token, CITA_TELEGRAM_CHAT_ID: '123456789',
  CITA_NIE: 'PRIVATE-IDENTITY', CITA_NOMBRE: 'PRIVATE-NAME', CITA_EMAIL: 'PRIVATE-EMAIL', CITA_TELEFONO: 'PRIVATE-PHONE' };
const reply = result => ({ ok: true, json: async () => ({ ok: true, result }) });

test('Telegram configuration is optional, private-chat only, and errors omit secrets', () => {
  assert.equal(readTelegramConfig({}), null);
  assert.equal(readTelegramConfig(env).chatId, '123456789');
  assert.ok(readTelegramConfig({ CITA_TELEGRAM_TOKEN: token }, { requireChat: false }));
  for (const config of [{ ...env, CITA_TELEGRAM_CHAT_ID: '-12345' }, { CITA_TELEGRAM_TOKEN: token }, { ...env, CITA_TELEGRAM_TOKEN: 'PRIVATE-TOKEN/host' }]) {
    assert.throws(() => readTelegramConfig(config), error => !error.message.includes(token) && !error.message.includes('PRIVATE-TOKEN'));
  }
});

test('Telegram sends one plain alert to the fixed HTTPS API without applicant data', async () => {
  const calls = [];
  const status = await sendTelegram('posible disponibilidad', { env, date: new Date('2026-11-26T15:02:13Z'),
    fetchImpl: async (url, options) => { calls.push({ url, options }); return reply({ message_id: 1 }); },
  });
  assert.equal(status, 'accepted'); assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://api.telegram.org/bot${token}/sendMessage`);
  assert.equal(calls[0].options.redirect, 'error');
  const payload = JSON.parse(calls[0].options.body);
  assert.equal(payload.chat_id, env.CITA_TELEGRAM_CHAT_ID); assert.equal(payload.disable_notification, false);
  assert.match(payload.text, /POSIBLE DISPONIBILIDAD/); assert.match(payload.text, /16:02:13/);
  for (const secret of [token, env.CITA_NIE, env.CITA_NOMBRE, env.CITA_EMAIL, env.CITA_TELEFONO]) assert.equal(payload.text.includes(secret), false);
});

test('routine cooldown/recovery and automatic expiry restarts do not send phone messages', async () => {
  let calls = 0;
  for (const kind of ['enfriamiento', 'reanudado', 'sesion_caducada', 'sin citas']) {
    assert.equal(await sendTelegram(kind, { env, fetchImpl: () => { calls++; } }), 'skipped');
  }
  for (const kind of ['revisión', 'captcha', 'sesión caducada', 'prueba']) assert.ok(telegramText(kind));
  assert.equal(calls, 0);
});

test('disabled or incomplete Telegram configuration performs no request', async () => {
  const fetchImpl = () => { throw new Error('Should not request'); };
  assert.equal(await sendTelegram('prueba', { env: {}, fetchImpl }), 'disabled');
  assert.equal(await sendTelegram('prueba', { env: { CITA_TELEGRAM_TOKEN: token }, fetchImpl }), 'configuration_error');
});

test('Telegram HTTP/API/JSON/network errors stay categorical and are not retried', async () => {
  for (const fetchImpl of [
    async () => ({ ok: false, status: 429 }),
    async () => ({ ok: true, json: async () => ({ ok: false, description: token }) }),
    async () => ({ ok: true, json: async () => { throw new Error(token); } }),
    async () => { throw new Error(token); },
  ]) {
    let attempts = 0;
    const status = await sendTelegram('prueba', { env, fetchImpl: (...args) => { attempts++; return fetchImpl(...args); } });
    assert.equal(status, 'failed'); assert.equal(attempts, 1);
    assert.equal(telegramStatus(status).includes(token), false);
  }
});

test('Telegram timeout is bounded even if a transport never settles', async () => {
  let signal;
  assert.equal(await sendTelegram('prueba', { env, timeoutMs: 20,
    fetchImpl: (_, options) => { signal = options.signal; return new Promise(() => {}); },
  }), 'timed_out');
  assert.equal(signal.aborted, true);
  assert.equal((await telegramRequest(token, 'deleteWebhook')).status, 'configuration_error');
});

test('Windows failure does not suppress Telegram and both transports start independently', async () => {
  const output = [];
  let phoneCalls = 0, finishWindows;
  const pending = notifyAll('posible disponibilidad', 'PRIVATE-OFFICE', {}, {
    windows: () => new Promise(resolve => { finishWindows = resolve; }),
    telegram: async () => { phoneCalls++; return 'accepted'; }, output: text => output.push(text),
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(phoneCalls, 1); assert.equal(output.length, 1); finishWindows(false);
  assert.equal(await pending, false);
  assert.equal(await notifyAll('prueba', undefined, {}, { windows: async () => { throw new Error('PRIVATE'); },
    telegram: async () => { phoneCalls++; return 'accepted'; }, output: () => {} }), false);
  assert.equal(phoneCalls, 2); assert.equal(output.join('').includes('PRIVATE'), false);
});

test('Telegram failure leaves Windows delivery and handoff intact', async () => {
  assert.equal(await notifyAll('prueba', undefined, {}, { windows: async () => true,
    telegram: async () => { throw new Error(token); }, output: text => assert.equal(text.includes(token), false) }), true);
});

const update = (id, text, type = 'private', updateId = 1) => ({ update_id: updateId,
  message: { text, chat: { id, type }, from: { id, is_bot: false } } });

test('chat linking requires the current nonce in a private chat and rejects ambiguity', () => {
  assert.equal(findLinkedChat([update(42, '/start old'), update(43, '/start challenge', 'group')], 'challenge'), null);
  assert.equal(findLinkedChat([update(42, '/start challenge')], 'challenge'), '42');
  assert.throws(() => findLinkedChat([update(42, '/start challenge'), update(43, '/start challenge')], 'challenge'), /Más de un chat/);
});

test('setup preserves local settings and sends a test only to the nonce-confirmed chat', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cita-telegram-'));
  const envPath = path.join(directory, '.env');
  const original = `CITA_NOMBRE="SYNTHETIC PRIVATE NAME"\nCITA_TELEGRAM_TOKEN=${token}\nCITA_TELEGRAM_CHAT_ID=\n`;
  fs.writeFileSync(envPath, original);
  const requests = [], lines = [], recipients = [];
  try {
    let polls = 0;
    const status = await setupTelegram({ env, envPath, nonce: 'challenge', sleep: async () => {}, output: line => lines.push(line),
      api: async (_, method, params) => {
        requests.push({ method, params });
        return method === 'getMe' ? { status: 'accepted', result: { username: 'synthetic_alert_bot', is_bot: true } }
          : { status: 'accepted', result: ++polls === 1 ? [update(99, '/start wrong', 'private', 4)] : [update(42, '/start challenge', 'private', 5)] };
      }, sendTest: async config => { recipients.push(config.chatId); return 'accepted'; },
    });
    assert.equal(status, 'accepted'); assert.deepEqual(recipients, ['42']);
    assert.equal(requests[2].params.offset, 5);
    assert.equal(fs.readFileSync(envPath, 'utf8'), original.replace('CITA_TELEGRAM_CHAT_ID=', 'CITA_TELEGRAM_CHAT_ID=42'));
    assert.ok(lines.some(line => line === 'https://t.me/synthetic_alert_bot?start=challenge'));
    assert.equal(lines.join('').includes(token), false); assert.equal(lines.join('').includes('SYNTHETIC PRIVATE NAME'), false);
  } finally { fs.unlinkSync(envPath); fs.rmdirSync(directory); }
});

test('setup refuses concurrent .env edits and sends nothing to unconfirmed chats', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cita-telegram-'));
  const envPath = path.join(directory, '.env'); fs.writeFileSync(envPath, 'CITA_TELEGRAM_CHAT_ID=\n');
  let sent = false;
  try {
    await assert.rejects(setupTelegram({ env, envPath, nonce: 'challenge', output: () => {},
      api: async (_, method) => {
        if (method === 'getMe') return { status: 'accepted', result: { username: 'synthetic_alert_bot', is_bot: true } };
        fs.writeFileSync(envPath, 'CONCURRENT=EDIT\n');
        return { status: 'accepted', result: [update(42, '/start challenge')] };
      }, sendTest: async () => { sent = true; },
    }), /cambió/);
    assert.equal(fs.readFileSync(envPath, 'utf8'), 'CONCURRENT=EDIT\n'); assert.equal(sent, false);
  } finally { fs.unlinkSync(envPath); fs.rmdirSync(directory); }
});

test('phone-test CLI needs no identity, certificate, Windows alert or browser', () => {
  const result = spawnSync(process.execPath, ['cita-regreso.cjs', '--probar-telegram'], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8', env: { ...process.env, CITA_TELEGRAM_TOKEN: '', CITA_TELEGRAM_CHAT_ID: '', CITA_NIE: '', CITA_NOMBRE: '' },
  });
  assert.equal(result.status, 1); assert.match(result.stdout, /Telegram desactivado/); assert.equal(result.stderr, '');
});
