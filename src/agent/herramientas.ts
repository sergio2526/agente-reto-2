/** Registro de herramientas: cada export de src/tools/<archivo>.ts se publica como <archivo>_<export>. */
import { z } from "zod"
import type { DefinicionHerramienta } from "../llm/adapter"
import * as contratos from "../tools/contratos"
import type { Herramienta } from "../tools/lib/herramienta"

const MODULOS: Record<string, Record<string, Herramienta>> = { contratos }

export interface HerramientaRegistrada {
  nombre: string
  herramienta: Herramienta
  esquema: z.ZodObject<z.ZodRawShape>
}

export type RegistroHerramientas = Map<string, HerramientaRegistrada>

export function crearRegistro(): RegistroHerramientas {
  const registro: RegistroHerramientas = new Map()
  for (const [archivo, modulo] of Object.entries(MODULOS)) {
    for (const [exportado, herramienta] of Object.entries(modulo)) {
      const nombre = `${archivo}_${exportado}`
      registro.set(nombre, { nombre, herramienta, esquema: z.object(herramienta.args) })
    }
  }
  return registro
}

function esquemaJson(esquema: z.ZodObject<z.ZodRawShape>): Record<string, unknown> {
  const { $schema: _omitido, ...resto } = z.toJSONSchema(esquema) as Record<string, unknown>
  return resto
}

export function definiciones(registro: RegistroHerramientas): DefinicionHerramienta[] {
  return [...registro.values()].map((r) => ({
    nombre: r.nombre,
    descripcion: r.herramienta.description,
    esquema: esquemaJson(r.esquema),
  }))
}
