/**
 * API HTTP + front estático. Un solo proceso: `bun run dev`.
 *   POST /api/chat           { sessionId, message } → { reply, toolCalls, needsConfirmation, pendientes }
 *   POST /api/chat/stream    igual, como Server-Sent Events
 *   GET  /api/sessions/:id   historial visible de la sesión
 *   GET  /api/health         { ok, provider, model }
 *   GET  /api/archivos/:f    alertas.md, maestro-contratos.csv, historial.jsonl, log.jsonl, procesados.json
 *   POST /api/reset          borra out/ (estado de la demo)
 */
import { rmSync } from "node:fs"
import { join } from "node:path"
import { ejecutarTurno, type Dependencias, type ResultadoTurno } from "./agent/ciclo"
import { crearRegistro } from "./agent/herramientas"
import { construirSistema } from "./agent/prompt"
import { AlmacenSesiones, ID_SESION } from "./agent/sesiones"
import { claveProveedor, config } from "./config"
import { ErrorProveedor, type ProveedorLLM } from "./llm/adapter"
import { crearProveedor } from "./llm"

const RAIZ = join(import.meta.dir, "..")
const almacen = new AlmacenSesiones(join(RAIZ, "out", "sesiones"))
const registro = crearRegistro()
const ocupadas = new Set<string>()
let tokensGlobales = 0

const ESTATICOS: Record<string, { archivo: string; tipo: string }> = {
  "/": { archivo: "web/index.html", tipo: "text/html; charset=utf-8" },
  "/app.js": { archivo: "web/app.js", tipo: "text/javascript; charset=utf-8" },
  "/styles.css": { archivo: "web/styles.css", tipo: "text/css; charset=utf-8" },
}

const ARCHIVOS: Record<string, { ruta: string; tipo: string }> = {
  "alertas.md": { ruta: "out/alertas.md", tipo: "text/markdown; charset=utf-8" },
  "maestro-contratos.csv": { ruta: "out/sharepoint/maestro-contratos.csv", tipo: "text/csv; charset=utf-8" },
  "historial.jsonl": { ruta: "out/sharepoint/historial.jsonl", tipo: "text/plain; charset=utf-8" },
  "log.jsonl": { ruta: "out/log.jsonl", tipo: "text/plain; charset=utf-8" },
  "procesados.json": { ruta: "out/procesados.json", tipo: "application/json; charset=utf-8" },
}

// ───────────────────────── utilidades ─────────────────────────

/** Ningún texto que salga del servidor puede contener la clave del proveedor. */
function redactar(texto: string): string {
  const clave = claveProveedor()
  return clave ? texto.split(clave).join("[redactado]") : texto
}

function json(cuerpo: unknown, estado = 200): Response {
  return new Response(redactar(JSON.stringify(cuerpo)), {
    status: estado,
    headers: { "content-type": "application/json; charset=utf-8" },
  })
}

function autorizado(req: Request): boolean {
  if (!config.claveAcceso) return true
  return req.headers.get("x-access-key") === config.claveAcceso
}

function proveedorSeguro(): ProveedorLLM | ErrorProveedor {
  try {
    return crearProveedor()
  } catch (e) {
    return e instanceof ErrorProveedor ? e : new ErrorProveedor("No se pudo iniciar el proveedor.", "configuracion")
  }
}

function dependencias(llm: ProveedorLLM, alEvento?: Dependencias["alEvento"]): Dependencias {
  return {
    llm,
    registro,
    sistema: construirSistema(RAIZ, new Date().toISOString().slice(0, 10)),
    directorio: RAIZ,
    limites: { maxIteraciones: config.maxIteraciones, maxTokensSesion: config.maxTokensSesion },
    hayPresupuesto: () => tokensGlobales < config.maxTokensGlobal,
    consumir: (n) => {
      tokensGlobales += n
    },
    alEvento,
  }
}

interface PeticionChat {
  sessionId: string
  message: string
}

async function leerPeticion(req: Request): Promise<PeticionChat | string> {
  const cuerpo = (await req.json().catch(() => null)) as Partial<PeticionChat> | null
  if (!cuerpo || typeof cuerpo.sessionId !== "string" || !ID_SESION.test(cuerpo.sessionId)) return "sessionId inválido"
  if (typeof cuerpo.message !== "string" || !cuerpo.message.trim()) return "message vacío"
  if (cuerpo.message.length > 4000) return "message demasiado largo (máx. 4000 caracteres)"
  return { sessionId: cuerpo.sessionId, message: cuerpo.message.trim() }
}

