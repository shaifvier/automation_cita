# Monitor de cita ICP+ — Autorización de regreso (Barcelona)

Script de Node.js + Playwright (Firefox) que consulta periódicamente el portal de
cita previa de extranjería (ICP+) para el trámite **«AUTORIZACIÓN DE REGRESO»** en la
provincia de Barcelona y avisa (pitido + ventana abierta) si aparece una pantalla
distinta de «no hay citas». **No reserva**: la reserva la termina una persona.

## Conclusión importante

ICP+ detecta que el navegador está automatizado y le responde **«no hay citas»
(códigos 0017 / 0501) aunque haya citas disponibles**. Se comprobó en la provincia de
Lleida: en Chrome normal aparecía el paso «Selecciona Oficina» con hueco, y en el
navegador del script, incluso manejado a mano, «no hay citas» (0501).

Por tanto **este monitor no puede detectar citas** tal como está, y no se ha intentado
ocultar la automatización (sería eludir el filtro anti-bots del portal). La forma
fiable es consultar a mano en un navegador normal.

## Qué hace

- Abre el selector de Barcelona, elige oficina («Cualquier oficina» o todas una a una),
  el trámite y entra por «Presentación sin Cl@ve» o «con Cl@ve» (certificado).
- Rellena NIE y nombre (de variables de entorno), envía y clasifica la respuesta:
  sin citas (con su código), sin trámite, rechazo (403/429/«Request Rejected»),
  sesión caducada, fallo temporal, CAPTCHA o pantalla a revisar.
- Respeta los límites del portal: pausa adaptativa entre consultas (85–150 s) que sube
  con cada 429, y espera de 60 s → 120 s → 300 s tras rechazos o fallos.
- No guarda datos personales en disco; la salida se redacta.

## Uso

```powershell
npm install
npx playwright install firefox

$env:CITA_NIE = 'X0000000X'          # NIE del solicitante
$env:CITA_NOMBRE = 'NOMBRE APELLIDO'

# Sin certificado, todas las comisarías:
node .\cita-regreso.cjs --red

# Con certificado (Cl@ve), solo «Cualquier oficina»:
node .\cita-regreso.cjs --red --certificado --solo-cualquiera --pausa=110
```

Opciones: `--red` (traza de navegación sin datos personales), `--certificado`,
`--solo-cualquiera`, `--desde=OFICINA`, `--pausa=SEGUNDOS`, `--diagnostico`
(comprueba el formulario sin enviar datos).

### Certificado (opcional)

Para `--certificado` hacen falta, junto al script (o en las rutas indicadas por
`CITA_CERT_PEM`, `CITA_KEY_PEM`, `CITA_CERT_PASS_FILE`):

- `cert.pem`: certificado del titular.
- `key.pem`: clave privada **cifrada** (AES-256).
- `.p12pass`: contraseña de la clave.

Conversión desde un `.p12` de la FNMT (cifrado antiguo RC2/3DES):

```bash
openssl pkcs12 -legacy -in cert.p12 -clcerts -nokeys -out cert.pem
openssl pkcs12 -legacy -in cert.p12 -nocerts -aes256 -out key.pem
```

Estos archivos están en `.gitignore` y **no deben subirse nunca**.

## Notas técnicas

- El servidor de ICP+ no envía el certificado intermedio (RapidSSL TLS RSA CA G1);
  Firefox se lanza con `security.enterprise_roots.enabled` para usar el almacén de
  Windows. La validación TLS sigue activa.
- `sin-tramite.json` guarda las comisarías que no ofrecen el trámite; se revisan cada
  10 rondas.
