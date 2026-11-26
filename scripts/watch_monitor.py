"""Read-only observer for an already-running monitor-owned Chrome.

No navigation, clicks, input, cookies, storage or authentication are changed.
Only categorical DOM observations are logged. Candidate screenshots are PRIVATE.
"""
import argparse
import asyncio
import base64
from collections import Counter
import ctypes
from contextlib import suppress
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
import urllib.parse
import urllib.request
from zoneinfo import ZoneInfo

import psutil
import websockets

MADRID = ZoneInfo('Europe/Madrid')
SNAPSHOT_JS = r'''(() => {
  const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const t = norm(document.body?.innerText);
  const visible = el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const controls = [...document.querySelectorAll('select,input[type=radio],input[type=date]')].filter(visible);
  const choices = controls.some(el => {
    const label = norm([el.id, el.name, el.getAttribute('aria-label'), ...Array.from(el.labels || [], l => l.textContent)].join(' '));
    const usable = !el.disabled && (el.tagName !== 'SELECT' || [...el.options].some(o => !o.disabled && o.value && !/^(seleccion|despliega|elij|escog)/i.test(norm(o.text).trim())));
    return usable && !/tramites|provincia|tipo de documento/.test(label) && /oficina|sede|fecha|\bdia\b|hora|\bcitas?\b|calendario/.test(label);
  });
  const requestButton = [...document.querySelectorAll('button,input[type=button],input[type=submit]')].filter(visible).some(e => /solicitar cita/.test(norm(e.innerText || e.value)));
  const applicantForm = !!document.querySelector('#txtIdCitado');
  const entry = /tramites policia nacional/.test(t) && controls.some(e => e.tagName === 'SELECT');
  const challengeFrame = [...document.querySelectorAll('iframe[src*=recaptcha],iframe[src*=hcaptcha],iframe[src*="challenges.cloudflare.com"],.g-recaptcha,.h-captcha,.cf-turnstile')].some(visible);
  const selectionWords = /seleccion(?:a|e|ar)\s+(?:la\s+|una?\s+)?(?:oficina|fecha|dia|hora)|citas? disponibles|calendario/.test(t);
  const contactForms = [...document.forms].filter(form => {
    const roles = {phone: 0, email: 0, confirmation: 0};
    for (const el of [...form.querySelectorAll('input')].filter(el => visible(el) && !el.disabled && !el.readOnly && ['text', 'email', 'tel'].includes(el.type))) {
      const label = norm([el.id, el.name, el.getAttribute('aria-label'), el.placeholder, ...Array.from(el.labels || [], l => l.textContent)].join(' '));
      const mail = /e[\s_-]?mail|correo/.test(label), phone = /telefono|movil|phone/.test(label);
      if (mail && phone) continue;
      if (mail) roles[/confirm|repet|repit|repeat|verif|(?:email|correo)[\s_-]*(?:dos|2)\b/.test(label) ? 'confirmation' : 'email']++;
      else if (phone) roles.phone++;
    }
    return Object.values(roles).every(count => count === 1);
  });
  return {
    temporary: /se ha producido un error en el sistema[\s,.;:]*por favor[\s,]*intentelo de nuevo/.test(t),
    expired: /su sesion ha caducado|sesion expirada/.test(t),
    rejected: /requested url was rejected|request rejected|access denied|too many requests/.test(t),
    captcha: challengeFrame || /captcha|no soy un robot|verifica que eres humano|verify you are human/.test(t),
    unavailable: /en este momento no hay citas disponibles/.test(t),
    applicantForm, entry, requestButton,
    candidate: ((choices && selectionWords) || contactForms.length === 1) && !entry && !applicantForm && !requestButton,
    code: (t.match(/no hay citas disponibles\.?\s*(\d{4})\b/) || t.match(/\d{2}:\d{2}:\d{2}(\d{4})\b/) || t.match(/\b(0\d{3})\b\s*cod\. oper/i) || [])[1] || null
  };
})()'''


def category(state, host):
    if state.get('rejected'):
        return 'rejected'
    if state.get('temporary'):
        return 'temporary_error'
    if state.get('expired'):
        return 'session_expired'
    if state.get('captcha'):
        return 'challenge'
    if host != 'icp.administracionelectronica.gob.es':
        return 'authentication'
    if state.get('applicantForm') or state.get('requestButton') or state.get('entry'):
        return 'checking'
    if state.get('candidate'):
        return 'potential_availability'
    if state.get('unavailable'):
        return 'no_appointments'
    return 'review_needed'