/** Ejecuta un turno con exclusión por sesión y persistencia al final. */
async function turno(p: PeticionChat, alEvento?: Dependencias["alEvento"]): Promise<ResultadoTurno | Response> {
  if (ocupadas.has(p.sessionId)) return json({ error: "La sesión ya está procesando un mensaje." }, 409)
  const llm = proveedorSeguro()
  if (llm instanceof ErrorProveedor) return json({ error: llm.message }, 503)
  ocupadas.add(p.sessionId)
  const sesion = almacen.obtener(p.sessionId)
  try {
    return await ejecutarTurno(sesion, p.message, dependencias(llm, alEvento))
  } finally {
    almacen.guardar(sesion)
    ocupadas.delete(p.sessionId)
  }
}

// ───────────────────────── rutas ─────────────────────────

async function chat(req: Request): Promise<Response> {
  const p = await leerPeticion(req)
  if (typeof p === "string") return json({ error: p }, 400)
  const r = await turno(p)
  return r instanceof Response ? r : json(r)
}

function chatStream(req: Request): Response {
  const codificador = new TextEncoder()
  const flujo = new ReadableStream<Uint8Array>({
    async start(control) {
      const enviar = (evento: string, datos: unknown) =>
        control.enqueue(codificador.encode(`event: ${evento}\ndata: ${redactar(JSON.stringify(datos))}\n\n`))
      const p = await leerPeticion(req)
      if (typeof p === "string") {
        enviar("error", { texto: p })
      } else {
        const r = await turno(p, (e) => enviar(e.tipo, e))
        if (r instanceof Response) enviar("error", { texto: ((await r.json()) as { error: string }).error })
        else enviar("fin", r)
      }
      control.close()
    },
  })
  return new Response(flujo, {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" },
  })
}

function sesion(id: string): Response {
  if (!ID_SESION.test(id) || !almacen.existe(id)) return json({ error: "sesión no encontrada" }, 404)
  const { mensajes: _internos, ...visible } = almacen.obtener(id)
  return json(visible)
}

async function archivo(nombre: string): Promise<Response> {
  const permitido = ARCHIVOS[nombre]
  if (!permitido) return json({ error: "archivo no disponible" }, 404)
  const f = Bun.file(join(RAIZ, permitido.ruta))
  if (!(await f.exists())) return json({ error: "aún no se ha generado; procesa el buzón primero" }, 404)
  return new Response(f, { headers: { "content-type": permitido.tipo } })
}

function reset(): Response {
  if (ocupadas.size > 0) return json({ error: "hay un turno en curso; intenta en unos segundos" }, 409)
  rmSync(join(RAIZ, "out"), { recursive: true, force: true })
  almacen.limpiar()
  return json({ ok: true })
}

async function enrutar(req: Request): Promise<Response> {
  const { pathname } = new URL(req.url)
  const estatico = ESTATICOS[pathname]
  if (req.method === "GET" && estatico) {
    return new Response(Bun.file(join(RAIZ, estatico.archivo)), { headers: { "content-type": estatico.tipo } })
  }
  if (pathname === "/api/health") {
    const llm = proveedorSeguro()
    const activo = llm instanceof ErrorProveedor ? { provider: config.proveedor, model: config.modelo, error: llm.message } : { provider: llm.proveedor, model: llm.modelo }
    return json({ ok: true, ...activo, accessKeyRequired: Boolean(config.claveAcceso) })
  }
  if (!pathname.startsWith("/api/")) return new Response("No encontrado", { status: 404 })
  if (!autorizado(req)) return json({ error: "clave de acceso inválida" }, 401)
  if (req.method === "POST" && pathname === "/api/chat") return chat(req)
  if (req.method === "POST" && pathname === "/api/chat/stream") return chatStream(req)
  if (req.method === "POST" && pathname === "/api/reset") return reset()
  const id = /^\/api\/sessions\/([^/]+)$/.exec(pathname)?.[1]
  if (req.method === "GET" && id) return sesion(id)
  const nombre = /^\/api\/archivos\/([^/]+)$/.exec(pathname)?.[1]
  if (req.method === "GET" && nombre) return archivo(nombre)
  return json({ error: "ruta no encontrada" }, 404)
}

const servidor = Bun.serve({
  port: config.puerto,
  idleTimeout: 255, // un turno con varias herramientas puede tardar minutos
  async fetch(req) {
    try {
      return await enrutar(req)
    } catch {
      return json({ error: "error interno del servidor" }, 500)
    }
  },
})

const inicial = proveedorSeguro()
const modo = inicial instanceof ErrorProveedor ? `sin proveedor (${inicial.message})` : `${inicial.proveedor}/${inicial.modelo}`
console.log(`Agente de contratos en http://localhost:${servidor.port} · ${modo}`)
