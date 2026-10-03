/**
 * Herramientas del agente de registro de contratos.
 * Cada export es una herramienta; el modelo la ve como `contratos_<export>`.
 * Son la única fuente de valores que el agente puede afirmar (CA2).
 */
import { z } from "zod"
import { generarAlertas } from "./lib/alertas"
import { ejecutarSeguro } from "./lib/bitacora"
import { adjuntoContrato, leerAdjuntos, leerCorreo, leerProcesados, listarIdsBuzon, motivoSinContrato, resolverComercial } from "./lib/buzon"
import { extraerContrato } from "./lib/extraccion"
import { herramienta } from "./lib/herramienta"
import { asegurarMaestro } from "./lib/maestro"
import { registrarMensaje } from "./lib/registro"
import { recortar } from "./lib/texto"
import { ContratoSchema, fallo, ok } from "./lib/tipos"
import { analizarMensaje } from "./lib/validacion"

const mensajeId = z.string().regex(/^[a-zA-Z0-9_-]+$/).describe("Id del mensaje del buzón, p. ej. msg-001")
const contratoOpcional = ContratoSchema.optional().describe(
  "Contrato tal como lo devolvió contratos_extraer; solo cambia valores que el usuario haya confirmado. Omitir si el mensaje no trae contrato",
)
const fechaHoy = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

export const leer_buzon = herramienta({
  description:
    "Lista los mensajes del buzón de contratos que aún no se han procesado, con remitente, asunto, adjuntos y si traen contrato.",
  args: {},
  async execute(_args, ctx) {
    return ejecutarSeguro(ctx, "contratos_leer_buzon", null, () => {
      asegurarMaestro(ctx)
      const procesados = leerProcesados(ctx)
      const mensajes = listarIdsBuzon(ctx)
        .filter((id) => !procesados[id])
        .map((id) => {
          const correo = leerCorreo(ctx, id)
          const adjuntos = leerAdjuntos(ctx, correo)
          const tieneContrato = adjuntos.some((a) => a.esContrato)
          const comercial = resolverComercial(ctx, correo.de)
          return {
            id: correo.id,
            de: correo.de,
            asunto: correo.asunto,
            fecha: correo.fecha,
            adjuntos: correo.adjuntos,
            tiene_contrato: tieneContrato,
            comercial: comercial?.nombre ?? null,
            cuerpo: recortar(correo.cuerpo, 300),
            ...(tieneContrato ? {} : { clasificacion: "rechazado", motivo: motivoSinContrato(adjuntos) }),
          }
        })
      return ok({ mensajes, ya_procesados: Object.keys(procesados).length })
    }, (d) => `${d.mensajes.length} mensajes pendientes`)
  },
})

export const extraer = herramienta({
  description:
    "Extrae de forma determinista los datos del contrato adjunto a un mensaje, con confianza en [0,1] y evidencia por campo.",
  args: { mensaje_id: mensajeId },
  async execute({ mensaje_id }, ctx) {
    return ejecutarSeguro(ctx, "contratos_extraer", mensaje_id, () => {
      const correo = leerCorreo(ctx, mensaje_id)
      const adjunto = adjuntoContrato(ctx, correo)
      if (!adjunto) {
        return fallo(`${mensaje_id} no trae contrato: ${motivoSinContrato(leerAdjuntos(ctx, correo))}. Clasifícalo como rechazado`)
      }
      return extraerContrato(adjunto.texto)
    }, (c) => `${c.tipo_documento} ${c.id_contrato ?? "sin número"} · ${c.cliente ?? "sin cliente"}`)
  },
})

export const validar = herramienta({
  description:
    "Clasifica un mensaje como nuevo, actualizacion, duplicado o rechazado frente al maestro y lista los campos que requieren revisión humana.",
  args: { mensaje_id: mensajeId, contrato: contratoOpcional },
  async execute({ mensaje_id, contrato }, ctx) {
    return ejecutarSeguro(ctx, "contratos_validar", mensaje_id, () => {
      const analisis = analizarMensaje(ctx, mensaje_id, contrato ?? null)
      return analisis.ok ? ok(analisis.data.validacion) : analisis
    }, (v) => `${v.clasificacion}${v.requiere_revision.length ? ` · revisión: ${v.requiere_revision.join(", ")}` : ""}`)
  },
})

export const registrar = herramienta({
  description:
    "Registra o actualiza el contrato en el maestro, lo archiva en SharePoint y marca el mensaje como procesado; rechaza si hay campos en revisión sin confirmado=true.",
  args: {
    mensaje_id: mensajeId,
    contrato: contratoOpcional,
    confirmado: z
      .boolean()
      .optional()
      .describe("true solo si el usuario confirmó explícitamente, en un turno posterior, los campos en revisión"),
    hoy: fechaHoy.optional().describe("Fecha de registro YYYY-MM-DD; por defecto la fecha del sistema"),
  },
  async execute({ mensaje_id, contrato, confirmado, hoy }, ctx) {
    return ejecutarSeguro(ctx, "contratos_registrar", mensaje_id, () =>
      registrarMensaje(ctx, {
        mensajeId: mensaje_id,
        propuesto: contrato ?? null,
        confirmado: confirmado === true,
        hoy: hoy ?? new Date().toISOString().slice(0, 10),
      }),
    (r) => `${r.accion}${r.id_contrato ? ` ${r.id_contrato}` : ""}`)
  },
})

export const alertas = herramienta({
  description:
    "Genera out/alertas.md con contratos que vencen en 60 días o menos, pólizas exigidas no vigentes y contratos registrados desde el corte del 2026-05-30.",
  args: { hoy: fechaHoy.describe("Fecha de referencia YYYY-MM-DD") },
  async execute({ hoy }, ctx) {
    return ejecutarSeguro(ctx, "contratos_alertas", null, () => generarAlertas(ctx, hoy),
      (a) => `${a.vencen.length} vencen · ${a.polizas_pendientes.length} pólizas pendientes · ${a.registrados_desde_corte.length} desde corte`)
  },
})
