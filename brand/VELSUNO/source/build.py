from pathlib import Path
import json, math, re, shutil, html, io
import fitz
from PIL import Image, ImageDraw
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont as RLFont
from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor
from reportlab.lib.utils import ImageReader
B=Path('output/VELSUNO'); W=Path('work')
for weight in [400,500,600,700]:
 f=instantiateVariableFont(TTFont(W/'Manrope.ttf'),{'wght':weight},inplace=False)
 f.save(W/f'Manrope-{weight}.ttf'); pdfmetrics.registerFont(RLFont('M'+str(weight),str(W/f'Manrope-{weight}.ttf')))
FONTS={w:TTFont(W/f'Manrope-{w}.ttf') for w in [400,500,600,700]}
L={'brand-primary':'#20231F','brand-secondary':'#F6F7F2','brand-accent':'#E4EA8A','bg-primary':'#F6F7F2','bg-secondary':'#ECEEE7','surface-default':'#FFFFFF','surface-elevated':'#FFFFFF','border-subtle':'#DDE0D5','border-control':'#767B70','text-primary':'#20231F','text-secondary':'#555C50','text-muted':'#666E60','disabled-bg':'#E4E7DD','disabled-text':'#727A6B','semantic-income':'#176344','semantic-expense':'#8F4035','semantic-savings':'#326153','semantic-transfer':'#485D80','semantic-debt':'#70527D','semantic-warning':'#78540A','semantic-error':'#A82C3D','semantic-review':'#78540A','semantic-success':'#176344','status-positive-bg':'#E7F2EA','status-warning-bg':'#FBF0D3','status-error-bg':'#FCE8EC','plus-primary':'#20231F','plus-accent':'#E4EA8A','plus-bg':'#EFF2CB','trial-fg':'#485D80','trial-bg':'#EAF0F9','upgrade-bg':'#20231F','upgrade-fg':'#FFFFFF','milestone-accent':'#566122','milestone-bg':'#EFF2CB','focus-ring':'#475619','action-bg':'#20231F','action-fg':'#FFFFFF','action-hover':'#343A2F','action-pressed':'#10130F'}
D={**L,'brand-primary':'#F3F4EE','brand-secondary':'#171A16','bg-primary':'#10130F','bg-secondary':'#171A16','surface-default':'#1C201A','surface-elevated':'#282D25','border-subtle':'#394034','border-control':'#7E8974','text-primary':'#F3F4EE','text-secondary':'#C1C8B8','text-muted':'#A3AE98','disabled-bg':'#30362B','disabled-text':'#849178','semantic-income':'#8DD8AD','semantic-expense':'#F1AF9E','semantic-savings':'#ADD2B1','semantic-transfer':'#A7BDEA','semantic-debt':'#D5B9E7','semantic-warning':'#EBC571','semantic-error':'#FFA6B2','semantic-review':'#EBC571','semantic-success':'#8DD8AD','status-positive-bg':'#1B3526','status-warning-bg':'#392F17','status-error-bg':'#3D2229','plus-primary':'#F3F4EE','plus-bg':'#30371C','trial-fg':'#A7BDEA','trial-bg':'#242D41','upgrade-bg':'#E4EA8A','upgrade-fg':'#20231F','milestone-accent':'#E4EA8A','milestone-bg':'#30371C','focus-ring':'#E4EA8A','action-bg':'#E4EA8A','action-fg':'#20231F','action-hover':'#F0F3B5','action-pressed':'#CAD362'}
INK=L['text-primary']; BG=L['bg-primary']; ACC=L['brand-accent']; MUT=L['text-secondary']
def tpaths(s,x,y,size=20,color=INK,weight=400,anchor='start'):
 f=FONTS[weight]; gs=f.getGlyphSet(); cmap=f.getBestCmap(); upm=f['head'].unitsPerEm; scale=size/upm
 names=[cmap.get(ord(c),'.notdef') for c in str(s)]
 width=sum(f['hmtx'][n][0] for n in names)*scale
 if anchor=='end': x-=width
 elif anchor=='middle':x-=width/2
 out=[];pos=0
 for n in names:
  p=SVGPathPen(gs);gs[n].draw(p);out.append(f'<path d="{p.getCommands()}" transform="translate({x+pos*scale:.3f},{y}) scale({scale},-{scale})" fill="{color}"/>');pos+=f['hmtx'][n][0]
 return ''.join(out)
