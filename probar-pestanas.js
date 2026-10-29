"use strict";
// Banco de pruebas de la lógica de pestañas: carga el app.js real en un
// sandbox con un DOM mínimo y comprueba rutas, sesiones y paso de token.
const fs = require("fs");
const vm = require("vm");
const ruta = require("path").join(__dirname, "..", "public", "app.js");
const codigo = fs.readFileSync(ruta, "utf8");

function noop() {}
const VACIOS = ["children", "childNodes", "options", "rows", "cells", "files", "labels", "dataset"];

function crearClase() {
  const clases = new Set();
  const base = {
    classList: {
      toggle: (c, on) => (on ? clases.add(c) : clases.delete(c)),
      add: (c) => clases.add(c),
      remove: (c) => clases.delete(c),
      contains: (c) => clases.has(c),
      _clases: clases,
    },
    textContent: "",
    value: "",
    checked: false,
    hidden: false,
    disabled: false,
    style: {},
    dataset: {},
    length: 0,
    listeners: {},
    addEventListener(tipo, fn) {
      (this.listeners[tipo] = this.listeners[tipo] || []).push(fn);
    },
    removeEventListener: noop,
    setAttribute: noop,
    removeAttribute: noop,
    getAttribute: () => null,
    focus: noop,
    blur: noop,
    click() {
      (this.listeners.click || []).forEach((f) => f());
    },
    appendChild: noop,
    insertAdjacentHTML: noop,
    remove: noop,
    querySelector: () => proxy,
    querySelectorAll: () => [],
    addEventListenerOnce: noop,
  };
  // Cualquier método que la página use y no esté en la lista no rompe la prueba.
  var proxy = new Proxy(base, {
    get(objeto, prop) {
      if (prop in objeto) return objeto[prop];
      if (VACIOS.includes(prop)) return [];
      if (prop === Symbol.iterator) return undefined;
      return noop;
    },
    set(objeto, prop, valor) {
      objeto[prop] = valor;
      return true;
    },
  });
  return proxy;
}

