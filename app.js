"use strict";

const $ = (id) => document.getElementById(id);

const MAX_LADO_IMAGEN = 1400;
const MAX_BYTES_COMPROBANTE = 550_000;

let estudiantes = [];
let transacciones = [];
let solicitudes = [];
let misSolicitudes = [];
let precioAlmuerzo = 0;
let titularQr = { nombre: "", cedula: "", telefono: "", banco: "" };
let ventanaHoras = 48;

let huellas = [];
let solicitudHuella = null;
let fechaAsistencia = "";
let sondeoHuella = null;

let pedidos = [];
let fechaPedidos = "";
let periodoAsistencia = "dia";
let miAsistenciaCache = [];

// La sesión se carga en inicializar(): en el servidor local vive en
// sessionStorage (una pestaña = una sesión) y en la nube solo en memoria.
let token = "";
let rol = "";
let modoNubeActual = false;
let fuenteSSE = null;
let suscripcionFirestore = false;
let modalResolver = null;
let modalPideCampo = false;
let cuentaCargada = false;
let estudianteActual = null;

// Enlaza un evento solo si el elemento existe: así la interfaz puede
// cambiar (por ejemplo, quitar la barra lateral) sin romper el resto.
function on(id, evento, manejador) {
  const elemento = $(id);
  if (elemento) elemento.addEventListener(evento, manejador);
}

/* ---------- Pestañas: /alumno y /admin son pestañas independientes ---------- */

const RUTAS = { inicio: "/", alumno: "/alumno", admin: "/admin" };
const ROLES_ADMIN = ["admin", "caja", "cocinera"];

const ROLES_INFO = {
  admin: {
    nombre: "Administración",
    detalle: "Control total del sistema, estudiantes, huellas y configuración.",
    icono: "fa-solid fa-user-gear",
    inicio: "admin-inicio",
  },
  caja: {
    nombre: "Caja",
    detalle: "Comprobantes, recargas, saldos y movimientos del comedor.",
    icono: "fa-solid fa-cash-register",
    inicio: "admin-inicio",
  },
  cocinera: {
    nombre: "Cocina",
    detalle: "Pedidos del día y entregas realizadas en el comedor.",
    icono: "fa-solid fa-kitchen-set",
    inicio: "admin-inicio",
  },
  usuario: {
    nombre: "Estudiante",
    detalle: "Saldo, comedor y asistencia.",
    icono: "fa-solid fa-user-graduate",
    inicio: "est-inicio",
  },
};

function esRolAdmin(valor = rol) {
  return ROLES_ADMIN.includes(valor);
}

function rutaActual() {
  const ruta = window.location.pathname.replace(/\/+$/, "");
  if (ruta === "/admin") return "admin";
  if (ruta === "/alumno") return "alumno";
  return "inicio";
}

