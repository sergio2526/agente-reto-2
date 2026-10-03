/**
 * Ciclo del agente: prompt → modelo → herramientas → modelo … → respuesta.
 * Reglas CA1–CA5 del PRD: tope de iteraciones, confirmación humana entre turnos,
 * toda llamada visible y registrada, y errores que no matan la sesión.
 */
import { z } from "zod"
import { ErrorProveedor, type LlamadaHerramienta, type MensajeLLM, type ProveedorLLM, type ResultadoHerramienta } from "../llm/adapter"
import { registrarLog } from "../tools/lib/bitacora"
import { definiciones, type RegistroHerramientas } from "./herramientas"
import type { EventoChat, Sesion } from "./sesiones"

export interface Limites {
  maxIteraciones: number
  maxTokensSesion: number
}

export interface Dependencias {
  llm: ProveedorLLM
  registro: RegistroHerramientas
  sistema: string
  directorio: string
  limites: Limites
  /** Devuelve false si el presupuesto global de tokens se agotó. */
  hayPresupuesto: () => boolean
  consumir: (tokens: number) => void
  alEvento?: (evento: EventoChat | { tipo: "estado"; texto: string }) => void
}

export interface ResultadoTurno {
  reply: string
  toolCalls: Extract<EventoChat, { tipo: "herramienta" }>[]
  needsConfirmation: boolean
  pendientes: Record<string, string[]>
  tokens: Sesion["tokens"]
}

type EventoHerramienta = Extract<EventoChat, { tipo: "herramienta" }>
type Respuesta = { ok: true; data: unknown } | { ok: false; error: string }

const ahora = () => new Date().toISOString()

// Las herramientas escriben en los mismos archivos: se ejecutan en serie entre sesiones.
let cola: Promise<unknown> = Promise.resolve()
function enSerie<T>(fn: () => Promise<T>): Promise<T> {
  const resultado = cola.then(fn)
  cola = resultado.catch(() => undefined)
  return resultado
}

// ───────────────────────── confirmación humana (CA3) ─────────────────────────

function mensajeDe(args: unknown): string | null {
  const id = (args as { mensaje_id?: unknown } | null)?.mensaje_id
  return typeof id === "string" ? id : null
}

function confirmacionInvalida(sesion: Sesion, nombre: string, args: unknown): string | null {
  if (nombre !== "contratos_registrar" || (args as { confirmado?: unknown }).confirmado !== true) return null
  const id = mensajeDe(args) ?? ""
  const pendiente = sesion.pendientes[id]
  if (pendiente && pendiente.turno < sesion.turno) return null
  return `confirmado=true rechazado para ${id}: el usuario aún no ha confirmado los campos en revisión en un turno posterior a la pregunta. Termina el turno mostrando los campos y preguntando.`
}

function actualizarPendientes(sesion: Sesion, nombre: string, args: unknown, r: Respuesta): void {
  const id = mensajeDe(args)
  if (!id) return
  const marcar = (campos: string[]) => {
    sesion.pendientes[id] ??= { turno: sesion.turno, campos }
    sesion.pendientes[id].campos = campos
  }
  if (nombre === "contratos_validar" && r.ok) {
    const v = r.data as { clasificacion: string; requiere_revision: string[] }
    if (v.requiere_revision.length && ["nuevo", "actualizacion"].includes(v.clasificacion)) marcar(v.requiere_revision)
  }
  if (nombre === "contratos_registrar") {
    if (r.ok) delete sesion.pendientes[id]
    else {
      const campos = /^requiere revisión: ([^.]+)\./.exec(r.error)?.[1]
      if (campos) marcar(campos.split(",").map((c) => c.trim()))
    }
  }
}

// ───────────────────────── ejecución de herramientas ─────────────────────────

