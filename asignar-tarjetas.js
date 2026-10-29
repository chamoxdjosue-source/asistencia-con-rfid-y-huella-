"use strict";

// Lee tarjetas_rfid.json y asigna cada código RFID al estudiante cuyo nombre
// coincide. Si la persona de la tarjeta no existe, la crea como estudiante
// nuevo. Es idempotente: si la tarjeta ya está asignada, no hace nada.

const fs = require("fs");
const path = require("path");
const db = require("../src/database.js");

const RUTA_TARJETAS = path.join(__dirname, "..", "tarjetas_rfid.json");

function normalizar(texto) {
  return String(texto || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

// "Tarjeta de Jhostin" -> "Jhostin"
function nombreDesdeTarjeta(nombreTarjeta) {
  return String(nombreTarjeta || "")
    .replace(/^tarjeta\s+de\s+/i, "")
    .trim();
}

function primerNombre(nombreCompleto) {
  return normalizar(String(nombreCompleto || "").split(/\s+/)[0]);
}

function idDocumento(estudiante) {
  return estudiante.estudiante_id || estudiante.id;
}

function siguienteId(estudiantes) {
  let max = 0;
  for (const e of estudiantes) {
    const coincidencia = /^EST(\d+)$/i.exec(String(idDocumento(e) || ""));
    if (coincidencia) max = Math.max(max, parseInt(coincidencia[1], 10));
  }
  return `EST${String(max + 1).padStart(3, "0")}`;
}

async function main() {
  if (!fs.existsSync(RUTA_TARJETAS)) {
    throw new Error(`No se encontró ${RUTA_TARJETAS}`);
  }

  const tarjetas = JSON.parse(fs.readFileSync(RUTA_TARJETAS, "utf8"));
  console.log("Asignando tarjetas RFID desde tarjetas_rfid.json\n");

  const estudiantes = await db.listarEstudiantes();
  let asignadas = 0;
  let creados = 0;
  let sinCambios = 0;

  for (const tarjeta of tarjetas) {
    const persona = nombreDesdeTarjeta(tarjeta.nombre);
    const codigos = [tarjeta.codigo_rfid, tarjeta.codigo_rfid_2]
      .map((codigo) => String(codigo === undefined || codigo === null ? "" : codigo).trim())
      .filter(Boolean);
    const [codigo, codigoAlt] = codigos;
    const objetivo = normalizar(persona);

    // Coincidencia por primer nombre (Juan -> Juan Pérez) o nombre completo.
    const estudiante =
      estudiantes.find((e) => primerNombre(e.nombre) === objetivo) ||
      estudiantes.find((e) => normalizar(e.nombre) === objetivo);

    if (estudiante) {
      const actuales = db.rfidsDe(estudiante);
      const faltantes = codigos.filter((valor) => !actuales.includes(valor));
      if (!faltantes.length) {
        console.log(
          `==  ${idDocumento(estudiante)} ${estudiante.nombre}: ya tiene las tarjetas ${actuales.join(" / ")}`
        );
        sinCambios++;
        continue;
      }

      await db.asignarTarjeta(idDocumento(estudiante), codigo);
      await db.asignarTarjetaAlt(idDocumento(estudiante), codigoAlt || null);
      const actualizado = { ...estudiante, rfid: codigo, rfid_alt: codigoAlt || null };
      for (const valor of codigos) await db.sincronizarTarjeta(valor, actualizado);
      console.log(
        `OK  ${idDocumento(estudiante)} ${estudiante.nombre} <- ${codigos.join(" / ")}`
      );
      estudiante.rfid = codigo;
      estudiante.rfid_alt = codigoAlt || null;
      asignadas++;
      continue;
    }

    const id = siguienteId(estudiantes);
    const nuevo = {
      estudiante_id: id,
      nombre: persona,
      curso: "",
      rfid: codigo,
      rfid_alt: codigoAlt || null,
      saldo: 0,
    };
    await db.guardarEstudiante(id, nuevo);
    for (const valor of codigos) await db.sincronizarTarjeta(valor, { ...nuevo, id });
    estudiantes.push({ id, ...nuevo });
    console.log(
      `NEW ${id} ${persona}: estudiante creado con tarjetas ${codigos.join(" / ")}`
    );
    creados++;
  }

  console.log(
    `\nResumen: ${asignadas} tarjetas asignadas, ${creados} estudiantes creados, ${sinCambios} sin cambios.`
  );
}

main().catch((error) => {
  console.error("Error:", error.message);
  process.exit(1);
});