// Si la pestaña se abrió con la sesión en la dirección (#t=token&r=rol), se
// guarda aquí y se borra de la barra para que el token no quede a la vista.
function adoptarTokenDeUrl() {
  const hash = window.location.hash.replace(/^#/, "");
  if (!hash) return false;
  const params = new URLSearchParams(hash);
  const recibido = params.get("t") || "";
  const rolRecibido = params.get("r") || "";
  history.replaceState(null, "", RUTAS[rutaActual()]);
  if (!recibido) return false;
  let rolFinal = rolRecibido;
  if (!rolFinal) rolFinal = rutaActual() === "admin" ? "admin" : "usuario";
  if (!["admin", "caja", "cocinera", "usuario"].includes(rolFinal)) rolFinal = "usuario";
  // En la nube no existe una autorización real de administración todavía. Un
  // token con rol administrativo en la URL no debe abrir el panel.
  if (modoNubeActual && ROLES_ADMIN.includes(rolFinal)) {
    mostrarUltimo(null);
    return false;
  }
  guardarSesion(recibido, rolFinal);
  return true;
}

// Qué vista se muestra: la URL manda. Si pides /admin sin sesión de
// administración, se muestra el login.
function vistaDeRuta() {
  const ruta = rutaActual();
  if (ruta === "admin") return esRolAdmin() ? "admin" : "login";
  if (ruta === "alumno") return rol === "usuario" ? "usuario" : "login";
  if (esRolAdmin()) return "admin";
  if (rol === "usuario") return "usuario";
  return "login";
}

function sincronizarUrl(vista) {
  const destino = vista === "admin" ? RUTAS.admin : vista === "usuario" ? RUTAS.alumno : RUTAS.inicio;
  const actual = rutaActual();
  if (vista === "login" && actual !== "inicio") return; // conserva /admin o /alumno
  if (window.location.pathname !== destino) {
    history.replaceState(null, "", destino);
  }
}

// Muestra sólo los enlaces de la barra lateral que corresponden al rol.
function aplicarRolesSidebar() {
  const rolesActivos = rol ? [rol] : [];
  document.body.dataset.rol = rol || "visitante";
  document.querySelectorAll("[data-roles]").forEach((elemento) => {
    const permitidos = String(elemento.dataset.roles || "").split(/\s+/).filter(Boolean);
    const visible = rolesActivos.some((r) => permitidos.includes(r));
    elemento.classList.toggle("oculto", !visible);
  });
}

const TITULOS_MODULO = {
  "est-inicio": "Inicio",
  "est-comedor": "Saldo y comedor",
  "est-recarga": "Recargar saldo",
  "est-solicitudes": "Mis solicitudes",
  "est-asistencia": "Mi asistencia",
  "admin-inicio": "Resumen",
  "admin-comprobantes": "Comprobantes",
  "admin-saldos": "Saldos y movimientos",
  "admin-estudiantes": "Estudiantes",
  "admin-pedidos": "Pedidos del día",
  "admin-entregas": "Entregas",
  "admin-asistencia": "Asistencia general",
  "admin-huellas": "Huella dactilar",
  "admin-config": "Configuración",
};

let moduloActual = "";

function mostrarModulo(nombre, opciones = {}) {
  const modulo = nombre || (rol === "usuario" ? "est-inicio" : "admin-inicio");
  const contenedor = rol === "usuario" ? $("vistaUsuario") : $("vistaAdmin");
  if (!contenedor) return;
  const modulos = contenedor.querySelectorAll(".modulo[data-modulo]");
  if (!modulos.length) return;
  moduloActual = modulo;

  modulos.forEach((seccion) => {
    seccion.classList.toggle("oculto", seccion.dataset.modulo !== modulo);
  });

  document.querySelectorAll(".sidebar-nav-link[data-modulo]").forEach((enlace) => {
    enlace.classList.toggle("active", enlace.dataset.modulo === modulo);
  });

  const titulo = TITULOS_MODULO[modulo] || "Inicio";
  if ($("pestanaActual")) $("pestanaActual").textContent = titulo;

  // Cargas específicas del módulo abierto.
  if (modulo === "admin-comprobantes") cargarSolicitudes().catch(() => {});
  if (modulo === "admin-saldos") cargarDatos().catch(() => {});
  if (modulo === "admin-estudiantes") cargarDatos().catch(() => {});
  if (modulo === "admin-pedidos" || modulo === "admin-entregas") cargarPedidos().catch(() => {});
  if (modulo === "admin-asistencia") cargarAsistencias().catch(() => {});
  if (modulo === "admin-huellas") cargarHuellas().catch(() => {});
  if (modulo === "est-comedor") cargarMiCuenta().catch(() => {});
  if (modulo === "est-solicitudes") cargarMisSolicitudes().catch(() => {});
  if (modulo === "est-asistencia") cargarMiAsistencia().catch(() => {});

  if (!opciones.silencioso) scrollArriba();
  cerrarSidebarMovil();
}

function marcarPestanas() {
  aplicarRolesSidebar();
  if ($("pestanaActual")) $("pestanaActual").textContent = TITULOS_MODULO[moduloActual] || "Inicio";
}

/* ---------- Navegación (barra lateral y pestañas) ---------- */

function scrollArriba() {
  if (typeof window.scrollTo === "function") {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
}

function cerrarSidebarMovil() {
  const sidebar = $("sidebar");
  const backdrop = $("sidebarBackdrop");
  if (sidebar) sidebar.classList.remove("abierto");
  if (backdrop) backdrop.classList.remove("visible");
}

function abrirSidebarMovil() {
  const sidebar = $("sidebar");
  const backdrop = $("sidebarBackdrop");
  if (sidebar) sidebar.classList.add("abierto");
  if (backdrop) backdrop.classList.add("visible");
}

function irAInicio() {
  if (rol === "usuario") {
    mostrarModulo("est-inicio");
    return;
  }
  if (esRolAdmin()) {
    mostrarModulo("admin-inicio");
    return;
  }
  if (rutaActual() !== "inicio") history.replaceState(null, "", RUTAS.inicio);
  renderVistas();
}

function irAAlumno() {
  if (rol === "usuario") {
    mostrarModulo("est-comedor");
    return;
  }
  abrirPestana(RUTAS.alumno);
}

function irAAdmin() {
  if (esRolAdmin()) {
    mostrarModulo("admin-inicio");
    return;
  }
  if (rutaActual() !== "admin") history.replaceState(null, "", RUTAS.admin);
  renderVistas();
}

// La barra lateral y la cabecera muestran quién está conectado.
function actualizarSidebar() {
  const nombre = $("sidebarNombreUsuario");
  const rolTexto = $("sidebarRolUsuario");
  const icono = $("sidebarIconoUsuario");
  const cerrar = $("sidebarCerrarSesion");
  if (!nombre) return;

  if (esRolAdmin()) {
    const info = ROLES_INFO[rol] || ROLES_INFO.admin;
    nombre.textContent = info.nombre;
    if (rolTexto) rolTexto.textContent = `Sesión de ${info.nombre.toLowerCase()}`;
    if (icono) icono.className = info.icono;

    if ($("adminRolEyebrow")) $("adminRolEyebrow").textContent = `Área de ${info.nombre.toLowerCase()}`;
    if ($("adminRolTitulo")) $("adminRolTitulo").textContent = `Panel de ${info.nombre.toLowerCase()}`;
    if ($("adminRolDetalle")) $("adminRolDetalle").textContent = info.detalle;
    if ($("adminRolChip")) {
      $("adminRolChip").textContent = `${info.nombre} activo`;
      $("adminRolChip").className = "chip chip-ok";
    }
    if ($("kpisCaja")) $("kpisCaja").classList.toggle("oculto", rol === "cocinera");
    if ($("kpisCocina")) $("kpisCocina").classList.toggle("oculto", rol !== "cocinera");
  } else if (rol === "usuario") {
    nombre.textContent = estudianteActual ? estudianteActual.nombre : "Estudiante";
    if (rolTexto) {
      rolTexto.textContent = estudianteActual
        ? [estudianteActual.curso, estudianteActual.estudiante_id].filter(Boolean).join(" · ")
        : "Sesión de estudiante";
    }
    if (icono) icono.className = "fa-solid fa-user-graduate";
  } else {
    nombre.textContent = "Invitado";
    if (rolTexto) rolTexto.textContent = "Sin sesión";
    if (icono) icono.className = "fa-solid fa-user";
  }
  if (cerrar) cerrar.classList.toggle("oculto", !rol);
  aplicarRolesSidebar();
}

function abrirPestana(ruta, tokenSesion, rolSesion) {
  let hash = "";
  if (tokenSesion) {
    const params = new URLSearchParams({ t: tokenSesion });
    if (rolSesion) params.set("r", rolSesion);
    hash = `#${params.toString()}`;
  }
  const ventana = window.open(`${ruta}${hash}`, "_blank", "noopener");
  if (!ventana) {
    mostrarToast(
      "No se pudo abrir la pestaña",
      "Permite las ventanas emergentes para este sitio.",
      "err"
    );
  }
  return ventana;
}

// Atajos usados por las tarjetas y los botones "Ver todos".
function irAModulo(nombre) {
  const contenedor = rol === "usuario" ? $("vistaUsuario") : $("vistaAdmin");
  const existe = contenedor && contenedor.querySelector(`.modulo[data-modulo="${nombre}"]`);
  if (existe) mostrarModulo(nombre);
}

/* ---------- Formato ---------- */

function formatearBs(valor) {
  const numero = Number(valor || 0);
  return new Intl.NumberFormat("es-VE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(numero);
}

function dinero(valor) {
  return `Bs ${formatearBs(valor)}`;
}

function esc(texto) {
  if (texto === null || texto === undefined) return "-";
  return String(texto).replace(/[<>&"']/g, (c) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function kb(bytes) {
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// La capa de datos decide si la web habla con el servidor local o directo con
// Firestore (ver public/firebase-web.js). Las dos opciones devuelven la misma
// forma de respuesta, así que aquí no hay que saber en qué modo se está.
function crearControladorApi() {
  return typeof AbortController === "function" ? new AbortController() : null;
}

let controladorApi = crearControladorApi();

async function api(ruta, opciones) {
  const finales = { ...(opciones || {}) };
  if (controladorApi) finales.signal = controladorApi.signal;
  const res = await window.ApiWeb.peticion(ruta, finales);
  const datos = res.datos || {};
  if (res.status === 401 && rol) {
    cerrarSesionLocal();
    renderVistas();
  }
  if (!res.ok && !datos.ok) {
    throw new Error(datos.error || datos.mensaje || `Error ${res.status}`);
  }
  return datos;
}

function bloquear(boton, activo, texto = "Procesando…") {
  if (!boton) return;
  if (activo) {
    boton.dataset.texto = boton.textContent;
    boton.disabled = true;
    boton.classList.add("cargando");
    boton.textContent = texto;
    return;
  }
  boton.disabled = false;
  boton.classList.remove("cargando");
  if (boton.dataset.texto) boton.textContent = boton.dataset.texto;
}

/* ---------- Modal de confirmación ---------- */

function pedirConfirmacion(opciones = {}) {
  modalPideCampo = Boolean(opciones.campo);
  $("modalTitulo").textContent = opciones.titulo || "Confirmar";
  $("modalTexto").textContent = opciones.texto || "";
  $("modalTexto").classList.toggle("oculto", !opciones.texto);
  $("modalDetalle").innerHTML = opciones.detalle || "";
  $("modalDetalle").classList.toggle("oculto", !opciones.detalle);
  $("modalCampoWrap").classList.toggle("oculto", !modalPideCampo);
  $("modalCampo").value = opciones.valor !== undefined ? String(opciones.valor) : "";
  $("modalCampo").classList.remove("invalido");
  if (opciones.campo) {
    $("modalCampo").placeholder = opciones.placeholder || "";
    $("modalCampo").type = opciones.tipo || "text";
    $("modalCampo").inputMode = opciones.inputMode || "text";
  } else {
    $("modalCampo").type = "text";
    $("modalCampo").inputMode = "text";
  }

  const aceptar = $("modalAceptar");
  aceptar.textContent = opciones.aceptar || "Confirmar";
  aceptar.className = `btn ${opciones.peligro ? "btn-peligro" : "btn-primario"}`;

  $("modalOverlay").classList.remove("oculto");
  if (modalPideCampo) $("modalCampo").focus();
  else aceptar.focus();

  return new Promise((resolve) => {
    modalResolver = resolve;
  });
}

function cerrarModal(valor) {
  $("modalOverlay").classList.add("oculto");
  const resolver = modalResolver;
  modalResolver = null;
  modalPideCampo = false;
  if (resolver) resolver(valor);
}

function aceptarModal() {
  if (modalPideCampo) {
    const valor = $("modalCampo").value.trim();
    if (!valor) {
      $("modalCampo").classList.add("invalido");
      $("modalCampo").focus();
      return;
    }
    cerrarModal(valor);
    return;
  }
  cerrarModal(true);
}

function filaModal(etiqueta, valor, clase = "") {
  return `<div class="modal-detalle-fila"><span>${esc(etiqueta)}</span><strong class="${clase}">${esc(valor)}</strong></div>`;
}

/* ---------- Visor de comprobantes ---------- */

function abrirComprobante(fuente) {
  if (!fuente) return;
  $("lightboxImg").src = fuente;
  $("lightbox").classList.remove("oculto");
}

function cerrarComprobante() {
  $("lightbox").classList.add("oculto");
  $("lightboxImg").src = "";
}

/* ---------- Última tarjeta ---------- */

const TITULOS = {
  PAGO_APROBADO: "Pago aprobado",
  TARJETA_IDENTIFICADA: "Tarjeta identificada",
  SALDO_INSUFICIENTE: "Saldo insuficiente",
  SALDO_RECARGADO: "Saldo recargado",
  RECARGA_REVERTIDA: "Recarga revertida",
  TARJETA_ASIGNADA: "Tarjeta asignada",
  TARJETA_NO_ASOCIADA: "Tarjeta no registrada",
  ERROR: "Error del sistema",
};

function mostrarUltimo(evento) {
  const contenedor = $("ultimo");
  const titulo = $("ultimoTitulo");
  const detalle = $("ultimoDetalle");

  if (!evento) {
    contenedor.className = "ultimo idle";
    titulo.textContent = "Esperando tarjeta…";
    detalle.textContent = "Acerca el carnet al lector RFID";
    $("ultimo").querySelector(".ultimo-icono").textContent = "—";
    return;
  }

  const nombre = evento.estudiante ? `${evento.estudiante.nombre} (${evento.estudiante.curso})` : "";
  const mensaje = evento.mensaje || "";
  let clase = "info";

  if (evento.evento === "PAGO_APROBADO") clase = "ok";
  else if (evento.evento === "SALDO_INSUFICIENTE" || evento.evento === "ERROR") clase = "err";

  contenedor.className = `ultimo ${clase}`;
  titulo.textContent = TITULOS[evento.evento] || evento.evento;
  detalle.textContent = `${nombre ? nombre + " — " : ""}${mensaje} (${evento.hora || ""})`;
  contenedor.querySelector(".ultimo-icono").textContent =
    evento.evento === "PAGO_APROBADO" ? "✓"
      : evento.evento === "SALDO_INSUFICIENTE" ? "!"
        : evento.evento === "RECARGA_REVERTIDA" ? "↺" : "i";
}

/* ---------- Vistas ---------- */

// La URL manda sobre la sesión: /admin sin sesión de administrador muestra el
// login, y /alumno sin sesión de alumno también.
const VISTAS = { vistaLogin: "login", vistaUsuario: "usuario", vistaAdmin: "admin" };

function mostrarVista(idVista) {
  const vista = VISTAS[idVista] || "login";
  for (const id of Object.keys(VISTAS)) {
    $(id).classList.toggle("oculto", id !== idVista);
  }
  sincronizarUrl(vista);
  marcarPestanas();
  if (vista === "login" && rutaActual() === "admin") {
    mostrarAccesoAdmin();
  }
}

function renderVistas() {
  const vista = vistaDeRuta();
  // La URL puede seguir en /admin o /alumno después de cerrar sesión; sin un
  // rol válido se muestra el login y no se consultan endpoints protegidos.
  if (vista === "usuario" && rol === "usuario") {
    mostrarVista("vistaUsuario");
    mostrarModulo("est-inicio", { silencioso: true });
    cargarMiCuenta().catch(() => {});
    cargarMiAsistencia().catch(() => {});
    cargarMisSolicitudes().catch(() => {});
    cerrarNotificaciones();
  } else if (vista === "admin" && esRolAdmin()) {
    mostrarVista("vistaAdmin");
    const inicio = (ROLES_INFO[rol] && ROLES_INFO[rol].inicio) || "admin-inicio";
    mostrarModulo(inicio, { silencioso: true });
    conectarNotificaciones();
    if (rol !== "cocinera") cargarDatos().catch(() => {});
    if (rol !== "cocinera") cargarSolicitudes().catch(() => {});
    if (rol === "admin") cargarHuellas().catch(() => {});
    if (rol !== "caja") cargarAsistencias().catch(() => {});
    cargarPedidos().catch(() => {});
    renderResumenOperativo();
  } else {
    mostrarVista("vistaLogin");
    cerrarNotificaciones();
  }
  actualizarSidebar();
}

/* ---------- Notificaciones (toast) ---------- */

function mostrarToast(titulo, detalle, tipo = "info") {
  const tarjeta = document.createElement("div");
  tarjeta.className = `toast toast-${tipo}`;
  tarjeta.innerHTML = `
    <strong>${esc(titulo)}</strong>
    <span>${esc(detalle)}</span>`;
  const salir = () => {
    tarjeta.classList.add("toast-sale");
    setTimeout(() => tarjeta.remove(), 400);
  };
  tarjeta.addEventListener("click", salir);
  $("toastContainer").appendChild(tarjeta);
  setTimeout(salir, 6000);
}

function conectarNotificaciones() {
  if (fuenteSSE || suscripcionFirestore || !esRolAdmin()) return;

  // En la nube no hay servidor Node, así que en vez de SSE se escucha la
  // colección de solicitudes de Firestore en vivo.
  window.ApiWeb.esNube()
    .then((nube) => {
      if (nube) {
        if (suscripcionFirestore) return;
        suscripcionFirestore = true;
        if (rol !== "cocinera") {
          window.ApiWeb.suscribirSolicitudes((datos) => {
            avisarSolicitud(datos);
            cargarSolicitudes().catch(() => {});
          });
        }
        window.ApiWeb.suscribirPedidos((datos) => {
          avisarPedido(datos);
          cargarPedidos().catch(() => {});
        });
        return;
      }
      if (fuenteSSE || !esRolAdmin()) return;
      fuenteSSE = new EventSource(
        `/api/notificaciones?token=${encodeURIComponent(token)}`
      );
      fuenteSSE.addEventListener("solicitud", (e) => {
        if (rol === "cocinera") return;
        let datos;
        try {
          datos = JSON.parse(e.data);
        } catch {
          return;
        }
        avisarSolicitud(datos);
        cargarSolicitudes().catch(() => {});
      });
      fuenteSSE.addEventListener("pedido", (e) => {
        let datos;
        try {
          datos = JSON.parse(e.data);
        } catch {
          return;
        }
        avisarPedido(datos);
        cargarPedidos().catch(() => {});
      });
      fuenteSSE.onerror = () => {};
    })
    .catch(() => {});
}

function avisarSolicitud(datos) {
  if (!datos) return;
  if (datos.estado === "aprobada") {
    mostrarToast(
      "Recarga aprobada",
      `${datos.nombre}: ${dinero(datos.monto)} · ${datos.id}`,
      "ok"
    );
  } else {
    mostrarToast(
      "Nueva solicitud de recarga",
      `${datos.nombre}: ${dinero(datos.monto)} · ${datos.motivo || "en revisión"}`,
      "info"
    );
  }
}

function cerrarNotificaciones() {
  if (fuenteSSE) {
    fuenteSSE.close();
    fuenteSSE = null;
  }
  if (suscripcionFirestore) {
    window.ApiWeb.cerrarSuscripcion();
    suscripcionFirestore = false;
  }
}

/* ---------- Transacciones (admin) ---------- */

function filtrarTransacciones() {
  const tipo = $("filtroTipo").value;
  const desde = $("filtroDesde").value;
  const hasta = $("filtroHasta").value;
  const texto = $("filtroTexto").value.trim().toLowerCase();

  return transacciones
    .filter((t) => tipo === "todos" || t.tipo === tipo)
    .filter((t) => !desde || t.fecha >= desde)
    .filter((t) => !hasta || t.fecha <= hasta)
    .filter(
      (t) =>
        !texto ||
        String(t.nombre || "").toLowerCase().includes(texto) ||
        String(t.curso || "").toLowerCase().includes(texto)
    )
    .sort((a, b) => String(b.numero).localeCompare(String(a.numero)));
}

function renderTransacciones() {
  const lista = filtrarTransacciones();
  const cuerpo = $("tablaTransacciones");
  $("vacioTransacciones").style.display = lista.length ? "none" : "block";

  cuerpo.innerHTML = lista
    .map((t) => {
      const monto = t.tipo === "RECARGA" ? t.monto : t.precio;
      const tipoClase = t.tipo === "RECARGA" ? "badge-recarga" : t.tipo === "ANULACION" ? "badge-anulacion" : "badge-compra";
      const anulada = t.estado === "anulado";
      const accion =
        t.tipo === "RECARGA" && !anulada
          ? `<button class="btn-enlace btn-peligro" data-revertir="${esc(t.numero)}">Revertir</button>`
          : anulada
            ? `<span class="pista">revertida</span>`
            : "";
      return `
        <tr class="${anulada ? "fila-anulada" : ""}">
          <td>${esc(t.numero)}</td>
          <td>${esc(t.nombre)}</td>
          <td>${esc(t.curso)}</td>
          <td><span class="badge ${tipoClase}">${esc(t.tipo)}</span></td>
          <td class="num">${formatearBs(monto)}</td>
          <td class="num">${formatearBs(t.saldo_anterior)}</td>
          <td class="num">${formatearBs(t.saldo_posterior)}</td>
          <td>${esc(t.fecha)}</td>
          <td>${esc(t.hora)}</td>
          <td>${esc(t.metodo || t.origen || "")}</td>
          <td>${accion}</td>
        </tr>`;
    })
    .join("");
  renderResumenOperativo();
}

async function revertirTransaccion(numero) {
  const transaccion = transacciones.find((t) => t.numero === numero);
  const nombre = transaccion ? transaccion.nombre : "";
  const monto = transaccion ? Number(transaccion.monto || 0) : 0;

  const confirmacion = await pedirConfirmacion({
    titulo: "¿Revertir esta recarga?",
    texto: `Se descontarán ${dinero(monto)} del saldo de ${nombre}. La operación queda anotada en el historial.`,
    detalle: transaccion
      ? filaModal("Recarga", numero) +
        filaModal("Estudiante", `${nombre} (${transaccion.curso})`) +
        filaModal("Saldo que tenía", dinero(transaccion.saldo_posterior))
      : "",
    campo: "motivo",
    placeholder: "Ej: se cobró dos veces",
    aceptar: "Revertir",
    peligro: true,
  });
  if (!confirmacion) return;

  try {
    const resultado = await api("/api/recargar/revertir", {
      method: "POST",
      body: JSON.stringify({ numero, motivo: confirmacion }),
    });
    mensaje($("recargaMsg"), resultado.mensaje, resultado.ok);
    mostrarToast("Recarga revertida", resultado.mensaje, resultado.saldo_negativo ? "err" : "ok");
    mostrarUltimo({ ...resultado, hora: new Date().toLocaleTimeString("es-VE") });
    await cargarDatos();
  } catch (error) {
    mensaje($("recargaMsg"), error.message, false);
  }
}

/* ---------- Estudiantes ---------- */

function renderEstudiantes() {
  const texto = $("buscarEstudiante").value.trim().toLowerCase();
  const lista = estudiantes
    .filter(
      (e) =>
        !texto ||
        String(e.nombre || "").toLowerCase().includes(texto) ||
        String(e.curso || "").toLowerCase().includes(texto)
    )
    .sort((a, b) => String(a.nombre || "").localeCompare(String(b.nombre || "")));

  const cuerpo = $("tablaEstudiantes");
  $("vacioEstudiantes").style.display = lista.length ? "none" : "block";

  cuerpo.innerHTML = lista
    .map((e) => {
      const saldo = Number(e.saldo || 0);
      const claseSaldo = saldo <= 0 ? "saldo-bajo" : saldo < precioAlmuerzo ? "saldo-medio" : "saldo-positivo";
      const idsTarjeta = [e.rfid, e.rfid_alt]
        .map((valor) => String(valor === undefined || valor === null ? "" : valor).trim())
        .filter(Boolean);
      const tarjeta = idsTarjeta.length
        ? idsTarjeta.map((id) => `<span class="mono">${esc(id)}</span>`).join("<br>")
        : `<span class="pista">sin tarjeta</span>`;
      return `
        <tr>
          <td>${esc(e.nombre)}</td>
          <td>${esc(e.curso)}</td>
          <td>${tarjeta}</td>
          <td class="num"><span class="${claseSaldo}">${formatearBs(saldo)}</span></td>
          <td>
            <div class="fila-acciones">
              <button class="btn-enlace" data-recargar="${esc(e.estudiante_id)}">Saldo</button>
              ${rol === "admin" ? `<button class="btn-enlace" data-tarjeta="${esc(e.estudiante_id)}">Tarjeta</button>
              <button class="btn-enlace" data-pagador="${esc(e.estudiante_id)}" title="A nombre de quién llega el comprobante">
                ${e.pagador ? esc(e.pagador) : "Paga como"}
              </button>` : ""}
            </div>
          </td>
        </tr>`;
    })
    .join("");

  // Caja sólo consulta y recarga: las altas y la asignación de tarjetas son
  // exclusivas de administración.
  if ($("btnNuevoEstudiante")) $("btnNuevoEstudiante").classList.toggle("oculto", rol !== "admin");
  if ($("nuevoEstudianteCuerpo") && rol !== "admin") $("nuevoEstudianteCuerpo").classList.add("oculto");

  renderSugerencias();
  renderSelectorRecarga();
  renderResumenOperativo();
}

function renderSugerencias() {
  const lista = $("sugerenciasEstudiantes");
  if (!lista) return;
  lista.innerHTML = estudiantes
    .map((e) => `<option value="${esc(e.nombre)}">`)
    .join("");
}

function renderSelectorRecarga() {
  const filtro = ($("buscarRecarga")?.value || "").trim().toLowerCase();
  const selector = $("recargarEstudiante");
  const anterior = selector.value;

  const ordenados = [...estudiantes].sort((a, b) =>
    String(a.nombre || "").localeCompare(String(b.nombre || ""), "es")
  );

  const lista = filtro
    ? ordenados.filter(
        (e) =>
          String(e.nombre || "").toLowerCase().includes(filtro) ||
          String(e.curso || "").toLowerCase().includes(filtro)
      )
    : ordenados;

  selector.innerHTML = lista
    .map(
      (e) =>
        `<option value="${esc(e.estudiante_id)}">${esc(e.nombre)} · ${esc(e.curso)} — ${dinero(e.saldo)}</option>`
    )
    .join("");

  if (lista.some((e) => e.estudiante_id === anterior)) selector.value = anterior;
  else if (lista.length) selector.selectedIndex = 0;

  $("pistaRecarga").textContent = filtro
    ? `${lista.length} de ${estudiantes.length} estudiantes`
    : `${estudiantes.length} estudiantes · escribe para filtrar`;

  actualizarResumenRecarga();
}

function estudianteSeleccionado() {
  const id = $("recargarEstudiante").value;
  return estudiantes.find((e) => e.estudiante_id === id) || null;
}

function actualizarResumenRecarga() {
  const estudiante = estudianteSeleccionado();
  const monto = Number($("recargarMonto").value || 0);
  const actual = Number((estudiante && estudiante.saldo) || 0);
  const nuevo = actual + (monto > 0 ? monto : 0);

  $("resumenActual").textContent = dinero(actual);
  $("resumenNuevo").textContent = dinero(nuevo);
  $("btnRecargar").disabled = !estudiante || !(monto > 0);
  $("resumenNuevo").classList.toggle("destacado-alerta", monto > 0);
}

/* ---------- Carga de datos ---------- */

const VACIOS = ["vacioTransacciones", "vacioEstudiantes", "vacioSolicitudes", "vacioMisSolicitudes"];

function marcarCargando(activo) {
  for (const id of VACIOS) {
    const el = $(id);
    if (!el) continue;
    if (activo) {
      if (el.dataset.vacio === undefined) el.dataset.vacio = el.textContent;
      el.textContent = "Cargando…";
      el.classList.add("cargando");
    } else {
      if (el.dataset.vacio !== undefined) el.textContent = el.dataset.vacio;
      el.classList.remove("cargando");
    }
  }
}

async function cargarDatos() {
  marcarCargando(true);
  try {
    // Cada dato va por separado: si uno falla (por ejemplo, se cae la red
    // justo al pedir las transacciones) los otros dos igual se pintan.
    const [est, trans, config] = await Promise.allSettled([
      api("/api/estudiantes"),
      api("/api/transacciones"),
      api("/api/config"),
    ]);
    if (est.status === "fulfilled") estudiantes = est.value || [];
    if (trans.status === "fulfilled") transacciones = trans.value || [];
    if (config.status === "fulfilled") {
      precioAlmuerzo = Number((config.value && config.value.precio) || precioAlmuerzo || 0);
    }
    renderEstudiantes();
    renderTransacciones();
    renderResumenOperativo();
    const fallidos = [est, trans, config].filter((r) => r.status === "rejected");
    if (fallidos.length) {
      mostrarToast(
        "Aviso",
        "No se pudo actualizar una parte de los datos. Se muestra lo último conocido.",
        "info"
      );
    }
  } finally {
    marcarCargando(false);
  }
}

async function cargarSugerencias() {
  // El listado de estudiantes ya no es público: solo se carga con sesión de
  // operador y se usa en los módulos internos. El login no autocompleta
  // nombres para no exponer el alumnado.
  if (!esRolAdmin()) return;
  if (!estudiantes.length) {
    try {
      estudiantes = (await api("/api/estudiantes")) || [];
    } catch {}
  }
  renderSugerencias();
}

async function cargarUltimo() {
  if (!["admin", "caja"].includes(rol)) return;
  const evento = await api("/api/ultimo");
  mostrarUltimo(evento);
}

async function cargarEstado() {
  const estado = await api("/api/status");
  const chip = $("chipLector");
  if (estado.lector) {
    chip.textContent = "Lector: conectado";
    chip.className = "chip chip-ok";
  } else {
    chip.textContent = "Lector: no detectado";
    chip.className = "chip chip-error";
  }

  const chipAsistencia = $("chipLectorAsistencia");
  if (chipAsistencia) {
    if (estado.lector_asistencia === undefined) {
      chipAsistencia.classList.add("oculto");
    } else if (estado.lector_asistencia) {
      chipAsistencia.textContent = "Asistencia: conectado";
      chipAsistencia.className = "chip chip-ok";
    } else {
      chipAsistencia.textContent = "Asistencia: no detectado";
      chipAsistencia.className = "chip chip-neutro";
    }
  }
}

async function cargarConfig() {
  const config = await api("/api/config");
  precioAlmuerzo = Number(config.precio || 0);
  titularQr = config.beneficiario || titularQr;
  ventanaHoras = Number(config.ventana_horas || 48);
  $("configPrecio").value = config.precio;
  renderTitularQr();
}

function renderTitularQr() {
  const nombre = $("qrTitular");
  const datos = $("qrDatos");
  if (titularQr.nombre) {
    nombre.textContent = titularQr.nombre;
    const partes = [titularQr.cedula, titularQr.telefono, titularQr.banco].filter(Boolean);
    datos.textContent = partes.length ? partes.join(" · ") : "";
  } else {
    nombre.textContent = "sin configurar";
    datos.textContent = "el titular del QR aún no está configurado";
  }
  $("configTitular").value = titularQr.nombre || "";
  $("configCedula").value = titularQr.cedula || "";
  $("configBanco").value = titularQr.banco || "";
  $("configVentana").value = ventanaHoras;
}

async function guardarTitular() {
  const beneficiario = {
    nombre: $("configTitular").value.trim(),
    cedula: $("configCedula").value.trim(),
    banco: $("configBanco").value.trim(),
  };
  const horas = Number($("configVentana").value);
  const boton = $("btnGuardarTitular");
  bloquear(boton, true, "Guardando…");
  try {
    const resultado = await api("/api/config", {
      method: "POST",
      body: JSON.stringify({ beneficiario, ventana_horas: horas }),
    });
    titularQr = resultado.beneficiario || beneficiario;
    ventanaHoras = Number(resultado.ventana_horas || horas);
    renderTitularQr();
    mensaje($("titularMsg"), `Titular del QR: ${titularQr.nombre || "(sin configurar)"}.`);
    mostrarToast(
      "Titular guardado",
      beneficiario.nombre
        ? `Los comprobantes se verificarán contra ${beneficiario.nombre}.`
        : "Sin titular, ningún comprobante se aprueba solo.",
      "ok"
    );
  } catch (error) {
    mensaje($("titularMsg"), error.message, false);
  } finally {
    bloquear(boton, false);
  }
}

// Pide al backend que lea con la IA la imagen del QR publicada y rellena el
// nombre del titular para no tener que escribirlo a mano.
async function leerQrConIa() {
  const boton = $("btnLeerQr");
  bloquear(boton, true, "Leyendo el QR…");
  mensaje($("titularMsg"), "La IA está leyendo la imagen del QR…");
  try {
    const imagen = await leerComoDataUrl(await fetchQrComoArchivo());
    const resultado = await api("/api/config/qr", {
      method: "POST",
      body: JSON.stringify({ archivo: imagen }),
    });
    if (!resultado.ok) {
      mensaje($("titularMsg"), resultado.error || "No se pudo leer el QR.", false);
      return;
    }
    const sugerencia = resultado.sugerencia || {};
    $("configTitular").value = sugerencia.nombre || "";
    $("configCedula").value = sugerencia.cedula || "";
    $("configBanco").value = sugerencia.banco || "";
    mensaje($("titularMsg"), `${resultado.mensaje}`);
  } catch (error) {
    mensaje($("titularMsg"), error.message, false);
  } finally {
    bloquear(boton, false);
  }
}

async function fetchQrComoArchivo() {
  const res = await fetch($("qrImagen").src);
  if (!res.ok) throw new Error("No se pudo cargar la imagen del QR.");
  const blob = await res.blob();
  return new File([blob], "qr-pago.jpeg", { type: blob.type || "image/jpeg" });
}

async function guardarPagador(estudianteId) {
  const estudiante = estudiantes.find((e) => e.estudiante_id === estudianteId);
  if (!estudiante) return;
  const respuesta = await pedirConfirmacion({
    titulo: "¿Quién paga por este estudiante?",
    texto: "Escribe el nombre de quien paga (por ejemplo, la madre). La IA lo usará para comprobar que el comprobante venga de esa persona. Déjalo vacío para usar el nombre del estudiante.",
    campo: "pagador",
    placeholder: estudiante.pagador || "Nombre del padre, madre o representante",
    aceptar: "Guardar",
  });
  if (respuesta === false) return;

  try {
    const resultado = await api("/api/estudiantes/pagador", {
      method: "POST",
      body: JSON.stringify({ estudiante_id: estudianteId, pagador: respuesta }),
    });
    mostrarToast("Pagador actualizado", resultado.mensaje, "ok");
    await cargarDatos();
  } catch (error) {
    mostrarToast("No se pudo guardar", error.message, "err");
  }
}

/* ---------- Cuenta del usuario ---------- */

function pintarSaldo(estudiante) {
  const saldo = Number(estudiante.saldo || 0);
  const precio = precioAlmuerzo;
  const alcanza = precio > 0 && saldo >= precio;
  const almuerzos = precio > 0 ? Math.floor(saldo / precio) : 0;

  estudianteActual = estudiante;
  actualizarSidebar();

  $("saludoUsuario").textContent = `Hola, ${estudiante.nombre}`;
  $("cursoUsuario").textContent = `Curso: ${estudiante.curso} · ID: ${estudiante.estudiante_id}`;
  $("saldoUsuario").textContent = dinero(saldo);

  const tarjeta = $("tarjetaSaldo");
  tarjeta.classList.toggle("bajo", saldo <= 0);
  tarjeta.classList.toggle("justo", saldo > 0 && !alcanza);

  const chip = $("chipSaldo");
  if (precio <= 0) {
    chip.textContent = "Sin precio";
    chip.className = "chip chip-desconocido";
  } else if (alcanza) {
    chip.textContent = "Puedes pagar";
    chip.className = "chip chip-ok";
  } else if (saldo > 0) {
    chip.textContent = "Saldo insuficiente";
    chip.className = "chip chip-desconocido";
  } else {
    chip.textContent = "Sin saldo";
    chip.className = "chip chip-error";
  }

  if (precio > 0 && alcanza) {
    $("saldoDetalle").textContent = `Te alcanza para ${almuerzos} almuerzo${almuerzos === 1 ? "" : "s"} · ${dinero(precio)} cada uno`;
  } else if (precio > 0) {
    $("saldoDetalle").textContent = `Faltan ${dinero(precio - saldo)} para pagar un almuerzo de ${dinero(precio)}`;
  } else {
    $("saldoDetalle").textContent = "El administrador aún no define el precio del almuerzo";
  }

  $("saldoPrecio").textContent = precio > 0 ? dinero(precio) : "—";
  $("saldoAlmuerzos").textContent = precio > 0 ? String(almuerzos) : "—";

  if ($("saldoInicio")) $("saldoInicio").textContent = dinero(saldo);
  if ($("saldoInicioDetalle")) {
    $("saldoInicioDetalle").textContent =
      precio > 0 && saldo >= precio
        ? `Te alcanza para ${almuerzos} almuerzo${almuerzos === 1 ? "" : "s"}`
        : precio > 0
          ? `Faltan ${dinero(Math.max(precio - saldo, 0))} para un almuerzo`
          : "Precio del almuerzo sin configurar";
  }
  if ($("precioInicio")) $("precioInicio").textContent = precio > 0 ? dinero(precio) : "—";
  if ($("precioInicioDetalle")) $("precioInicioDetalle").textContent = "Definido por administración";

  const botonPagar = $("btnPagar");
  // En la nube no hay servidor que descuente el saldo de forma segura: el pago
  // del pedido se hace desde el servidor local. La consulta y la recarga siguen
  // disponibles.
  botonPagar.disabled = modoNubeActual || precio <= 0 || !alcanza;
  botonPagar.title = modoNubeActual
    ? "El pago del pedido se registra en el servidor local"
    : botonPagar.disabled
      ? "No tienes saldo suficiente"
      : `Cobrar ${dinero(precio)}`;
  $("btnIrARecarga").classList.toggle("oculto", alcanza);
}

// El pedido de almuerzo del propio alumno (lo dejó el lector del comedor).
const ESTADOS_MI_PEDIDO = {
  PEDIDO: {
    chip: "Falta pagar",
    clase: "chip-desconocido",
    texto: "Tienes el almuerzo pedido. Para pagarlo, pasa tu tarjeta otra vez en el lector y apoya el dedo.",
  },
  PAGO_SOLICITADO: {
    chip: "Pagando…",
    clase: "chip-desconocido",
    texto: "Estamos cobrando tu pedido. En un momento te lo confirmamos.",
  },
  PAGADO: {
    chip: "Pagado",
    clase: "chip-ok",
    texto: "Almuerzo pagado. Acércate a cocina a retirarlo; allí confirmarán la entrega.",
  },
  RECOGIDO: {
    chip: "Recogido",
    clase: "chip-ok",
    texto: "Almuerzo pagado y entregado. ¡Buen provecho!",
  },
  SIN_SALDO: {
    chip: "Sin saldo",
    clase: "chip-error",
    texto: "No te alcanza el saldo para pagar el almuerzo. Recarga y avisa al administrador para cobrarlo.",
  },
  RECHAZADO: {
    chip: "Rechazado",
    clase: "chip-error",
    texto: "No se pudo validar tu pedido (la tarjeta o el dedo no coinciden). Pide ayuda en la secretaría.",
  },
  CANCELADO: {
    chip: "Cancelado",
    clase: "chip-desconocido",
    texto: "Tu pedido de hoy fue cancelado por el administrador.",
  },
};

function pintarMiPedido(pedido) {
  const chip = $("miPedidoChip");
  const detalle = $("miPedidoDetalle");
  if (!chip || !detalle) return;

  if (!pedido || !pedido.estado) {
    chip.textContent = "Sin pedido";
    chip.className = "chip chip-neutro";
    detalle.textContent = "Todavía no has pedido el almuerzo de hoy. Pasa tu tarjeta en el lector del comedor.";
    const chip2 = $("miPedidoChipComedor");
    const detalle2 = $("miPedidoDetalleComedor");
    if (chip2) { chip2.textContent = "Sin pedido"; chip2.className = "chip chip-neutro"; }
    if (detalle2) detalle2.textContent = detalle.textContent;
    if ($("pedidoInicio")) $("pedidoInicio").textContent = "Sin pedido";
    if ($("pedidoInicioDetalle")) $("pedidoInicioDetalle").textContent = "Pasa tu tarjeta en el comedor";
    return;
  }

  const info = ESTADOS_MI_PEDIDO[pedido.estado] || {
    chip: "Pedido",
    clase: "chip-desconocido",
    texto: "Tu pedido está en proceso.",
  };
  const textoFinal = pedido.mensaje ? `${info.texto} (${pedido.mensaje})` : info.texto;
  chip.textContent = info.chip;
  chip.className = `chip ${info.clase}`;
  detalle.textContent = textoFinal;
  const chip2 = $("miPedidoChipComedor");
  const detalle2 = $("miPedidoDetalleComedor");
  if (chip2) { chip2.textContent = info.chip; chip2.className = `chip ${info.clase}`; }
  if (detalle2) detalle2.textContent = textoFinal;
  if ($("pedidoInicio")) $("pedidoInicio").textContent = info.chip;
  if ($("pedidoInicioDetalle")) $("pedidoInicioDetalle").textContent = info.texto;
}

// Carga el pedido del día del alumno y lo pinta.
async function cargarMiPedido(fecha) {
  if (!$("miPedidoChip")) return;
  // El pedido del alumno siempre es el de HOY (la fecha que elige el
  // administrador en el panel no tiene nada que ver aquí).
  const dia = fecha || hoyISO();
  try {
    const datos = await api(`/api/pedidos/mio?fecha=${encodeURIComponent(dia)}`);
    pintarMiPedido(datos && datos.pedido);
  } catch (error) {
    pintarMiPedido(null);
  }
}

function renderHistorial(historial) {
  $("vacioHistorial").style.display = historial.length ? "none" : "block";
  $("tablaHistorial").innerHTML = historial
    .map((t) => {
      const monto = t.tipo === "RECARGA" ? t.monto : t.precio;
      const tipoClase =
        t.tipo === "RECARGA" ? "badge-recarga" : t.tipo === "ANULACION" ? "badge-anulacion" : "badge-compra";
      const anulada = t.estado === "anulado";
      return `
        <tr class="${anulada ? "fila-anulada" : ""}">
          <td>${esc(t.numero)}</td>
          <td><span class="badge ${tipoClase}">${esc(t.tipo)}</span></td>
          <td class="num">${formatearBs(monto)}</td>
          <td class="num">${formatearBs(t.saldo_anterior)}</td>
          <td class="num">${formatearBs(t.saldo_posterior)}</td>
          <td>${esc(t.fecha)}</td>
          <td>${esc(t.hora)}</td>
        </tr>`;
    })
    .join("");
}

async function cargarMiCuenta() {
  if (!cuentaCargada) {
    $("btnPagar").disabled = true;
    $("saldoUsuario").textContent = "…";
    $("saldoDetalle").textContent = "Cargando tu saldo…";
  }
  if (precioAlmuerzo <= 0) await cargarConfig().catch(() => {});
  const datos = await api("/api/mi-cuenta");
  pintarSaldo(datos.estudiante);
  renderHistorial(datos.historial || []);
  cuentaCargada = true;
  // El pedido del día lo dejó el lector del comedor: se pinta aparte para no
  // bloquear la pantalla si el endpoint falla.
  cargarMiPedido().catch(() => {});
}

/* ---------- Secciones del estudiante: Comedor y Asistencia ---------- */

// Se conserva por compatibilidad: las secciones del estudiante ahora son
// módulos independientes de la barra lateral.
function mostrarSubPestana(nombre) {
  const mapa = {
    comedor: "est-comedor",
    inicio: "est-inicio",
    recarga: "est-recarga",
    asistencia: "est-asistencia",
  };
  mostrarModulo(mapa[nombre] || "est-comedor");
}

async function cargarMiAsistencia() {
  if (!$("tablaMiAsistencia")) return;
  if (!$("resumenMiAsistencia").innerHTML) {
    $("resumenMiAsistencia").innerHTML =
      `<div class="resumen-celda"><span>Asistencias</span><strong>Cargando…</strong></div>`;
  }
  const datos = await api("/api/mi-asistencia");
  renderMiAsistencia(datos.asistencias || []);
}

function renderMiAsistencia(registros) {
  miAsistenciaCache = registros || [];
  const hoy = new Date();
  const inicioPeriodo = new Date(hoy);
  if (periodoAsistencia === "semana") inicioPeriodo.setDate(hoy.getDate() - 6);
  if (periodoAsistencia === "mes") inicioPeriodo.setDate(hoy.getDate() - 29);
  const desde = periodoAsistencia === "dia" ? hoyISO() : inicioPeriodo.toLocaleDateString("sv-SE");
  const lista = miAsistenciaCache.filter((a) => !desde || String(a.fecha || "") >= desde);
  const presentes = lista.filter((a) => a.hora_entrada);

  if ($("chipMiAsistencia")) {
    $("chipMiAsistencia").textContent = `${lista.length} ${lista.length === 1 ? "día" : "días"}`;
  }

  if ($("asistenciaInicio")) {
    const deHoy = miAsistenciaCache.find((a) => a.fecha === hoyISO());
    $("asistenciaInicio").textContent = deHoy && deHoy.hora_entrada ? (deHoy.hora_salida ? "Completa" : "Dentro") : "Sin marcar";
    if ($("asistenciaInicioDetalle")) {
      $("asistenciaInicioDetalle").textContent =
        deHoy && deHoy.hora_entrada
          ? `Entrada ${deHoy.hora_entrada}${deHoy.hora_salida ? ` · salida ${deHoy.hora_salida}` : ""}`
          : "Aún no registras entrada hoy";
    }
  }

  if ($("resumenMiAsistencia")) {
    $("resumenMiAsistencia").innerHTML = `
      <div class="resumen-celda"><span>Días asistidos</span><strong>${presentes.length}</strong></div>
      <div class="resumen-celda"><span>Jornadas completas</span><strong>${lista.filter((a) => a.hora_entrada && a.hora_salida).length}</strong></div>
      <div class="resumen-celda"><span>Hoy</span><strong>${esc(estadoHoyTexto(lista))}</strong></div>`;
  }

  $("vacioMiAsistencia").style.display = lista.length ? "none" : "block";
  $("tablaMiAsistencia").innerHTML = lista
    .map((a) => {
      const completa = Boolean(a.hora_entrada && a.hora_salida);
      const clase = !a.hora_entrada ? "badge-anulacion" : completa ? "badge-ok" : "badge-alerta";
      const etiqueta = !a.hora_entrada ? "Sin entrada" : completa ? "Completa" : "Dentro";
      return `
        <tr>
          <td>${esc(a.fecha || "—")}</td>
          <td>${esc(a.hora_entrada || "—")}</td>
          <td>${esc(a.hora_salida || "—")}</td>
          <td><span class="badge ${clase}">${etiqueta}</span></td>
          <td>${esc(a.permanencia || "—")}</td>
        </tr>`;
    })
    .join("");
}

function estadoHoyTexto(registros) {
  const hoy = hoyISO();
  const registro = registros.find((a) => a.fecha === hoy);
  if (!registro || !registro.hora_entrada) return "Sin marcar";
  if (registro.hora_salida) return "Completa";
  return "Dentro";
}

/* ---------- Sesión ---------- */

function guardarSesion(nuevoToken, nuevoRol) {
  token = nuevoToken;
  rol = nuevoRol;
  // En la nube el token no se persiste: al recargar la página hay que volver a
  // iniciar sesión. En local se conserva por pestaña en sessionStorage.
  if (modoNubeActual) {
    if (window.ApiWeb && typeof window.ApiWeb.recordarSesion === "function") {
      window.ApiWeb.recordarSesion(nuevoToken, nuevoRol);
    }
    return;
  }
  if (nuevoToken) {
    sessionStorage.setItem("comedor_token", nuevoToken);
    sessionStorage.setItem("comedor_rol", nuevoRol);
  } else {
    sessionStorage.removeItem("comedor_token");
    sessionStorage.removeItem("comedor_rol");
  }
}

// Recupera la sesión de esta pestaña al recargar. La autorización real sigue
// siendo del servidor; aquí solo se restaura el token para que la primera
// consulta lo valide.
function cargarSesionGuardada() {
  if (modoNubeActual) return false;
  const guardado = sessionStorage.getItem("comedor_token") || "";
  const rolGuardado = sessionStorage.getItem("comedor_rol") || "";
  if (!guardado || !["admin", "caja", "cocinera", "usuario"].includes(rolGuardado)) {
    return false;
  }
  token = guardado;
  rol = rolGuardado;
  return true;
}

function cerrarSesionLocal() {
  // Cancela las consultas que estaban en curso: si el usuario cierra sesión,
  // no deben llegar respuestas 401 de peticiones que ya no importan.
  if (controladorApi) controladorApi.abort();
  controladorApi = crearControladorApi();
  cuentaCargada = false;
  estudianteActual = null;
  moduloActual = "";
  guardarSesion("", "");
  cerrarNotificaciones();
  sincronizarUrl("login");
  marcarPestanas();
  actualizarSidebar();
}

function mensaje(elemento, texto, ok = true) {
  elemento.textContent = texto;
  elemento.className = `mensaje ${ok ? "ok" : "err"}`;
}

async function entrarUsuario() {
  const nombre = $("loginNombre").value.trim();
  const password = $("loginPassword").value;
  if (!nombre || !password) {
    mensaje($("loginMsg"), "Ingresa el nombre y la contraseña.", false);
    return;
  }
  const boton = $("btnEntrarUsuario");
  bloquear(boton, true, "Entrando…");
  try {
    const resultado = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ nombre, password }),
    });
    $("loginPassword").value = "";
    mensaje($("loginMsg"), "", true);
    await cargarConfig().catch(() => {});

    // Si esta pestaña ya era de administración, el alumno entra en otra.
    if (esRolAdmin()) {
      abrirPestana(RUTAS.alumno, resultado.token, "usuario");
      mensaje($("loginMsg"), "Sesión del alumno abierta en otra pestaña.");
      return;
    }

    guardarSesion(resultado.token, "usuario");
    renderVistas();
  } catch (error) {
    mensaje($("loginMsg"), error.message, false);
  } finally {
    bloquear(boton, false);
  }
}

async function entrarAdmin() {
  const password = $("passwordAdmin").value;
  const perfil = ($("perfilAdmin") && $("perfilAdmin").value) || "admin";
  if (!password) {
    mensaje($("loginAdminMsg"), "Ingresa la contraseña del perfil.", false);
    return;
  }
  const boton = $("btnEntrarAdmin");
  bloquear(boton, true, "Entrando…");
  try {
    const resultado = await api("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ password, perfil }),
    });
    const rolSesion = resultado.rol || perfil;
    $("passwordAdmin").value = "";
    mensaje($("loginAdminMsg"), "", true);

    if ($("adminNuevaPestana").checked) {
      abrirPestana(RUTAS.admin, resultado.token, rolSesion);
      mensaje($("loginAdminMsg"), "Panel abierto en otra pestaña.");
      return;
    }

    guardarSesion(resultado.token, rolSesion);
    if (rutaActual() !== "admin") history.replaceState(null, "", RUTAS.admin);
    renderVistas();
  } catch (error) {
    mensaje($("loginAdminMsg"), error.message, false);
  } finally {
    bloquear(boton, false);
  }
}

// Cambia el perfil seleccionado en el login de administración.
function seleccionarPerfil(perfil, boton) {
  const destino = ["admin", "caja", "cocinera"].includes(perfil) ? perfil : "admin";
  if ($("perfilAdmin")) $("perfilAdmin").value = destino;
  document.querySelectorAll(".perfil-btn").forEach((btn) => {
    btn.classList.toggle("activo", btn.dataset.perfil === destino);
  });
  const info = ROLES_INFO[destino];
  if ($("passwordAdmin")) {
    $("passwordAdmin").placeholder = `Contraseña de ${info.nombre.toLowerCase()}`;
    $("passwordAdmin").focus();
  }
  if ($("loginAdminMsg")) mensaje($("loginAdminMsg"), "", true);
  if (boton) boton.blur();
}

async function accionCerrarSesion() {
  // Corta primero las consultas en curso para que no lleguen al servidor
  // después de invalidar el token (evita errores 401 al cerrar sesión).
  const enCurso = controladorApi;
  controladorApi = crearControladorApi();
  if (enCurso) enCurso.abort();
  try {
    const ruta = esRolAdmin() ? "/api/admin/logout" : "/api/logout";
    await api(ruta, { method: "POST", body: "{}" });
  } catch {}
  cerrarSesionLocal();
  renderVistas();
  if ($("passwordAdmin")) $("passwordAdmin").value = "";
  mostrarAccesoAdmin();
}

// En Firebase Hosting no hay servidor Node que valide las claves de los
// perfiles. Hasta migrar a Firebase Authentication, el panel administrativo se
// bloquea en la nube; así nadie puede confundir una comprobación hecha en el
// navegador con una autorización real.
function configurarModoNube() {
  const aviso =
    "El panel de administración no está disponible en modo nube. Usa el servidor local o configura Firebase Authentication.";
  document.querySelectorAll(".perfil-btn").forEach((boton) => {
    boton.disabled = true;
    boton.title = aviso;
  });
  if ($("passwordAdmin")) {
    $("passwordAdmin").disabled = true;
    $("passwordAdmin").placeholder = "No disponible en modo nube";
  }
  if ($("btnEntrarAdmin")) $("btnEntrarAdmin").disabled = true;
  if ($("adminNuevaPestana")) {
    $("adminNuevaPestana").checked = false;
    $("adminNuevaPestana").disabled = true;
  }
  if ($("loginAdminMsg")) {
    $("loginAdminMsg").textContent = aviso;
    $("loginAdminMsg").className = "mensaje";
  }
  if ($("btnPagar")) {
    $("btnPagar").disabled = true;
    $("btnPagar").title = "El pago del pedido se registra en el servidor local";
  }
}

// El login nuevo muestra las dos tarjetas a la vez. Estas funciones se
// conservan para que la ruta /admin enfoque el acceso de administración.
function mostrarAccesoAdmin() {
  if ($("adminLoginCuerpo")) $("adminLoginCuerpo").classList.remove("oculto");
  if ($("passwordAdmin")) $("passwordAdmin").focus();
}

function ocultarAccesoAdmin() {
  if ($("adminLoginCuerpo")) $("adminLoginCuerpo").classList.remove("oculto");
}

/* ---------- Pagar almuerzo ---------- */

async function accionPagar() {
  if (rol !== "usuario") return;
  const boton = $("btnPagar");
  if (boton.disabled) return;
  bloquear(boton, true, "Procesando pago…");
  try {
    const resultado = await api("/api/pagar", { method: "POST", body: "{}" });
    mensaje($("pagoMsg"), resultado.mensaje, resultado.ok);
    mostrarUltimo({ ...resultado, hora: new Date().toLocaleTimeString("es-VE") });
    if (resultado.ok) mostrarToast("¡Almuerzo pagado!", resultado.mensaje, "ok");
    await cargarMiCuenta().catch(() => {});
  } catch (error) {
    mensaje($("pagoMsg"), error.message, false);
    mostrarToast("No se pudo cobrar", error.message, "err");
  } finally {
    bloquear(boton, false);
    await cargarMiCuenta().catch(() => {});
  }
}

/* ---------- Recarga de saldo (usuario) ---------- */

function marcarChips(grupo, valor) {
  const texto = String(valor).trim().replace(",", ".");
  grupo.querySelectorAll(".chip-btn").forEach((chip) => {
    chip.classList.toggle("activo", texto !== "" && Number(chip.dataset.monto) === Number(texto));
  });
}

function abrirPanelRecarga() {
  if (rol === "usuario" && moduloActual !== "est-recarga") mostrarModulo("est-recarga", { silencioso: true });
  $("recargaCuerpo").classList.remove("oculto");
  $("btnToggleRecarga").textContent = "Ocultar datos de pago";
  $("btnToggleRecarga").classList.add("activo");
  $("btnToggleRecarga").setAttribute("aria-expanded", "true");
  $("recargaCuerpo").scrollIntoView({ behavior: "smooth", block: "nearest" });
  $("recargaMontoUsuario").focus();
}

function accionToggleRecarga() {
  const abierto = $("recargaCuerpo").classList.contains("oculto");
  if (abierto) {
    abrirPanelRecarga();
  } else {
    $("recargaCuerpo").classList.add("oculto");
    $("btnToggleRecarga").textContent = "Ver cómo pagar";
    $("btnToggleRecarga").classList.remove("activo");
    $("btnToggleRecarga").setAttribute("aria-expanded", "false");
  }
}

function comprimirImagen(archivo) {
  return new Promise((resolve, reject) => {
    if (!archivo.type || !archivo.type.startsWith("image/")) {
      reject(new Error("El archivo debe ser una imagen."));
      return;
    }
    const url = URL.createObjectURL(archivo);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      try {
        const dibujar = (lado, calidad) => {
          const escala = Math.min(1, lado / Math.max(img.width, img.height));
          const ancho = Math.max(1, Math.round(img.width * escala));
          const alto = Math.max(1, Math.round(img.height * escala));
          const lienzo = document.createElement("canvas");
          lienzo.width = ancho;
          lienzo.height = alto;
          const ctx = lienzo.getContext("2d");
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, ancho, alto);
          ctx.drawImage(img, 0, 0, ancho, alto);
          return lienzo.toDataURL("image/jpeg", calidad);
        };
        let salida = dibujar(MAX_LADO_IMAGEN, 0.8);
        if (salida.length > MAX_BYTES_COMPROBANTE) salida = dibujar(1000, 0.6);
        if (salida.length > MAX_BYTES_COMPROBANTE) salida = dibujar(820, 0.5);
        resolve(salida);
      } catch (error) {
        reject(error);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("No se pudo leer la imagen. Usa una foto JPG o PNG."));
    };
    img.src = url;
  });
}

