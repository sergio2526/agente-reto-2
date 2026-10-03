# Agente conversacional — Registro de Contratos Vigentes (Reto 02)

Agente que actúa como **punto único de recepción** del buzón de contratos: lee los correos, extrae los datos del contrato, detecta duplicados y otrosíes, archiva en una estructura tipo SharePoint, alimenta el maestro, pide confirmación humana para lo dudoso y genera alertas de vencimientos y pólizas.

- Backend y herramientas: **TypeScript sobre Bun**, herramientas tipadas con **zod**.
- Modelo: **Anthropic `claude-opus-5-5`** detrás de un adaptador propio (`src/llm/adapter.ts`).
- Front: HTML + JS sin framework, servido por el mismo proceso.
- Planteamiento, decisiones y regla de gobierno: [`SOLUCION.md`](./SOLUCION.md).

## Levantar en local (un comando)

Requisitos: [Bun](https://bun.sh) ≥ 1.1.

```bash
cp .env.example .env      # y escribe tu ANTHROPIC_API_KEY
bun install && bun run dev
```

Abre <http://localhost:3004>. Botón de ejemplo en la pantalla inicial = prompt de la sección 11 del PRD.

Con Docker: `docker compose up --build` (lee `.env`).

Sin `ANTHROPIC_API_KEY` el servidor arranca en **modo simulado** (ver abajo).

## Modo simulado (chat web sin LLM)

Para probar el chat web completo sin clave ni costo:

```bash
LLM_PROVIDER=simulado bun run dev
```

(o simplemente `bun run dev` sin `ANTHROPIC_API_KEY`: con `LLM_PROVIDER=auto`, el valor por defecto, se activa solo).

El proveedor simulado (`src/llm/simulado.ts`) implementa la misma interfaz `ProveedorLLM` que Anthropic, pero decide con reglas fijas qué herramientas llamar. Pasa por el mismo ciclo, las mismas herramientas, la misma validación zod y la misma guarda de confirmación. La insignia superior del front muestra **"modo simulado · sin LLM"**. Entiende tres instrucciones:

| Escribe | Qué hace |
|---|---|
| `Procesa el buzón de contratos con fecha de hoy 2026-09-03…` (botón de ejemplo) | leer → extraer → validar → registrar lo limpio → alertas; tabla por mensaje y pregunta de confirmación de msg-006. |
| `confirmo el valor 0 y la fecha fin 2027-08-31` | Registra msg-006 con `confirmado: true` y regenera las alertas. |
| `Genera las alertas al 2026-09-03` | Solo el reporte de alertas. |

Sirve para probar el producto y la interfaz; la comprensión de lenguaje libre requiere el modelo real.

## Variables de entorno

| Variable | Obligatoria | Por defecto | Uso |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Solo para el modelo real | — | Clave del proveedor. Solo la lee el backend; nunca se envía al front ni se escribe en logs (se redacta en cualquier respuesta). |
| `LLM_PROVIDER` | No | `auto` | `auto` (Anthropic si hay clave; si no, simulado), `anthropic` o `simulado`. |
| `LLM_MODEL` | No | `claude-opus-5-5` | Modelo. |
| `LLM_EFFORT` | No | `medium` | Esfuerzo de razonamiento (`low`…`max`). |
| `LLM_TIMEOUT_MS` | No | `120000` | Timeout por llamada al proveedor. |
| `LLM_MAX_OUTPUT_TOKENS` | No | `16000` | Tope de salida por llamada. |
| `MAX_ITERATIONS` | No | `25` | Tope de iteraciones modelo↔herramientas por turno (CA1). |
| `MAX_SESSION_TOKENS` | No | `1500000` | Tope de tokens por sesión. |
| `MAX_GLOBAL_TOKENS` | No | `20000000` | Tope de tokens del proceso (protege la clave en el link público). |
| `ACCESS_KEY` | No | vacío | Si se define, el front la pide y la API exige la cabecera `x-access-key`. |
| `PORT` | No | `3004` | Puerto HTTP (en Render se usa el que asigna la plataforma). |

## Demo sin modelo

```bash
bun install && bun run demo.ts
```

Limpia `out/`, procesa los 6 mensajes en orden llamando directamente a las herramientas (extraer → validar → registrar), muestra que `msg-006` queda **sin registrar** en la primera pasada, hace una segunda llamada con `confirmado: true` (valor 0, fecha fin 2027-08-31), genera `out/alertas.md` e imprime la tabla resumen. No necesita clave.

Otros comandos:

| Comando | Qué hace |
|---|---|
| `bun test` | 26 pruebas: extracción, flujo completo, ciclo del agente (CA1, CA3, CA5), modo simulado y sincronía de `modulo/`. |
| `bun run typecheck` | `tsc --noEmit` en modo estricto. |
| `bun run check` | typecheck + tests + demo. |
| `bun run modulo` | Regenera `modulo/` desde las fuentes de la app. |

## Salidas (`out/`, se crea en ejecución)

| Ruta | Contenido |
|---|---|
| `out/sharepoint/maestro-contratos.csv` | Copia de trabajo del maestro (el fixture nunca se modifica). |
| `out/sharepoint/Contratos/<año>/<cliente>/<id>.txt` | Documentos archivados. Los otrosíes como `<id>-otrosi-<mensaje>.txt`. |
| `out/sharepoint/historial.jsonl` | `{ ts, id_contrato, accion, cambios, mensaje_id, fecha, documento }` por alta o actualización. |
| `out/procesados.json` | Mensajes ya procesados y su resultado. |
| `out/log.jsonl` | `{ ts, herramienta, mensaje_id, ok, resumen }` por cada llamada a herramienta. |
| `out/alertas.md` | Reporte de vencimientos, pólizas y gap cubierto. |
| `out/sesiones/<id>.json` | Sesiones del chat. |

## API

| Método | Ruta | Cuerpo / respuesta |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId, message }` → `{ reply, toolCalls[], needsConfirmation, pendientes, tokens }` |
| `POST` | `/api/chat/stream` | Igual, como Server-Sent Events: `estado`, `herramienta`, `asistente`, `error`, `fin` (lo usa el front). |
| `GET` | `/api/sessions/:id` | Historial visible de la sesión (eventos, pendientes, tokens). |
| `GET` | `/api/health` | `{ ok, provider, model, accessKeyRequired }` — nunca expone claves. |
| `GET` | `/api/archivos/:nombre` | `alertas.md`, `maestro-contratos.csv`, `historial.jsonl`, `log.jsonl`, `procesados.json`. |
| `POST` | `/api/reset` | Borra `out/` y las sesiones (vuelve al buzón inicial para repetir la demo). |

Con `ACCESS_KEY` definida, todas las rutas `/api/*` salvo `/api/health` exigen la cabecera `x-access-key`.

## Link de prueba (Render)

> URL: `________________` · Clave de acceso: `________________`

Despliegue con `render.yaml` (Docker, plan free):

1. Sube la carpeta `agente-reto-2` a un repositorio de GitHub (sin `node_modules/`, `out/` ni `.env`; ya están en `.gitignore`).
2. En <https://dashboard.render.com>: **New → Blueprint**, conecta el repositorio y acepta el servicio `agente-registro-contratos`.
3. En **Environment** del servicio define:
   - `ACCESS_KEY`: una clave para el link (recomendado si es público).
   - `ANTHROPIC_API_KEY`: **opcional**. Sin ella el servicio corre en modo simulado; con ella usa el modelo real (no hace falta redesplegar el código, solo reiniciar).
4. Espera el build y abre `https://<servicio>.onrender.com`. `GET /api/health` muestra qué proveedor está activo.
5. Antes de cada demo pulsa **Reiniciar demo** para volver al buzón inicial.

Notas del plan free de Render: el servicio se duerme tras ~15 min sin tráfico (el primer acceso tarda ~1 min) y el disco es efímero, así que `out/` se borra en cada redespliegue o reinicio. Para la demo es lo deseable.

## Estructura

```
agent/prompt.md                    comportamiento (system prompt)
src/knowledge/registro-contratos.md   conocimiento del proceso
src/tools/contratos.ts             herramientas (ejecución) → contratos_<export>
src/tools/lib/                     extracción, validación, registro, alertas, CSV, rutas
src/agent/                         ciclo del agente, registro de herramientas, sesiones, prompt
src/llm/                           adaptador neutral + Anthropic + simulado (sin LLM)
src/server.ts                      API HTTP + estáticos
web/                               front de chat
demo.ts                            herramientas sin modelo
modulo/                            bonus: agente empaquetado (generado desde las fuentes)
tests/                             pruebas
fixtures/reto-02/                  fixtures del reto (solo lectura)
```