def rect(x,y,w,h,fill,rx=0,stroke='none',sw=1): return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}"/>'
def line(x1,y1,x2,y2,color=INK,sw=2):return f'<path d="M{x1} {y1}L{x2} {y2}" fill="none" stroke="{color}" stroke-width="{sw}"/>'
# Apertura: approved option 02; rounded square with an offset right-side opening.
PATH='M64 32L52 29V27Q52 20 45 20H27Q20 20 20 27V45Q20 52 27 52H45Q52 52 52 45V38Q52 36 54 36L64 39V46Q64 64 46 64H26Q8 64 8 46V26Q8 8 26 8H46Q64 8 64 26Z'
def mark(x,y,size,color=INK):return f'<g transform="translate({x} {y}) scale({size/72})" fill="{color}"><path d="{PATH}"/></g>'
def logo(x,y,w=250,color=INK):
 return f'<g transform="translate({x} {y}) scale({w/320})">'+mark(0,0,64,color)+tpaths('velsuno',82,49,49,color,600)+'</g>'
def svg(w,h,body,title='Velsuno'):
 return f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}" role="img"><title>{html.escape(title)}</title>{body}</svg>'
def save_svg(path,w,h,body,title='Velsuno',png=False,scale=1):
 p=B/path;p.write_text(svg(w,h,body,title),encoding='utf8')
 if png: render(p,p.with_suffix('.png'),w*scale,h*scale)
 return p

def render(src,dst,w=None,h=None):
 doc=fitz.open(str(src)); pdf=fitz.open('pdf',doc.convert_to_pdf()); page=pdf[0]
 sc=(w/page.rect.width) if w else 1
 pix=page.get_pixmap(matrix=fitz.Matrix(sc,sc),alpha=True);Path(dst).write_bytes(pix.tobytes('png'));return dst

# Production logos: paths only, no external fonts or images.
for name,col in [('primary',INK),('black','#000000'),('white','#FFFFFF'),('citron',ACC)]:
 save_svg(f'logo/logo-{name}.svg',640,128,logo(0,0,640,col),png=True,scale=2)
save_svg('logo/wordmark.svg',485,108,tpaths('velsuno',0,86,97,INK,600),png=True,scale=2)
save_svg('logo/isotipo.svg',72,72,mark(0,0,72),png=True,scale=16)
save_svg('logo/lockup-horizontal.svg',640,128,logo(0,0,640))
save_svg('logo/lockup-vertical.svg',320,270,mark(110,10,100)+tpaths('velsuno',160,190,64,INK,600,'middle')+tpaths('Tu dinero, más claro.',160,237,21,MUT,500,'middle'),png=True,scale=2)
for s,n in [(1024,'app-icon-1024'),(512,'app-icon-512'),(192,'app-icon-192'),(180,'apple-touch-icon')]:
 save_svg(f'icons/{n}.svg',s,s,rect(0,0,s,s,INK)+mark(s*.19,s*.19,s*.62,ACC),png=True)
# Optical favicon: larger right-hand opening and near-square inner counter.
small='M29 13L23 12V11Q23 9 21 9H11Q9 9 9 11V21Q9 23 11 23H21Q23 23 23 21V17L29 18V22Q29 29 22 29H10Q3 29 3 22V10Q3 3 10 3H22Q29 3 29 10Z'
save_svg('icons/favicon.svg',32,32,rect(0,0,32,32,INK,7)+f'<path d="{small}" fill="{ACC}"/>')
render(B/'icons/favicon.svg',B/'icons/favicon-32x32.png',32,32)
render(B/'icons/favicon.svg',B/'icons/favicon-16x16.png',16,16)
for size in [64,96]:render(B/'icons/favicon.svg',B/f'icons/favicon-{size}x{size}.png',size,size)
Image.open(B/'icons/favicon-32x32.png').save(B/'icons/favicon.ico',sizes=[(16,16),(32,32)])
save_svg('social/avatar.svg',1024,1024,rect(0,0,1024,1024,INK)+mark(225,225,574,ACC),png=True)
save_svg('plus/plus-badge.svg',104,40,rect(0,0,104,40,ACC,20)+tpaths('PLUS',52,26,17,INK,700,'middle'),png=True,scale=4)
save_svg('plus/plus-mark.svg',400,100,logo(0,13,280)+rect(295,25,96,38,ACC,19)+tpaths('PLUS',343,50,16,INK,700,'middle'),png=True,scale=3)

