'use strict';
// All network calls are injected fixtures. These tests never contact Telegram.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { readTelegramConfig, telegramRequest, sendTelegram, sendTelegramPhoto, telegramText, telegramStatus } = require('../lib/telegram.cjs');
const { captureTelegramScreenshot } = require('../lib/screenshot.cjs');
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
    enableTelegram: true,
    windows: () => new Promise(resolve => { finishWindows = resolve; }),
    telegram: async () => { phoneCalls++; return 'accepted'; }, output: text => output.push(text),
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(phoneCalls, 1); assert.equal(output.length, 1); finishWindows(false);
  assert.equal(await pending, false);
  assert.equal(await notifyAll('prueba', undefined, {}, { enableTelegram: true, windows: async () => { throw new Error('PRIVATE'); },
    telegram: async () => { phoneCalls++; return 'accepted'; }, output: () => {} }), false);
  assert.equal(phoneCalls, 2); assert.equal(output.join('').includes('PRIVATE'), false);
});

test('Telegram failure leaves Windows delivery and handoff intact', async () => {
  assert.equal(await notifyAll('prueba', undefined, {}, { enableTelegram: true, windows: async () => true,
    telegram: async () => { throw new Error(token); }, output: text => assert.equal(text.includes(token), false) }), true);
});

test('Windows-only mode never calls the Telegram transport, even with saved configuration', async () => {
  let desktop = 0, phone = 0;
  for (const settings of [{}, { enableTelegram: false }]) {
    assert.equal(await notifyAll('posible disponibilidad', undefined, {}, { ...settings,
      windows: async () => { desktop++; return true; }, telegram: async () => { phone++; return 'accepted'; },
      output: () => assert.fail('Disabled phone channel must not report delivery'),
    }), true);
  }
  assert.equal(desktop, 2); assert.equal(phone, 0);
});

test('Telegram screenshot is a bounded multipart upload to the private chat with a silent caption', async () => {
  const image = Buffer.from('synthetic-image');
  let requests = 0;
  assert.equal(await sendTelegramPhoto('prueba', image, { env, fetchImpl: async (url, options) => {
    requests++;
    assert.equal(url, `https://api.telegram.org/bot${token}/sendPhoto`);
    assert.ok(options.body instanceof FormData); assert.deepEqual(options.headers, {});
    assert.equal(options.body.get('chat_id'), env.CITA_TELEGRAM_CHAT_ID);
    assert.equal(options.body.get('disable_notification'), 'true'); assert.equal(options.body.get('protect_content'), 'true');
    const file = options.body.get('photo');
    assert.equal(file.type, 'image/jpeg'); assert.equal(file.name, 'icp-view.jpg');
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), image);
    assert.match(options.body.get('caption'), /PRUEBA DE TELEGRAM/);
    assert.equal(options.body.get('caption').includes(env.CITA_NIE), false);
    return reply({ message_id: 2 });
  } }), 'accepted');
  for (const invalid of [null, Buffer.alloc(0), Buffer.alloc(8 * 1024 * 1024 + 1)]) {
    assert.equal(await sendTelegramPhoto('prueba', invalid, { env, fetchImpl: () => { requests++; } }), 'failed');
  }
  assert.equal(requests, 1);
});

test('text alert is accepted before a slow screenshot and its photo upload', async () => {
  const order = [];
  let completeCapture;
  const pending = notifyAll('posible disponibilidad', undefined, {}, {
    enableTelegram: true, windows: async () => true, output: () => {},
    screenshot: () => new Promise(resolve => { completeCapture = resolve; }),
    telegram: async () => { order.push('text'); return 'accepted'; },
    telegramPhoto: async () => { order.push('photo'); return 'accepted'; },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['text']);
  completeCapture(Buffer.from('synthetic'));
  assert.equal(await pending, true); assert.deepEqual(order, ['text', 'photo']);
});

test('photo and capture failures preserve the original Windows and Telegram text alerts', async () => {
  for (const failure of ['capture', 'upload', 'text']) {
    const messages = [];
    let textCalls = 0, photoCalls = 0;
    assert.equal(await notifyAll('revisión', undefined, {}, {
      enableTelegram: true, windows: async () => true, output: value => messages.push(value),
      screenshot: async () => { if (failure === 'capture') throw new Error('PRIVATE'); return Buffer.from('synthetic'); },
      telegram: async () => { textCalls++; return failure === 'text' ? 'failed' : 'accepted'; },
      telegramPhoto: async () => { photoCalls++; throw new Error(token); },
    }), true);
    assert.equal(textCalls, 1); assert.equal(photoCalls, failure === 'upload' ? 1 : 0);
    assert.equal(messages.join('').includes(token), false); assert.equal(messages.join('').includes('PRIVATE'), false);
  }
});

test('disabled photo mode and routine events never capture or upload a browser view', async () => {
  let captures = 0, photos = 0;
  const base = { windows: async () => true, output: () => {},
    screenshot: async () => { captures++; return Buffer.from('synthetic'); },
    telegramPhoto: async () => { photos++; return 'accepted'; } };
  await notifyAll('posible disponibilidad', undefined, {}, { ...base, enableTelegram: false });
  await notifyAll('enfriamiento', undefined, {}, { ...base, enableTelegram: true, telegram: async () => 'skipped' });
  const { screenshot, ...textOnly } = base;
  await notifyAll('posible disponibilidad', undefined, {}, { ...textOnly, enableTelegram: true, telegram: async () => 'accepted' });
  assert.equal(captures, 0); assert.equal(photos, 0);
});

test('screenshot capture masks fields and literal applicant text without saving to disk', async () => {
  const masks = [];
  const page = { url: () => 'https://icp.administracionelectronica.gob.es/selection',
    locator: selector => { masks.push(selector); return selector; }, getByText: regex => { masks.push(regex); return regex; },
    screenshot: async options => { assert.equal(options.fullPage, false); assert.equal(options.type, 'jpeg'); assert.equal(options.path, undefined);
      assert.equal(options.mask.length, 3); assert.equal(options.timeout, 2000); return Buffer.from('synthetic'); },
  };
  assert.ok(await captureTelegramScreenshot(page, { secrets: ['SYNTHETIC.NAME', 'synthetic@example.invalid'] }));
  assert.ok(masks[1].test('SYNTHETIC.NAME')); assert.equal(masks[1].test('SYNTHETICxNAME'), false);
  assert.equal(await captureTelegramScreenshot({ url: () => 'https://example.invalid/', screenshot: () => assert.fail('Foreign origin captured') }), null);
});

test('unavailable, changed and stalled browser views fail without delaying the original text indefinitely', async () => {
  const url = 'https://icp.administracionelectronica.gob.es/selection';
  const page = { url: () => url, locator: () => ({}), getByText: () => ({}) };
  assert.equal(await captureTelegramScreenshot({ ...page, screenshot: async () => { throw new Error('PRIVATE'); } }), null);
  assert.equal(await captureTelegramScreenshot({ ...page, screenshot: () => new Promise(() => {}) }, { timeoutMs: 15 }), null);
  let changed = false;
  assert.equal(await captureTelegramScreenshot({ ...page, url: () => changed ? url + '/new' : url,
    screenshot: async () => { changed = true; return Buffer.from('synthetic'); } }), null);
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
