/** Sesiones en memoria con respaldo en out/sesiones/<id>.json. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { MensajeLLM } from "../llm/adapter"

export type EventoChat =
  | { tipo: "usuario"; texto: string; ts: string }
  | { tipo: "asistente"; texto: string; final: boolean; necesitaConfirmacion: boolean; ts: string }
  | {
      tipo: "herramienta"
      id: string
      nombre: string
      argumentos: unknown
      ok: boolean
      resumen: string
      resultado: unknown
      ts: string
    }
  | { tipo: "error"; texto: string; ts: string }

export interface Pendiente {
  /** Turno en el que se pidió la revisión: la confirmación solo vale en un turno posterior. */
  turno: number
  campos: string[]
}

export interface Sesion {
  id: string
  creada: string
  turno: number
  mensajes: MensajeLLM[]
  eventos: EventoChat[]
  pendientes: Record<string, Pendiente>
  tokens: { entrada: number; salida: number }
}

export const ID_SESION = /^[a-zA-Z0-9_-]{1,64}$/

export class AlmacenSesiones {
  private readonly sesiones = new Map<string, Sesion>()

  constructor(private readonly carpeta: string) {}

  obtener(id: string): Sesion {
    const enMemoria = this.sesiones.get(id)
    if (enMemoria) return enMemoria
    const sesion = this.leerDisco(id) ?? this.nueva(id)
    this.sesiones.set(id, sesion)
    return sesion
  }

  existe(id: string): boolean {
    return this.sesiones.has(id) || existsSync(this.archivo(id))
  }

  guardar(sesion: Sesion): void {
    mkdirSync(this.carpeta, { recursive: true })
    writeFileSync(this.archivo(sesion.id), JSON.stringify(sesion), "utf8")
  }

  limpiar(): void {
    this.sesiones.clear()
  }

  private nueva(id: string): Sesion {
    return { id, creada: new Date().toISOString(), turno: 0, mensajes: [], eventos: [], pendientes: {}, tokens: { entrada: 0, salida: 0 } }
  }

  private archivo(id: string): string {
    return join(this.carpeta, `${id}.json`)
  }

  private leerDisco(id: string): Sesion | null {
    if (!existsSync(this.archivo(id))) return null
    return JSON.parse(readFileSync(this.archivo(id), "utf8")) as Sesion
  }
}
