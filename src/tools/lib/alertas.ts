/** Reporte de riesgos (HU-5): vencimientos, pólizas pendientes y gap cubierto. */
import { leerHistorial } from "./bitacora"
import { leerMaestro } from "./maestro"
import { RUTAS, escribirTexto } from "./rutas"
import { diasEntre, fechaValida } from "./texto"
import { type ContextoHerramienta, type FilaMaestro, type Resultado, fallo, ok } from "./tipos"

/** Fecha desde la que el maestro estaba congelado. */
export const FECHA_CORTE = "2026-05-30"
export const DIAS_ALERTA = 60

export interface Vencimiento {
  id_contrato: string
  cliente: string
  fecha_fin: string
  dias_restantes: number
  estado_poliza: string
}

export interface PolizaPendiente {
  id_contrato: string
  cliente: string
  tipo_poliza: string
  estado_poliza: string
  fecha_fin: string
}

export interface RegistroReciente {
  id_contrato: string
  cliente: string
  fecha_registro: string
  comercial: string
}

export interface Actualizacion {
  id_contrato: string
  fecha: string
  campos: string[]
}

export interface Alertas {
  ruta: string
  hoy: string
  vencen: Vencimiento[]
  vencidos: Vencimiento[]
  polizas_pendientes: PolizaPendiente[]
  registrados_desde_corte: RegistroReciente[]
  actualizados_desde_corte: Actualizacion[]
}

function vencimiento(f: FilaMaestro, hoy: string): Vencimiento {
  return {
    id_contrato: f.id_contrato,
    cliente: f.cliente,
    fecha_fin: f.fecha_fin,
    dias_restantes: diasEntre(hoy, f.fecha_fin),
    estado_poliza: f.estado_poliza,
  }
}

function calcular(ctx: ContextoHerramienta, hoy: string): Omit<Alertas, "ruta"> {
  const filas = leerMaestro(ctx).filter((f) => fechaValida(f.fecha_fin))
  const porFin = (a: Vencimiento, b: Vencimiento) => a.dias_restantes - b.dias_restantes
  const todos = filas.map((f) => vencimiento(f, hoy))
  return {
    hoy,
    vencen: todos.filter((v) => v.dias_restantes >= 0 && v.dias_restantes <= DIAS_ALERTA).sort(porFin),
    vencidos: todos.filter((v) => v.dias_restantes < 0).sort(porFin),
    polizas_pendientes: filas
      .filter((f) => f.requiere_poliza === "true" && f.estado_poliza !== "vigente")
      .map(({ id_contrato, cliente, tipo_poliza, estado_poliza, fecha_fin }) => ({ id_contrato, cliente, tipo_poliza, estado_poliza, fecha_fin })),
    registrados_desde_corte: filas
      .filter((f) => f.fecha_registro >= FECHA_CORTE)
      .map(({ id_contrato, cliente, fecha_registro, comercial }) => ({ id_contrato, cliente, fecha_registro, comercial })),
    actualizados_desde_corte: leerHistorial(ctx)
      .filter((h) => h.accion === "actualizacion" && h.fecha >= FECHA_CORTE)
      .map((h) => ({ id_contrato: h.id_contrato, fecha: h.fecha, campos: Object.keys(h.cambios) })),
  }
}

function tabla(encabezados: string[], filas: string[][]): string {
  if (filas.length === 0) return "_Sin registros._\n"
  const linea = (celdas: string[]) => `| ${celdas.map((c) => c.replace(/\|/g, "\\|")).join(" | ")} |`
  return [linea(encabezados), linea(encabezados.map(() => "---")), ...filas.map(linea)].join("\n") + "\n"
}

export function alertasMarkdown(a: Omit<Alertas, "ruta">): string {
  const v = (x: Vencimiento) => [x.id_contrato, x.cliente, x.fecha_fin, String(x.dias_restantes), x.estado_poliza]
  return [
    `# Alertas de contratos — ${a.hoy}`,
    "",
    `Generado por el agente de registro de contratos. Fecha de referencia: **${a.hoy}**.`,
    "",
    `## 1. Contratos que vencen en ≤ ${DIAS_ALERTA} días (${a.vencen.length})`,
    "",
    tabla(["Contrato", "Cliente", "Fecha fin", "Días", "Estado póliza"], a.vencen.map(v)),
    `## 2. Pólizas exigidas que no están vigentes (${a.polizas_pendientes.length})`,
    "",
    tabla(
      ["Contrato", "Cliente", "Tipo de póliza", "Estado", "Fecha fin contrato"],
      a.polizas_pendientes.map((p) => [p.id_contrato, p.cliente, p.tipo_poliza, p.estado_poliza, p.fecha_fin]),
    ),
    `## 3. Gap cubierto: registrados desde el ${FECHA_CORTE} (${a.registrados_desde_corte.length})`,
    "",
    tabla(
      ["Contrato", "Cliente", "Fecha registro", "Comercial"],
      a.registrados_desde_corte.map((r) => [r.id_contrato, r.cliente, r.fecha_registro, r.comercial]),
    ),
    `### Actualizaciones (otrosíes) aplicadas desde el ${FECHA_CORTE} (${a.actualizados_desde_corte.length})`,
    "",
    tabla(
      ["Contrato", "Fecha", "Campos modificados"],
      a.actualizados_desde_corte.map((u) => [u.id_contrato, u.fecha, u.campos.join(", ")]),
    ),
    `## Anexo: contratos con fecha fin ya cumplida (${a.vencidos.length})`,
    "",
    "Revisar si se liquidaron, se prorrogaron o falta un otrosí en el buzón.",
    "",
    tabla(["Contrato", "Cliente", "Fecha fin", "Días", "Estado póliza"], a.vencidos.map(v)),
  ].join("\n")
}

export function generarAlertas(ctx: ContextoHerramienta, hoy: string): Resultado<Alertas> {
  if (!fechaValida(hoy)) return fallo(`fecha "hoy" inválida: "${hoy}" (use YYYY-MM-DD)`)
  const datos = calcular(ctx, hoy)
  escribirTexto(ctx, RUTAS.alertas, alertasMarkdown(datos))
  return ok({ ruta: RUTAS.alertas, ...datos })
}
