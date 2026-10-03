import { z } from "zod"

export const PAISES = ["CO", "EC", "PE", "PA", "HN"] as const
export const MONEDAS = ["COP", "USD", "PEN", "PAB", "HNL"] as const
export const ESTADOS_POLIZA = ["vigente", "pendiente", "vencida", "no_aplica"] as const
export const TIPOS_DOCUMENTO = ["contrato", "contrato_marco", "otrosi"] as const
export const CLASIFICACIONES = ["nuevo", "actualizacion", "duplicado", "rechazado"] as const

/** Umbral de RN5: por debajo de este valor un campo exige revisión humana. */
export const UMBRAL_CONFIANZA = 0.8

/** Campos del contrato que llevan confianza propia. */
export const CAMPOS_CONTRATO = [
  "id_contrato",
  "cliente",
  "nit_cliente",
  "pais",
  "objeto",
  "valor",
  "moneda",
  "fecha_inicio",
  "fecha_fin",
  "requiere_poliza",
  "tipo_poliza",
] as const
export type CampoContrato = (typeof CAMPOS_CONTRATO)[number]

const fechaIso = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "fecha debe tener formato YYYY-MM-DD")

export const ContratoSchema = z.object({
  tipo_documento: z.enum(TIPOS_DOCUMENTO).describe("contrato, contrato_marco u otrosi"),
  id_contrato: z.string().nullable().describe("Número del contrato tal como aparece en el documento"),
  cliente: z.string().nullable().describe("Razón social de la contraparte"),
  nit_cliente: z.string().nullable().describe("Identificador tributario sin dígito de verificación ni puntos"),
  pais: z.enum(PAISES).nullable().describe("País de la contraparte"),
  objeto: z.string().max(200).nullable().describe("Objeto del contrato, máximo 200 caracteres"),
  valor: z.number().nonnegative().nullable().describe("Valor sin separadores; 0 si es por demanda"),
  valor_indeterminado: z.boolean().describe("true si el contrato no tiene valor determinado (por demanda)"),
  moneda: z.enum(MONEDAS).nullable().describe("Moneda del valor"),
  fecha_inicio: fechaIso.nullable().describe("Fecha de inicio YYYY-MM-DD"),
  fecha_fin: fechaIso.nullable().describe("Fecha de fin YYYY-MM-DD"),
  plazo_meses: z.number().int().positive().nullable().describe("Plazo en meses si el documento lo expresa así"),
  requiere_poliza: z.boolean().nullable().describe("true si el contrato exige constituir pólizas"),
  tipo_poliza: z.string().describe("Tipos de póliza separados por ';' (vacío si no aplica)"),
  confianza: z
    .record(z.string(), z.number().min(0).max(1))
    .describe("Confianza en [0,1] por campo, tal como la devolvió contratos_extraer"),
  evidencia: z
    .record(z.string(), z.string())
    .optional()
    .describe("Fragmento del documento que respalda cada campo"),
  advertencias: z.array(z.string()).optional().describe("Notas de la extracción"),
})
export type Contrato = z.infer<typeof ContratoSchema>

export type Pais = (typeof PAISES)[number]
export type Moneda = (typeof MONEDAS)[number]
export type EstadoPoliza = (typeof ESTADOS_POLIZA)[number]
export type Clasificacion = (typeof CLASIFICACIONES)[number]

/** Fila del maestro tal como se guarda en el CSV (sección 7.2 del PRD). */
export interface FilaMaestro {
  id_contrato: string
  cliente: string
  nit_cliente: string
  pais: string
  objeto: string
  valor: string
  moneda: string
  fecha_inicio: string
  fecha_fin: string
  requiere_poliza: string
  tipo_poliza: string
  estado_poliza: string
  comercial: string
  ruta_sharepoint: string
  fecha_registro: string
  fuente: string
}

export const COLUMNAS_MAESTRO: (keyof FilaMaestro)[] = [
  "id_contrato",
  "cliente",
  "nit_cliente",
  "pais",
  "objeto",
  "valor",
  "moneda",
  "fecha_inicio",
  "fecha_fin",
  "requiere_poliza",
  "tipo_poliza",
  "estado_poliza",
  "comercial",
  "ruta_sharepoint",
  "fecha_registro",
  "fuente",
]

export interface ContextoHerramienta {
  /** Raíz del proyecto: todas las rutas se resuelven desde aquí. */
  directory: string
  sessionId: string
}

/** Error esperable (dato de entrada malo): se informa tal cual, sin prefijo de error interno. */
export class ErrorNegocio extends Error {}

export type Resultado<T> = { ok: true; data: T } | { ok: false; error: string }

export function ok<T>(data: T): Resultado<T> {
  return { ok: true, data }
}

export function fallo<T = never>(error: string): Resultado<T> {
  return { ok: false, error }
}
