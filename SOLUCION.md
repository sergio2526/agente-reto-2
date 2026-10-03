# SOLUCIÓN — Agente "Registro de Contratos Vigentes"

## 1. Problema en una frase

El maestro de contratos vigentes está congelado desde el 2026-05-30 porque dependía de una persona y solo recibía los contratos con póliza; eso le duele a la **analista administrativa** (no puede mantener el maestro ni seguir pólizas), a la **gerencia** (no sabe qué vence ni qué riesgo tiene) y a la empresa (pólizas exigidas que nadie constituye).

## 2. Arquitectura

```
┌───────────────────────┐  POST /api/chat/stream (SSE)   ┌──────────────────────────────────────────────┐
│ Front (web/)          │ ─────────────────────────────▶ │ Backend Bun (src/server.ts)                  │
│ · historial del chat  │ ◀───────────────────────────── │ · sesiones (memoria + out/sesiones/*.json)   │
│ · tarjeta por tool    │  eventos: estado, herramienta, │ · ciclo del agente (src/agent/ciclo.ts)      │
│ · resalta confirmación│  asistente, error, fin         │   tope de iteraciones, guarda de confirmación│
│ · visor de out/       │                                │ · adaptador LLM (src/llm/adapter.ts)         │
└───────────────────────┘                                │     └─ ProveedorAnthropic (src/llm/anthropic)│
                                                         │ · registro de herramientas (zod → JSON Schema)│
                                                         └──────────────┬───────────────────────────────┘
                                                                        │ execute(args, ctx)
                                                         ┌──────────────▼───────────────────────────────┐
                                                         │ src/tools/contratos.ts (+ lib/)              │
                                                         │ extracción regex · validación RN1–RN5 ·      │
                                                         │ registro/archivo · alertas · log             │
                                                         └───────┬───────────────────────────┬──────────┘
                                                                 │ lectura                   │ escritura
                                                    fixtures/reto-02/ (solo lectura)    out/ (sharepoint, log, alertas)
```

| Pieza | Dónde vive | Qué contiene |
|---|---|---|
| **Comportamiento** (prompt) | `agent/prompt.md` | Rol, reglas no negociables (solo afirmar lo que dio una herramienta, nada dudoso sin confirmación), orden del proceso y formato de respuesta. |
| **Conocimiento** | `src/knowledge/registro-contratos.md` | Esquema del maestro, RN1–RN5, cómo leer la confianza, casos especiales, contenido de las alertas. Se concatena al prompt. |
| **Ejecución** | `src/tools/` | Toda la lógica de negocio determinista. El servidor no conoce reglas de negocio: cambiar una regla no toca `server.ts` ni el ciclo. |

## 3. Ciclo del agente

`src/agent/ciclo.ts → ejecutarTurno()`:

1. Se agrega el mensaje del usuario a la sesión y se incrementa el número de turno.
2. Bucle de hasta `MAX_ITERATIONS` (25): se llama a `llm.enviar(mensajes, herramientas, { sistema })`.
   - Sin llamadas a herramientas → esa es la respuesta final del turno.
   - Con llamadas → cada una se **valida con zod** antes de ejecutar (si falla, el error vuelve al modelo como `tool_result` con `is_error`), pasa por la **guarda de confirmación**, se ejecuta en serie (las herramientas escriben los mismos archivos) y su resultado se emite al front y se guarda en el historial.
3. **Tope (CA1)**: al llegar a 25 iteraciones se adjunta una nota a los últimos resultados y se hace una llamada final con `tool_choice: none`: el modelo responde con lo hecho y lo pendiente.
4. **Topes de costo**: tokens por sesión y tokens globales del proceso; al superarlos el turno se cierra con un mensaje claro, sin llamar al modelo.
5. **Errores (CA5)**: el adaptador traduce errores del SDK (timeout, autenticación, rate limit, red) a `ErrorProveedor` con texto claro; el ciclo lo muestra en el chat, conserva lo ya registrado y deja la sesión usable.

