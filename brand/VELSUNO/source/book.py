exec(open('work/build.py').read().split('# SVG UI applications.')[0])
# This entrypoint imports production constants and rebuilds deterministic identity assets.
from reportlab.pdfbase.pdfmetrics import stringWidth
C=canvas.Canvas(str(B/'brandbook/Velsuno_Brand_Book_v1.0.pdf'),pagesize=(1200,800))
C.setTitle('Velsuno — Brand Book v1.0');C.setAuthor('Velsuno · Mauro Ávila');C.setSubject('Identidad y sistema visual para el Gestor Financiero Automático Multifuente')
page=0; page_titles=[]
def fill(c):C.setFillColor(HexColor(c))
def box(x,y,w,h,col,rad=0,stroke=None):
 fill(col);C.setStrokeColor(HexColor(stroke or col));C.roundRect(x,800-y-h,w,h,rad,fill=1,stroke=int(bool(stroke)))
def tx(s,x,y,size=18,col=INK,wt=400):
 fill(col);C.setFont('M'+str(wt),size);C.drawString(x,800-y-size*.8,str(s))
def para(s,x,y,w=490,size=18,col=MUT,wt=400,lh=None):
 lh=lh or size*1.5; yy=y
 for segment in str(s).split('\n'):
  row=''
  for word in segment.split():
   t=(row+' '+word).strip()
   if stringWidth(t,'M'+str(wt),size)>w and row:tx(row,x,yy,size,col,wt);yy+=lh;row=word
   else:row=t
  if row:tx(row,x,yy,size,col,wt);yy+=lh
  yy+=5
 return yy

def pic(rel,x,y,w,h=None,bg=None):
 p=B/rel;im=Image.open(p); iw,ih=im.size
 if h is None:h=w*ih/iw
 if bg:box(x,y,w,h,bg,16)
 C.drawImage(str(p),x,800-y-h,width=w,height=h,mask='auto',preserveAspectRatio=True,anchor='c')
def brand(x,y,w=210,col=INK):
 # Vector logo embedded in book from converted SVG PDF isn't supported by reportlab;
 # raster derivative is 1280px wide, adequate even on full-page displays.
 rel='logo/logo-primary.png' if col==INK else 'logo/logo-citron.png' if col==ACC else 'logo/logo-white.png';pic(rel,x,y,w,w*.2)
def start(k,title,sub='',dark=False):
 global page
 if page:C.showPage()
 page+=1;page_titles.append(title);bg=INK if dark else BG; fg='#F3F4EE' if dark else INK
 box(0,0,1200,800,bg);tx(k.upper(),56,39,12,ACC if dark else MUT,600)
 tx(title,56,80,min(41,41*1088/max(1,stringWidth(title,'M600',41))),fg,600)
 if sub:para(sub,56,140,1080,16,'#C1C8B8' if dark else MUT)
 tx('VELSUNO / BRAND SYSTEM 1.0',56,762,10,'#C1C8B8' if dark else MUT,500)
 tx(f'{page:02d}',1114,759,13,'#C1C8B8' if dark else MUT,600)
 return fg

