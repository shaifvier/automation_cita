'use strict';

const tokenPattern = /^\d+:[A-Za-z0-9_-]{20,}$/;
const privateChatPattern = /^[1-9]\d*$/;
const events = new Set(['posible disponibilidad', 'revisión', 'captcha', 'sesión caducada', 'prueba']);

function readTelegramConfig(env = process.env, { requireChat = true } = {}) {
  const token = (env.CITA_TELEGRAM_TOKEN || '').trim();
  const chatId = (env.CITA_TELEGRAM_CHAT_ID || '').trim();
  if (!token && !chatId) return null;
  if (!tokenPattern.test(token) || (requireChat && !privateChatPattern.test(chatId))) {
    throw new Error('Configura CITA_TELEGRAM_TOKEN y enlaza tu chat privado; consulta README.md.');
  }
  return { token, chatId };
}

function telegramText(kind, date = new Date()) {
  const text = {
    'posible disponibilidad': 'ICP+: POSIBLE DISPONIBILIDAD\nBarcelona · Autorización de regreso. Revisa ahora el navegador del ordenador y elige la comisaría. La reserva la completas tú.',
    revisión: 'ICP+: REVISIÓN NECESARIA\nEl monitor espera intervención manual. Revisa el navegador del ordenador.',
    captcha: 'ICP+: CAPTCHA\nEl monitor espera intervención manual. Revisa el navegador del ordenador.',
    'sesión caducada': 'ICP+: SESIÓN CADUCADA\nNo se pudo continuar automáticamente. Revisa el navegador del ordenador.',
    prueba: 'ICP+: PRUEBA DE TELEGRAM\nSi ves este mensaje, el canal de Telegram recibe avisos. No se ha consultado ni reservado una cita.',
  }[kind];
  if (!text) return null;
  const time = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', dateStyle: 'short', timeStyle: 'medium' }).format(date);
  return `${text}\n${time} (Europe/Madrid)`;
}

async function telegramRequest(token, method, params = {}, { fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
  if (!tokenPattern.test(token) || !['sendMessage', 'getMe', 'getUpdates'].includes(method)) return { status: 'configuration_error' };
  const controller = new AbortController();
  let timer;
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => { controller.abort(); resolve({ status: 'timed_out' }); }, timeoutMs);
  });
  const request = (async () => {
    try {
      const response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params),
        signal: controller.signal, redirect: 'error',
      });
      if (!response.ok) return { status: 'failed' };
      const data = await response.json();
      return data.ok === true ? { status: 'accepted', result: data.result } : { status: 'failed' };
    } catch {
      // Exceptions and API descriptions can contain token-bearing URLs or chat data.
      return { status: controller.signal.aborted ? 'timed_out' : 'failed' };
    }
  })();
  try { return await Promise.race([request, timeout]); }
  finally { clearTimeout(timer); }
}

async function sendTelegram(kind, { env = process.env, date = new Date(), ...requestOptions } = {}) {
  if (!events.has(kind)) return 'skipped';
  let config;
  try { config = readTelegramConfig(env); } catch { return 'configuration_error'; }
  if (!config) return 'disabled';
  const { status } = await telegramRequest(config.token, 'sendMessage', {
    chat_id: config.chatId, text: telegramText(kind, date), disable_notification: false, protect_content: true,
  }, requestOptions);
  return status;
}

function telegramStatus(status) {
  return {
    accepted: 'Telegram aceptó el mensaje; revisa el móvil.',
    disabled: 'Telegram desactivado: configura el token y enlaza el chat privado.',
    configuration_error: 'Telegram sin configurar: revisa CITA_TELEGRAM_TOKEN y CITA_TELEGRAM_CHAT_ID en .env.',
    timed_out: 'Telegram agotó el tiempo de envío; la entrega no está confirmada.',
    failed: 'Telegram no confirmó el envío; revisa la conexión y la configuración local.',
  }[status] || 'Telegram no confirmó el envío.';
}

module.exports = { readTelegramConfig, telegramText, telegramRequest, sendTelegram, telegramStatus };
