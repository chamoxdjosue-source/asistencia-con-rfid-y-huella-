"use strict";

const db = require("../src/database.js");

const ESTUDIANTES = [
  { estudiante_id: "EST001", nombre: "Juan Pérez", curso: "6to" },
  { estudiante_id: "EST002", nombre: "María López", curso: "6to" },
  { estudiante_id: "EST003", nombre: "Carlos Gómez", curso: "5to" },
  { estudiante_id: "EST004", nombre: "Ana Rodríguez", curso: "5to" },
  { estudiante_id: "EST005", nombre: "Pedro Vargas", curso: "4to" },
  { estudiante_id: "EST006", nombre: "Lucía Fernández", curso: "4to" },
  { estudiante_id: "EST007", nombre: "Jorge Ramírez", curso: "3ro" },
  { estudiante_id: "EST008", nombre: "Sofía Herrera", curso: "3ro" },
];

const PRECIO_INICIAL = 5;

const RESETEAR = process.argv.includes("--reset");
const VACIAR = process.argv.includes("--vaciar");

async function sembrarEstudiante(datos) {
  const existente = await db.getEstudiantePorId(datos.estudiante_id);

  if (existente && !RESETEAR) {
    console.log(`==  ${datos.estudiante_id} ${datos.nombre}: ya existe (sin cambios)`);
    return;
  }

  const campos = {
    estudiante_id: datos.estudiante_id,
    nombre: datos.nombre,
    curso: datos.curso,
    rfid: existente?.rfid || null,
    saldo: existente?.saldo ?? 0,
  };

  if (RESETEAR) {
    campos.rfid = null;
    campos.saldo = 0;
  }

  await db.guardarEstudiante(datos.estudiante_id, campos);
  console.log(`OK  ${datos.estudiante_id} ${datos.nombre}: ${existente ? "actualizado" : "creado"}`);
}

async function main() {
  console.log("Comedor Escolar — Siembra de datos iniciales");
  console.log(VACIAR ? "[modo: VACIAR]" : RESETEAR ? "[modo: RESETEAR]" : "[modo: normal]\n");

  for (const e of ESTUDIANTES) {
    try {
      await sembrarEstudiante(e);
    } catch (error) {
      console.log(`ERR ${e.estudiante_id} ${e.nombre}: ${error.message}`);
    }
  }

  const configExistente = await db.getDocumentoConfig("comedor");
  if (!configExistente || RESETEAR) {
    await db.setDocumentoConfig("comedor", { precio: PRECIO_INICIAL });
    console.log(`OK  Configuración: precio del almuerzo Bs ${PRECIO_INICIAL}`);
  } else {
    console.log(`==  Configuración: precio actual Bs ${configExistente.precio} (sin cambios)`);
  }

  if (VACIAR) {
    const cantidad = await db.eliminarTransacciones();
    console.log(`OK  Transacciones vaciadas: ${cantidad}`);
  }

  console.log("\nListo. Inicia el sistema con: npm start");
}

main().catch((error) => {
  console.error(`Error en la siembra: ${error.message}`);
  process.exit(1);
});