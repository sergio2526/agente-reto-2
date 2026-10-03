import { claveProveedor, config } from "../config"
import { ErrorProveedor, type ProveedorLLM } from "./adapter"
import { ProveedorAnthropic } from "./anthropic"
import { ProveedorSimulado } from "./simulado"

/**
 * Fábrica del proveedor configurado. Añadir otro proveedor = un `case` más.
 * "auto": Anthropic si hay ANTHROPIC_API_KEY; si no, el simulado (sin LLM).
 */
export function crearProveedor(): ProveedorLLM {
  const proveedor = config.proveedor === "auto" ? (claveProveedor() ? "anthropic" : "simulado") : config.proveedor
  switch (proveedor) {
    case "simulado":
      return new ProveedorSimulado()
    case "anthropic": {
      const apiKey = claveProveedor()
      if (!apiKey) throw new ErrorProveedor("Falta ANTHROPIC_API_KEY en el entorno del servidor.", "configuracion")
      return new ProveedorAnthropic({
        apiKey,
        modelo: config.modelo,
        esfuerzo: config.esfuerzo,
        timeoutMs: config.timeoutMs,
        maxTokensSalida: config.maxTokensSalida,
      })
    }
    default:
      throw new ErrorProveedor(`Proveedor LLM no soportado: ${config.proveedor}`, "configuracion")
  }
}