def allowed_host(host):
    return host == 'icp.administracionelectronica.gob.es' or host == 'clave.gob.es' or host.endswith('.clave.gob.es')


def atomic_json(path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=True, indent=2) + '\n', encoding='utf-8')
    temporary.replace(path)


class Journal:
    def __init__(self, directory, monitor_pid):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.monitor_pid = monitor_pid
        self.started = datetime.now(timezone.utc).isoformat()
        self.counts = Counter()
        self.events = []
        self.gaps = []
        self.candidates = []
        self.previous = None
        self.previous_code = None
        self.last = None
        # Resume the private observation history when this observer is restarted.
        history = self.directory / 'observations.jsonl'
        if history.exists():
            for line in history.read_text(encoding='utf-8').splitlines():
                try:
                    row = json.loads(line)
                    if row.get('source') == 'read_only_browser_observer':
                        self._remember(row)
                except (ValueError, KeyError):
                    continue
            if self.events:
                self.started = self.events[0]['observedAt']

    def _remember(self, row):
        if self.last:
            elapsed = (datetime.fromisoformat(row['observedAt']) - datetime.fromisoformat(self.last['observedAt'])).total_seconds()
            if elapsed > 90:
                self.gaps.append({'from': self.last['observedAtMadrid'], 'to': row['observedAtMadrid'], 'seconds': round(elapsed)})
        status, code = row['status'], row.get('code')
        self.counts[status] += 1
        if status != self.previous or code != self.previous_code or row.get('evidence'):
            self.events.append(row)
        if status == 'potential_availability':
            if self.previous != status:
                self.candidates.append(row)
            elif row.get('evidence') and self.candidates:
                self.candidates[-1]['evidence'] = row['evidence']
        self.previous, self.previous_code, self.last = status, code, row

    def record(self, status, code=None, evidence=None, keep_awake=False):
        stamp = datetime.now(timezone.utc)
        row = {'observedAt': stamp.isoformat(), 'observedAtMadrid': stamp.astimezone(MADRID).isoformat(),
               'source': 'read_only_browser_observer', 'monitorPid': self.monitor_pid,
               'status': status, 'code': code, 'evidence': evidence, 'keepAwake': keep_awake}
        with (self.directory / 'observations.jsonl').open('a', encoding='utf-8') as stream:
            stream.write(json.dumps(row, ensure_ascii=True) + '\n')
        if self.last is None:
            self.started = row['observedAt']
        self._remember(row)
        # A report viewer may briefly hold a file open on Windows. The append-only
        # journal remains the source of truth if a derived-file refresh is locked.
        with suppress(OSError):
            atomic_json(self.directory / 'status.json', {'observerPid': psutil.Process().pid, 'startedAt': self.started,
                'latest': row, 'observationCounts': dict(self.counts), 'observationGaps': self.gaps, 'potentialAvailabilityEvents': self.candidates})
        with suppress(OSError):
            self.write_report()

    def write_report(self):
        lines = ['# Overnight appointment-monitor observations', '',
            'Barcelona / Autorizacion de regreso / Cualquier oficina / certificate authentication.', '',
            f"Latest observation (Europe/Madrid): **{self.last['observedAtMadrid']}**",
            f"Current browser state: **{self.last['status']}**",
            f"Potential availability events recorded: **{len(self.candidates)}**", '',
            ('The observed monitor has stopped; this report is closed.' if self.last['status'] == 'monitor_stopped'
             else 'The primary monitor controls polling, Windows alerts, cooldown and expiry recovery.'),
            'This observer reads the browser only; samples are NOT counts of portal queries.',
            'Potential availability requires human verification. Nothing is selected or booked.',
            'Screenshots, if present, are private local evidence and may contain applicant details. Do not publish them.', '',
            '## State changes', '', '| Europe/Madrid | Observed state | Code | Evidence |', '| --- | --- | --- | --- |']
        for row in self.events[-100:]:
            evidence = f"[Screenshot]({row['evidence']})" if row.get('evidence') else ''
            lines.append(f"| {row['observedAtMadrid']} | {row['status']} | {row.get('code') or ''} | {evidence} |")
        if self.gaps:
            lines.extend(['', '## Observation gaps', '', 'Availability cannot be established during these unobserved intervals.', ''])
            for gap in self.gaps:
                lines.append(f"- {gap['from']} to {gap['to']}: {gap['seconds']} seconds without an observation.")
        if self.candidates:
            lines.extend(['', '## Potential availability evidence', ''])
            for row in self.candidates:
                evidence = f"[Screenshot]({row['evidence']})" if row.get('evidence') else 'Screenshot unavailable'
                lines.append(f"- {row['observedAtMadrid']}: {evidence}")
        lines.extend(['', '## Observation counts', ''])
        lines.extend(f'- {state}: {count}' for state, count in sorted(self.counts.items()))
        (self.directory / 'report.md').write_text('\n'.join(lines) + '\n', encoding='utf-8')