# Compact, custom interface icons, stroke 1.75 on 24 px grid.
IC={
 'income':'M12 3V17M7 12L12 17L17 12M4 20H20',
 'expense':'M12 18V4M7 9L12 4L17 9M4 21H20',
 'transfer':'M4 7H20L16 3M20 17H4L8 21',
 'cards':'M3 5H21V19H3ZM3 10H21M7 15H11',
 'institutions':'M3 8L12 3L21 8ZM5 11V18M12 11V18M19 11V18M3 21H21',
 'alerts':'M5 17V10C5 1 19 1 19 10V17H5ZM9 21H15',
 'analytics':'M4 3V21H21M8 16V12M13 16V8M18 16V5',
 'plus':'M12 4V20M4 12H20',
 'categories':'M3 3H10V10H3ZM14 3H21V10H14ZM3 14H10V21H3ZM14 14H21V21H14Z',
 'review':'M12 3L22 21H2ZM12 9V14M12 17V18',
 'milestone':'M4 9V4H9M15 4H20V9M20 15V20H15M9 20H4V15M8 12L11 15L17 9',
 'check':'M4 12L10 18L21 5',
 'home':'M3 10L12 3L21 10V21H3ZM9 21V14H15V21',
 'connections':'M8 4H16V11Q16 15 12 15Q8 15 8 11ZM10 1V4M14 1V4M12 15V21',
 'settings':'M5 5H19M5 12H19M5 19H19M9 3V7M15 10V14M10 17V21',
 'debt':'M6 3H18V21L15 19L12 21L9 19L6 21ZM9 8H15M9 12H15',
 'arrow-right':'M4 12H20M14 6L20 12L14 18',
 'lock':'M6 10H18V21H6ZM8 10V7C8 1 16 1 16 7V10',
 'search':'M18 18L22 22M19 10A9 9 0 1 1 1 10A9 9 0 1 1 19 10',
 'mail':'M3 5H21V19H3ZM3 5L12 13L21 5',
}
def icon(name,x,y,size=24,col=INK):return f'<g transform="translate({x} {y}) scale({size/24})"><path d="{IC[name]}" stroke="{col}" stroke-width="1.75" fill="none" stroke-linejoin="round" stroke-linecap="round"/></g>'
for name in IC:save_svg(f'icons/ui/{name}.svg',24,24,icon(name,0,0))
(B/'icons/ui/sprite.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg">'+''.join(f'<symbol id="{k}" viewBox="0 0 24 24"><path d="{v}" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/></symbol>' for k,v in IC.items())+'</svg>')

# Tokens: two intentionally separate theme maps.
TYPE={'display':[56,64,600],'h1':[36,44,600],'h2':[28,36,600],'h3':[22,30,600],'body':[16,24,400],'small':[14,20,400],'caption':[12,16,500],'numeric-xl':[48,56,600],'numeric-large':[32,40,600],'numeric-small':[16,24,600],'button':[16,24,600],'label':[14,20,600]}
T={'$schema':'https://www.designtokens.org/schemas/2025.10/format.json','brand':{'name':'Velsuno','version':'1.0','status':'Design system delivered; naming legal clearance pending'},'light':{k:{'$type':'color','$value':v} for k,v in L.items()},'dark':{k:{'$type':'color','$value':v} for k,v in D.items()},'typography':{k:{'$type':'typography','$value':{'fontFamily':'Manrope','fontSize':{'value':v[0],'unit':'px'},'lineHeight':v[1]/v[0],'fontWeight':v[2],'letterSpacing':{'value':0,'unit':'px'}}} for k,v in TYPE.items()},'space':{str(x):{'$type':'dimension','$value':{'value':x,'unit':'px'}} for x in [4,8,12,16,24,32,48,64]},'radius':{'control':12,'card':24,'compact':16,'pill':999},'motion':{'fast_ms':140,'standard_ms':220,'milestone_ms':600,'easing':'cubic-bezier(.2,0,0,1)'},'data':{'light':['#20231F','#326153','#485D80','#8F4035','#70527D','#78540A'],'dark':['#E4EA8A','#8DD8AD','#A7BDEA','#F1AF9E','#D5B9E7','#EBC571']}}
# This JSON is a flat bridge for Figma/Style Dictionary; no unsupported schema compliance claim.
T.pop('$schema'); (B/'developer/design-tokens.json').write_text(json.dumps(T,indent=2,ensure_ascii=False))
css='@font-face{font-family:Manrope;src:url("../fonts/Manrope-variable.ttf") format("truetype");font-weight:200 800;font-display:swap;}\n'
for sel,m in [(':root, [data-theme="light"]',L),('[data-theme="dark"]',D)]:css+=sel+'{\n'+''.join(f'  --{k}: {v};\n' for k,v in m.items())+'}\n'
css+=':root{--font-sans:Manrope,system-ui,sans-serif;--radius-card:24px;--radius-control:12px;--radius-pill:999px;--duration-fast:140ms;--duration-standard:220ms;--duration-milestone:600ms;--ease-standard:cubic-bezier(.2,0,0,1);--shadow-card:0 8px 28px #20231F0A;}\n'
css+=':root{'+''.join(f'--space-{x}:{x}px;' for x in [4,8,12,16,24,32,48,64])+'}\n'
for k,v in TYPE.items(): css+=f'.type-{k}'+'{'+f'font-family:var(--font-sans);font-size:{v[0]}px;line-height:{v[1]}px;font-weight:{v[2]};'+'}\n'
css+='body{font-family:var(--font-sans);background:var(--bg-primary);color:var(--text-primary)}\n.numeric{font-variant-numeric:tabular-nums lining-nums;}\na{color:inherit;text-decoration:underline;text-underline-offset:3px;}\n:focus-visible{outline:3px solid var(--focus-ring);outline-offset:3px;}\nbutton,input,select{min-height:44px;font:inherit;}\n.button-primary{background:var(--action-bg);color:var(--action-fg);border:0;border-radius:var(--radius-control);padding:12px 24px;}\n.button-primary:hover{background:var(--action-hover)}\n.button-primary:active{background:var(--action-pressed)}\nbutton:disabled{background:var(--disabled-bg);color:var(--disabled-text);cursor:not-allowed;}\n@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:0.01ms!important;transition-duration:0.01ms!important;scroll-behavior:auto!important;}}\n'
(B/'developer/design-tokens.css').write_text(css)
(B/'developer/tailwind-theme.css').write_text('/* Tailwind v4: import design-tokens.css first, then this file. */\n@theme inline {\n --color-background:var(--bg-primary);\n --color-surface:var(--surface-default);\n --color-foreground:var(--text-primary);\n --color-muted:var(--text-secondary);\n --color-brand:var(--brand-primary);\n --color-accent:var(--brand-accent);\n --color-income:var(--semantic-income);\n --color-expense:var(--semantic-expense);\n --color-review:var(--semantic-review);\n --color-error:var(--semantic-error);\n --font-sans:Manrope,system-ui,sans-serif;\n --radius-card:24px;\n}\n')
# contrast report, exact ratios; decorative borders excluded.
def lum(h):
 vals=[int(h[i:i+2],16)/255 for i in [1,3,5]]
 vals=[v/12.92 if v<=.04045 else ((v+.055)/1.055)**2.4 for v in vals]
 return sum(a*b for a,b in zip(vals,[.2126,.7152,.0722]))
