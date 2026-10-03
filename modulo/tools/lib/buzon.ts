import { readdirSync } from "node:fs"
import { z } from "zod"
import { RUTAS, escribirTexto, existe, leerJson, leerTexto, ruta, unir } from "./rutas"
import { ErrorNegocio, type ContextoHerramienta } from "./tipos"

const CorreoSchema = z.object({
  id: z.string(),
  de: z.string(),
  para: z.string(),
  asunto: z.string(),
  fecha: z.string(),
  cuerpo: z.string(),
  adjuntos: z.array(z.string()),
})
export type Correo = z.infer<typeof CorreoSchema>

export interface Comercial {
  email: string
  nombre: string
  region: string
}

export interface MarcaProcesado {
  clasificacion: string
  accion: string
  id_contrato: string | null
  ts: string
}
export type Procesados = Record<string, MarcaProcesado>

const ID_MENSAJE = /^[a-zA-Z0-9_-]+$/

export function listarIdsBuzon(ctx: ContextoHerramienta): string[] {
  return readdirSync(ruta(ctx, RUTAS.buzon), { withFileTypes: true })
    .filter((d) => d.isDirectory() && ID_MENSAJE.test(d.name))
    .map((d) => d.name)
    .sort()
}

export function leerCorreo(ctx: ContextoHerramienta, mensajeId: string): Correo {
  if (!ID_MENSAJE.test(mensajeId)) throw new ErrorNegocio(`id de mensaje inválido: ${mensajeId}`)
  const rel = unir(RUTAS.buzon, mensajeId, "correo.json")
  if (!existe(ctx, rel)) throw new ErrorNegocio(`el mensaje ${mensajeId} no existe en el buzón`)
  return CorreoSchema.parse(JSON.parse(leerTexto(ctx, rel)))
}

const NOMBRE_CONTRACTUAL = /contrato|otros[ií]|acta|adenda|modificatorio/i
const ENCABEZADO_CONTRACTUAL = /^\s*(contrato|otros[ií]|acta de|adenda|modificatorio)/i

export interface Adjunto {
  nombre: string
  ruta: string
  texto: string
  esContrato: boolean
}

export function leerAdjuntos(ctx: ContextoHerramienta, correo: Correo): Adjunto[] {
  return correo.adjuntos.map((nombre) => {
    const rel = unir(RUTAS.buzon, correo.id, nombre)
    const texto = existe(ctx, rel) ? leerTexto(ctx, rel) : ""
    const esContrato = NOMBRE_CONTRACTUAL.test(nombre) || ENCABEZADO_CONTRACTUAL.test(texto)
    return { nombre, ruta: rel, texto, esContrato }
  })
}

export function adjuntoContrato(ctx: ContextoHerramienta, correo: Correo): Adjunto | null {
  return leerAdjuntos(ctx, correo).find((a) => a.esContrato) ?? null
}

export function motivoSinContrato(adjuntos: Adjunto[]): string {
  if (adjuntos.length === 0) return "el correo no trae adjuntos"
  const nombres = adjuntos.map((a) => a.nombre).join(", ")
  return `ningún adjunto es un contrato u otrosí (${nombres})`
}

export function leerComerciales(ctx: ContextoHerramienta): Comercial[] {
  return leerJson<Comercial[]>(ctx, RUTAS.comerciales, [])
}

export function resolverComercial(ctx: ContextoHerramienta, email: string): Comercial | null {
  const buscado = email.trim().toLowerCase()
  return leerComerciales(ctx).find((c) => c.email.toLowerCase() === buscado) ?? null
}

export function leerProcesados(ctx: ContextoHerramienta): Procesados {
  return leerJson<Procesados>(ctx, RUTAS.procesados, {})
}

export function marcarProcesado(ctx: ContextoHerramienta, mensajeId: string, marca: MarcaProcesado): void {
  const procesados = leerProcesados(ctx)
  procesados[mensajeId] = marca
  escribirTexto(ctx, RUTAS.procesados, `${JSON.stringify(procesados, null, 2)}\n`)
}
