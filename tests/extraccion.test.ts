import { describe, expect, test } from "bun:test"
import { extraerContrato } from "../src/tools/lib/extraccion"
import type { Contrato } from "../src/tools/lib/tipos"
import { textoFixture } from "./ayuda"

function extraer(mensaje: string, archivo = "contrato.txt"): Contrato {
  const r = extraerContrato(textoFixture(mensaje, archivo))
  if (!r.ok) throw new Error(r.error)
  return r.data
}

describe("extracción determinista sobre los fixtures", () => {
  test("msg-001: contrato con póliza de cumplimiento", () => {
    const c = extraer("msg-001")
    expect(c).toMatchObject({
      id_contrato: "CT-2026-015",
      cliente: "Industrias Delta S.A.S.",
      nit_cliente: "890900111",
      pais: "CO",
      valor: 265000000,
      moneda: "COP",
      fecha_inicio: "2026-08-01",
      fecha_fin: "2027-07-31",
      requiere_poliza: true,
      tipo_poliza: "cumplimiento",
    })
    expect(Math.min(...Object.values(c.confianza))).toBeGreaterThanOrEqual(0.8)
  })

  test("msg-002: Ecuador, USD con separador anglosajón, sin póliza", () => {
    expect(extraer("msg-002")).toMatchObject({
      nit_cliente: "1790012345001",
      pais: "EC",
      valor: 120000,
      moneda: "USD",
      fecha_fin: "2027-08-14",
      requiere_poliza: false,
      tipo_poliza: "",
    })
  })

  test("msg-003: otrosí solo trae lo que modifica", () => {
    const c = extraer("msg-003", "otrosi.txt")
    expect(c).toMatchObject({ tipo_documento: "otrosi", id_contrato: "CT-2026-011", valor: 520000, moneda: "PEN", fecha_fin: "2027-11-01" })
    expect(c.fecha_inicio).toBeNull()
    expect(c.confianza.fecha_inicio).toBe(0)
  })

  test("msg-006: contrato marco por demanda con plazo en meses", () => {
    const c = extraer("msg-006")
    expect(c).toMatchObject({ tipo_documento: "contrato_marco", id_contrato: "CM-2026-03", valor: 0, valor_indeterminado: true, moneda: "COP", fecha_fin: "2027-08-31" })
    expect(c.confianza.valor).toBeLessThan(0.8)
    expect(c.confianza.fecha_fin).toBeLessThan(0.8)
  })
})

describe("errores tipados (HU-6)", () => {
  test("texto vacío", () => {
    expect(extraerContrato("   \n")).toEqual({ ok: false, error: expect.stringContaining("vacío") })
  })

  test("fecha inválida", () => {
    const texto = "CONTRATO No. CT-2026-099\n\nTERCERA. PLAZO. Desde el treinta y uno (31) de febrero de 2026 hasta el 1 de marzo de 2027."
    expect(extraerContrato(texto)).toEqual({ ok: false, error: expect.stringContaining("fecha inválida") })
  })

  test("moneda desconocida", () => {
    const texto = "CONTRATO No. CT-2026-098\n\nSEGUNDA. VALOR. El valor es de CIEN MIL EUROS (EUR 100.000)."
    expect(extraerContrato(texto)).toEqual({ ok: false, error: expect.stringContaining("moneda desconocida") })
  })

  test("campos ausentes son null con confianza 0", () => {
    const r = extraerContrato("CONTRATO DE SERVICIOS\n\nTexto sin cláusulas reconocibles.")
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.valor).toBeNull()
      expect(r.data.confianza.valor).toBe(0)
      expect(r.data.cliente).toBeNull()
    }
  })
})
