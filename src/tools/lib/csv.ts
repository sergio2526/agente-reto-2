/** CSV mínimo (RFC 4180): comillas dobles, comas y saltos de línea dentro de campos. */

export function parsearCsv(contenido: string): Record<string, string>[] {
  const filas = leerFilas(contenido.replace(/^﻿/, ""))
  const [encabezados, ...datos] = filas
  if (!encabezados) return []
  return datos
    .filter((fila) => fila.some((celda) => celda.trim() !== ""))
    .map((fila) => Object.fromEntries(encabezados.map((col, i) => [col, fila[i] ?? ""])))
}

function leerFilas(texto: string): string[][] {
  const filas: string[][] = []
  let fila: string[] = []
  let celda = ""
  let enComillas = false
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i]
    if (enComillas) {
      if (c === '"' && texto[i + 1] === '"') {
        celda += '"'
        i++
      } else if (c === '"') enComillas = false
      else celda += c
      continue
    }
    if (c === '"') enComillas = true
    else if (c === ",") {
      fila.push(celda)
      celda = ""
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && texto[i + 1] === "\n") i++
      fila.push(celda)
      filas.push(fila)
      fila = []
      celda = ""
    } else celda += c
  }
  if (celda !== "" || fila.length > 0) {
    fila.push(celda)
    filas.push(fila)
  }
  return filas
}

function escapar(valor: string): string {
  return /[",\n\r]/.test(valor) ? `"${valor.replace(/"/g, '""')}"` : valor
}

export function serializarCsv(columnas: readonly string[], filas: Record<string, string>[]): string {
  const lineas = [columnas.join(",")]
  for (const fila of filas) lineas.push(columnas.map((c) => escapar(fila[c] ?? "")).join(","))
  return `${lineas.join("\n")}\n`
}
