"use strict";

// Crea/actualiza la coleccion "tarjetas" a partir de los estudiantes que ya
// tienen tarjeta (campo rfid). El ESP32 la lee para saber a que estudiante
// pertenece cada tarjeta, sin exponer los datos privados de "estudiantes".
//
// Ejecutar cada vez que se asignen tarjetas nuevas:
//   npm run firestore:tarjetas

const fb = require("../src/firebase.js");
const db = require("../src/database.js");

async function main() {
  console.log(`Sincronizando 'tarjetas' en ${fb.PROJECT}\n`);
  const estudiantes = await fb.queryCollection("estudiantes");

  let sincronizadas = 0;
  let sinTarjeta = 0;
  const duenos = new Map();

  for (const e of estudiantes) {
    const uids = [...new Set(db.rfidsDe(e))];
    if (!uids.length) {
      sinTarjeta++;
      continue;
    }
    const id = e.estudiante_id || e.id;
    for (const uid of uids) {
      const previo = duenos.get(uid);
      if (previo && previo !== id) {
        console.warn(
          `! ${uid} ya pertenece a ${previo}; se omite ${id} ${e.nombre || ""} (UID duplicado)`
        );
        continue;
      }
      duenos.set(uid, id);
      await fb.updateDocument("tarjetas", uid, {
        estudiante_id: id,
        nombre: String(e.nombre || ""),
        curso: String(e.curso || ""),
      });
      console.log(`OK ${uid} -> ${id} ${e.nombre || ""} ${e.curso || ""}`);
      sincronizadas++;
    }
  }

  console.log(
    `\nResumen: ${sincronizadas} tarjetas sincronizadas, ${sinTarjeta} estudiantes sin tarjeta.`
  );
}

main().catch((error) => {
  console.error("Error:", error.message);
  process.exit(1);
});