"use strict";

const db = require("../src/database.js");
const { hashPassword, verificarPassword, generarPassword } = require("../src/auth.js");

// Restablece contraseñas de estudiantes.
//
//   npm run passwords            -> conserva las que ya existen (no se pueden
//                                   recuperar si son personalizadas)
//   npm run passwords -- --reset -> genera una contraseña aleatoria nueva para
//                                   cada estudiante y la muestra UNA sola vez.
//
// En Firestore nunca se guarda la contraseña: solo el hash PBKDF2.
async function main() {
  const reset = process.argv.includes("--reset");

  const estudiantes = await db.listarEstudiantes();
  estudiantes.sort((a, b) => String(a.estudiante_id).localeCompare(String(b.estudiante_id)));

  if (estudiantes.length === 0) {
    console.log("No hay estudiantes registrados.");
    return;
  }

  console.log(
    reset
      ? "Generando contraseñas nuevas y aleatorias para cada estudiante:\n"
      : "Revisando contraseñas de los estudiantes:\n"
  );

  for (const estudiante of estudiantes) {
    if (!reset && estudiante.contrasena) {
      console.log(
        `  ${estudiante.estudiante_id}  ${estudiante.nombre}  -> contraseña ya definida (no se puede recuperar)`
      );
      continue;
    }

    const clave = generarPassword(12);
    const verificacion = await verificarPassword(clave, estudiante.contrasena || "");
    if (verificacion.ok) {
      console.log(
        `  ${estudiante.estudiante_id}  ${estudiante.nombre}  -> ya usa esa contraseña (no se muestra)`
      );
      continue;
    }

    await db.setPassword(estudiante.estudiante_id, await hashPassword(clave));
    console.log(`  ${estudiante.estudiante_id}  ${estudiante.nombre}  -> ${clave}`);
  }

  console.log("\nListo. Firestore solo guarda el hash; entrega estas claves en mano.");
}

main().catch((error) => {
  console.error("Error:", error.message);
  process.exit(1);
});
