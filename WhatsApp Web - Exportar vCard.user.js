// ==UserScript==
// @name         WhatsApp Web - Exportar vCard
// @namespace    http://tampermonkey.net/
// @version      2025.07.30
// @description  Guarda contactos desde la vista de info de contacto como vCard (.vcf). Importar/exportar desde el menú Tampermonkey. Vista flotante editable, posición recordada, y resaltado en lista de chats.
// @author       wernser412
// @icon         https://web.whatsapp.com/favicon/1x/favicon/
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

    GM_registerMenuCommand("📋 Ver vCard", togglePanel);
    GM_registerMenuCommand("📤 Exportar vCard", exportVCF);
    GM_registerMenuCommand("📥 Importar vCard", importVCF);

    function exportVCF() {
        const contacts = getContacts();
        if (!contacts.length) return alert("No hay contactos guardados.");
        const vcf = contacts.map(({ nombre, numero }) =>
            `BEGIN:VCARD\nVERSION:3.0\nFN:${nombre}\nTEL;TYPE=CELL:${numero}\nEND:VCARD`
        ).join("\n");
        const blob = new Blob([vcf], { type: 'text/vcard' });
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
                const regex = /FN:(.*?)\r?\nTEL.*?:(.*?)\r?\n/g;
                let match;
                while ((match = regex.exec(text))) {
                    nuevos.push({ nombre: match[1], numero: match[2] });
                }
                const actuales = getContacts();
                const combinados = [...actuales];
                nuevos.forEach(c => {
                    if (!actuales.some(a => a.numero === c.numero)) {
                        combinados.push(c);
                    }
                });
                setContacts(combinados);
                alert(`✅ Se importaron ${combinados.length - actuales.length} nuevos contactos.`);

                // Actualizar textarea si el panel está abierto
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
        if (contenedor.querySelector("#btn-vcf-exacto")) return;

        const yaExiste = getContacts().some(c => c.numero === numero);

        const btn = document.createElement("button");
        btn.id = "btn-vcf-exacto";
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

            const area = document.querySelector("#panel-vcf textarea");
            if (area) {
                const lista = getContacts();
                area.value = lista.map(c => `${c.nombre}: ${c.numero}`).join("\n");
            }
            resaltar();
        };

        contenedor.appendChild(btn);
    }

    function buscarYInsertar() {
        const numeroElem = document.querySelector("div.x1fcty0u.xhslqc4.x6prxxf.x1o2sk6j");
        if (!numeroElem) return;

        const numero = numeroElem.innerText.trim();
        if (!/^\+\d[\d\s]{6,}/.test(numero)) return;

        let nombre = "Desconocido";

        const contenedor = numeroElem.closest("div.x1c4vz4f");
        if (contenedor) {
            const posibles = contenedor.querySelectorAll("span.selectable-text.copyable-text");
            for (const el of posibles) {
                const texto = el.innerText.trim();
                if (
                    texto.length > 0 &&
                    texto !== numero &&
                    !texto.toLowerCase().includes("últ. vez") &&
                    !texto.toLowerCase().includes("haz clic") &&
                    !/^\+\d/.test(texto)
                ) {
                    nombre = texto;
                    break;
                }
            }
        }

        crearBoton(nombre, numero, numeroElem.parentElement);
    }

    setInterval(buscarYInsertar, 1000);

    const resaltar = () => {
        const contactos = getContacts();
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
})();
