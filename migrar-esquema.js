"use strict";

// -----------------------------------------------------------------------------
// Migración de esquema (se puede ejecutar varias veces, es idempotente).
//
// Rellena los campos nuevos que usan las consultas indexadas, sin borrar nada:
//   * estudiantes            -> nombre_clave (nombre normalizado, sin tildes)
//   * transacciones_comedor  -> secuencia    (número entero para ordenar)
//   * solicitudes_recarga    -> secuencia
//   * asistencias            -> fecha        (para registros antiguos)
//
// Ejecutar con:  npm run firestore:migrar
// -----------------------------------------------------------------------------

const fb = require("../src/firebase.js");
const { normalizar } = require("../src/database.js");

const LOTE = 400;

function numeroDeTexto(texto) {
  const coincidencia = /(\d+)\s*$/.exec(String(texto || ""));
  return coincidencia ? parseInt(coincidencia[1], 10) : null;
}

async function escribirEnLotes(escrituras) {
  for (let i = 0; i < escrituras.length; i += LOTE) {
    await fb.commit(escrituras.slice(i, i + LOTE));
  }
}

async function migrarColeccion(nombre, calcularCampos) {
  const docs = await fb.queryCollection(nombre);
  const escrituras = [];

  for (const doc of docs) {
    const campos = calcularCampos(doc);
    if (campos) escrituras.push(fb.escribir(nombre, doc.id, campos));
  }

  if (!escrituras.length) {
    console.log(`==  ${nombre}: ${docs.length} documentos, ya estaban al día`);
    return;
  }

  await escribirEnLotes(escrituras);
  console.log(`OK  ${nombre}: ${escrituras.length} de ${docs.length} documentos actualizados`);
}

async function main() {
  console.log(`Migrando esquema en ${fb.PROJECT}\n`);

  await migrarColeccion("estudiantes", (doc) => {
    const clave = normalizar(doc.nombre);
    if (clave && doc.nombre_clave !== clave) return { nombre_clave: clave };
    return null;
  });

  await migrarColeccion("transacciones_comedor", (doc) => {
    if (doc.secuencia !== undefined && doc.secuencia !== null) return null;
    const secuencia = numeroDeTexto(doc.numero || doc.id);
    return secuencia === null ? null : { secuencia };
  });

  await migrarColeccion("solicitudes_recarga", (doc) => {
    if (doc.secuencia !== undefined && doc.secuencia !== null) return null;
    const secuencia = numeroDeTexto(doc.numero || doc.id);
    return secuencia === null ? null : { secuencia };
  });

  await migrarColeccion("asistencias", (doc) => {
    if (doc.fecha) return null;
    const coincidencia = /_(\d{4}-\d{2}-\d{2})$/.exec(String(doc.id || ""));
    return coincidencia ? { fecha: coincidencia[1] } : null;
  });

  console.log("\nListo. La base quedó con los campos e índices que usa el sistema.");
}

main().catch((error) => {
  console.error("Error en la migración:", error.message);
  process.exit(1);
});
