/**
 * Interfaz neutral del proveedor de lenguaje. El ciclo del agente solo conoce estos tipos:
 * cambiar de proveedor = escribir otra implementación de ProveedorLLM.
 */

export interface LlamadaHerramienta {
  id: string
  nombre: string
  argumentos: unknown
}

export interface ResultadoHerramienta {
  id: string
  nombre: string
  contenido: string
  esError: boolean
}

export type MensajeLLM =
  | { rol: "usuario"; texto: string }
  | {
      rol: "asistente"
      texto: string
      llamadas: LlamadaHerramienta[]
      /** Contenido original del proveedor (p. ej. bloques de razonamiento) para reenviarlo intacto. */
      nativo?: unknown
    }
  | { rol: "herramientas"; resultados: ResultadoHerramienta[]; nota?: string }

export interface DefinicionHerramienta {
  nombre: string
  descripcion: string
  /** JSON Schema del objeto de argumentos. */
  esquema: Record<string, unknown>
}

export interface OpcionesEnvio {
  sistema: string
  /** false = el modelo debe responder con texto, sin llamar herramientas. */
  permitirHerramientas: boolean
}

export type MotivoFin = "fin_turno" | "herramientas" | "limite_tokens" | "rechazo" | "otro"

export interface RespuestaLLM {
  texto: string
  llamadas: LlamadaHerramienta[]
  nativo: unknown
  uso: { entrada: number; salida: number }
  fin: MotivoFin
}

export interface ProveedorLLM {
  readonly proveedor: string
  readonly modelo: string
  enviar(mensajes: MensajeLLM[], herramientas: DefinicionHerramienta[], opciones: OpcionesEnvio): Promise<RespuestaLLM>
}

export type TipoErrorProveedor = "configuracion" | "timeout" | "autenticacion" | "limite" | "red" | "proveedor"

/** Error del proveedor ya traducido a lenguaje claro y sin datos sensibles. */
export class ErrorProveedor extends Error {
  constructor(
    message: string,
    readonly tipo: TipoErrorProveedor,
  ) {
    super(message)
  }
}
