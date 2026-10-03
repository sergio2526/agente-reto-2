import type { z } from "zod"
import type { ContextoHerramienta } from "./tipos"

/** Contrato de herramienta del PRD (6.2): description, args (zod) y execute que nunca lanza. */
export interface Herramienta<S extends z.ZodRawShape = z.ZodRawShape> {
  description: string
  args: S
  execute(args: z.infer<z.ZodObject<S>>, ctx: ContextoHerramienta): Promise<string>
}

export function herramienta<S extends z.ZodRawShape>(definicion: Herramienta<S>): Herramienta<S> {
  return definicion
}
