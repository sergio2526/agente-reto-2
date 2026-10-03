/** Modo simulado: la conversación de la sección 11 del PRD de punta a punta, sin LLM. */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { ejecutarTurno, type Dependencias } from "../src/agent/ciclo"
import { crearRegistro } from "../src/agent/herramientas"
import { AlmacenSesiones } from "../src/agent/sesiones"
import { ProveedorSimulado } from "../src/llm/simulado"
import { parsearCsv } from "../src/tools/lib/csv"
import { proyectoTemporal } from "./ayuda"

const PROMPT_PRD =
  "Procesa el buzón de contratos con fecha de hoy 2026-09-03. Registra lo que esté limpio, muéstrame lo que requiere revisión campo por campo y termina con el reporte de alertas. No registres nada dudoso sin preguntarme."

describe("proveedor simulado", () => {
  test("procesa el buzón, pide confirmación de msg-006 y la registra en el turno siguiente", async () => {
    const ctx = proyectoTemporal()
    const sesion = new AlmacenSesiones(join(ctx.directory, "out/sesiones")).obtener("sim")
    const deps: Dependencias = {
      llm: new ProveedorSimulado(),
      registro: crearRegistro(),
      sistema: "",
      directorio: ctx.directory,
      limites: { maxIteraciones: 25, maxTokensSesion: 1_000_000 },
      hayPresupuesto: () => true,
      consumir: () => undefined,
    }

    const t1 = await ejecutarTurno(sesion, PROMPT_PRD, deps)
    expect(t1.needsConfirmation).toBe(true)
    expect(t1.pendientes).toEqual({ "msg-006": ["valor", "fecha_fin"] })
    expect(t1.reply).toContain("¿Confirmas para msg-006 el valor 0 y la fecha fin 2027-08-31?")
    expect(t1.toolCalls.map((t) => t.nombre)).toContain("contratos_alertas")

    const t2 = await ejecutarTurno(sesion, "confirmo el valor 0 y la fecha fin 2027-08-31", deps)
    expect(t2.needsConfirmation).toBe(false)
    expect(t2.toolCalls[0]).toMatchObject({ nombre: "contratos_registrar", ok: true })
    expect(t2.reply).toContain("Alertas al 2026-09-03")

    const filas = parsearCsv(readFileSync(join(ctx.directory, "out/sharepoint/maestro-contratos.csv"), "utf8"))
    expect(filas.find((f) => f.id_contrato === "CM-2026-03")).toMatchObject({ valor: "0", fecha_fin: "2027-08-31", fecha_registro: "2026-09-03" })
  })

  test("sin intención reconocible responde con ayuda", async () => {
    const r = await new ProveedorSimulado().enviar([{ rol: "usuario", texto: "hola" }], [])
    expect(r.llamadas).toHaveLength(0)
    expect(r.texto).toContain("modo simulado")
  })
})
