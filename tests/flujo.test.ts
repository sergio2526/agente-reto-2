import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import * as contratos from "../src/tools/contratos"
import { parsearCsv } from "../src/tools/lib/csv"
import type { Contrato } from "../src/tools/lib/tipos"
import { RAIZ, datos, leer, proyectoTemporal } from "./ayuda"

const HOY = "2026-09-03"

describe("flujo completo de herramientas sobre el buzón", async () => {
  const ctx = proyectoTemporal()
  const leerOut = (rel: string) => readFileSync(join(ctx.directory, rel), "utf8")
  const resultados: Record<string, { clasificacion: string; registro: ReturnType<typeof leer> }> = {}

  const buzon = datos<{ mensajes: { id: string; tiene_contrato: boolean; clasificacion?: string }[] }>(
    await contratos.leer_buzon.execute({}, ctx),
  )
  for (const m of buzon.mensajes) {
    const ext = leer<Contrato>(await contratos.extraer.execute({ mensaje_id: m.id }, ctx))
    const contrato = ext.ok ? ext.data : undefined
    const v = datos<{ clasificacion: string }>(await contratos.validar.execute({ mensaje_id: m.id, contrato }, ctx))
    const registro = leer(await contratos.registrar.execute({ mensaje_id: m.id, contrato, hoy: HOY }, ctx))
    resultados[m.id] = { clasificacion: v.clasificacion, registro }
  }

  test("HU-1: lista 6 mensajes y marca la cotización sin contrato", () => {
    expect(buzon.mensajes).toHaveLength(6)
    expect(buzon.mensajes.find((m) => m.id === "msg-005")).toMatchObject({ tiene_contrato: false, clasificacion: "rechazado" })
  })

  test("clasificaciones esperadas (sección 7.4)", () => {
    const clasif = Object.fromEntries(Object.entries(resultados).map(([id, r]) => [id, r.clasificacion]))
    expect(clasif).toEqual({
      "msg-001": "nuevo",
      "msg-002": "nuevo",
      "msg-003": "actualizacion",
      "msg-004": "duplicado",
      "msg-005": "rechazado",
      "msg-006": "nuevo",
    })
  })

  test("RN5: msg-006 no se registra sin confirmación", () => {
    const r = resultados["msg-006"]!.registro
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toStartWith("requiere revisión: valor, fecha_fin")
  })

  test("O2: sin duplicados, otrosí modifica la fila y queda historial", () => {
    const filas = parsearCsv(leerOut("out/sharepoint/maestro-contratos.csv"))
    const ids = filas.map((f) => f.id_contrato)
    expect(new Set(ids).size).toBe(ids.length)
    expect(filas).toHaveLength(10)
    expect(filas.find((f) => f.id_contrato === "CT-2026-011")).toMatchObject({ fecha_fin: "2027-11-01", valor: "520000", estado_poliza: "pendiente" })
    expect(filas.find((f) => f.id_contrato === "CT-2026-015")).toMatchObject({ estado_poliza: "pendiente" })
    expect(filas.find((f) => f.id_contrato === "CT-2026-016")).toMatchObject({ estado_poliza: "no_aplica" })
    const historial = leerOut("out/sharepoint/historial.jsonl").trim().split("\n").map((l) => JSON.parse(l))
    const otrosi = historial.find((h) => h.accion === "actualizacion")
    expect(otrosi).toMatchObject({ id_contrato: "CT-2026-011", mensaje_id: "msg-003" })
    expect(otrosi.cambios.fecha_fin).toEqual({ antes: "2027-05-01", despues: "2027-11-01" })
  })

  test("el modelo no puede colar un valor distinto sin confirmación", async () => {
    const original = datos<Contrato>(await contratos.extraer.execute({ mensaje_id: "msg-006" }, ctx))
    const v = datos<{ requiere_revision: string[] }>(
      await contratos.validar.execute({ mensaje_id: "msg-006", contrato: { ...original, cliente: "Otro S.A.S." } }, ctx),
    )
    expect(v.requiere_revision).toContain("cliente")
  })

  test("con confirmado=true msg-006 queda registrado y el lote termina", async () => {
    const original = datos<Contrato>(await contratos.extraer.execute({ mensaje_id: "msg-006" }, ctx))
    const r = datos<{ accion: string; id_contrato: string }>(
      await contratos.registrar.execute(
        { mensaje_id: "msg-006", contrato: { ...original, valor: 0, fecha_fin: "2027-08-31" }, confirmado: true, hoy: HOY },
        ctx,
      ),
    )
    expect(r).toMatchObject({ accion: "alta", id_contrato: "CM-2026-03" })
    expect(datos<{ mensajes: unknown[] }>(await contratos.leer_buzon.execute({}, ctx)).mensajes).toHaveLength(0)
  })

  test("HU-5: alertas con las tres secciones", async () => {
    const a = datos<{ vencen: { id_contrato: string }[]; polizas_pendientes: { id_contrato: string }[]; registrados_desde_corte: { id_contrato: string }[] }>(
      await contratos.alertas.execute({ hoy: HOY }, ctx),
    )
    expect(a.vencen.map((v) => v.id_contrato)).toEqual(["CT-2026-009", "CT-2026-004"])
    expect(a.polizas_pendientes.map((p) => p.id_contrato)).toEqual(["CT-2026-004", "CT-2026-011", "CT-2026-015", "CM-2026-03"])
    expect(a.registrados_desde_corte.map((r) => r.id_contrato)).toEqual(["CT-2026-015", "CT-2026-016", "CM-2026-03"])
    const md = leerOut("out/alertas.md")
    for (const seccion of ["vencen en ≤ 60 días", "Pólizas exigidas", "registrados desde el 2026-05-30"]) expect(md).toContain(seccion)
  })

  test("RN6 y RN7: el fixture no cambia y hay log por llamada", () => {
    expect(readFileSync(join(ctx.directory, "fixtures/reto-02/maestro-contratos.csv"), "utf8")).toBe(
      readFileSync(join(RAIZ, "fixtures/reto-02/maestro-contratos.csv"), "utf8"),
    )
    const log = leerOut("out/log.jsonl").trim().split("\n").map((l) => JSON.parse(l))
    expect(log.length).toBeGreaterThanOrEqual(19)
    expect(Object.keys(log[0])).toEqual(expect.arrayContaining(["ts", "herramienta", "mensaje_id", "ok", "resumen"]))
  })

  test("HU-6: errores legibles sin lanzar", async () => {
    expect(leer(await contratos.extraer.execute({ mensaje_id: "msg-999" }, ctx))).toEqual({ ok: false, error: "el mensaje msg-999 no existe en el buzón" })
    expect(leer(await contratos.alertas.execute({ hoy: "2026-02-31" }, ctx)).ok).toBe(false)
    expect(leer(await contratos.registrar.execute({ mensaje_id: "msg-001" }, ctx))).toMatchObject({ ok: false, error: expect.stringContaining("ya fue procesado") })
  })
})