function leerComoDataUrl(archivo) {
  return new Promise((resolve, reject) => {
    const lector = new FileReader();
    lector.onload = () => resolve(lector.result);
    lector.onerror = () => reject(new Error("No se pudo leer el archivo."));
    lector.readAsDataURL(archivo);
  });
}

function limpiarArchivo() {
  $("recargaArchivo").value = "";
  $("vistaPrevia").classList.add("oculto");
  $("zonaSoltar").classList.remove("oculto", "arrastrando");
  $("pistaArchivo").classList.add("oculto");
  $("pistaArchivo").textContent = "";
}

function previsualizarArchivo(archivo) {
  if (!archivo) {
    limpiarArchivo();
    return;
  }
  const vistaPrevia = $("vistaPrevia");
  const img = $("vistaPreviaImg");
  img.src = "";
  $("zonaSoltar").classList.add("oculto");
  $("pistaArchivo").classList.add("oculto");
  vistaPrevia.classList.remove("oculto");
  $("vistaPreviaNombre").textContent = archivo.name;
  $("vistaPreviaPeso").textContent = kb(archivo.size);
  $("pistaArchivo").classList.remove("oculto");
  $("pistaArchivo").textContent = "La reducimos automáticamente para que el comprobante suba rápido.";
  if (archivo.type.startsWith("image/")) {
    const lector = new FileReader();
    lector.onload = () => {
      img.src = lector.result;
    };
    lector.readAsDataURL(archivo);
  } else {
    vistaPrevia.classList.add("oculto");
    $("zonaSoltar").classList.remove("oculto");
  }
}

