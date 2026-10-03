/**
 * Proveedor SIMULADO: implementa ProveedorLLM con reglas deterministas en lugar de un modelo.
 * Sirve para probar el chat web completo (herramientas, confirmación, alertas) sin clave ni costo.
 * Usa el mismo ciclo, las mismas herramientas y la misma guarda de confirmación que el modelo real.
 */
import type { DefinicionHerramienta, LlamadaHerramienta, MensajeLLM, ProveedorLLM, RespuestaLLM } from "./adapter"

type Datos = Record<string, unknown>
type Resultado = { ok: true; data: Datos } | { ok: false; error: string }

interface Llamada {
  id: string
  nombre: string
  argumentos: Datos
  resultado?: Resultado
}

interface MensajeBuzon {
  id: string
  de: string
  comercial: string | null
  tiene_contrato: boolean
}

const FECHA_REFERENCIA = /(?:\bhoy|referencia|\bal)\D{0,20}?(\d{4}-\d{2}-\d{2})/gi
const PAUSA_MS = 250

// ───────────────────────── lectura de la conversación ─────────────────────────

function textosUsuario(mensajes: MensajeLLM[]): string[] {
  return mensajes.flatMap((m) => (m.rol === "usuario" ? [m.texto] : []))
}

/** Empareja cada llamada a herramienta con su resultado. */
function llamadas(mensajes: MensajeLLM[]): Llamada[] {
  const porId = new Map<string, Llamada>()
  for (const m of mensajes) {
    if (m.rol === "asistente") {
      for (const l of m.llamadas) porId.set(l.id, { id: l.id, nombre: l.nombre, argumentos: (l.argumentos ?? {}) as Datos })
    } else if (m.rol === "herramientas") {
      for (const r of m.resultados) {
        const l = porId.get(r.id)
        if (l) l.resultado = JSON.parse(r.contenido) as Resultado
      }
    }
  }
  return [...porId.values()]
}

function turnoActual(mensajes: MensajeLLM[]): MensajeLLM[] {
  const inicio = mensajes.findLastIndex((m) => m.rol === "usuario")
  return mensajes.slice(inicio)
}

function datos<T>(l: Llamada | undefined): T | null {
  return l?.resultado?.ok ? (l.resultado.data as T) : null
}

function de(ls: Llamada[], nombre: string): Llamada[] {
  return ls.filter((l) => l.nombre === nombre)
}

function porMensaje(ls: Llamada[], nombre: string, id: string): Llamada | undefined {
  return ls.findLast((l) => l.nombre === nombre && l.argumentos.mensaje_id === id)
}

/** Fecha de referencia: la última dada como "hoy …", "al …" o "referencia …"; si no, la del sistema. */
function fechaHoy(mensajes: MensajeLLM[]): string {
  const fechas = textosUsuario(mensajes).flatMap((t) => [...t.matchAll(FECHA_REFERENCIA)].map((m) => m[1]!))
  return fechas.at(-1) ?? new Date().toISOString().slice(0, 10)
}

// ───────────────────────── construcción de respuestas ─────────────────────────

function llamar(nombre: string, argumentos: Datos): LlamadaHerramienta {
  return { id: `sim_${crypto.randomUUID()}`, nombre, argumentos }
}

function responder(texto: string, ls: LlamadaHerramienta[] = []): RespuestaLLM {
  return { texto, llamadas: ls, nativo: undefined, uso: { entrada: 0, salida: 0 }, fin: ls.length ? "herramientas" : "fin_turno" }
}

const PIE = "\n\n_Modo simulado: respuesta armada por reglas a partir de los resultados de las herramientas, sin LLM._"

function celda(texto: unknown): string {
  return String(texto ?? "—").replace(/\|/g, "\\|").replace(/\n/g, " ")
}

function fila(celdas: unknown[]): string {
  return `| ${celdas.map(celda).join(" | ")} |`
}

function tabla(encabezados: string[], filas: unknown[][]): string {
  return [fila(encabezados), fila(encabezados.map(() => "---")), ...filas.map(fila)].join("\n")
}

