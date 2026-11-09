/*
 * Widget de chat del agente de ventas.
 * Pégalo en cualquier página:
 *   <script src="https://TU-SERVIDOR/widget.js" data-color="#4f46e5" defer></script>
 */
(function () {
  if (window.__agenteSebax) return;
  window.__agenteSebax = true;

  var script = document.currentScript;
  var BASE = (script && script.src ? new URL(script.src).origin : location.origin);
  var COLOR = (script && script.getAttribute("data-color")) || "#4f46e5";
  var SALUDO = (script && script.getAttribute("data-saludo")) || "";

  function store(k, v) {
    try {
      if (v === undefined) return localStorage.getItem(k);
      localStorage.setItem(k, v);
    } catch (e) { return null; }
  }
  var sesion = store("agente_sesion");
  if (!sesion) {
    sesion = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2)).replace(/[^A-Za-z0-9_-]/g, "");
    store("agente_sesion", sesion);
  }
  var ultimoId = 0, abierto = false, enviando = false, poll = null, info = { negocio: "", agente: "Asistente" };

  var css = "\
.as-btn{position:fixed;right:20px;bottom:20px;width:60px;height:60px;border-radius:50%;border:0;cursor:pointer;background:" + COLOR + ";color:#fff;box-shadow:0 6px 20px rgba(0,0,0,.25);z-index:2147483000;display:grid;place-items:center;transition:transform .15s}\
.as-btn:hover{transform:scale(1.06)}\
.as-badge{position:absolute;top:2px;right:2px;width:14px;height:14px;border-radius:50%;background:#ef4444;border:2px solid #fff;display:none}\
.as-panel{position:fixed;right:20px;bottom:92px;width:370px;max-width:calc(100vw - 32px);height:560px;max-height:calc(100vh - 120px);background:#fff;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.22);z-index:2147483000;display:none;flex-direction:column;overflow:hidden;font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1d2433}\
.as-panel.as-open{display:flex}\
.as-head{background:" + COLOR + ";color:#fff;padding:14px 16px;display:flex;align-items:center;gap:10px}\
.as-head b{display:block;font-size:15px}.as-head small{opacity:.85;font-size:12px}\
.as-x{margin-left:auto;background:none;border:0;color:#fff;font-size:22px;cursor:pointer;line-height:1}\
.as-msgs{flex:1;overflow-y:auto;padding:14px;background:#f6f7f9;display:flex;flex-direction:column;gap:8px}\
.as-m{max-width:85%;padding:9px 12px;border-radius:14px;white-space:pre-wrap;word-wrap:break-word}\
.as-m a{color:inherit;text-decoration:underline}\
.as-bot{background:#fff;align-self:flex-start;border-bottom-left-radius:4px;box-shadow:0 1px 2px rgba(0,0,0,.06)}\
.as-hum{background:#fff7e6;align-self:flex-start;border-bottom-left-radius:4px}\
.as-yo{background:" + COLOR + ";color:#fff;align-self:flex-end;border-bottom-right-radius:4px}\
.as-typing{align-self:flex-start;color:#6b7280;font-size:13px;padding:4px 6px}\
.as-form{display:flex;gap:8px;padding:10px;border-top:1px solid #e5e7eb;background:#fff}\
.as-form textarea{flex:1;resize:none;border:1px solid #d1d5db;border-radius:10px;padding:9px 10px;font:inherit;max-height:100px;outline-color:" + COLOR + "}\
.as-form button{border:0;border-radius:10px;background:" + COLOR + ";color:#fff;padding:0 14px;cursor:pointer;font-weight:600}\
.as-form button:disabled{opacity:.5;cursor:default}\
@media (max-width:480px){.as-panel{right:8px;left:8px;width:auto;bottom:84px;height:calc(100vh - 100px)}}";
  var style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  var btn = document.createElement("button");
  btn.className = "as-btn";
  btn.setAttribute("aria-label", "Abrir chat");
  btn.innerHTML = '<svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor"><path d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H8l-4 4V6a2 2 0 0 1 2-2z"/></svg><span class="as-badge"></span>';
  var panel = document.createElement("div");
  panel.className = "as-panel";
  panel.setAttribute("role", "dialog");
  panel.innerHTML =
    '<div class="as-head"><div><b class="as-name">Asistente</b><small>Respondemos al instante</small></div><button class="as-x" aria-label="Cerrar">×</button></div>' +
    '<div class="as-msgs" aria-live="polite"></div>' +
    '<form class="as-form"><textarea rows="1" placeholder="Escribe tu mensaje..." aria-label="Mensaje"></textarea><button type="submit">Enviar</button></form>';
  document.body.appendChild(btn);
  document.body.appendChild(panel);

  var msgs = panel.querySelector(".as-msgs");
  var form = panel.querySelector(".as-form");
  var input = form.querySelector("textarea");
  var sendBtn = form.querySelector("button");
  var badge = btn.querySelector(".as-badge");

  function esc(s) {
    return s.replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; });
  }
  function formato(t) {
    return esc(t)
      .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
      .replace(/(^|[\s(])\*(?!\s)([^*\n]+?)\*(?=[\s).,!?:;]|$)/g, "$1<b>$2</b>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/(^|[\s>])(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  }
  function agregar(rol, texto) {
    var d = document.createElement("div");
    d.className = "as-m " + (rol === "cliente" ? "as-yo" : rol === "humano" ? "as-hum" : "as-bot");
    d.innerHTML = formato(texto);
    msgs.appendChild(d);
    msgs.scrollTop = msgs.scrollHeight;
  }
  var typing = null;
  function escribiendo(on) {
    if (on && !typing) {
      typing = document.createElement("div");
      typing.className = "as-typing";
      typing.textContent = info.agente + " está escribiendo...";
      msgs.appendChild(typing);
      msgs.scrollTop = msgs.scrollHeight;
    } else if (!on && typing) { typing.remove(); typing = null; }
  }

  function traerNuevos(inicial) {
    return fetch(BASE + "/api/chat/mensajes?sesion=" + encodeURIComponent(sesion) + "&desde=" + ultimoId)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        (d.mensajes || []).forEach(function (m) {
          ultimoId = Math.max(ultimoId, m.id);
          if (inicial || m.rol !== "cliente") agregar(m.rol, m.texto);
          if (!inicial && !abierto && m.rol !== "cliente") badge.style.display = "block";
        });
        return d.mensajes || [];
      })
      .catch(function () { return []; });
  }

  function abrir() {
    abierto = true;
    panel.classList.add("as-open");
    badge.style.display = "none";
    input.focus();
  }
  function cerrar() { abierto = false; panel.classList.remove("as-open"); }
  btn.addEventListener("click", function () { abierto ? cerrar() : abrir(); });
  panel.querySelector(".as-x").addEventListener("click", cerrar);

  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
  });
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var texto = input.value.trim();
    if (!texto || enviando) return;
    enviando = true; sendBtn.disabled = true;
    input.value = "";
    agregar("cliente", texto);
    escribiendo(true);
    fetch(BASE + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sesion: sesion, mensaje: texto }),
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        escribiendo(false);
        if (!res.ok) return agregar("agente", res.d.error || "Hubo un problema, intenta de nuevo.");
        if (res.d.respuesta) agregar("agente", res.d.respuesta);
        ultimoId = Math.max(ultimoId, res.d.ultimoId || 0);
      })
      .catch(function () { escribiendo(false); agregar("agente", "No pude conectarme. Revisa tu conexión e intenta de nuevo."); })
      .then(function () { enviando = false; sendBtn.disabled = false; input.focus(); });
  });

  fetch(BASE + "/api/chat/info").then(function (r) { return r.json(); }).then(function (d) {
    info = d;
    panel.querySelector(".as-name").textContent = d.agente + " · " + d.negocio;
  }).catch(function () {});

  traerNuevos(true).then(function (lista) {
    if (!lista.length) {
      agregar("agente", SALUDO || "¡Hola! 👋 ¿En qué te puedo ayudar hoy?");
    }
  });
  // Mensajes proactivos (seguimientos, respuestas de un asesor humano).
  poll = setInterval(function () { if (!enviando) traerNuevos(false); }, 10000);
})();