def contrast(a,b):
 x,y=sorted([lum(a),lum(b)],reverse=True);return (x+.05)/(y+.05)
checks=[]
for theme,m in [('light',L),('dark',D)]:
 for fg in ['text-primary','text-secondary','text-muted']+[k for k in m if k.startswith('semantic-')]:
  for bg in ['bg-primary','surface-default','surface-elevated']:
   checks.append({'theme':theme,'foreground':fg,'background':bg,'ratio':round(contrast(m[fg],m[bg]),3),'required':4.5,'pass':contrast(m[fg],m[bg])>=4.5})
 for fg,bg,ratio in [('action-fg','action-bg',4.5),('semantic-warning','status-warning-bg',4.5),('semantic-error','status-error-bg',4.5),('semantic-success','status-positive-bg',4.5),('text-primary','plus-bg',4.5),('milestone-accent','milestone-bg',4.5),('trial-fg','trial-bg',4.5),('border-control','surface-default',3),('focus-ring','bg-primary',3),('focus-ring','surface-elevated',3)]:
  checks.append({'theme':theme,'foreground':fg,'background':bg,'ratio':round(contrast(m[fg],m[bg]),3),'required':ratio,'pass':contrast(m[fg],m[bg])>=ratio})
(B/'developer/contrast-report.json').write_text(json.dumps(checks,indent=2))
print('Contrast checks',len(checks),'fails',[x for x in checks if not x['pass']])
# SVG UI applications. All amounts fictional; source health is visible.
def txt(s,x,y,size=18,col=INK,weight=400,anchor='start'):return tpaths(s,x,y,size,col,weight,anchor)
def wrap(s,x,y,w=500,size=18,col=INK,weight=400,leading=None):
 words=s.split();rows=[];row='';leading=leading or size*1.5
 for word in words:
  q=(row+' '+word).strip()
  if pdfmetrics.stringWidth(q,'M'+str(weight),size)>w and row:rows.append(row);row=word
  else:row=q
 if row:rows.append(row)
 return ''.join(txt(q,x,y+i*leading,size,col,weight) for i,q in enumerate(rows))
