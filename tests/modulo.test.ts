import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { generarModulo } from "../scripts/build-modulo"
import * as moduloTools from "../modulo/tools/contratos"
import * as appTools from "../src/tools/contratos"
import { RAIZ } from "./ayuda"

describe("modulo/ empaqueta las mismas piezas que la aplicación", () => {
  test("cada archivo de modulo/ coincide con su fuente (ejecuta `bun run modulo` si falla)", () => {
    for (const [rel, esperado] of Object.entries(generarModulo())) {
      const ruta = join(RAIZ, rel)
      expect(existsSync(ruta)).toBe(true)
      expect(readFileSync(ruta, "utf8")).toBe(esperado)
    }
  })

  test("las herramientas del módulo se importan sin el servidor y exponen el mismo contrato", () => {
    expect(Object.keys(moduloTools).sort()).toEqual(Object.keys(appTools).sort())
    for (const [nombre, h] of Object.entries(moduloTools)) {
      expect(h.description).toBe(appTools[nombre as keyof typeof appTools].description)
      expect(typeof h.execute).toBe("function")
    }
  })
})