function comprobarArchivo(archivo) {
  if (!archivo) {
    return null;
  }
  if (!archivo.type.startsWith("image/")) {
    return "El comprobante debe ser una imagen.";
  }
  if (archivo.size > 12 * 1024 * 1024) {
    return "La imagen es muy pesada. Tómala con menos resolución.";
  }
  return null;
}

async function accionEnviarComprobante() {
  const monto = Number($("recargaMontoUsuario").value);
  const nota = $("recargaNota").value.trim();
  const archivo = $("recargaArchivo").files[0];
  const boton = $("btnEnviarComprobante");

  if (!Number.isFinite(monto) || monto <= 0) {
    mensaje($("comprobanteMsg"), "Indica el monto que pagaste.", false);
    $("recargaMontoUsuario").focus();
    return;
  }
  if (!archivo) {
    mensaje($("comprobanteMsg"), "Adjunta una foto del comprobante.", false);
    $("zonaSoltar").focus();
    return;
  }
  const problema = comprobarArchivo(archivo);
  if (problema) {
    mensaje($("comprobanteMsg"), problema, false);
    $("zonaSoltar").focus();
    return;
  }

  bloquear(boton, true, "Enviando…");
  mensaje($("comprobanteMsg"), "Reduciendo y enviando el comprobante…", true);

  let imagen;
  try {
    imagen = await comprimirImagen(archivo);
  } catch (error) {
    if (archivo.size <= MAX_BYTES_COMPROBANTE) {
      imagen = await leerComoDataUrl(archivo);
    } else {
      bloquear(boton, false);
      mensaje($("comprobanteMsg"), `${error.message} La foto pesa ${kb(archivo.size)}.`, false);
      return;
    }
  }

  try {
    const resultado = await api("/api/comprobante", {
      method: "POST",
      body: JSON.stringify({ monto, nota, archivo: imagen }),
    });
    // La IA solo orienta a caja: el comprobante siempre queda pendiente.
    mensaje($("comprobanteMsg"), resultado.mensaje, true);
    mostrarToast("Comprobante enviado", resultado.mensaje, "info");
    pintarRevision(resultado.solicitud, resultado.aprobacion);
    limpiarArchivo();
    $("recargaMontoUsuario").value = "";
    $("recargaNota").value = "";
    await Promise.all([cargarMiCuenta().catch(() => {}), cargarMisSolicitudes().catch(() => {})]);
  } catch (error) {
    mensaje($("comprobanteMsg"), error.message, false);
    $("revisionIA").classList.add("oculto");
    mostrarToast("No se pudo enviar", error.message, "err");
  } finally {
    bloquear(boton, false);
  }
}

/* ---------- Solicitudes de recarga (admin) ---------- */

function analisisIA(solicitud) {
  return (solicitud && solicitud.analisis_ia) || {};
}

function verificacionIA(solicitud) {
  return (solicitud && solicitud.verificacion) || null;
}