def pill(s,x,y,m,kind='neutral',w=150):
 bg=m['bg-secondary'];fg=m['text-secondary']
 if kind=='review':bg=m['status-warning-bg'];fg=m['semantic-review']
 if kind=='success':bg=m['status-positive-bg'];fg=m['semantic-success']
 if kind=='plus':bg=m['plus-bg'];fg=m['text-primary']
 return rect(x,y,w,34,bg,17)+txt(s,x+w/2,y+23,14,fg,600,'middle')
def btn(s,x,y,w=200,m=L,secondary=False):
 return rect(x,y,w,48,m['surface-default'] if secondary else m['action-bg'],12,m['border-control'] if secondary else 'none')+txt(s,x+w/2,y+31,16,m['text-primary'] if secondary else m['action-fg'],600,'middle')
def field(label,val,x,y,w=390,m=L):return txt(label,x,y,14,m['text-secondary'],600)+rect(x,y+12,w,52,m['surface-default'],12,m['border-control'])+txt(val,x+16,y+45,16,m['text-primary'])
def card(x,y,w,h,m=L):return rect(x,y,w,h,m['surface-default'],24)
def shell(title,subtitle='',theme='light',active='Resumen',period='Septiembre 2026'):
 m=D if theme=='dark' else L
 s=rect(0,0,1440,960,m['bg-primary'])+rect(0,0,252,960,m['surface-default'])+logo(32,34,180,m['text-primary'])
 nav=[('Resumen','home'),('Movimientos','transfer'),('Por revisar','review'),('Cuentas y tarjetas','cards'),('Deudas','debt'),('Análisis','analytics'),('Conexiones','connections'),('Ajustes','settings')]
 for i,(n,ic) in enumerate(nav):
  y=150+i*62
  if n==active:s+=rect(20,y-32,212,48,m['plus-bg'],12)
  s+=icon(ic,34,y-23,22,m['text-primary'] if n==active else m['text-secondary'])+txt(n,70,y-5,16,m['text-primary'] if n==active else m['text-secondary'],600 if n==active else 400)
 s+=pill('PLUS',34,811,m,'plus',74)+txt('Cuenta de muestra',34,892,14,m['text-secondary'])
 s+=txt(title,300,87,34,m['text-primary'],600)+txt(subtitle,300,123,16,m['text-secondary'])+pill(period,1200,62,m,w=190)
 s+=txt('Vista de marca · datos ficticios · integraciones sujetas a cobertura validada',300,925,12,m['text-muted'])
 return s,m

def dashboard(theme='light'):
 s,m=shell('Tu mes, más claro.','Datos al 27 de septiembre · 10:42 a. m.',theme)
 s+=card(300,168,688,242,m)+txt('Flujo neto del mes · PEN',330,211,17,m['text-secondary'],500)+txt('S/ 1,300.00',330,275,54,m['text-primary'],600)+txt('Ingresos menos gastos registrados',330,314,16,m['text-secondary'])
 s+=pill('!  Datos parciales',330,343,m,'review',174)+txt('2 movimientos por revisar',520,366,15,m['text-secondary'])
 s+=card(1012,168,380,242,m)+txt('Próximo pago',1042,211,17,m['text-secondary'],500)+txt('S/ 480.00',1042,270,36,m['text-primary'],600)+txt('Tarjeta BCP · •••• 4821',1042,310,16,m['text-secondary'])+txt('Vence el 30 de septiembre',1042,344,16,m['text-secondary'])+txt('Ver tarjeta →',1042,381,16,m['text-primary'],600)
 for x,label,value,sem,ic in [(300,'Ingresos','S/ 5,500.00','income','income'),(672,'Gastos','S/ 4,200.00','expense','expense'),(1044,'Ahorro estimado','S/ 1,300.00','savings','analytics')]:
  s+=card(x,434,348,139,m)+icon(ic,x+25,460,23,m['semantic-'+sem])+txt(label,x+62,479,16,m['text-secondary'])+txt(value,x+25,532,30,m['text-primary'],600)
 s+=card(300,598,688,280,m)+txt('En qué se fue tu dinero',328,639,22,m['text-primary'],600)+txt('Gastos registrados · PEN',328,666,14,m['text-secondary'])
 for i,(lab,val,col) in enumerate([('Vivienda',1800,m['semantic-transfer']),('Alimentación',1050,m['semantic-income']),('Otros',1350,m['semantic-debt'])]):
  y=710+i*61;s+=txt(lab,328,y,15,m['text-secondary'])+rect(475,y-17,360*val/1800,14,col,7)+txt(f'S/ {val:,}',958,y,16,m['text-primary'],600,'end')
 s+=card(1012,598,380,280,m)+txt('Necesita tu atención',1040,639,22,m['text-primary'],600)+wrap('Confirma 2 movimientos para completar el resumen.',1040,685,306,18,m['text-secondary'])+btn('Revisar movimientos',1040,789,324,m)
 return s
