/**
 * Extracción determinista (regex + heurísticas) sobre el texto del contrato.
 * Cada campo devuelve valor, confianza y evidencia; lo ausente es null con confianza 0.
 */
import {
  MONEDAS,
  type CampoContrato,
  type Contrato,
  type Moneda,
  type Pais,
  type Resultado,
  fallo,
  ok,
} from "./tipos"
import {
  MESES,
  aIso,
  fechaValida,
  finDePlazo,
  parsearMonto,
  recortar,
  tituloRazonSocial,
  ultimoDiaDelMes,
} from "./texto"

interface Hallazgo<T> {
  valor: T
  confianza: number
  evidencia: string
}

const AUSENTE: Hallazgo<null> = { valor: null, confianza: 0, evidencia: "no encontrado en el texto" }

const NIT_PERIFERIA = "900123456"

class ErrorExtraccion extends Error {}

// ───────────────────────── utilidades de cláusulas ─────────────────────────

function parrafos(texto: string): string[] {
  return texto.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean)
}

/** Párrafo cuyo título (en mayúsculas) es la cláusula buscada: "SEGUNDA. VALOR." o "(VALOR)". */
function clausula(ps: string[], titulo: string): string | null {
  const patron = new RegExp(`(^|[.(]\\s*)${titulo}[.)]`, "u")
  return ps.find((p) => patron.test(p)) ?? null
}

function despuesDeTitulo(p: string, titulo: string): string {
  const i = p.search(new RegExp(`${titulo}[.)]`, "u"))
  return i < 0 ? p : p.slice(i + titulo.length + 1).trim()
}

function fragmento(texto: string, max = 160): string {
  return recortar(texto.replace(/\s+/g, " ").trim(), max)
}

// ───────────────────────── tipo e identificador ─────────────────────────

function primeraLinea(texto: string): string {
  return texto.split("\n").find((l) => l.trim() !== "")?.trim() ?? ""
}

function detectarTipo(texto: string): Contrato["tipo_documento"] {
  const linea = primeraLinea(texto)
  if (/^(otros[ií]|adenda|modificatorio)/i.test(linea)) return "otrosi"
  if (/contrato marco/i.test(linea)) return "contrato_marco"
  return "contrato"
}

const CODIGO = /\b[A-Z]{1,5}-\d{4}-\d{1,4}\b/g

function extraerId(texto: string): Hallazgo<string | null> {
  const linea = primeraLinea(texto)
  const enTitulo = linea.match(CODIGO)
  // En un otrosí el título nombra primero el otrosí y al final el contrato modificado.
  if (enTitulo?.length) return { valor: enTitulo[enTitulo.length - 1]!, confianza: 0.95, evidencia: linea }
  const enCuerpo = /No\.\s*([A-Z]{1,5}-\d{4}-\d{1,4})/.exec(texto)
  if (enCuerpo) return { valor: enCuerpo[1]!, confianza: 0.85, evidencia: fragmento(enCuerpo[0]) }
  return AUSENTE
}

// ───────────────────────── partes ─────────────────────────

interface Parte {
  nombre: string
  tipoId: string
  numero: string
  contexto: string
}

const PARTE =
  /([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ0-9.&\s]+?),\s*(?:identificad[ao]\s+con\s+)?(NIT|RUC|RTN)\s*(?:No\.\s*)?([\d.\-]+\d)/gu

function partes(texto: string): Parte[] {
  return [...texto.matchAll(PARTE)].map((m) => ({
    nombre: m[1]!.replace(/\s+/g, " ").trim(),
    tipoId: m[2]!,
    numero: m[3]!,
    contexto: texto.slice(m.index ?? 0, (m.index ?? 0) + m[0].length + 120),
  }))
}

function limpiarIdentificador(p: Parte): string {
  const sinDv = p.tipoId === "NIT" ? p.numero.replace(/-\d$/, "") : p.numero
  return sinDv.replace(/[.\-]/g, "")
}