function resumir(r: Respuesta): string {
  if (!r.ok) return r.error
  const d = (r.data ?? {}) as Record<string, unknown>
  const partes: string[] = []
  if (Array.isArray(d.mensajes)) partes.push(`${d.mensajes.length} mensajes`)
  for (const clave of ["tipo_documento", "clasificacion", "accion", "id_contrato", "cliente", "ruta"]) {
    if (typeof d[clave] === "string") partes.push(d[clave] as string)
  }
  if (Array.isArray(d.requiere_revision) && d.requiere_revision.length) partes.push(`revisión: ${d.requiere_revision.join(", ")}`)
  return partes.join(" · ") || "ok"
}

async function ejecutarLlamada(sesion: Sesion, llamada: LlamadaHerramienta, deps: Dependencias): Promise<Respuesta> {
  const registrada = deps.registro.get(llamada.nombre)
  if (!registrada) return { ok: false, error: `herramienta desconocida: ${llamada.nombre}` }
  const args = registrada.esquema.safeParse(llamada.argumentos ?? {})
  if (!args.success) return { ok: false, error: `argumentos inválidos: ${z.prettifyError(args.error)}` }
  const bloqueo = confirmacionInvalida(sesion, llamada.nombre, args.data)
  if (bloqueo) return { ok: false, error: bloqueo }
  const ctx = { directory: deps.directorio, sessionId: sesion.id }
  const texto = await enSerie(() => registrada.herramienta.execute(args.data, ctx))
  return JSON.parse(texto) as Respuesta
}

/** Errores previos a execute (validación, guardas) también quedan en out/log.jsonl (CA4). */
function registrarRechazoPrevio(sesion: Sesion, llamada: LlamadaHerramienta, r: Respuesta, deps: Dependencias): void {
  if (r.ok || !(r.error.startsWith("argumentos inválidos") || r.error.startsWith("confirmado=true") || r.error.startsWith("herramienta desconocida"))) return
  try {
    registrarLog({ directory: deps.directorio, sessionId: sesion.id }, {
      herramienta: llamada.nombre,
      mensaje_id: mensajeDe(llamada.argumentos),
      ok: false,
      resumen: r.error,
    })
  } catch {
    // el log no debe tumbar el turno
  }
}

async function correrHerramientas(sesion: Sesion, llamadas: LlamadaHerramienta[], deps: Dependencias) {
  const resultados: ResultadoHerramienta[] = []
  const eventos: EventoHerramienta[] = []
  for (const llamada of llamadas) {
    deps.alEvento?.({ tipo: "estado", texto: `Ejecutando ${llamada.nombre}…` })
    const r = await ejecutarLlamada(sesion, llamada, deps)
    registrarRechazoPrevio(sesion, llamada, r, deps)
    actualizarPendientes(sesion, llamada.nombre, llamada.argumentos, r)
    const evento: EventoHerramienta = {
      tipo: "herramienta",
      id: llamada.id,
      nombre: llamada.nombre,
      argumentos: llamada.argumentos,
      ok: r.ok,
      resumen: resumir(r),
      resultado: r.ok ? r.data : r.error,
      ts: ahora(),
    }
    eventos.push(evento)
    emitir(sesion, evento, deps)
    resultados.push({ id: llamada.id, nombre: llamada.nombre, contenido: JSON.stringify(r), esError: !r.ok })
  }
  return { resultados, eventos }
}

// ───────────────────────── turno ─────────────────────────

function emitir(sesion: Sesion, evento: EventoChat, deps: Dependencias): void {
  sesion.eventos.push(evento)
  deps.alEvento?.(evento)
}

function tokensSesion(sesion: Sesion): number {
  return sesion.tokens.entrada + sesion.tokens.salida
}

function sinPresupuesto(sesion: Sesion, deps: Dependencias): string | null {
  if (tokensSesion(sesion) >= deps.limites.maxTokensSesion) {
    return `Se alcanzó el tope de tokens de esta sesión (${deps.limites.maxTokensSesion}). Abre una sesión nueva para continuar.`
  }
  if (!deps.hayPresupuesto()) return "Se agotó el presupuesto global de tokens del servidor. Intenta más tarde."
  return null
}

