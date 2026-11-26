'use strict';
const { patterns } = require('./core.cjs');

function readContact(env = process.env) {
  const phone = (env.CITA_TELEFONO || '').trim().replace(/[\s().-]/g, '');
  const email = (env.CITA_EMAIL || '').trim();
  if (!phone && !email) return null;
  if (!/^\+?\d{9,15}$/.test(phone) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    || email.length > 254 || /REEMPLAZAR/i.test(email)) {
    throw new Error('Configura CITA_TELEFONO y CITA_EMAIL en .env; consulta .env.example.');
  }
  return { phone, email };
}

function contactRole(field) {
  const text = [field.id, field.name, field.label, field.ariaLabel, field.placeholder]
    .filter(Boolean).join(' ').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const mail = /e[\s_-]?mail|correo/.test(text);
  const phone = /telefono|movil|phone/.test(text);
  if (mail && phone) return null;
  if (mail) return /confirm|repet|repit|repeat|verif|(?:email|correo)[\s_-]*(?:dos|2)\b/.test(text) ? 'confirmation' : 'email';
  return phone ? 'phone' : null;
}

function contactPlan(fields) {
  const forms = new Map();
  for (const field of fields) {
    const role = contactRole(field);
    if (!role || field.form < 0) continue;
    if (!forms.has(field.form)) forms.set(field.form, { phone: [], email: [], confirmation: [] });
    forms.get(field.form)[role].push(field);
  }
  const plans = [...forms.values()].filter(form => Object.values(form).every(fields => fields.length === 1));
  return plans.length === 1 ? Object.fromEntries(Object.entries(plans[0]).map(([role, [field]]) => [role, field])) : null;
}

async function inspectContactForm(page) {
  // Read metadata only. Values, form actions and page text never enter reports.
  return page.locator('form input').evaluateAll((elements, sources) => {
    const blocked = sources.some(source => new RegExp(source, 'i').test(document.body?.innerText || ''))
      || [...document.querySelectorAll('iframe[src*=recaptcha],iframe[src*=hcaptcha],iframe[src*="challenges.cloudflare.com"],.g-recaptcha,.h-captcha,.cf-turnstile')]
        .some(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
    const fields = elements.map((el, index) => ({
      index, form: [...document.forms].indexOf(el.form), id: el.id, name: el.name, type: el.type,
      label: [...el.labels || []].map(label => label.textContent).join(' '),
      ariaLabel: el.getAttribute('aria-label'), placeholder: el.placeholder,
      usable: ['text', 'email', 'tel'].includes(el.type) && !el.disabled && !el.readOnly
        && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden',
    })).filter(field => field.usable);
    return { blocked, fields };
  }, Object.values(patterns).map(pattern => pattern.source));
}

async function prefillContact(page, contact, { origin, active = () => true } = {}) {
  const allowed = () => active() && new URL(page.url()).origin === origin;
  try {
    if (!allowed()) return 'stopped';
    const initialUrl = page.url();
    const { blocked, fields } = await inspectContactForm(page);
    if (blocked) return 'blocked';
    const plan = contactPlan(fields);
    if (!plan) return 'waiting';
    const targets = Object.entries(plan).map(([role, field]) => ({
      field, locator: page.locator('form input').nth(field.index), value: role === 'phone' ? contact.phone : contact.email,
    }));
    // Check all three before writing anything. Never replace existing edits.
    for (const target of targets) {
      const current = await target.locator.inputValue({ timeout: 750 });
      if (current && current !== target.value) return 'existing_contact';
      const max = await target.locator.getAttribute('maxlength', { timeout: 750 });
      if (max !== null && Number(max) >= 0 && target.value.length > Number(max)) return 'unsupported';
    }
    let changed = false;
    for (const target of targets) {
      if (!allowed() || page.url() !== initialUrl) return 'stopped';
      // Recheck identity and blankness after each asynchronous operation.
      const current = await target.locator.evaluate((el, expected) => ({
        same: el.id === expected.id && el.name === expected.name && el.type === expected.type
          && [...document.forms].indexOf(el.form) === expected.form
          && [...el.labels || []].map(label => label.textContent).join(' ') === expected.label
          && el.getAttribute('aria-label') === expected.ariaLabel && el.placeholder === expected.placeholder,
        empty: el.value === '', matches: el.value === expected.value,
      }), { ...target.field, value: target.value });
      if (!current.same || (!current.empty && !current.matches)) return 'existing_contact';
      if (current.empty) {
        if (!allowed() || page.url() !== initialUrl) return 'stopped';
        await target.locator.fill(target.value, { timeout: 750 });
        changed = true;
      }
    }
    return changed ? 'filled' : 'ready';
  } catch {
    // Playwright exceptions can include field values; keep them private.
    return 'failed';
  }
}

module.exports = { readContact, contactRole, contactPlan, inspectContactForm, prefillContact };
