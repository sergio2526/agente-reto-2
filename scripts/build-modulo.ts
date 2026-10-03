/**
 * Genera modulo/ a partir de las MISMAS fuentes que usa la aplicación:
 *   agent/prompt.md                  → modulo/agent.md
 *   src/tools/** (contratos + lib)   → modulo/tools/**
 *   src/knowledge/registro-contratos.md → modulo/skill/registro-contratos/SKILL.md
 * tests/modulo.test.ts falla si modulo/ diverge de las fuentes.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"

const RAIZ = join(import.meta.dir, "..")

const FRONTMATTER_AGENTE = `---
description: Registra contratos vigentes desde el buzón único — extrae, clasifica (nuevo, actualización, duplicado, rechazado), pide confirmación humana para campos dudosos, archiva y genera alertas de vencimiento y pólizas.
mode: primary
permission:
  edit: deny
  bash: deny
---

`

const FRONTMATTER_SKILL = `---
name: registro-contratos
description: Conocimiento del proceso de registro de contratos vigentes de Periferia — esquema del maestro, reglas RN1–RN5, lectura de la confianza por campo, casos especiales (contrato marco, otrosí, póliza condicional) y contenido del reporte de alertas. Úsala al procesar el buzón de contratos o al responder dudas sobre el maestro.
---

`

function archivosTs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const ruta = join(dir, e.name)
    if (e.isDirectory()) return archivosTs(ruta)
    return e.name.endsWith(".ts") ? [ruta] : []
  })
}

function leer(relativa: string): string {
  return readFileSync(join(RAIZ, relativa), "utf8")
}

/** Contenido esperado de cada archivo de modulo/, por ruta relativa. */
export function generarModulo(): Record<string, string> {
  const salida: Record<string, string> = {
    "modulo/agent.md": FRONTMATTER_AGENTE + leer("agent/prompt.md"),
    "modulo/skill/registro-contratos/SKILL.md": FRONTMATTER_SKILL + leer("src/knowledge/registro-contratos.md"),
  }
  const herramientas = join(RAIZ, "src/tools")
  for (const archivo of archivosTs(herramientas)) {
    const rel = relative(herramientas, archivo).split("\\").join("/")
    salida[`modulo/tools/${rel}`] = readFileSync(archivo, "utf8")
  }
  return salida
}

if (import.meta.main) {
  rmSync(join(RAIZ, "modulo/tools"), { recursive: true, force: true })
  for (const [rel, contenido] of Object.entries(generarModulo())) {
    const destino = join(RAIZ, rel)
    mkdirSync(dirname(destino), { recursive: true })
    writeFileSync(destino, contenido, "utf8")
    console.log(`✔ ${rel}`)
  }
}