// ───────────────────────── resúmenes ─────────────────────────

interface Validacion {
  clasificacion: string
  motivo: string
  requiere_revision: string[]
  detalle_revision: Record<string, string>
  advertencias: string[]
}

function accion(ls: Llamada[], id: string, v: Validacion | null): string {
  const reg = porMensaje(ls, "contratos_registrar", id)
  if (reg?.resultado?.ok) {
    const d = reg.resultado.data as { accion: string; id_contrato: string | null }
    return `${d.accion}${d.id_contrato ? ` ${d.id_contrato}` : ""}`
  }
  if (reg && !reg.resultado?.ok) return "⏸ sin registrar (requiere revisión)"
  if (v?.requiere_revision.length) return "⏸ sin registrar (requiere revisión)"
  return "—"
}

function tablaMensajes(ls: Llamada[], mensajes: MensajeBuzon[]): string {
  const filas = mensajes.map((m) => {
    const val = porMensaje(ls, "contratos_validar", m.id)
    const v = datos<Validacion>(val)
    const error = val?.resultado && !val.resultado.ok ? val.resultado.error : null
    const obs = error ?? [v?.motivo, ...(v?.advertencias ?? [])].filter(Boolean).join("; ")
    return [m.id, m.comercial ?? `${m.de} (no registrado)`, v?.clasificacion ?? "error", accion(ls, m.id, v), obs]
  })
  return tabla(["Mensaje", "Remitente", "Clasificación", "Acción", "Observaciones"], filas)
}

interface ContratoExtraido extends Datos {
  confianza: Record<string, number>
  evidencia?: Record<string, string>
}

function detalleRevision(ls: Llamada[], id: string, v: Validacion): string {
  const c = datos<ContratoExtraido>(porMensaje(ls, "contratos_extraer", id))
  const filas = v.requiere_revision.map((campo) => [
    campo,
    c?.[campo] ?? "—",
    c?.confianza[campo] ?? "—",
    c?.evidencia?.[campo] ?? v.detalle_revision[campo],
  ])
  const propuesta = v.requiere_revision
    .map((campo) => `${campo.startsWith("fecha") ? "la" : "el"} ${campo.replace("_", " ")} ${c?.[campo] ?? "?"}`)
    .join(" y ")
  return [
    `### ${id} requiere revisión antes de registrarse`,
    "",
    tabla(["Campo", "Valor propuesto", "Confianza", "Evidencia"], filas),
    "",
    `**¿Confirmas para ${id} ${propuesta}?** Responde, por ejemplo: «confirmo ${propuesta}». Si algún valor es otro, escríbelo (p. ej. «confirmo el valor 0 y la fecha fin 2027-12-31»).`,
  ].join("\n")
}

interface Alertas {
  ruta: string
  hoy: string
  vencen: { id_contrato: string; cliente: string; fecha_fin: string; dias_restantes: number }[]
  polizas_pendientes: { id_contrato: string; tipo_poliza: string; estado_poliza: string }[]
  registrados_desde_corte: { id_contrato: string; cliente: string }[]
}

function resumenAlertas(ls: Llamada[]): string {
  const llamada = de(ls, "contratos_alertas").at(-1)
  const a = datos<Alertas>(llamada)
  if (!a) return llamada?.resultado && !llamada.resultado.ok ? `No pude generar alertas: ${llamada.resultado.error}` : ""
  const lista = (xs: string[]) => (xs.length ? xs.join(", ") : "ninguno")
  return [
    `### Alertas al ${a.hoy} (\`${a.ruta}\`)`,
    "",
    `- **Vencen en ≤ 60 días:** ${lista(a.vencen.map((v) => `${v.id_contrato} – ${v.cliente} (${v.fecha_fin}, ${v.dias_restantes} días)`))}`,
    `- **Pólizas exigidas no vigentes:** ${lista(a.polizas_pendientes.map((p) => `${p.id_contrato} (${p.tipo_poliza}, ${p.estado_poliza})`))}`,
    `- **Registrados desde el corte 2026-05-30:** ${lista(a.registrados_desde_corte.map((r) => `${r.id_contrato} – ${r.cliente}`))}`,
  ].join("\n")
}

