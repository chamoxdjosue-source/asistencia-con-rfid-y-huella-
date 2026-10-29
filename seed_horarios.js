const { setHorarios, getHorarios } = require("./configuracion.js");

async function seedHorarios() {
  await setHorarios({
    entradaInicio: "08:00",
    entradaFin: "09:00",
    salidaInicio: "12:00",
    salidaFin: "4:00",
  });
  console.log("Horarios configurados en Firestore:");
  const h = await getHorarios();
  console.log(JSON.stringify(h, null, 2));
}

seedHorarios().catch(e => console.error(e.message));