**Confirmación humana (CA3) — se impone en el servidor, no solo en el prompt:**

- Cuando `contratos_validar` devuelve `requiere_revision` no vacío, o `contratos_registrar` responde "requiere revisión", la sesión guarda `pendientes[mensaje_id] = { turno, campos }`.
- `contratos_registrar` con `confirmado: true` solo se ejecuta si ese mensaje tiene un pendiente creado **en un turno anterior**. Si el modelo intenta confirmar en el mismo turno en que se detectó la duda, el ciclo lo rechaza y le indica que termine preguntando.
- Al final de cada turno `needsConfirmation = pendientes no vacío`; el front pinta la respuesta con borde de alerta y una barra "El agente espera tu confirmación para: msg-006 (valor, fecha_fin)".
- Además, `contratos_registrar` re-extrae el documento y compara: si el `contrato` que manda el modelo difiere en cualquier campo de lo extraído, ese campo entra en `requiere_revision`. El modelo puede **proponer**; solo el humano confirma (riesgo de la sección 10 del PRD).

**CA4**: cada llamada se ve en el chat (nombre, argumentos, resultado) y queda en `out/log.jsonl`, incluidas las rechazadas antes de ejecutar (zod o guarda).

## 4. Elección del modelo

- **Proveedor / modelo**: Anthropic, `claude-opus-5-5` con razonamiento adaptativo y `effort: medium` (configurable por `LLM_EFFORT`). Se activa `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`) para que una negativa de los clasificadores de seguridad se reintente en otro modelo dentro de la misma llamada.
- **Modo simulado**: `LLM_PROVIDER=simulado` (o `auto` sin clave) usa `src/llm/simulado.ts`, otra implementación de la misma interfaz que decide con reglas fijas qué herramientas llamar. Permite probar el link y la interfaz completa sin clave ni costo, y demuestra que cambiar de proveedor no toca el ciclo.
- **Por qué**: el trabajo del modelo aquí es orquestar herramientas, respetar reglas duras ("no registres sin confirmar") y redactar tablas claras en español; los valores no los produce el modelo. Opus 5.5 es fuerte en uso de herramientas en paralelo y seguimiento de instrucciones, y su precio ($4 / $20 por millón de tokens de entrada / salida, lectura de caché $0.20) es menor que el de generaciones anteriores de Opus. El adaptador permite bajar a `claude-sonnet-5-5` cambiando solo `LLM_MODEL` si se prioriza costo.
- **Costo estimado por caso** (estimación, no medida — no tuve una clave para medir uso real):
  - Prefijo fijo (prompt + conocimiento + esquemas de herramientas) ≈ 15 000 caracteres ≈ 4 500 tokens, con punto de caché.
  - Un lote de 6 mensajes con llamadas en paralelo ≈ 6–8 iteraciones; el contexto crece hasta ~25–30k tokens → ~100–150k tokens de entrada acumulados (la mayoría lecturas de caché) y ~5–10k de salida.
  - ≈ **US$0,25–0,45 por lote → US$0,05–0,08 por contrato**. Sin paralelismo (una herramienta por iteración, ~20 iteraciones) sube a ~US$0,15 por contrato. El tope `MAX_SESSION_TOKENS` acota el peor caso por sesión.

## 5. Estrategia de extracción

**El modelo no extrae.** La extracción es determinista (`src/tools/lib/extraccion.ts`) y es la única fuente de valores; el modelo orquesta, explica y pregunta.

