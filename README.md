# Visitas de obra — v1

App web para el móvil (Android + Chrome) que registra las visitas del estudio:

- **Tipo de visita:** obra en curso · toma de datos para informe
- **Por cada fotografía:** descripción dictada por voz y transcrita a texto
- **Sin cobertura:** todo se guarda en el móvil y se sube a Drive al volver la conexión
- **Salida en Google Drive**, lista para que Claude la lea:

```
VISITAS-OBRA/
  LEEME.md                         instrucciones para Claude
  expedientes.json
  26-025-INF_Rua-Vila-de-Noia-70-72/
    2026-09-28_1005_toma-datos/
      F01.jpg  F02.jpg …
      F03_audio.webm               (solo si se grabó audio)
      visita.md                    fotos + observaciones
      visita.json
```

## Puesta en marcha (una sola vez)

### 1. Publicar la app (necesita https para cámara y micrófono)

Opción recomendada: **GitHub Pages** (gratis).
1. Crear cuenta en github.com y un repositorio, p. ej. `visitas-obra`.
2. Subir el contenido de esta carpeta (`Add file → Upload files`).
3. `Settings → Pages → Branch: main / root → Save`.
4. La app quedará en `https://<usuario>.github.io/visitas-obra/`.

### 2. Permiso para escribir en Google Drive

En <https://console.cloud.google.com>, con la cuenta de Google del estudio:
1. **Crear proyecto** → nombre «Visitas de obra».
2. **APIs y servicios → Biblioteca** → buscar **Google Drive API** → *Habilitar*.
3. **APIs y servicios → Pantalla de consentimiento de OAuth** → tipo *Externo*;
   nombre de la app y correo; en *Usuarios de prueba* añadir la cuenta de Google
   que se usará. (No hace falta verificación: la app solo usa el permiso
   `drive.file`, que da acceso únicamente a lo que la propia app crea.)
   Publicar la app (*Publicar aplicación → En producción*) para que el permiso
   no caduque cada 7 días.
4. **Credenciales → Crear credenciales → ID de cliente de OAuth** → tipo
   *Aplicación web* → en **Orígenes de JavaScript autorizados** añadir
   `https://<usuario>.github.io` (y `http://localhost:8765` para pruebas).
5. Copiar el **ID de cliente** (`….apps.googleusercontent.com`).

### 3. En el móvil

1. Abrir la dirección de la app en Chrome → menú ⋮ → **Instalar app** / *Añadir a pantalla de inicio*.
2. En la app: **⚙ Ajustes** → pegar el ID de cliente → *Guardar y conectar con Drive*.
3. Con wifi: **Preparar dictado sin conexión** (descarga el modelo de voz en español).
4. En los ajustes de Android, instalar también el paquete de voz sin conexión de Gboard,
   que sirve de alternativa con el micrófono del teclado.

## Uso en obra

1. *Nueva visita* → tipo → expediente (o crear uno nuevo).
2. **Foto** → se abre la cámara → tras disparar, pulsar el **micrófono** y describir.
3. *Guardar y otra foto* para encadenar.
4. Al terminar, **Cerrar visita y subir a Drive**. Sin cobertura queda como
   «Pendiente de subir»; al volver la conexión, pulsar *Sincronizar*.

Si el dictado no puede transcribir (sin cobertura y sin modelo descargado),
usar **Grabar solo audio**: se guarda la nota de voz con la foto, marcada como
«pendiente de transcribir».

## Pruebas en el ordenador

```
python -m http.server 8765
```
y abrir `http://localhost:8765`.

## Archivos

| Archivo | Qué hace |
|---|---|
| `index.html` | página |
| `app.js` | toda la lógica: vistas, almacenamiento local, dictado, subida a Drive |
| `styles.css` | estilo |
| `config.js` | ID de cliente por defecto, nombre de la carpeta raíz, idioma |
| `sw.js`, `manifest.webmanifest`, `icon-*.png` | instalación y funcionamiento sin conexión |