function contraparte(texto: string): Parte | null {
  return (
    partes(texto).find((p) => !/PERIFERIA/.test(p.nombre) && limpiarIdentificador(p) !== NIT_PERIFERIA) ??
    null
  )
}

function escaparRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Busca la razón social escrita en mayúsculas/minúsculas (p. ej. en el bloque de firmas). */
function extraerCliente(texto: string, parte: Parte | null): Hallazgo<string | null> {
  if (!parte) return AUSENTE
  const patron = new RegExp(escaparRegex(parte.nombre), "giu")
  const conFormato = [...texto.matchAll(patron)].map((m) => m[0]).find((s) => s !== s.toUpperCase())
  if (conFormato) return { valor: conFormato, confianza: 0.95, evidencia: fragmento(parte.contexto) }
  return { valor: tituloRazonSocial(parte.nombre), confianza: 0.85, evidencia: fragmento(parte.contexto) }
}

function extraerNit(parte: Parte | null): Hallazgo<string | null> {
  if (!parte) return AUSENTE
  return { valor: limpiarIdentificador(parte), confianza: 0.95, evidencia: `${parte.tipoId} ${parte.numero}` }
}

// ───────────────────────── país ─────────────────────────

function paisPorIdentificador(p: Parte): Pais | null {
  const digitos = limpiarIdentificador(p)
  if (p.tipoId === "NIT") return "CO"
  if (p.tipoId === "RTN" || digitos.length === 14) return "HN"
  if (p.tipoId === "RUC" && digitos.length === 13) return "EC"
  if (p.tipoId === "RUC" && digitos.length === 11) return "PE"
  if (p.tipoId === "RUC" && /-/.test(p.numero)) return "PA"
  return null
}

const LUGARES: [RegExp, Pais][] = [
  [/colombia|bogot[aá]|medell[ií]n|barranquilla|cali\b|cartagena|bucaramanga/i, "CO"],
  [/ecuador|quito|guayaquil|cuenca/i, "EC"],
  [/per[uú]\b|lima\b|arequipa/i, "PE"],
  [/panam[aá]/i, "PA"],
  [/honduras|tegucigalpa|san pedro sula/i, "HN"],
]

function paisPorDomicilio(contexto: string): Pais | null {
  const domicilio = /domicilio en ([^,]+(?:,\s*[^,]+)?)/i.exec(contexto)?.[1] ?? ""
  return LUGARES.find(([re]) => re.test(domicilio))?.[1] ?? null
}

function extraerPais(parte: Parte | null): Hallazgo<Pais | null> {
  if (!parte) return AUSENTE
  const porId = paisPorIdentificador(parte)
  const porLugar = paisPorDomicilio(parte.contexto)
  const evidencia = fragmento(parte.contexto)
  if (porId && porLugar && porId !== porLugar) return { valor: porId, confianza: 0.5, evidencia }
  if (porId && porLugar) return { valor: porId, confianza: 0.95, evidencia }
  const valor = porId ?? porLugar
  return valor ? { valor, confianza: 0.85, evidencia } : AUSENTE
}

// ───────────────────────── objeto ─────────────────────────

const PREFIJOS_OBJETO = [
  /^[^.]{0,80}?EL CONTRATISTA\s+(se obliga a\s+(ejecutar|prestar|realizar)|prestará|ejecutará|realizará)\s+/i,
  /^(el |los )?servicios? de\s+/i,
  /^(la|el|los|las)\s+/i,
]

