/** Ciclo del agente con un proveedor guionizado: verifica CA1, CA3 y CA5 sin gastar tokens. */
import { describe, expect, test } from "bun:test"
import { ejecutarTurno, type Dependencias } from "../src/agent/ciclo"
import { crearRegistro } from "../src/agent/herramientas"
import { AlmacenSesiones } from "../src/agent/sesiones"
import { ErrorProveedor, type LlamadaHerramienta, type MensajeLLM, type ProveedorLLM, type RespuestaLLM } from "../src/llm/adapter"
import type { Contrato } from "../src/tools/lib/tipos"
import { proyectoTemporal } from "./ayuda"

type Paso = (mensajes: MensajeLLM[]) => RespuestaLLM

function responder(texto: string, llamadas: LlamadaHerramienta[] = []): RespuestaLLM {
  return { texto, llamadas, nativo: undefined, uso: { entrada: 100, salida: 10 }, fin: llamadas.length ? "herramientas" : "fin_turno" }
}

function llamar(nombre: string, argumentos: unknown, id = `t-${Math.random()}`): LlamadaHerramienta {
  return { id, nombre, argumentos }
}

/** Último resultado de herramienta visto por el "modelo". */
function ultimoResultado<T>(mensajes: MensajeLLM[]): T {
  const ultimo = mensajes.at(-1)
  if (ultimo?.rol !== "herramientas") throw new Error("se esperaba un resultado de herramienta")
  return JSON.parse(ultimo.resultados[0]!.contenido) as T
}

class Guion implements ProveedorLLM {
  readonly proveedor = "guion"
  readonly modelo = "guion-1"
  constructor(private readonly pasos: Paso[]) {}
  async enviar(mensajes: MensajeLLM[]): Promise<RespuestaLLM> {
    const paso = this.pasos.shift()
    if (!paso) return responder("fin")
    return paso(mensajes)
  }
}

function deps(llm: ProveedorLLM, directorio: string, maxIteraciones = 25): Dependencias {
  return {
    llm,
    registro: crearRegistro(),
    sistema: "test",
    directorio,
    limites: { maxIteraciones, maxTokensSesion: 1_000_000 },
    hayPresupuesto: () => true,
    consumir: () => undefined,
  }
}

describe("ciclo del agente", () => {
  test("CA3: confirmado=true solo vale en un turno posterior a la pregunta", async () => {
    const ctx = proyectoTemporal()
    const sesion = new AlmacenSesiones(`${ctx.directory}/out/sesiones`).obtener("s1")
    let contrato: Contrato | null = null
    const guion = new Guion([
      () => responder("", [llamar("contratos_extraer", { mensaje_id: "msg-006" })]),
      (m) => {
        contrato = (ultimoResultado<{ data: Contrato }>(m)).data
        return responder("", [llamar("contratos_registrar", { mensaje_id: "msg-006", contrato, confirmado: true })])
      },
      () => responder("¿Confirmas valor 0 y fecha fin 2027-08-31 para msg-006?"),
      // turno 2: el usuario confirmó
      () => responder("", [llamar("contratos_registrar", { mensaje_id: "msg-006", contrato, confirmado: true, hoy: "2026-09-03" })]),
      () => responder("Registrado CM-2026-03."),
    ])
    const d = deps(guion, ctx.directory)

    const t1 = await ejecutarTurno(sesion, "procesa msg-006", d)
    expect(t1.toolCalls[1]).toMatchObject({ nombre: "contratos_registrar", ok: false })
    expect(String(t1.toolCalls[1]!.resultado)).toContain("confirmado=true rechazado")
    // El registrar bloqueado no deja pendiente; se pide validar o registrar sin confirmar para levantarlo.
    expect(t1.needsConfirmation).toBe(false)

    sesion.pendientes["msg-006"] = { turno: sesion.turno, campos: ["valor", "fecha_fin"] }
    const t2 = await ejecutarTurno(sesion, "confirmo el valor 0 y la fecha fin 2027-08-31", d)
    expect(t2.toolCalls[0]).toMatchObject({ nombre: "contratos_registrar", ok: true })
    expect(t2.needsConfirmation).toBe(false)
  })

  test("CA3: un registrar sin confirmar deja la sesión esperando confirmación", async () => {
    const ctx = proyectoTemporal()
    const sesion = new AlmacenSesiones(`${ctx.directory}/out/sesiones`).obtener("s2")
    const guion = new Guion([
      () => responder("", [llamar("contratos_registrar", { mensaje_id: "msg-006" })]),
      () => responder("msg-006 requiere revisión de valor y fecha_fin. ¿Confirmas?"),
    ])
    const t = await ejecutarTurno(sesion, "registra msg-006", deps(guion, ctx.directory))
    expect(t.needsConfirmation).toBe(true)
    expect(t.pendientes).toEqual({ "msg-006": ["valor", "fecha_fin"] })
  })

  test("argumentos inválidos vuelven al modelo como error, sin ejecutar", async () => {
    const ctx = proyectoTemporal()
    const sesion = new AlmacenSesiones(`${ctx.directory}/out/sesiones`).obtener("s3")
    const guion = new Guion([
      () => responder("", [llamar("contratos_alertas", { hoy: "3 de septiembre" })]),
      () => responder("La fecha debe ir en formato YYYY-MM-DD."),
    ])
    const t = await ejecutarTurno(sesion, "alertas", deps(guion, ctx.directory))
    expect(t.toolCalls[0]).toMatchObject({ ok: false })
    expect(String(t.toolCalls[0]!.resultado)).toContain("argumentos inválidos")
  })

  test("CA1: tope de iteraciones cierra el turno con un resumen", async () => {
    const ctx = proyectoTemporal()
    const sesion = new AlmacenSesiones(`${ctx.directory}/out/sesiones`).obtener("s4")
    const bucle: Paso = () => responder("", [llamar("contratos_leer_buzon", {})])
    const guion = new Guion([bucle, bucle, bucle, () => responder("Hice 3 lecturas; falta extraer.")])
    const t = await ejecutarTurno(sesion, "procesa", deps(guion, ctx.directory, 3))
    expect(t.toolCalls).toHaveLength(3)
    expect(t.reply).toBe("Hice 3 lecturas; falta extraer.")
    const ultimo = sesion.mensajes.findLast((m) => m.rol === "herramientas")
    expect(ultimo?.rol === "herramientas" && ultimo.nota).toContain("tope de 3 iteraciones")
  })

  test("CA5: un error del proveedor se informa y la sesión sigue viva", async () => {
    const ctx = proyectoTemporal()
    const sesion = new AlmacenSesiones(`${ctx.directory}/out/sesiones`).obtener("s5")
    const guion = new Guion([
      () => {
        throw new ErrorProveedor("El modelo no respondió en 120 s. Intenta de nuevo.", "timeout")
      },
      () => responder("Aquí estoy."),
    ])
    const d = deps(guion, ctx.directory)
    const t1 = await ejecutarTurno(sesion, "hola", d)
    expect(t1.reply).toContain("no respondió")
    const t2 = await ejecutarTurno(sesion, "¿sigues?", d)
    expect(t2.reply).toBe("Aquí estoy.")
  })
})