// Quién debería haber enviado el comprobante: lo que el admin registró en la
// ficha del estudiante, o el propio estudiante si no hay pagador anotado.
function pagadorEsperado(solicitud) {
  const estudiante = estudiantes.find((e) => e.estudiante_id === solicitud.estudiante_id);
  return (
    (estudiante && (estudiante.pagador || estudiante.representante)) || solicitud.nombre || ""
  );
}

// "MARÍA LÓPEZ" en verde si coincide con lo esperado, en ámbar si no coincide.
function celdaPersona(leido, esperado) {
  if (!leido) return `<span class="pista">no se leyó</span>`;
  const iguales =
    !esperado ||
    normalizarTexto(leido) === normalizarTexto(esperado) ||
    normalizarTexto(esperado).includes(normalizarTexto(leido));
  const titulo = esperado ? `Esperado: ${esperado}` : "Sin referencia para comparar";
  return `<span class="persona ${iguales ? "persona-ok" : "persona-alerta"}" title="${esc(titulo)}">${esc(leido)}</span>`;
}

function celdaMomento(solicitud) {
  const momento = (verificacionIA(solicitud) || {}).momento;
  if (!momento) {
    const crudo = analisisIA(solicitud);
    const texto = [crudo.fecha, crudo.hora].filter(Boolean).join(" ");
    return texto
      ? `<span class="persona persona-alerta">${esc(texto)}</span>`
      : `<span class="pista">no se leyó</span>`;
  }
  const revision = (verificacionIA(solicitud).revisiones || []).find((r) => r.id === "momento");
  const clase = revision && revision.estado === "ok" ? "persona-ok" : "persona-alerta";
  return `<span class="persona ${clase}">${esc(momento.texto)}</span>`;
}