| Campo | Cómo se encuentra | Confianza |
|---|---|---|
| `id_contrato` | Código `XX-AAAA-N` en la primera línea (en un otrosí, el último código: el contrato modificado). Si no, `No. XX-…` en el cuerpo. | 0.95 / 0.85 |
| Partes | Patrón `RAZÓN SOCIAL, (identificada con) NIT|RUC|RTN número`; se descarta a Periferia (NIT 900123456). La primera restante es el cliente. | — |
| `cliente` | Se busca la misma razón social escrita en mayúsculas/minúsculas en el documento (bloque de firmas). Si no aparece, se normaliza el texto en mayúsculas. | 0.95 / 0.85 |
| `nit_cliente` | Número sin puntos; en NIT se quita el dígito de verificación. | 0.95 |
| `pais` | Tipo y longitud del identificador (NIT→CO, RUC 13→EC, RUC 11→PE, RTN→HN) contrastado con el domicilio de la contraparte. Coinciden → 0.95; solo uno → 0.85; se contradicen → 0.5. | |
| `objeto` | Cláusula `OBJETO.`, quitando la fórmula "EL CONTRATISTA se obliga a…/prestará…"; máx. 200 caracteres. | 0.9 (0.85 si se recorta) |
| `valor`, `moneda` | Cláusula `VALOR` (o "(VALOR)" en un otrosí): `COP $265.000.000`, `USD 120,000.00`, `PEN 520,000.00`. El parser distingue separadores latinos y anglosajones; un formato ambiguo baja a 0.3. Si la cláusula dice "no tiene un valor determinado" → valor 0, `valor_indeterminado`, 0.5; la moneda se toma de la única moneda citada en el documento si es coherente con el país (0.85). Moneda no soportada (p. ej. EUR) → `{ ok: false }`. | 0.95 |
| Fechas | Cláusula `PLAZO`: fecha tras "desde" y tras "hasta" (`primero (1) de agosto de 2026`). Fecha imposible (31 de febrero) → `{ ok: false }`. Solo inicio + "N meses" → fin derivado (0.85). "Contado desde la firma": con fecha de firma completa, inicio 0.85 / fin 0.8; si la firma solo dice "en el mes de agosto de 2026" → inicio día 1 (0.8) y fin = último día del mes de vencimiento (0.5). | 0.95 |
| Póliza | Cláusula `GARANTÍAS` o párrafo que mencione póliza/garantía; tipos por palabra clave (cumplimiento, calidad, salarios y prestaciones, responsabilidad civil, anticipo, estabilidad). Póliza condicional ("cuyo valor supere…") → 0.85 con advertencia. Sin cláusula en un contrato completo → `false` (0.9). | 0.95 |

Campos ausentes: `null` con confianza 0, nunca inventados. **Dónde entra el modelo**: decide el orden de las llamadas, agrupa en paralelo, redacta la tabla por mensaje y la pregunta de confirmación, e interpreta la respuesta del humano para reenviar el contrato con los valores que el humano dictó (que igual pasan por `contratos_validar`/`registrar` y por la guarda de confirmación).

## 6. Regla de gobierno (propuesta de una página)

**Dueño del maestro** (pregunta abierta del PRD): la **analista administrativa** es la dueña operativa (custodia, confirma campos dudosos, cierra alertas); la **gerencia administrativa y financiera** es la responsable final (aprueba la regla, recibe el indicador y resuelve escalamientos). No depende de una persona: el buzón es compartido y tiene suplente designado.

1. **Canal único**: `contratos@periferia-ficticia.com` (buzón compartido, no personal). Lo administra la analista administrativa con un suplente de tesorería. El agente lo lee cada 15 minutos en horario hábil. Ningún otro canal (correo personal, chat) cuenta como "entregado".
2. **Obligación del comercial**:
   - Qué: **todo** contrato firmado por ambas partes, con o sin póliza (PDF con texto, no foto), y todo otrosí, acta de inicio, acta de terminación/liquidación y cesión.
   - Plazo: máximo **3 días hábiles** desde la última firma.
   - Asunto: `[CONTRATO|OTROSI|ACTA] <Cliente> - <Número> - <objeto corto>`; un documento por correo. Para la campaña de reconstrucción: `[MIGRACION] …` (el agente registra esos con `fuente = migracion`).
   - Incumplimiento: el contrato no se habilita en facturación (ver indicador) y se reporta en el comité comercial mensual.
