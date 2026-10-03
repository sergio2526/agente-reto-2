// Front de chat sin framework: historial, llamadas a herramientas visibles y estado de confirmación.
const $ = (id) => document.getElementById(id)
const chat = $("chat")
const entrada = $("entrada")
const enviarBtn = $("enviar")

const almacen = {
  leer(clave) {
    try { return localStorage.getItem(clave) } catch { return null }
  },
  escribir(clave, valor) {
    try { localStorage.setItem(clave, valor) } catch { /* modo privado */ }
  },
}

let sesionId = almacen.leer("sesion") || nuevaSesionId()
let claveAcceso = almacen.leer("claveAcceso") || ""
let ocupado = false

function nuevaSesionId() {
  const id = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  almacen.escribir("sesion", id)
  return id
}

function cabeceras(extra = {}) {
  return claveAcceso ? { ...extra, "x-access-key": claveAcceso } : extra
}

function markdown(texto) {
  const html = window.marked ? window.marked.parse(texto || "") : (texto || "").replace(/</g, "&lt;")
  return window.DOMPurify ? window.DOMPurify.sanitize(html) : html
}

function bajar() {
  chat.scrollTop = chat.scrollHeight
}

function json(valor) {
  const texto = typeof valor === "string" ? valor : JSON.stringify(valor, null, 2)
  return texto.length > 6000 ? `${texto.slice(0, 6000)}\n…` : texto
}

// ───────────────────────── render de eventos ─────────────────────────

function agregar(nodo) {
  $("vacio")?.remove()
  chat.appendChild(nodo)
  bajar()
}

function pintarUsuario(texto) {
  const div = document.createElement("div")
  div.className = "msg usuario"
  div.textContent = texto
  agregar(div)
}

function pintarAsistente(e) {
  const div = document.createElement("div")
  div.className = `msg asistente${e.final ? "" : " parcial"}${e.necesitaConfirmacion ? " confirmar" : ""}`
  div.innerHTML = markdown(e.texto)
  agregar(div)
}

function pintarError(texto) {
  const div = document.createElement("div")
  div.className = "msg error"
  div.textContent = texto
  agregar(div)
}

function pintarHerramienta(e) {
  const det = document.createElement("details")
  det.className = `msg herramienta${e.ok ? "" : " fallo"}`
  const resumen = document.createElement("summary")
  const nombre = Object.assign(document.createElement("span"), { className: "nombre", textContent: `🔧 ${e.nombre}` })
  const estado = Object.assign(document.createElement("span"), { className: "estado", textContent: e.ok ? "ok" : "error" })
  const texto = Object.assign(document.createElement("span"), { className: "resumen", textContent: e.resumen })
  resumen.append(nombre, estado, texto)
  const args = Object.assign(document.createElement("div"), { className: "etiqueta", textContent: "Argumentos" })
  const argsPre = Object.assign(document.createElement("pre"), { textContent: json(e.argumentos) })
  const res = Object.assign(document.createElement("div"), { className: "etiqueta", textContent: "Resultado" })
  const resPre = Object.assign(document.createElement("pre"), { textContent: json(e.resultado) })
  det.append(resumen, args, argsPre, res, resPre)
  agregar(det)
}

function pintar(e) {
  if (e.tipo === "usuario") pintarUsuario(e.texto)
  else if (e.tipo === "asistente") pintarAsistente(e)
  else if (e.tipo === "herramienta") pintarHerramienta(e)
  else if (e.tipo === "error") pintarError(e.texto)
}

function mostrarPendientes(pendientes) {
  const ids = Object.entries(pendientes || {})
  $("confirmacion").hidden = ids.length === 0
  $("pendientes").textContent = ids.map(([id, campos]) => `${id} (${campos.join(", ")})`).join(" · ")
}

function pensando(activo, texto = "Pensando…") {
  ocupado = activo
  $("pensando").hidden = !activo
  $("estado").textContent = texto
  enviarBtn.disabled = activo
}

// ───────────────────────── conversación ─────────────────────────

function* eventosSse(bufer) {
  let corte
  while ((corte = bufer.texto.indexOf("\n\n")) >= 0) {
    const bloque = bufer.texto.slice(0, corte)
    bufer.texto = bufer.texto.slice(corte + 2)
    const evento = /^event: (.*)$/m.exec(bloque)?.[1]
    const datos = /^data: (.*)$/m.exec(bloque)?.[1]
    if (evento && datos) yield { evento, datos: JSON.parse(datos) }
  }
}

function manejarEvento({ evento, datos }) {
  if (evento === "estado") pensando(true, datos.texto)
  else if (evento === "usuario") return
  else if (evento === "fin") mostrarPendientes(datos.pendientes)
  else if (evento === "error" && !datos.tipo) pintarError(datos.texto)
  else pintar(datos)
}

