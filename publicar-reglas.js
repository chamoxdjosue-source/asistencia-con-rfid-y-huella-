"use strict";

// Publica en Firestore las reglas de seguridad que necesita el lector ESP32:
//   - "tarjetas":   lectura publica (uid -> estudiante_id, nombre, curso). Sin
//                   datos sensibles del estudiante.
//   - "asistencias": lectura + alta/actualizacion (para registra entrada/salida).
//   - "huellas":    lectura + alta/actualizacion (ranura del sensor -> estudiante
//                   y solicitud de enrolamiento). No guarda la huella en si.
//   - "pedidos":    lectura + alta/actualizacion (pedido de almuerzo del dia y
//                   peticion de cobro con tarjeta + huella). El saldo lo
//                   descuenta el servidor, nunca el lector.
//   - Todo lo demas queda bloqueado (el servidor entra como propietario por
//     OAuth y no se ve afectado por estas reglas).
//
// OJO: con estas reglas la web publicada en Firebase Hosting deja de poder
// leer "estudiantes", "transacciones_comedor", "configuracion" y
// "solicitudes_recarga" con la API key (solo leen el ESP32 y el servidor).
// Antes de publicarlas hay que decidir como se protege el panel en la nube.
// Mientras tanto el proyecto funciona con las reglas abiertas.

const fb = require("../src/firebase.js");

const REGLAS = `rules_version = '2';

service cloud.firestore {
  match /databases/{database}/documents {

    // Mapa publico: tarjeta -> datos minimos del estudiante.
    // Lo escribe el servidor (scripts/sincronizar-tarjetas.js); el ESP32 solo lee.
    match /tarjetas/{uid} {
      allow read: if true;
      allow write: if false;
    }

    // Asistencia del dia: el ESP32 crea la entrada y actualiza la salida.
    match /asistencias/{doc} {
      allow read: if true;
      allow create, update: if true;
      allow delete: if false;
    }

    // Huellas: el ESP32 lee la asociacion ranura -> estudiante (para saber a
    // quien pertenece el dedo) y actualiza la solicitud de enrolamiento. No
    // guarda la huella en si, solo el numero de ranura del sensor.
    match /huellas/{doc} {
      allow read: if true;
      allow create, update: if true;
      allow delete: if false;
    }

    // Pedidos de almuerzo: el ESP32 registra el pedido cuando el estudiante
    // pasa la tarjeta y pide el cobro cuando vuelve a pasar la tarjeta con la
    // huella. El descuento del saldo lo hace el servidor (el lector no toca
    // el dinero).
    match /pedidos/{doc} {
      allow read: if true;
      allow create, update: if true;
      allow delete: if false;
    }

    // El resto queda privado.
    match /{document=**} {
      allow read, write: if false;
    }
  }
}`;

const BASE = "https://firebaserules.googleapis.com/v1";

async function reintentar(fn, intentos = 8, espera = 1500) {
  let ultimo;
  for (let i = 0; i < intentos; i++) {
    try {
      return await fn();
    } catch (error) {
      ultimo = error;
      console.log(`  (reintento ${i + 1}: ${error.message})`);
      await new Promise((r) => setTimeout(r, espera));
    }
  }
  throw ultimo;
}

async function main() {
  console.log(`Publicando reglas de Firestore para el proyecto ${fb.PROJECT}\n`);
  const token = await fb.getAccessToken();

  // 1) Crear el ruleset
  const rs = await reintentar(async () => {
    const res = await fetch(`${BASE}/projects/${fb.PROJECT}/rulesets`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        source: { files: [{ name: "firestore.rules", content: REGLAS }] },
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
    return data;
  });
  console.log(`Ruleset creado: ${rs.name}`);

  // 2) Apuntar el release cloud.firestore al ruleset nuevo
  const releaseName = `projects/${fb.PROJECT}/releases/cloud.firestore`;
  const up = await reintentar(async () => {
    const res = await fetch(`${BASE}/${releaseName}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        release: { name: releaseName, rulesetName: rs.name },
        updateMask: "rulesetName",
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
    return data;
  });
  console.log(`Reglas publicadas -> ${up.rulesetName}`);
  console.log("\nReglas vigentes:");
  console.log(REGLAS);
}

main().catch((error) => {
  const detalle = String(error.message || "");
  if (detalle.includes("403") || detalle.includes("PERMISSION_DENIED")) {
    console.error(
      "\nNo se pudieron publicar las reglas: la cuenta con la que inicias sesión\n" +
        "no tiene permiso de IAM sobre el proyecto (firebaserules.rulesets.create).\n" +
        "Hace falta una cuenta con permisos de administrador del proyecto, o bien:\n" +
        "  1. entra en la consola de Firebase -> Reglas de Firestore y pega las\n" +
        "     reglas de este archivo a mano, o\n" +
        "  2. da el rol 'Administrador de reglas de Firebase' a la cuenta que usa\n" +
        "     la CLI y vuelve a ejecutar: npm run firestore:reglas\n"
    );
  } else {
    console.error("Error:", error.message);
  }
  process.exit(1);
});