def rule(x,y,w=1088):box(x,y,w,1,L['border-subtle'])
def columns(items,y=230,width=510,size=19):
 for i,(h,b) in enumerate(items):
  x=56+(i%2)*564;yy=y+(i//2)*215
  tx(h,x,yy,24,INK,600);para(b,x,yy+46,width,size)

def page_ui(title,rel,notes,theme=False):
 start('Producto / aplicación',title,notes,theme);pic(rel,230,207,800,533)

# 01
start('Brand book / septiembre 2026','',dark=True)
brand(70,70,365,ACC);tx('Tu dinero,',70,285,89,'#F3F4EE',600);tx('más claro.',70,389,89,'#F3F4EE',600)
pic('icons/app-icon-1024.png',822,257,275,275)
para('Identidad, lenguaje y sistema visual\nGestor financiero automático multifuente',73,590,740,23,'#C1C8B8')
tx('V1.0 / OPCIÓN VISUAL 02 ELEGIDA POR MAURO',73,690,12,ACC,600)
#02
start('01 / Contexto','Menos registro. Más comprensión.','La marca responde al Prompt Madre v1.1, fechado el 27 de septiembre de 2026.')
columns([('Verdad del producto','Transforma notificaciones financieras compatibles en movimientos organizados, deduplicados y explicables. Mantiene registro manual y correcciones.'),('Frustración que elimina','Tener que reconstruir la actividad del mes y abandonar el seguimiento porque registrar cada gasto exige demasiado esfuerzo.'),('Diferencial concreto','Automatización con origen visible y revisión de incertidumbre. Una operación recibida por dos fuentes no debe duplicarse.'),('Promesa responsable','Ayudar a entender el dinero con menos trabajo manual. La cobertura depende de fuentes conectadas y formatos bancarios validados.')],210,size=18)
#03
start('01 / Audiencia','Para quien quiere saber sin registrar todo.','Hipótesis de audiencia para validar con usuarios; no son hallazgos de una investigación de campo.')
columns([('Usuario inicial','Persona en Perú que recibe ingresos y paga con cuentas o tarjetas; opera en soles y, a veces, dólares. Quiere una rutina sencilla.'),('Trabajo que contrata','“Cuando mis movimientos están repartidos, ayúdame a entender el mes y detectar lo que necesita atención sin volver a escribirlo todo.”'),('Beneficio funcional','Ver ingresos, gastos, próximos pagos y cambios relevantes. Comprender qué está confirmado y qué falta revisar.'),('Beneficio emocional','Menos carga mental y una sensación de orientación. La marca acompaña sin sermonear ni prometer riqueza.')],211,size=18)
#04
start('02 / Referentes','Qué tomar. Qué evitar.','Lectura estratégica de fuentes oficiales consultadas el 27 de septiembre de 2026. No es un estudio exhaustivo.')
rows=[('Apple Wallet','Concentración, jerarquía, objetos claros.','Tomar la claridad; no sugerir pagos ni copiar tarjetas.'),('Copilot Money','Organización automática y asistente.','Explicar origen y cobertura; “asistente” no basta.'),('Monarch','Visión completa y planificación.','Una conclusión principal antes de más gráficos.'),('YNAB','Método y participación del usuario.','Reducir fricción sin prometer cero intervención.')]
y=226
for a,b,d in rows:
 tx(a,56,y,24,INK,600);para(b,300,y,340,17);para(d,705,y,430,17);rule(56,y+91);y+=119
#05
start('02 / Referentes','La diferencia vive en el sistema.','Comparación de marca: observaciones de sus páginas y comunicación oficial, no auditoría de sus aplicaciones.')
columns([('Nubank','Su contenedor morado refuerza reconocimiento. Aprendizaje: consistencia del símbolo y del soporte. Evitamos convertir Velsuno en otra fintech morada.'),('Monzo','El coral es una señal distintiva sostenida. Aprendizaje: un acento limitado puede ser más reconocible que muchos colores sin jerarquía.'),('Revolut','Amplia oferta bajo una marca digital y planes. Evitamos que una estética premium sugiera banca, trading o inversión que este producto no ofrece.'),('Patrones de esta muestra','Automatización, claridad y confianza son promesas compartidas. El espacio elegido combina calma visual con evidencia: origen, cobertura y corrección.')],211,size=18)
#06
start('03 / Territorios','Cuatro rutas. Una elección.','Criterio de decisión: producto, distinción, confianza, memoria y capacidad de evolucionar.')
territories=[('01  Claridad cotidiana / ELEGIDO','Alivio y orientación. Interfaces despejadas, apertura como símbolo y nombre abierto. Riesgo: resultar genérico si no se muestra evidencia.'),('02  Flujo invisible','Continuidad y ahorro de esfuerzo. Canales y capas. Naming de movimiento. Riesgo: prometer automatización total.'),('03  Progreso sereno','Motivación sin presión. Ritmos, hitos y superficies cálidas. Naming de avance. Riesgo: parecer coaching o gamificación.'),('04  Perspectiva personal','Comprensión y autonomía. Marcos, comparaciones y narrativas. Naming de visión. Riesgo: sentirse analítico y distante.')]
for i,(h,b) in enumerate(territories):
 y=211+i*122;box(56,y,1088,107,ACC if i==0 else '#FFFFFF',18);tx(h,78,y+18,22,INK,600);para(b,78,y+53,1035,16,MUT)
#07
start('04 / Naming','Cinco finalistas sometidos a búsqueda.','Historias creativas propuestas; no son etimologías ni promesas de disponibilidad.')
ns=[('Velsuno','vel-SU-no','Ver + una visión reunida. Sereno.','Tu dinero, más claro.','7 letras; admite finanzas e inteligencia.'),('Orvilo','or-VI-lo','Orden y visión. Preciso.','Todo toma sentido.','Buena fluidez; conflicto con SaaS de gestión.'),('Talvio','TAL-vio','Actividad a la vista. Directo.','Ve cómo vas.','Corto; saturación en software y servicios.'),('Enlumo','en-LU-mo','Poner luz en lo cotidiano. Cálido.','Entiende tu dinero.','Fácil de decir; marcas ajenas ya existentes.'),('Nuvilo','nu-VI-lo','Nueva perspectiva. Ligero.','Una nueva forma de ver.','Sonoro; apps homónimas identificadas.')]
y=210
for a,b,c,d,e in ns:
 tx(a,56,y,25,INK,600);tx(b,56,y+35,14,MUT);para(c+' '+d,255,y,415,17);para(e,737,y,395,17);rule(56,y+87);y+=103
#08
start('04 / Naming','La búsqueda filtra. No otorga derechos.','Fecha de corte: 27/09/2026. Evidencias y consultas reproducibles en research/naming-validation.md.')
columns([('Velsuno / seleccionado','No se identificó una app financiera exacta en las búsquedas realizadas. Apareció un título comercial de ropa en Etsy: no asumir exclusividad global.'),('Dominios y redes','Consultas RDAP de .com, .app y .pe devolvieron HTTP 404. Eso no confirma compra disponible; .pe puede tener cobertura limitada. Usuarios sociales no reservados.'),('Conflictos descartados','Orvilo: SaaS de facturas y clientes. Talvio: software, RR. HH. y voz. Nuvilo: app de salud y otro producto digital. Enlumo: iluminación y comercio.'),('Estado de autorización','DIGITAL SEARCH: filtro preliminar, no clearance completo. LEGAL TRADEMARK CLEARANCE: no realizado. Antes de lanzar: revisión marcaria y fonética en mercados objetivo.')],210,size=17)
#09
start('04 / Nombre elegido','Velsuno','Nombre de trabajo seleccionado profesionalmente. La aprobación del símbolo no equivale a autorización legal del nombre.')
brand(72,235,690);para('Una vista que reúne lo disperso.',73,420,970,34,INK,600)
para('Velsuno evoca ver y reunir en uno. Es una construcción creativa: no pretende tener una raíz lingüística oficial. La pronunciación propuesta es vel-SU-no; se escribe sin tilde.',73,489,980,22)
para('Potencial: Velsuno, Velsuno Plus y el futuro asistente de Velsuno. Riesgo: requiere enseñar el nombre y probar comprensión oral antes de escalar internacionalmente.',73,609,980,19)
#10
start('05 / Fundamentos','Claridad que se puede comprobar.')
columns([('Posicionamiento','Para personas que quieren entender su dinero con menos esfuerzo, Velsuno organiza actividad financiera compatible y hace visible su estado de confianza.'),('Idea de marca','Abrir una vista clara sobre lo que ya ocurrió. El dato gana valor cuando se comprende y se puede corregir.'),('Misión','Reducir el trabajo de registrar y facilitar una lectura útil, honesta y cotidiana de las finanzas personales.'),('Diferenciación','Menos fricción, origen visible y control humano. La marca promete comprensión; el producto debe demostrar exactitud y cobertura.')],210,size=19)
#11
start('05 / Principios','Cinco reglas para cada decisión.')
for i,(h,b) in enumerate([('Primero lo importante','Una conclusión principal y acciones claras antes que un tablero lleno.'),('La evidencia a la vista','Mostrar fuente, fecha, cobertura y revisión cuando importen.'),('El usuario conserva el control','Corregir, exportar y cancelar con claridad; sin presión artificial.'),('El progreso se gana','Reconocer resultados relevantes y confiables, no logins ni consumo.'),('Una sola marca','Free, Plus, voz e IA comparten nombre, símbolo y tono.')]):
 y=202+i*101;tx(f'0{i+1}',56,y,25,L['milestone-accent'],600);tx(h,128,y,25,INK,600);para(b,128,y+42,980,18)
#12
start('05 / Personalidad y voz','Humana. Precisa. Calmada.')
columns([('Humana','Habla de tú, en español claro. Reconoce la situación sin juzgarla. Evita diminutivos, emojis excesivos y frases de motivación vacía.'),('Precisa','Distingue gastos de pagos de tarjeta y flujo de ahorro. Indica moneda y período. No escribe “todo” si la cobertura es parcial.'),('Calmada','Una acción principal por mensaje. Errores sin alarma innecesaria. Oraciones orientativas de 8 a 18 palabras, sin forzar el límite.'),('Nunca','Culpa, urgencia fabricada, garantías de riqueza, “seguridad 100%”, “IA que lo sabe todo” o promesas de integración no verificada.')],210,size=19)
#13
start('06 / Mensaje','Tu dinero, más claro.','Tagline principal: comprensible hoy y compatible con una evolución hacia IA y voz.',True)
para('Tu dinero,\nmás claro.',73,246,1040,85,'#F3F4EE',600,100)
para('Funcional: “Menos registro manual. Más perspectiva sobre tu mes.”\nEmocional: “Entiende tu mes con calma.”\nInteligencia: “Lo que pasa con tu dinero, explicado.”',73,525,1000,22,'#C1C8B8')
tx('Usar una sola frase por pieza. No convertir las alternativas en tres taglines simultáneos.',73,685,15,ACC)
#14
start('07 / Identidad','Apertura','Dirección visual 02 elegida por Mauro. Una abertura revela lo que antes estaba disperso.')
brand(118,302,960)
para('Un marco continuo con una interrupción deliberada. Sugiere acceso a la información y espacio para entenderla. No representa una tarjeta ni una función bancaria.',130,537,940,23)
#15
start('07 / Construcción','Una geometría sencilla, un gesto propio.','El archivo SVG es el máster. No redibujar a partir de estas cotas ni sustituirlo por una letra C.')
pic('logo/isotipo.png',85,226,360,360)
# guide grid
C.setStrokeColor(HexColor('#DDE0D5'));C.setLineWidth(.45)
for a in range(9):
 C.line(85+a*45,800-226,85+a*45,800-586);C.line(85,800-226-a*45,445,800-226-a*45)
para('Retícula del máster: 72 × 72 unidades.\nExtensión del símbolo: x 8–64, y 8–64.\nGrosor principal: 12 unidades.\nContraforma: 32 × 32 unidades.\nAbertura derecha desplazada y corte oblicuo.',570,239,540,23)
para('La relación entre esquinas curvas y abertura es fija. Esta asimetría distingue el símbolo de un simple contenedor.',570,540,540,19)
#16
start('07 / Espacio y escala','Darle aire también es diseñar.','Zona de protección y tamaños mínimos recomendados, revisados en los archivos exportados.')
box(87,260,704,235,'#FFFFFF',18);pic('logo/logo-primary.png',135,329,608,121.6)
C.setStrokeColor(HexColor('#767B70'));C.setDash(4,4);C.rect(115,800-281-191,650,191,stroke=1,fill=0);C.setDash()
para('x = 12 unidades del símbolo.\nEspacio mínimo alrededor: 1x.\nPreferido en portada y marketing: 2x.',834,255,300,21)
para('Logo horizontal: mínimo 140 px de ancho.\nIsotipo aislado: mínimo 24 px.\nFavicon: usar la variante óptica de 16/32 px.\nCon tagline: ancho recomendado ≥ 260 px.',89,555,1000,21)
#17
start('07 / Variantes','Una firma, distintos fondos.')
for x,y,w,col,rel in [(56,210,520,'#FFFFFF','logo/logo-primary.png'),(622,210,520,INK,'logo/logo-white.png'),(56,444,520,INK,'logo/logo-citron.png'),(622,444,520,'#FFFFFF','logo/logo-black.png')]:
 box(x,y,w,190,col,22);pic(rel,x+35,y+53,w-70,90)
para('Color, blanco, negro y cítrico. El logo principal es monocromo: no se colorean sus partes por separado.',56,679,1050,18)
#18
start('07 / Lockups','Horizontal para producto. Vertical para espacio.','Usar archivos existentes. El wordmark mantiene minúsculas y espaciado fijo.')
pic('logo/lockup-vertical.png',91,215,390,329);pic('logo/wordmark.png',630,264,485,108)
tx('Vertical + tagline',91,606,22,INK,600);tx('Wordmark',630,606,22,INK,600)
para('Presentaciones, cierres y espacios cuadrados. Evitar el tagline en tamaño pequeño.',91,650,430,17)
para('Útil cuando el nombre ya debe ser protagonista. El símbolo puede acompañar en otra zona.',630,650,480,17)
#19
start('07 / Usos incorrectos','Preservar la abertura.')
columns([('No deformar','No estirar ni comprimir. No alterar la abertura, redondear el corte o rellenar la contraforma.'),('No añadir efectos','Sin bevel, sombra, glow, transparencia ni degradados dentro del símbolo. El gradiente, si existe, pertenece al soporte.'),('No convertir en decoración','No repetir el logo como ruido detrás de cifras. No recortarlo cuando deba identificar la marca.'),('No inventar submarcas','Sin corona de Plus, símbolo IA, colores bancarios ni reemplazo por la letra C. Usar las variantes entregadas.')],216,size=19)
#20
start('08 / App y favicon','Reconocible antes de leer.','App icon: fondo opaco y cuadrado; la plataforma aplica la máscara. Avatar conserva margen para recorte circular.')
pic('icons/app-icon-1024.png',56,223,325,325);pic('social/avatar.png',428,273,225,225)
for x,siz in [(750,96),(886,64),(1000,32),(1090,16)]:
 pic(f'icons/favicon-{siz}x{siz}.png',x,325,siz,siz);tx(str(siz)+' px',x,440,15,MUT)
para('Favicon óptico: abertura ampliada para evitar cierre visual. No usarlo como logo grande. Se entregan SVG, PNG 16/32 e ICO.',56,613,1088,22)
#21
start('09 / Paleta','Neutros que dejan hablar a los datos.','El acento cítrico identifica momentos y soportes. No sustituye el verde de ingresos ni el ámbar de revisión.')
cols=[('Grafito',INK),('Marfil',BG),('Cítrico',ACC),('Blanco','#FFFFFF')]
for i,(n,c) in enumerate(cols):
 x=56+i*278;box(x,218,254,290,c,24);tx(n,x,539,25,INK,600);tx(c,x,581,20,MUT)
para('Base neutra dominante. Acento orientativo: hasta 10% del área funcional. No es una regla matemática para marketing. La distinción depende del conjunto: apertura, contraste, espacio y voz.',56,648,1080,19)
#22
start('09 / Light','Luz sin exceso de blanco.','Textos y controles usan contraste propio; las divisiones decorativas pueden ser más sutiles.')
keys=['bg-primary','bg-secondary','surface-default','surface-elevated','border-subtle','border-control','text-primary','text-secondary','text-muted','disabled-bg','disabled-text','focus-ring']
for i,k in enumerate(keys):
 x=56+(i%3)*371;y=217+(i//3)*122;box(x,y,55,55,L[k],12,L['border-subtle']);tx(k,x+72,y+4,15,INK,600);tx(L[k],x+72,y+34,16,MUT)
#23
start('09 / Dark','Oscuridad con profundidad.','Superficies elevadas, textos suaves y semánticos aclarados. No es una inversión del modo claro.',True)
for i,k in enumerate(keys):
 x=56+(i%3)*371;y=217+(i//3)*122;box(x,y,55,55,D[k],12,D['border-subtle']);tx(k,x+72,y+4,15,'#F3F4EE',600);tx(D[k],x+72,y+34,16,'#C1C8B8')
#24
start('09 / Semántica','El color describe, no decide.','Cada estado se acompaña con palabra, signo o icono. Gastar no equivale a un error.')
sem=[('income','Ingreso +'),('expense','Gasto −'),('savings','Ahorro'),('transfer','Transferencia'),('debt','Deuda'),('warning','Advertencia'),('error','Error'),('review','Por revisar'),('success','Confirmado')]
for i,(k,label) in enumerate(sem):
 x=56+(i%3)*371;y=218+(i//3)*157
 box(x,y,334,127,'#FFFFFF',16);tx(label,x+17,y+18,19,L['semantic-'+k],600);tx('Light '+L['semantic-'+k],x+17,y+55,15,MUT);tx('Dark  '+D['semantic-'+k],x+17,y+85,15,MUT)
#25
start('10 / Comercial','Plus amplía la capacidad.','La seguridad, la exactitud, la revisión y la corrección humana pertenecen a todos los planes.')
pic('plus/plus-mark.png',69,228,600,150)
columns([('Free','La misma tipografía, controles, protección y dignidad visual. Se muestra como plan útil y permanente.'),('Plus','Etiqueta cítrica sobre superficie neutra. Más fuentes y perspectiva cuando estén disponibles. Sin metales, coronas ni brillo artificial.')],420,size=20)
para('Trial: estado temporal, no tercera marca. Mostrar fecha exacta y condiciones. Los 14 días son una propuesta configurable del Prompt Madre; no una decisión comercial nueva.',56,659,1080,18)
#26
start('11 / Tipografía','Manrope. Una familia, todo el sistema.','Incluida bajo SIL Open Font License 1.1. No usar SF Pro ni tipografías propietarias de Apple como dependencia.')
tx('Aa 0123456789',56,222,83,INK,500)
for i,(role,(sz,lh,wt)) in enumerate(TYPE.items()):
 x=56+(i%3)*371;y=358+(i//3)*82
 tx(role,x,y,17,INK,600);tx(f'{sz}/{lh} px · peso {wt}',x,y+29,16,MUT)
#27
start('11 / Números','Cada cifra merece el mismo cuidado.')
tx('S/ 5,500.00',56,220,75,INK,600);tx('−S/ 182.40',56,328,60,L['semantic-expense'],600);tx('+US$ 1,420.00',56,426,53,L['semantic-income'],600)
para('Usar cifras tabulares y alineación derecha en tablas. En UI: font-variant-numeric: tabular-nums lining-nums.',760,223,370,22)
para('PEN: S/ 5,500.00\nUSD: US$ 1,420.00\nPorcentaje: 18.4%\nMoneda visible cuando conviven PEN y USD.',760,410,370,20)
para('Nunca sumar PEN y USD sin una conversión explícita. Si hay datos incompletos, escribir “flujo neto” o “ahorro estimado”. Los ejemplos del brief con $ se normalizan a US$ para evitar ambigüedad.',56,614,1084,21)
#28
start('12 / Iconografía','Una misma mano en todos los detalles.','20 SVG originales. Retícula 24 px · trazo 1.75 px · extremos y uniones redondos · tamaño usual 20/24 px.')
for i,k in enumerate(IC):
 x=56+(i%5)*220;y=212+(i//5)*119
 # render individual icon for book
 p=B/'icons/ui'/f'{k}.png';render(B/'icons/ui'/f'{k}.svg',p,96,96)
 pic(f'icons/ui/{k}.png',x,y,38,38);tx(k,x,y+57,14,MUT)
para('Controles solo con icono necesitan nombre accesible. No rellenar arbitrariamente los trazos para señalar selección: usar contenedor, peso de texto y aria-current.',56,690,1080,17)
#29
start('13 / Lenguaje gráfico','La abertura se convierte en espacio.','Contenedores amplios y márgenes generosos. La información mantiene prioridad sobre la decoración.')
box(56,216,510,295,INK,32);pic('logo/logo-citron.png',90,255,300,60);tx('Una vista clara.',90,390,38,'#F3F4EE',600)
box(613,216,530,295,'#FFFFFF',24);box(646,255,90,10,ACC,5);tx('Información relevante',646,304,25,INK,600);para('Jerarquía antes que ornamento.\nUna acción principal por contenedor.',646,364,450,19)
columns([('Forma e imagen','Radio 24 px en tarjetas; 12 px en controles. Fotografía cotidiana y natural si aporta contexto, sin billetes, lujo aspiracional o resultados irreales.'),('Movimiento','140 ms para estados, 220 ms para transiciones. Hito: aparición suave de 600 ms, una sola vez. Respetar reducción de movimiento.')],558,size=17)
#30
start('14 / Datos','Primero la información.','Ejemplo ficticio en PEN. Barras con cero real, etiquetas directas y unidades explícitas.')
vals=[('Vivienda',1800,L['semantic-transfer']),('Alimentación',1050,L['semantic-income']),('Otros',1350,L['semantic-debt'])]
for i,(lab,val,col) in enumerate(vals):
 y=244+i*105;tx(lab,56,y,20,INK,500);box(248,y,530*val/1800,25,col,8);tx(f'S/ {val:,}',810,y,21,INK,600)
para('Barras: orden por valor o período.\nLínea: fecha y unidad; no unir períodos faltantes.\nDonut: máximo 5 categorías + Otros; total al centro.\nProgreso: valor actual / meta y porcentaje.',56,580,510,18)
para('Presupuestos: mostrar gasto y límite, no solo color.\nIngresos vs. gastos: mismo período y moneda.\nComparación mensual: separar meses completos de parciales.\nSiempre ofrecer tabla o resumen equivalente.',637,580,510,18)
#31
page_ui('Dashboard / Light','ui/dashboard-preview.png','El flujo neto no se presenta como ahorro confirmado cuando existen movimientos por revisar.')
#32
page_ui('Dashboard / Dark','ui/dashboard-dark-preview.png','Misma jerarquía. Contraste y semánticos adaptados a superficies oscuras.',True)
#33
start('15 / Producto','La marca también cabe en la mano.','Referencia visual responsive. Mantener importes y acciones legibles a 320 px de ancho.')
pic('ui/dashboard-mobile-preview.png',104,204,229,496)
para('El estado de los datos acompaña al importe principal. Una cifra grande sin su contexto puede engañar.',489,249,605,28,INK,600)
para('La composición toma la claridad de interfaces como Wallet: superficies definidas, agrupación y lectura breve. Velsuno usa su propia marca, semántica y estructura financiera.',489,414,605,22)
para('Estas pantallas son aplicaciones de marca y no acreditan integraciones o funciones implementadas.',489,601,605,18)
#34
start('15 / Acceso','Entrada sencilla, sin promesas ocultas.','Login y registro: etiquetas persistentes, recuperación visible y condiciones accesibles.')
pic('ui/login-preview.png',56,252,526,351);pic('ui/signup-preview.png',618,252,526,351)
tx('Login',56,642,23,INK,600);tx('Signup',618,642,23,INK,600)
#35
start('15 / Control','Automatizar con permiso. Corregir con contexto.','La fuente y la incertidumbre son parte de la experiencia de marca.')
pic('ui/onboarding-preview.png',56,249,526,351);pic('ui/review-preview.png',618,249,526,351)
para('Onboarding: reenvío selectivo y ruta manual. Nunca pedir credenciales bancarias.',56,636,516,19)
para('Por revisar: monto, origen y motivo. La confirmación del usuario resuelve la duda.',618,636,516,19)
#36
page_ui('Movimientos con trazabilidad','ui/transactions-preview.png','Compra con tarjeta = gasto. Pago de tarjeta ≠ segundo gasto. Transferencia propia ≠ ingreso ordinario.')
#37
start('15 / Planes','La propuesta comercial debe ser legible.','Los ejemplos usan límites del Prompt Madre. Precio y duración final no se redefinen aquí.')
pic('ui/pricing-preview.png',56,240,526,351);pic('ui/upgrade-preview.png',618,240,526,351)
para('Free y Plus se comparan por capacidad. No vender la seguridad como privilegio.',56,635,515,19)
para('El trial explica qué pasa después. La interfaz final debe recibir términos y precios del sistema comercial.',618,635,515,19)
#38
start('15 / Continuidad','Dentro y fuera del producto.')
pic('ui/plus-active-preview.png',56,250,680,453);pic('ui/email-preview.png',825,198,320,333)
para('Plus activo: estado, renovación y gestión visibles. Cancelar no borra los datos.',825,580,320,20)
#39
start('16 / Hitos','Especial porque significa algo.','Solo después de un resultado financiero relevante y respaldado por datos suficientemente conciliados.')
pic('ui/milestone-preview.png',56,229,718,479)
para('Contenedor cítrico tenue.\nSin confeti ni medallas.\nCifra principal + comparación.\nIcono de hito o símbolo.\nUna aparición suave, opcional.\nSin audio automático.',826,261,310,22)
para('No celebrar gastos, aperturas, sincronizaciones ni cifras estimadas. Una fuente caída inhibe el hito si afecta su cálculo.',826,562,310,17)
#40
start('17 / Copy','La forma de decirlo también protege.','Texto modelo. Variables de monto, fecha, estado y plan deben venir de datos reales.')
copies=[('Bienvenida','Tu dinero, más claro. Empecemos por lo esencial.'),('Estado vacío','Aún no hay movimientos. Añade uno o configura una fuente compatible.'),('Movimiento detectado','Registramos una compra de S/ 82.50. Revisa el detalle.'),('Por revisar','Falta confirmar el tipo de este movimiento.'),('Gasto sobre referencia','Restaurantes está S/ 180 por encima de tu promedio mensual.'),('Hito de ahorro','Cerraste agosto con S/ 1,300 de ahorro, S/ 400 más que en julio.')]
y=206
for a,b in copies:
 tx(a,56,y,17,INK,600);para(b,322,y,805,19);rule(56,y+65);y+=86
#41
start('17 / Copy','Mensajes de cuenta y suscripción.')
copies2=[('Login / Signup','Entra a tu cuenta. / Crea tu cuenta Velsuno.'),('Inicio de prueba','Tu prueba de Plus está activa hasta el {fecha}. No necesitas tarjeta.'),('Fin de prueba','Tu prueba termina el {fecha}. Si no eliges Plus, seguirás en Free.'),('Upgrade / activo','Amplía tu automatización con Plus. / Plus está activo.'),('Pago confirmado','Recibimos tu pago. Consulta el detalle en tu cuenta.'),('Pago fallido','No pudimos confirmar el pago. Revisa tu método de pago.'),('Error / desconexión','No pudimos guardar el cambio. Intenta de nuevo. / Esta fuente dejó de actualizarse.'),('Recuperación','Si existe una cuenta con ese correo, recibirás instrucciones para recuperar el acceso.')]
y=198
for a,b in copies2:
 tx(a,56,y,15,INK,600);para(b,300,y,834,17);y+=65
#42
start('18 / Accesibilidad','La claridad se mide.','Contraste de la paleta verificado por cálculo. Esto no constituye una auditoría WCAG de una app implementada.')
pass_count=sum(x['pass'] for x in checks)
tx(f'{pass_count}/{len(checks)}',56,218,78,INK,600);tx('pares de contraste pasan su umbral',58,320,24,MUT)
columns([('Contraste','Texto normal ≥ 4.5:1; texto grande ≥ 3:1. Controles significativos y foco ≥ 3:1. El reporte incluye combinaciones claras, oscuras y estados.'),('Interacción','Objetivo de marca: áreas táctiles de 44 × 44 px. Navegación por teclado, foco visible de 3 px y etiquetas accesibles persistentes.')],402,size=18)
para('No depender del color. Probar zoom al 200%, reflow, lector de pantalla, teclado y reducción de movimiento en la implementación. Los bordes sutiles son decorativos, no identificadores de inputs.',56,651,1080,18)
#43
start('19 / Handoff','Una fuente para diseño y desarrollo.')
columns([('Tokens','developer/design-tokens.json y .css contienen temas, estados, tipografía, espacios y motion. Tailwind tiene un puente CSS. El JSON usa una estructura de intercambio documentada.'),('Figma','Importar los SVG como vectores. Crear colecciones Light y Dark y mapear colores por nombre. Un importador puede requerir transformación; no se entrega un archivo .fig nativo.'),('Web / Vercel','Copiar logo, favicon y OG al directorio público. Usar la tipografía incluida. Configurar metadatos con el dominio real después de verificarlo.'),('Consistencia','No modificar colores en pantallas sueltas. Cambiar el token y regenerar. Mantener nombres de activos estables y conservar la variante óptica del favicon.')],210,size=18)
#44
start('20 / Social','Una firma que resiste el recorte.','Open Graph 1200 × 630 · publicación 1080 × 1080 · avatar 1024 × 1024.')
pic('social/og-image-1200x630.png',56,254,705,370);pic('social/social-square-1080x1080.png',810,262,333,333)
para('Texto alejado del borde. Mensaje legible en miniatura. Nunca incluir saldos reales ni datos de clientes en previews públicas.',56,678,1088,18)
#45
start('21 / Evolución','La inteligencia será una capacidad.','La identidad no depende de la tecnología del momento.')
columns([('Hoy','Organiza notificaciones compatibles, clasifica mediante reglas, muestra incertidumbre y facilita correcciones. No presentar IA ni voz como ya disponibles.'),('Después','Un asistente de Velsuno podrá explicar variaciones y responder sobre datos autorizados. La marca conserva nombre, símbolo y tono.'),('Voz','Entrada natural con confirmación cuando hay ambigüedad. Monto, moneda, fecha y tipo se validan antes de escribir.'),('Límite de promesa','No asesor financiero autónomo, banco, broker ni sistema de pagos. Evitar “ahorra garantizado” y “controlamos tu dinero por ti”.')],215,size=19)
#46
start('22 / Entrega','Todo en un sistema utilizable.')
index=[('brandbook/','PDF de 48 páginas y vista general.'),('logo/','Máster, wordmark, isotipo, lockups y variantes SVG/PNG.'),('icons/','App icon, favicon óptico y 20 iconos de interfaz.'),('social/ + plus/','OG, cuadrado, avatar y firma Plus.'),('ui/','13 vistas SVG/PNG y galería HTML local.'),('developer/','Tokens, CSS, Tailwind, copy y contraste.'),('fonts/ + research/','Fuente y licencia; benchmark, naming y evidencias.'),('source/','Scripts reproducibles y decisiones de producción.')]
for i,(a,b) in enumerate(index):
 y=204+i*62;tx(a,56,y,19,INK,600);tx(b,329,y,18,MUT)
#47
start('23 / Fuentes','Investigación y límites.','Fuentes consultadas el 27/09/2026. El archivo research/sources.md contiene las URLs completas y el alcance.')
refs=[('Producto','Prompt Madre Gestor Financiero Automático Multifuente v1.1, §§ 1–4, 6–10, 17–25, 38–46, 76–88.'),('Apple Wallet','apple.com/wallet/ · referencia de concentración y lectura.'),('Copilot / Monarch / YNAB','copilot.money · monarch.com · ynab.com · automatización, planificación y método.'),('Nubank / Monzo / Revolut','Nubank Brand Refresh (10/06/2026); Monzo makeover; revolut.com.'),('Nombres','Orvilo.app; Talvioapp.com; Nuvilo en Google Play; Enlumo.ca; búsquedas de Velsuno y RDAP.'),('Accesibilidad / fuente','W3C WCAG 2.2: 1.4.3, 1.4.11, 2.5.8. Manrope: Google Fonts + OFL incluida.')]
y=207
for a,b in refs:tx(a,56,y,19,INK,600);para(b,317,y,816,18);y+=82
#48
start('24 / Estado de entrega','Diseñado para empezar. Documentado para crecer.',dark=True)
para('Identidad visual: opción 02 elegida.\nActivos: producidos y consistentes.\nContraste: pares definidos verificados.\nNombre: selección creativa con clearance pendiente.\nProducto: especificación preservada.',73,236,1060,29,'#F3F4EE',500,48)
para('Antes del lanzamiento comercial: confirmar nombre y dominio, fijar condiciones de Plus y comprobar accesibilidad e integraciones en el producto real.',73,547,1000,22,'#C1C8B8')
brand(74,666,280,ACC)
C.save();(B/'brandbook/page-index.json').write_text(json.dumps(page_titles,ensure_ascii=False,indent=2))
print('Book pages:',page)