async def observe(port, capture=False, screenshot_path=None):
    def endpoint():
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/json/version', timeout=5) as response:
            return json.load(response)['webSocketDebuggerUrl']
    url = await asyncio.to_thread(endpoint)
    address = urllib.parse.urlparse(url)
    if address.hostname not in ('127.0.0.1', 'localhost', '::1') or address.scheme != 'ws':
        raise RuntimeError('Unexpected local endpoint')
    async with websockets.connect(url, max_size=16 * 1024 * 1024) as ws:
        counter = 0
        async def call(method, params=None, session=None):
            nonlocal counter
            counter += 1
            message = {'id': counter, 'method': method, 'params': params or {}}
            if session:
                message['sessionId'] = session
            await ws.send(json.dumps(message))
            while True:
                result = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))
                if result.get('id') == counter:
                    if 'error' in result:
                        raise RuntimeError('CDP observation unavailable')
                    return result.get('result', {})
        targets = (await call('Target.getTargets'))['targetInfos']
        pages = [t for t in targets if t.get('type') == 'page' and allowed_host(urllib.parse.urlparse(t.get('url', '')).hostname or '')]
        # Prefer the actual ICP+ page over an incidental authentication tab.
        pages.sort(key=lambda t: urllib.parse.urlparse(t.get('url', '')).hostname != 'icp.administracionelectronica.gob.es')
        if not pages:
            return 'no_portal_page', None, None
        target = pages[0]
        host = urllib.parse.urlparse(target['url']).hostname
        sid = (await call('Target.attachToTarget', {'targetId': target['targetId'], 'flatten': True}))['sessionId']
        result = await call('Runtime.evaluate', {'returnByValue': True, 'expression': SNAPSHOT_JS}, sid)
        state = result.get('result', {}).get('value')
        if not isinstance(state, dict):
            raise RuntimeError('No categorical snapshot')
        status = category(state, host)
        evidence = None
        if capture and status == 'potential_availability' and screenshot_path:
            # Preserve the candidate observation even if screenshot capture fails.
            with suppress(Exception):
                shot = await call('Page.captureScreenshot', {'format': 'png', 'fromSurface': True}, sid)
                Path(screenshot_path).write_bytes(base64.b64decode(shot['data']))
                evidence = Path(screenshot_path).name
        with suppress(Exception):
            await call('Target.detachFromTarget', {'sessionId': sid})
        return status, state.get('code'), evidence


async def main(args):
    process = psutil.Process(args.monitor_pid)
    creation = process.create_time()
    journal = Journal(args.output, args.monitor_pid)
    keep_awake = False
    if sys.platform == 'win32':
        # Scoped execution request, released on exit. No power-plan settings change.
        keep_awake = bool(ctypes.windll.kernel32.SetThreadExecutionState(0x80000001))
    try:
        while process.is_running() and process.create_time() == creation:
            try:
                filename = journal.directory / ('potential-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '.png')
                need_evidence = journal.previous != 'potential_availability' or not journal.candidates or not journal.candidates[-1].get('evidence')
                status, code, evidence = await observe(args.port, capture=need_evidence, screenshot_path=filename)
                journal.record(status, code, evidence, keep_awake)
            except Exception:
                # Never persist raw exception messages, target URLs or page text.
                journal.record('observation_unavailable', keep_awake=keep_awake)
            await asyncio.sleep(args.interval)
        journal.record('monitor_stopped', keep_awake=False)
    except psutil.NoSuchProcess:
        journal.record('monitor_stopped', keep_awake=False)
    finally:
        if sys.platform == 'win32' and keep_awake:
            ctypes.windll.kernel32.SetThreadExecutionState(0x80000000)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--monitor-pid', type=int, required=True)
    parser.add_argument('--port', type=int, required=True)
    parser.add_argument('--interval', type=int, default=30)
    parser.add_argument('--output', type=Path, required=True)
    arguments = parser.parse_args()
    if arguments.interval < 10 or not 1 <= arguments.port <= 65535:
        parser.error('Invalid interval or port')
    try:
        asyncio.run(main(arguments))
    except KeyboardInterrupt:
        pass