async function llamarModelo(sesion: Sesion, deps: Dependencias, permitirHerramientas: boolean) {
  const respuesta = await deps.llm.enviar(sesion.mensajes, definiciones(deps.registro), {
    sistema: deps.sistema,
    permitirHerramientas,
  })
  sesion.tokens.entrada += respuesta.uso.entrada
  sesion.tokens.salida += respuesta.uso.salida
  deps.consumir(respuesta.uso.entrada + respuesta.uso.salida)
  sesion.mensajes.push({ rol: "asistente", texto: respuesta.texto, llamadas: respuesta.llamadas, nativo: respuesta.nativo })
  if (respuesta.fin === "rechazo" && !respuesta.texto) {
    respuesta.texto = "El modelo declinó responder esta solicitud. Reformúlala o procesa el mensaje manualmente."
  }
  return respuesta
}

function cerrar(sesion: Sesion, texto: string, llamadas: EventoHerramienta[], deps: Dependencias): ResultadoTurno {
  const pendientes = Object.fromEntries(Object.entries(sesion.pendientes).map(([id, p]) => [id, p.campos]))
  const needsConfirmation = Object.keys(pendientes).length > 0
  emitir(sesion, { tipo: "asistente", texto, final: true, necesitaConfirmacion: needsConfirmation, ts: ahora() }, deps)
  return { reply: texto, toolCalls: llamadas, needsConfirmation, pendientes, tokens: sesion.tokens }
}

function fallar(sesion: Sesion, e: unknown, llamadas: EventoHerramienta[], deps: Dependencias): ResultadoTurno {
  const texto = e instanceof ErrorProveedor ? e.message : "Error inesperado en el ciclo del agente."
  emitir(sesion, { tipo: "error", texto, ts: ahora() }, deps)
  // Mantiene la alternancia usuario/asistente para que la sesión siga siendo usable (CA5).
  sesion.mensajes.push({ rol: "asistente", texto: `(turno interrumpido: ${texto})`, llamadas: [] })
  return cerrar(sesion, `⚠️ ${texto} Lo ya registrado se conserva; puedes pedirme que continúe.`, llamadas, deps)
}

export async function ejecutarTurno(sesion: Sesion, textoUsuario: string, deps: Dependencias): Promise<ResultadoTurno> {
  sesion.turno += 1
  emitir(sesion, { tipo: "usuario", texto: textoUsuario, ts: ahora() }, deps)
  sesion.mensajes.push({ rol: "usuario", texto: textoUsuario })
  const llamadas: EventoHerramienta[] = []
  try {
    for (let i = 1; i <= deps.limites.maxIteraciones; i++) {
      const agotado = sinPresupuesto(sesion, deps)
      if (agotado) return cerrar(sesion, agotado, llamadas, deps)
      deps.alEvento?.({ tipo: "estado", texto: `Pensando (iteración ${i}/${deps.limites.maxIteraciones})…` })
      const r = await llamarModelo(sesion, deps, true)
      if (r.llamadas.length === 0) return cerrar(sesion, r.texto, llamadas, deps)
      if (r.texto) emitir(sesion, { tipo: "asistente", texto: r.texto, final: false, necesitaConfirmacion: false, ts: ahora() }, deps)
      const { resultados, eventos } = await correrHerramientas(sesion, r.llamadas, deps)
      llamadas.push(...eventos)
      sesion.mensajes.push({ rol: "herramientas", resultados })
    }
    return await cerrarPorTope(sesion, llamadas, deps)
  } catch (e) {
    return fallar(sesion, e, llamadas, deps)
  }
}

/** CA1: al llegar al tope, el modelo responde sin herramientas con lo hecho y lo pendiente. */
async function cerrarPorTope(sesion: Sesion, llamadas: EventoHerramienta[], deps: Dependencias): Promise<ResultadoTurno> {
  const ultimo = sesion.mensajes.at(-1)
  if (ultimo?.rol === "herramientas") {
    ultimo.nota = `Se alcanzó el tope de ${deps.limites.maxIteraciones} iteraciones de este turno. No llames más herramientas: resume lo que quedó hecho y lo que falta.`
  }
  const r = await llamarModelo(sesion, deps, false)
  return cerrar(sesion, r.texto || "Alcancé el tope de iteraciones de este turno.", llamadas, deps)
}