save_svg('ui/dashboard-preview.svg',1440,960,dashboard(),png=True)
save_svg('ui/dashboard-dark-preview.svg',1440,960,dashboard('dark'),png=True)

# Account entry screens.
for mode in ['login','signup']:
 m=L;s=rect(0,0,1440,960,BG)+rect(0,0,656,960,INK)+logo(64,60,248,ACC)+mark(95,266,230,ACC)
 s+=txt('Menos registrar.',64,600,45,'#F3F4EE',600)+txt('Más entender.',64,660,45,'#F3F4EE',600)+wrap('Tu actividad financiera, organizada para ver lo que importa.',64,723,510,21,'#C1C8B8')
 s+=txt('Bienvenido de nuevo.' if mode=='login' else 'Empieza con claridad.',798,230,34,INK,600)
 s+=txt('Entra a tu cuenta.' if mode=='login' else 'Crea tu cuenta Velsuno.',798,271,18,MUT)
 y=337
 if mode=='signup':s+=field('Nombre','Alex',798,y);y+=100
 s+=field('Correo electrónico','alex@example.com',798,y);y+=100
 s+=field('Contraseña','••••••••••••',798,y);y+=100
 s+=btn('Entrar' if mode=='login' else 'Crear cuenta',798,y,390)
 s+=txt('Recuperar contraseña' if mode=='login' else 'Al continuar, aceptas Términos y Privacidad.',798,y+87,14,MUT,500)
 s+=txt('¿Aún no tienes cuenta? Crear cuenta' if mode=='login' else '¿Ya tienes cuenta? Entrar',798,y+128,15,INK,600)
 s+=txt('Vista de marca · formulario de ejemplo',798,890,12,L['text-muted'])
 save_svg(f'ui/{mode}-preview.svg',1440,960,s,png=True)

s,m=shell('Elige cómo empezar.','Paso 1 de 3 · Tus datos, bajo tu control',active='Conexiones')
s+=card(300,180,1092,590)+txt('Recibe tus movimientos por correo',340,242,30,INK,600)+wrap('Configura el reenvío selectivo de notificaciones bancarias a tu dirección privada. La cobertura depende del banco y del formato del mensaje.',340,289,890,19,MUT)
s+=rect(340,380,1000,105,BG,16)+icon('mail',366,413,30)+txt('Solo notificaciones financieras',420,420,19,INK,600)+txt('No necesitamos leer toda tu bandeja de entrada.',420,454,17,MUT)
s+=rect(340,507,1000,90,BG,16)+icon('lock',366,535,30)+txt('Sin contraseñas bancarias',420,545,19,INK,600)+txt('Nunca te pediremos PIN, CVV ni códigos de seguridad.',420,577,17,MUT)
s+=btn('Configurar correo',340,654,270)+btn('Empezar manualmente',635,654,280,secondary=True)
s+=txt('Gmail, SMS y nuevas fuentes aparecerán cuando estén disponibles y verificadas.',340,825,16,MUT)
save_svg('ui/onboarding-preview.svg',1440,960,s,png=True)

s,m=shell('Movimientos','Lo que ocurrió, con su origen visible.',active='Movimientos')
s+=btn('Añadir movimiento',1160,157,230)+pill('Todas las cuentas',300,165,m,w=188)+pill('PEN',504,165,m,w=80)
s+=card(300,224,1092,616)
s+=txt('Movimiento',330,271,14,MUT,600)+txt('Categoría / tipo',724,271,14,MUT,600)+txt('Importe',1350,271,14,MUT,600,'end')
rows=[('Supermercado de ejemplo','Automático · Email · BCP •••• 4821','Alimentación','−S/ 182.40','expense'),('Abono de sueldo','Automático · Email · BCP','Ingreso','+S/ 5,500.00','income'),('Pago de tarjeta','Automático · Email · BCP','Pago de tarjeta','S/ 480.00','transfer'),('Transferencia propia','Confirmado · BCP → BBVA','Transferencia interna','S/ 300.00','transfer'),('Movimiento sin categoría','Automático · Email · Por revisar','Por revisar','−S/ 65.00','review')]
for i,(lab,sub,cat,amt,se) in enumerate(rows):
 y=330+i*101;s+=icon(se if se in IC else 'cards',331,y-19,24,m['semantic-'+se])+txt(lab,378,y,19,INK,600)+txt(sub,378,y+30,14,MUT)+txt(cat,724,y+5,15,m['semantic-'+se],500)+txt(amt,1350,y+5,21,INK,600,'end')
 if i<4:s+=line(330,y+57,1360,y+57,L['border-subtle'],1)
