import base64,cairosvg,io
from PIL import Image,ImageDraw,ImageFont
O='/workspace/botmancers-brows/'
EYES=[(197,390,273,388),(470,498,545,497),(742,390,817,387)]
def brows(simple=False):
  out=[]
  for x1,y1,x2,y2 in EYES:
    for cx,cy in((x1,y1),(x2,y2)):
      if simple: out.append(f'<path d="M{cx-26} {cy-50} h52" stroke-width="22"/>')
      else: out.append(f'<path d="M{cx-23} {cy-48} h46" stroke-width="12"/>')
  return f'<g id="brows" fill="none" stroke="#40205f" stroke-linecap="round">{"".join(out)}</g>'
def logo(kind,simple=False):
  b=base64.b64encode(open(f'src/{kind}-1024.png','rb').read()).decode()
  return f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1024 1024" width="1024" height="1024"><image id="approved-logo-raster" width="1024" height="1024" xlink:href="data:image/png;base64,{b}"/>{brows(simple)}</svg>'
for k in['filled','outline']:
  open(O+f'logo-{k}.svg','w').write(logo(k))
  open(O+f'logo-{k}-16px-simplified.svg','w').write(logo(k,True))
  for s in[16,32,128,512]:
    src=logo(k,s==16)
    cairosvg.svg2png(bytestring=src.encode(),write_to=O+f'logo-{k}-{s}.png',output_width=s,output_height=s)
# avatar sheet after/before
for d in['before','after']:
  cairosvg.svg2png(url=f'{d}/sheet-examples-outline.svg',write_to=f'{d}-sheet.png',background_color='#ffffff')
import shutil,glob
for f in glob.glob('after/*.svg'): shutil.copy(f,O+'avatars/')
shutil.copy('after-sheet.png',O+'avatar-sheet-after.png')
# board
def L(p,s): return Image.open(p).convert('RGBA').resize((s,s),Image.LANCZOS)
font=ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',34)
sm=ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',20)
sizes=[512,128,32,16]
rowW=200+2*(sum(sizes)+40*4)+60
sb=Image.open('before-sheet.png');sa=Image.open('after-sheet.png')
W=max(rowW,200+sb.width+40);H=40+2*(512+70)+40+2*(sb.height+70)+40
bd=Image.new('RGBA',(W,H),'#0E120C');dr=ImageDraw.Draw(bd)
y=40
for lab,imgs in[('Before',{k:f'src/{k}-1024.png' for k in['filled','outline']}),('After',{k:O+f'logo-{k}-512.png' for k in['filled','outline']})]:
  dr.text((30,y+230),lab,font=font,fill='#d8dccf');x=200
  for k in['filled','outline']:
    for s in sizes:
      p=imgs[k] if s>=128 or lab=='Before' else O+f'logo-{k}-{s}.png'
      im=L(p,s) if lab=='Before' or s>=128 else Image.open(p).convert('RGBA')
      if lab=='After' and s==128: im=Image.open(O+f'logo-{k}-128.png').convert('RGBA')
      bd.alpha_composite(im,(x,y+512-s));dr.text((x,y+520),f'{k} {s}',font=sm,fill='#8f9488');x+=s+40
  y+=512+70
y+=20
for lab,im in[('Before',sb),('After',sa)]:
  dr.text((30,y+im.height//2),lab,font=font,fill='#d8dccf');bd.alpha_composite(im.convert('RGBA'),(200,y));y+=im.height+70
bd.convert('RGB').save(O+'before-after.png')
# zoom check strip
z=Image.new('RGB',(4*256+50,256),'#0E120C')
for i,(k,s) in enumerate([('filled',16),('outline',16),('filled',32),('outline',32)]):
  z.paste(Image.open(O+f'logo-{k}-{s}.png').convert('RGBA').resize((256,256),Image.NEAREST),(i*266,0),Image.open(O+f'logo-{k}-{s}.png').convert('RGBA').resize((256,256),Image.NEAREST))
z.save('zoom.png')
