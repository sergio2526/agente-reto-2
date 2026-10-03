import { cpSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ContextoHerramienta } from "../src/tools/lib/tipos"

export const RAIZ = join(import.meta.dir, "..")

/** Proyecto aislado en un directorio temporal con una copia de los fixtures. */
export function proyectoTemporal(): ContextoHerramienta {
  const dir = mkdtempSync(join(tmpdir(), "reto02-"))
  cpSync(join(RAIZ, "fixtures"), join(dir, "fixtures"), { recursive: true })
  return { directory: dir, sessionId: "test" }
}

export function textoFixture(mensaje: string, archivo: string): string {
  return readFileSync(join(RAIZ, "fixtures/reto-02/buzon", mensaje, archivo), "utf8")
}

export type Respuesta<T> = { ok: true; data: T } | { ok: false; error: string }

export function leer<T>(json: string): Respuesta<T> {
  return JSON.parse(json) as Respuesta<T>
}

export function datos<T>(json: string): T {
  const r = leer<T>(json)
  if (!r.ok) throw new Error(r.error)
  return r.data
}
