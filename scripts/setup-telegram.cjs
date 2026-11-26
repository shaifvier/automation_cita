'use strict';
// One-time setup for a dedicated personal alert bot. No ICP+ traffic.
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { setTimeout: pause } = require('node:timers/promises');
const { readTelegramConfig, telegramRequest, sendTelegram, telegramStatus } = require('../lib/telegram.cjs');

class SetupError extends Error {}

function findLinkedChat(updates, nonce) {
  const chats = new Set();
  for (const update of updates) {
    const message = update.message;
    if (message?.text === `/start ${nonce}` && message.chat?.type === 'private'
      && Number.isSafeInteger(message.chat.id) && message.chat.id > 0
      && message.from?.id === message.chat.id && !message.from.is_bot) chats.add(String(message.chat.id));
  }
  if (chats.size > 1) throw new SetupError('Más de un chat usó el enlace. Repite el enlace privado y no lo compartas.');
  return chats.size === 1 ? [...chats][0] : null;
}

async function setupTelegram({ env = process.env, envPath = path.join(__dirname, '..', '.env'),
  api = telegramRequest, output = console.log, now = Date.now, sleep = pause,
  nonce = randomBytes(24).toString('base64url'), timeoutMs = 120_000,
  sendTest = config => sendTelegram('prueba', { env: { CITA_TELEGRAM_TOKEN: config.token, CITA_TELEGRAM_CHAT_ID: config.chatId } }),
} = {}) {
  let config;
  try { config = readTelegramConfig(env, { requireChat: false }); } catch { /* Generic setup instruction below. */ }
  if (!config) throw new SetupError('Guarda el token de @BotFather en CITA_TELEGRAM_TOKEN dentro de .env.');
  let initial;
  try { initial = fs.readFileSync(envPath, 'utf8'); }
  catch { throw new SetupError('No se pudo leer .env. Prepara el archivo local antes de enlazar Telegram.'); }
  const me = await api(config.token, 'getMe');
  if (me.status !== 'accepted' || !me.result?.is_bot || !/^[A-Za-z0-9_]{5,32}$/.test(me.result.username || '')) {
    throw new SetupError('Telegram no pudo verificar el bot. Revisa el token y la conexión.');
  }
  output('Abre este enlace en tu Telegram y pulsa INICIAR/START (caduca en 2 minutos):');
  output(`https://t.me/${me.result.username}?start=${nonce}`);
  const deadline = now() + timeoutMs;
  let offset;
  while (now() < deadline) {
    const result = await api(config.token, 'getUpdates', {
      ...(offset !== undefined ? { offset } : {}), limit: 100, timeout: 10, allowed_updates: ['message'],
    }, { timeoutMs: Math.min(15_000, deadline - now()) });
    if (result.status !== 'accepted' || !Array.isArray(result.result)) {
      throw new SetupError('No se pudo leer la confirmación. Usa un bot dedicado sin webhook ni otro proceso getUpdates y revisa la conexión.');
    }
    const chatId = findLinkedChat(result.result, nonce);
    if (chatId) {
      // Refuse to overwrite concurrent edits to applicant/certificate settings.
      let current;
      try { current = fs.readFileSync(envPath, 'utf8'); }
      catch { throw new SetupError('No se pudo releer .env; no se guardó el chat.'); }
      if (current !== initial) throw new SetupError('.env cambió durante el enlace. Repite la configuración para conservar los cambios.');
      const key = /^\s*CITA_TELEGRAM_CHAT_ID\s*=.*$/gm;
      let updated = current.replace(key, `CITA_TELEGRAM_CHAT_ID=${chatId}`);
      if (!key.test(current)) updated = current.trimEnd() + `\nCITA_TELEGRAM_CHAT_ID=${chatId}\n`;
      try { fs.writeFileSync(envPath, updated, 'utf8'); }
      catch { throw new SetupError('No se pudo guardar el chat en .env.'); }
      output('Chat privado enlazado en .env. Enviando un aviso de prueba…');
      const status = await sendTest({ token: config.token, chatId });
      output(telegramStatus(status));
      return status;
    }
    for (const update of result.result) {
      if (Number.isSafeInteger(update.update_id)) offset = Math.max(offset || 0, update.update_id + 1);
    }
    // Long polling is normally sufficient; a small delay also bounds empty fast replies.
    await sleep(Math.min(500, Math.max(0, deadline - now())));
  }
  throw new SetupError('El enlace caducó sin confirmación. Ejecuta de nuevo la configuración y pulsa START en el enlace nuevo.');
}

if (require.main === module) setupTelegram().then(status => { if (status !== 'accepted') process.exitCode = 1; })
  .catch(error => { console.error(error instanceof SetupError ? error.message : 'No se pudo completar el enlace de Telegram. No se han mostrado datos privados.'); process.exitCode = 1; });

module.exports = { findLinkedChat, setupTelegram, SetupError };
