'use strict';
const notifier = require('node-notifier');

function notification(kind, office = 'Barcelona', details = {}) {
  const titles = {
    'posible disponibilidad': 'ICP+: posible disponibilidad',
    captcha: 'ICP+: intervención en CAPTCHA',
    prueba: 'ICP+: prueba de aviso',
    enfriamiento: 'ICP+: monitor en pausa',
    reanudado: 'ICP+: monitor reanudado',
  };
  const cooldownMessage = `${office}. Demasiados fallos; nuevo intento en ${Math.ceil((details.waitSeconds ?? 900) / 60)} min. La sesión se conserva.`;
  return { title: titles[kind] || 'ICP+: revisión necesaria',
    message: kind === 'enfriamiento' ? cooldownMessage
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
module.exports = { notification, notify };