// ───────────────────────── intención: procesar el buzón ─────────────────────────

function siguientePaso(ls: Llamada[], hoy: string): LlamadaHerramienta[] | null {
  const buzon = datos<{ mensajes: MensajeBuzon[] }>(de(ls, "contratos_leer_buzon")[0])
  if (!de(ls, "contratos_leer_buzon").length) return [llamar("contratos_leer_buzon", {})]
  const mensajes = buzon?.mensajes ?? []
  const pasos: [string, () => LlamadaHerramienta[]][] = [
    ["contratos_extraer", () => mensajes.filter((m) => m.tiene_contrato).map((m) => llamar("contratos_extraer", { mensaje_id: m.id }))],
    ["contratos_validar", () => mensajes.map((m) => llamar("contratos_validar", conContrato(ls, m.id)))],
    ["contratos_registrar", () => mensajes.filter((m) => registrable(ls, m.id)).map((m) => llamar("contratos_registrar", { ...conContrato(ls, m.id), hoy }))],
    ["contratos_alertas", () => [llamar("contratos_alertas", { hoy })]],
  ]
  for (const [nombre, generar] of pasos) {
    if (de(ls, nombre).length) continue
    const nuevas = generar()
    if (nuevas.length) return nuevas
  }
  return null
}

function conContrato(ls: Llamada[], id: string): Datos {
  const contrato = datos<Datos>(porMensaje(ls, "contratos_extraer", id))
  return contrato ? { mensaje_id: id, contrato } : { mensaje_id: id }
}

function registrable(ls: Llamada[], id: string): boolean {
  const v = datos<Validacion>(porMensaje(ls, "contratos_validar", id))
  return v !== null && v.requiere_revision.length === 0
}

function procesar(turno: Llamada[], hoy: string): RespuestaLLM {
  const paso = siguientePaso(turno, hoy)
  if (paso) return responder("", paso)
  const mensajes = datos<{ mensajes: MensajeBuzon[] }>(de(turno, "contratos_leer_buzon")[0])?.mensajes ?? []
  if (mensajes.length === 0) return responder(`No hay mensajes pendientes en el buzón.\n\n${resumenAlertas(turno)}${PIE}`)
  const revisiones = mensajes.flatMap((m) => {
    const v = datos<Validacion>(porMensaje(turno, "contratos_validar", m.id))
    return v?.requiere_revision.length ? [detalleRevision(turno, m.id, v)] : []
  })
  const texto = [
    `Procesé ${mensajes.length} mensajes del buzón con fecha de referencia **${hoy}**.`,
    tablaMensajes(turno, mensajes),
    ...revisiones,
    resumenAlertas(turno),
  ].join("\n\n")
  return responder(texto + PIE)
}

// ───────────────────────── intención: confirmar ─────────────────────────

function pendientes(historia: Llamada[]): string[] {
  const ids = new Set<string>()
  for (const l of historia) {
    const id = String(l.argumentos.mensaje_id ?? "")
    if (!id || !l.resultado) continue
    const r = l.resultado
    if (l.nombre === "contratos_validar" && r.ok && (r.data.requiere_revision as string[]).length) ids.add(id)
    if (l.nombre === "contratos_registrar" && !r.ok && r.error.startsWith("requiere revisión")) ids.add(id)
    if (l.nombre === "contratos_registrar" && (r.ok || r.error.includes("ya fue procesado"))) ids.delete(id)
  }
  return [...ids]
}

