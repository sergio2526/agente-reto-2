/**
 * Demo sin modelo: procesa los 6 mensajes del buzón llamando directamente a las herramientas.
 * Uso: bun run demo.ts
 */
import { rmSync } from "node:fs"
import { join } from "node:path"
import * as contratos from "./src/tools/contratos"
import type { Contrato } from "./src/tools/lib/tipos"

const HOY = "2026-09-03"
const ctx = { directory: import.meta.dir, sessionId: "demo" }

type Respuesta<T> = { ok: true; data: T } | { ok: false; error: string }

interface MensajeBuzon {
  id: string
  asunto: string
  tiene_contrato: boolean
}

interface Validacion {
  clasificacion: string
  requiere_revision: string[]
  advertencias: string[]
}

interface Registro {
  accion: string
  id_contrato: string | null
  ruta_archivo: string | null
}

interface Alertas {
  ruta: string
  vencen: { id_contrato: string; dias_restantes: number }[]
  polizas_pendientes: { id_contrato: string; estado_poliza: string }[]
  registrados_desde_corte: { id_contrato: string }[]
}

function leer<T>(json: string): Respuesta<T> {
  return JSON.parse(json) as Respuesta<T>
}

function titulo(texto: string): void {
  console.log(`\n${"═".repeat(72)}\n${texto}\n${"═".repeat(72)}`)
}

async function procesar(id: string, resumen: string[][]): Promise<Contrato | null> {
  console.log(`\n▶ ${id}`)
  const ext = leer<Contrato>(await contratos.extraer.execute({ mensaje_id: id }, ctx))
  const contrato = ext.ok ? ext.data : undefined
  console.log(`  extraer    → ${ext.ok ? `${ext.data.tipo_documento} ${ext.data.id_contrato}` : ext.error}`)

  const val = leer<Validacion>(await contratos.validar.execute({ mensaje_id: id, contrato }, ctx))
  if (!val.ok) {
    console.log(`  validar    → ERROR ${val.error}`)
    resumen.push([id, "error", "-", val.error])
    return null
  }
  const revision = val.data.requiere_revision.join(", ") || "—"
  console.log(`  validar    → ${val.data.clasificacion} · revisión: ${revision}`)
  for (const a of val.data.advertencias) console.log(`               ⚠ ${a}`)

  const reg = leer<Registro>(await contratos.registrar.execute({ mensaje_id: id, contrato, hoy: HOY }, ctx))
  const accion = reg.ok ? `${reg.data.accion} ${reg.data.id_contrato ?? ""}`.trim() : "SIN REGISTRAR (requiere revisión)"
  console.log(`  registrar  → ${reg.ok ? `${accion}${reg.data.ruta_archivo ? ` · ${reg.data.ruta_archivo}` : ""}` : reg.error}`)
  resumen.push([id, val.data.clasificacion, revision, accion])
  return reg.ok ? null : (contrato ?? null)
}

function tabla(filas: string[][]): void {
  const enc = ["Mensaje", "Clasificación", "Revisión", "Acción"]
  const anchos = enc.map((h, i) => Math.max(h.length, ...filas.map((f) => (f[i] ?? "").length)))
  const linea = (f: string[]) => f.map((c, i) => c.padEnd(anchos[i]!)).join(" │ ")
  console.log(linea(enc))
  console.log(anchos.map((a) => "─".repeat(a)).join("─┼─"))
  for (const f of filas) console.log(linea(f))
}

async function main(): Promise<void> {
  rmSync(join(ctx.directory, "out"), { recursive: true, force: true })

  titulo(`1. Buzón (fecha de referencia ${HOY})`)
  const buzon = leer<{ mensajes: MensajeBuzon[] }>(await contratos.leer_buzon.execute({}, ctx))
  if (!buzon.ok) throw new Error(buzon.error)
  for (const m of buzon.data.mensajes) console.log(`  ${m.id}  contrato=${m.tiene_contrato ? "sí" : "no"}  ${m.asunto}`)

  titulo("2. Primera pasada: extraer → validar → registrar (sin confirmación)")
  const resumen: string[][] = []
  const pendientes = new Map<string, Contrato>()
  for (const m of buzon.data.mensajes) {
    const pendiente = await procesar(m.id, resumen)
    if (pendiente) pendientes.set(m.id, pendiente)
  }

  titulo("3. Error controlado (HU-6): mensaje inexistente, el lote sigue")
  console.log(`  ${await contratos.extraer.execute({ mensaje_id: "msg-999" }, ctx)}`)

  titulo("4. Segunda pasada: el usuario confirma msg-006 (valor 0, fecha fin 2027-08-31)")
  const msg006 = pendientes.get("msg-006")
  if (msg006) {
    const confirmado: Contrato = { ...msg006, valor: 0, fecha_fin: "2027-08-31" }
    const reg = leer<Registro>(
      await contratos.registrar.execute({ mensaje_id: "msg-006", contrato: confirmado, confirmado: true, hoy: HOY }, ctx),
    )
    console.log(`  registrar(confirmado=true) → ${reg.ok ? `${reg.data.accion} ${reg.data.id_contrato} · ${reg.data.ruta_archivo}` : reg.error}`)
    const fila = resumen.find((f) => f[0] === "msg-006")
    if (fila && reg.ok) fila[3] = `${reg.data.accion} ${reg.data.id_contrato} (tras confirmar)`
  }

  titulo(`5. Alertas al ${HOY}`)
  const alertas = leer<Alertas>(await contratos.alertas.execute({ hoy: HOY }, ctx))
  if (alertas.ok) {
    const a = alertas.data
    console.log(`  ${a.ruta}`)
    console.log(`  Vencen ≤ 60 días: ${a.vencen.map((v) => `${v.id_contrato} (${v.dias_restantes} d)`).join(", ") || "ninguno"}`)
    console.log(`  Pólizas no vigentes: ${a.polizas_pendientes.map((p) => `${p.id_contrato} (${p.estado_poliza})`).join(", ")}`)
    console.log(`  Registrados desde el corte: ${a.registrados_desde_corte.map((r) => r.id_contrato).join(", ")}`)
  } else console.log(`  ERROR ${alertas.error}`)

  titulo("Resumen por mensaje")
  tabla(resumen)
  const restantes = leer<{ mensajes: MensajeBuzon[] }>(await contratos.leer_buzon.execute({}, ctx))
  if (restantes.ok) console.log(`\nMensajes pendientes en el buzón: ${restantes.data.mensajes.length}`)
}

await main()