save_svg('ui/transactions-preview.svg',1440,960,s,png=True)

s,m=shell('Por revisar','Confirma lo que falta. Conservamos el origen de cada dato.',active='Por revisar')
s+=card(300,180,666,633)+pill('!  Requiere revisión',330,211,m,'review',196)+txt('¿Qué tipo de movimiento es?',330,300,28,INK,600)+txt('S/ 65.00',330,362,48,INK,600)+txt('27 sep · 10:24 a. m. · PEN',330,403,16,MUT)
s+=field('Tipo de movimiento','Seleccionar tipo',330,458,604)+field('Categoría','Sin asignar',330,555,604)
s+=btn('Guardar corrección',330,688,273)+btn('Ignorar evento',625,688,309,secondary=True)
s+=card(990,180,402,633)+txt('Datos del origen',1018,241,24,INK,600)
for i,(k,v) in enumerate([('Institución','BCP'),('Canal','Email'),('Monto detectado','S/ 65.00'),('Estado','Sin resolver'),('Motivo','Tipo no identificado')]):
 y=300+i*82;s+=txt(k,1018,y,14,MUT)+txt(v,1018,y+30,18,INK,500)
s+=wrap('Tus correcciones quedan registradas. Un dato dudoso no se confirma automáticamente.',1018,741,340,15,MUT)
save_svg('ui/review-preview.svg',1440,960,s,png=True)

s,m=shell('Un cierre que cuenta.','Agosto 2026 · Período conciliado',active='Resumen',period='Agosto 2026')
s+=rect(365,184,960,589,L['milestone-bg'],32)+mark(780,222,104,INK)+txt('Un mes de progreso.',845,395,39,INK,600,'middle')+txt('S/ 1,300.00',845,474,61,INK,600,'middle')+txt('de ahorro confirmado',845,521,21,MUT,500,'middle')+txt('S/ 400 más que en julio.',845,569,22,INK,500,'middle')+btn('Ver cierre de agosto',662,653,366)
s+=txt('Se muestra solo con datos suficientes y cálculos de alta confianza.',365,832,16,MUT)
save_svg('ui/milestone-preview.svg',1440,960,s,png=True)

s,m=shell('Una marca. Dos capacidades.','Elige el plan que acompaña tu forma de organizarte.',active='Ajustes')
for x,label,desc,items in [(300,'Free','Para empezar a ver tu mes.',['Registro manual sin límite artificial','1 institución activa','50 movimientos automáticos al mes','Historial visible: 3 meses','Correcciones y exportación básica']), (858,'Plus','Más automatización y perspectiva.',['Hasta 3 instituciones activas','Automatización ampliada','Historial financiero completo','Comparaciones e insights avanzados','Reglas y alertas avanzadas'])]:
 s+=card(x,184,532,660)+pill(label.upper(),x+32,216,m,'plus' if label=='Plus' else 'neutral',94)+txt(desc,x+32,312,23,INK,600)
 s+=txt('Gratis' if label=='Free' else 'Precio por definir',x+32,376,34,INK,600)
 for i,item in enumerate(items):s+=icon('check',x+32,420+i*59,20,L['semantic-income'])+txt(item,x+69,437+i*59,16,INK)
 s+=btn('Continuar con Free' if label=='Free' else 'Conocer Plus',x+32,746,468,secondary=label=='Free')
s+=txt('Límites iniciales configurables · Plus: tarifa y periodicidad pendientes de decisión.',300,886,14,MUT)
save_svg('ui/pricing-preview.svg',1440,960,s,png=True)

for mode in ['upgrade','plus-active']:
 s,m=shell('Tu plan', 'Capacidad adicional, con condiciones claras.',active='Ajustes')
 s+=card(350,184,1000,632)+pill('PLUS',390,222,m,'plus',96)
 if mode=='upgrade':
  s+=txt('Más espacio para tu vida financiera.',390,331,32,INK,600)+wrap('Amplía la automatización y compara tu evolución con el historial completo.',390,383,790,22,MUT)
  s+=txt('Prueba de ejemplo: 14 días, sin tarjeta.',390,478,22,INK,600)+wrap('Al terminar, sigues en Free si no eliges Plus. Tus datos se conservan.',390,522,790,18,MUT)
  s+=btn('Ver condiciones de Plus',390,665,405)+btn('Seguir con Free',820,665,480,secondary=True)
 else:
  s+=txt('Plus está activo.',390,331,38,INK,600)+txt('Tienes acceso a tus funciones de Plus.',390,383,22,MUT)
  for i,(a,b) in enumerate([('Estado','Suscripción activa'),('Próxima renovación','27 de octubre de 2026'),('Instituciones activas','2 de 3')]):
   y=460+i*58;s+=txt(a,390,y,17,MUT)+txt(b,1040,y,18,INK,600,'end')
  s+=btn('Gestionar suscripción',390,665,405)+txt('Puedes cancelar desde tu cuenta.',820,695,17,MUT)
 s+=txt('Ejemplo visual: mostrar precio, fecha y condiciones reales desde la configuración comercial.',350,869,14,MUT)
 save_svg(f'ui/{mode}-preview.svg',1440,960,s,png=True)

