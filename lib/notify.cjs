'use strict';
const notifier = require('node-notifier');
const { sendTelegram, sendTelegramPhoto, telegramStatus } = require('./telegram.cjs');

function notification(kind, office = 'Barcelona', details = {}) {
  const titles = {
    'posible disponibilidad': 'ICP+: posible disponibilidad',
    captcha: 'ICP+: intervención en CAPTCHA',
    prueba: 'ICP+: prueba de aviso',
    enfriamiento: 'ICP+: monitor en pausa',
    reanudado: 'ICP+: monitor reanudado',
    sesion_caducada: 'ICP+: reinicio de consulta programado',
  };
  const cooldownMessage = `${office}. Demasiados fallos; nuevo intento en ${Math.ceil((details.waitSeconds ?? 900) / 60)} min. La sesión se conserva.`;
  return { title: titles[kind] || 'ICP+: revisión necesaria',
    message: kind === 'sesion_caducada' ? `${office}. La solicitud ha caducado; se iniciará de nuevo en ${Math.ceil((details.waitSeconds ?? 120) / 60)} min, conservando el navegador.`
      : kind === 'enfriamiento' ? cooldownMessage
      : kind === 'reanudado' ? `${office}. Consulta completada; vuelve la vigilancia periódica. No se ha reservado ninguna cita.`
      : kind === 'prueba' ? 'Aviso de prueba. No se ha consultado ni reservado ninguna cita.'
      : `${office}. Revisa el navegador; la reserva la completa una persona.`,
    sound: true, wait: false, timeout: 10 };
}

function notify(kind, office, transport = notifier, details = {}) {
  return new Promise(resolve => {
    // Notification delivery does not prove that Windows displayed it.
    const timer = setTimeout(() => resolve(false), 12_000);
    try {
      transport.notify(notification(kind, office, details), error => { clearTimeout(timer); resolve(!error); });
    } catch { clearTimeout(timer); resolve(false); }
  });
}
async function notifyAll(kind, office, details = {}, {
  enableTelegram = false, screenshot, windows = notify, telegram = sendTelegram, telegramPhoto = sendTelegramPhoto, output = console.log,
} = {}) {
  // Independent transports: a failed desktop notification must not suppress the phone alert.
  const desktop = Promise.resolve().then(() => windows(kind, office, undefined, details)).catch(() => false);
  const phone = enableTelegram ? (async () => {
    const capture = screenshot && ['posible disponibilidad', 'revisión', 'captcha', 'sesión caducada', 'prueba'].includes(kind)
      ? Promise.resolve().then(() => screenshot()).catch(() => null) : null;
    const status = await Promise.resolve().then(() => telegram(kind)).catch(() => 'failed');
    if (status !== 'skipped') {
      try { output(telegramStatus(status)); } catch { /* Local reporting cannot block handoff. */ }
    }
    if (status === 'accepted' && capture) {
      const image = await capture;
      const imageStatus = image ? await Promise.resolve().then(() => telegramPhoto(kind, image)).catch(() => 'failed') : 'failed';
      try { output(imageStatus === 'accepted' ? 'Telegram aceptó la captura; revisa el móvil.' : 'Captura de Telegram no confirmada; el aviso de texto ya fue aceptado.'); }
      catch { /* Never interrupt manual booking to report a photo failure. */ }
    }
  })() : Promise.resolve();
  const [delivered] = await Promise.all([desktop, phone]);
  return delivered; // Preserve the Windows delivery meaning used by existing callers.
}
module.exports = { notification, notify, notifyAll };
