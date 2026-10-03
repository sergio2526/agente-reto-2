import { parsearCsv, serializarCsv } from "./csv"
import { RUTAS, copiarArchivo, existe, leerTexto, escribirTexto } from "./rutas"
import { COLUMNAS_MAESTRO, type ContextoHerramienta, type Contrato, type FilaMaestro } from "./tipos"

/** RN6: la primera ejecución copia el fixture a out/sharepoint/; el fixture nunca se toca. */
export function asegurarMaestro(ctx: ContextoHerramienta): void {
  if (!existe(ctx, RUTAS.maestro)) copiarArchivo(ctx, RUTAS.maestroFixture, RUTAS.maestro)
}

export function leerMaestro(ctx: ContextoHerramienta): FilaMaestro[] {
  asegurarMaestro(ctx)
  return parsearCsv(leerTexto(ctx, RUTAS.maestro)) as unknown as FilaMaestro[]
}

export function guardarMaestro(ctx: ContextoHerramienta, filas: FilaMaestro[]): void {
  escribirTexto(ctx, RUTAS.maestro, serializarCsv(COLUMNAS_MAESTRO, filas as unknown as Record<string, string>[]))
}

/** AUTO-<año>-<secuencia> para contratos sin número (sección 7.2). */
export function siguienteIdAuto(filas: FilaMaestro[], anio: string): string {
  const prefijo = `AUTO-${anio}-`
  const usados = filas
    .filter((f) => f.id_contrato.startsWith(prefijo))
    .map((f) => Number(f.id_contrato.slice(prefijo.length)) || 0)
  const siguiente = Math.max(0, ...usados) + 1
  return `${prefijo}${String(siguiente).padStart(3, "0")}`
}

/** Representación en texto de un campo del contrato, tal como se guarda en el CSV. */
export function valorCsv(contrato: Contrato, campo: keyof FilaMaestro): string | null {
  switch (campo) {
    case "valor":
      return contrato.valor === null ? null : String(contrato.valor)
    case "requiere_poliza":
      return contrato.requiere_poliza === null ? null : String(contrato.requiere_poliza)
    case "tipo_poliza":
      return contrato.requiere_poliza === null ? null : contrato.tipo_poliza
    case "id_contrato":
    case "cliente":
    case "nit_cliente":
    case "pais":
    case "objeto":
    case "moneda":
    case "fecha_inicio":
    case "fecha_fin":
      return contrato[campo]
    default:
      return null
  }
}

export interface DatosRegistro {
  id_contrato: string
  comercial: string
  ruta_sharepoint: string
  fecha_registro: string
  fuente: "buzon" | "migracion"
}

export function filaNueva(contrato: Contrato, datos: DatosRegistro): FilaMaestro {
  const requiere = contrato.requiere_poliza === true
  return {
    id_contrato: datos.id_contrato,
    cliente: contrato.cliente ?? "",
    nit_cliente: contrato.nit_cliente ?? "",
    pais: contrato.pais ?? "",
    objeto: contrato.objeto ?? "",
    valor: String(contrato.valor ?? 0),
    moneda: contrato.moneda ?? "",
    fecha_inicio: contrato.fecha_inicio ?? "",
    fecha_fin: contrato.fecha_fin ?? "",
    requiere_poliza: String(requiere),
    tipo_poliza: requiere ? contrato.tipo_poliza : "",
    estado_poliza: requiere ? "pendiente" : "no_aplica",
    comercial: datos.comercial,
    ruta_sharepoint: datos.ruta_sharepoint,
    fecha_registro: datos.fecha_registro,
    fuente: datos.fuente,
  }
}
