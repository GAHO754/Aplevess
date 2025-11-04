<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Registrar compra</title>
  <link rel="icon" type="image/png" sizes="32x32" href="manzanas.png">
  <link rel="stylesheet" href="registrar.css" />

  <!-- OCR (Tesseract) -->
  <script src="https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js"></script>
</head>
<body class="bg-animated">
  <header class="top-bar">
    <div class="left-section"><h1 class="applebees-title">Applebee’s</h1></div>
    <div class="center-section"><p id="userGreeting">Registro de ticket</p></div>
    <div class="right-section">
      <a class="btn-secondary" href="panel.html">← Regresar</a>
    </div>
  </header>
  
  <main class="page">
    <section class="card panel-option" id="subida-ticket">
      <h2>📸 Sube primero tu ticket (obligatorio)</h2>

      <!-- =========== SUBIDA DE IMAGEN =========== -->
      <div class="upload-area">
        <label for="ticketFile">📎 Imagen del ticket</label>

        <div class="dropzone" id="dropzone" aria-label="Arrastra tu ticket aquí">
          <p>Arrastra y suelta la imagen aquí</p>
        </div>

        <!-- input real -->
        <input type="file" id="ticketFile" accept="image/*" style="display:none;" />

        <div class="upload-actions">
          <button id="btnSeleccionarArchivo" type="button" class="btn-secondary">📎 Subir archivo</button>
          <button id="btnAbrirCamara" type="button" class="btn-primary">📷 Tomar foto</button>
        </div>
      </div>

      <!-- =========== MODAL CÁMARA =========== -->
      <div class="camera-modal" id="cameraModal" aria-hidden="true">
        <div class="camera-box">
          <div class="camera-header">
            <h3>Tomar foto del ticket</h3>
            <button id="btnCerrarCamara" class="btn-secondary" type="button">Cerrar</button>
          </div>
          <video id="cameraVideo" playsinline autoplay></video>
          <div class="camera-actions">
            <button id="btnCapturar" class="btn-cta" type="button">Capturar</button>
          </div>
        </div>
      </div>

      <!-- =========== ACCIONES OCR =========== -->
      <div class="actions-row" style="gap:8px; flex-wrap:wrap;">
        <button id="btnProcesarTicket" type="button" class="btn-cta">
          <span>Procesar ticket (OCR)</span>
        </button>
        <button id="btnToggleDebug" type="button" class="btn-secondary" aria-expanded="false">
          🛠️ Mostrar depuración OCR
        </button>
      </div>
      <div id="ocrStatus" class="validacion-msg"></div>

      <!-- Panel de depuración OCR -->
      <pre id="ocrDebug" style="
        background: rgba(0,0,0,.35);
        border: 1px solid rgba(255,255,255,.08);
        padding: 10px;
        border-radius: 10px;
        font-size: 12px;
        max-height: 200px;
        overflow: auto;
        white-space: pre-wrap;
        margin-top: 10px;
        display: none;
      "></pre>

      <hr class="divider">

      <!-- =========== FORMULARIO DE DATOS =========== -->
      <div class="upload-area">
        <div class="grid-2">
          <div>
            <label for="inputTicketNumero">Número de ticket</label>
            <input type="text" id="inputTicketNumero" placeholder="Ej. 123456" disabled />
          </div>
          <div>
            <label for="inputTicketFecha">Fecha del ticket</label>
            <input type="date" id="inputTicketFecha" disabled />
          </div>
        </div>

        <label>Productos detectados / consumidos</label>
        <div id="listaProductos" class="lista-productos"></div>

        <div class="producto-inputs">
          <input type="text" id="nuevoProducto" placeholder="Agregar manualmente (si faltó algo)" disabled />
          <input type="number" id="nuevaCantidad" placeholder="Cantidad" min="1" disabled />
          <button id="btnAgregarProducto" type="button" class="btn-primary" disabled>➕ Agregar</button>
        </div>

        <!-- Puntos del ticket -->
        <div class="puntos-wrapper">
          <div class="puntos-header"><h3>🏅 Puntos del ticket (automático)</h3></div>
          <table class="tabla-puntos" id="tablaPuntos">
            <thead>
              <tr><th>Producto</th><th>Cant.</th><th>Puntos/u</th><th>Subtotal</th></tr>
            </thead>
            <tbody></tbody>
            <tfoot>
              <tr><td colspan="3" class="right">Total</td><td><strong id="totalPuntos">0</strong> pts</td></tr>
            </tfoot>
          </table>
        </div>

        <label for="inputTicketTotal">Total pagado</label>
        <input type="number" id="inputTicketTotal" step="0.01" placeholder="Ej. 249.90" disabled />

        <button id="btnRegistrarTicket" type="button" class="btn-cta" disabled>
          <span>Registrar Ticket</span>
        </button>
      </div>

      <div class="ticket-result">
        <p id="ticketValidacion" class="validacion-msg"></p>
      </div>
    </section>
  </main>

  <footer><p>© 2025 Great American Hospitality</p></footer>

  <!-- Firebase -->
  <script src="https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js"></script>
  <script src="https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js"></script>
  <script src="https://www.gstatic.com/firebasejs/10.12.2/firebase-database-compat.js"></script>
  <script src="firebase-config.js"></script>

  <!-- OpenCV (auto enderezado) -->
  <script async src="https://docs.opencv.org/4.x/opencv.js"></script>

  <!-- Proxy IA (Firebase Functions Gen2) -->
  <script>
  window.OPENAI_PROXY_ENDPOINT = "https://ocr-3wbtuycfvq-uc.a.run.app";
</script>


  <!-- Lógica tuya -->
  <script src="registrar.js"></script>
  <script src="ocr.js"></script>

  <!-- Drag & drop + Debug toggle -->
  <script>
    const dz = document.getElementById('dropzone');
    const fileInput = document.getElementById('ticketFile');

    // click en zona = abrir input
    dz.addEventListener('click', () => fileInput.click());

    // arrastrar
    dz.addEventListener('dragover', e => {
      e.preventDefault();
      dz.classList.add('drag');
    });
    dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
    dz.addEventListener('drop', e => {
      e.preventDefault();
      dz.classList.remove('drag');
      if (e.dataTransfer.files?.length) {
        fileInput.files = e.dataTransfer.files;
      }
    });

    // botón "subir archivo"
    document.getElementById('btnSeleccionarArchivo')?.addEventListener('click', () => {
      fileInput.click();
    });

    // Botón depuración OCR (muestra/oculta <pre id="ocrDebug">)
    const btnDbg = document.getElementById('btnToggleDebug');
    const preDbg = document.getElementById('ocrDebug');
    btnDbg?.addEventListener('click', () => {
      const showing = preDbg.style.display !== 'none';
      preDbg.style.display = showing ? 'none' : 'block';
      btnDbg.setAttribute('aria-expanded', String(!showing));
      btnDbg.textContent = showing ? '🛠️ Mostrar depuración OCR' : '🛠️ Ocultar depuración OCR';
    });
  </script>
</body>
</html>
