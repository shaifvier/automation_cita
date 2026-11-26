# Monitor ICP+ — Autorización de regreso (Barcelona)

Monitor de disponibilidad con Node.js + Playwright. Ofrece Firefox, Chrome normal
y Chrome lanzado por SeleniumBase y conectado por CDP. **No reserva citas**:
se detiene ante una pantalla reconocible de selección de oficina/fecha/hora,
emite un aviso de Windows y deja la ventana para que una persona continúe.
Una pantalla desconocida produce un aviso de revisión distinto.

La detección real de disponibilidad sigue siendo experimental. Una respuesta
«no hay citas», incluidos los códigos 0017/0501, no demuestra por sí sola ni la
ausencia de citas ni un bloqueo por automatización. Véase
[el informe de investigación](docs/browser-research.md).

## Preparación (Windows, sesión de escritorio abierta)

Requisitos: Node >=20.12, Python 3.12 y Google Chrome instalado.

```powershell
npm ci
npx playwright install firefox
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-lock.txt
Copy-Item .env.example .env
```

Edita **solo `.env`**, que Git ignora. Sustituye `CITA_NIE` y `CITA_NOMBRE`.
Para `CITA_PYTHON`, usa la ruta a `.venv/Scripts/python.exe` de tu clon.
No publiques ese archivo ni pegues datos privados en issues o conversaciones.

```powershell
# Verificar que Windows muestra el aviso (sin consultar el portal):
node .\cita-regreso.cjs --probar-aviso

# Una consulta con SeleniumBase, sin Cl@ve:
node --env-file=.env .\cita-regreso.cjs --browser=seleniumbase --una-consulta

# Monitor periódico con certificado, cualquier oficina de Barcelona:
node --env-file=.env .\cita-regreso.cjs --browser=seleniumbase --certificado --solo-cualquiera

# Diagnóstico público: llega al formulario sin rellenar ni enviar NIE/nombre:
node .\cita-regreso.cjs --browser=chrome --diagnostico
```

Firefox sigue siendo el navegador predeterminado. `--browser=chrome` usa Chrome
lanzado por Playwright; `--browser=seleniumbase` usa un perfil independiente y
un helper de Python local. No se usa el perfil personal de Chrome.

## Certificado

`--certificado` conserva la configuración existente de PEM, clave privada
**cifrada** y archivo de contraseña. Configura en `.env`:

- `CITA_CERT_PEM`: ruta al certificado PEM.
- `CITA_KEY_PEM`: ruta a la clave PEM cifrada.
- `CITA_CERT_PASS_FILE`: ruta al archivo de contraseña.

Se presentan únicamente a `https://pasarela-ident.clave.gob.es`. Los valores
predeterminados son `cert.pem`, `key.pem` y `.p12pass` junto al script. No se
importan certificados en Windows ni se cambian políticas de Chrome. Si falla
Cl@ve, se solicita revisión; no se cambia automáticamente a la ruta sin Cl@ve.
La validación TLS permanece activa en el monitor.

## Funcionamiento y opciones

- Pausa predeterminada de **120 s** entre consultas completadas; mínimo de 85 s,
  incluso al cambiar de ronda u oficina. `--pausa=SEGUNDOS` permite aumentarla.
- `Retry-After` puede prolongar cualquier espera. Tras tres fallos consecutivos
  (rechazo o error temporal), entra en una pausa de **15 min** y hace una sola
  consulta de prueba en la misma sesión. Si sigue bloqueado, espera **30 min**,
  luego **60 min**; las siguientes pausas siguen en 60 min. Un `Retry-After` más
  largo siempre prevalece. No se borran cookies ni caché ni se recrea el navegador.
- Una consulta normal tras la pausa reanuda automáticamente la vigilancia y
  reinicia la progresión de pausas. Windows recibe avisos al pausar y al recuperar
  el servicio; la consola registra `enfriamiento`/`reanudado`, `waitSeconds` y
  `retryAt` (UTC). La fecha indica el momento más temprano previsto para reintentar.
- Cerrar la ventana o pulsar Ctrl+C interrumpe la pausa inmediatamente. CAPTCHA
  no resuelto o página desconocida siguen requiriendo revisión.
  `--una-consulta`, `--max-consultas` y el límite de investigación siguen vigentes:
  no se hacen reintentos fuera de esos límites.
- Si ICP+ indica que la solicitud ha caducado por inactividad, se inicia de nuevo
  el flujo desde Barcelona, con la misma oficina, identidad y autenticación,
  tras la pausa normal (o un `Retry-After` mayor). Se conservan el navegador,
  las cookies y el estado de los bloqueos anteriores. Se permiten **dos reinicios**
  sin completar una consulta normal; una tercera caducidad requiere revisión.
  La consola conserva `sesión caducada` como diagnóstico y añade el motivo
  `session_restart_scheduled` o `session_restart_limit`. Windows avisa del
  reinicio programado y de la recuperación. Una consulta normal restablece el límite.
