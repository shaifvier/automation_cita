'use strict';
const { classify, patterns, codeOf, assertAction } = require('./core.cjs');

const ENTRY = 'https://icp.administracionelectronica.gob.es/icpplustieb/citar?p=8&locale=es';
const PROCEDURE = 'AUTORIZACIÓN DE REGRESO';
const ANY_OFFICE = 'Cualquier oficina';

class Stop extends Error {
  constructor(result, reason) { super(result); this.result = result; this.reason = reason; }
}

function createPortal(session, { entry = ENTRY, diagnostic = false, certificate = false,
  identity = {}, onNavigation = () => {}, stepDelayMs = 3000, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const { page } = session;
  let stage = 'entry', httpStatus = 0, retryAfter = null;
  let challengeUsed = false, handedOff = false;
  const origin = new URL(entry).origin;
  page.on('response', response => {
    if (stage === 'hold') return;
    const request = response.request();
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      httpStatus = response.status();
      retryAfter = response.headers()['retry-after'] || null;
      onNavigation({ stage, httpStatus, result: 'navegación' });
    }
  });
  const alive = () => session.browser.isConnected() && !page.isClosed();
  const body = () => page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  const officeMenu = () => page.getByRole('combobox', { name: 'Selecciona Oficina:' });
  const policeMenu = () => page.getByRole('combobox', { name: 'TRÁMITES POLICÍA NACIONAL' });

  async function snapshot(selectionStage = stage === 'selection') {
    const text = await body();
    const challenge = await page.locator('iframe[src*="recaptcha"]:visible, iframe[src*="hcaptcha"]:visible, iframe[src*="challenges.cloudflare.com"]:visible, .g-recaptcha:visible, .h-captcha:visible, .cf-turnstile:visible').count() > 0;
    const choices = await page.locator('select:visible, input[type=radio]:visible, input[type=date]:visible').evaluateAll(elements => elements.map(el => {
      const label = [el.id, el.name, el.getAttribute('aria-label'),
        ...Array.from(el.labels || [], item => item.textContent)].filter(Boolean).join(' ');
      const usable = !el.disabled && (el.tagName !== 'SELECT' || Array.from(el.options).some(option =>
        !option.disabled && option.value && !/^(seleccion|despliega|elij|escog)/i.test(option.text.trim())));
      return { label, usable: Boolean(usable) };
    })).catch(() => []);
    return { result: classify({ text, httpStatus, challenge, selectionStage, choices }), code: codeOf(text),
      stage, httpStatus, retryAfter };
  }

  function assertOrigin() {
    const current = new URL(page.url());
    const allowed = stage === 'certificate' ? [origin, 'https://pasarela-ident.clave.gob.es', 'https://se-pasarela.clave.gob.es'] : [origin];
    const claveGateway = stage === 'certificate' && current.protocol === 'https:' && (current.hostname === 'clave.gob.es' || current.hostname.endsWith('.clave.gob.es'));
    if (!allowed.includes(current.origin) && !claveGateway) throw new Stop('revisión', 'unexpected_origin');
  }
  async function click(locator, action) {
    assertAction(stage, action); assertOrigin();
    try { await locator.click({ timeout: 10_000 }); }
    catch { throw new Stop('revisión', 'click_failed'); } // Never force or evaluate(el.click()).
  }
  async function waitFor(locator, timeout = 30_000) {
    const interrupt = page.getByText(patterns.rejected).or(page.getByText(patterns.expired)).or(page.getByText(patterns.captcha));
    await locator.or(interrupt).first().waitFor({ timeout });
    const state = await snapshot(false);
    if (['rechazo', 'captcha', 'sesión caducada', 'fallo temporal'].includes(state.result)) throw new Stop(state.result);
  }

  async function open() {
    if (handedOff) return { stage: 'hold', result: 'revisión', reason: 'human_handoff' };
    stage = 'entry'; httpStatus = 0; retryAfter = null; challengeUsed = false;
    try {
      await page.goto(entry, { waitUntil: 'domcontentloaded' });
      let state = await snapshot(false);
      if (state.result === 'captcha') {
        state = await handleChallenge();
        if (state.result === 'captcha') return state;
      }
      if (['rechazo', 'sesión caducada', 'fallo temporal'].includes(state.result)) return state;
      await waitFor(officeMenu());
      // ICP+ can reload after its JavaScript check; require stable controls.
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      await officeMenu().waitFor();
      return { ...await snapshot(false), result: 'ok' };
    } catch (error) { return failure(error); }
  }

  async function handleChallenge() {
    if (!challengeUsed) {
      challengeUsed = true;
      await session.solveChallenge();
      if (alive()) await sleep(1500);
    }
    return snapshot();
  }

  async function failure(error) {
    const state = await snapshot();
    if (error instanceof Stop) return { ...state, result: error.result, reason: error.reason };
    if (['rechazo', 'captcha', 'sesión caducada', 'fallo temporal'].includes(state.result)) return state;
    return { ...state, result: 'revisión', reason: error.name === 'TimeoutError' ? 'expected_control_timeout' : 'unexpected_error' };
  }

  async function checkOffice(label) {
    if (handedOff) return { stage: 'hold', result: 'revisión', reason: 'human_handoff' };
    try {
      stage = 'entry';
      assertAction(stage, 'office'); assertOrigin();
      if (await officeMenu().inputValue() !== await officeMenu().locator('option').evaluateAll((options, label) =>
        options.find(o => o.text.trim() === label)?.value, label)) {
        const nav = page.waitForEvent('framenavigated', { predicate: f => f === page.mainFrame(), timeout: 10_000 }).catch(() => null);
        await officeMenu().selectOption({ label });
        await nav;
      }
      await waitFor(policeMenu());
      const options = await policeMenu().locator('option').allTextContents();
      if (!options.filter(text => text.trim() && !/^Despliega/i.test(text.trim())).length) throw new Stop('fallo temporal');
      if (!options.some(text => text.trim() === PROCEDURE)) return { ...await snapshot(), result: 'sin trámite' };
      assertAction(stage, 'procedure');
      await policeMenu().selectOption({ label: PROCEDURE });
      await sleep(stepDelayMs);
      await click(page.getByRole('button', { name: 'Aceptar', exact: true }), 'accept');

      stage = 'presentation';
      const presentation = page.getByText(certificate ? /^Presentación con Cl@ve$/ : /^Presentación sin Cl@ve$/).first();
      await waitFor(presentation);
      await sleep(stepDelayMs);
      await click(presentation, 'authenticate');

      const nieBox = page.locator('#txtIdCitado');
      const nameBox = page.locator('#txtDesCitado');
      if (certificate) {
        stage = 'certificate';
        const eidName = /(?:Access|Acceder)\s+(?:a\s+)?eIdentifi(?:er|cador)|Acceso\s+DNIe\s*\/\s*Certificado\s+electr[oó]nico/i;
        const eid = page.getByRole('button', { name: eidName }).or(page.getByRole('link', { name: eidName })).or(page.getByText(eidName)).first();
        await waitFor(eid.or(nieBox), 60_000);
        if (await eid.isVisible().catch(() => false)) {
          await click(eid, 'eidentifier');
          await waitFor(nieBox, 60_000);
        }
      }
      stage = 'form';
      await waitFor(nieBox);
      assertOrigin();
      const extra = await page.locator('input[required], select[required]').evaluateAll(elements =>
        elements.some(el => !['txtIdCitado', 'txtDesCitado'].includes(el.id) && !el.disabled && el.type !== 'hidden'));
      if (extra) throw new Stop('revisión');
      if (diagnostic) return { ...await snapshot(), result: 'formulario disponible' };

      const closeInfo = page.locator('.modal.show .close, .modal.in .close, [role="dialog"] .close, button[aria-label="Close"], button[aria-label="Cerrar"]').first();
      if (await closeInfo.isVisible().catch(() => false)) await click(closeInfo, 'close-info');
      const radio = page.locator('#rdbTipoDocNie');
      if (await radio.count() && !await radio.isChecked()) { assertAction(stage, 'nie-type'); await radio.check(); }
      assertAction(stage, 'identity');
      await nieBox.fill(identity.nie); await nameBox.fill(identity.name);
      await sleep(stepDelayMs);
      // Only submit applicant validation, never an appointment selection.
      const navigated = page.waitForEvent('framenavigated', { predicate: f => f === page.mainFrame(), timeout: 30_000 }).catch(() => null);
      await click(page.locator('#btnEnviar'), 'submit-identity');
      if (!await navigated) throw new Stop('revisión');
      await page.waitForLoadState('domcontentloaded');

      stage = 'request';
      const request = page.getByRole('button', { name: 'Solicitar Cita', exact: true });
      await waitFor(request.or(page.getByText(patterns.unavailable)));
      let state = await snapshot(false);
      if (state.result !== 'revisión') return state;
      if (!await request.isVisible()) throw new Stop('revisión');
      await sleep(stepDelayMs);
      await click(request, 'request-availability');
      await request.waitFor({ state: 'hidden' });
      await page.waitForLoadState('domcontentloaded');
      await sleep(1500);
      stage = 'selection';
      // There are no actions allowed in this stage, even on unknown pages.
      return snapshot(true);
    } catch (error) { return failure(error); }
  }

  return { open, checkOffice, snapshot, handleChallenge, alive,
    async offices() { return officeMenu().locator('option').allTextContents().then(items => items.map(x => x.trim()).filter(Boolean)); },
    hold() { stage = 'hold'; handedOff = true; },
  };
}
module.exports = { ENTRY, PROCEDURE, ANY_OFFICE, createPortal };
