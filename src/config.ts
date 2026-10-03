/** Configuración leída de variables de entorno (Bun carga .env automáticamente). */
import type { Esfuerzo } from "./llm/anthropic"

function entero(nombre: string, porDefecto: number): number {
  const valor = Number(process.env[nombre])
  return Number.isFinite(valor) && valor > 0 ? Math.floor(valor) : porDefecto
}

function texto(nombre: string, porDefecto: string): string {
  return process.env[nombre]?.trim() || porDefecto
}

const ESFUERZOS: Esfuerzo[] = ["low", "medium", "high", "xhigh", "max"]

function esfuerzo(): Esfuerzo {
  const valor = texto("LLM_EFFORT", "medium") as Esfuerzo
  return ESFUERZOS.includes(valor) ? valor : "medium"
}

export const config = {
  puerto: entero("PORT", 3004),
  proveedor: texto("LLM_PROVIDER", "auto"),
  modelo: texto("LLM_MODEL", "claude-opus-5-5"),
  esfuerzo: esfuerzo(),
  timeoutMs: entero("LLM_TIMEOUT_MS", 120_000),
  maxTokensSalida: entero("LLM_MAX_OUTPUT_TOKENS", 16_000),
  maxIteraciones: entero("MAX_ITERATIONS", 25),
  maxTokensSesion: entero("MAX_SESSION_TOKENS", 1_500_000),
  maxTokensGlobal: entero("MAX_GLOBAL_TOKENS", 20_000_000),
  claveAcceso: process.env.ACCESS_KEY?.trim() ?? "",
} as const

/** La clave del proveedor solo se lee aquí y nunca sale del backend. */
export function claveProveedor(): string {
  return process.env.ANTHROPIC_API_KEY?.trim() ?? ""
}
