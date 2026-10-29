"use strict";

/* ============================================================================
 * public/firebase-web.js
 *
 * Capa de datos de la web con dos modos:
 *
 *   - MODO SERVIDOR: la página la sirve el Node local (server.js). Todo pasa
 *     por su API /api/* (lector RFID USB, análisis con IA, etc.).
 *
 *   - MODO NUBE: la página la sirve Firebase Hosting. Ahí no hay servidor Node,
 *     así que esta capa habla directo con Firestore usando el SDK web y
 *     replica los MISMOS contratos de la API (mismas rutas, misma forma de
 *     respuesta) para que public/app.js no tenga que cambiar.
 *
 * El modo se detecta solo: si /api/status contesta JSON es que hay servidor
 * detrás. Se puede forzar con ?modo=servidor o ?modo=nube.
 *
 * Lo que NO funciona en modo nube (porque vive en el servidor local):
 *   - el lector RFID USB (POST /api/uid) y el estado real del lector,
 *   - el análisis con IA de los comprobantes y del QR (Groq),
 *   - las notificaciones push del servidor (SSE); aquí se suplen con
 *     onSnapshot de Firestore.
 * ========================================================================== */

(function () {
  /* ---------------------------------------------------------------- config */

  const CONFIG_FIREBASE = {
    apiKey: "AIzaSyC8BsnLnMhaD5ODrDdPjHoxaWMO0thQO2A",
    authDomain: "asistenciarfid-778d2.firebaseapp.com",
    projectId: "asistenciarfid-778d2",
    storageBucket: "asistenciarfid-778d2.firebasestorage.app",
    messagingSenderId: "904688748100",
    appId: "1:904688748100:web:1fde289dfd18fbe1809e11",
  };

  // El panel administrativo en Firebase Hosting está deshabilitado mientras no
  // exista Firebase Authentication + reglas de Firestore por rol. No se guardan
  // contraseñas ni perfiles en este archivo: cualquier comprobación hecha en el
  // navegador se puede saltar y no sirve como autorización real.
  const ADMIN_NUBE_HABILITADO = false;

  const PROYECTO = CONFIG_FIREBASE.projectId;

  const COLECCIONES = {
    ESTUDIANTES: "estudiantes",
    TRANSACCIONES: "transacciones_comedor",
    CONFIGURACION: "configuracion",
    SOLICITUDES: "solicitudes_recarga",
    ASISTENCIAS: "asistencias",
    TARJETAS: "tarjetas",
    HUELLAS: "huellas",
    PEDIDOS: "pedidos",
  };

  const HUELLA_SOLICITUD = "enrolamiento";
  const RANURAS_HUELLA = 127;

  const CAMPOS_PRIVADOS = ["contrasena"];
  const CAMPOS_SOLO_ADMIN = [
    ...CAMPOS_PRIVADOS,
    "rfid",
    "rfid_alt",
    "pagador",
    "nombre_clave",
  ];

  const MAX_TRANSACCIONES = 500;
  const MAX_SOLICITUDES = 100;
  const LIMITE_IMAGEN = 700_000;
  const MONTO_MAXIMO = 100000;
  const PRECIO_DEFECTO = 5;
  const VENTANA_HORAS_DEFECTO = 48;
  const VENTANA_HORAS_MAXIMA = 720;
  const DURACION_SESION_MS = 12 * 60 * 60 * 1000;

  /* ----------------------------------------------------------- utilidades */

  const pad = (n) => String(n).padStart(2, "0");

  function fechaLocal(fecha) {
    const ahora = fecha || new Date();
    return `${ahora.getFullYear()}-${pad(ahora.getMonth() + 1)}-${pad(ahora.getDate())}`;
  }

  function horaLocal(fecha) {
    const ahora = fecha || new Date();
    return `${pad(ahora.getHours())}:${pad(ahora.getMinutes())}:${pad(ahora.getSeconds())}`;
  }

  function normalizar(texto) {
    return String(texto || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function limpiar(texto, max) {
    return String(texto === undefined || texto === null ? "" : texto)
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, max);
  }

  function sinCampos(objeto, ocultos) {
    const limpio = { ...objeto };
    for (const campo of ocultos) delete limpio[campo];
    return limpio;
  }

  // Dos carnets por estudiante: el UID de un lector y el mismo UID con los
  // bytes invertidos que entrega otro modelo (RC522). El antiguo se conserva.
  function rfidsDe(estudiante) {
    return [estudiante && estudiante.rfid, estudiante && estudiante.rfid_alt]
      .map((valor) => String(valor === undefined || valor === null ? "" : valor).trim())
      .filter(Boolean);
  }

  function aCentavos(valor) {
    return Math.round((Number(valor) || 0) * 100) / 100;
  }

  function formatearBs(valor) {
    return new Intl.NumberFormat("es-VE", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(Number(valor) || 0);
  }

  function secuenciaDe(documento) {
    const directo = Number(documento?.secuencia);
    if (Number.isFinite(directo)) return directo;
    const coincidencia = /(\d+)\s*$/.exec(String(documento?.numero || documento?.id || ""));
    return coincidencia ? parseInt(coincidencia[1], 10) : 0;
  }

  function normalizarBeneficiario(beneficiario) {
    const datos = beneficiario || {};
    return {
      nombre: limpiar(datos.nombre, 90),
      cedula: limpiar(datos.cedula, 25),
      telefono: limpiar(datos.telefono, 25),
      banco: limpiar(datos.banco, 60),
    };
  }

  function validarMonto(monto) {
    const cantidad = Number(monto);
    if (!Number.isFinite(cantidad) || cantidad <= 0) {
      return { ok: false, error: "El monto debe ser un número mayor a 0." };
    }
    if (cantidad > MONTO_MAXIMO) {
      return { ok: false, error: `El monto máximo por operación es Bs ${formatearBs(MONTO_MAXIMO)}.` };
    }
    return { ok: true, valor: aCentavos(cantidad) };
  }

  function esFechaValida(texto) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(texto || ""))) return false;
    const [anio, mes, dia] = String(texto).split("-").map(Number);
    const fecha = new Date(anio, mes - 1, dia);
    return (
      fecha.getFullYear() === anio && fecha.getMonth() === mes - 1 && fecha.getDate() === dia
    );
  }

  function perteneceAFecha(asistencia, fecha) {
    if (!asistencia) return false;
    if (asistencia.fecha) return String(asistencia.fecha) === fecha;
    return String(asistencia.id || "").endsWith(`_${fecha}`);
  }

  function horaEnMinutos(hora) {
    const partes = String(hora || "").split(":").map(Number);
    if (partes.length < 2 || partes.some((n) => !Number.isFinite(n))) return null;
    return partes[0] * 60 + partes[1];
  }

  function permanenciaMinutos(asistencia) {
    const entrada = horaEnMinutos(asistencia.hora_entrada);
    const salida = horaEnMinutos(asistencia.hora_salida);
    if (entrada === null || salida === null || salida < entrada) return null;
    return salida - entrada;
  }

  function formatearPermanencia(minutos) {
    if (minutos === null) return null;
    const horas = Math.floor(minutos / 60);
    const resto = minutos % 60;
    if (!horas) return `${resto} min`;
    return resto ? `${horas} h ${resto} min` : `${horas} h`;
  }

  async function hash(texto) {
    const datos = new TextEncoder().encode(String(texto));
    const digests = await crypto.subtle.digest("SHA-256", datos);
    return Array.from(new Uint8Array(digests))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  // Comprueba el mismo formato PBKDF2 que genera src/auth.js en el servidor.
  // La sal se guarda como texto hexadecimal y Node la usa tal cual (UTF-8), por
  // eso aquí también se codifica el texto de la sal, no sus bytes decodificados.
  async function verificarPasswordWeb(password, almacenado) {
    const valor = String(almacenado || "");
    if (!valor) return false;
    const pbkdf2 = /^pbkdf2\$(\d+)\$([a-f0-9]{16,})\$([a-f0-9]{32,})$/i.exec(valor);
    if (pbkdf2) {
      const iteraciones = Number(pbkdf2[1]);
      const sal = pbkdf2[2];
      const esperado = pbkdf2[3].toLowerCase();
      if (!Number.isFinite(iteraciones) || iteraciones < 10_000) return false;
      try {
        const material = await crypto.subtle.importKey(
          "raw",
          new TextEncoder().encode(String(password)),
          "PBKDF2",
          false,
          ["deriveBits"]
        );
        const bits = await crypto.subtle.deriveBits(
          {
            name: "PBKDF2",
            salt: new TextEncoder().encode(sal),
            iterations: iteraciones,
            hash: "SHA-256",
          },
          material,
          esperado.length * 4
        );
        const derivado = Array.from(new Uint8Array(bits))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
        return derivado === esperado;
      } catch {
        return false;
      }
    }
    // Compatibilidad con los hashes SHA-256 anteriores.
    if (/^[a-f0-9]{64}$/i.test(valor)) return (await hash(password)) === valor.toLowerCase();
    return false;
  }

  function generarPassword(longitud = 14) {
    const alfabeto = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
    const bytes = new Uint8Array(longitud);
    crypto.getRandomValues(bytes);
    return Array.from(bytes)
      .map((b) => alfabeto[b % alfabeto.length])
      .join("");
  }

  async function hashPasswordWeb(password) {
    const bytesSal = new Uint8Array(16);
    crypto.getRandomValues(bytesSal);
    const sal = Array.from(bytesSal)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const material = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(String(password)),
      "PBKDF2",
      false,
      ["deriveBits"]
    );
    const bits = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt: new TextEncoder().encode(sal),
        iterations: 210_000,
        hash: "SHA-256",
      },
      material,
      256
    );
    const derivado = Array.from(new Uint8Array(bits))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return `pbkdf2$210000$${sal}$${derivado}`;
  }

  /* -------------------------------------------------------------- sesiones */

  // En modo nube la sesión vive solo en memoria: recargar la página obliga a
  // iniciar sesión otra vez. No se escribe ningún token en sessionStorage ni en
  // localStorage.
  let sesionMemoria = { token: "", rol: "" };

  function recordarSesion(token, rol) {
    sesionMemoria = {
      token: String(token || ""),
      rol: String(rol || ""),
    };
  }

  function tokenDeNube() {
    return sesionMemoria.token;
  }

  function nuevoToken(rol, extra) {
    const buffer = new Uint8Array(16);
    crypto.getRandomValues(buffer);
    const aleatorio = Array.from(buffer)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const expira = Date.now() + DURACION_SESION_MS;
    return `${aleatorio}.${expira}.${rol}${extra ? `.${extra}` : ""}`;
  }

  function leerToken(token) {
    if (!token) return null;
    const partes = String(token).split(".");
    if (partes.length < 3) return null;
    const expira = Number(partes[1]);
    if (!Number.isFinite(expira) || Date.now() > expira) return null;
    return { rol: partes[2], estudianteId: partes[3] || null };
  }

  /* ------------------------------------------------------------- Firestore */

  let instancia = null;

  function firestore() {
    if (instancia) return instancia;
    const sdk = window.firebase;
    if (!sdk || !sdk.firestore) {
      throw new Error("No se cargó el SDK de Firestore (revisa la conexión).");
    }
    if (!sdk.apps || sdk.apps.length === 0) sdk.initializeApp(CONFIG_FIREBASE);
    instancia = sdk.firestore();
    return instancia;
  }

  function referencia(coleccion, id) {
    return firestore().collection(coleccion).doc(String(id));
  }

  async function leerDoc(coleccion, id) {
    const snap = await referencia(coleccion, id).get();
    return snap.exists ? { id: snap.id, ...snap.data() } : null;
  }

  async function listarDocs(coleccion, opciones = {}) {
    let consulta = firestore().collection(coleccion);
    for (const filtro of opciones.where || []) {
      consulta = consulta.where(filtro.campo, filtro.op || "==", filtro.valor);
    }
    if (opciones.campos && opciones.campos.length) {
      consulta = consulta.select(...opciones.campos);
    }
    if (opciones.orderBy) {
      consulta = consulta.orderBy(opciones.orderBy.campo, opciones.orderBy.dir || "asc");
    }
    if (opciones.limit) consulta = consulta.limit(opciones.limit);
    const snap = await consulta.get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }

  /* --------------------------------------------------- REST con proyección */

  // El SDK web (compat v10) no trae `select()`, así que para las consultas que
  // deben dejar fuera campos pesados —la foto del comprobante pesa cientos de
  // KB— se usa la API REST de Firestore con proyección de campos.
  const BASE_REST = `https://firestore.googleapis.com/v1/projects/${PROYECTO}/databases/(default)/documents`;

  function camposAObjeto(campos) {
    const salida = {};
    for (const [clave, valor] of Object.entries(campos || {})) {
      if ("stringValue" in valor) salida[clave] = valor.stringValue;
      else if ("integerValue" in valor) salida[clave] = parseInt(valor.integerValue, 10);
      else if ("doubleValue" in valor) salida[clave] = valor.doubleValue;
      else if ("booleanValue" in valor) salida[clave] = valor.booleanValue;
      else if ("nullValue" in valor) salida[clave] = null;
      else if ("timestampValue" in valor) salida[clave] = valor.timestampValue;
      else if ("mapValue" in valor) salida[clave] = camposAObjeto(valor.mapValue.fields);
      else if ("arrayValue" in valor) {
        salida[clave] = (valor.arrayValue.values || []).map((item) => camposAObjeto({ v: item }).v);
      } else salida[clave] = valor;
    }
    return salida;
  }

  async function restConsultar(coleccion, opciones = {}) {
    const consulta = { structuredQuery: { from: [{ collectionId: coleccion }] } };
    if (opciones.where) {
      consulta.structuredQuery.where = {
        fieldFilter: {
          field: { fieldPath: opciones.where.campo },
          op: "EQUAL",
          value: { stringValue: String(opciones.where.valor) },
        },
      };
    }
    if (opciones.orderBy) {
      consulta.structuredQuery.orderBy = [
        {
          field: { fieldPath: opciones.orderBy.campo },
          direction: opciones.orderBy.dir === "desc" ? "DESCENDING" : "ASCENDING",
        },
      ];
    }
    if (opciones.limit) consulta.structuredQuery.limit = Math.max(1, Number(opciones.limit));
    if (opciones.campos && opciones.campos.length) {
      consulta.structuredQuery.select = {
        fields: opciones.campos.map((campo) => ({ fieldPath: campo })),
      };
    }

    const res = await fetch(`${BASE_REST}:runQuery?key=${CONFIG_FIREBASE.apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(consulta),
    });
    if (!res.ok) {
      const detalle = await res.text().catch(() => "");
      throw new Error(`Firestore runQuery ${res.status}: ${detalle.slice(0, 200)}`);
    }

    const respuesta = await res.json();
    const documentos = [];
    for (const fila of respuesta || []) {
      const documento = fila.document;
      if (!documento) continue;
      const id = String(documento.name || "").split("/").pop();
      documentos.push({ id, ...camposAObjeto(documento.fields) });
    }
    return documentos;
  }

  /* ------------------------------------------------------------- estudiantes */

  async function listarEstudiantes() {
    return listarDocs(COLECCIONES.ESTUDIANTES);
  }

  async function listarEstudiantesPublicos(esAdmin) {
    const todos = await listarEstudiantes();
    const ocultos = esAdmin ? CAMPOS_PRIVADOS : CAMPOS_SOLO_ADMIN;
    return todos.map((e) => sinCampos(e, ocultos));
  }

  async function contarEstudiantes() {
    const snap = await firestore().collection(COLECCIONES.ESTUDIANTES).get();
    return snap.size;
  }

  function getEstudiantePorId(estudianteId) {
    return leerDoc(COLECCIONES.ESTUDIANTES, estudianteId);
  }

  async function getEstudiantePorNombre(nombre) {
    const objetivo = normalizar(nombre);
    if (!objetivo) return null;
    try {
      const porClave = await listarDocs(COLECCIONES.ESTUDIANTES, {
        where: [{ campo: "nombre_clave", op: "==", valor: objetivo }],
        limit: 1,
      });
      if (porClave[0]) return porClave[0];
    } catch {
      /* sin índice/campo: se usa el respaldo */
    }
    const todos = await listarEstudiantes();
    return todos.find((e) => normalizar(e.nombre) === objetivo) || null;
  }

  async function guardarEstudiante(estudianteId, campos) {
    const datos = { ...campos };
    if (datos.nombre !== undefined) datos.nombre_clave = normalizar(datos.nombre);
    await referencia(COLECCIONES.ESTUDIANTES, estudianteId).set(datos, { merge: true });
  }

  async function sincronizarTarjeta(uid, estudiante) {
    await referencia(COLECCIONES.TARJETAS, String(uid).trim()).set(
      {
        estudiante_id: estudiante.estudiante_id || estudiante.id,
        nombre: String(estudiante.nombre || ""),
        curso: String(estudiante.curso || ""),
      },
      { merge: true }
    );
  }

  /* -------------------------------------------------------- configuración */

  async function getConfig() {
    const documento = (await leerDoc(COLECCIONES.CONFIGURACION, "comedor")) || {};
    const precio = Number(documento.precio);
    const ventana = Number(documento.ventana_horas);
    return {
      precio: Number.isFinite(precio) && precio >= 0 ? precio : PRECIO_DEFECTO,
      beneficiario: normalizarBeneficiario(documento.beneficiario),
      ventana_horas: Math.min(
        Math.max(
          Number.isFinite(ventana) && ventana > 0 ? ventana : VENTANA_HORAS_DEFECTO,
          1
        ),
        VENTANA_HORAS_MAXIMA
      ),
    };
  }

  async function setConfig(cambios) {
    const documento = {};
    if (cambios.precio !== undefined) {
      const value = Number(cambios.precio);
      if (!Number.isFinite(value) || value < 0) {
        throw new Error("El precio debe ser un número mayor o igual a 0");
      }
      documento.precio = value;
    }
    if (cambios.beneficiario !== undefined) {
      documento.beneficiario = normalizarBeneficiario(cambios.beneficiario);
    }
    if (cambios.ventana_horas !== undefined) {
      const value = Number(cambios.ventana_horas);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error("La ventana de horas debe ser un número mayor a 0.");
      }
      documento.ventana_horas = Math.min(value, VENTANA_HORAS_MAXIMA);
    }
    if (Object.keys(documento).length) {
      await referencia(COLECCIONES.CONFIGURACION, "comedor").set(documento, { merge: true });
    }
    return getConfig();
  }

  /* ----------------------------------------------------------- transacciones */

  async function listarTransacciones(limite = MAX_TRANSACCIONES) {
    let docs;
    try {
      docs = await listarDocs(COLECCIONES.TRANSACCIONES, {
        orderBy: { campo: "secuencia", dir: "desc" },
        limit: limite,
      });
    } catch {
      docs = await listarDocs(COLECCIONES.TRANSACCIONES);
    }
    // El panel espera las transacciones de más antigua a más reciente. Se
    // ordena por el número real de secuencia y no por el texto, porque en la
    // base hay documentos con la secuencia como texto y otros como número.
    docs.sort((a, b) => secuenciaDe(a) - secuenciaDe(b));
    return docs.slice(-limite);
  }

  async function listarTransaccionesDeEstudiante(estudianteId, limite = 200) {
    if (!estudianteId) return [];
    const docs = await listarDocs(COLECCIONES.TRANSACCIONES, {
      where: [{ campo: "estudiante_id", op: "==", valor: String(estudianteId) }],
    });
    docs.sort((a, b) => secuenciaDe(b) - secuenciaDe(a));
    return docs.slice(0, Math.max(1, limite));
  }

  function getTransaccion(numero) {
    return leerDoc(COLECCIONES.TRANSACCIONES, numero);
  }

  /* --------------------------------------------------------------- solicitudes */

  // La imagen del comprobante pesa cientos de KB: no se baja con la lista, se
  // pide aparte cuando el administrador abre el comprobante.
  const CAMPOS_SOLICITUD = [
    "numero",
    "secuencia",
    "nombre",
    "curso",
    "estudiante_id",
    "monto",
    "monto_declarado",
    "monto_creditado",
    "estado",
    "fecha",
    "hora",
    "nota",
    "analisis_ia",
    "verificacion",
    "beneficiario_qr",
    "huella",
    "motivo",
    "revisado_por",
  ];

  async function listarSolicitudes(limite = MAX_SOLICITUDES) {
    let docs;
    try {
      // Proyección por REST: la foto del comprobante no baja con la lista.
      docs = await restConsultar(COLECCIONES.SOLICITUDES, {
        campos: CAMPOS_SOLICITUD,
        orderBy: { campo: "secuencia", dir: "desc" },
        limit: limite,
      });
    } catch {
      // Respaldo sin proyección: baja también las imágenes, así que se limita.
      docs = await listarDocs(COLECCIONES.SOLICITUDES, {
        orderBy: { campo: "secuencia", dir: "desc" },
        limit: 25,
      });
    }
    docs.sort((a, b) => secuenciaDe(a) - secuenciaDe(b));
    return docs;
  }

  function getDocumentoSolicitud(numero) {
    return leerDoc(COLECCIONES.SOLICITUDES, numero);
  }

  // Las listas no llevan la imagen: se descarga solo al abrir el comprobante.
  function sinArchivoSolicitud(solicitud) {
    if (!solicitud) return solicitud;
    const { archivo, ...resto } = solicitud;
    return { ...resto, tiene_archivo: Boolean(archivo) };
  }

  async function listarSolicitudesDeEstudiante(estudianteId, limite = 50) {
    if (!estudianteId) return [];
    let docs = [];
    try {
      docs = await listarDocs(COLECCIONES.SOLICITUDES, {
        where: [{ campo: "estudiante_id", op: "==", valor: String(estudianteId) }],
      });
    } catch {
      docs = [];
    }
    // Respaldo para documentos antiguos sin estudiante_id.
    if (!docs.length) {
      const todas = await listarSolicitudes(Math.max(limite, 100));
      docs = todas.filter(
        (s) => String(s.estudiante_id || "") === String(estudianteId)
      );
    }
    docs.sort((a, b) => secuenciaDe(b) - secuenciaDe(a));
    return docs.slice(0, Math.max(1, limite));
  }

  // Aprobación atómica e idempotente: la marca `resolucion_<numero>` se crea en
  // el mismo commit que el saldo y el cambio de estado de la solicitud. Si dos
  // personas aprueban a la vez, solo una mueve el dinero.
  async function aprobarSolicitudRecarga(solicitud, montoAutorizado, revisor) {
    const numero = String((solicitud && solicitud.numero) || "");
    if (!numero) return { ok: false, evento: "SOLICITUD_INVALIDA", mensaje: "Solicitud inválida." };
    const validacion = validarMonto(montoAutorizado);
    if (!validacion.ok) return { ok: false, evento: "MONTO_INVALIDO", mensaje: validacion.error };
    const monto = validacion.valor;

    return firestore().runTransaction(async (tx) => {
      const solRef = referencia(COLECCIONES.SOLICITUDES, numero);
      const marcaRef = referencia(COLECCIONES.CONFIGURACION, `resolucion_${numero}`);
      const [solSnap, marcaSnap] = await Promise.all([tx.get(solRef), tx.get(marcaRef)]);
      if (marcaSnap.exists) {
        return {
          ok: false,
          evento: "YA_RESUELTA",
          mensaje: "Otra persona ya resolvió esa solicitud. No se acreditó dos veces.",
        };
      }
      if (!solSnap.exists) {
        return { ok: false, evento: "NO_ENCONTRADA", mensaje: "La solicitud no existe." };
      }
      const actual = { id: solSnap.id, ...solSnap.data() };
      if (actual.estado !== "pendiente") {
        return { ok: false, evento: "YA_RESUELTA", mensaje: "Esa solicitud ya fue revisada." };
      }
      const declarado = aCentavos(actual.monto_declarado || actual.monto || 0);
      if (monto > declarado) {
        return {
          ok: false,
          evento: "MONTO_MAYOR",
          mensaje: `El importe autorizado no puede superar el monto declarado (Bs ${formatearBs(declarado)}).`,
        };
      }

      const estRef = referencia(COLECCIONES.ESTUDIANTES, actual.estudiante_id);
      const contadorRef = referencia(COLECCIONES.CONFIGURACION, "contador");
      const [estSnap, contadorSnap] = await Promise.all([tx.get(estRef), tx.get(contadorRef)]);
      if (!estSnap.exists) {
        return { ok: false, evento: "NO_ENCONTRADO", mensaje: "El estudiante ya no existe." };
      }
      const estudiante = { id: estSnap.id, ...estSnap.data() };
      const saldoAnterior = aCentavos(estudiante.saldo || 0);
      const saldoPosterior = aCentavos(saldoAnterior + monto);
      const actualContador = Number(contadorSnap.exists ? contadorSnap.data().transaccion : 0) || 0;
      const siguiente = actualContador + 1;
      const transNumero = `TRANS${String(siguiente).padStart(3, "0")}`;
      const ahora = new Date();
      const transaccion = {
        numero: transNumero,
        secuencia: siguiente,
        estudiante_id: actual.estudiante_id,
        nombre: estudiante.nombre || actual.nombre,
        curso: estudiante.curso || actual.curso,
        tipo: "RECARGA",
        monto,
        saldo_anterior: saldoAnterior,
        saldo_posterior: saldoPosterior,
        fecha: fechaLocal(ahora),
        hora: horaLocal(ahora),
        metodo: "comprobante",
        origen: "comprobante-admin",
        referencia: numero,
        revisado_por: revisor || null,
        estado: "aprobado",
      };

      tx.set(referencia(COLECCIONES.TRANSACCIONES, transNumero), transaccion, { merge: true });
      tx.set(estRef, { saldo: saldoPosterior }, { merge: true });
      tx.set(contadorRef, { transaccion: siguiente }, { merge: true });
      tx.set(
        solRef,
        {
          estado: "aprobada",
          monto_autorizado: monto,
          monto_creditado: monto,
          revisado_por: revisor || "admin",
          revisado_en: ahora.toISOString(),
          transaccion: transNumero,
        },
        { merge: true }
      );
      tx.set(
        marcaRef,
        {
          tipo: "resolucion_solicitud",
          solicitud: numero,
          estado: "aprobada",
          monto_autorizado: monto,
          revisado_por: revisor || "admin",
          fecha: ahora.toISOString(),
        },
        { merge: false }
      );

      return {
        ok: true,
        evento: "SALDO_RECARGADO",
        monto,
        saldo_anterior: saldoAnterior,
        saldo_posterior: saldoPosterior,
        transaccion,
        solicitud_aprobada: numero,
        mensaje: `Solicitud de ${actual.nombre} aprobada por Bs ${formatearBs(monto)}. Saldo: Bs ${formatearBs(saldoAnterior)} → Bs ${formatearBs(saldoPosterior)}.`,
      };
    });
  }

  async function rechazarSolicitudRecarga(solicitud, motivo, revisor) {
    const numero = String((solicitud && solicitud.numero) || "");
    if (!numero) return { ok: false, mensaje: "Solicitud inválida." };
    return firestore().runTransaction(async (tx) => {
      const solRef = referencia(COLECCIONES.SOLICITUDES, numero);
      const marcaRef = referencia(COLECCIONES.CONFIGURACION, `resolucion_${numero}`);
      const [solSnap, marcaSnap] = await Promise.all([tx.get(solRef), tx.get(marcaRef)]);
      if (marcaSnap.exists) {
        return { ok: false, mensaje: "Otra persona ya resolvió esa solicitud." };
      }
      if (!solSnap.exists) return { ok: false, mensaje: "La solicitud no existe." };
      const actual = { id: solSnap.id, ...solSnap.data() };
      if (actual.estado !== "pendiente") {
        return { ok: false, mensaje: "Esa solicitud ya fue revisada." };
      }
      const ahora = new Date().toISOString();
      tx.set(
        solRef,
        {
          estado: "rechazada",
          motivo: String(motivo || "").slice(0, 300),
          revisado_por: revisor || "admin",
          revisado_en: ahora,
        },
        { merge: true }
      );
      tx.set(
        marcaRef,
        {
          tipo: "resolucion_solicitud",
          solicitud: numero,
          estado: "rechazada",
          revisado_por: revisor || "admin",
          fecha: ahora,
        },
        { merge: false }
      );
      return {
        ok: true,
        mensaje: `Solicitud de ${actual.nombre} rechazada: ${String(motivo || "").slice(0, 300)}`,
      };
    });
  }

  async function buscarSolicitudPorHuella(huella, estado) {
    if (!huella) return null;
    const docs = await listarDocs(COLECCIONES.SOLICITUDES, {
      where: [{ campo: "huella", op: "==", valor: String(huella) }],
      limit: 50,
    });
    return docs.find((s) => !estado || s.estado === estado) || null;
  }

  /* --------------------------------------------------------------- asistencias */

  async function listarAsistenciasPorFecha(fecha) {
    let docs = [];
    try {
      docs = await listarDocs(COLECCIONES.ASISTENCIAS, {
        where: [{ campo: "fecha", op: "==", valor: String(fecha) }],
      });
    } catch {
      docs = [];
    }
    if (!docs.length) {
      const todas = await listarDocs(COLECCIONES.ASISTENCIAS);
      return todas.filter((a) => perteneceAFecha(a, fecha));
    }
    return docs.filter((a) => perteneceAFecha(a, fecha));
  }

  async function listarAsistenciasDeEstudiante(estudianteId, limite = 200) {
    if (!estudianteId) return [];
    let docs = [];
    try {
      docs = await listarDocs(COLECCIONES.ASISTENCIAS, {
        where: [{ campo: "estudiante_id", op: "==", valor: String(estudianteId) }],
      });
    } catch {
      docs = [];
    }
    if (!docs.length) {
      const todas = await listarDocs(COLECCIONES.ASISTENCIAS);
      docs = todas.filter((a) => String(a.id || "").startsWith(`${estudianteId}_`));
    }
    docs.sort((a, b) => String(b.fecha || "").localeCompare(String(a.fecha || "")));
    return docs.slice(0, Math.max(1, limite));
  }

  function getAsistencia(estudianteId, fecha) {
    return leerDoc(COLECCIONES.ASISTENCIAS, `${estudianteId}_${fecha}`);
  }

  async function guardarAsistencia(documentoId, campos) {
    await referencia(COLECCIONES.ASISTENCIAS, documentoId).set(campos, { merge: true });
  }

  async function eliminarAsistencia(documentoId) {
    await referencia(COLECCIONES.ASISTENCIAS, documentoId).delete();
  }

  function resumen(asistencias) {
    let presentes = 0;
    let completas = 0;
    let permanencias = 0;
    let minutos = 0;
    for (const asistencia of asistencias) {
      if (!asistencia.hora_entrada) continue;
      presentes++;
      if (asistencia.hora_salida) completas++;
      const duracion = permanenciaMinutos(asistencia);
      if (duracion !== null) {
        permanencias++;
        minutos += duracion;
      }
    }
    return {
      presentes,
      completas,
      pendientes: presentes - completas,
      permanencias,
      minutos_totales: minutos,
      minutos_promedio: permanencias ? Math.round(minutos / permanencias) : null,
    };
  }

  function ordenarPorEntrada(lista) {
    return lista.sort((a, b) =>
      String(a.hora_entrada || "").localeCompare(String(b.hora_entrada || ""))
    );
  }

  function fechaDe(asistencia) {
    if (asistencia.fecha) return String(asistencia.fecha);
    const id = String(asistencia.id || "");
    const guion = id.indexOf("_");
    return guion >= 0 ? id.slice(guion + 1) : "";
  }

  async function historialDe(estudianteId, limite = 200) {
    const registros = await listarAsistenciasDeEstudiante(estudianteId, limite);
    return registros.map((a) => ({
      fecha: fechaDe(a),
      hora_entrada: a.hora_entrada || "",
      hora_salida: a.hora_salida || "",
      estado: a.estado || (a.hora_salida ? "COMPLETA" : a.hora_entrada ? "ENTRADA" : ""),
      origen: a.origen || "",
      permanencia: formatearPermanencia(permanenciaMinutos(a)),
    }));
  }

  /* ------------------------------------------------------------------ huellas */

  async function listarHuellas() {
    const docs = await listarDocs(COLECCIONES.HUELLAS);
    return docs.filter((d) => d.id !== HUELLA_SOLICITUD && d.estudiante_id);
  }

  function getSolicitudHuella() {
    return leerDoc(COLECCIONES.HUELLAS, HUELLA_SOLICITUD);
  }

  async function guardarSolicitudHuella(campos) {
    await referencia(COLECCIONES.HUELLAS, HUELLA_SOLICITUD).set(campos, { merge: true });
  }

  async function eliminarHuella(slot) {
    await referencia(COLECCIONES.HUELLAS, String(slot)).delete();
  }

  async function ranuraLibre() {
    const huellas = await listarHuellas();
    const usadas = new Set(
      huellas.map((h) => Number(h.slot)).filter((n) => Number.isFinite(n))
    );
    for (let i = 1; i <= RANURAS_HUELLA; i++) {
      if (!usadas.has(i)) return i;
    }
    return null;
  }

  /* ----------------------------------------------------- operaciones de saldo */

  // Reserva el siguiente número de transacción y graba TODO (transacción,
  // saldo del estudiante y contador) en una sola transacción de Firestore.
  async function registrarOperacion({ datos, estudianteId, saldoPosterior, actualizaciones }) {
    return firestore().runTransaction(async (tx) => {
      const contadorRef = referencia(COLECCIONES.CONFIGURACION, "contador");
      const contadorSnap = await tx.get(contadorRef);
      const actual = Number(contadorSnap.exists ? contadorSnap.data().transaccion : 0) || 0;
      const siguiente = actual + 1;
      const numero = `TRANS${String(siguiente).padStart(3, "0")}`;
      const transaccion = { numero, secuencia: siguiente, ...datos };

      tx.set(referencia(COLECCIONES.TRANSACCIONES, numero), transaccion, { merge: true });
      for (const cambio of actualizaciones ? actualizaciones(transaccion) : []) {
        tx.set(referencia(cambio.coleccion, cambio.id), cambio.fields, { merge: true });
      }
      if (estudianteId && saldoPosterior !== undefined) {
        tx.set(referencia(COLECCIONES.ESTUDIANTES, estudianteId), { saldo: saldoPosterior }, {
          merge: true,
        });
      }
      tx.set(contadorRef, { transaccion: siguiente }, { merge: true });
      return transaccion;
    });
  }

  async function recargarSaldo(estudianteId, monto, metodo = "manual", opciones = {}) {
    const validacion = validarMonto(monto);
    if (!validacion.ok) {
      return { ok: false, evento: "MONTO_INVALIDO", mensaje: validacion.error };
    }
    const cantidad = validacion.valor;
    if (!estudianteId) {
      return { ok: false, evento: "NO_ENCONTRADO", mensaje: "Indica el estudiante a recargar." };
    }

    const estudiante = await getEstudiantePorId(estudianteId);
    if (!estudiante) {
      return { ok: false, evento: "NO_ENCONTRADO", mensaje: "El estudiante no existe." };
    }

    const saldoAnterior = aCentavos(estudiante.saldo || 0);
    const saldoPosterior = aCentavos(saldoAnterior + cantidad);
    const { fecha, hora } = { fecha: fechaLocal(), hora: horaLocal() };

    const transaccion = await registrarOperacion({
      datos: {
        estudiante_id: estudianteId,
        nombre: estudiante.nombre,
        curso: estudiante.curso,
        tipo: "RECARGA",
        monto: cantidad,
        saldo_anterior: saldoAnterior,
        saldo_posterior: saldoPosterior,
        fecha,
        hora,
        metodo,
        origen: opciones.origen || "admin-manual",
        referencia: opciones.referencia || null,
        revisado_por: opciones.revisor || null,
        estado: "aprobado",
      },
      estudianteId,
      saldoPosterior,
    });

    return {
      ok: true,
      evento: "SALDO_RECARGADO",
      estudiante: {
        estudiante_id: estudianteId,
        nombre: estudiante.nombre,
        curso: estudiante.curso,
      },
      monto: cantidad,
      saldo_anterior: saldoAnterior,
      saldo_posterior: saldoPosterior,
      transaccion,
      mensaje: `${estudiante.nombre} (${estudiante.curso}): recarga de Bs ${formatearBs(cantidad)} (${metodo}). Saldo: Bs ${formatearBs(saldoAnterior)} → Bs ${formatearBs(saldoPosterior)}.`,
    };
  }

  async function revertirRecarga(numeroTransaccion, motivo = "corrección del administrador", revisor = null) {
    if (!numeroTransaccion) {
      return { ok: false, evento: "TRANSACCION_INVALIDA", mensaje: "Indica la recarga a revertir." };
    }
    const original = await getTransaccion(numeroTransaccion);
    if (!original) {
      return { ok: false, evento: "TRANSACCION_INVALIDA", mensaje: "La recarga no existe." };
    }
    if (original.tipo !== "RECARGA") {
      return { ok: false, evento: "NO_REVERSIBLE", mensaje: "Solo se revierten recargas, no cobros." };
    }
    if (original.estado === "anulado" || original.revertido_por) {
      return {
        ok: false,
        evento: "YA_REVERTIDA",
        mensaje: `La recarga ${numeroTransaccion} ya fue revertida (${original.revertido_por}).`,
      };
    }

    const estudianteId = original.estudiante_id;
    const estudiante = await getEstudiantePorId(estudianteId);
    if (!estudiante) {
      return { ok: false, evento: "NO_ENCONTRADO", mensaje: "El estudiante ya no existe." };
    }

    const monto = aCentavos(Math.abs(Number(original.monto) || 0));
    const saldoAnterior = aCentavos(estudiante.saldo || 0);
    const saldoPosterior = aCentavos(saldoAnterior - monto);

    const anulacion = await registrarOperacion({
      datos: {
        estudiante_id: estudianteId,
        nombre: original.nombre,
        curso: original.curso,
        tipo: "ANULACION",
        monto: -monto,
        saldo_anterior: saldoAnterior,
        saldo_posterior: saldoPosterior,
        fecha: fechaLocal(),
        hora: horaLocal(),
        metodo: "reversión",
        origen: "admin-reversion",
        referencia: numeroTransaccion,
        motivo: String(motivo).slice(0, 300),
        revisado_por: revisor || null,
        estado: "aprobado",
      },
      estudianteId,
      saldoPosterior,
      actualizaciones: (transaccion) => [
        {
          coleccion: COLECCIONES.TRANSACCIONES,
          id: numeroTransaccion,
          fields: { estado: "anulado", revertido_por: transaccion.numero },
        },
      ],
    });

    return {
      ok: true,
      evento: "RECARGA_REVERTIDA",
      estudiante: {
        estudiante_id: estudianteId,
        nombre: original.nombre,
        curso: original.curso,
      },
      monto,
      saldo_anterior: saldoAnterior,
      saldo_posterior: saldoPosterior,
      saldo_negativo: saldoPosterior < 0,
      transaccion: anulacion,
      recarga_revertida: numeroTransaccion,
      mensaje: `Se revirtió la recarga ${numeroTransaccion} de Bs ${formatearBs(monto)} (${original.nombre}). Saldo: Bs ${formatearBs(saldoAnterior)} → Bs ${formatearBs(saldoPosterior)}${saldoPosterior < 0 ? " (quedó en negativo)" : ""}.`,
    };
  }

  /* ---------------------------------------------------------------- pedidos */

  // Estados de un pedido del comedor.
  const ESTADO_PEDIDO = "PEDIDO";
  const ESTADO_PAGO_SOLICITADO = "PAGO_SOLICITADO";
  const ESTADO_PAGADO = "PAGADO";
  const ESTADO_RECOGIDO = "RECOGIDO";
  const ESTADO_SIN_SALDO = "SIN_SALDO";
  const ESTADO_RECHAZADO = "RECHAZADO";
  const ESTADO_CANCELADO = "CANCELADO";

  async function listarPedidosPorFecha(fecha) {
    const docs = await listarDocs(COLECCIONES.PEDIDOS, {
      where: [{ campo: "fecha", op: "==", valor: String(fecha) }],
    });
    return docs.sort((a, b) =>
      String(b.hora_pedido || "").localeCompare(String(a.hora_pedido || ""))
    );
  }

  // Cocina trabaja con pedidos y entregas, no con dinero: se quitan importes y
  // datos de saldo antes de responderle a ese perfil.
  function sinImportesPedido(pedido) {
    if (!pedido) return pedido;
    const {
      monto,
      precio,
      saldo,
      saldo_posterior,
      saldo_anterior,
      transaccion,
      ...resto
    } = pedido;
    return {
      ...resto,
      mensaje: String(resto.mensaje || "").replace(/Bs\.?\s*[\d.,]+/gi, "Bs —"),
    };
  }

  function resumenSinImportes(resumen) {
    const { monto_cobrado, monto_por_cobrar, ...conteos } = resumen || {};
    return conteos;
  }

  function resumenPedidos(pedidos, precioPorDefecto = 0) {
    const cuenta = {
      total: 0,
      pendientes: 0,
      solicitados: 0,
      pagados: 0,
      por_entregar: 0,
      entregados: 0,
      sin_saldo: 0,
      rechazados: 0,
      cancelados: 0,
      monto_cobrado: 0,
      monto_por_cobrar: 0,
    };
    for (const pedido of pedidos || []) {
      cuenta.total++;
      // El lector no sabe el precio: los pedidos nuevos no guardan `monto`
      // hasta que se cobran, así que se usa el precio configurado.
      const monto =
        Number(pedido.monto || pedido.precio || precioPorDefecto || 0) || 0;
      switch (pedido.estado) {
        case ESTADO_PEDIDO:
          cuenta.pendientes++;
          cuenta.monto_por_cobrar += monto;
          break;
        case ESTADO_PAGO_SOLICITADO:
          cuenta.solicitados++;
          cuenta.monto_por_cobrar += monto;
          break;
        case ESTADO_PAGADO:
          cuenta.pagados++;
          cuenta.por_entregar++;
          cuenta.monto_cobrado += monto;
          break;
        case ESTADO_RECOGIDO:
          cuenta.pagados++;
          cuenta.entregados++;
          cuenta.monto_cobrado += monto;
          break;
        case ESTADO_SIN_SALDO:
          cuenta.sin_saldo++;
          cuenta.monto_por_cobrar += monto;
          break;
        case ESTADO_RECHAZADO:
          cuenta.rechazados++;
          break;
        case ESTADO_CANCELADO:
          cuenta.cancelados++;
          break;
        default:
          cuenta.pendientes++;
          break;
      }
    }
    cuenta.monto_cobrado = aCentavos(cuenta.monto_cobrado);
    cuenta.monto_por_cobrar = aCentavos(cuenta.monto_por_cobrar);
    return cuenta;
  }

  // La tarjeta y la huella tienen que ser las del estudiante del pedido.
  async function validarEvidenciaPedido(pedido) {
    const estudianteId = String(pedido.estudiante_id || "");
    if (!estudianteId) {
      return { ok: false, motivo: "El pedido no indica a qué estudiante es." };
    }
    const slot = Number(pedido.huella_slot);
    const hayHuella = Number.isFinite(slot) && slot > 0;
    const uid = String(pedido.tarjeta || "").trim();
    if (!hayHuella && !uid) {
      return { ok: false, motivo: "El cobro no viene ni de una tarjeta ni de una huella." };
    }
    if (hayHuella) {
      const huella = await leerDoc(COLECCIONES.HUELLAS, slot);
      if (!huella || String(huella.estudiante_id || "") !== estudianteId) {
        return { ok: false, motivo: "La huella reconocida no es la del estudiante del pedido." };
      }
    }
    if (uid) {
      const tarjeta = await leerDoc(COLECCIONES.TARJETAS, uid);
      if (!tarjeta || String(tarjeta.estudiante_id || "") !== estudianteId) {
        return { ok: false, motivo: "La tarjeta leída no es la del estudiante del pedido." };
      }
    }
    return { ok: true };
  }

  // Cobra un pedido: descuenta el saldo y lo deja PAGADO, pendiente de entrega.
  // Nunca marca la entrega: esa la confirma cocina con `entregarPedido`.
  async function cobrarPedido(pedido, opciones = {}) {
    const config = await getConfig();
    const precio = config.precio;
    const fecha = fechaLocal();
    const hora = horaLocal();

    try {
      return await firestore().runTransaction(async (tx) => {
        const estRef = referencia(COLECCIONES.ESTUDIANTES, pedido.estudiante_id);
        const contadorRef = referencia(COLECCIONES.CONFIGURACION, "contador");
        const pedidoRef = referencia(COLECCIONES.PEDIDOS, pedido.id);
        const pagoRef = referencia(COLECCIONES.CONFIGURACION, `pago_${pedido.id}`);
        const [estSnap, contadorSnap, pedidoSnap, pagoSnap] = await Promise.all([
          tx.get(estRef),
          tx.get(contadorRef),
          tx.get(pedidoRef),
          tx.get(pagoRef),
        ]);

        // La marca de pago es la garantía contra doble cobro, incluso si el
        // lector vuelve a pedir el pago o dos operadores pulsan a la vez.
        if (pagoSnap.exists) {
          return {
            ok: false,
            evento: "PEDIDO_YA_PAGADO",
            nombre: pedido.nombre,
            mensaje: "Ese pedido ya fue cobrado. No se descontó el saldo otra vez.",
          };
        }
        const actual = pedidoSnap.exists ? { id: pedidoSnap.id, ...pedidoSnap.data() } : pedido;
        if (actual.estado === ESTADO_PAGADO || actual.estado === ESTADO_RECOGIDO) {
          return {
            ok: false,
            evento: "PEDIDO_YA_PAGADO",
            nombre: actual.nombre || pedido.nombre,
            mensaje: "Ese pedido ya está pagado.",
          };
        }
        if (actual.estado === ESTADO_CANCELADO) {
          return {
            ok: false,
            evento: "PEDIDO_CANCELADO",
            nombre: actual.nombre || pedido.nombre,
            mensaje: "Ese pedido está cancelado y no se puede cobrar.",
          };
        }

        const fresco = estSnap.exists ? { id: estSnap.id, ...estSnap.data() } : null;
        if (!fresco) {
          return {
            ok: false,
            evento: "ESTUDIANTE_NO_EXISTE",
            mensaje: "El estudiante del pedido ya no existe.",
          };
        }
        const saldo = aCentavos(fresco.saldo || 0);

        if (saldo < precio) {
          return {
            ok: false,
            evento: "SALDO_INSUFICIENTE",
            saldo,
            precio,
            mensaje: `${fresco.nombre}: saldo insuficiente. Tiene Bs ${formatearBs(saldo)} y el almuerzo cuesta Bs ${formatearBs(precio)}. Faltan Bs ${formatearBs(aCentavos(precio - saldo))}.`,
          };
        }

        const saldoPosterior = aCentavos(saldo - precio);
        const actualContador = Number(contadorSnap.exists ? contadorSnap.data().transaccion : 0) || 0;
        const siguiente = actualContador + 1;
        const numero = `TRANS${String(siguiente).padStart(3, "0")}`;
        const transaccion = {
          numero,
          secuencia: siguiente,
          estudiante_id: fresco.estudiante_id || pedido.estudiante_id,
          nombre: fresco.nombre || pedido.nombre,
          curso: fresco.curso || pedido.curso,
          tipo: "COMPRA",
          precio,
          monto: precio,
          saldo_anterior: saldo,
          saldo_posterior: saldoPosterior,
          fecha,
          hora,
          metodo: opciones.manual ? "caja" : pedido.metodo || "tarjeta+huella",
          origen: opciones.manual ? "caja-manual" : "pedido-rfid",
          referencia: pedido.id,
          revisado_por: opciones.revisor || null,
          estado: "aprobado",
        };

        tx.set(referencia(COLECCIONES.TRANSACCIONES, numero), transaccion, { merge: true });
        tx.set(estRef, { saldo: saldoPosterior }, { merge: true });
        tx.set(contadorRef, { transaccion: siguiente }, { merge: true });
        tx.set(
          pagoRef,
          {
            tipo: "pago_pedido",
            pedido_id: pedido.id,
            estudiante_id: fresco.estudiante_id || pedido.estudiante_id,
            monto: precio,
            transaccion: numero,
            revisado_por: opciones.revisor || null,
            fecha: new Date().toISOString(),
          },
          { merge: false }
        );
        tx.set(
          pedidoRef,
          {
            estado: ESTADO_PAGADO,
            hora_pago: hora,
            precio,
            monto: precio,
            transaccion: numero,
            revisado_por: opciones.revisor || null,
            mensaje: "Almuerzo pagado. Pendiente de entrega en cocina.",
            actualizado: new Date().toISOString(),
          },
          { merge: true }
        );

        return {
          ok: true,
          evento: "PEDIDO_PAGADO",
          nombre: fresco.nombre || pedido.nombre,
          monto: precio,
          saldo_posterior: saldoPosterior,
          transaccion,
          mensaje: `${fresco.nombre || pedido.nombre}: almuerzo pagado. Se descontaron Bs ${formatearBs(precio)}. Saldo restante: Bs ${formatearBs(saldoPosterior)}. Pendiente de entrega.`,
        };
      });
    } catch (error) {
      return {
        ok: false,
        evento: "ERROR_PAGO",
        mensaje: `No se pudo registrar el pago: ${error.message}`,
      };
    }
  }

  // El administrador cobra a mano un pedido (por ejemplo, después de recargar
  // el saldo del estudiante). Ya no se ejecuta ningún cobro automático en la
  // nube desde la lista de pedidos.
  async function cobrarPedidoManual(estudianteId, fecha, revisor = null) {
    const id = `${estudianteId}_${fecha}`;
    const pedido = await leerDoc(COLECCIONES.PEDIDOS, id);
    if (!pedido) {
      return { ok: false, mensaje: "Ese estudiante no tiene ningún pedido ese día." };
    }
    if (pedido.estado === ESTADO_PAGADO || pedido.estado === ESTADO_RECOGIDO) {
      return {
        ok: false,
        mensaje:
          pedido.estado === ESTADO_PAGADO
            ? "Ese pedido ya está pagado; solo falta entregarlo."
            : "Ese pedido ya está pagado y entregado.",
      };
    }
    const resultado = await cobrarPedido(pedido, { manual: true, revisor });
    if (!resultado.ok) {
      // No se pisa un pedido pagado por una carrera con otro cobro.
      const actual = await leerDoc(COLECCIONES.PEDIDOS, id);
      if (
        actual &&
        actual.estado !== ESTADO_PAGADO &&
        actual.estado !== ESTADO_RECOGIDO &&
        actual.estado !== ESTADO_CANCELADO
      ) {
        await referencia(COLECCIONES.PEDIDOS, id).set(
          {
            estado: ESTADO_SIN_SALDO,
            mensaje: resultado.mensaje,
            actualizado: new Date().toISOString(),
          },
          { merge: true }
        );
      }
    }
    return resultado;
  }

  // Confirma la entrega de un pedido pagado. La marca
  // `configuracion/entrega_<pedido>` se crea en la misma transacción, así que
  // dos clics o dos cocineras no registran la misma entrega dos veces.
  async function entregarPedido(estudianteId, fecha, revisor = null) {
    const id = `${estudianteId}_${fecha}`;
    try {
      return await firestore().runTransaction(async (tx) => {
        const pedidoRef = referencia(COLECCIONES.PEDIDOS, id);
        const entregaRef = referencia(COLECCIONES.CONFIGURACION, `entrega_${id}`);
        const [pedidoSnap, entregaSnap] = await Promise.all([
          tx.get(pedidoRef),
          tx.get(entregaRef),
        ]);
        if (!pedidoSnap.exists) {
          return { ok: false, evento: "PEDIDO_NO_EXISTE", mensaje: "Ese pedido no existe." };
        }
        if (entregaSnap.exists) {
          return {
            ok: false,
            evento: "PEDIDO_YA_ENTREGADO",
            mensaje: "Otra persona ya confirmó esta entrega. No se registró dos veces.",
          };
        }
        const pedido = { id: pedidoSnap.id, ...pedidoSnap.data() };
        if (pedido.estado === ESTADO_RECOGIDO) {
          return {
            ok: false,
            evento: "PEDIDO_YA_ENTREGADO",
            mensaje: `El pedido de ${pedido.nombre} ya fue entregado.`,
          };
        }
        if (pedido.estado !== ESTADO_PAGADO) {
          return {
            ok: false,
            evento: "PEDIDO_NO_PAGADO",
            mensaje: `El pedido de ${pedido.nombre} todavía no está pagado; primero debe cobrarse en caja.`,
          };
        }

        const hora = horaLocal();
        tx.set(
          entregaRef,
          {
            tipo: "entrega_pedido",
            pedido_id: id,
            estudiante_id: pedido.estudiante_id || estudianteId,
            entregado_por: revisor || "cocina",
            fecha: new Date().toISOString(),
            hora,
          },
          { merge: false }
        );
        tx.set(
          pedidoRef,
          {
            estado: ESTADO_RECOGIDO,
            hora_recogido: hora,
            entrega_confirmada: true,
            entregado_por: revisor || "cocina",
            mensaje: "Almuerzo entregado.",
            actualizado: new Date().toISOString(),
          },
          { merge: true }
        );

        return {
          ok: true,
          evento: "PEDIDO_ENTREGADO",
          nombre: pedido.nombre,
          estado: ESTADO_RECOGIDO,
          mensaje: `Almuerzo de ${pedido.nombre} entregado.`,
        };
      });
    } catch (error) {
      if (String(error && error.message).includes("ALREADY_EXISTS")) {
        return {
          ok: false,
          evento: "PEDIDO_YA_ENTREGADO",
          mensaje: "Otra persona ya confirmó esta entrega. No se registró dos veces.",
        };
      }
      return {
        ok: false,
        evento: "ERROR_ENTREGA",
        mensaje: `No se pudo registrar la entrega: ${error.message}`,
      };
    }
  }

  async function cancelarPedido(estudianteId, fecha, motivo) {
    const id = `${estudianteId}_${fecha}`;
    const pedido = await leerDoc(COLECCIONES.PEDIDOS, id);
    if (!pedido) {
      return { ok: false, mensaje: "Ese estudiante no tiene ningún pedido ese día." };
    }
    if (pedido.estado === ESTADO_RECOGIDO) {
      return { ok: false, mensaje: "Ese pedido ya fue pagado y entregado: no se puede cancelar." };
    }
    if (pedido.estado === ESTADO_PAGADO) {
      return {
        ok: false,
        mensaje:
          "Ese pedido ya está pagado. No se cancela desde cocina; si hubo un error, caja debe registrar el ajuste.",
      };
    }
    await referencia(COLECCIONES.PEDIDOS, id).set(
      {
        estado: ESTADO_CANCELADO,
        mensaje: motivo ? limpiar(motivo, 200) : "Cancelado por el administrador.",
        actualizado: new Date().toISOString(),
      },
      { merge: true }
    );
    return { ok: true, mensaje: `Pedido de ${pedido.nombre} cancelado.` };
  }

  /* --------------------------------------------------------------- alta de estudiantes */

  function idDe(estudiante) {
    return String(estudiante.estudiante_id || estudiante.id || "");
  }

  function siguienteId(estudiantes) {
    let max = 0;
    for (const e of estudiantes) {
      const coincidencia = /^EST(\d+)$/i.exec(idDe(e));
      if (coincidencia) max = Math.max(max, parseInt(coincidencia[1], 10));
    }
    return `EST${String(max + 1).padStart(3, "0")}`;
  }

  function numeroDeId(id) {
    const coincidencia = /(\d+)/.exec(String(id || ""));
    return coincidencia ? parseInt(coincidencia[1], 10) : null;
  }

  async function crearEstudiante({ nombre, curso, estudiante_id, rfid, password } = {}) {
    const nom = limpiar(nombre, 90);
    if (!nom) return { ok: false, error: "Escribe el nombre del estudiante." };
    const cur = limpiar(curso, 40);

    const estudiantes = await listarEstudiantes();

    let id = limpiar(estudiante_id, 20);
    if (id) {
      if (estudiantes.some((e) => idDe(e).toLowerCase() === id.toLowerCase())) {
        return { ok: false, error: `Ya existe un estudiante con el id ${id}.` };
      }
    } else {
      id = siguienteId(estudiantes);
    }

    const uid = limpiar(rfid, 40);
    if (uid) {
      const dueno = estudiantes.find((e) => rfidsDe(e).includes(uid));
      if (dueno) {
        return { ok: false, error: `Esa tarjeta ya está asignada a ${dueno.nombre}.` };
      }
    }

    const clave = limpiar(password, 60) || generarPassword();
    const nuevo = {
      estudiante_id: id,
      nombre: nom,
      nombre_clave: normalizar(nom),
      curso: cur,
      saldo: 0,
      contrasena: await hashPasswordWeb(clave),
    };
    if (uid) nuevo.rfid = uid;

    await guardarEstudiante(id, nuevo);
    if (uid) await sincronizarTarjeta(uid, nuevo);

    return {
      ok: true,
      estudiante: { estudiante_id: id, nombre: nom, curso: cur, saldo: 0, rfid: uid || null },
      password: clave,
      mensaje: `Estudiante ${nom} creado (${id}). Su contraseña es "${clave}".`,
    };
  }

  async function asignarTarjetaEstudiante(estudianteId, uid) {
    const estudiante = await getEstudiantePorId(String(estudianteId || ""));
    if (!estudiante) return { ok: false, error: "El estudiante no existe." };

    const id = idDe(estudiante);
    const valor = limpiar(uid, 40);
    const principal = String(estudiante.rfid || "").trim();
    const alterna = String(estudiante.rfid_alt || "").trim();
    const actuales = rfidsDe(estudiante);

    if (!valor) {
      await referencia(COLECCIONES.ESTUDIANTES, id).set(
        { rfid: null, rfid_alt: null },
        { merge: true }
      );
      for (const anterior of actuales) {
        await referencia(COLECCIONES.TARJETAS, anterior).delete();
      }
      return {
        ok: true,
        uid: null,
        mensaje: `Se quitaron las tarjetas de ${estudiante.nombre}.`,
      };
    }

    if (actuales.includes(valor)) {
      return {
        ok: true,
        uid: valor,
        mensaje: `La tarjeta ${valor} ya estaba asignada a ${estudiante.nombre}.`,
      };
    }

    const estudiantes = await listarEstudiantes();
    const dueno = estudiantes.find(
      (e) => idDe(e) !== id && rfidsDe(e).includes(valor)
    );
    if (dueno) {
      return { ok: false, error: `Esa tarjeta ya está asignada a ${dueno.nombre}.` };
    }

    // Sin tarjeta principal -> esta es la primera. Con principal y sin segunda
    // -> se agrega como segunda. Con las dos -> se reemplaza solo la segunda.
    if (!principal) {
      await referencia(COLECCIONES.ESTUDIANTES, id).set({ rfid: valor }, { merge: true });
    } else {
      await referencia(COLECCIONES.ESTUDIANTES, id).set(
        { rfid_alt: valor },
        { merge: true }
      );
      if (alterna && alterna !== valor) {
        await referencia(COLECCIONES.TARJETAS, alterna).delete();
      }
    }
    await sincronizarTarjeta(valor, estudiante);

    return {
      ok: true,
      uid: valor,
      mensaje: principal
        ? `Segunda tarjeta ${valor} agregada a ${estudiante.nombre}.`
        : `Tarjeta ${valor} asignada a ${estudiante.nombre}.`,
    };
  }

  /* ------------------------------------------------------------- manejadores */

  function ok(datos) {
    return { ok: true, status: 200, datos: datos === undefined ? {} : datos };
  }

  function fallo(status, mensaje) {
    return { ok: false, status, datos: { ok: false, error: mensaje } };
  }

  function tokenDe(cabeceras) {
    const encabezado = (cabeceras && (cabeceras.get?.("authorization") || cabeceras.Authorization)) || "";
    const [tipo, valor] = String(encabezado).split(" ");
    return tipo && tipo.toLowerCase() === "bearer" ? valor : null;
  }

  function tieneRol(sesion, roles) {
    return Boolean(sesion && roles.includes(sesion.rol));
  }

  function requiereAdmin(sesion) {
    return tieneRol(sesion, ["admin"]);
  }

  function requiereCaja(sesion) {
    return tieneRol(sesion, ["admin", "caja"]);
  }

  function requiereOperador(sesion) {
    return tieneRol(sesion, ["admin", "caja", "cocinera"]);
  }

  async function manejarNube(metodo, ruta, parametros, cuerpo, token) {
    const sesion = leerToken(token);
    // En la nube no hay autorización administrativa real todavía. Los endpoints
    // de caja/cocina responden 403 aunque alguien fabrique un token, y la
    // comprobación se podrá activar cuando exista Firebase Authentication.
    const esAdmin = ADMIN_NUBE_HABILITADO && requiereAdmin(sesion);
    const esCaja = ADMIN_NUBE_HABILITADO && requiereCaja(sesion);
    const esOperador = ADMIN_NUBE_HABILITADO && requiereOperador(sesion);

    // ----- estado general -----
    if (metodo === "GET" && ruta === "/api/status") {
      return ok({
        lector: false,
        dispositivo: null,
        proyectoFirebase: PROYECTO,
        momento: new Date().toLocaleString("es-VE"),
      });
    }

    if (metodo === "GET" && ruta === "/api/ultimo") {
      return ok(null);
    }

    // ----- estudiantes -----
    if (metodo === "GET" && ruta === "/api/estudiantes") {
      return ok(await listarEstudiantesPublicos(Boolean(esCaja)));
    }

    if (metodo === "POST" && ruta === "/api/estudiantes") {
      if (!esAdmin) return fallo(403, "Sesión de administrador requerida.");
      const resultado = await crearEstudiante(cuerpo || {});
      if (!resultado.ok) return fallo(400, resultado.error);
      return ok(resultado);
    }

    if (metodo === "POST" && ruta === "/api/estudiantes/tarjeta") {
      if (!esAdmin) return fallo(403, "Sesión de administrador requerida.");
      const resultado = await asignarTarjetaEstudiante(
        String((cuerpo || {}).estudiante_id || ""),
        (cuerpo || {}).uid
      );
      if (!resultado.ok) return fallo(400, resultado.error);
      return ok(resultado);
    }

    if (metodo === "POST" && ruta === "/api/estudiantes/pagador") {
      if (!esAdmin) return fallo(403, "Sesión de administrador requerida.");
      const estudianteId = String((cuerpo || {}).estudiante_id || "");
      const estudiante = await getEstudiantePorId(estudianteId);
      if (!estudiante) return fallo(404, "Estudiante no encontrado.");
      const pagador = normalizarBeneficiario({ nombre: (cuerpo || {}).pagador }).nombre;
      await referencia(COLECCIONES.ESTUDIANTES, estudianteId).set(
        { pagador: pagador || null },
        { merge: true }
      );
      return ok({
        ok: true,
        pagador,
        mensaje: pagador
          ? `Ahora los comprobantes de ${estudiante.nombre} deben venir de ${pagador}.`
          : `Se quitó el pagador de ${estudiante.nombre}; se usará su propio nombre.`,
      });
    }

    // ----- transacciones -----
    if (metodo === "GET" && ruta === "/api/transacciones") {
      if (!esCaja) return fallo(403, "Esta acción requiere el perfil de caja.");
      return ok(await listarTransacciones(MAX_TRANSACCIONES));
    }

    // ----- asistencias -----
    if (metodo === "GET" && ruta === "/api/asistencias") {
      if (!esOperador) return fallo(403, "Sesión del área de administración requerida.");
      const fecha = parametros.get("fecha") || fechaLocal();
      if (!esFechaValida(fecha)) return fallo(400, "Usa el formato AAAA-MM-DD.");
      const asistencias = ordenarPorEntrada(await listarAsistenciasPorFecha(fecha));
      const totalEstudiantes = await contarEstudiantes();
      return ok({
        fecha,
        asistencias,
        resumen: resumen(asistencias),
        total_estudiantes: totalEstudiantes,
      });
    }

    if (metodo === "POST" && ruta === "/api/asistencias/registrar") {
      if (!esAdmin) return fallo(403, "Sesión de administrador requerida.");
      const accion = (cuerpo || {}).accion === "salida" ? "salida" : "entrada";
      const resultado = await registrarManual({
        estudiante_id: (cuerpo || {}).estudiante_id,
        accion,
        fecha: (cuerpo || {}).fecha,
      });
      if (!resultado.ok) return { ok: false, status: 400, datos: resultado };
      return ok(resultado);
    }

    if (metodo === "POST" && ruta === "/api/asistencias/eliminar") {
      if (!esAdmin) return fallo(403, "Sesión de administrador requerida.");
      const resultado = await eliminarRegistro(
        String((cuerpo || {}).estudiante_id || ""),
        (cuerpo || {}).fecha
      );
      if (!resultado.ok) return { ok: false, status: 400, datos: resultado };
      return ok(resultado);
    }

    // ----- pedidos del comedor -----
    if (metodo === "GET" && ruta === "/api/pedidos") {
      if (!esOperador) return fallo(403, "Sesión del área de administración requerida.");
      const fecha = parametros.get("fecha") || fechaLocal();
      if (!esFechaValida(fecha)) return fallo(400, "Usa el formato AAAA-MM-DD.");
      // No se cobra nada al abrir la lista. El cobro es una acción explícita de
      // caja o del lector con el servidor local.
      const lista = await listarPedidosPorFecha(fecha);
      const config = await getConfig();
      const esCocina = sesion.rol === "cocinera";
      return ok({
        fecha,
        pedidos: esCocina ? lista.map(sinImportesPedido) : lista,
        resumen: esCocina
          ? resumenSinImportes(resumenPedidos(lista, config.precio))
          : resumenPedidos(lista, config.precio),
      });
    }

    if (metodo === "GET" && ruta === "/api/pedidos/mio") {
      const estudianteId = sesion && sesion.estudianteId;
      if (!estudianteId) return fallo(401, "Sesión de usuario requerida.");
      const fecha = parametros.get("fecha") || fechaLocal();
      const pedido = await leerDoc(COLECCIONES.PEDIDOS, `${estudianteId}_${fecha}`);
      return ok({ ok: true, fecha, pedido: pedido || null });
    }

    if (metodo === "POST" && ruta === "/api/pedidos/cobrar") {
      if (!esCaja) return fallo(403, "Esta acción requiere el perfil de caja.");
      const cuerpo = cuerpo || {};
      const resultado = await cobrarPedidoManual(
        String(cuerpo.estudiante_id || ""),
        String(cuerpo.fecha || fechaLocal()),
        sesion.rol
      );
      if (!resultado.ok) return { ok: false, status: 400, datos: resultado };
      return ok(resultado);
    }

    if (metodo === "POST" && ruta === "/api/pedidos/entregar") {
      if (!ADMIN_NUBE_HABILITADO || !tieneRol(sesion, ["admin", "cocinera"])) {
        return fallo(403, "Esta acción requiere el perfil de cocina o administración.");
      }
      const cuerpo = cuerpo || {};
      const resultado = await entregarPedido(
        String(cuerpo.estudiante_id || ""),
        String(cuerpo.fecha || fechaLocal()),
        sesion.rol
      );
      if (!resultado.ok) return { ok: false, status: 400, datos: resultado };
      return ok(resultado);
    }

    if (metodo === "POST" && ruta === "/api/pedidos/cancelar") {
      if (!esCaja) return fallo(403, "Esta acción requiere el perfil de caja.");
      const cuerpo = cuerpo || {};
      const resultado = await cancelarPedido(
        String(cuerpo.estudiante_id || ""),
        String(cuerpo.fecha || fechaLocal()),
        cuerpo.motivo
      );
      if (!resultado.ok) return { ok: false, status: 400, datos: resultado };
      return ok(resultado);
    }

    // ----- huellas -----
    if (metodo === "GET" && ruta === "/api/huellas") {
      if (!esAdmin) return fallo(403, "Sesión de administrador requerida.");
      const [huellas, solicitud] = await Promise.all([
        listarHuellas(),
        getSolicitudHuella(),
      ]);
      return ok({ ok: true, huellas, solicitud: solicitud || null });
    }

    if (metodo === "GET" && ruta === "/api/huellas/solicitud") {
      if (!esAdmin) return fallo(403, "Sesión de administrador requerida.");
      const solicitud = await getSolicitudHuella();
      return ok({ ok: true, solicitud: solicitud || null });
    }

    if (metodo === "POST" && ruta === "/api/huellas/solicitar") {
      if (!esAdmin) return fallo(403, "Sesión de administrador requerida.");
      const resultado = await solicitarHuella(String((cuerpo || {}).estudiante_id || ""));
      if (!resultado.ok) return { ok: false, status: 400, datos: resultado };
      return ok(resultado);
    }

    if (metodo === "POST" && ruta === "/api/huellas/quitar") {
      if (!esAdmin) return fallo(403, "Sesión de administrador requerida.");
      const resultado = await quitarHuella(String((cuerpo || {}).estudiante_id || ""));
      if (!resultado.ok) return { ok: false, status: 400, datos: resultado };
      return ok(resultado);
    }

    if (metodo === "POST" && ruta === "/api/huellas/cancelar") {
      if (!esAdmin) return fallo(403, "Sesión de administrador requerida.");
      await guardarSolicitudHuella({
        accion: "ninguna",
        estado: "inactivo",
        mensaje: "",
        actualizado: new Date().toISOString(),
      });
      return ok({ ok: true, mensaje: "Enrolamiento cancelado." });
    }

    // ----- sesiones -----
    // No hay login administrativo en la nube. No se compara ninguna contraseña
    // en el navegador: el panel se habilitará con Firebase Authentication y
    // reglas de Firestore por rol.
    if (metodo === "POST" && ruta === "/api/admin/login") {
      return fallo(
        403,
        "El acceso administrativo no está disponible en modo nube. Usa el servidor local o configura Firebase Authentication."
      );
    }

    if (metodo === "POST" && ruta === "/api/admin/logout") {
      recordarSesion("", "");
      return ok({ ok: true });
    }

    if (metodo === "GET" && ruta === "/api/admin/sesion") {
      return ok({ ok: false, rol: null, motivo: "modo-nube-sin-auth" });
    }

    if (metodo === "POST" && ruta === "/api/login") {
      const nombre = String((cuerpo || {}).nombre || "").trim();
      const password = String((cuerpo || {}).password || "");
      if (!nombre || !password) {
        return fallo(400, "Ingresa el nombre y la contraseña.");
      }
      const estudiante = await getEstudiantePorNombre(nombre);
      if (!estudiante) {
        return fallo(401, "Nombre o contraseña incorrectos.");
      }
      const passOk = await verificarPasswordWeb(password, estudiante.contrasena);
      if (!passOk) {
        return fallo(401, "Nombre o contraseña incorrectos.");
      }
      const token = nuevoToken("usuario", estudiante.estudiante_id);
      recordarSesion(token, "usuario");
      return ok({
        ok: true,
        token,
        rol: "usuario",
        estudiante: {
          estudiante_id: estudiante.estudiante_id,
          nombre: estudiante.nombre,
          curso: estudiante.curso,
          saldo: Number(estudiante.saldo || 0),
        },
      });
    }

    if (metodo === "POST" && ruta === "/api/logout") {
      recordarSesion("", "");
      return ok({ ok: true });
    }

    // ----- cuenta del alumno -----
    if (metodo === "GET" && ruta === "/api/mi-cuenta") {
      if (!sesion || sesion.rol !== "usuario") {
        return fallo(401, "Sesión de usuario requerida.");
      }
      const estudiante = await getEstudiantePorId(sesion.estudianteId);
      if (!estudiante) return fallo(401, "Estudiante no encontrado.");
      let historial = [];
      try {
        historial = await listarTransaccionesDeEstudiante(estudiante.estudiante_id, 200);
      } catch {
        historial = [];
      }
      return ok({
        ok: true,
        estudiante: {
          estudiante_id: estudiante.estudiante_id,
          nombre: estudiante.nombre,
          curso: estudiante.curso,
          saldo: Number(estudiante.saldo || 0),
        },
        historial,
      });
    }

    if (metodo === "GET" && ruta === "/api/mi-asistencia") {
      if (!sesion || sesion.rol !== "usuario") {
        return fallo(401, "Sesión de usuario requerida.");
      }
      return ok({ ok: true, asistencias: await historialDe(sesion.estudianteId, 200) });
    }

    // Solicitudes del alumno autenticado. El id sale de la sesión, nunca de un
    // parámetro que el alumno pueda cambiar por el de otro estudiante.
    if (metodo === "GET" && ruta === "/api/mis-solicitudes") {
      if (!sesion || sesion.rol !== "usuario") {
        return fallo(401, "Sesión de usuario requerida.");
      }
      const solicitudes = await listarSolicitudesDeEstudiante(sesion.estudianteId, 50);
      const propias = solicitudes.map((s) => sinArchivoSolicitud(s));
      return ok({ ok: true, solicitudes: propias });
    }

    // El pago del pedido se registra en el servidor local. En la nube solo se
    // consultan saldo, historial y solicitudes; no se mueve dinero desde el
    // navegador.
    if (metodo === "POST" && ruta === "/api/pagar") {
      if (!sesion || sesion.rol !== "usuario") {
        return fallo(401, "Sesión de usuario requerida.");
      }
      return fallo(
        403,
        "El pago del almuerzo se registra en el servidor local. En modo nube solo puedes consultar tu saldo y enviar comprobantes."
      );
    }

    // ----- comprobantes -----
    // Sin IA en la nube: el comprobante queda pendiente de revisión manual.
    if (metodo === "POST" && ruta === "/api/comprobante") {
      if (!sesion || sesion.rol !== "usuario") {
        return fallo(401, "Sesión de usuario requerida.");
      }
      const validacion = validarMonto((cuerpo || {}).monto);
      if (!validacion.ok) return fallo(400, "Indica un monto válido a recargar.");
      const monto = validacion.valor;

      const archivo = String((cuerpo || {}).archivo || "");
      if (!archivo.startsWith("data:image/")) {
        return fallo(400, "Adjunta el comprobante (imagen).");
      }
      if (archivo.length > LIMITE_IMAGEN) {
        return fallo(
          413,
          `La imagen es muy pesada. El máximo es ${Math.round(LIMITE_IMAGEN / 1000)} KB.`
        );
      }

      const estudiante = await getEstudiantePorId(sesion.estudianteId);
      if (!estudiante) return fallo(401, "Estudiante no encontrado.");

      const huellaCompleta = await hash(archivo);
      const huella = huellaCompleta.slice(0, 40);
      const ahora = new Date();
      const solicitud = {
        numero: `SOL${Date.now()}`,
        estudiante_id: estudiante.estudiante_id,
        nombre: estudiante.nombre,
        curso: estudiante.curso,
        monto,
        monto_declarado: monto,
        nota: String((cuerpo || {}).nota || "").slice(0, 500),
        archivo,
        huella,
        fecha: fechaLocal(ahora),
        hora: horaLocal(ahora),
        estado: "pendiente",
        origen_analisis: "sin-ia",
      };

      const config = await getConfig();
      solicitud.beneficiario_qr = config.beneficiario;

      let reutilizada = null;
      try {
        reutilizada = await buscarSolicitudPorHuella(huella, "aprobada");
      } catch {
        reutilizada = null;
      }

      const problemas = ["la revisión con IA solo corre en el servidor local"];
      if (reutilizada) {
        problemas.push("el mismo comprobante ya fue acreditado antes");
      }
      if (!config.beneficiario.nombre) {
        problemas.push("el comedor aún no tiene configurado el titular del QR");
      }

      await referencia(COLECCIONES.SOLICITUDES, solicitud.numero).set(
        // La secuencia va como número, igual que en las solicitudes anteriores.
        { ...solicitud, secuencia: Date.now() },
        { merge: true }
      );

      return ok({
        ok: true,
        aprobacion: "pendiente",
        monto,
        problemas,
        mensaje: `Comprobante recibido.${problemas.length ? ` El administrador lo revisará porque: ${problemas.join("; ")}.` : " Queda en revisión del administrador."}`,
        solicitud,
      });
    }

    // Descarga perezosa de la imagen del comprobante (pesa cientos de KB).
    if (metodo === "GET" && ruta.startsWith("/api/comprobantes/")) {
      const numero = decodeURIComponent(ruta.slice("/api/comprobantes/".length));
      if (!sesion) return fallo(401, "Inicia sesión para ver el comprobante.");
      const solicitud = await getDocumentoSolicitud(numero);
      if (!solicitud) return fallo(404, "Comprobante no encontrado.");
      const esDueno =
        sesion.rol === "usuario" &&
        String(solicitud.estudiante_id) === String(sesion.estudianteId);
      if (!esCaja && !esDueno) {
        return fallo(403, "No tienes permiso para ver ese comprobante.");
      }
      return ok({ ok: true, archivo: solicitud.archivo || null });
    }

    // ----- solicitudes de recarga -----
    if (metodo === "GET" && ruta === "/api/solicitudes") {
      if (!esCaja) return fallo(403, "Esta acción requiere el perfil de caja.");
      const solicitudes = await listarSolicitudes(MAX_SOLICITUDES);
      return ok(solicitudes.map(sinArchivoSolicitud));
    }

    if (metodo === "POST" && ruta === "/api/solicitudes") {
      if (!esCaja) return fallo(403, "Esta acción requiere el perfil de caja.");
      const numero = String((cuerpo || {}).numero || "");
      const solicitud = await getDocumentoSolicitud(numero);
      if (!solicitud) return fallo(404, "Solicitud no encontrada.");
      if (solicitud.estado !== "pendiente") {
        return fallo(409, "Esa solicitud ya fue revisada. No se acreditó dos veces.");
      }
      const montoAutorizado = Number((cuerpo || {}).monto_autorizado);
      const resultado = await aprobarSolicitudRecarga(
        solicitud,
        montoAutorizado,
        sesion.rol
      );
      if (!resultado.ok) return { ok: false, status: 400, datos: resultado };
      return ok(resultado);
    }

    if (metodo === "POST" && ruta === "/api/solicitudes/rechazar") {
      if (!esCaja) return fallo(403, "Esta acción requiere el perfil de caja.");
      const motivo = String((cuerpo || {}).motivo || "").trim();
      if (!motivo) return fallo(400, "Escribe el motivo del rechazo.");
      const solicitud = await getDocumentoSolicitud(String((cuerpo || {}).numero || ""));
      if (!solicitud) return fallo(404, "Solicitud no encontrada.");
      if (solicitud.estado !== "pendiente") {
        return fallo(409, "Esa solicitud ya fue revisada.");
      }
      const resultado = await rechazarSolicitudRecarga(solicitud, motivo, sesion.rol);
      if (!resultado.ok) return { ok: false, status: 409, datos: { ...resultado, ok: false } };
      return ok({
        ok: true,
        mensaje: resultado.mensaje,
        solicitud_aprobada: null,
      });
    }

    // ----- recargas -----
    if (metodo === "POST" && ruta === "/api/recargar") {
      if (!esCaja) return fallo(403, "Esta acción requiere el perfil de caja.");
      const validacion = validarMonto((cuerpo || {}).monto);
      if (!validacion.ok) {
        return { ok: false, status: 400, datos: { ok: false, evento: "MONTO_INVALIDO", mensaje: validacion.error } };
      }
      const resultado = await recargarSaldo(
        (cuerpo || {}).estudiante_id,
        validacion.valor,
        (cuerpo || {}).metodo || "manual",
        { revisor: sesion.rol }
      );
      if (!resultado.ok) return { ok: false, status: 400, datos: resultado };
      return ok(resultado);
    }

    if (metodo === "POST" && ruta === "/api/recargar/revertir") {
      if (!esCaja) return fallo(403, "Esta acción requiere el perfil de caja.");
      const resultado = await revertirRecarga(
        String((cuerpo || {}).numero || "").trim(),
        (cuerpo || {}).motivo || "corrección del administrador",
        sesion.rol
      );
      if (!resultado.ok) return { ok: false, status: 400, datos: resultado };
      return ok(resultado);
    }

    // ----- configuración -----
    if (metodo === "GET" && ruta === "/api/config") {
      return ok(await getConfig());
    }

    if (metodo === "POST" && ruta === "/api/config") {
      if (!esAdmin) return fallo(403, "Sesión de administrador requerida.");
      try {
        const config = await setConfig(cuerpo || {});
        return ok({ ok: true, ...config });
      } catch (error) {
        return fallo(400, error.message);
      }
    }

    // ----- cosas que solo funcionan en el servidor local -----
    if (metodo === "POST" && ruta === "/api/config/qr") {
      if (!esAdmin) return fallo(403, "Sesión de administrador requerida.");
      return {
        ok: false,
        status: 200,
        datos: {
          ok: false,
          error:
            "La lectura del QR con IA solo funciona en el servidor local. Escribe el titular a mano.",
        },
      };
    }

    if (metodo === "POST" && ruta === "/api/uid") {
      return {
        ok: false,
        status: 400,
        datos: {
          ok: false,
          error: "El lector RFID USB solo funciona con el servidor local.",
        },
      };
    }

    return { ok: false, status: 404, datos: { error: "Ruta no encontrada." } };
  }

  /* ------------------------------------------ registro y salida manual (nube) */

  async function registrarManual({ estudiante_id, accion, fecha }) {
    const dia = esFechaValida(fecha) ? fecha : fechaLocal();
    const estudiante = await getEstudiantePorId(String(estudiante_id || ""));
    if (!estudiante) {
      return { ok: false, mensaje: "El estudiante no existe." };
    }

    const documentoId = `${estudiante.estudiante_id}_${dia}`;
    const existente = await getAsistencia(estudiante.estudiante_id, dia);
    const hora = horaLocal();

    if (accion === "salida" && !existente) {
      return { ok: false, mensaje: "No hay entrada registrada para ese día." };
    }
    if (accion === "salida" && existente.hora_salida) {
      return {
        ok: false,
        mensaje: `La salida ya estaba registrada a las ${existente.hora_salida}.`,
      };
    }
    if (accion === "entrada" && existente && existente.hora_entrada) {
      return {
        ok: false,
        mensaje: `La entrada ya estaba registrada a las ${existente.hora_entrada}.`,
      };
    }

    const campos =
      accion === "salida"
        ? { hora_salida: hora, estado: "COMPLETA" }
        : {
            fecha: dia,
            estudiante_id: estudiante.estudiante_id,
            nombre: estudiante.nombre,
            curso: estudiante.curso,
            hora_entrada: hora,
            estado: "ENTRADA",
            origen: "manual",
          };

    await guardarAsistencia(documentoId, campos);
    const asistencia = await getAsistencia(estudiante.estudiante_id, dia);

    return {
      ok: true,
      asistencia,
      mensaje:
        accion === "salida"
          ? `Salida de ${estudiante.nombre} registrada a las ${hora}.`
          : `Entrada de ${estudiante.nombre} registrada a las ${hora}.`,
    };
  }

  async function eliminarRegistro(estudianteId, fecha) {
    if (!esFechaValida(fecha)) {
      return { ok: false, mensaje: "La fecha no es válida." };
    }
    const documentoId = `${estudianteId}_${fecha}`;
    const existente = await getAsistencia(estudianteId, fecha);
    if (!existente) {
      return { ok: false, mensaje: "No hay ningún registro para ese estudiante y fecha." };
    }
    await eliminarAsistencia(documentoId);
    return { ok: true, mensaje: `Registro de ${existente.nombre || estudianteId} eliminado.` };
  }

  async function solicitarHuella(estudianteId) {
    const estudiante = await getEstudiantePorId(String(estudianteId || ""));
    if (!estudiante) return { ok: false, mensaje: "El estudiante no existe." };

    const huellas = await listarHuellas();
    if (huellas.some((h) => h.estudiante_id === estudiante.estudiante_id)) {
      return { ok: false, mensaje: `${estudiante.nombre} ya tiene una huella registrada.` };
    }

    const slot = await ranuraLibre();
    if (slot === null) {
      return { ok: false, mensaje: "No quedan ranuras libres en el sensor." };
    }

    const momento = new Date().toISOString();
    const solicitud = {
      accion: "registrar",
      estado: "pendiente",
      slot,
      estudiante_id: estudiante.estudiante_id,
      nombre: estudiante.nombre,
      curso: estudiante.curso,
      mensaje: "",
      solicitado: momento,
      actualizado: momento,
    };
    await guardarSolicitudHuella(solicitud);
    return {
      ok: true,
      mensaje: `Pon el dedo en el sensor del comedor para guardar la huella de ${estudiante.nombre}.`,
      solicitud,
    };
  }

  async function quitarHuella(estudianteId) {
    const huellas = await listarHuellas();
    const actual = huellas.find((h) => h.estudiante_id === String(estudianteId || ""));
    if (!actual) return { ok: false, mensaje: "Ese estudiante no tiene huella registrada." };

    await eliminarHuella(actual.slot);
    await guardarSolicitudHuella({
      accion: "borrar",
      estado: "pendiente",
      slot: Number(actual.slot),
      estudiante_id: actual.estudiante_id,
      nombre: actual.nombre,
      curso: actual.curso,
      mensaje: "",
      solicitado: new Date().toISOString(),
      actualizado: new Date().toISOString(),
    });
    return { ok: true, mensaje: `Huella de ${actual.nombre} eliminada.` };
  }

  /* ------------------------------------------------------------- modo y API */

  let modoResuelto = null;
  let sdkNubePromesa = null;

  // En local no hace falta descargar el SDK de Firebase: todo pasa por la API
  // del servidor Node. Se carga solo cuando la página corre en Firebase
  // Hosting, para que el sistema siga abriendo aunque no haya Internet.
  function cargarScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = src;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`No se pudo cargar ${src}`));
      document.head.appendChild(script);
    });
  }

  function cargarSdkNube() {
    if (window.firebase && window.firebase.firestore) return Promise.resolve();
    if (!sdkNubePromesa) {
      const base = "https://www.gstatic.com/firebasejs/10.12.2";
      sdkNubePromesa = cargarScript(`${base}/firebase-app-compat.js`)
        .then(() => cargarScript(`${base}/firebase-firestore-compat.js`))
        .then(() => {
          if (!window.firebase || !window.firebase.firestore) {
            throw new Error("El SDK de Firestore no quedó disponible.");
          }
        });
    }
    return sdkNubePromesa;
  }

  async function modoDe() {
    if (modoResuelto) return modoResuelto;
    const forzado = new URLSearchParams(window.location.search).get("modo");
    if (forzado === "servidor" || forzado === "nube") {
      if (forzado === "nube") await cargarSdkNube();
      modoResuelto = forzado;
      return modoResuelto;
    }
    try {
      const res = await fetch("/api/status", { cache: "no-store" });
      const tipo = res.headers.get("content-type") || "";
      if (res.ok && tipo.includes("application/json")) {
        modoResuelto = "servidor";
        return modoResuelto;
      }
    } catch {
      /* sin servidor: se sigue con Firestore */
    }
    await cargarSdkNube();
    modoResuelto = "nube";
    return modoResuelto;
  }

  async function esNube() {
    return (await modoDe()) === "nube";
  }

  async function peticionServidor(ruta, opciones) {
    const finales = { ...(opciones || {}) };
    finales.headers = {
      ...(opciones && opciones.headers ? opciones.headers : {}),
      "Content-Type": "application/json",
    };
    const token = sessionStorage.getItem("comedor_token") || "";
    if (token) finales.headers.Authorization = `Bearer ${token}`;
    const res = await fetch(ruta, finales);
    const datos = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, datos };
  }

  async function peticionNube(ruta, opciones) {
    const metodo = String((opciones && opciones.method) || "GET").toUpperCase();
    const url = new URL(ruta, window.location.origin);
    const parametros = url.searchParams;
    let cuerpo = {};
    if (opciones && opciones.body) {
      try {
        cuerpo = JSON.parse(opciones.body);
      } catch {
        cuerpo = {};
      }
    }
    const token = tokenDeNube();
    try {
      return await manejarNube(metodo, url.pathname, parametros, cuerpo, token);
    } catch (error) {
      return {
        ok: false,
        status: 500,
        datos: { ok: false, error: `Error en Firestore: ${error.message}` },
      };
    }
  }

  async function peticion(ruta, opciones) {
    if ((await modoDe()) === "servidor") return peticionServidor(ruta, opciones);
    return peticionNube(ruta, opciones);
  }

  /* --------------------------------------------------------- notificaciones */

  // El aviso de "hay una recarga nueva" se hace sondeoando la colección con
  // proyección: así solo baja el estado de cada solicitud, no las fotos.
  let temporizador = null;
  let vistos = new Set();
  let primeraVez = true;

  const CAMPOS_AVISO = ["numero", "nombre", "monto", "estado", "secuencia", "motivo"];

  function suscribirSolicitudes(callback) {
    if (temporizador) return;

    const revisar = async () => {
      let docs = [];
      try {
        docs = await restConsultar(COLECCIONES.SOLICITUDES, {
          campos: CAMPOS_AVISO,
          orderBy: { campo: "secuencia", dir: "desc" },
          limit: 20,
        });
      } catch {
        return;
      }
      const actuales = new Set(docs.map((d) => `${d.id}:${d.estado}`));
      if (primeraVez) {
        primeraVez = false;
        vistos = actuales;
        return;
      }
      for (const doc of docs) {
        const clave = `${doc.id}:${doc.estado}`;
        if (!vistos.has(clave)) callback(doc);
      }
      vistos = actuales;
    };

    revisar();
    temporizador = setInterval(revisar, 12000);
  }

  function cerrarSuscripcion() {
    if (temporizador) {
      clearInterval(temporizador);
      temporizador = null;
      vistos = new Set();
      primeraVez = true;
    }
    if (temporizadorPedidos) {
      clearInterval(temporizadorPedidos);
      temporizadorPedidos = null;
      pedidosVistos = new Map();
      primeraVezPedidos = true;
    }
  }

  /* --------------------------------------------------- aviso de pedidos */

  // En la nube no hay SSE del servidor: los pedidos nuevos (y los pagados) se
  // detectan sondeando la colección del día.
  let temporizadorPedidos = null;
  let pedidosVistos = new Map();
  let primeraVezPedidos = true;

  const CAMPOS_PEDIDO = [
    "nombre",
    "curso",
    "estado",
    "hora_pedido",
    "hora_pago",
    "monto",
    "precio",
    "fecha",
  ];

  function suscribirPedidos(callback) {
    if (temporizadorPedidos) return;

    const revisar = async () => {
      let docs = [];
      try {
        docs = await restConsultar(COLECCIONES.PEDIDOS, {
          campos: CAMPOS_PEDIDO,
          where: { campo: "fecha", valor: fechaLocal() },
          limit: 50,
        });
      } catch {
        return;
      }

      if (primeraVezPedidos) {
        primeraVezPedidos = false;
        pedidosVistos = new Map(docs.map((d) => [d.id, d.estado]));
        return;
      }

      for (const doc of docs) {
        const antes = pedidosVistos.get(doc.id);
        if (antes === doc.estado) continue;
        pedidosVistos.set(doc.id, doc.estado);
        if (antes === undefined) {
          callback({
            nombre: doc.nombre,
            estado: "NUEVO",
            monto: Number(doc.monto || doc.precio || 0),
            mensaje: `Nuevo pedido de almuerzo: ${doc.nombre}.`,
          });
        } else if (doc.estado === "PAGADO") {
          callback({
            nombre: doc.nombre,
            estado: "PAGADO",
            mensaje: `${doc.nombre}: almuerzo pagado. Pendiente de entrega.`,
          });
        } else if (doc.estado === "RECOGIDO") {
          callback({
            nombre: doc.nombre,
            estado: "RECOGIDO",
            mensaje: `${doc.nombre}: almuerzo entregado.`,
          });
        }
      }
    };

    revisar();
    temporizadorPedidos = setInterval(revisar, 10000);
  }

  /* ----------------------------------------------------------------- salida */

  window.ApiWeb = {
    modo: modoDe,
    esNube,
    peticion,
    recordarSesion,
    suscribirSolicitudes,
    suscribirPedidos,
    cerrarSuscripcion,
    proyecto: PROYECTO,
  };
})();