/** Valores que el usuario dictó explícitamente. */
function valoresDictados(texto: string): Datos {
  const cambios: Datos = {}
  const valor = /valor(?:\s+(?:de|en|es|=|:))?\s*\$?\s*(\d[\d.,]*)/i.exec(texto)?.[1]
  if (valor) cambios.valor = Number(valor.replace(/[.,](?=\d{3}(\D|$))/g, "").replace(",", "."))
  const fin = /fecha[\s_]*fin(?:al)?\D{0,20}(\d{4}-\d{2}-\d{2})/i.exec(texto)?.[1]
  if (fin) cambios.fecha_fin = fin
  const inicio = /fecha[\s_]*(?:de\s+)?inicio\D{0,20}(\d{4}-\d{2}-\d{2})/i.exec(texto)?.[1]
  if (inicio) cambios.fecha_inicio = inicio
  return cambios
}

function confirmar(historia: Llamada[], turno: Llamada[], texto: string, hoy: string): RespuestaLLM {
  const idsTurno = new Set(turno.map((l) => l.id))
  const abiertos = pendientes(historia.filter((l) => !idsTurno.has(l.id)))
  const mencionados = abiertos.filter((id) => texto.includes(id))
  const objetivo = mencionados.length ? mencionados : abiertos
  if (objetivo.length === 0) return responder(`No hay contratos esperando confirmación. Pídeme «procesa el buzón».${PIE}`)
  if (!de(turno, "contratos_registrar").length) {
    const cambios = valoresDictados(texto)
    return responder("", objetivo.map((id) => {
      const contrato = datos<Datos>(porMensaje(historia, "contratos_extraer", id))
      return llamar("contratos_registrar", { mensaje_id: id, ...(contrato ? { contrato: { ...contrato, ...cambios } } : {}), confirmado: true, hoy })
    }))
  }
  if (!de(turno, "contratos_alertas").length) return responder("", [llamar("contratos_alertas", { hoy })])
  const lineas = de(turno, "contratos_registrar").map((l) => {
    const r = l.resultado
    if (r?.ok) return `- ✅ **${l.argumentos.mensaje_id}** → ${r.data.accion} ${r.data.id_contrato} · archivado en \`${r.data.ruta_archivo}\``
    return `- ❌ **${l.argumentos.mensaje_id}**: ${r && !r.ok ? r.error : "sin resultado"}`
  })
  return responder(["Listo, con tu confirmación:", ...lineas, "", resumenAlertas(turno)].join("\n") + PIE)
}

// ───────────────────────── intención: solo alertas ─────────────────────────

function soloAlertas(turno: Llamada[], hoy: string): RespuestaLLM {
  if (!de(turno, "contratos_alertas").length) return responder("", [llamar("contratos_alertas", { hoy })])
  return responder(resumenAlertas(turno) + PIE)
}

const AYUDA = `Estoy en **modo simulado** (sin LLM). Entiendo estas instrucciones:

- «Procesa el buzón de contratos con fecha de hoy 2026-09-03» → leo, extraigo, valido, registro lo limpio y genero alertas.
- «Confirmo el valor 0 y la fecha fin 2027-08-31» → registro lo que quedó en revisión con esos valores.
- «Genera las alertas al 2026-09-03» → solo el reporte de alertas.`

// ───────────────────────── proveedor ─────────────────────────

export class ProveedorSimulado implements ProveedorLLM {
  readonly proveedor = "simulado"
  readonly modelo = "reglas-deterministas"

  async enviar(mensajes: MensajeLLM[], _herramientas: DefinicionHerramienta[]): Promise<RespuestaLLM> {
    await Bun.sleep(PAUSA_MS)
    const texto = textosUsuario(mensajes).at(-1) ?? ""
    const historia = llamadas(mensajes)
    const turno = llamadas(turnoActual(mensajes))
    const hoy = fechaHoy(mensajes)
    if (/confirm|^\s*s[ií]\b/i.test(texto)) return confirmar(historia, turno, texto, hoy)
    if (/buz[oó]n|procesa|pendiente/i.test(texto)) return procesar(turno, hoy)
    if (/alerta|vencen|p[oó]liza/i.test(texto)) return soloAlertas(turno, hoy)
    return responder(AYUDA)
  }
}
