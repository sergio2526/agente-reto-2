/** Escritura en el maestro, archivo en "SharePoint" y marca de procesado (HU-4). */
import { extname } from "node:path"
import { agregarHistorial, type Cambio } from "./bitacora"
import { leerProcesados, marcarProcesado } from "./buzon"
import { filaNueva, guardarMaestro, leerMaestro, siguienteIdAuto } from "./maestro"
import { RUTAS, copiarArchivo, unir } from "./rutas"
import { slugCliente } from "./texto"
import { COLUMNAS_MAESTRO, type Clasificacion, type ContextoHerramienta, type Contrato, type FilaMaestro, type Resultado, fallo, ok } from "./tipos"
import { analizarMensaje, type Analisis } from "./validacion"

export interface ResultadoRegistro {
  id_contrato: string | null
  accion: "alta" | "actualizacion" | "duplicado" | "rechazado"
  clasificacion: Clasificacion
  ruta_archivo: string | null
  cambios?: Record<string, Cambio>
  motivo: string
  advertencias: string[]
}

/** Regla de gobierno: la campaña de cierre del gap usa el prefijo [MIGRACION] en el asunto. */
const CAMPANA_MIGRACION = /\[MIGRACI[OÓ]N\]/i

interface Peticion {
  mensajeId: string
  propuesto: Contrato | null
  confirmado: boolean
  hoy: string
}

function textoRevision(an: Analisis): string {
  const { requiere_revision, detalle_revision } = an.validacion
  const detalle = requiere_revision.map((c) => `${c} (${detalle_revision[c]})`).join("; ")
  return `requiere revisión: ${requiere_revision.join(", ")}. Detalle: ${detalle}. Pide confirmación explícita al usuario campo por campo y, solo si confirma, reintenta con confirmado=true.`
}

function archivar(ctx: ContextoHerramienta, an: Analisis, carpeta: string, nombre: string): string {
  const adjunto = an.adjunto!
  const relativa = unir("Contratos", carpeta, `${nombre}${extname(adjunto.nombre) || ".txt"}`)
  copiarArchivo(ctx, adjunto.ruta, unir(RUTAS.sharepoint, relativa))
  return relativa
}

function alta(ctx: ContextoHerramienta, an: Analisis, p: Peticion): ResultadoRegistro {
  const contrato = an.contrato!
  const filas = leerMaestro(ctx)
  const anio = (contrato.fecha_inicio ?? p.hoy).slice(0, 4)
  const id = contrato.id_contrato ?? siguienteIdAuto(filas, anio)
  const rutaSharepoint = archivar(ctx, an, unir(anio, slugCliente(contrato.cliente ?? "sin-cliente")), id)
  const { comercial } = an.validacion
  const fila = filaNueva(contrato, {
    id_contrato: id,
    comercial: comercial.nombre ?? `${comercial.email} (no registrado)`,
    ruta_sharepoint: rutaSharepoint,
    fecha_registro: p.hoy,
    fuente: CAMPANA_MIGRACION.test(an.correo.asunto) ? "migracion" : "buzon",
  })
  guardarMaestro(ctx, [...filas, fila])
  const cambios = Object.fromEntries(COLUMNAS_MAESTRO.map((c) => [c, { antes: null, despues: fila[c] }]))
  agregarHistorial(ctx, { id_contrato: id, accion: "alta", cambios, mensaje_id: p.mensajeId, fecha: p.hoy, documento: rutaSharepoint })
  return resultado(an, "alta", id, unir(RUTAS.sharepoint, rutaSharepoint), cambios)
}

function actualizacion(ctx: ContextoHerramienta, an: Analisis, p: Peticion): ResultadoRegistro {
  const filas = leerMaestro(ctx)
  const fila = filas.find((f) => f.id_contrato === an.fila!.id_contrato)!
  const carpeta = unir(fila.fecha_inicio.slice(0, 4), slugCliente(fila.cliente))
  const sufijo = an.contrato!.tipo_documento === "otrosi" ? "otrosi" : "version"
  const documento = archivar(ctx, an, carpeta, `${fila.id_contrato}-${sufijo}-${p.mensajeId}`)
  const cambios: Record<string, Cambio> = {}
  for (const [campo, d] of Object.entries(an.validacion.diferencias ?? {})) {
    cambios[campo] = { antes: d.maestro, despues: d.documento }
    fila[campo as keyof FilaMaestro] = d.documento
  }
  if (!fila.ruta_sharepoint) fila.ruta_sharepoint = documento
  guardarMaestro(ctx, filas)
  agregarHistorial(ctx, { id_contrato: fila.id_contrato, accion: "actualizacion", cambios, mensaje_id: p.mensajeId, fecha: p.hoy, documento })
  return resultado(an, "actualizacion", fila.id_contrato, unir(RUTAS.sharepoint, documento), cambios)
}

function resultado(
  an: Analisis,
  accion: ResultadoRegistro["accion"],
  id: string | null,
  ruta: string | null,
  cambios?: Record<string, Cambio>,
): ResultadoRegistro {
  const { clasificacion, motivo, advertencias } = an.validacion
  return { id_contrato: id, accion, clasificacion, ruta_archivo: ruta, ...(cambios ? { cambios } : {}), motivo, advertencias }
}

function aplicar(ctx: ContextoHerramienta, an: Analisis, p: Peticion): ResultadoRegistro {
  switch (an.validacion.clasificacion) {
    case "nuevo":
      return alta(ctx, an, p)
    case "actualizacion":
      return actualizacion(ctx, an, p)
    case "duplicado":
      return resultado(an, "duplicado", an.fila?.id_contrato ?? null, null)
    case "rechazado":
      return resultado(an, "rechazado", null, null)
  }
}

export function registrarMensaje(ctx: ContextoHerramienta, p: Peticion): Resultado<ResultadoRegistro> {
  const previo = leerProcesados(ctx)[p.mensajeId]
  if (previo) return fallo(`${p.mensajeId} ya fue procesado (${previo.accion}${previo.id_contrato ? ` ${previo.id_contrato}` : ""})`)
  const analisis = analizarMensaje(ctx, p.mensajeId, p.propuesto)
  if (!analisis.ok) return analisis
  const an = analisis.data
  if (an.validacion.requiere_revision.length > 0 && !p.confirmado) return fallo(textoRevision(an))
  const r = aplicar(ctx, an, p)
  marcarProcesado(ctx, p.mensajeId, { clasificacion: r.clasificacion, accion: r.accion, id_contrato: r.id_contrato, ts: new Date().toISOString() })
  return ok(r)
}