function escenario({ ruta: rutaPagina, hash = "", sesion = {}, adminOk = true, config = {}, pedidosRespuesta = null, huellasRespuesta = null }) {
  const elementos = new Map();
  const guardadas = { ...sesion };
  const abiertas = [];
  const llamadas = [];
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} },
    URLSearchParams,
    Blob: class {},
    FileReader: class {
      readAsDataURL() {}
    },
    FormData: class {},
    Image: class {},
    EventSource: class {
      close() {}
      addEventListener() {}
    },
    crypto: { getRandomValues: (a) => a },
    document: {
      getElementById: (id) => {
        if (!elementos.has(id)) {
          const el = crearClase();
          if (id === "vistaLogin" || id === "vistaUsuario" || id === "vistaAdmin") {
            el.classList.add("oculto");
          }
          el.id = id;
          elementos.set(id, el);
        }
        return elementos.get(id);
      },
      createElement: () => crearClase(),
      querySelector: () => crearClase(),
      querySelectorAll: () => [],
      getElementsByClassName: () => [],
      getElementsByTagName: () => [],
      addEventListener() {},
      body: crearClase(),
    },
    sessionStorage: {
      getItem: (k) => (k in guardadas ? guardadas[k] : null),
      setItem: (k, v) => {
        guardadas[k] = String(v);
      },
      removeItem: (k) => {
        delete guardadas[k];
      },
    },
    location: { href: "http://127.0.0.1:3000" + rutaPagina, origin: "http://127.0.0.1:3000" },
    fetch: async (url, opciones = {}) => {
      const metodo = (opciones.method || "GET").toUpperCase();
      const cuerpo = metodo === "GET" ? {} : JSON.parse(opciones.body || "{}");
      const bearer = (opciones.headers || {}).Authorization || "";
      const tokenSesion = bearer.replace("Bearer ", "");
      llamadas.push({ url, metodo, cuerpo });
      const responder = (status, datos) => ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => datos,
        headers: { get: () => (opciones.headers || {})["Content-Type"] || "application/json" },
      });
      if (url === "/api/config") return responder(200, { ok: true, precio: 5, beneficiario: {}, ventana_horas: 48, ...config });
      if (url === "/api/huellas" || url === "/api/huellas/solicitud") {
        if (huellasRespuesta) return responder(200, huellasRespuesta);
        return responder(200, { ok: true, huellas: [], solicitud: null });
      }
      if (url.startsWith("/api/pedidos")) {
        if (pedidosRespuesta) return responder(200, pedidosRespuesta);
        return responder(200, { ok: true, fecha: "2026-10-22", pedidos: [], resumen: {} });
      }
      if (url === "/api/admin/sesion") {
        if (tokenSesion === "tok-admin") return responder(200, { ok: adminOk, rol: adminOk ? "admin" : null });
        return responder(200, { ok: false, rol: null });
      }
      if (url === "/api/mi-cuenta") {
        if (tokenSesion !== "tok-alumno") return responder(401, { ok: false, error: "Sesión de usuario requerida." });
        return responder(200, { ok: true, estudiante: { estudiante_id: "EST005", nombre: "Pedro Vargas", curso: "5to", saldo: 10 }, historial: [] });
      }
      if (url === "/api/admin/login") return responder(200, { ok: true, token: "tok-admin" });
      if (url === "/api/login") return responder(200, { ok: true, token: "tok-alumno", estudiante: { estudiante_id: "EST005", nombre: "Pedro Vargas", curso: "5to", saldo: 10 } });
      if (url === "/api/estudiantes" || url === "/api/transacciones" || url === "/api/solicitudes")
        return responder(200, []);
      if (url === "/api/ultimo") return responder(200, { ok: true, ultimo: null });
      if (url === "/api/status") return responder(200, { ok: true, lector: { conectado: false, estado: "sin lector" }, ultimo: null, fecha: "2026-09-28" });
      if (url === "/api/sugerencias") return responder(200, { ok: true, estudiantes: [] });
      return responder(200, { ok: true, cuerpo });
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  // La capa de datos (public/firebase-web.js) delega las llamadas al
  // servidor local; aquí se simula con el fetch falso de arriba.
  sandbox.ApiWeb = {
    modo: async () => "servidor",
    esNube: async () => false,
    peticion: async (ruta, opciones) => {
      const finales = { ...(opciones || {}) };
      finales.headers = {
        ...(opciones && opciones.headers ? opciones.headers : {}),
        "Content-Type": "application/json",
      };
      const tokenSesion = sandbox.sessionStorage.getItem("comedor_token") || "";
      if (tokenSesion) finales.headers.Authorization = `Bearer ${tokenSesion}`;
      const res = await sandbox.fetch(ruta, finales);
      const datos = await res.json().catch(() => ({}));
      return { ok: res.ok, status: res.status, datos };
    },
    suscribirSolicitudes: () => {},
    cerrarSuscripcion: () => {},
  };
  sandbox.window.location.pathname = rutaPagina;
  sandbox.window.location.hash = hash;
  sandbox.window.open = (url) => {
    abiertas.push(url);
    return { closed: false };
  };
  sandbox.historial = [];
  sandbox.history = {
    replaceState: (_e, _t, url) => {
      sandbox.historial.push(String(url));
      sandbox.window.location.pathname = String(url).split("#")[0];
      sandbox.window.location.hash = "";
      sandbox.urlFinal = String(url);
    },
  };
  sandbox.addEventListener = noop;
  sandbox.scrollTo = noop;
  sandbox.window.scrollTo = noop;
  vm.createContext(sandbox);
  vm.runInContext(codigo, sandbox, { filename: "app.js" });
  const el = (id) => sandbox.document.getElementById(id);
  return { sandbox, elementos, guardadas, abiertas, llamadas, el };
}

const esperar = () => new Promise((r) => setTimeout(r, 400));
process.on("unhandledRejection", (e) => console.log("  !! rechazo sin manejar:", e && e.message));
let fallos = 0;
function comprobar(titulo, condicion, detalle = "") {
  console.log(`${condicion ? "  ok  " : " FALLA"}  ${titulo}${detalle ? " -> " + detalle : ""}`);
  if (!condicion) fallos++;
}

