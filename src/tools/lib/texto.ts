/** Utilidades de texto, fechas y números sin dependencias externas. */

export function sinTildes(texto: string): string {
  return texto.normalize("NFD").replace(/[̀-ͯ]/g, "")
}

export function normalizar(texto: string): string {
  return sinTildes(texto).toLowerCase().replace(/\s+/g, " ").trim()
}

const SUFIJOS_SOCIETARIOS = /\b(s\.?\s?a\.?\s?s|s\.?\s?a\.?\s?c|s\.?\s?a|s\.?\s?de\s?r\.?\s?l|ltda|e\.?\s?u)\.?(?=\s|$)/g

/** "Industrias Delta S.A.S." → "industrias-delta" (misma convención del maestro). */
export function slugCliente(cliente: string): string {
  return normalizar(cliente)
    .replace(SUFIJOS_SOCIETARIOS, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

const PALABRAS_VACIAS = new Set([
  "de", "del", "la", "las", "el", "los", "y", "e", "en", "para", "con", "por", "a", "al", "un", "una",
])

function tokens(texto: string): string[] {
  return normalizar(texto)
    .replace(/[^a-z0-9 ]/g, " ")
    .split(" ")
    .filter((t) => t.length > 1 && !PALABRAS_VACIAS.has(t))
}

/** Coeficiente de Dice sobre palabras significativas, en [0, 1]. */
export function similitud(a: string, b: string): number {
  const ta = new Set(tokens(a))
  const tb = new Set(tokens(b))
  if (ta.size === 0 || tb.size === 0) return 0
  let comunes = 0
  for (const t of ta) if (tb.has(t)) comunes++
  return (2 * comunes) / (ta.size + tb.size)
}

export const MESES: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7,
  agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
}

export function aIso(anio: number, mes: number, dia: number): string {
  return `${anio}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`
}

/** true si la cadena es una fecha YYYY-MM-DD que existe en el calendario. */
export function fechaValida(iso: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return false
  const [anio, mes, dia] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const d = new Date(Date.UTC(anio, mes - 1, dia))
  return d.getUTCFullYear() === anio && d.getUTCMonth() === mes - 1 && d.getUTCDate() === dia
}

function desdeUtc(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export function ultimoDiaDelMes(anio: number, mes: number): number {
  return new Date(Date.UTC(anio, mes, 0)).getUTCDate()
}

/** Suma meses y resta un día: plazo de 12 meses desde 2026-08-15 → 2027-08-14. */
export function finDePlazo(inicioIso: string, meses: number): string {
  const [anio, mes, dia] = inicioIso.split("-").map(Number) as [number, number, number]
  const d = new Date(Date.UTC(anio, mes - 1 + meses, dia))
  d.setUTCDate(d.getUTCDate() - 1)
  return desdeUtc(d)
}

export function diasEntre(desdeIso: string, hastaIso: string): number {
  const ms = Date.parse(`${hastaIso}T00:00:00Z`) - Date.parse(`${desdeIso}T00:00:00Z`)
  return Math.round(ms / 86_400_000)
}

export function sumarDias(iso: string, dias: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + dias)
  return desdeUtc(d)
}

/**
 * Convierte un monto escrito con separadores latinos ("265.000.000") o
 * anglosajones ("120,000.00") a número. Devuelve null si es ambiguo.
 */
export function parsearMonto(crudo: string): number | null {
  const s = crudo.trim().replace(/[.,]$/, "")
  if (/^\d+$/.test(s)) return Number(s)
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(s)) return Number(s.replace(/\./g, "").replace(",", "."))
  if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(s)) return Number(s.replace(/,/g, ""))
  return null
}

const CONECTORES_MINUSCULA = new Set(["de", "del", "la", "las", "los", "y", "e", "en"])

/** "CORPORACIÓN ANDINA DE SERVICIOS S.A." → "Corporación Andina de Servicios S.A." */
export function tituloRazonSocial(mayusculas: string): string {
  return mayusculas
    .toLowerCase()
    .split(" ")
    .map((palabra, i) => {
      if (/^([a-z]\.)+[a-z]?\.?$/.test(palabra)) return palabra.toUpperCase()
      if (i > 0 && CONECTORES_MINUSCULA.has(palabra)) return palabra
      return palabra.charAt(0).toUpperCase() + palabra.slice(1)
    })
    .join(" ")
}

export function recortar(texto: string, max: number): string {
  if (texto.length <= max) return texto
  return `${texto.slice(0, max - 1).trimEnd()}…`
}
