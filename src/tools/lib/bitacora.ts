import { RUTAS, agregarLinea, leerTexto, existe } from "./rutas"
import { ErrorNegocio, type ContextoHerramienta, type Resultado } from "./tipos"

export interface EntradaLog {
  herramienta: string
  mensaje_id: string | null
  ok: boolean
  resumen: string
}

/** RN7: cada llamada a herramienta deja una línea en out/log.jsonl. */
export function registrarLog(ctx: ContextoHerramienta, entrada: EntradaLog): void {
  agregarLinea(ctx, RUTAS.log, { ts: new Date().toISOString(), sesion: ctx.sessionId, ...entrada })
}

export interface Cambio {
  antes: string | null
  despues: string
}

export interface EntradaHistorial {
  id_contrato: string
  accion: "alta" | "actualizacion"
  cambios: Record<string, Cambio>
  mensaje_id: string
  fecha: string
  documento: string
}

export function agregarHistorial(ctx: ContextoHerramienta, entrada: EntradaHistorial): void {
  agregarLinea(ctx, RUTAS.historial, { ts: new Date().toISOString(), ...entrada })
}

export function leerHistorial(ctx: ContextoHerramienta): EntradaHistorial[] {
  if (!existe(ctx, RUTAS.historial)) return []
  return leerTexto(ctx, RUTAS.historial)
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as EntradaHistorial)
}

function mensajeDeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * Envoltura común de toda herramienta: nunca lanza, siempre deja log
 * y devuelve el JSON `{ ok, data }` o `{ ok, error }`.
 */
export function ejecutarSeguro<T>(
  ctx: ContextoHerramienta,
  herramienta: string,
  mensajeId: string | null,
  accion: () => Resultado<T>,
  resumir: (data: T) => string,
): string {
  let resultado: Resultado<T>
  try {
    resultado = accion()
  } catch (e) {
    const error = e instanceof ErrorNegocio ? e.message : `error interno en ${herramienta}: ${mensajeDeError(e)}`
    resultado = { ok: false, error }
  }
  const resumen = resultado.ok ? resumir(resultado.data) : resultado.error
  try {
    registrarLog(ctx, { herramienta, mensaje_id: mensajeId, ok: resultado.ok, resumen })
  } catch {
    // Un fallo al escribir el log no debe tumbar la herramienta.
  }
  return JSON.stringify(resultado)
}