- `--solo-cualquiera` consulta únicamente «Cualquier oficina». Sin esa opción,
  recorre oficinas e intercala «Cualquier oficina» cada cinco oficinas.
- `--desde=OFICINA` reanuda desde una coincidencia única. Combinado con
  `--una-consulta`, consulta únicamente esa oficina.
- `--max-consultas=N` limita el número de intentos; incluye fallos de apertura.
  `--una-consulta` equivale a un intento y no reintenta fallos.
- `--diagnostico` hace un intento por defecto y no lee datos del solicitante;
  admite `--max-consultas=N` para repetir el diagnóstico público.
- `--red` añade metadatos de navegación sin URLs, cuerpos, cabeceras ni cookies.
- SeleniumBase intenta su manejador de CAPTCHA una vez por episodio. Un proceso
  separado limita la ejecución a 55 s y termina antes de la entrega al usuario.
  La página se vuelve a clasificar: que el método termine no prueba que haya
  resuelto el desafío. Si no puede continuar, avisa y se detiene.
- Una posible disponibilidad, pantalla desconocida o caducidad repetida detiene
  la automatización. El aviso suena cada 20 s durante hasta 10 min; la ventana
  y el contexto permanecen abiertos hasta que la persona los cierre.
- Windows puede ocultar avisos por su configuración o modo de concentración.
  El pitido y el mensaje de consola sirven como aviso adicional.

La salida JSON contiene hora UTC, navegador, autenticación, oficina, etapa,
HTTP, resultado, código de respuesta y motivo enumerado de revisión. No guarda texto de página, datos del
solicitante ni material del certificado. `artifacts/` contiene únicamente
caché local de oficinas y, si ejecutas la investigación, registros sanitizados;
Git ignora esa carpeta. Las oficinas sin trámite se revisan cada diez rondas.

## Pruebas y comparación reproducible

```powershell
npm test
npm run test:browser
.\.venv\Scripts\python.exe -m unittest discover -s test -p test_bridge.py

# Comparación real: Firefox/Chrome/SeleniumBase, con y sin certificado.
# Una consulta por combinación, secuencial y con >=120 s entre consultas:
node --env-file=.env .\scripts\research.cjs --repeticiones=1

# Prueba periódica real: tres consultas SeleniumBase con certificado:
node --env-file=.env .\scripts\research.cjs --humo
```

La comparación admite `--repeticiones=2` (predeterminado), limita el trabajo
automático a 45 min entre consultas y se detiene tras cualquier entrega al
usuario. No la ejecutes en paralelo con otro monitor. Compara manualmente el
mismo trámite, oficina, solicitante y autenticación en un Chrome normal, sin
seleccionar ni reservar una cita.

Las pruebas de navegador usan exclusivamente fixtures locales y una identidad
sintética. La prueba mTLS genera certificados sintéticos temporales; solo esa
prueba acepta el certificado de servidor autofirmado. Requiere OpenSSL en
`C:/Strawberry/c/bin/openssl.exe` o la variable `OPENSSL` con la ruta correspondiente.

## Observador de larga duracion (sin reiniciar el monitor)

`watch_monitor.py` puede observar por CDP el Chrome de un monitor SeleniumBase ya
abierto. Se le pasan el PID de Node y el puerto CDP de ese navegador. No navega,
no rellena formularios, no cambia cookies ni realiza consultas al portal.

```powershell
.\.venv\Scripts\python.exe scripts/watch_monitor.py --monitor-pid PID_NODE --port PUERTO_CDP --output artifacts/overnight
```

Cada 30 s escribe `observations.jsonl`, `status.json` y `report.md`. Los tiempos
legibles usan Europe/Madrid. Son muestras del estado del navegador, no recuentos
de consultas ni pruebas de la hora exacta de apertura de una cita. Una pantalla
con posibles opciones de cita se conserva como captura PNG privada para revision.
El monitor principal sigue gestionando los avisos de Windows y la entrega manual.
El informe marca intervalos de mas de 90 s sin observaciones y distingue un
monitor detenido de uno activo; no permite concluir nada sobre citas en esos huecos.

El observador puede ejecutarse como proceso independiente del chat. En Windows
mantiene una solicitud temporal para evitar la suspension automatica mientras
observa; no cambia el plan de energia y libera la solicitud al terminar. No evita
un apagado, la suspension manual ni el cierre de la tapa. Mantener el equipo
encendido y conectado a corriente sigue siendo necesario. Termina cuando sale
el PID original del monitor. Puede reiniciarse conservando el historial local.

Todo el directorio `artifacts/` queda fuera de Git. Las capturas pueden contener
datos del solicitante: son evidencia privada y no se deben publicar. El observador
no incorpora revision humana/IA continua ni avisos externos por correo/telefono.