3. **Acuse automático**: en ≤ 15 minutos el agente responde al remitente con: número de radicado (`mensaje_id`), clasificación (nuevo / actualización / duplicado / rechazado), datos extraídos y, si aplica, qué falta o qué quedó en revisión. Copia a la analista cuando hay revisión o rechazo.
4. **Excepciones y escalamiento**:
   - Sin firmar, ilegible o sin contrato (cotizaciones, propuestas): **rechazado** con motivo; vuelve al comercial.
   - Sin valor (por demanda), sin plazo claro o con conflicto con el maestro: queda **en revisión**; la analista confirma en ≤ 2 días hábiles con el comercial.
   - Remitente no registrado en `comerciales.json`: se registra igual y se avisa a la analista para dar de alta al comercial.
   - Escalamiento: comercial → (3 días hábiles sin respuesta) director comercial → (5 días hábiles) gerencia administrativa y financiera.
5. **Cierre del gap (junio–agosto 2026), una sola campaña de 2 semanas**:
   - Semana 1: finanzas extrae del ERP los clientes/órdenes **facturados** de jun–ago 2026 y los cruza con el maestro; sale una lista de faltantes por comercial.
   - Cada comercial reenvía sus contratos faltantes al buzón con asunto `[MIGRACION]`. El agente los procesa igual que cualquier contrato (extracción, revisión, alertas).
   - Semana 2: la analista resuelve revisiones; el director comercial certifica por escrito que su lista quedó completa. Lo que no aparezca se reporta a gerencia como riesgo (servicio facturado sin contrato).
6. **Indicador mensual**: **cobertura del maestro** = contratos con facturación en el mes que existen en el maestro ÷ contratos facturados en el mes. Meta ≥ 95 %. Indicadores de apoyo: mediana de días firma→registro (meta ≤ 3) y % de mensajes que requirieron revisión (debe bajar a medida que el formato se estandariza).

## 7. Decisiones y trade-offs

| Decisión | Alternativa descartada | Por qué |
|---|---|---|
| Extracción 100 % determinista (regex) con confianza explícita; el modelo no produce valores. | Extracción con el LLM (o híbrida con el valor final del modelo). | El PRD exige que el valor registrado salga de la herramienta (riesgo de "redondeo" del modelo). Regex es auditable, gratis y reproducible en `demo.ts`. Costo: plantillas muy distintas bajan la confianza y caen en revisión humana — que es el comportamiento deseado. |
| La guarda de confirmación vive en el servidor (pendientes por turno) y `registrar` re-extrae y compara. | Confiar en que el prompt haga cumplir "no registres sin confirmar". | Un prompt no es un control: un modelo puede saltárselo o ser manipulado por texto del contrato (inyección). Con la guarda, ni un modelo desobediente puede registrar un campo dudoso sin un turno humano de por medio. |
| Ciclo propio sobre un adaptador neutral (`enviar(mensajes, herramientas)`), con el contenido nativo del proveedor guardado en la sesión. | Tool Runner del SDK de Anthropic. | El PRD pide que cambiar de proveedor no toque el ciclo, y necesito controlar cada iteración (guarda, tope, eventos al front, log). Guardar el contenido nativo permite devolver intactos los bloques de razonamiento entre iteraciones. |
| `validar` y `registrar` aceptan `contrato` opcional; los rechazados y duplicados también pasan por `registrar` para quedar en `procesados.json`. | Que los rechazados nunca se marquen, o una herramienta extra "descartar". | Si no se marcan, `leer_buzon` los devuelve siempre y el lote nunca "termina". Reusar `registrar` (sin escribir en el maestro) mantiene el contrato mínimo de 5 herramientas. |
| Un otrosí que amplía `fecha_fin` en un contrato con póliza pasa `estado_poliza` a `pendiente`. | Dejar el estado como estaba. | El propio otrosí de msg-003 dice que las garantías "deberán ampliarse en vigencia". Si no se marca, gerencia no ve que hay que pedir el anexo a la aseguradora. |
| Estado en archivos compartidos (`out/`) y herramientas en serie. | Un `out/` por sesión. | El PRD fija las rutas de `out/` y el maestro es uno solo. Para la demo pública basta con **Reiniciar demo**; en producción el maestro viviría en SharePoint con control de concurrencia. |
| SSE para mostrar herramientas en vivo. | Solo `POST /api/chat` con respuesta completa. | Un lote toma decenas de segundos; ver cada herramienta mientras ocurre es lo que pide el PRD ("mostrar cada llamada") y evita que parezca colgado. `/api/chat` sigue disponible. |