s=rect(0,0,1000,1040,BG)+logo(190,72,235)+rect(170,168,660,690,'#FFFFFF',24)+pill('CIERRE MENSUAL',214,210,L,w=188)+txt('Tu agosto, más claro.',214,315,37,INK,600)+wrap('Tu cierre está listo. Aquí tienes el dato principal del mes.',214,367,566,20,MUT)+rect(214,450,572,155,L['milestone-bg'],20)+txt('Ahorro confirmado',242,496,17,MUT)+txt('S/ 1,300.00',242,563,47,INK,600)+txt('S/ 400 más que en julio.',214,659,21,INK,500)+btn('Ver mi cierre',214,711,572)+txt('Consulta el detalle entrando a tu cuenta.',214,813,15,MUT)+txt('Velsuno · Tu dinero, más claro.',190,927,15,MUT)+txt('Preferencias de notificaciones · Ejemplo con datos ficticios',190,962,13,MUT)
save_svg('ui/email-preview.svg',1000,1040,s,png=True)

# Mobile dashboard design, original layout; no bank-card imitation.
s=rect(0,0,390,844,BG)+logo(24,30,150)+txt('Tu mes,',24,130,33,INK,600)+txt('más claro.',24,170,33,INK,600)+txt('Septiembre 2026 · PEN',24,204,14,MUT)
s+=rect(16,236,358,238,INK,26)+txt('Flujo neto del mes',40,278,16,'#C1C8B8')+txt('S/ 1,300.00',40,335,41,'#F3F4EE',600)+rect(40,365,220,32,ACC,16)+txt('!  Datos parciales',150,387,14,INK,600,'middle')+txt('2 movimientos por revisar',40,436,15,'#C1C8B8')
for x,lab,val in [(16,'Ingresos','S/ 5,500'),(204,'Gastos','S/ 4,200')]:s+=rect(x,490,170,123,'#FFFFFF',22)+txt(lab,x+19,529,15,MUT)+txt(val,x+19,579,26,INK,600)
s+=rect(16,633,358,99,'#FFFFFF',22)+icon('review',35,663,25,L['semantic-review'])+txt('Completa tu resumen',75,671,17,INK,600)+txt('Revisar 2 movimientos →',75,704,14,MUT)
s+=rect(0,767,390,77,'#FFFFFF')
for x,ic,lab in [(39,'home','Inicio'),(137,'transfer','Movimientos'),(239,'review','Revisar'),(333,'settings','Cuenta')]:s+=icon(ic,x-11,780,22)+txt(lab,x,826,10,INK,500,'middle')
save_svg('ui/dashboard-mobile-preview.svg',390,844,s,png=True,scale=2)

# Social exports with fixed, requested dimensions.
s=rect(0,0,1200,630,INK)+logo(62,54,280,ACC)+txt('Tu dinero,',62,260,67,'#F3F4EE',600)+txt('más claro.',62,343,67,'#F3F4EE',600)+wrap('Menos registro manual. Más perspectiva sobre tu mes.',62,416,620,25,'#C1C8B8')+txt('Finanzas personales',62,567,18,'#C1C8B8')+rect(812,92,318,422,ACC,40)+mark(874,166,194,INK)+txt('Ver.',971,406,36,INK,600,'middle')+txt('Entender.',971,458,36,INK,600,'middle')
save_svg('social/og-image-1200x630.svg',1200,630,s,png=True)
s=rect(0,0,1080,1080,BG)+logo(70,67,285)+txt('Tu dinero,',70,340,89,INK,600)+txt('más claro.',70,449,89,INK,600)+rect(70,537,940,395,INK,44)+mark(130,595,185,ACC)+wrap('Menos registro manual. Más perspectiva sobre tu mes.',370,639,565,39,'#F3F4EE',500)+txt('Velsuno · Finanzas personales',70,1015,23,MUT)
save_svg('social/social-square-1080x1080.svg',1080,1080,s,png=True)
print('Visual assets produced')