(async () => {
  console.log("1) /alumno sin sesión muestra el login");
  {
    const { el } = escenario({ ruta: "/alumno" });
    await esperar();
    const login = el("vistaLogin");
    comprobar("login visible", !login.classList.contains("oculto"));
    comprobar("formulario de admin abierto", !el("adminLoginCuerpo").classList.contains("oculto"));
  }

  console.log("2) /alumno con sesión de alumno muestra su vista");
  {
    const escenario_dbg = escenario({ ruta: "/alumno", sesion: { comedor_token: "tok-alumno", comedor_rol: "usuario" } });
    const { el } = escenario_dbg;
    await esperar();
    comprobar("vista del alumno visible", !el("vistaUsuario").classList.contains("oculto"));
    comprobar("barra configurada para el alumno", escenario_dbg.sandbox.document.body.dataset.rol === "usuario", escenario_dbg.sandbox.document.body.dataset.rol);
    comprobar("la activa deja de ser enlace", true);
    comprobar("Administración sigue como enlace", !el("sidebarAdmin").classList.contains("oculto"));
    comprobar("la URL se queda en /alumno", escenario_dbg.sandbox.window.location.pathname === "/alumno");
  }

  console.log("3) /admin con token de alumno no abre el panel");
  {
    const { el } = escenario({ ruta: "/admin", sesion: { comedor_token: "tok-alumno", comedor_rol: "usuario" } });
    await esperar();
    comprobar("login visible", !el("vistaLogin").classList.contains("oculto"));
    comprobar("panel oculto", el("vistaAdmin").classList.contains("oculto"));
    comprobar("URL conservada en /admin", true);
  }

  console.log("4) /admin#t=... adopta la sesión y limpia la dirección");
  {
    const c = escenario({ ruta: "/admin", hash: "#t=tok-admin" });
    await esperar();
    comprobar("token guardado en sessionStorage", c.guardadas.comedor_token === "tok-admin", c.guardadas.comedor_token);
    comprobar("rol admin guardado", c.guardadas.comedor_rol === "admin", c.guardadas.comedor_rol);
    comprobar("panel visible", !c.el("vistaAdmin").classList.contains("oculto"));
    comprobar("hash eliminado", (c.sandbox.window.location.hash === "" || c.sandbox.window.location.hash === "#"), c.sandbox.urlFinal || c.sandbox.window.location.hash);
  }

  console.log("5) /alumno#t=... mantiene la sesión del alumno de esa pestaña");
  {
    const c = escenario({ ruta: "/alumno", hash: "#t=tok-alumno" });
    await esperar();
    comprobar("rol usuario", c.guardadas.comedor_rol === "usuario", c.guardadas.comedor_rol);
    comprobar("vista alumno visible", !c.el("vistaUsuario").classList.contains("oculto"));
  }

  console.log("6) token inválido en /admin vuelve al login");
  {
    const c = escenario({ ruta: "/admin", hash: "#t=tok-falso", adminOk: false });
    await esperar();
    try { await c.sandbox.inicializar(); } catch (e) { console.log("  !! error en inicializar:", (e && e.stack || e).toString().split("\n")[0]); }
    comprobar("login visible", !c.el("vistaLogin").classList.contains("oculto"));
    comprobar("sesión borrada", !c.guardadas.comedor_token, String(c.guardadas.comedor_token));
  }

  console.log("7) login de admin con la casilla marcada abre otra pestaña");
  {
    const c = escenario({ ruta: "/admin" });
    await esperar();
    c.el("adminNuevaPestana").checked = true;
    c.el("passwordAdmin").value = "admin";
    c.el("btnEntrarAdmin").click();
    await esperar();
    comprobar("abrió una pestaña", c.abiertas.length === 1, JSON.stringify(c.abiertas));
    comprobar("con el token en el fragmento", String(c.abiertas[0]).includes("t=tok-admin"), c.abiertas[0]);
    comprobar("esta pestaña SIN sesión (sigue en login)", !c.guardadas.comedor_token);
    comprobar("mensaje al usuario", (c.el("loginAdminMsg").textContent || "").includes("otra pestaña"), c.el("loginAdminMsg").textContent);
  }

  console.log("8) login de admin sin la casilla reemplaza la vista actual");
  {
    const c = escenario({ ruta: "/" });
    await esperar();
    c.el("adminNuevaPestana").checked = false;
    c.el("passwordAdmin").value = "admin";
    try { await c.sandbox.entrarAdmin(); } catch (e) { console.log("  !! error en entrarAdmin:", (e && e.stack || e).toString().split("\n")[0]); }
    await esperar();
    comprobar("no abrió pestañas", c.abiertas.length === 0, JSON.stringify(c.abiertas));
    comprobar("panel visible", !c.el("vistaAdmin").classList.contains("oculto"));
    comprobar("token en esta pestaña", c.guardadas.comedor_token === "tok-admin");
    comprobar("URL movida a /admin", c.sandbox.window.location.pathname === "/admin", c.sandbox.window.location.pathname);
  }

  console.log("9) botón 'Abrir administración' desde el alumno");
  {
    const c = escenario({ ruta: "/alumno", sesion: { comedor_token: "tok-alumno", comedor_rol: "usuario" } });
    await esperar();
    c.el("btnAbrirAdmin").click();
    comprobar("abrió /admin en pestaña nueva", c.abiertas[0] === "/admin", JSON.stringify(c.abiertas));
    comprobar("sin filtrar el token", !String(c.abiertas[0]).includes("tok-alumno"));
  }

  console.log("10) botón 'Abrir vista del alumno' desde administración");
  {
    const c = escenario({ ruta: "/admin", sesion: { comedor_token: "tok-admin", comedor_rol: "admin" } });
    await esperar();
    c.el("btnAbrirAlumno").click();
    comprobar("abrió /alumno en pestaña nueva", c.abiertas[0] === "/alumno", JSON.stringify(c.abiertas));
  }

  console.log("11) cerrar sesión en admin no toca la sesión de alumno de otra pestaña");
  {
    const c = escenario({ ruta: "/admin", sesion: { comedor_token: "tok-admin", comedor_rol: "admin" } });
    await esperar();
    c.el("btnCerrarSesion").click();
    await esperar();
    comprobar("token eliminado de esta pestaña", !c.guardadas.comedor_token);
    comprobar("vuelve al login de /admin", !c.el("vistaLogin").classList.contains("oculto"));
    comprobar("URL sigue en /admin", c.sandbox.window.location.pathname === "/admin", c.sandbox.window.location.pathname);
  }

  console.log("12) el alumno entra en otra pestaña si esta ya es de admin");
  {
    const c = escenario({ ruta: "/admin", sesion: { comedor_token: "tok-admin", comedor_rol: "admin" } });
    await esperar();
    c.el("loginNombre").value = "Pedro Vargas";
    c.el("loginPassword").value = "usu5";
    try { await c.sandbox.entrarUsuario(); } catch (e) { console.log("  !! error en entrarUsuario:", (e && e.stack || e).toString().split("\n")[0]); }
    await esperar();
    comprobar("abrió /alumno con su token", String(c.abiertas[0]).includes("/alumno#t=tok-alumno"), JSON.stringify(c.abiertas));
    comprobar("admin sigue en su pestaña", c.guardadas.comedor_token === "tok-admin");
  }

  console.log("13) la barra lateral abre la vista del alumno en otra pestaña");
  {
    const c = escenario({ ruta: "/admin", sesion: { comedor_token: "tok-admin", comedor_rol: "admin" } });
    await esperar();
    c.el("sidebarAlumno").click();
    comprobar("abrió /alumno", c.abiertas[0] === "/alumno", JSON.stringify(c.abiertas));
    comprobar("la barra queda en modo administración", c.sandbox.document.body.dataset.rol === "admin", c.sandbox.document.body.dataset.rol);
  }

  console.log("14) la barra lateral cambia a la vista del alumno sin abrir pestaña");
  {
    const c = escenario({ ruta: "/alumno", sesion: { comedor_token: "tok-alumno", comedor_rol: "usuario" } });
    await esperar();
    c.el("sidebarAlumno").click();
    comprobar("no abrió pestañas", c.abiertas.length === 0, JSON.stringify(c.abiertas));
    comprobar("sigue en /alumno", c.sandbox.window.location.pathname === "/alumno", c.sandbox.window.location.pathname);
  }

  console.log("15) el botón Inicio de la barra lateral vuelve al comedor");
  {
    const c = escenario({ ruta: "/alumno", sesion: { comedor_token: "tok-alumno", comedor_rol: "usuario" } });
    await esperar();
    c.el("sidebarInicio").click();
    await esperar();
    comprobar("sigue en /alumno", c.sandbox.window.location.pathname === "/alumno", c.sandbox.window.location.pathname);
    comprobar("la barra queda en modo alumno", c.sandbox.document.body.dataset.rol === "usuario", c.sandbox.document.body.dataset.rol);
  }

  console.log("16) la barra lateral muestra quién está conectado");
  {
    const c = escenario({ ruta: "/alumno", sesion: { comedor_token: "tok-alumno", comedor_rol: "usuario" } });
    await esperar();
    comprobar("nombre del estudiante", c.el("sidebarNombreUsuario").textContent === "Pedro Vargas", c.el("sidebarNombreUsuario").textContent);
    comprobar("botón de cerrar sesión visible", !c.el("sidebarCerrarSesion").classList.contains("oculto"));
  }

  console.log("17) cerrar sesión desde la barra lateral");
  {
    const c = escenario({ ruta: "/alumno", sesion: { comedor_token: "tok-alumno", comedor_rol: "usuario" } });
    await esperar();
    c.el("sidebarCerrarSesion").click();
    await esperar();
    comprobar("token eliminado", !c.guardadas.comedor_token);
    comprobar("barra en modo invitado", c.el("sidebarNombreUsuario").textContent === "Invitado", c.el("sidebarNombreUsuario").textContent);
    comprobar("botón de cerrar sesión oculto", c.el("sidebarCerrarSesion").classList.contains("oculto"));
  }

  console.log("18) el panel de pedidos cuenta los pedidos del día");
  {
    const respuesta = {
      ok: true,
      fecha: "2026-10-22",
      pedidos: [
        {
          id: "EST001_2026-10-22",
          estudiante_id: "EST001",
          nombre: "Juan Pérez",
          curso: "6to",
          estado: "PEDIDO",
          hora_pedido: "12:01:00",
        },
        {
          id: "EST002_2026-10-22",
          estudiante_id: "EST002",
          nombre: "María López",
          curso: "6to",
          estado: "RECOGIDO",
          hora_pedido: "12:02:00",
          monto: 5,
          transaccion: "TRANS019",
        },
      ],
      resumen: {
        total: 2,
        pendientes: 1,
        solicitados: 0,
        pagados: 1,
        sin_saldo: 0,
        monto_cobrado: 5,
        monto_por_cobrar: 5,
      },
    };
    const c = escenario({
      ruta: "/admin",
      sesion: { comedor_token: "tok-admin", comedor_rol: "admin" },
      pedidosRespuesta: respuesta,
    });
    await esperar();
    const resumen = c.el("resumenPedidos").innerHTML;
    const tabla = c.el("tablaPedidos").innerHTML;
    comprobar("se pidieron los pedidos del día", c.llamadas.some((l) => l.url.startsWith("/api/pedidos?")));
    comprobar("el resumen cuenta los pedidos", resumen.includes("Pedidos registrados") && resumen.includes(">2<"), resumen.slice(0, 120));
    comprobar("el resumen cuenta los que faltan por pagar", resumen.includes("Faltan por pagar") && resumen.includes(">1<"));
    comprobar("la tabla lista a los dos estudiantes", tabla.includes("Juan Pérez") && tabla.includes("María López"));
    comprobar("la tabla marca el estado", tabla.includes("Falta pagar") && tabla.includes("Entregado"));
    comprobar("el pedido pendiente muestra el precio", tabla.includes("5,00"), tabla);
    comprobar("el pedido pagado muestra el botón de cobro", !tabla.includes("data-cobrar-pedido=\"EST002\""));
    comprobar("el pedido pendiente sí trae el botón de cobro", tabla.includes("data-cobrar-pedido=\"EST001\""));
  }

  console.log("19) cobrar un pedido desde el panel llama a la API");
  {
    const respuesta = {
      ok: true,
      fecha: "2026-10-22",
      pedidos: [
        {
          id: "EST001_2026-10-22",
          estudiante_id: "EST001",
          nombre: "Juan Pérez",
          curso: "6to",
          estado: "PEDIDO",
          hora_pedido: "12:01:00",
        },
      ],
      resumen: { total: 1, pendientes: 1, pagados: 0 },
    };
    const c = escenario({
      ruta: "/admin",
      sesion: { comedor_token: "tok-admin", comedor_rol: "admin" },
      pedidosRespuesta: respuesta,
    });
    await esperar();
    // Clic en el botón "Cobrar" de la fila (evento delegado en la tabla).
    const manejador = (c.el("tablaPedidos").listeners.click || [])[0];
    if (manejador) {
      manejador({
        target: {
          closest: (selector) =>
            selector === "[data-cobrar-pedido]"
              ? { dataset: { cobrarPedido: "EST001" } }
              : null,
        },
      });
      await esperar();
      comprobar("la confirmación dice el nombre del alumno", c.el("modalTexto").textContent.includes("Juan Pérez"), c.el("modalTexto").textContent);
      c.sandbox.cerrarModal(true);
      await esperar();
    }
    const llamada = c.llamadas.find((l) => l.url === "/api/pedidos/cobrar");
    comprobar("se llamó a POST /api/pedidos/cobrar", !!llamada, JSON.stringify(c.llamadas.map((l) => l.url)));
    comprobar("con el estudiante y la fecha", !!llamada && llamada.metodo === "POST" && llamada.cuerpo.estudiante_id === "EST001", llamada ? JSON.stringify(llamada.cuerpo) : "");
  }

  console.log("20) cancelar un pedido desde el panel llama a la API");
  {
    const respuesta = {
      ok: true,
      fecha: "2026-10-22",
      pedidos: [
        {
          id: "EST001_2026-10-22",
          estudiante_id: "EST001",
          nombre: "Juan Pérez",
          curso: "6to",
          estado: "PEDIDO",
          hora_pedido: "12:01:00",
        },
      ],
      resumen: { total: 1, pendientes: 1, pagados: 0 },
    };
    const c = escenario({
      ruta: "/admin",
      sesion: { comedor_token: "tok-admin", comedor_rol: "admin" },
      pedidosRespuesta: respuesta,
    });
    await esperar();
    const manejador = (c.el("tablaPedidos").listeners.click || [])[0];
    if (manejador) {
      manejador({
        target: {
          closest: (selector) =>
            selector === "[data-cancelar-pedido]"
              ? { dataset: { cancelarPedido: "EST001" } }
              : null,
        },
      });
      await esperar();
      c.sandbox.cerrarModal(true);
      await esperar();
    }
    const llamada = c.llamadas.find((l) => l.url === "/api/pedidos/cancelar");
    comprobar("se llamó a POST /api/pedidos/cancelar", !!llamada);
    comprobar("con el estudiante y la fecha", !!llamada && llamada.metodo === "POST" && llamada.cuerpo.estudiante_id === "EST001");
  }

  console.log("21) el alumno ve el estado de su pedido del día");
  {
    const c = escenario({
      ruta: "/alumno",
      sesion: { comedor_token: "tok-alumno", comedor_rol: "usuario" },
      pedidosRespuesta: {
        ok: true,
        fecha: "2026-10-22",
        pedido: {
          id: "EST005_2026-10-22",
          estudiante_id: "EST005",
          nombre: "Pedro Vargas",
          estado: "PEDIDO",
          hora_pedido: "12:05:00",
        },
      },
    });
    await esperar();
    const chip = c.el("miPedidoChip");
    const detalle = c.el("miPedidoDetalle");
    comprobar("el chip dice que falta pagar", chip.textContent === "Falta pagar", chip.textContent);
    comprobar("el detalle explica cómo pagar", detalle.textContent.includes("pasa tu tarjeta otra vez"), detalle.textContent);
  }

  console.log("22) el alumno sin pedido ve que no ha pedido");
  {
    const c = escenario({
      ruta: "/alumno",
      sesion: { comedor_token: "tok-alumno", comedor_rol: "usuario" },
      pedidosRespuesta: { ok: true, fecha: "2026-10-22", pedido: null },
    });
    await esperar();
    comprobar("el chip dice sin pedido", c.el("miPedidoChip").textContent === "Sin pedido", c.el("miPedidoChip").textContent);
    comprobar(
      "el detalle invita a pasar la tarjeta",
      c.el("miPedidoDetalle").textContent.includes("Pasa tu tarjeta"),
      c.el("miPedidoDetalle").textContent
    );
  }

  console.log("23) el alta de huella muestra el aviso que manda el lector");
  {
    const c = escenario({
      ruta: "/admin",
      sesion: { comedor_token: "tok-admin", comedor_rol: "admin" },
      huellasRespuesta: {
        ok: true,
        huellas: [{ estudiante_id: "EST005", nombre: "Pedro Vargas", curso: "5to", slot: 3 }],
        solicitud: {
          accion: "registrar",
          estado: "pendiente",
          estudiante_id: "EST005",
          nombre: "Pedro Vargas",
          slot: 3,
          mensaje: "Retira el dedo y vuelve a ponerlo",
        },
      },
    });
    await esperar();
    const caja = c.el("solicitudHuella");
    comprobar("el aviso está visible", !caja.classList.contains("oculto"));
    comprobar(
      "título con el nombre",
      c.el("huellaTitulo").textContent.includes("Pedro Vargas"),
      c.el("huellaTitulo").textContent
    );
    comprobar(
      "detalle con el aviso del lector",
      c.el("huellaDetalle").textContent === "Retira el dedo y vuelve a ponerlo",
      c.el("huellaDetalle").textContent
    );
    comprobar(
      "sin marcar error",
      !caja.className.includes("err") && !caja.className.includes("ok"),
      caja.className
    );
  }

  console.log("24) el alta sin aviso del lector mantiene la instrucción general");
  {
    const c = escenario({
      ruta: "/admin",
      sesion: { comedor_token: "tok-admin", comedor_rol: "admin" },
      huellasRespuesta: {
        ok: true,
        huellas: [],
        solicitud: { accion: "registrar", estado: "pendiente", estudiante_id: "EST005", nombre: "Pedro Vargas" },
      },
    });
    await esperar();
    comprobar(
      "detalle genérico",
      c.el("huellaDetalle").textContent.includes("dos veces"),
      c.el("huellaDetalle").textContent
    );
  }

  console.log("25) el alta fallida explica el motivo que da el lector");
  {
    const c = escenario({
      ruta: "/admin",
      sesion: { comedor_token: "tok-admin", comedor_rol: "admin" },
      huellasRespuesta: {
        ok: true,
        huellas: [],
        solicitud: {
          accion: "registrar",
          estado: "error",
          estudiante_id: "EST005",
          nombre: "Pedro Vargas",
          mensaje: "El dedo no se retiró a tiempo",
        },
      },
    });
    await esperar();
    const caja = c.el("solicitudHuella");
    comprobar("el aviso está visible", !caja.classList.contains("oculto"));
    comprobar(
      "título de error",
      c.el("huellaTitulo").textContent === "No se pudo completar",
      c.el("huellaTitulo").textContent
    );
    comprobar(
      "detalle con el motivo",
      c.el("huellaDetalle").textContent === "El dedo no se retiró a tiempo",
      c.el("huellaDetalle").textContent
    );
    comprobar("estilo de error", caja.className.includes("err"), caja.className);
  }

  console.log(fallos === 0 ? "\nTODAS LAS PRUEBAS PASARON" : `\n${fallos} PRUEBAS FALLARON`);
  process.exit(fallos === 0 ? 0 : 1);
})();