## 8. Supuestos

1. **Fecha de registro**: `contratos_registrar` acepta `hoy` opcional (si el usuario da una fecha, se usa; si no, la del sistema) para que la demo sea determinista.
2. **msg-006**: la firma solo dice "en el mes de agosto de 2026". Se propone inicio 2026-08-01 (0.8) y fin 2027-08-31 = último día del mes de vencimiento (0.5), que es la fecha que el PRD usa en su ejemplo de confirmación. La prórroga automática se reporta como advertencia.
3. **Póliza condicional** (msg-006: solo para órdenes > COP 100 M): se registra `requiere_poliza = true`, estado `pendiente`, con advertencia; ante la duda, que aparezca en las alertas.
4. **Comercial no registrado**: se escribe el correo con el sufijo "(no registrado)" en la columna `comercial`.
5. **Archivo**: los adjuntos son `.txt`, se archivan con su extensión. Un otrosí se archiva como `<id>-otrosi-<mensaje>.txt` en la carpeta del contrato; `ruta_sharepoint` sigue apuntando al contrato base y el historial guarda la ruta del otrosí.
6. **Objeto en actualizaciones**: no se sobrescribe el objeto curado del maestro; RN1 compara solo id, valor y fechas, como dice el PRD.
7. **Otrosí de un contrato que no está en el maestro** → `rechazado` (primero debe llegar el contrato base).
8. **"Registrados desde el corte"** = `fecha_registro ≥ 2026-05-30`. Las actualizaciones por otrosí se listan en una subsección aparte; los contratos con fecha fin ya cumplida van en un anexo (no estaba pedido, pero CT-2025-018 y CT-2026-002 vencieron sin cierre registrado).
9. `id_contrato` ausente no exige revisión: el PRD define el respaldo `AUTO-<año>-<secuencia>`; se informa como advertencia.
10. Errores de HU-6 (texto vacío, fecha inválida, moneda desconocida) se devuelven como `{ ok: false, error }` desde `contratos_extraer`/`validar`.
11. El link puede ser público con `ACCESS_KEY` opcional; el estado es único para todos los visitantes.

## 9. Cobertura

| Historia / requisito | Estado | Evidencia | Qué falta para producción |
|---|---|---|---|
| HU-1 Leer el buzón | Hecho | `contratos_leer_buzon`; msg-005 `tiene_contrato:false`, `rechazado` con motivo. | Conector Exchange/Graph y lectura de PDF reales. |
| HU-2 Extraer con confianza | Hecho | 4 tests de fixtures + 4 de errores; `null`/0 para ausentes. | Más plantillas de contrato; OCR para escaneos; `contratos_leer_pdf` (P1) no implementado. |
| HU-3 Validar y clasificar | Hecho | RN1–RN4, conflictos de identidad, remitente desconocido no bloquea. | Similitud de objeto más robusta (embeddings) si los nombres varían mucho. |
| HU-4 Registrar y archivar | Hecho | Maestro sin duplicados, historial, archivo por año/cliente, `procesados.json`. | Escritura en SharePoint con control de versiones y bloqueo. |
| HU-5 Alertas | Hecho | Tres secciones + anexo de vencidos; `hoy` como argumento. | Envío programado (correo/Teams) a gerencia. |
| HU-6 Errores | Hecho | Herramientas nunca lanzan; errores legibles; el lote sigue. | — |
| CA1–CA5 | Hecho | `tests/ciclo.test.ts` con proveedor guionizado. | Pruebas con el modelo real (ver Uso de IA / limitaciones). |
| Front con tool calls y confirmación resaltada | Hecho | `web/`. | Autenticación real (SSO). |
| `demo.ts` sin modelo | Hecho | `bun run demo.ts`. | — |
| Seguridad / costo | Hecho | Clave solo en backend y redactada; topes de iteraciones y tokens; `ACCESS_KEY`. | Rate limit por IP; gestor de secretos. |
| Link público | Parcial | `render.yaml` + `Dockerfile` listos; funciona en modo simulado sin clave. | Publicarlo desde la cuenta de Render del candidato. |
| Bonus `modulo/` | Hecho | Generado desde las fuentes; `tests/modulo.test.ts` falla si diverge. | Publicarlo como paquete. |

