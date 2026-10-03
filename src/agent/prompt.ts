import { readFileSync } from "node:fs"
import { join } from "node:path"

export const RUTA_PROMPT = "agent/prompt.md"
export const RUTA_CONOCIMIENTO = "src/knowledge/registro-contratos.md"

/** System prompt = comportamiento (agent/prompt.md) + conocimiento (src/knowledge/). */
export function construirSistema(raiz: string, hoy: string): string {
  const comportamiento = readFileSync(join(raiz, RUTA_PROMPT), "utf8").trim()
  const conocimiento = readFileSync(join(raiz, RUTA_CONOCIMIENTO), "utf8").trim()
  return `${comportamiento}\n\n<conocimiento_del_proceso>\n${conocimiento}\n</conocimiento_del_proceso>\n\nFecha del sistema: ${hoy}.`
}