async function enviar(texto) {
  if (ocupado || !texto.trim()) return
  pintarUsuario(texto)
  entrada.value = ""
  pensando(true)
  try {
    const resp = await fetch("/api/chat/stream", {
      method: "POST",
      headers: cabeceras({ "content-type": "application/json" }),
      body: JSON.stringify({ sessionId: sesionId, message: texto }),
    })
    if (!resp.ok || !resp.body) {
      const cuerpo = await resp.json().catch(() => ({}))
      pintarError(cuerpo.error || `Error HTTP ${resp.status}`)
      return
    }
    const lector = resp.body.getReader()
    const decodificador = new TextDecoder()
    const bufer = { texto: "" }
    for (;;) {
      const { value, done } = await lector.read()
      if (done) break
      bufer.texto += decodificador.decode(value, { stream: true })
      for (const ev of eventosSse(bufer)) manejarEvento(ev)
    }
  } catch {
    pintarError("Se perdió la conexión con el servidor. Lo ya registrado se conserva; reintenta.")
  } finally {
    pensando(false)
    entrada.focus()
  }
}

async function restaurar() {
  const resp = await fetch(`/api/sessions/${sesionId}`, { headers: cabeceras() })
  if (!resp.ok) return
  const sesion = await resp.json()
  for (const e of sesion.eventos || []) pintar(e)
  mostrarPendientes(Object.fromEntries(Object.entries(sesion.pendientes || {}).map(([id, p]) => [id, p.campos])))
}

// ───────────────────────── archivos ─────────────────────────

function filasCsv(texto) {
  const filas = [[]]
  let celda = ""
  let comillas = false
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i]
    if (comillas) {
      if (c === '"' && texto[i + 1] === '"') { celda += '"'; i++ }
      else if (c === '"') comillas = false
      else celda += c
    } else if (c === '"') comillas = true
    else if (c === ",") { filas.at(-1).push(celda); celda = "" }
    else if (c === "\n") { filas.at(-1).push(celda); celda = ""; filas.push([]) }
    else if (c !== "\r") celda += c
  }
  if (celda) filas.at(-1).push(celda)
  return filas.filter((f) => f.length > 1)
}

function tablaCsv(texto) {
  const tabla = document.createElement("table")
  filasCsv(texto).forEach((fila, i) => {
    const tr = tabla.insertRow()
    for (const celda of fila) {
      const c = document.createElement(i === 0 ? "th" : "td")
      c.textContent = celda
      tr.appendChild(c)
    }
  })
  return tabla
}

async function abrirArchivo(nombre) {
  const cuerpo = $("panel-cuerpo")
  $("panel").hidden = false
  $("panel-titulo").textContent = nombre
  cuerpo.textContent = "Cargando…"
  const resp = await fetch(`/api/archivos/${nombre}`, { headers: cabeceras() })
  if (!resp.ok) {
    cuerpo.textContent = (await resp.json().catch(() => ({}))).error || "No disponible"
    return
  }
  const texto = await resp.text()
  cuerpo.textContent = ""
  if (nombre.endsWith(".md")) cuerpo.innerHTML = markdown(texto)
  else if (nombre.endsWith(".csv")) cuerpo.appendChild(tablaCsv(texto))
  else cuerpo.appendChild(Object.assign(document.createElement("pre"), { textContent: texto }))
}

// ───────────────────────── arranque ─────────────────────────

async function iniciar() {
  const salud = await fetch("/api/health").then((r) => r.json()).catch(() => null)
  const simulado = salud?.provider === "simulado"
  $("modelo").textContent = !salud ? "sin conexión" : simulado ? "modo simulado · sin LLM" : `${salud.provider} · ${salud.model}`
  $("modelo").classList.toggle("simulado", simulado)
  if (salud?.accessKeyRequired && !claveAcceso) {
    claveAcceso = window.prompt("Clave de acceso del demo (ver README):") || ""
    almacen.escribir("claveAcceso", claveAcceso)
  }
  await restaurar().catch(() => undefined)
}

$("formulario").addEventListener("submit", (ev) => {
  ev.preventDefault()
  enviar(entrada.value)
})
entrada.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && !ev.shiftKey) {
    ev.preventDefault()
    enviar(entrada.value)
  }
})
$("ejemplo").addEventListener("click", (ev) => enviar(ev.currentTarget.textContent))
$("nueva").addEventListener("click", () => {
  sesionId = nuevaSesionId()
  location.reload()
})
$("reiniciar").addEventListener("click", async () => {
  if (!window.confirm("¿Borrar out/ y volver al buzón inicial? Se pierden registros y sesiones.")) return
  await fetch("/api/reset", { method: "POST", headers: cabeceras() })
  sesionId = nuevaSesionId()
  location.reload()
})
document.querySelectorAll("[data-archivo]").forEach((b) => b.addEventListener("click", () => abrirArchivo(b.dataset.archivo)))
$("panel-cerrar").addEventListener("click", () => { $("panel").hidden = true })

iniciar()