function limpiarObjeto(crudo: string): string {
  let s = crudo.trim().replace(/\.$/, "")
  for (const re of PREFIJOS_OBJETO) s = s.replace(re, "")
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function extraerObjeto(ps: string[]): Hallazgo<string | null> {
  const p = clausula(ps, "OBJETO")
  if (!p) return AUSENTE
  const limpio = limpiarObjeto(despuesDeTitulo(p, "OBJETO"))
  if (!limpio) return AUSENTE
  const recortado = limpio.length > 200
  return { valor: recortar(limpio, 200), confianza: recortado ? 0.85 : 0.9, evidencia: fragmento(p) }
}

// ───────────────────────── valor y moneda ─────────────────────────

interface ValorMoneda {
  valor: Hallazgo<number | null>
  moneda: Hallazgo<Moneda | null>
  indeterminado: boolean
}

const MONTO = /\b([A-Z]{3})\s*\$?\s*(\d[\d.,]*\d)/gu
const INDETERMINADO =
  /no tiene (un )?valor determinado|valor indeterminado|cuant[ií]a indeterminada|por demanda|seg[uú]n (la|las|cada) [oó]rden/i
const MONEDA_POR_PAIS: Record<Pais, Moneda> = { CO: "COP", EC: "USD", PE: "PEN", PA: "USD", HN: "HNL" }

function esMoneda(codigo: string): codigo is Moneda {
  return (MONEDAS as readonly string[]).includes(codigo)
}

function montoExplicito(p: string): ValorMoneda | null {
  const m = [...p.matchAll(MONTO)].find((x) => !["IVA", "NIT", "RUC"].includes(x[1]!))
  if (!m) return null
  const codigo = m[1]!
  const crudo = m[2]!
  if (!esMoneda(codigo)) throw new ErrorExtraccion(`moneda desconocida "${codigo}" en: ${fragmento(m[0], 80)}`)
  const numero = parsearMonto(crudo)
  const evidencia = fragmento(m[0], 80)
  return {
    valor: numero === null ? { valor: null, confianza: 0.3, evidencia } : { valor: numero, confianza: 0.95, evidencia },
    moneda: { valor: codigo, confianza: 0.95, evidencia },
    indeterminado: false,
  }
}

/** Contrato por demanda: valor 0 y moneda inferida de otras menciones del documento. */
function valorIndeterminado(p: string, texto: string, pais: Pais | null): ValorMoneda {
  const menciones = [...new Set([...texto.matchAll(MONTO)].map((m) => m[1]!).filter(esMoneda))]
  const deducida = menciones.length === 1 ? menciones[0]! : pais ? MONEDA_POR_PAIS[pais] : null
  const coherente = menciones.length === 1 && (!pais || MONEDA_POR_PAIS[pais] === deducida)
  return {
    valor: { valor: 0, confianza: 0.5, evidencia: `valor por demanda: ${fragmento(p, 120)}` },
    moneda: deducida
      ? {
          valor: deducida,
          confianza: coherente ? 0.85 : 0.6,
          evidencia: coherente ? `única moneda mencionada en el documento (${deducida})` : "inferida del país",
        }
      : AUSENTE,
    indeterminado: true,
  }
}

function extraerValor(ps: string[], texto: string, pais: Pais | null): ValorMoneda {
  const p = clausula(ps, "VALOR")
  if (!p) return { valor: AUSENTE, moneda: AUSENTE, indeterminado: false }
  if (INDETERMINADO.test(p)) return valorIndeterminado(p, texto, pais)
  return montoExplicito(p) ?? { valor: AUSENTE, moneda: AUSENTE, indeterminado: false }
}

// ───────────────────────── fechas y plazo ─────────────────────────

const NOMBRES_MES = Object.keys(MESES).join("|")
const FECHA = new RegExp(
  `\\(?(\\d{1,2})\\)?\\s+(?:d[ií]as\\s+del\\s+mes\\s+)?de\\s+(${NOMBRES_MES})\\s+(?:de|del)\\s+(\\d{4})`,
  "giu",
)
const MES_SOLO = new RegExp(`en el mes de (${NOMBRES_MES}) de (\\d{4})`, "iu")

interface FechaEncontrada {
  iso: string
  indice: number
  texto: string
}

function fechasEn(texto: string): FechaEncontrada[] {
  return [...texto.matchAll(FECHA)].map((m) => {
    const iso = aIso(Number(m[3]), MESES[m[2]!.toLowerCase()]!, Number(m[1]))
    if (!fechaValida(iso)) throw new ErrorExtraccion(`fecha inválida en el documento: "${m[0]}"`)
    return { iso, indice: m.index ?? 0, texto: m[0] }
  })
}

function fechaTras(texto: string, palabra: RegExp): FechaEncontrada | null {
  const m = palabra.exec(texto)
  if (!m) return null
  return fechasEn(texto.slice(m.index)).at(0) ?? null
}

function plazoEnMeses(p: string): number | null {
  const m = /\(?(\d{1,3})\)?\s+mes(es)?\b/i.exec(p)
  return m ? Number(m[1]) : null
}

interface Plazo {
  inicio: Hallazgo<string | null>
  fin: Hallazgo<string | null>
  meses: number | null
  advertencias: string[]
}

function plazoDesdeFirma(texto: string, meses: number, p: string): Plazo {
  const advertencias = /prorrogab|pr[oó]rroga autom/i.test(p) ? ["el plazo se prorroga automáticamente"] : []
  const firma = fechaTras(texto, /se firma|firmad[oa]|suscri/i)
  if (firma) {
    return {
      inicio: { valor: firma.iso, confianza: 0.85, evidencia: `inicio = fecha de firma: ${firma.texto}` },
      fin: { valor: finDePlazo(firma.iso, meses), confianza: 0.8, evidencia: `${meses} meses desde la firma` },
      meses,
      advertencias,
    }
  }
  const mes = MES_SOLO.exec(texto)
  if (!mes) return { inicio: AUSENTE, fin: AUSENTE, meses, advertencias }
  const [anio, numMes] = [Number(mes[2]), MESES[mes[1]!.toLowerCase()]!]
  const finAnio = anio + Math.floor((numMes - 1 + meses) / 12)
  const finMes = ((numMes - 1 + meses) % 12) + 1
  return {
    inicio: {
      valor: aIso(anio, numMes, 1),
      confianza: 0.8,
      evidencia: `firma "${mes[0]}": día no especificado, se toma el día 1`,
    },
    fin: {
      valor: aIso(finAnio, finMes, ultimoDiaDelMes(finAnio, finMes)),
      confianza: 0.5,
      evidencia: `${meses} meses desde una firma sin día exacto; se propone el último día del mes`,
    },
    meses,
    advertencias: [...advertencias, "fecha de firma sin día exacto"],
  }
}

function extraerPlazo(ps: string[], texto: string): Plazo {
  const p = clausula(ps, "PLAZO")
  if (!p) return { inicio: AUSENTE, fin: AUSENTE, meses: null, advertencias: [] }
  const meses = plazoEnMeses(p)
  const desde = fechaTras(p, /\bdesde\b/i)
  const hasta = fechaTras(p, /\bhasta\b/i)
  if (!desde && !hasta && meses && /firma|suscripci[oó]n/i.test(p)) return plazoDesdeFirma(texto, meses, p)
  const inicio: Hallazgo<string | null> = desde
    ? { valor: desde.iso, confianza: 0.95, evidencia: desde.texto }
    : AUSENTE
  if (hasta) return { inicio, fin: { valor: hasta.iso, confianza: 0.95, evidencia: hasta.texto }, meses, advertencias: [] }
  if (desde && meses) {
    const fin = finDePlazo(desde.iso, meses)
    return { inicio, fin: { valor: fin, confianza: 0.85, evidencia: `${meses} meses desde ${desde.iso}` }, meses, advertencias: [] }
  }
  return { inicio, fin: AUSENTE, meses, advertencias: [] }
}

// ───────────────────────── pólizas ─────────────────────────

const TIPOS_POLIZA: [RegExp, string][] = [
  [/cumplimiento/i, "cumplimiento"],
  [/calidad/i, "calidad"],
  [/salarios|prestaciones sociales/i, "salarios_prestaciones"],
  [/responsabilidad civil/i, "responsabilidad_civil"],
  [/anticipo/i, "buen_manejo_anticipo"],
  [/estabilidad/i, "estabilidad"],
]
const CONDICIONAL = /cuyo valor supere|en caso de que|siempre que|cuando el valor|si el valor/i

interface Poliza {
  requiere: Hallazgo<boolean | null>
  tipos: string
  advertencias: string[]
}

function extraerPoliza(ps: string[], tipo: Contrato["tipo_documento"]): Poliza {
  const p = clausula(ps, "GARANTÍAS") ?? clausula(ps, "GARANTIAS") ?? ps.find((x) => /p[oó]liza|garant[ií]a/i.test(x))
  if (!p) {
    if (tipo === "otrosi") return { requiere: AUSENTE, tipos: "", advertencias: [] }
    return {
      requiere: { valor: false, confianza: 0.9, evidencia: "el contrato no tiene cláusula de garantías ni menciona pólizas" },
      tipos: "",
      advertencias: [],
    }
  }
  const tipos = TIPOS_POLIZA.filter(([re]) => re.test(p)).map(([, t]) => t).join(";")
  const condicional = CONDICIONAL.test(p)
  return {
    requiere: { valor: true, confianza: condicional ? 0.85 : 0.95, evidencia: fragmento(p) },
    tipos,
    advertencias: condicional ? ["la póliza es condicional (depende del valor de cada orden); se registra como pendiente"] : [],
  }
}

// ───────────────────────── ensamblado ─────────────────────────

function conConfianza(campos: Record<CampoContrato, Hallazgo<unknown>>) {
  const confianza: Record<string, number> = {}
  const evidencia: Record<string, string> = {}
  for (const [campo, h] of Object.entries(campos)) {
    confianza[campo] = h.confianza
    evidencia[campo] = h.evidencia
  }
  return { confianza, evidencia }
}

function construir(texto: string): Contrato {
  const ps = parrafos(texto)
  const tipo = detectarTipo(texto)
  const parte = contraparte(texto)
  const pais = extraerPais(parte)
  const vm = extraerValor(ps, texto, pais.valor)
  const plazo = extraerPlazo(ps, texto)
  const poliza = extraerPoliza(ps, tipo)
  const campos: Record<CampoContrato, Hallazgo<unknown>> = {
    id_contrato: extraerId(texto),
    cliente: extraerCliente(texto, parte),
    nit_cliente: extraerNit(parte),
    pais,
    objeto: extraerObjeto(ps),
    valor: vm.valor,
    moneda: vm.moneda,
    fecha_inicio: plazo.inicio,
    fecha_fin: plazo.fin,
    requiere_poliza: poliza.requiere,
    tipo_poliza: { ...poliza.requiere, valor: poliza.tipos },
  }
  return {
    tipo_documento: tipo,
    id_contrato: campos.id_contrato.valor as string | null,
    cliente: campos.cliente.valor as string | null,
    nit_cliente: campos.nit_cliente.valor as string | null,
    pais: pais.valor,
    objeto: campos.objeto.valor as string | null,
    valor: vm.valor.valor,
    valor_indeterminado: vm.indeterminado,
    moneda: vm.moneda.valor,
    fecha_inicio: plazo.inicio.valor,
    fecha_fin: plazo.fin.valor,
    plazo_meses: plazo.meses,
    requiere_poliza: poliza.requiere.valor,
    tipo_poliza: poliza.tipos,
    ...conConfianza(campos),
    advertencias: [...plazo.advertencias, ...poliza.advertencias],
  }
}

/** Punto de entrada: texto del adjunto → Contrato con confianza por campo. */
export function extraerContrato(texto: string): Resultado<Contrato> {
  if (!texto.trim()) return fallo("el adjunto está vacío: no hay texto que extraer")
  try {
    return ok(construir(texto))
  } catch (e) {
    if (e instanceof ErrorExtraccion) return fallo(e.message)
    throw e
  }
}

