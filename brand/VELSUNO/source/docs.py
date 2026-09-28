from pathlib import Path
import json,html,hashlib
B=Path('output/VELSUNO')
research='''# Investigación Velsuno
Fecha de consulta: 27 de septiembre de 2026. Alcance: fuentes públicas, sin pruebas de uso con consumidores y sin auditoría de aplicaciones autenticadas. Las conclusiones son interpretación estratégica del estudio.

| Referente | Naming / símbolo / color | Voz, UI y posicionamiento | Premium y aprendizaje |
|---|---|---|---|
| Apple Wallet | Nombre descriptivo; marca de sistema; organización mediante objetos y superficies | Reúne elementos cotidianos. Referencia de concentración y jerarquía | No se traslada su modelo de pagos. Inspiración de claridad, sin usar su marca, SF Pro ni tarjetas como identidad |
| Copilot Money | Metáfora de acompañamiento y descriptor Money | Presenta organización automática y un asistente; foco en seguimiento y lectura visual | Producto premium. “Asistente” y “automático” no son diferencias suficientes por sí solos |
| Monarch | Nombre simbólico y oferta amplia | Seguimiento, presupuesto y planificación | Página consultada con Core y Plus. La amplitud debe explicarse por capacidades y no solo por acabado |
| YNAB | Acrónimo asociado a un método | Método explícito y control participativo sobre el presupuesto | Suscripción; no trasladar la carga de adopción del método a este producto de baja fricción |
| Nubank | Nu en contenedor morado; continuidad de marca | Refresh oficial refuerza un sistema coherente con variaciones | Ultravioleta comparte arquitectura. Evitar usar morado como atajo de innovación |
| Monzo | Nombre abstracto y coral reconocido | Comunicación cercana; sistema extendido desde un color identificador | Mantiene familia de marca. Reservar un acento tiene más valor que decorar todo |
| Revolut | Nombre evocativo y oferta bancaria amplia | Plataforma digital de muchas capacidades y planes | Referencia comercial, no alcance funcional de Velsuno; evitar códigos de trading y falsa exclusividad |

## Lectura del panorama
En esta muestra, organización, claridad, automatización y acompañamiento se repiten. El color aislado no crea una posición defendible. Proponemos que Velsuno combine una firma reconocible con decisiones de producto visibles: dato parcial, origen de un movimiento y corrección humana.

## Decisión
Territorio: claridad cotidiana. Apertura, espacios amplios, tipografía consistente y un único acento. Los colores financieros se reservan para su significado. El dashboard distingue datos parciales de ahorro confirmado.

## Fuentes primarias
- Apple Wallet: https://www.apple.com/wallet/
- Copilot Money: https://www.copilot.money/
- Copilot FAQ: https://www.copilot.money/faq
- Monarch: https://www.monarch.com/
- Monarch planes: https://www.monarch.com/pricing
- YNAB: https://www.ynab.com/
- Monzo: https://monzo.com/
- Monzo sistema visual: https://monzo.com/blog/weve-had-a-little-makeover
- Nubank Brand Refresh, 10/06/2026: https://blog.nubank.com.br/brand-refresh-como-renovamos-a-identidade-visual-do-nubank/
- Revolut: https://www.revolut.com/

Las descripciones tipográficas de terceros no se convierten en especificaciones. No se descargaron sus fuentes ni se copiaron sus símbolos. Manrope es una elección independiente para Velsuno.
'''
(B/'research/benchmark.md').write_text(research)
(B/'research/naming-validation.md').write_text('''# Naming: evaluación y evidencia
Corte: 27/09/2026. Revisión preliminar de resultados web indexados; no sustituye búsquedas marcarias, de similitud fonética ni búsquedas completas dentro de tiendas. Un resultado no encontrado no demuestra inexistencia.

## Selección: Velsuno
- Pronunciación propuesta: vel-SU-no. Siete letras, sin tilde.
- Concepto: evocación creativa de ver y reunir en uno, no etimología real.
- Historia: movimientos que llegan separados se convierten en una lectura comprensible.
- Personalidad: serena, precisa, contemporánea, accesible.
- Tagline: Tu dinero, más claro.
- Ventajas: no limita a gastos, bancos o IA; admite Velsuno Plus y asistente de Velsuno.
- Debilidades: nombre inventado; necesita prueba oral y de recuerdo. La V/B puede generar error al dictarlo en español. No suponer comprensión internacional por pronunciarlo fácilmente.
- Potencial internacional: plausible, no validado con usuarios ni revisión lingüística exhaustiva.
- Conflictos: no se identificó una app financiera exacta. Apareció “Velsuno Vintage Riviera T-Shirt” en páginas de Etsy y coincidencias OCR no relevantes. No inferimos titular, registro o derechos sobre ese uso.
- App Store / Play Store: consultas web restringidas a apps.apple.com y play.google.com sin ficha exacta relevante identificada. No se comprobó todo el catálogo de todos los países.
- Redes: consultas web restringidas a Instagram, LinkedIn y Facebook sin perfil comercial exacto validado. No se comprobó disponibilidad de handles ni se reservó ninguno.
- Dominios: búsquedas exactas de velsuno.com, velsuno.app y velsuno.pe; sin sitio oficial coincidente validado. Consulta https://rdap.org/domain/{dominio}: HTTP 404 en los tres. No equivale a disponibilidad comercial; .pe puede no estar resuelto por ese servicio. Verificar en registrador antes de comprar.
- DIGITAL SEARCH CLEAR: no se otorga un clearance general; filtro preliminar sin colisión financiera exacta encontrada.
- LEGAL TRADEMARK CLEARANCE: NO REALIZADO. No se consultaron todas las bases de marcas ni se emitió opinión jurídica.

## Otros cuatro finalistas
| Nombre | Concepto e historia creativos | Personalidad / tagline | Fortalezas / debilidades | Conflictos encontrados | Potencial internacional |
|---|---|---|---|---|---|
| Orvilo / or-VI-lo | Orden y visión: reunir operaciones | Preciso; Todo toma sentido | Fluido, corto; fuerte cercanía con software existente | SaaS de propuestas, facturas y clientes en orvilo.app. Página de registro y Terms. Presencia digital directa: descartar | Fonética sencilla, riesgo elevado por uso previo |
| Talvio / TAL-vio | Actividad a la vista | Directo; Ve cómo vas | Breve; saturación digital | talvioapp.com: workforce; talvio.co: empleo; talvio.ai: voz; talvio.ca: integración; perfiles LinkedIn exactos | Difícil diferenciación en software internacional |
| Enlumo / en-LU-mo | Poner luz sobre lo cotidiano | Cálido; Entiende tu dinero | Sonoro; cercanía a nombres de iluminación | Enlumo LTD y LinkedIn, iluminación; enlumo.ca comercio. No se identificó una app financiera exacta | Buen sonido, derechos y confusión sin resolver |
| Nuvilo / nu-VI-lo | Nueva perspectiva | Ligero; Una nueva forma de ver | Flexible; puede parecer infantil | Nuvilo en Google Play (salud), nuvilo.cloud y nuvilo.com.br. Descartar por apps homónimas | Ya usado por productos digitales en distintos contextos |

## Método aplicado
Búsqueda exacta, búsqueda junto a app/finance/software, filtros a tiendas y redes, y comprobación de sitios identificados. Los motores a veces ampliaron consultas a resultados parecidos; esos resultados no se tomaron como prueba de disponibilidad. Se revisaron las colisiones relevantes directamente en sus páginas públicas.

## Fuentes
- https://www.orvilo.app/
- https://orvilo.app/terms-of-service/
- https://www.talvioapp.com/
- https://www.talvio.co/
- https://www.talvio.ai/privacy
- https://talvio.ca/en/our-services/erp-crm-integration/
- https://www.linkedin.com/company/talvio-co
- https://uk.linkedin.com/company/enlumo-ltd
- https://find-and-update.company-information.service.gov.uk/company/07501446/filing-history
- https://enlumo.ca/
- https://play.google.com/store/apps/details?id=com.nuvilo.health
- https://nuvilo.cloud/
- https://nuvilo.com.br/
- https://www.etsy.com/es/market/camisa_mediterr%C3%A1nea
- https://www.etsy.com/fr/market/vintage_beach_shirt

## Próxima validación de lanzamiento
Confirmar nombre con Mauro, evaluar similitud fonética y marcaria en Perú y mercados previstos, confirmar dominios en un registrador y reservar usuarios de redes. Este paquete permite implementar y evaluar la identidad sin afirmar que el nombre está legalmente libre.
''')
(B/'research/sources.md').write_text('''# Fuentes y alcance
Consulta: 27/09/2026.

Producto: Prompt_Madre_Gestor_Financiero_Automatico_v1.1(2).docx, versión 1.1. Leído antes de diseñar. No se modificó el producto.
Brief: Texto pegado(20260927-201256).txt, MASTER BRAND PRODUCTION STUDIO.
Selección del usuario: opción visual 2, mensaje “elijo la opción 2”.

Ver benchmark.md y naming-validation.md para fuentes comerciales y búsqueda de nombres.

Accesibilidad (documentación primaria W3C):
- https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html
- https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html
- https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html

Se aplicaron umbrales de 4.5:1 para texto normal y 3:1 para límites de controles/foco. Objetivo de marca 44 px de área táctil; no confundirlo con el mínimo AA de 24 px y sus excepciones. Se requiere auditoría de la implementación para afirmar conformidad WCAG.

Tipografía:
- https://github.com/google/fonts/tree/main/ofl/manrope
- https://github.com/google/fonts/blob/main/ofl/manrope/OFL.txt
Descarga del archivo variable y licencia adjunta. No se incluyeron fuentes propietarias de terceros.

Gráficos y datos: todos los montos son ficticios y sirven para demostrar el diseño. No constituyen reporte de las finanzas de Mauro ni datos provenientes de una integración real.

Exploración visual: herramienta integrada de generación de imágenes, prompt en source/image-generation-prompt.txt. La opción 02 fue reconstruida como geometría SVG editable, no como una imagen incrustada.
''')
copy={
'welcome':'Tu dinero, más claro. Empecemos por lo esencial.',
'login':'Entra a tu cuenta.','signup':'Crea tu cuenta Velsuno.',
'empty_state':'Aún no hay movimientos. Añade uno o configura una fuente compatible.',
'detected':'Registramos una compra de {amount}. Revisa el detalle.',
'review_required':'Falta confirmar el tipo de este movimiento.',
'overspending':'{category} está {amount} por encima de tu promedio mensual.',
'savings_milestone':'Cerraste {month} con {amount} de ahorro, {delta} más que en {previous_month}.',
'trial_started':'Tu prueba de Plus está activa hasta el {date}. No necesitas tarjeta.',
'trial_ending':'Tu prueba termina el {date}. Si no eliges Plus, seguirás en Free.',
'upgrade':'Amplía tu automatización con Plus.',
'plus_active':'Plus está activo. Consulta tus funciones y próxima renovación en tu cuenta.',
'payment_successful':'Recibimos tu pago. Consulta el detalle en tu cuenta.',
'payment_failed':'No pudimos confirmar el pago. Revisa tu método de pago.',
'error':'No pudimos guardar el cambio. Intenta de nuevo.',
'sync_disconnected':'Esta fuente dejó de actualizarse. Revisa la conexión para continuar.',
'account_recovery':'Si existe una cuenta con ese correo, recibirás instrucciones para recuperar el acceso.'}
(B/'developer/copy-es-PE.json').write_text(json.dumps(copy,ensure_ascii=False,indent=2))
(B/'developer/README.md').write_text('''# Velsuno / Handoff de diseño v1.0

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
''')
(B/'README.md').write_text('''# Velsuno · Identidad v1.0

Comienza con brandbook/Velsuno_Brand_Book_v1.0.pdf (48 páginas).
Abre ui/index.html después de descomprimir para revisar las 13 aplicaciones de marca.
Consulta developer/README.md para implementar logos, tokens y metadatos.

Símbolo: Apertura, opción visual 02 elegida por Mauro.
Nombre: Velsuno. Tagline: Tu dinero, más claro.
Estado legal del nombre: no validado. Dominios y usuarios de redes: sin reservar.
Los mockups usan datos ficticios y no representan funciones verificadas del SaaS.

La carpeta research contiene el filtro de nombres, fuentes y benchmark.
La carpeta source conserva scripts y decisiones para futuras versiones.
''')
(B/'source/decisions.md').write_text('''# Decisiones v1.0
- Prompt Madre v1.1 preservado como fuente funcional.
- Claridad cotidiana elegida como territorio.
- Velsuno seleccionado como nombre de trabajo, sin clearance legal.
- Mauro eligió explícitamente la opción visual 02. La opción 01 previa quedó descartada.
- Símbolo definitivo: Apertura. Todo activo de producción utiliza el mismo path maestro salvo favicon óptico documentado.
- Manrope como única familia; grafito, marfil y cítrico como base. Semánticos independientes.
- El archivo research/visual-exploration.png es exploración y no debe usarse como arte final.
- Las 13 pantallas son aplicaciones de marca. No se conectan a servicios ni recopilan datos.
- El nombre, el dominio, el precio Plus, las condiciones comerciales definitivas y las integraciones reales no se aprobaron por seleccionar el símbolo.

Token efficiency: se reutilizó la lectura del Prompt Madre. Se descartaron nombres por evidencia antes de producir. Hubo más búsquedas de naming de las inicialmente deseables debido a colisiones; no se trasladan las listas descartadas al usuario. Activos y reglas se externalizan a archivos. Consumo exacto de tokens: no disponible.
''')
(B/'source/image-generation-prompt.txt').write_text('''Built-in image generation, logo-brand exploration. Three flat vector-friendly concepts for “velsuno”: two inward elbows, an offset rounded-square aperture, and curved channels forming V. Graphite #20231F, ivory #F6F7F2, citron #E4EA8A. No wallets, coins, dollar signs, ascending arrows, AI sparkles or literal cards. User selected 02. Final vector geometry constructed independently and consistently from that visual direction. Exploration is not a production logo.
''')
# Local visual gallery, keyboard usable, all screen descriptions meaningful.
screens=[('dashboard-preview','Resumen claro'),('dashboard-dark-preview','Resumen oscuro'),('dashboard-mobile-preview','Resumen móvil'),('login-preview','Inicio de sesión'),('signup-preview','Crear cuenta'),('onboarding-preview','Configurar una fuente'),('transactions-preview','Movimientos y origen'),('review-preview','Revisar un movimiento'),('milestone-preview','Hito financiero'),('pricing-preview','Free y Plus'),('upgrade-preview','Prueba de Plus'),('plus-active-preview','Plus activo'),('email-preview','Correo mensual')]
buttons=''.join(f'<button type="button" data-src="{f}.png" data-title="{label}" aria-pressed="{str(i==0).lower()}">{label}</button>' for i,(f,label) in enumerate(screens))
gallery='''<!doctype html><html lang="es-PE"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Velsuno · Aplicaciones de marca</title><link rel="stylesheet" href="../developer/design-tokens.css"><style>*{box-sizing:border-box}body{margin:0;padding:28px}header{display:flex;align-items:center;gap:24px;flex-wrap:wrap}header img{width:180px}h1{font-size:24px}p{color:var(--text-secondary)}nav{display:flex;gap:8px;flex-wrap:wrap;margin:24px 0}nav button{border:1px solid var(--border-control);border-radius:12px;background:white;padding:8px 16px;cursor:pointer}nav button[aria-pressed=true]{background:var(--brand-primary);color:white}figure{margin:0;background:var(--bg-secondary);border-radius:24px;padding:16px;text-align:center}figure img{display:block;max-width:100%;height:auto;max-height:80vh;margin:auto}figcaption{padding:16px}footer{margin:20px 0}a{margin-right:24px}</style><header><img src="../logo/logo-primary.svg" alt="Velsuno"><h1>Aplicaciones de marca</h1></header><p>13 vistas de referencia. Datos ficticios; las pantallas no ejecutan operaciones financieras.</p><nav aria-label="Elegir pantalla">'''+buttons+'''</nav><figure><img id="preview" src="dashboard-preview.png" alt="Resumen claro: flujo neto de S/ 1,300 con datos parciales y dos movimientos por revisar."><figcaption id="caption">Resumen claro</figcaption></figure><footer><a href="../brandbook/Velsuno_Brand_Book_v1.0.pdf">Brand Book PDF</a><a href="../developer/README.md">Guía de implementación</a></footer><script>const buttons=[...document.querySelectorAll('nav button')];for(const b of buttons)b.addEventListener('click',()=>{for(const a of buttons)a.setAttribute('aria-pressed','false');b.setAttribute('aria-pressed','true');const im=document.getElementById('preview');im.src=b.dataset.src;im.alt=b.dataset.title+' · referencia visual de Velsuno; datos ficticios';document.getElementById('caption').textContent=b.dataset.title;});</script></html>'''
(B/'ui/index.html').write_text(gallery)
# Concise deliverable inventory.
files=[]
for p in sorted(B.rglob('*')):
 if p.is_file():files.append({'path':str(p.relative_to(B)),'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
(B/'asset-index.json').write_text(json.dumps(files,ensure_ascii=False,indent=2))
print('Docs and gallery complete',len(files))
