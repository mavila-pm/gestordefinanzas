# Velsuno / Handoff de diseño v1.0

Identidad visual: Apertura (opción 02 elegida por Mauro). Nombre de trabajo: Velsuno. Tagline: Tu dinero, más claro. El nombre requiere clearance marcario y confirmación de dominio antes del lanzamiento.

## Qué se puede usar directamente
- SVG de logo con trazados reales, sin fuentes externas ni raster incrustado.
- PNG de logo transparentes, app icon opaco 1024 y derivados.
- Favicon SVG, PNG 16/32, ICO; variante óptica diferenciada.
- OG 1200×630; cuadrado 1080×1080; avatar 1024×1024.
- 20 iconos SVG de interfaz y sprite con currentColor.
- Temas Light/Dark, estados, tipografía, espacios y movimiento.
- Manrope variable y licencia OFL.
- 13 aplicaciones de marca en SVG/PNG; ui/index.html es una galería estática local, no la app SaaS.

## Instalación web
1. Copiar logo/, icons/ y social/ a public/brand/ conservando nombres.
2. Copiar fonts/ y developer/design-tokens.css conservando la relación ../fonts/ o corregir el URL del @font-face.
3. Importar design-tokens.css globalmente. Aplicar data-theme="light" o "dark" a html.
4. Clase numeric para importes y tablas. Formatear PEN y USD separados; indicar tipo de cambio y fecha si hay conversión.
5. Asociar favicon.svg, favicon.ico y apple-touch-icon.png a los metadatos del sitio.
6. Configurar Open Graph con social/og-image-1200x630.png y el dominio confirmado. No se ha fijado dominio ni publicado el sitio.

Ejemplo HTML:
```html
<link rel="icon" type="image/svg+xml" href="/brand/icons/favicon.svg">
<link rel="icon" sizes="32x32" href="/brand/icons/favicon-32x32.png">
<link rel="apple-touch-icon" href="/brand/icons/apple-touch-icon.png">
<meta property="og:image" content="https://DOMINIO_CONFIRMADO/brand/social/og-image-1200x630.png">
```
Reemplazar DOMINIO_CONFIRMADO antes de usarlo en producción; no es un dominio real.

## Tailwind y Figma
- tailwind-theme.css es un puente de temas para Tailwind v4. No reemplaza la configuración ni ha sido compilado dentro del proyecto de producto.
- design-tokens.json es un JSON de intercambio; los colores usan HEX y claves $type/$value. No se afirma conformidad con un esquema DTCG ni importación automática universal.
- Figma: importar SVG y crear variables por temas. Mapear cada clave de color; tipografía en px, lineHeight como ratio. Un plugin puede requerir transformación de formato. No se entrega archivo .fig nativo.

## Reglas de producto preservadas
Seguridad, exactitud, deduplicación, exportación básica y corrección humana no son premium. Precio de Plus pendiente. Trial de 14 días y límites Free 1 institución/50 automáticos/3 meses son valores propuestos o configurables en el Prompt Madre: obtenerlos del backend y no hardcodearlos desde los mockups. Android SMS, Gmail producción, IA y voz solo deben mostrarse disponibles después de implementación y verificación. Nunca etiquetar flujo parcial como ahorro confirmado.

## Accesibilidad
92 pares de contraste verificados, con resultados exactos en contrast-report.json. Los bordes sutiles son decorativos. Para inputs usar border-control. No usar texto blanco sobre el cítrico. Foco de 3 px y separación de 3 px. Objetivo de hit area 44×44 px. Probar lector de pantalla, teclado, zoom, reflow y estados reales en la aplicación. No se afirma conformidad integral WCAG a partir de mockups.

## SVG y tipografía
El wordmark está convertido a trazados para mantener forma y espacio. No editarlo escribiendo la palabra de nuevo. La fuente del producto sigue siendo texto accesible; no implementar toda la UI como SVG o imagen. Las vistas SVG entregadas son muestras visuales para reconstruir con HTML semántico.

## Licencias y alcance
Manrope se distribuye con OFL.txt. Símbolo, composiciones e iconos fueron producidos para este proyecto. La exploración visual usa generación de imágenes; no constituye garantía de exclusividad jurídica. No se incluyeron logotipos de bancos ni imágenes copiadas de competidores. Este paquete no modifica repositorios ni publica un producto.
