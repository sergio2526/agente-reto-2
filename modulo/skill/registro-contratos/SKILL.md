---
name: registro-contratos
description: Conocimiento del proceso de registro de contratos vigentes de Periferia — esquema del maestro, reglas RN1–RN5, lectura de la confianza por campo, casos especiales (contrato marco, otrosí, póliza condicional) y contenido del reporte de alertas. Úsala al procesar el buzón de contratos o al responder dudas sobre el maestro.
---

# Proceso de registro de contratos vigentes

## Contexto

- El maestro de contratos vigentes estuvo congelado desde el **2026-05-30**. Antes solo llegaban a administración los contratos que exigían póliza; ahora **todo** contrato, otrosí o acta de terminación debe pasar por el buzón único, tenga o no póliza.
- No hay área legal interna: el agente no interpreta cláusulas, solo extrae datos objetivos y escala lo dudoso a la analista administrativa, dueña del maestro.
- SharePoint se simula con `out/sharepoint/`. El fixture del maestro es de solo lectura; se trabaja sobre la copia `out/sharepoint/maestro-contratos.csv`.

## Esquema del maestro

| Columna | Regla |
|---|---|
| id_contrato | Número tal como aparece en el documento. Sin número: `AUTO-<año>-<secuencia>`. |
| cliente / nit_cliente | Razón social de la contraparte; identificador sin dígito de verificación ni puntos. |
| pais | CO, EC, PE, PA o HN. NIT → CO; RUC de 13 dígitos → EC; RUC de 11 dígitos → PE; RTN → HN. |
| objeto | Máximo 200 caracteres. |
| valor / moneda | Sin separadores. `0` si el contrato es por demanda. Monedas: COP, USD, PEN, PAB, HNL. |
| fecha_inicio / fecha_fin | YYYY-MM-DD. `fecha_fin` puede derivarse del plazo en meses. |
| requiere_poliza / tipo_poliza | Tipos separados por `;` (cumplimiento, calidad, salarios_prestaciones, responsabilidad_civil, buen_manejo_anticipo, estabilidad). |
| estado_poliza | vigente, pendiente, vencida o no_aplica. Alta con póliza → `pendiente`. |
| comercial | Nombre resuelto desde `comerciales.json`; si el remitente no está, se registra el correo con "(no registrado)". |

## Reglas de negocio

- **RN1 Duplicado**: mismo `id_contrato` con el mismo valor, fecha de inicio y fecha de fin. No se escribe nada; se reporta.
- **RN2 Actualización**: mismo `id_contrato` (o mismo NIT y objeto con similitud ≥ 0.9) con algún campo distinto, o un otrosí. Se actualiza la fila y se deja el cambio en `historial.jsonl`. En un otrosí solo cuentan los campos que el documento modifica.
- **RN3 Nuevo**: sin coincidencia en el maestro. Se inserta.
- **RN4 Rechazado**: sin adjunto de contrato (cotizaciones, preguntas) o texto sin partes ni objeto identificables. Un otrosí de un contrato que no está en el maestro también se rechaza: primero debe llegar el contrato base.
- **RN5 Revisión**: campos con confianza < 0.8 y conflictos con el maestro (cliente, NIT o país distintos) van a `requiere_revision`. No se registran sin confirmación humana explícita.
- Un remitente que no está en `comerciales.json` se reporta pero **no** bloquea el registro.

## Cómo leer la confianza

- 0.95: dato literal en su cláusula (número del contrato, monto con moneda, fechas "desde/hasta").
- 0.85–0.9: dato deducido con una regla segura (fecha fin = inicio + plazo en meses, razón social normalizada, póliza condicional).
- 0.8: fecha de inicio tomada del mes de firma cuando el día no está escrito.
- 0.5: valor por demanda (contrato marco sin cuantía) o fecha fin derivada de una firma sin día exacto. **Siempre requiere confirmación.**
- 0: el dato no está en el texto. Nunca se inventa.

## Casos especiales

- **Contrato marco / por demanda**: valor `0` y `valor_indeterminado = true`. La analista debe confirmar que se registra en 0.
- **Plazo "contado desde la firma"**: si la firma no trae día, se propone inicio el día 1 del mes y fin el último día del mes de vencimiento; la analista confirma la fecha fin.
- **Otrosí que amplía el plazo** de un contrato con póliza: las pólizas deben ampliarse, por eso el estado pasa a `pendiente` hasta que la aseguradora expida el anexo.
- **Póliza condicional** (por ejemplo, solo para órdenes que superen un monto): se registra `requiere_poliza = true` y estado `pendiente` para que gerencia la vea en las alertas.

## Alertas

`out/alertas.md` tiene tres secciones obligatorias: contratos que vencen en ≤ 60 días desde la fecha de referencia, pólizas exigidas que no están vigentes, y contratos registrados desde el corte del 2026-05-30 (gap cubierto). Como anexo lista los contratos cuya fecha fin ya pasó, para revisar si se liquidaron o falta un otrosí.
