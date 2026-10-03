import Anthropic from "@anthropic-ai/sdk"
import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaMessageParam,
  BetaTool,
  BetaToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/beta/messages/messages"
import {
  ErrorProveedor,
  type DefinicionHerramienta,
  type MensajeLLM,
  type MotivoFin,
  type OpcionesEnvio,
  type ProveedorLLM,
  type RespuestaLLM,
} from "./adapter"

export type Esfuerzo = "low" | "medium" | "high" | "xhigh" | "max"

export interface ConfigAnthropic {
  apiKey: string
  modelo: string
  esfuerzo: Esfuerzo
  timeoutMs: number
  maxTokensSalida: number
}

const BETA_FALLBACK = "server-side-fallback-2026-07-01"

function aContenido(m: Extract<MensajeLLM, { rol: "asistente" }>): BetaContentBlockParam[] {
  if (Array.isArray(m.nativo)) return m.nativo as BetaContentBlockParam[]
  const bloques: BetaContentBlockParam[] = []
  if (m.texto) bloques.push({ type: "text", text: m.texto })
  for (const l of m.llamadas) bloques.push({ type: "tool_use", id: l.id, name: l.nombre, input: l.argumentos })
  return bloques.length ? bloques : [{ type: "text", text: "(sin respuesta)" }]
}

function aMensaje(m: MensajeLLM): BetaMessageParam {
  if (m.rol === "usuario") return { role: "user", content: m.texto }
  if (m.rol === "asistente") return { role: "assistant", content: aContenido(m) }
  const resultados: BetaToolResultBlockParam[] = m.resultados.map((r) => ({
    type: "tool_result",
    tool_use_id: r.id,
    content: r.contenido,
    is_error: r.esError,
  }))
  const nota: BetaContentBlockParam[] = m.nota ? [{ type: "text", text: m.nota }] : []
  return { role: "user", content: [...resultados, ...nota] }
}

function aHerramientas(defs: DefinicionHerramienta[]): BetaTool[] {
  return defs.map((d, i) => ({
    name: d.nombre,
    description: d.descripcion,
    input_schema: d.esquema as BetaTool.InputSchema,
    // Un punto de caché al final de las herramientas: tools + system quedan en caché.
    ...(i === defs.length - 1 ? { cache_control: { type: "ephemeral" as const } } : {}),
  }))
}

function motivo(stop: string | null): MotivoFin {
  if (stop === "end_turn") return "fin_turno"
  if (stop === "tool_use") return "herramientas"
  if (stop === "max_tokens") return "limite_tokens"
  if (stop === "refusal") return "rechazo"
  return "otro"
}

function aRespuesta(content: BetaContentBlock[], stop: string | null, entrada: number, salida: number): RespuestaLLM {
  const texto = content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim()
  const llamadas = content.flatMap((b) =>
    b.type === "tool_use" ? [{ id: b.id, nombre: b.name, argumentos: b.input }] : [],
  )
  return { texto, llamadas, nativo: content, uso: { entrada, salida }, fin: motivo(stop) }
}

/** Traduce errores del SDK a mensajes claros; nunca incluye cabeceras ni la clave. */
function traducirError(e: unknown, timeoutMs: number): ErrorProveedor {
  if (e instanceof Anthropic.APIConnectionTimeoutError) {
    return new ErrorProveedor(`El modelo no respondió en ${Math.round(timeoutMs / 1000)} s. Intenta de nuevo.`, "timeout")
  }
  if (e instanceof Anthropic.AuthenticationError) {
    return new ErrorProveedor("La clave del proveedor no es válida o no está configurada en el servidor.", "autenticacion")
  }
  if (e instanceof Anthropic.RateLimitError) {
    return new ErrorProveedor("El proveedor limitó las solicitudes por ahora. Espera un momento y reintenta.", "limite")
  }
  if (e instanceof Anthropic.APIConnectionError) {
    return new ErrorProveedor("No hay conexión con el proveedor del modelo.", "red")
  }
  if (e instanceof Anthropic.APIError) {
    return new ErrorProveedor(`El proveedor devolvió un error (HTTP ${e.status ?? "?"}).`, "proveedor")
  }
  return new ErrorProveedor("Error inesperado al llamar al modelo.", "proveedor")
}

export class ProveedorAnthropic implements ProveedorLLM {
  readonly proveedor = "anthropic"
  readonly modelo: string
  private readonly cliente: Anthropic

  constructor(private readonly config: ConfigAnthropic) {
    this.modelo = config.modelo
    this.cliente = new Anthropic({ apiKey: config.apiKey, timeout: config.timeoutMs, maxRetries: 1 })
  }

  async enviar(mensajes: MensajeLLM[], herramientas: DefinicionHerramienta[], op: OpcionesEnvio): Promise<RespuestaLLM> {
    try {
      const r = await this.cliente.beta.messages.create({
        model: this.modelo,
        max_tokens: this.config.maxTokensSalida,
        system: [{ type: "text", text: op.sistema, cache_control: { type: "ephemeral" } }],
        messages: mensajes.map(aMensaje),
        tools: aHerramientas(herramientas),
        tool_choice: op.permitirHerramientas ? { type: "auto" } : { type: "none" },
        thinking: { type: "adaptive" },
        output_config: { effort: this.config.esfuerzo },
        betas: [BETA_FALLBACK],
        fallbacks: "default",
      })
      return aRespuesta(r.content, r.stop_reason, r.usage.input_tokens + (r.usage.cache_read_input_tokens ?? 0) + (r.usage.cache_creation_input_tokens ?? 0), r.usage.output_tokens)
    } catch (e) {
      throw traducirError(e, this.config.timeoutMs)
    }
  }
}
