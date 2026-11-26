'use strict';
const notifier = require('node-notifier');
const { sendTelegram, telegramStatus } = require('./telegram.cjs');

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
async function notifyAll(kind, office, details = {}, { enableTelegram = false, windows = notify, telegram = sendTelegram, output = console.log } = {}) {
  // Independent transports: a failed desktop notification must not suppress the phone alert.
  const desktop = Promise.resolve().then(() => windows(kind, office, undefined, details)).catch(() => false);
  const phone = enableTelegram ? Promise.resolve().then(() => telegram(kind)).catch(() => 'failed').then(status => {
    if (status !== 'skipped') {
      try { output(telegramStatus(status)); } catch { /* Local reporting cannot block handoff. */ }
    }
  }) : Promise.resolve();
  const [delivered] = await Promise.all([desktop, phone]);
  return delivered; // Preserve the Windows delivery meaning used by existing callers.
}
module.exports = { notification, notify, notifyAll };
