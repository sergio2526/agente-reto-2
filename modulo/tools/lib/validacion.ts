/** Clasificación RN1–RN5: nuevo, actualización, duplicado o rechazado. */
import { adjuntoContrato, leerAdjuntos, leerCorreo, motivoSinContrato, resolverComercial, type Adjunto, type Correo } from "./buzon"
import { extraerContrato } from "./extraccion"
import { leerMaestro, valorCsv } from "./maestro"
import { normalizar, similitud, slugCliente } from "./texto"
import {
  CAMPOS_CONTRATO,
  UMBRAL_CONFIANZA,
  type CampoContrato,
  type Clasificacion,
  type ContextoHerramienta,
  type Contrato,
  type FilaMaestro,
  type Resultado,
  fallo,
  ok,
} from "./tipos"

export interface Diferencia {
  maestro: string
  documento: string
}

export interface Validacion {
  clasificacion: Clasificacion
  motivo: string
  id_contrato_existente?: string
  requiere_revision: string[]
  detalle_revision: Record<string, string>
  diferencias?: Record<string, Diferencia>
  advertencias: string[]
  comercial: { email: string; nombre: string | null; registrado: boolean }
}

export interface Analisis {
  correo: Correo
  adjunto: Adjunto | null
  extraido: Contrato | null
  contrato: Contrato | null
  fila: FilaMaestro | null
  validacion: Validacion
}

const CAMPOS_COMPARABLES: CampoContrato[] = [
  "cliente", "nit_cliente", "pais", "valor", "moneda", "fecha_inicio", "fecha_fin", "requiere_poliza", "tipo_poliza",
]
const CAMPOS_IDENTIDAD: CampoContrato[] = ["cliente", "nit_cliente", "pais"]
const SIMILITUD_OBJETO = 0.9

// ───────────────────────── revisión por confianza (RN5) ─────────────────────────

function camposEvaluados(contrato: Contrato): CampoContrato[] {
  return CAMPOS_CONTRATO.filter((campo) => {
    if (campo === "id_contrato") return false // tiene regla de respaldo AUTO-<año>-<seq>
    if (campo === "tipo_poliza") return contrato.requiere_poliza === true
    // En un otrosí solo se evalúa lo que el documento modifica.
    if (contrato.tipo_documento === "otrosi") return contrato[campo] !== null
    return true
  })
}

/** Usa SIEMPRE la confianza de la extracción, nunca la que declare el modelo. */
function revisionPorConfianza(extraido: Contrato, contrato: Contrato): Record<string, string> {
  const detalle: Record<string, string> = {}
  for (const campo of camposEvaluados(contrato)) {
    const confianza = extraido.confianza[campo] ?? 0
    if (confianza < UMBRAL_CONFIANZA) {
      const motivo = extraido.evidencia?.[campo] ?? ""
      detalle[campo] = `confianza ${confianza} < ${UMBRAL_CONFIANZA}${motivo ? `: ${motivo}` : ""}`
    }
  }
  return detalle
}

/** Todo valor propuesto que difiera de la extracción exige confirmación humana. */
function revisionPorCambiosDelAgente(extraido: Contrato, contrato: Contrato): Record<string, string> {
  const detalle: Record<string, string> = {}
  for (const campo of CAMPOS_CONTRATO) {
    const original = valorCsv(extraido, campo)
    const propuesto = valorCsv(contrato, campo)
    if (original !== propuesto) {
      detalle[campo] = `valor propuesto "${propuesto ?? "vacío"}" difiere de la extracción "${original ?? "vacío"}"`
    }
  }
  return detalle
}

// ───────────────────────── comparación con el maestro ─────────────────────────

function iguales(campo: CampoContrato, maestro: string, documento: string): boolean {
  if (campo === "cliente") return slugCliente(maestro) === slugCliente(documento)
  if (campo === "valor") return Number(maestro) === Number(documento)
  if (campo === "tipo_poliza") {
    const conjunto = (s: string) => s.split(";").map((t) => t.trim()).filter(Boolean).sort().join(";")
    return conjunto(maestro) === conjunto(documento)
  }
  return normalizar(maestro) === normalizar(documento)
}

function diferenciasConFila(fila: FilaMaestro, contrato: Contrato): Record<string, Diferencia> {
  const diferencias: Record<string, Diferencia> = {}
  for (const campo of CAMPOS_COMPARABLES) {
    const documento = valorCsv(contrato, campo)
    if (documento === null) continue
    if (!iguales(campo, fila[campo], documento)) diferencias[campo] = { maestro: fila[campo], documento }
  }
  return diferencias
}

function buscarEnMaestro(filas: FilaMaestro[], contrato: Contrato): { fila: FilaMaestro | null; porId: boolean } {
  const porId = contrato.id_contrato ? filas.find((f) => f.id_contrato === contrato.id_contrato) : undefined
  if (porId) return { fila: porId, porId: true }
  const { nit_cliente: nit, objeto } = contrato
  if (!nit || !objeto) return { fila: null, porId: false }
  const similar = filas.find((f) => f.nit_cliente === nit && similitud(f.objeto, objeto) >= SIMILITUD_OBJETO)
  return { fila: similar ?? null, porId: false }
}