function normalizarTexto(texto) {
  return String(texto || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function veredictoIA(solicitud) {
  const analisis = solicitud.analisis_ia;
  if (!analisis) {
    return `<span class="pista">sin análisis</span>`;
  }
  const partes = [];

  if (verificacionIA(solicitud)) {
    partes.push(
      `<span class="detalle-ia">${esc(verificacionIA(solicitud).resumen || "")}</span>`
    );
  }

  if (analisis.sospechas) {
    partes.unshift(
      `<span class="badge badge-alerta" title="${esc(analisis.sospechas)}">Revisar</span>
       <span class="detalle-ia">${esc(analisis.sospechas)}</span>`
    );
    return partes.join("");
  }

  if (analisis.esComprobante && Number(analisis.monto) > 0) {
    const coincide =
      Math.round((Number(analisis.monto) - Number(solicitud.monto)) * 100) / 100 === 0;
    partes.unshift(
      `<span class="badge ${coincide ? "badge-ok" : "badge-alerta"}">${dinero(analisis.monto)}</span>
       <span class="detalle-ia">${coincide ? "coincide con lo pedido" : "el comprobante dice otra cantidad"}</span>`
    );
  } else {
    partes.unshift(`<span class="badge badge-alerta">No reconocido</span>`);
  }

  return partes.join("");
}

// La caja que ve el estudiante después de enviar el comprobante.
function pintarRevision(solicitud, aprobacion) {
  const caja = $("revisionIA");
  const lista = $("revisionLista");
  const verificacion = verificacionIA(solicitud);
  if (!verificacion) {
    caja.classList.add("oculto");
    return;
  }

  const chip = $("revisionEstado");
  chip.textContent = "pendiente de caja";
  chip.className = "chip chip-alerta";

  $("revisionTitulo").textContent = "Tu comprobante está en revisión";

  const iconos = { ok: "✓", alerta: "!", sin_dato: "?", info: "i" };
  lista.innerHTML = (verificacion.revisiones || [])
    .map(
      (r) => `
      <li class="revision-fila revision-${r.estado}">
        <span class="revision-icono" aria-hidden="true">${iconos[r.estado] || "i"}</span>
        <div>
          <strong>${esc(r.etiqueta)}</strong>
          <span>${esc(r.detalle)}</span>
        </div>
      </li>`
    )
    .join("");

  $("revisionResumen").textContent = verificacion.resumen || "";
  caja.classList.remove("oculto");
}

const ESTADOS_SOLICITUD = {
  pendiente: { texto: "Pendiente", clase: "badge-alerta" },
  aprobada: { texto: "Aprobada", clase: "badge-ok" },
  rechazada: { texto: "Rechazada", clase: "badge-anulacion" },
};

function estadoSolicitud(estado) {
  return ESTADOS_SOLICITUD[estado] || { texto: estado || "—", clase: "badge-anulacion" };
}

function solicitudesFiltradas() {
  const estado = ($("filtroEstadoSolicitud") && $("filtroEstadoSolicitud").value) || "pendiente";
  const texto = (($("buscarSolicitud") && $("buscarSolicitud").value) || "").trim().toLowerCase();
  return solicitudes
    .filter((s) => estado === "todas" || s.estado === estado)
    .filter(
      (s) =>
        !texto ||
        String(s.nombre || "").toLowerCase().includes(texto) ||
        String(s.curso || "").toLowerCase().includes(texto) ||
        String(s.numero || "").toLowerCase().includes(texto)
    )
    .sort((a, b) => String(b.numero).localeCompare(String(a.numero)));
}

function renderSolicitudes() {
  const pendientes = solicitudes.filter((s) => s.estado === "pendiente");
  const lista = solicitudesFiltradas();

  const cuerpo = $("tablaSolicitudes");
  $("vacioSolicitudes").style.display = lista.length ? "none" : "block";
  $("contadorSolicitudes").textContent = `${pendientes.length} pendiente${pendientes.length === 1 ? "" : "s"}`;
  $("contadorSolicitudes").className = `chip ${pendientes.length ? "chip-alerta" : "chip-neutro"}`;
  if ($("badgeComprobantes")) {
    $("badgeComprobantes").textContent = String(pendientes.length);
    $("badgeComprobantes").classList.toggle("oculto", !pendientes.length);
  }
  if ($("kpiSolicitudesPendientes")) $("kpiSolicitudesPendientes").textContent = String(pendientes.length);
  renderMiniSolicitudes(pendientes);

  cuerpo.innerHTML = lista
    .map((s) => {
      const estado = estadoSolicitud(s.estado);
      const autorizado =
        s.monto_autorizado !== undefined && s.monto_autorizado !== null
          ? formatearBs(s.monto_autorizado)
          : s.estado === "pendiente"
            ? `<span class="pista">por definir</span>`
            : "—";
      const acciones =
        s.estado === "pendiente"
          ? `<div class="fila-acciones">
              <button class="btn btn-primario btn-solicitud" data-numero="${esc(s.numero)}">Aprobar</button>
              <button class="btn btn-peligro btn-solicitud" data-rechazar="${esc(s.numero)}">Rechazar</button>
            </div>`
          : `<span class="pista">${esc(s.revisado_por || "revisada")}${s.motivo ? ` · ${esc(s.motivo)}` : ""}</span>`;
      return `
      <tr>
        <td>${esc(s.numero)}</td>
        <td>${esc(s.nombre)}<br><span class="pista">${esc(s.curso)}</span></td>
        <td class="num">${formatearBs(s.monto)}</td>
        <td class="num">${autorizado}</td>
        <td>${celdaPersona(analisisIA(s).pagador, pagadorEsperado(s))}</td>
        <td>${celdaPersona(analisisIA(s).receptor, (s.beneficiario_qr && s.beneficiario_qr.nombre) || titularQr.nombre)}</td>
        <td>${celdaMomento(s)}</td>
        <td class="celda-analisis">${veredictoIA(s)}</td>
        <td><span class="badge ${estado.clase}">${estado.texto}</span></td>
        <td>
          ${
            s.tiene_archivo
              ? `<button class="solicitud-mini-btn" data-ver="${esc(s.numero)}" title="Ver comprobante" aria-label="Ver comprobante de ${esc(s.nombre)}">
                   <i class="fa-solid fa-receipt" aria-hidden="true"></i>
                 </button>`
              : `<span class="pista">sin imagen</span>`
          }
        </td>
        <td>${acciones}</td>
      </tr>`;
    })
    .join("");
}

function renderMiniSolicitudes(pendientes) {
  const contenedor = $("miniSolicitudes");
  if (!contenedor) return;
  const lista = (pendientes || []).slice(0, 4);
  if (!lista.length) {
    contenedor.innerHTML = `<p class="vacio">Sin comprobantes pendientes.</p>`;
    return;
  }
  contenedor.innerHTML = lista
    .map(
      (s) => `
      <div class="mini-item">
        <span class="mini-item-icon"><i class="fa-solid fa-receipt"></i></span>
        <div class="mini-item-body"><strong>${esc(s.nombre)}</strong><span>${esc(s.curso)} · ${esc(s.numero)}</span></div>
        <span class="mini-item-monto">${formatearBs(s.monto)}</span>
      </div>`
    )
    .join("");
}

function renderMiniPedidos(datos) {
  const contenedor = $("miniPedidos");
  if (!contenedor) return;
  const lista = ((datos && datos.pedidos) || []).slice(0, 4);
  if (!lista.length) {
    contenedor.innerHTML = `<p class="vacio">Sin pedidos registrados.</p>`;
    return;
  }
  contenedor.innerHTML = lista
    .map((p) => {
      const info = estadoPedido(p.estado);
      return `
        <div class="mini-item">
          <span class="mini-item-icon"><i class="fa-solid fa-bowl-food"></i></span>
          <div class="mini-item-body"><strong>${esc(p.nombre)}</strong><span>${esc(p.curso)} · ${esc(p.hora_pedido || "—")}</span></div>
          <span class="badge ${info.clase}">${esc(info.texto)}</span>
        </div>`;
    })
    .join("");
}

// Actualiza los indicadores del resumen según el perfil conectado.
function renderResumenOperativo() {
  if (!esRolAdmin()) return;

  if (rol === "cocinera") {
    const resumen = pedidos.reduce(
      (acc, p) => {
        acc.total += 1;
        if (p.estado === "RECOGIDO") acc.entregados += 1;
        else if (p.estado === "SIN_SALDO") acc.sinSaldo += 1;
        else if (p.estado === "PEDIDO" || p.estado === "PAGO_SOLICITADO") acc.pendientes += 1;
        else if (p.estado === "PAGADO") acc.porEntregar += 1;
        return acc;
      },
      { total: 0, pendientes: 0, porEntregar: 0, entregados: 0, sinSaldo: 0 }
    );
    if ($("kpiPedidosTotal")) $("kpiPedidosTotal").textContent = String(resumen.total);
    if ($("kpiPedidosPendientes")) $("kpiPedidosPendientes").textContent = String(resumen.pendientes);
    if ($("kpiPedidosEntregados")) $("kpiPedidosEntregados").textContent = String(resumen.porEntregar);
    if ($("kpiPedidosSinSaldo")) $("kpiPedidosSinSaldo").textContent = String(resumen.sinSaldo);
    return;
  }

  if (rol === "caja" || rol === "admin") {
    const hoy = hoyISO();
    const pendientes = solicitudes.filter((s) => s.estado === "pendiente");
    const delDia = transacciones.filter((t) => t.fecha === hoy);
    const recargas = delDia.filter((t) => t.tipo === "RECARGA" && t.estado !== "anulado");
    const totalRecargas = recargas.reduce((suma, t) => suma + Number(t.monto || 0), 0);
    const saldoBajo = estudiantes.filter((e) => Number(e.saldo || 0) < Number(precioAlmuerzo || 0)).length;

    if ($("kpiSolicitudesPendientes")) $("kpiSolicitudesPendientes").textContent = String(pendientes.length);
    if ($("kpiRecargasHoy")) $("kpiRecargasHoy").textContent = dinero(totalRecargas);
    if ($("kpiMovimientosHoy")) $("kpiMovimientosHoy").textContent = String(delDia.length);
    if ($("kpiSaldoBajo")) $("kpiSaldoBajo").textContent = String(saldoBajo);
  }
}

// Entregas del día: primero los pagados pendientes de cocina y luego los ya
// entregados. La entrega se confirma con un botón distinto al cobro.
function renderEntregas(lista) {
  if (!$("tablaEntregas")) return;
  const entregas = (lista || [])
    .filter((p) => p.estado === "PAGADO" || p.estado === "RECOGIDO")
    .sort((a, b) => {
      if (a.estado !== b.estado) return a.estado === "PAGADO" ? -1 : 1;
      return String(b.hora_pago || b.hora_pedido || "").localeCompare(
        String(a.hora_pago || a.hora_pedido || "")
      );
    });
  const porEntregar = entregas.filter((p) => p.estado === "PAGADO").length;
  if ($("vacioEntregas")) $("vacioEntregas").style.display = entregas.length ? "none" : "block";
  if ($("contadorEntregas")) {
    $("contadorEntregas").textContent = `${porEntregar} por entregar · ${entregas.length - porEntregar} entregadas`;
    $("contadorEntregas").className = `chip ${porEntregar ? "chip-alerta" : "chip-ok"}`;
  }
  $("tablaEntregas").innerHTML = entregas
    .map((p) => {
      const monto = Number(p.monto || p.precio || precioAlmuerzo || 0) || 0;
      const esAdmin = rol === "caja" || rol === "admin";
      const accion =
        p.estado === "PAGADO" && (rol === "cocinera" || rol === "admin")
          ? `<button class="btn-enlace" data-entregar-pedido="${esc(estudianteIdDePedido(p))}">Confirmar entrega</button>`
          : `<span class="pista">${p.estado === "RECOGIDO" ? "entregado" : "esperando cobro"}</span>`;
      return `
        <tr>
          <td>${esc(p.hora_pago || p.hora_pedido || "—")}</td>
          <td>${esc(p.nombre)}</td>
          <td>${esc(p.curso)}</td>
          <td><span class="badge ${p.estado === "RECOGIDO" ? "badge-ok" : "badge-recarga"}">${p.estado === "RECOGIDO" ? "Entregado" : "Pagado · por entregar"}</span></td>
          <td class="num solo-caja">${esAdmin && monto ? formatearBs(monto) : "—"}</td>
          <td>${accion}</td>
        </tr>`;
    })
    .join("");
}

async function cargarSolicitudes() {
  marcarCargando(true);
  try {
    solicitudes = (await api("/api/solicitudes")) || [];
    renderSolicitudes();
    renderResumenOperativo();
  } finally {
    marcarCargando(false);
  }
}

/* ---------- Mis solicitudes (estudiante) ---------- */

function renderMisSolicitudes(lista) {
  if (!$("tablaMisSolicitudes")) return;
  misSolicitudes = Array.isArray(lista) ? lista : [];

  const pendientes = misSolicitudes.filter((s) => s.estado === "pendiente").length;
  const aprobadas = misSolicitudes.filter((s) => s.estado === "aprobada").length;
  const rechazadas = misSolicitudes.filter((s) => s.estado === "rechazada").length;
  const acreditado = misSolicitudes
    .filter((s) => s.estado === "aprobada")
    .reduce((total, s) => total + Number(s.monto_autorizado || s.monto_creditado || 0), 0);

  if ($("resumenMisSolicitudes")) {
    $("resumenMisSolicitudes").innerHTML = `
      <div class="resumen-celda"><span>Pendientes</span><strong>${pendientes}</strong></div>
      <div class="resumen-celda"><span>Aprobadas</span><strong>${aprobadas}</strong></div>
      <div class="resumen-celda"><span>Rechazadas</span><strong>${rechazadas}</strong></div>
      <div class="resumen-celda"><span>Acreditado</span><strong>${dinero(acreditado)}</strong></div>`;
  }

  if ($("vacioMisSolicitudes")) {
    $("vacioMisSolicitudes").style.display = misSolicitudes.length ? "none" : "block";
  }

  $("tablaMisSolicitudes").innerHTML = misSolicitudes
    .map((s) => {
      const estado = estadoSolicitud(s.estado);
      const autorizado =
        s.monto_autorizado !== undefined && s.monto_autorizado !== null
          ? formatearBs(s.monto_autorizado)
          : s.estado === "pendiente"
            ? `<span class="pista">—</span>`
            : "—";
      let revision = "En espera de caja";
      if (s.estado === "rechazada") revision = s.motivo || "Rechazada por caja";
      else if (s.estado === "aprobada") revision = s.revisado_por ? `Aprobada por ${s.revisado_por}` : "Aprobada por caja";
      return `
        <tr>
          <td>${esc(s.numero)}</td>
          <td>${esc(s.fecha || "—")}<br><span class="pista">${esc(s.hora || "")}</span></td>
          <td class="num">${formatearBs(s.monto)}</td>
          <td class="num">${autorizado}</td>
          <td><span class="badge ${estado.clase}">${estado.texto}</span></td>
          <td>${esc(revision)}</td>
          <td>${
            s.tiene_archivo
              ? `<button class="btn-enlace" data-ver-mia="${esc(s.numero)}">Ver</button>`
              : `<span class="pista">sin imagen</span>`
          }</td>
        </tr>`;
    })
    .join("");
}

async function cargarMisSolicitudes() {
  if (!$("tablaMisSolicitudes")) return;
  const datos = await api("/api/mis-solicitudes");
  renderMisSolicitudes(datos.solicitudes || []);
}

async function abrirComprobanteDeSolicitud(solicitud) {
  if (!solicitud) return;
  if (solicitud.archivo) {
    abrirComprobante(solicitud.archivo);
    return;
  }
  try {
    const datos = await api(`/api/comprobantes/${encodeURIComponent(solicitud.numero)}`);
    if (datos && datos.archivo) abrirComprobante(datos.archivo);
    else mostrarToast("Sin comprobante", "Esa solicitud no guardó la imagen.", "err");
  } catch (error) {
    mostrarToast("No se pudo abrir", error.message, "err");
  }
}

// Resumen con quién envió, a quién pagó y la hora, para decidir rápido.
function detalleSolicitud(solicitud) {
  const analisis = analisisIA(solicitud);
  const verificacion = verificacionIA(solicitud);
  const esperadoPagador = pagadorEsperado(solicitud);
  const esperadoTitular = (solicitud.beneficiario_qr && solicitud.beneficiario_qr.nombre) || titularQr.nombre;
  const coincide = (leido, esperado) =>
    !leido || !esperado || normalizarTexto(leido) === normalizarTexto(esperado) ||
    normalizarTexto(esperado).includes(normalizarTexto(leido));
  const clase = (leido, esperado) => (!leido ? "neutro" : coincide(leido, esperado) ? "" : "alerta");

  let html =
    filaModal("Estudiante", `${solicitud.nombre} (${solicitud.curso})`) +
    filaModal("Monto solicitado", dinero(solicitud.monto)) +
    filaModal("Quién envía", analisis.pagador || "no se leyó", clase(analisis.pagador, esperadoPagador)) +
    filaModal("A quién pagó", analisis.receptor || "no se leyó", clase(analisis.receptor, esperadoTitular)) +
    filaModal(
      "Hora del comprobante",
      (verificacion && verificacion.momento && verificacion.momento.texto) ||
        [analisis.fecha, analisis.hora].filter(Boolean).join(" ") ||
        "no se leyó"
    );

  if (solicitud.nota) html += filaModal("Nota", solicitud.nota);

  if (analisis.sospechas) {
    html += filaModal("Revisión automática", analisis.sospechas, "alerta");
  } else if (verificacion && verificacion.alertas && verificacion.alertas.length) {
    html += filaModal("Revisión automática", verificacion.alertas.join("; "), "alerta");
  } else if (analisis.esComprobante && Number(analisis.monto) > 0) {
    html += filaModal("Revisión automática", `comprobante por ${dinero(analisis.monto)}`);
  } else {
    html += filaModal("Revisión automática", "no se reconoció un comprobante", "alerta");
  }

  return html;
}

// Vista rápida del análisis al tocar la miniatura del comprobante.
async function verDetalleSolicitud(solicitud) {
  const verificacion = verificacionIA(solicitud);
  const revision = verificacion
    ? `<ul class="revision-lista modal-revision">${verificacion.revisiones
        .map(
          (r) => `<li class="revision-fila revision-${r.estado}">
            <strong>${esc(r.etiqueta)}</strong>
            <span>${esc(r.detalle)}</span>
          </li>`
        )
        .join("")}</ul>`
    : "";

  await pedirConfirmacion({
    titulo: `Comprobante de ${solicitud.nombre}`,
    texto: verificacion ? verificacion.resumen : "",
    detalle: revision,
    aceptar: "Entendido",
  });
}

async function aprobarSolicitud(numero) {
  const solicitud = solicitudes.find((s) => s.numero === numero);
  if (!solicitud) return;

  const confirmacion = await pedirConfirmacion({
    titulo: "Aprobar la recarga",
    texto: `Revisa el comprobante y escribe el importe que se acreditará a ${solicitud.nombre}. No puede ser mayor al monto que declaró el estudiante.`,
    detalle:
      detalleSolicitud(solicitud) +
      filaModal("Monto declarado", dinero(solicitud.monto), "destacado"),
    campo: "monto_autorizado",
    valor: solicitud.monto,
    tipo: "number",
    inputMode: "decimal",
    placeholder: "Importe autorizado en Bs",
    aceptar: "Aprobar y acreditar",
  });
  if (!confirmacion) return;

  const montoAutorizado = Number(String(confirmacion).replace(",", "."));
  if (!Number.isFinite(montoAutorizado) || montoAutorizado <= 0) {
    mostrarToast("Importe inválido", "Escribe un importe mayor a 0.", "err");
    return;
  }
  if (montoAutorizado > Number(solicitud.monto) + 0.001) {
    mostrarToast(
      "Importe mayor al declarado",
      `El máximo para esta solicitud es ${dinero(solicitud.monto)}.`,
      "err"
    );
    return;
  }

  try {
    const resultado = await api("/api/solicitudes", {
      method: "POST",
      body: JSON.stringify({ numero, monto_autorizado: montoAutorizado }),
    });
    mensaje($("recargaMsg"), resultado.mensaje, true);
    mostrarToast("Recarga aprobada", resultado.mensaje, "ok");
    mostrarUltimo({ ...resultado, hora: new Date().toLocaleTimeString("es-VE") });
    await Promise.all([cargarSolicitudes(), cargarDatos()]);
  } catch (error) {
    mensaje($("recargaMsg"), error.message, false);
    mostrarToast("No se pudo aprobar", error.message, "err");
    await cargarSolicitudes().catch(() => {});
  }
}

async function rechazarSolicitud(numero) {
  const solicitud = solicitudes.find((s) => s.numero === numero);
  const motivo = await pedirConfirmacion({
    titulo: "¿Rechazar esta solicitud?",
    texto: solicitud
      ? `La solicitud de ${solicitud.nombre} por ${dinero(solicitud.monto)} no se aprobará.`
      : "",
    campo: "motivo",
    placeholder: "Ej: el comprobante no se lee",
    aceptar: "Rechazar",
    peligro: true,
  });
  if (!motivo) return;

  try {
    const resultado = await api("/api/solicitudes/rechazar", {
      method: "POST",
      body: JSON.stringify({ numero, motivo }),
    });
    mensaje($("recargaMsg"), resultado.mensaje, true);
    mostrarToast("Solicitud rechazada", resultado.mensaje, "info");
    await cargarSolicitudes();
  } catch (error) {
    mensaje($("recargaMsg"), error.message, false);
    mostrarToast("No se pudo rechazar", error.message, "err");
  }
}

/* ---------- Acciones admin ---------- */

async function accionRecargar() {
  const boton = $("btnRecargar");
  if (boton.disabled) return;

  const estudiante = estudianteSeleccionado();
  const monto = Number($("recargarMonto").value);
  const metodo = $("recargarMetodo").value || "manual";

  if (!estudiante) {
    mensaje($("recargaMsg"), "Selecciona un estudiante.", false);
    return;
  }
  if (!Number.isFinite(monto) || monto <= 0) {
    mensaje($("recargaMsg"), "Escribe un monto mayor a 0.", false);
    $("recargarMonto").focus();
    return;
  }

  const actual = Number(estudiante.saldo || 0);
  const confirmacion = await pedirConfirmacion({
    titulo: "¿Confirmar la recarga?",
    texto: `Se sumarán ${dinero(monto)} al saldo de ${estudiante.nombre}.`,
    detalle:
      filaModal("Estudiante", `${estudiante.nombre} (${estudiante.curso})`) +
      filaModal("Método", metodo) +
      filaModal("Saldo actual", dinero(actual)) +
      filaModal("Saldo nuevo", dinero(actual + monto), "destacado"),
    aceptar: "Confirmar",
  });
  if (!confirmacion) return;

  bloquear(boton, true, "Agregando…");
  try {
    const resultado = await api("/api/recargar", {
      method: "POST",
      body: JSON.stringify({ estudiante_id: estudiante.estudiante_id, monto, metodo }),
    });
    mensaje($("recargaMsg"), resultado.mensaje, true);
    mostrarToast("Saldo agregado", resultado.mensaje, "ok");
    mostrarUltimo({ ...resultado, hora: new Date().toLocaleTimeString("es-VE") });
    await cargarDatos();
  } catch (error) {
    mensaje($("recargaMsg"), error.message, false);
    mostrarToast("No se pudo agregar el saldo", error.message, "err");
  } finally {
    bloquear(boton, false);
  }
}

/* ---------- Alta de estudiantes (administrador) ---------- */

function alternarNuevoEstudiante() {
  const cuerpo = $("nuevoEstudianteCuerpo");
  const estabaOculto = cuerpo.classList.contains("oculto");
  cuerpo.classList.toggle("oculto", !estabaOculto);
  $("btnNuevoEstudiante").textContent = estabaOculto ? "Cerrar" : "＋ Nuevo";
  if (estabaOculto) $("nuevoNombre").focus();
}

async function accionCrearEstudiante() {
  const boton = $("btnCrearEstudiante");
  const nombre = $("nuevoNombre").value.trim();
  if (!nombre) {
    mensaje($("nuevoEstudianteMsg"), "Escribe el nombre del estudiante.", false);
    $("nuevoNombre").focus();
    return;
  }

  const cuerpo = {
    nombre,
    curso: $("nuevoCurso").value.trim(),
    estudiante_id: $("nuevoId").value.trim(),
    rfid: $("nuevoRfid").value.trim(),
    password: $("nuevoPassword").value,
  };

  bloquear(boton, true, "Creando…");
  try {
    const resultado = await api("/api/estudiantes", {
      method: "POST",
      body: JSON.stringify(cuerpo),
    });
    mensaje($("nuevoEstudianteMsg"), resultado.mensaje, true);
    mostrarToast("Estudiante creado", `Su contraseña es "${resultado.password}".`, "ok");
    ["nuevoNombre", "nuevoCurso", "nuevoId", "nuevoRfid", "nuevoPassword"].forEach((id) => {
      $(id).value = "";
    });
    await cargarDatos();
  } catch (error) {
    mensaje($("nuevoEstudianteMsg"), error.message, false);
    mostrarToast("No se pudo crear", error.message, "err");
  } finally {
    bloquear(boton, false);
  }
}

async function accionAsignarTarjeta(estudianteId) {
  const estudiante = estudiantes.find((e) => e.estudiante_id === estudianteId);
  const actuales = [estudiante && estudiante.rfid, estudiante && estudiante.rfid_alt]
    .map((valor) => String(valor === undefined || valor === null ? "" : valor).trim())
    .filter(Boolean);
  const uid = await pedirConfirmacion({
    titulo: "Asignar tarjeta",
    texto: `Acerca el carnet al lector o escribe su UID para ${estudiante ? estudiante.nombre : "el estudiante"}.${
      actuales.length ? " Si ya tiene una, se guarda como segunda tarjeta." : ""
    }`,
    campo: "uid",
    placeholder: actuales.length ? `Actual: ${actuales.join(" / ")}` : "UID de la tarjeta",
    aceptar: "Asignar",
  });
  if (!uid) return;
  try {
    const resultado = await api("/api/estudiantes/tarjeta", {
      method: "POST",
      body: JSON.stringify({ estudiante_id: estudianteId, uid }),
    });
    mostrarToast("Tarjeta asignada", resultado.mensaje, "ok");
    await cargarDatos();
  } catch (error) {
    mostrarToast("No se pudo asignar", error.message, "err");
  }
}

async function accionGuardarPrecio() {
  const precio = Number($("configPrecio").value);
  if (!Number.isFinite(precio) || precio < 0) {
    mensaje($("configMsg"), "Ingresa un precio válido.", false);
    return;
  }
  const boton = $("btnGuardarPrecio");
  bloquear(boton, true, "Guardando…");
  try {
    const resultado = await api("/api/config", {
      method: "POST",
      body: JSON.stringify({ precio }),
    });
    precioAlmuerzo = Number(resultado.precio || 0);
    mensaje($("configMsg"), `Precio actualizado a ${dinero(resultado.precio)}.`);
    mostrarToast("Precio actualizado", `El almuerzo ahora cuesta ${dinero(resultado.precio)}.`, "ok");
    renderEstudiantes();
  } catch (error) {
    mensaje($("configMsg"), error.message, false);
  } finally {
    bloquear(boton, false);
  }
}

async function accionProbarUid() {
  const uid = $("uidManual").value.trim();
  if (!uid) return;
  try {
    const resultado = await api("/api/uid", {
      method: "POST",
      body: JSON.stringify({ uid }),
    });
    $("uidManual").value = "";
    mostrarUltimo(resultado);
  } catch (error) {
    mostrarUltimo({
      ok: false,
      evento: "ERROR",
      mensaje: error.message,
      hora: new Date().toLocaleTimeString("es-VE"),
    });
  }
}

/* ---------- Exportar CSV ---------- */

function exportarCSV() {
  const lista = filtrarTransacciones();
  if (lista.length === 0) {
    mostrarToast("Nada que exportar", "No hay transacciones con los filtros actuales.", "info");
    return;
  }

  const filas = [
    ["Nro", "Estudiante", "Curso", "Tipo", "Monto (Bs)", "Saldo anterior", "Saldo posterior", "Fecha", "Hora", "Metodo", "Origen", "Estado"],
    ...lista.map((t) => [
      t.numero,
      t.nombre,
      t.curso,
      t.tipo,
      t.tipo === "RECARGA" ? t.monto : t.precio,
      t.saldo_anterior,
      t.saldo_posterior,
      t.fecha,
      t.hora,
      t.metodo || "",
      t.origen || "",
      t.estado || "",
    ]),
  ];

  const csv =
    "\uFEFF" +
    filas
      .map((fila) =>
        fila.map((celda) => `"${String(celda ?? "").replace(/"/g, '""')}"`).join(",")
      )
      .join("\r\n");

  const enlace = document.createElement("a");
  const fecha = new Date().toISOString().slice(0, 10);
  enlace.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  enlace.download = `transacciones_comedor_${fecha}.csv`;
  enlace.click();
  URL.revokeObjectURL(enlace.href);
  mostrarToast("CSV exportado", `${lista.length} transacciones descargadas.`, "ok");
}

/* ---------- Huella dactilar y asistencia del lector ---------- */

function huellaDe(estudianteId) {
  return huellas.find((h) => h.estudiante_id === estudianteId) || null;
}

function renderHuellas() {
  const tabla = $("tablaHuellas");
  if (!tabla) return;

  const texto = ($("buscarHuella").value || "").trim().toLowerCase();
  const lista = estudiantes
    .filter(
      (e) =>
        !texto ||
        String(e.nombre || "").toLowerCase().includes(texto) ||
        String(e.curso || "").toLowerCase().includes(texto)
    )
    .sort((a, b) => String(a.nombre || "").localeCompare(String(b.nombre || "")));

  const registradas = huellas.filter((h) => h.estudiante_id).length;
  $("chipHuellas").textContent = `${registradas} ${registradas === 1 ? "registrada" : "registradas"}`;
  $("vacioHuellas").style.display = lista.length ? "none" : "block";

  tabla.innerHTML = lista
    .map((e) => {
      const huella = huellaDe(e.estudiante_id);
      const celda = huella
        ? `<span class="badge badge-huella">Ranura ${esc(String(huella.slot))}</span>`
        : `<span class="pista">sin registrar</span>`;
      const boton = huella
        ? `<button class="btn-enlace btn-peligro" data-quitar-huella="${esc(e.estudiante_id)}">Quitar</button>`
        : `<button class="btn-enlace" data-registrar-huella="${esc(e.estudiante_id)}">Registrar huella</button>`;
      return `
        <tr>
          <td>${esc(e.nombre)}</td>
          <td>${esc(e.curso)}</td>
          <td>${celda}</td>
          <td>${boton}</td>
        </tr>`;
    })
    .join("");
}

function renderSolicitudHuella() {
  const caja = $("solicitudHuella");
  if (!caja) return;
  const s = solicitudHuella;
  const activa = s && ["pendiente", "listo", "error"].includes(s.estado);
  if (!activa) {
    caja.classList.add("oculto");
    return;
  }

  const registrar = s.accion !== "borrar";
  let icono = "☝";
  let titulo = registrar ? `Guardando la huella de ${s.nombre || ""}` : `Borrando la huella de ${s.nombre || ""}`;
  let detalle = registrar
    ? "Pon el dedo en el sensor del comedor (dos veces, con la yema bien apoyada)."
    : "Esperando al sensor para borrar la huella…";

  // El lector publica el avance (poner el dedo, retirarlo...) y aqui se
  // muestra tal cual para que el alumno sepa cuando tiene que actuar.
  if (s.estado === "pendiente" && s.mensaje) {
    detalle = s.mensaje;
  }

  if (s.estado === "listo") {
    icono = "✓";
    titulo = registrar
      ? `Huella de ${s.nombre || ""} registrada`
      : `Huella de ${s.nombre || ""} eliminada`;
    detalle = registrar ? "Ya puede marcar su asistencia con el dedo." : "Listo.";
  } else if (s.estado === "error") {
    icono = "!";
    titulo = "No se pudo completar";
    detalle = s.mensaje || "Vuelve a intentarlo.";
  }

  caja.className = `aviso-huella ${s.estado === "listo" ? "ok" : s.estado === "error" ? "err" : ""}`;
  $("huellaIcono").textContent = icono;
  $("huellaTitulo").textContent = titulo;
  $("huellaDetalle").textContent = detalle;
}

async function cargarHuellas() {
  if (!$("tablaHuellas")) return;
  const datos = await api("/api/huellas");
  huellas = datos.huellas || [];
  solicitudHuella = datos.solicitud || null;
  renderHuellas();
  renderSolicitudHuella();
}

function detenerSondeoHuella() {
  if (sondeoHuella) {
    clearInterval(sondeoHuella);
    sondeoHuella = null;
  }
}

function iniciarSondeoHuella() {
  detenerSondeoHuella();
  let intentos = 0;
  sondeoHuella = setInterval(async () => {
    intentos += 1;
    let datos;
    try {
      datos = await api("/api/huellas/solicitud");
    } catch {
      detenerSondeoHuella();
      return;
    }
    solicitudHuella = datos.solicitud || null;
    renderSolicitudHuella();
    if (!solicitudHuella || solicitudHuella.estado !== "pendiente") {
      detenerSondeoHuella();
      cargarHuellas().catch(() => {});
      if (solicitudHuella && solicitudHuella.estado === "listo") {
        mostrarToast("Huella lista", `Los cambios quedaron guardados.`, "ok");
      }
    } else if (intentos >= 90) {
      // ~3 minutos sin respuesta del sensor: dejamos de insistir.
      detenerSondeoHuella();
    }
  }, 2000);
}

async function accionRegistrarHuella(estudianteId) {
  const estudiante = estudiantes.find((e) => e.estudiante_id === estudianteId);
  const confirmacion = await pedirConfirmacion({
    titulo: "Registrar huella",
    texto: `Vas a guardar la huella de ${estudiante ? estudiante.nombre : "este estudiante"} en el sensor del comedor. Debe poner el dedo cuando se lo indiques.`,
    aceptar: "Continuar",
  });
  if (!confirmacion) return;
  try {
    const resultado = await api("/api/huellas/solicitar", {
      method: "POST",
      body: JSON.stringify({ estudiante_id: estudianteId }),
    });
    solicitudHuella = resultado.solicitud || null;
    renderSolicitudHuella();
    mostrarToast("Registro de huella", resultado.mensaje, "info");
    iniciarSondeoHuella();
  } catch (error) {
    mostrarToast("No se pudo iniciar", error.message, "err");
  }
}

async function accionQuitarHuella(estudianteId) {
  const estudiante = estudiantes.find((e) => e.estudiante_id === estudianteId);
  const confirmacion = await pedirConfirmacion({
    titulo: "¿Quitar la huella?",
    texto: `${estudiante ? estudiante.nombre : "El estudiante"} ya no podrá marcar su asistencia con el dedo. Puedes registrarla de nuevo después.`,
    aceptar: "Quitar",
    peligro: true,
  });
  if (!confirmacion) return;
  try {
    const resultado = await api("/api/huellas/quitar", {
      method: "POST",
      body: JSON.stringify({ estudiante_id: estudianteId }),
    });
    mostrarToast("Huella eliminada", resultado.mensaje, "ok");
    await cargarHuellas().catch(() => {});
    iniciarSondeoHuella();
  } catch (error) {
    mostrarToast("No se pudo quitar", error.message, "err");
  }
}

async function accionCancelarHuella() {
  detenerSondeoHuella();
  try {
    await api("/api/huellas/cancelar", { method: "POST", body: JSON.stringify({}) });
  } catch {}
  solicitudHuella = null;
  renderSolicitudHuella();
  await cargarHuellas().catch(() => {});
}

function hoyISO() {
  const ahora = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${ahora.getFullYear()}-${pad(ahora.getMonth() + 1)}-${pad(ahora.getDate())}`;
}

async function cargarAsistencias(fecha) {
  if (!$("tablaAsistencias")) return;
  const dia = fecha || fechaAsistencia || hoyISO();
  fechaAsistencia = dia;
  if ($("fechaAsistencia")) $("fechaAsistencia").value = dia;
  const datos = await api(`/api/asistencias?fecha=${encodeURIComponent(dia)}`);
  renderAsistencias(datos);
}

function renderAsistencias(datos) {
  const lista = (datos && datos.asistencias) || [];
  const resumen = (datos && datos.resumen) || {};
  const total = Number((datos && datos.total_estudiantes) || 0);

  if ($("resumenAsistencia")) {
    const faltan = Math.max(0, total - Number(resumen.presentes || 0));
    $("resumenAsistencia").innerHTML = `
      <div class="resumen-celda"><span>Presentes</span><strong>${resumen.presentes || 0}</strong></div>
      <div class="resumen-celda"><span>Con entrada y salida</span><strong>${resumen.completas || 0}</strong></div>
      <div class="resumen-celda"><span>Sin salida aún</span><strong>${resumen.pendientes || 0}</strong></div>
      <div class="resumen-celda"><span>Sin llegar</span><strong>${faltan}</strong></div>`;
  }

  const cuerpo = $("tablaAsistencias");
  $("vacioAsistencias").style.display = lista.length ? "none" : "block";

  cuerpo.innerHTML = lista
    .map((a) => {
      const estId = a.estudiante_id || String(a.id || "").split("_")[0];
      const completa = Boolean(a.hora_salida);
      // Sólo administración puede corregir la asistencia manualmente.
      const accion = rol === "admin" && !completa
        ? `<button class="btn-enlace" data-asistencia="salida" data-est="${esc(estId)}">Marcar salida</button>`
        : "";
      const borrar = rol === "admin"
        ? `<button class="btn-enlace btn-peligro" data-borrar-asistencia="${esc(estId)}">Borrar</button>`
        : "";
      const celdaAccion = accion || borrar
        ? `<div class="fila-acciones">${accion}${borrar}</div>`
        : `<span class="pista">sólo lectura</span>`;
      return `
        <tr>
          <td>${esc(a.nombre)}</td>
          <td>${esc(a.curso)}</td>
          <td>${esc(a.hora_entrada || "—")}</td>
          <td>${esc(a.hora_salida || "—")}</td>
          <td><span class="badge ${completa ? "badge-recarga" : "badge-compra"}">${completa ? "COMPLETA" : "ENTRADA"}</span></td>
          <td>${celdaAccion}</td>
        </tr>`;
    })
    .join("");
}

async function accionMarcarAsistencia(estudianteId, accion) {
  try {
    const resultado = await api("/api/asistencias/registrar", {
      method: "POST",
      body: JSON.stringify({ estudiante_id: estudianteId, accion, fecha: fechaAsistencia }),
    });
    mostrarToast("Asistencia registrada", resultado.mensaje, "ok");
    await cargarAsistencias();
  } catch (error) {
    mostrarToast("No se pudo registrar", error.message, "err");
  }
}

async function accionBorrarAsistencia(estudianteId) {
  const confirmacion = await pedirConfirmacion({
    titulo: "¿Borrar el registro?",
    texto: "Se eliminará la entrada y la salida de ese estudiante para esa fecha.",
    aceptar: "Borrar",
    peligro: true,
  });
  if (!confirmacion) return;
  try {
    const resultado = await api("/api/asistencias/eliminar", {
      method: "POST",
      body: JSON.stringify({ estudiante_id: estudianteId, fecha: fechaAsistencia }),
    });
    mostrarToast("Registro borrado", resultado.mensaje, "ok");
    await cargarAsistencias();
  } catch (error) {
    mostrarToast("No se pudo borrar", error.message, "err");
  }
}

/* ---------- Pedidos del comedor (admin) ----------
 *
 * El lector (ESP32) deja los pedidos en Firestore: uno por estudiante y día.
 * Cuando el estudiante pasa la tarjeta queda registrado su pedido; cuando
 * vuelve a pasar la tarjeta y apoya el dedo, el servidor descuenta el saldo
 * y marca el pedido como pagado y recogido.
 */

const ESTADOS_PEDIDO = {
  PEDIDO: { texto: "Falta pagar", clase: "badge-compra" },
  PAGO_SOLICITADO: { texto: "Pagando…", clase: "badge-alerta" },
  PAGADO: { texto: "Pagado · por entregar", clase: "badge-recarga" },
  RECOGIDO: { texto: "Entregado", clase: "badge-ok" },
  SIN_SALDO: { texto: "Sin saldo", clase: "badge-alerta" },
  RECHAZADO: { texto: "Rechazado", clase: "badge-anulacion" },
  CANCELADO: { texto: "Cancelado", clase: "badge-anulacion" },
};

function estadoPedido(estado) {
  return ESTADOS_PEDIDO[estado] || { texto: estado || "—", clase: "badge-anulacion" };
}

function estudianteIdDePedido(pedido) {
  return String(pedido.estudiante_id || String(pedido.id || "").split("_")[0]);
}

function saldoDeEstudiante(estudianteId) {
  const encontrado = estudiantes.find(
    (e) => String(e.estudiante_id || e.id) === String(estudianteId)
  );
  if (!encontrado || encontrado.saldo === undefined || encontrado.saldo === null) return null;
  return Number(encontrado.saldo) || 0;
}

async function cargarPedidos(fecha) {
  if (!$("tablaPedidos")) return;
  const dia = fecha || fechaPedidos || hoyISO();
  fechaPedidos = dia;
  if ($("fechaPedidos")) $("fechaPedidos").value = dia;
  const datos = await api(`/api/pedidos?fecha=${encodeURIComponent(dia)}`);
  renderPedidos(datos);
}

function renderPedidos(datos) {
  const lista = (datos && datos.pedidos) || [];
  const resumen = (datos && datos.resumen) || {};
  // Se guarda la lista para poder poner el nombre del alumno en las
  // confirmaciones de cobro, cancelación y entrega.
  pedidos = lista;
  const esCaja = rol === "admin" || rol === "caja";
  const puedeEntregar = rol === "admin" || rol === "cocinera";

  if ($("resumenPedidos")) {
    $("resumenPedidos").innerHTML = `
      <div class="resumen-celda"><span>Pedidos registrados</span><strong>${resumen.total || 0}</strong></div>
      <div class="resumen-celda"><span>Faltan por pagar</span><strong>${resumen.pendientes || 0}</strong></div>
      <div class="resumen-celda"><span>Pagando ahora</span><strong>${resumen.solicitados || 0}</strong></div>
      <div class="resumen-celda"><span>Por entregar</span><strong>${resumen.por_entregar || 0}</strong></div>
      <div class="resumen-celda"><span>Entregados</span><strong>${resumen.entregados || 0}</strong></div>
      <div class="resumen-celda"><span>Sin saldo</span><strong>${resumen.sin_saldo || 0}</strong></div>`;
  }

  const cuerpo = $("tablaPedidos");
  $("vacioPedidos").style.display = lista.length ? "none" : "block";

  renderEntregas(lista);
  renderMiniPedidos(datos);
  renderResumenOperativo();

  cuerpo.innerHTML = lista
    .map((p) => {
      const estId = estudianteIdDePedido(p);
      const info = estadoPedido(p.estado);
      const saldo = saldoDeEstudiante(estId);
      // El lector no sabe el precio: si el pedido aún no se cobró, se muestra
      // el precio configurado del almuerzo. Cocina no recibe estos datos.
      const monto = Number(p.monto || p.precio || precioAlmuerzo || 0) || 0;
      const nota = p.mensaje ? `<br><span class="pista">${esc(p.mensaje)}</span>` : "";

      let accion = "";
      if (esCaja && (p.estado === "PEDIDO" || p.estado === "SIN_SALDO")) {
        accion += `<button class="btn-enlace" data-cobrar-pedido="${esc(estId)}">Cobrar</button>`;
      }
      if (puedeEntregar && p.estado === "PAGADO") {
        accion += `<button class="btn-enlace" data-entregar-pedido="${esc(estId)}">Entregar</button>`;
      }
      if (esCaja && ["PEDIDO", "SIN_SALDO", "PAGO_SOLICITADO", "RECHAZADO"].includes(p.estado)) {
        accion += `<button class="btn-enlace btn-peligro" data-cancelar-pedido="${esc(estId)}">Cancelar</button>`;
      }
      if (!accion) {
        accion =
          p.estado === "RECOGIDO"
            ? `<span class="badge badge-ok">Entregado</span>`
            : p.estado === "PAGADO"
              ? `<span class="pista">Listo para cocina</span>`
              : `<span class="pista">En preparación</span>`;
      }

      return `
        <tr>
          <td>${esc(p.hora_pedido || "—")}</td>
          <td>${esc(p.nombre)}${nota}</td>
          <td>${esc(p.curso)}</td>
          <td><span class="badge ${info.clase}">${esc(info.texto)}</span></td>
          <td class="num solo-caja">${esCaja && monto ? formatearBs(monto) : "—"}</td>
          <td class="num solo-caja">${esCaja && saldo !== null ? formatearBs(saldo) : "—"}</td>
          <td><div class="fila-acciones">${accion}</div></td>
        </tr>`;
    })
    .join("");
}

async function accionCobrarPedido(estudianteId) {
  const pedido = pedidos.find((p) => estudianteIdDePedido(p) === String(estudianteId));
  const nombre = pedido ? pedido.nombre : "el estudiante";
  const confirmacion = await pedirConfirmacion({
    titulo: "¿Cobrar este pedido?",
    texto: `Se descontará el precio del almuerzo del saldo de ${nombre}. El pedido quedará pagado y pendiente de entrega en cocina.`,
    aceptar: "Cobrar",
  });
  if (!confirmacion) return;
  try {
    const resultado = await api("/api/pedidos/cobrar", {
      method: "POST",
      body: JSON.stringify({ estudiante_id: estudianteId, fecha: fechaPedidos }),
    });
    mostrarToast("Pedido cobrado", resultado.mensaje, "ok");
    await Promise.all([cargarPedidos(), cargarDatos()]);
  } catch (error) {
    mostrarToast("No se pudo cobrar", error.message, "err");
  }
}

// Confirma la entrega de un pedido ya pagado. No descuenta saldo: el cobro se
// hizo antes desde caja o con el lector. La marca de entrega del servidor evita
// que dos clics registren la misma entrega dos veces.
async function accionEntregarPedido(estudianteId) {
  const pedido = pedidos.find((p) => estudianteIdDePedido(p) === String(estudianteId));
  const nombre = pedido ? pedido.nombre : "el estudiante";
  const confirmacion = await pedirConfirmacion({
    titulo: "¿Confirmar la entrega?",
    texto: `Se marcará el almuerzo de ${nombre} como entregado. Esta acción no vuelve a cobrar.`,
    aceptar: "Confirmar entrega",
  });
  if (!confirmacion) return;
  try {
    const resultado = await api("/api/pedidos/entregar", {
      method: "POST",
      body: JSON.stringify({ estudiante_id: estudianteId, fecha: fechaPedidos || hoyISO() }),
    });
    mostrarToast("Entrega confirmada", resultado.mensaje, "ok");
    await cargarPedidos();
  } catch (error) {
    mostrarToast("No se pudo entregar", error.message, "err");
    await cargarPedidos().catch(() => {});
  }
}

async function accionCancelarPedido(estudianteId) {
  const pedido = pedidos.find((p) => estudianteIdDePedido(p) === String(estudianteId));
  const nombre = pedido ? pedido.nombre : "el estudiante";
  const confirmacion = await pedirConfirmacion({
    titulo: "¿Cancelar este pedido?",
    texto: `El pedido de ${nombre} se marcará como cancelado. No se cobra nada.`,
    aceptar: "Cancelar pedido",
    peligro: true,
  });
  if (!confirmacion) return;
  try {
    const resultado = await api("/api/pedidos/cancelar", {
      method: "POST",
      body: JSON.stringify({ estudiante_id: estudianteId, fecha: fechaPedidos }),
    });
    mostrarToast("Pedido cancelado", resultado.mensaje, "ok");
    await cargarPedidos();
  } catch (error) {
    mostrarToast("No se pudo cancelar", error.message, "err");
  }
}

function avisarPedido(datos) {
  if (!datos) return;
  if (datos.estado === "NUEVO") {
    mostrarToast("Nuevo pedido", datos.mensaje || `${datos.nombre} pidió su almuerzo.`, "info");
  } else if (datos.estado === "PAGADO") {
    mostrarToast("Pedido pagado", datos.mensaje || `${datos.nombre} ya pagó su almuerzo.`, "ok");
  } else if (datos.estado === "RECOGIDO") {
    mostrarToast("Entrega confirmada", datos.mensaje || `${datos.nombre} retiró su almuerzo.`, "ok");
  } else {
    mostrarToast("Pedido", datos.mensaje || datos.nombre || "", "err");
  }
}

/* ---------- Inicialización ---------- */

function registrarEventos() {
  $("btnEntrarUsuario").addEventListener("click", entrarUsuario);
  $("loginNombre").addEventListener("keydown", (e) => {
    if (e.key === "Enter") entrarUsuario();
  });
  $("loginPassword").addEventListener("keydown", (e) => {
    if (e.key === "Enter") entrarUsuario();
  });

  $("btnMostrarAdmin").addEventListener("click", mostrarAccesoAdmin);
  $("btnVolverUsuario").addEventListener("click", ocultarAccesoAdmin);
  $("btnEntrarAdmin").addEventListener("click", entrarAdmin);
  $("passwordAdmin").addEventListener("keydown", (e) => {
    if (e.key === "Enter") entrarAdmin();
  });

  $("btnCerrarSesion").addEventListener("click", accionCerrarSesion);
  $("btnCerrarSesionUsuario").addEventListener("click", accionCerrarSesion);
  $("btnAbrirAdmin").addEventListener("click", () => abrirPestana(RUTAS.admin));
  $("btnAbrirAlumno").addEventListener("click", () => abrirPestana(RUTAS.alumno));

  // Barra lateral: cada enlace abre su módulo según el rol.
  document.querySelectorAll(".sidebar-nav-link[data-modulo]").forEach((enlace) => {
    enlace.addEventListener("click", () => mostrarModulo(enlace.dataset.modulo));
  });
  on("sidebarInicio", "click", irAInicio);
  on("sidebarAdmin", "click", irAAdmin);
  on("sidebarAlumno", "click", irAAlumno);
  on("sidebarCerrarSesion", "click", accionCerrarSesion);

  // Atajos "Ver todos" y tarjetas de acceso rápido.
  document.querySelectorAll("[data-ir-modulo]").forEach((boton) => {
    boton.addEventListener("click", () => irAModulo(boton.dataset.irModulo));
  });

  // Menú móvil.
  on("btnMenu", "click", abrirSidebarMovil);
  on("sidebarClose", "click", cerrarSidebarMovil);
  on("sidebarBackdrop", "click", cerrarSidebarMovil);

  // Selector de perfil del login de administración.
  document.querySelectorAll(".perfil-btn").forEach((boton) => {
    boton.addEventListener("click", () => seleccionarPerfil(boton.dataset.perfil, boton));
  });
  if ($("perfilAdmin")) {
    const perfilInicial = $("perfilAdmin").value || "admin";
    document.querySelectorAll(".perfil-btn").forEach((boton) => {
      boton.classList.toggle("activo", boton.dataset.perfil === perfilInicial);
    });
  }

  // Filtros de período de la asistencia del estudiante.
  document.querySelectorAll(".filtro-periodo").forEach((boton) => {
    boton.addEventListener("click", () => {
      periodoAsistencia = boton.dataset.periodo || "dia";
      document.querySelectorAll(".filtro-periodo").forEach((b) => {
        b.classList.toggle("activo", b.dataset.periodo === periodoAsistencia);
      });
      renderMiAsistencia(miAsistenciaCache);
    });
  });

  $("btnPagar").addEventListener("click", accionPagar);
  $("btnIrARecarga").addEventListener("click", abrirPanelRecarga);
  $("btnToggleRecarga").addEventListener("click", accionToggleRecarga);
  $("btnEnviarComprobante").addEventListener("click", accionEnviarComprobante);
  $("recargaArchivo").addEventListener("change", (e) => {
    const archivo = e.target.files[0];
    const problema = comprobarArchivo(archivo);
    if (problema) {
      limpiarArchivo();
      mensaje($("comprobanteMsg"), problema, false);
      return;
    }
    previsualizarArchivo(archivo);
  });
  $("btnQuitarArchivo").addEventListener("click", limpiarArchivo);
  $("qrImagen").addEventListener("click", () => abrirComprobante($("qrImagen").src));

  const zona = $("zonaSoltar");
  zona.addEventListener("click", () => $("recargaArchivo").click());
  zona.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      $("recargaArchivo").click();
    }
  });
  ["dragenter", "dragover"].forEach((evento) => {
    zona.addEventListener(evento, (e) => {
      e.preventDefault();
      zona.classList.add("arrastrando");
    });
  });
  ["dragleave", "dragend"].forEach((evento) => {
    zona.addEventListener(evento, () => zona.classList.remove("arrastrando"));
  });
  zona.addEventListener("drop", (e) => {
    e.preventDefault();
    zona.classList.remove("arrastrando");
    const archivo = e.dataTransfer?.files?.[0];
    const problema = comprobarArchivo(archivo);
    if (problema) {
      mensaje($("comprobanteMsg"), problema, false);
      return;
    }
    if (e.dataTransfer) {
      e.dataTransfer.items.clear();
    }
    const destino = new DataTransfer();
    destino.items.add(archivo);
    $("recargaArchivo").files = destino.files;
    previsualizarArchivo(archivo);
  });

  $("btnRecargar").addEventListener("click", accionRecargar);
  $("recargarMonto").addEventListener("input", actualizarResumenRecarga);
  $("recargarEstudiante").addEventListener("change", actualizarResumenRecarga);
  $("buscarRecarga").addEventListener("input", renderSelectorRecarga);
  $("btnGuardarPrecio").addEventListener("click", accionGuardarPrecio);
  $("btnGuardarTitular").addEventListener("click", guardarTitular);
  $("btnLeerQr").addEventListener("click", leerQrConIa);
  $("btnProbarUid").addEventListener("click", accionProbarUid);
  $("btnExportar").addEventListener("click", exportarCSV);

  $("uidManual").addEventListener("keydown", (e) => {
    if (e.key === "Enter") accionProbarUid();
  });

  $("tablaEstudiantes").addEventListener("click", (e) => {
    const pagador = e.target.closest("[data-pagador]");
    if (pagador) {
      guardarPagador(pagador.dataset.pagador);
      return;
    }
    const tarjeta = e.target.closest("[data-tarjeta]");
    if (tarjeta) {
      accionAsignarTarjeta(tarjeta.dataset.tarjeta);
      return;
    }
    const boton = e.target.closest("[data-recargar]");
    if (!boton) return;
    $("buscarRecarga").value = "";
    renderSelectorRecarga();
    $("recargarEstudiante").value = boton.dataset.recargar;
    actualizarResumenRecarga();
    mostrarModulo("admin-saldos", { silencioso: true });
    $("recargarMonto").focus();
    $("recargarMonto").scrollIntoView({ behavior: "smooth", block: "center" });
  });

  $("btnNuevoEstudiante").addEventListener("click", alternarNuevoEstudiante);
  $("btnCrearEstudiante").addEventListener("click", accionCrearEstudiante);
  ["nuevoNombre", "nuevoCurso", "nuevoId", "nuevoRfid", "nuevoPassword"].forEach((id) => {
    $(id).addEventListener("keydown", (e) => {
      if (e.key === "Enter") accionCrearEstudiante();
    });
  });

  document.querySelectorAll(".sub-pestana").forEach((boton) => {
    boton.addEventListener("click", () => mostrarSubPestana(boton.dataset.tab));
  });

  $("tablaTransacciones").addEventListener("click", (e) => {
    const boton = e.target.closest("[data-revertir]");
    if (boton) revertirTransaccion(boton.dataset.revertir);
  });

  $("tablaSolicitudes").addEventListener("click", (e) => {
    const ver = e.target.closest("[data-ver]");
    if (ver) {
      const solicitud = solicitudes.find((s) => s.numero === ver.dataset.ver);
      if (solicitud) {
        // La imagen del comprobante pesa cientos de KB: en la nube no viene con
        // la lista, se pide cuando el administrador la abre.
        if (solicitud.archivo) {
          abrirComprobante(solicitud.archivo);
        } else {
          api(`/api/comprobantes/${encodeURIComponent(solicitud.numero)}`)
            .then((datos) => {
              if (datos && datos.archivo) abrirComprobante(datos.archivo);
              else mostrarToast("Sin comprobante", "Ese solicitud no guardó la imagen.", "err");
            })
            .catch(() =>
              mostrarToast("No se pudo abrir", "No se pudo leer el comprobante.", "err")
            );
        }
        verDetalleSolicitud(solicitud);
      }
      return;
    }
    const aprobar = e.target.closest("[data-numero]");
    if (aprobar) {
      aprobarSolicitud(aprobar.dataset.numero);
      return;
    }
    const rechazar = e.target.closest("[data-rechazar]");
    if (rechazar) rechazarSolicitud(rechazar.dataset.rechazar);
  });

  // Filtros del listado de comprobantes y seguimiento del alumno.
  on("filtroEstadoSolicitud", "change", renderSolicitudes);
  on("buscarSolicitud", "input", renderSolicitudes);
  on("btnRefrescarMisSolicitudes", "click", () => {
    cargarMisSolicitudes().catch(() =>
      mostrarToast("No se pudo actualizar", "Revisa la conexión e inténtalo de nuevo.", "err")
    );
  });

  $("tablaMisSolicitudes").addEventListener("click", (e) => {
    const ver = e.target.closest("[data-ver-mia]");
    if (!ver) return;
    const solicitud = misSolicitudes.find((s) => String(s.numero) === String(ver.dataset.verMia));
    if (solicitud) abrirComprobanteDeSolicitud(solicitud);
    else mostrarToast("No encontrada", "Actualiza la lista e inténtalo otra vez.", "err");
  });

  document.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip-btn");
    if (!chip) return;
    const grupo = chip.closest(".chips-monto");
    const input = $(grupo.dataset.input);
    input.value = chip.dataset.monto;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
    marcarChips(grupo, chip.dataset.monto);
  });

  document.querySelectorAll(".chips-monto").forEach((grupo) => {
    const input = $(grupo.dataset.input);
    const alCambiar = () => marcarChips(grupo, input.value);
    input.addEventListener("input", alCambiar);
    input.addEventListener("change", alCambiar);
    alCambiar();
  });

  $("modalAceptar").addEventListener("click", aceptarModal);
  $("modalCancelar").addEventListener("click", () => cerrarModal(false));
  $("modalOverlay").addEventListener("click", (e) => {
    if (e.target === $("modalOverlay")) cerrarModal(false);
  });
  $("modalCampo").addEventListener("keydown", (e) => {
    if (e.key === "Enter") aceptarModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!$("modalOverlay").classList.contains("oculto")) cerrarModal(false);
      else if (!$("lightbox").classList.contains("oculto")) cerrarComprobante();
    }
  });

  $("lightbox").addEventListener("click", (e) => {
    if (e.target === $("lightbox") || e.target === $("lightboxCerrar")) cerrarComprobante();
  });

  for (const id of ["filtroTipo", "filtroDesde", "filtroHasta", "filtroTexto"]) {
    $(id).addEventListener("input", renderTransacciones);
  }
  $("buscarEstudiante").addEventListener("input", renderEstudiantes);

  $("buscarHuella").addEventListener("input", renderHuellas);
  $("btnCancelarHuella").addEventListener("click", accionCancelarHuella);
  $("fechaAsistencia").addEventListener("change", () => cargarAsistencias($("fechaAsistencia").value));

  $("tablaHuellas").addEventListener("click", (e) => {
    const registrar = e.target.closest("[data-registrar-huella]");
    if (registrar) {
      accionRegistrarHuella(registrar.dataset.registrarHuella);
      return;
    }
    const quitar = e.target.closest("[data-quitar-huella]");
    if (quitar) accionQuitarHuella(quitar.dataset.quitarHuella);
  });

  $("tablaAsistencias").addEventListener("click", (e) => {
    const marcar = e.target.closest("[data-asistencia]");
    if (marcar) {
      accionMarcarAsistencia(marcar.dataset.est, marcar.dataset.asistencia);
      return;
    }
    const borrar = e.target.closest("[data-borrar-asistencia]");
    if (borrar) accionBorrarAsistencia(borrar.dataset.borrarAsistencia);
  });

  $("tablaPedidos").addEventListener("click", (e) => {
    const cobrar = e.target.closest("[data-cobrar-pedido]");
    if (cobrar) {
      accionCobrarPedido(cobrar.dataset.cobrarPedido);
      return;
    }
    const entregar = e.target.closest("[data-entregar-pedido]");
    if (entregar) {
      accionEntregarPedido(entregar.dataset.entregarPedido);
      return;
    }
    const cancelar = e.target.closest("[data-cancelar-pedido]");
    if (cancelar) accionCancelarPedido(cancelar.dataset.cancelarPedido);
  });

  on("tablaEntregas", "click", (e) => {
    const entregar = e.target.closest("[data-entregar-pedido]");
    if (entregar) accionEntregarPedido(entregar.dataset.entregarPedido);
  });

  on("fechaPedidos", "change", () => cargarPedidos($("fechaPedidos").value).catch(() => {}));
  on("btnRefrescarPedidos", "click", () => cargarPedidos().catch(() => {}));
}

async function inicializar() {
  $("fechaActual").textContent = new Date().toLocaleDateString("es-VE", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  // La capa de datos decide si hay servidor Node detrás. En Firebase Hosting no
  // hay API ni sesiones firmadas, así que se bloquea el acceso administrativo y
  // se avisa en la interfaz antes de pintar el login.
  try {
    modoNubeActual = Boolean(window.ApiWeb && (await window.ApiWeb.esNube()));
  } catch {
    modoNubeActual = false;
  }
  if (modoNubeActual) configurarModoNube();

  cargarSesionGuardada();
  adoptarTokenDeUrl();
  if (modoNubeActual && esRolAdmin()) cerrarSesionLocal();
  registrarEventos();
  mostrarUltimo(null);

  // El precio se carga antes de pintar cualquier vista: sin él, el botón de
  // pago se mostraría deshabilitado y el saldo sin contexto.
  await cargarConfig().catch(() => {});
  renderVistas();

  // Una pestaña abierta con #t=... puede traer un token caducado. La respuesta
  // confirma también el perfil real (admin, caja o cocinera).
  if (esRolAdmin()) {
    const sesion = await api("/api/admin/sesion").catch(() => ({ ok: false }));
    if (!sesion.ok) {
      cerrarSesionLocal();
      renderVistas();
    } else if (sesion.rol) {
      rol = sesion.rol;
      sessionStorage.setItem("comedor_rol", rol);
      actualizarSidebar();
      renderVistas();
    }
  }

  await cargarSugerencias();
  cargarEstado();

  setInterval(() => {
    const vista = vistaDeRuta();
    if (vista === "usuario") {
      cargarMiCuenta().catch(() => {});
      if (moduloActual === "est-asistencia") {
        cargarMiAsistencia().catch(() => {});
      }
      if (moduloActual === "est-solicitudes") {
        cargarMisSolicitudes().catch(() => {});
      }
    } else if (vista === "admin") {
      // Cada rol consulta solo lo que necesita. Cocina nunca llama a los
      // endpoints de caja (solicitudes, movimientos, último cobro).
      if (rol === "admin" || rol === "caja") {
        cargarDatos().catch(() => {});
        cargarSolicitudes().catch(() => {});
        cargarUltimo().catch(() => {});
      }
      if (rol === "admin") cargarHuellas().catch(() => {});
      // Al cerrar sesión la URL sigue en /admin, pero ya no hay credenciales:
      // no se deben seguir pidiendo asistencias ni pedidos protegidos.
      if (esRolAdmin()) {
        cargarAsistencias().catch(() => {});
        cargarPedidos().catch(() => {});
      }
    }
  }, 15000);
  setInterval(() => cargarEstado().catch(() => {}), 5000);
}

inicializar().catch((error) => {
  mostrarUltimo({
    ok: false,
    evento: "ERROR",
    mensaje: `No se pudo conectar con el servidor: ${error.message}`,
    hora: "",
  });
});