## 10. Uso de IA

- **Claude Code (Claude Opus 5.5)**: analizó el PRD y los fixtures, propuso la arquitectura y escribió el código, las pruebas, el README y este documento, iterando contra el typecheck, `bun test` y `demo.ts`.
- **Lo que se descartó de lo propuesto en el camino**:
  - Usar el Tool Runner del SDK: descartado por el requisito de adaptador propio y por necesitar la guarda de confirmación dentro del ciclo.
  - Que `contratos_extraer` marcara el mensaje rechazado como efecto secundario: descartado; una lectura no debe escribir.
  - Dejar la confirmación solo en el prompt: descartado (ver decisiones).
  - Tomar el día de la firma de msg-006 como "desconocido = null": descartado porque el PRD espera que solo `valor` y `fecha_fin` queden en revisión; se documentó la regla (día 1, confianza 0.8).
- **Limitación honesta**: durante la construcción no había una `ANTHROPIC_API_KEY` disponible. El adaptador está verificado por tipos contra el SDK oficial (`@anthropic-ai/sdk`) y el ciclo con proveedores simulados (guion en tests y el modo simulado del front), pero la conversación real con el modelo debe probarse con la clave propia antes de la defensa.
- _(Completar por el candidato: qué revisó o cambió a mano y cómo validó cada parte.)_

## 11. Riesgos de llevarlo a producción

| Riesgo | Mitigación |
|---|---|
| Contratos escaneados o plantillas nuevas: la regex no encuentra campos. | Lo no encontrado queda con confianza 0 → revisión humana (no datos malos). Añadir OCR y, opcionalmente, un extractor LLM que solo **proponga** con evidencia citada, siempre sometido a la misma validación y confirmación. |
| Inyección de instrucciones en el texto del contrato o del correo. | El texto solo llega al modelo como resultado de herramienta; las escrituras están protegidas por la guarda de confirmación y la re-extracción, y las herramientas no ejecutan shell ni aceptan rutas absolutas. |
| Concurrencia sobre el maestro (varios usuarios o lotes). | Herramientas en serie en el proceso; en producción, SharePoint/lista con ETag o una base transaccional. |
| Costo del link público. | Topes por turno, por sesión y global; `ACCESS_KEY`; modelo configurable a uno más barato. |
| Datos personales y comerciales en contratos y logs. | Logs con resúmenes, no contenido; retención definida; despliegue en la nube corporativa; nada real en el repositorio. |
| Disco efímero en el hosting (se pierde `out/`). | Para la demo es aceptable (Reiniciar demo); en producción el estado vive en SharePoint. |
| Falsos duplicados por variaciones de razón social. | Dedupe por `id_contrato` y por NIT + similitud de objeto, nunca por nombre; comparación de cliente por slug sin sufijos societarios. |
| Que el proceso vuelva a morir por rotación. | Buzón compartido, suplente, regla de gobierno aprobada por gerencia e indicador de cobertura mensual. |
