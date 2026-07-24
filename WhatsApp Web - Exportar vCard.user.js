// ==UserScript==
// @name         WhatsApp Web - Exportar vCard
// @namespace    http://tampermonkey.net/
// @version      2026.07.23
// @description  Guarda contactos desde la vista de info de contacto como vCard (.vcf). Importar/exportar desde el menú Tampermonkey. Vista flotante editable, posición recordada, y resaltado en lista de chats.
// @author       wernser412
// @downloadURL  https://github.com/wernser412/WhatsApp-Web_Exportar-vCard/raw/refs/heads/main/WhatsApp%20Web%20-%20Exportar%20vCard.user.js
// @icon         https://github.com/wernser412/WhatsApp-Web_Exportar-vCard/blob/main/ICONO.png?raw=true
// @match        https://web.whatsapp.com/
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function () {
    'use strict';

    const STORAGE_KEY = 'contactosVCF';
    const POS_KEY = 'posVCF';

    const getContacts = () => GM_getValue(STORAGE_KEY, []);
    const setContacts = (list) => GM_setValue(STORAGE_KEY, list);

    const savePos = (x, y) => GM_setValue(POS_KEY, { x, y });
    const getPos = () => GM_getValue(POS_KEY, { x: 50, y: 50 });

    // Normaliza un número para comparar duplicados (ignora espacios/guiones)
    const normalizar = (num) => (num || '').replace(/[^\d+]/g, '');

    // WhatsApp suele envolver números y textos con marcas invisibles de dirección
    // de texto (LRM, RLM, LRE/PDF, etc.) que no se ven pero rompen comparaciones
    // exactas con regex. Las quitamos antes de evaluar cualquier texto.
    const limpiarInvisibles = (s) => (s || '')
        .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
        .trim();

    // Escapa texto según la RFC 6350 (vCard) para evitar archivos inválidos
    const escaparVCard = (texto) =>
        (texto || '')
            .replace(/\\/g, '\\\\')
            .replace(/;/g, '\\;')
            .replace(/,/g, '\\,')
            .replace(/\n/g, '\\n');

    GM_registerMenuCommand("📋 Ver vCard", togglePanel);
    GM_registerMenuCommand("📤 Exportar vCard", exportVCF);
    GM_registerMenuCommand("📥 Importar vCard", importVCF);
    GM_registerMenuCommand("🤖 Recorrer chats y guardar automático", recorrerYGuardarTodos);
    GM_registerMenuCommand("🗑️ Vaciar caché de mensajes recuperables", vaciarCacheMensajes);

    function esperar(condicionFn, timeoutMs = 4000, intervalMs = 150) {
        return new Promise((resolve) => {
            const inicio = Date.now();
            const check = () => {
                const resultado = condicionFn();
                if (resultado) return resolve(resultado);
                if (Date.now() - inicio > timeoutMs) return resolve(null);
                setTimeout(check, intervalMs);
            };
            check();
        });
    }
    const pausa = (ms) => new Promise((r) => setTimeout(r, ms));

    // Un .click() simple a veces no "despierta" los manejadores de eventos de WhatsApp
    // (es una app en React que a veces escucha pointerdown/mousedown en vez de solo click).
    // Disparamos la secuencia completa para que sea confiable.
    function simularClic(el) {
        if (!el) return;
        const opciones = { bubbles: true, cancelable: true };
        ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(tipo => {
            try {
                const EventClass = tipo.startsWith('pointer') && typeof PointerEvent !== 'undefined' ? PointerEvent : MouseEvent;
                el.dispatchEvent(new EventClass(tipo, opciones));
            } catch (e) {
                el.dispatchEvent(new MouseEvent(tipo, opciones));
            }
        });
    }

    // Recorre automáticamente los chats individuales visibles en la lista, abre
    // la ficha de "Datos del contacto" de cada uno, lee el número real (aunque
    // el contacto ya esté guardado en tu teléfono) y lo guarda. Detecta y salta
    // los grupos buscando el texto "N participantes" en el panel de info.
    async function recorrerYGuardarTodos() {
        const confirmado = confirm(
            "Esto va a recorrer automáticamente los chats visibles en tu lista (uno por uno), " +
            "abriendo cada ficha de contacto para leer su número. Puede tardar varios segundos/minutos " +
            "y vas a ver la pantalla cambiando de chat sola.\n\n" +
            "⚠️ Importante: si tenías mensajes sin leer en esos chats, al abrirlos se marcarán como " +
            "leídos (doble check azul), salvo que tengas desactivadas las confirmaciones de lectura.\n\n" +
            "¿Continuar?"
        );
        if (!confirmado) return;

        const totalFilas = document.querySelectorAll("div[data-testid='cell-frame-container']").length;
        if (!totalFilas) return alert("No se encontró ninguna lista de chats visible.");

        const contactos = getContacts();
        const existentes = new Set(contactos.map(c => normalizar(c.numero)));

        let guardados = 0, saltadosGrupo = 0, sinNumero = 0, procesados = 0;

        // Importante: WhatsApp recicla/reemplaza los elementos de la lista al re-renderizar,
        // así que NO guardamos un array fijo de filas al inicio (esas referencias quedan
        // "muertas" después del primer clic). En su lugar, volvemos a consultar el DOM
        // fresco en cada vuelta, por posición.
        for (let i = 0; i < totalFilas; i++) {
            const filasActuales = document.querySelectorAll("div[data-testid='cell-frame-container']");
            const fila = filasActuales[i];
            if (!fila) break;

            const nombreLista = fila.querySelector('span[title]')?.getAttribute('title')?.trim();
            if (!nombreLista) continue;

            try {
                const clicker = fila.closest("div[role='button']") || fila;
                simularClic(clicker);
                await pausa(200);

                // Esperamos a que el chat ABIERTO sea realmente el que corresponde a esta fila.
                // Usamos el contenedor completo del encabezado (no un span específico) porque
                // los grupos arman el encabezado con una estructura interna distinta.
                const tituloAbierto = await esperar(() => {
                    const contenedorInfo = document.querySelector('div[data-testid="conversation-info-header"]');
                    if (!contenedorInfo) return null;
                    const texto = limpiarInvisibles(contenedorInfo.innerText || '');
                    return texto.includes(limpiarInvisibles(nombreLista)) ? texto : null;
                }, 6000, 200);

                if (!tituloAbierto) {
                    console.warn('❌ No se pudo abrir (o confirmar) el chat:', nombreLista);
                    sinNumero++;
                    continue;
                }
                console.log('▶️ Procesando:', nombreLista);

                const headerInfo = document.querySelector('div[data-testid="conversation-info-header"]');
                if (!headerInfo) {
                    console.warn('❌ No se encontró el botón de info para:', nombreLista);
                    sinNumero++;
                    continue;
                }

                simularClic(headerInfo);

                const drawer = await esperar(() => {
                    const d = document.querySelector('div[data-testid="drawer-right"]');
                    const spans = d?.querySelectorAll('span.selectable-text.copyable-text');
                    return d && spans && spans.length > 0 ? d : null;
                }, 5000);

                procesados++;

                if (!drawer) {
                    console.warn('❌ El panel de info no cargó contenido para:', nombreLista);
                    sinNumero++;
                } else if (/\d+\s+participantes?/i.test(limpiarInvisibles(drawer.innerText))) {
                    console.log('👥 Detectado como grupo, saltado:', nombreLista);
                    saltadosGrupo++;
                } else {
                    const spanNumero = Array.from(drawer.querySelectorAll('span.selectable-text.copyable-text'))
                        .map(s => limpiarInvisibles(s.innerText))
                        .find(texto => /^\+\d[\d\s]{6,}$/.test(texto));

                    if (spanNumero) {
                        const numero = spanNumero;
                        const clave = normalizar(numero);
                        if (!existentes.has(clave)) {
                            contactos.push({ nombre: nombreLista, numero });
                            existentes.add(clave);
                            guardados++;
                            setContacts(contactos);
                            console.log('✅ Guardado:', nombreLista, numero);
                        } else {
                            console.log('ℹ️ Ya existía, se omite:', nombreLista, numero);
                        }
                    } else {
                        console.warn('❌ No se encontró número en el panel para:', nombreLista, '| texto del panel:', limpiarInvisibles(drawer.innerText).slice(0, 150));
                        sinNumero++;
                    }
                }

                const btnCerrar = drawer?.querySelector('button[aria-label="Cerrar"], button[aria-label="Close"]');
                if (btnCerrar) simularClic(btnCerrar);
                else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

                // Confirmamos que el panel realmente se cerró antes de seguir; si no,
                // el próximo clic en "info" lo cerraría en vez de abrirlo (es un botón
                // de alternar) y el siguiente chat quedaría sin procesar en silencio.
                const cerrado = await esperar(() => {
                    const d = document.querySelector('div[data-testid="drawer-right"]');
                    const spans = d?.querySelectorAll('span.selectable-text.copyable-text');
                    return (!spans || spans.length === 0) ? true : null;
                }, 2000);

                if (!cerrado) {
                    console.warn('⚠️ El panel no se cerró solo, forzando cierre para:', nombreLista);
                    simularClic(document.querySelector('div[data-testid="conversation-info-header"]'));
                    await pausa(400);
                }

                await pausa(400);
            } catch (err) {
                console.error('Error procesando fila:', nombreLista, err);
            }
        }

        setContacts(contactos);
        const area = document.querySelector("#panel-vcf textarea");
        if (area) area.value = contactos.map(c => `${c.nombre}: ${c.numero}`).join("\n");
        resaltar();

        alert(
            `✅ Listo.\n` +
            `Procesados: ${procesados}\n` +
            `Guardados nuevos: ${guardados}\n` +
            `Grupos saltados: ${saltadosGrupo}\n` +
            `Sin número detectado: ${sinNumero}\n\n` +
            `Nota: solo se recorrieron los chats cargados actualmente en la lista. ` +
            `Si tienes más, baja el scroll de la lista y vuelve a ejecutar este comando.`
        );
    }

    function exportVCF() {
        const contacts = getContacts();
        if (!contacts.length) return alert("No hay contactos guardados.");
        const vcf = contacts.map(({ nombre, numero }) =>
            `BEGIN:VCARD\nVERSION:3.0\nFN:${escaparVCard(nombre)}\nTEL;TYPE=CELL:${numero}\nEND:VCARD`
        ).join("\n");
        // BOM para que Excel/algunos lectores respeten acentos y ñ correctamente
        const blob = new Blob(["\ufeff" + vcf], { type: 'text/vcard;charset=utf-8' });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "contactos_whatsapp.vcf";
        a.click();
        URL.revokeObjectURL(a.href);
    }

    function importVCF() {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".vcf";
        input.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
                const text = reader.result;
                const nuevos = [];
                // Tolerante a que la última tarjeta no termine en salto de línea
                const regex = /FN:(.*?)\r?\n(?:[\s\S]*?)TEL[^:\r\n]*:(.*?)(?:\r?\n|$)/g;
                let match;
                while ((match = regex.exec(text))) {
                    const nombre = match[1].replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
                    const numero = match[2].trim();
                    if (nombre && numero) nuevos.push({ nombre, numero });
                }

                const actuales = getContacts();
                const vistos = new Set(actuales.map(a => normalizar(a.numero)));
                const combinados = [...actuales];
                let agregados = 0;
                nuevos.forEach(c => {
                    const clave = normalizar(c.numero);
                    if (!vistos.has(clave)) {
                        vistos.add(clave);
                        combinados.push(c);
                        agregados++;
                    }
                });
                setContacts(combinados);
                alert(`✅ Se importaron ${agregados} nuevos contactos.`);

                const area = document.querySelector("#panel-vcf textarea");
                if (area) {
                    area.value = combinados.map(c => `${c.nombre}: ${c.numero}`).join("\n");
                }
                resaltar();
            };
            reader.readAsText(file);
        };
        input.click();
    }

    function togglePanel() {
        const existing = document.getElementById("panel-vcf");
        if (existing) {
            existing.style.display = existing.style.display === "none" ? "block" : "none";
            return;
        }

        const pos = getPos();
        const panel = document.createElement("div");
        panel.id = "panel-vcf";
        panel.style = `
            position: fixed;
            top: ${pos.y}px;
            left: ${pos.x}px;
            background: white;
            border: 2px solid #25D366;
            padding: 10px;
            z-index: 9999;
            resize: both;
            overflow: auto;
            width: 300px;
            height: 200px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.2);
            border-radius: 6px;
        `;

        const header = document.createElement("div");
        header.textContent = "📋 Contactos vCard";
        header.style = "cursor: move; font-weight: bold; margin-bottom: 6px; display: flex; justify-content: space-between; align-items: center; user-select:none;";

        const btnClear = document.createElement("button");
        btnClear.textContent = "🗑 Eliminar todos";
        btnClear.style = "background:#e53935;color:white;border:none;border-radius:4px;padding:4px 8px;font-size:12px;cursor:pointer;";
        btnClear.onclick = () => {
            if (confirm("¿Estás seguro de eliminar todos los contactos?")) {
                setContacts([]);
                area.value = "";
                resaltar();
            }
        };

        const btnCerrar = document.createElement("button");
        btnCerrar.textContent = "✖";
        btnCerrar.style = "background:#ccc;border:none;border-radius:4px;padding:4px 8px;font-size:12px;cursor:pointer;margin-left:6px;";
        btnCerrar.onclick = () => {
            panel.style.display = "none";
        };

        header.appendChild(btnClear);
        header.appendChild(btnCerrar);

        const area = document.createElement("textarea");
        area.style = "width: 100%; height: calc(100% - 30px); resize: none; font-family: monospace; font-size: 13px;";
        const lista = getContacts();
        area.value = lista.map(c => `${c.nombre}: ${c.numero}`).join("\n");

        area.addEventListener("input", () => {
            const lineas = area.value.split("\n");
            const nuevos = [];
            for (const linea of lineas) {
                const partes = linea.split(":");
                if (partes.length >= 2) {
                    const nombre = partes[0].trim();
                    const numero = partes.slice(1).join(":").trim();
                    if (nombre && numero) {
                        nuevos.push({ nombre, numero });
                    }
                }
            }
            setContacts(nuevos);
            resaltar();
        });

        panel.appendChild(header);
        panel.appendChild(area);
        document.body.appendChild(panel);

        // Dragging
        let isDragging = false, offsetX, offsetY;
        header.addEventListener("mousedown", e => {
            isDragging = true;
            offsetX = e.clientX - panel.offsetLeft;
            offsetY = e.clientY - panel.offsetTop;
            e.preventDefault();
        });
        document.addEventListener("mousemove", e => {
            if (!isDragging) return;
            const x = e.clientX - offsetX;
            const y = e.clientY - offsetY;
            panel.style.left = x + "px";
            panel.style.top = y + "px";
            savePos(x, y);
        });
        document.addEventListener("mouseup", () => isDragging = false);
    }

    function crearBoton(nombre, numero, contenedor) {
        // Elimina cualquier botón "fantasma" que haya quedado de una vista anterior
        document.querySelectorAll(".btn-vcf-exacto").forEach(b => {
            if (!contenedor.contains(b)) b.remove();
        });

        if (contenedor.querySelector(".btn-vcf-exacto")) return;

        const clave = normalizar(numero);
        const yaExiste = getContacts().some(c => normalizar(c.numero) === clave);

        const btn = document.createElement("button");
        btn.className = "btn-vcf-exacto";
        btn.textContent = yaExiste ? "✅ Ya guardado en vCard" : "➕ Guardar en vCard";
        btn.disabled = yaExiste;

        btn.style = `
            margin-top: 8px;
            padding: 6px 12px;
            background-color: ${yaExiste ? "#888" : "#25D366"};
            color: white;
            border: none;
            border-radius: 5px;
            font-size: 14px;
            cursor: ${yaExiste ? "not-allowed" : "pointer"};
        `;

        btn.onclick = () => {
            const contactos = getContacts();
            contactos.push({ nombre, numero });
            setContacts(contactos);
            btn.textContent = "✅ Ya guardado en vCard";
            btn.disabled = true;
            btn.style.backgroundColor = "#888";
            btn.style.cursor = "not-allowed";

            const area = document.querySelector("#panel-vcf textarea");
            if (area) {
                const lista = getContacts();
                area.value = lista.map(c => `${c.nombre}: ${c.numero}`).join("\n");
            }
            resaltar();
        };

        contenedor.appendChild(btn);
    }

    // No dependemos de clases generadas (cambian con cada actualización de WhatsApp).
    // En su lugar: buscamos entre todos los textos "seleccionables" el que tenga forma
    // de número de teléfono, y usamos el texto inmediatamente anterior como nombre
    // (así es como WhatsApp ordena nombre → número en la vista de info de contacto).
    function encontrarNumeroYNombre() {
        const spans = Array.from(document.querySelectorAll("span.selectable-text.copyable-text"));
        const regexNumero = /^\+\d[\d\s]{6,}$/;

        for (let i = 0; i < spans.length; i++) {
            const texto = limpiarInvisibles(spans[i].innerText);
            if (!texto || !regexNumero.test(texto)) continue;

            let nombre = "Desconocido";
            for (let j = i - 1; j >= 0 && j >= i - 5; j--) {
                const candidato = limpiarInvisibles(spans[j].innerText);
                if (
                    candidato &&
                    !regexNumero.test(candidato) &&
                    !candidato.toLowerCase().includes("últ. vez") &&
                    !candidato.toLowerCase().includes("haz clic")
                ) {
                    nombre = candidato;
                    break;
                }
            }

            return { numeroElem: spans[i], numero: texto, nombre };
        }
        return null;
    }

    function buscarYInsertar() {
        const encontrado = encontrarNumeroYNombre();
        if (!encontrado) return;
        const { numeroElem, numero, nombre } = encontrado;
        crearBoton(nombre, numero, numeroElem.parentElement);
    }

    setInterval(buscarYInsertar, 1000);

    const resaltar = () => {
        const contactos = getContacts();
        const numeros = new Set(contactos.map(c => normalizar(c.numero)));
        const nombres = contactos.map(c => c.nombre);
        document.querySelectorAll("span[title]").forEach(span => {
            if (nombres.includes(span.title)) {
                span.style.background = "#d2f8d2";
                span.style.borderRadius = "4px";
                span.style.padding = "2px 4px";
            } else {
                span.style.background = "";
                span.style.borderRadius = "";
                span.style.padding = "";
            }
        });
    };
    setInterval(resaltar, 2000);

    // ===== Recuperación de mensajes eliminados =====
    // Mientras el chat está abierto, vamos guardando el texto de cada mensaje que
    // se ve en pantalla. Si luego cambia a "Este mensaje fue eliminado", mostramos
    // el texto que ya teníamos guardado justo debajo del aviso. Solo funciona para
    // mensajes que llegaste a ver mientras la pestaña estaba abierta.

    const MSG_KEY = 'mensajesRecuperablesVCF';
    const MAX_MENSAJES_GUARDADOS = 3000;
    const REGEX_ELIMINADO = /este mensaje fue eliminado|this message was deleted|you deleted this message|eliminaste este mensaje/i;

    const getMensajes = () => GM_getValue(MSG_KEY, {});
    const setMensajes = (obj) => GM_setValue(MSG_KEY, obj);

    function vaciarCacheMensajes() {
        if (confirm("¿Vaciar el caché de mensajes guardados para recuperación? Esto no afecta tus chats, solo el respaldo local.")) {
            setMensajes({});
            alert("✅ Caché de mensajes vaciado.");
        }
    }

    function capturarYRecuperarMensajes() {
        const mensajes = getMensajes();
        let cambios = false;

        document.querySelectorAll('[data-id]').forEach(fila => {
            const id = fila.getAttribute('data-id');
            if (!id) return;

            const contenedorTexto = fila.querySelector('div.copyable-text');
            const textoActual = contenedorTexto?.innerText?.trim();
            if (!textoActual) return;

            if (!REGEX_ELIMINADO.test(textoActual)) {
                // Mensaje normal y visible: lo guardamos (o actualizamos) mientras se pueda
                if (!mensajes[id] || mensajes[id].texto !== textoActual) {
                    mensajes[id] = { texto: textoActual, ts: Date.now() };
                    cambios = true;
                }
                const previo = fila.querySelector('.msg-recuperado-vcf');
                if (previo) previo.remove();
                return;
            }

            // El mensaje aparece como eliminado: si lo teníamos guardado, lo mostramos
            if (mensajes[id] && !fila.querySelector('.msg-recuperado-vcf')) {
                const aviso = document.createElement('div');
                aviso.className = 'msg-recuperado-vcf';
                aviso.style = 'margin-top:4px;padding:6px 8px;background:#fff3cd;border-left:3px solid #e6a700;border-radius:4px;font-size:13px;color:#333;white-space:pre-wrap;';
                aviso.textContent = `🗑️ Recuperado: ${mensajes[id].texto}`;
                (contenedorTexto.parentElement || fila).appendChild(aviso);
            }
        });

        if (cambios) {
            const claves = Object.keys(mensajes);
            if (claves.length > MAX_MENSAJES_GUARDADOS) {
                claves
                    .sort((a, b) => mensajes[a].ts - mensajes[b].ts)
                    .slice(0, claves.length - MAX_MENSAJES_GUARDADOS)
                    .forEach(k => delete mensajes[k]);
            }
            setMensajes(mensajes);
        }
    }

    setInterval(capturarYRecuperarMensajes, 1500);
})();