function mismaVigenciaYValor(fila: FilaMaestro, contrato: Contrato): boolean {
  return (
    Number(fila.valor) === contrato.valor &&
    fila.fecha_inicio === contrato.fecha_inicio &&
    fila.fecha_fin === contrato.fecha_fin
  )
}

/** Un otrosí que amplía el plazo obliga a ampliar las pólizas: pasan a pendiente. */
function efectoEnPoliza(fila: FilaMaestro, diferencias: Record<string, Diferencia>): Diferencia | null {
  if (fila.requiere_poliza !== "true" || !diferencias.fecha_fin) return null
  if (fila.estado_poliza === "pendiente") return null
  return { maestro: fila.estado_poliza, documento: "pendiente" }
}

// ───────────────────────── clasificación ─────────────────────────

interface Base {
  comercial: Validacion["comercial"]
  advertencias: string[]
}

function rechazo(base: Base, motivo: string): Validacion {
  return { clasificacion: "rechazado", motivo, requiere_revision: [], detalle_revision: {}, ...base }
}

function clasificarContraMaestro(
  base: Base,
  contrato: Contrato,
  filas: FilaMaestro[],
  revision: Record<string, string>,
): { validacion: Validacion; fila: FilaMaestro | null } {
  const { fila, porId } = buscarEnMaestro(filas, contrato)
  const esOtrosi = contrato.tipo_documento === "otrosi"
  if (!fila && esOtrosi) {
    return { validacion: rechazo(base, `otrosí del contrato ${contrato.id_contrato ?? "sin número"}, que no existe en el maestro`), fila: null }
  }
  if (!fila) {
    if (!contrato.id_contrato) base.advertencias.push("el documento no trae número: se asignará AUTO-<año>-<secuencia>")
    return { validacion: final(base, "nuevo", "no hay coincidencia en el maestro (RN3)", revision), fila: null }
  }
  const diferencias = diferenciasConFila(fila, contrato)
  const extra = { id_contrato_existente: fila.id_contrato, diferencias }
  if (!esOtrosi && (Object.keys(diferencias).length === 0 || (porId && mismaVigenciaYValor(fila, contrato)))) {
    const motivo = `${fila.id_contrato} ya está en el maestro con el mismo valor y vigencia (RN1)`
    return { validacion: { ...final(base, "duplicado", motivo, {}), ...extra }, fila }
  }
  const poliza = efectoEnPoliza(fila, diferencias)
  if (poliza) {
    diferencias.estado_poliza = poliza
    base.advertencias.push("el otrosí amplía el plazo: las pólizas deben ampliarse, el estado pasa a pendiente")
  }
  for (const campo of CAMPOS_IDENTIDAD) {
    const d = diferencias[campo]
    if (d) revision[campo] = `conflicto con el maestro: "${d.maestro}" vs "${d.documento}"`
  }
  const motivo = esOtrosi
    ? `otrosí que modifica ${fila.id_contrato} (RN2)`
    : `${porId ? "mismo id_contrato" : "mismo NIT y objeto similar"} con campos distintos (RN2)`
  return { validacion: { ...final(base, "actualizacion", motivo, revision), ...extra }, fila }
}

function final(base: Base, clasificacion: Clasificacion, motivo: string, revision: Record<string, string>): Validacion {
  return { clasificacion, motivo, requiere_revision: Object.keys(revision), detalle_revision: revision, ...base }
}

function baseDe(ctx: ContextoHerramienta, correo: Correo): Base {
  const comercial = resolverComercial(ctx, correo.de)
  const advertencias = comercial
    ? []
    : [`remitente ${correo.de} no está en comerciales.json: se reporta, no bloquea el registro`]
  return { comercial: { email: correo.de, nombre: comercial?.nombre ?? null, registrado: comercial !== null }, advertencias }
}

/** Analiza un mensaje completo. `propuesto` es el contrato que envía el agente (opcional). */
export function analizarMensaje(
  ctx: ContextoHerramienta,
  mensajeId: string,
  propuesto: Contrato | null,
): Resultado<Analisis> {
  const correo = leerCorreo(ctx, mensajeId)
  const base = baseDe(ctx, correo)
  const adjunto = adjuntoContrato(ctx, correo)
  const vacio = { correo, adjunto, extraido: null, contrato: null, fila: null }
  if (!adjunto) return ok({ ...vacio, validacion: rechazo(base, motivoSinContrato(leerAdjuntos(ctx, correo))) })

  const extraccion = extraerContrato(adjunto.texto)
  if (!extraccion.ok) return fallo(`${mensajeId}: ${extraccion.error}`)
  const extraido = extraccion.data
  const contrato = propuesto ?? extraido
  if (!contrato.cliente && !contrato.objeto) {
    return ok({ ...vacio, extraido, validacion: rechazo(base, "el texto no contiene partes ni objeto identificables (RN4)") })
  }
  base.advertencias.push(...(extraido.advertencias ?? []))
  const revision = { ...revisionPorConfianza(extraido, contrato), ...revisionPorCambiosDelAgente(extraido, contrato) }
  const { validacion, fila } = clasificarContraMaestro(base, contrato, leerMaestro(ctx), revision)
  return ok({ correo, adjunto, extraido, contrato, fila, validacion })
}
