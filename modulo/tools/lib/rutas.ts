import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"
import type { ContextoHerramienta } from "./tipos"

/** Rutas relativas a ctx.directory. Nunca se aceptan rutas absolutas del modelo. */
export const RUTAS = {
  fixtures: "fixtures/reto-02",
  buzon: "fixtures/reto-02/buzon",
  maestroFixture: "fixtures/reto-02/maestro-contratos.csv",
  comerciales: "fixtures/reto-02/comerciales.json",
  out: "out",
  sharepoint: "out/sharepoint",
  maestro: "out/sharepoint/maestro-contratos.csv",
  historial: "out/sharepoint/historial.jsonl",
  procesados: "out/procesados.json",
  log: "out/log.jsonl",
  alertas: "out/alertas.md",
} as const

/** Resuelve una ruta relativa y garantiza que no escape de la raíz del proyecto. */
export function ruta(ctx: ContextoHerramienta, relativa: string): string {
  const raiz = resolve(ctx.directory)
  const absoluta = resolve(raiz, relativa)
  if (absoluta !== raiz && !absoluta.startsWith(raiz + sep)) {
    throw new Error(`ruta fuera del proyecto: ${relativa}`)
  }
  return absoluta
}

export function relativaAlProyecto(ctx: ContextoHerramienta, absoluta: string): string {
  return relative(resolve(ctx.directory), absoluta).split(sep).join("/")
}

export function existe(ctx: ContextoHerramienta, relativa: string): boolean {
  return existsSync(ruta(ctx, relativa))
}

export function leerTexto(ctx: ContextoHerramienta, relativa: string): string {
  return readFileSync(ruta(ctx, relativa), "utf8")
}

export function leerJson<T>(ctx: ContextoHerramienta, relativa: string, porDefecto: T): T {
  if (!existe(ctx, relativa)) return porDefecto
  return JSON.parse(leerTexto(ctx, relativa)) as T
}

/** Solo escribe bajo out/: los fixtures son de solo lectura (RN6). */
function destinoEscribible(ctx: ContextoHerramienta, relativa: string): string {
  const normal = relativa.split("\\").join("/")
  if (!normal.startsWith(`${RUTAS.out}/`)) throw new Error(`escritura fuera de out/: ${relativa}`)
  const absoluta = ruta(ctx, normal)
  mkdirSync(dirname(absoluta), { recursive: true })
  return absoluta
}

export function escribirTexto(ctx: ContextoHerramienta, relativa: string, contenido: string): void {
  writeFileSync(destinoEscribible(ctx, relativa), contenido, "utf8")
}

export function agregarLinea(ctx: ContextoHerramienta, relativa: string, objeto: object): void {
  appendFileSync(destinoEscribible(ctx, relativa), `${JSON.stringify(objeto)}\n`, "utf8")
}

export function copiarArchivo(ctx: ContextoHerramienta, origen: string, destino: string): void {
  copyFileSync(ruta(ctx, origen), destinoEscribible(ctx, destino))
}

export function unir(...partes: string[]): string {
  return join(...partes).split(sep).join("/")
}
