import cairosvg
from PIL import Image,ImageDraw,ImageFont
O='/workspace/botmancers-brows/'
F='/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
font=ImageFont.truetype(F,34);sm=ImageFont.truetype(F,18)
for d in['before','after']:
  for n in['sheet-examples-outline','sheet-hands-outline']:
    cairosvg.svg2png(url=f'{d}/{n}.svg',write_to=f'{d}-{n}.png',background_color='#ffffff')
  # reach crop: first cell of hands-outline, 4x
  cairosvg.svg2png(url=f'{d}/sheet-hands-outline.svg',write_to=f'{d}-hands4x.png',scale=4,background_color='#F4F2F7')
  Image.open(f'{d}-hands4x.png').crop((4*20,4*60,4*250,4*330)).save(f'{d}-reach.png')
import shutil;shutil.copy('after-sheet-examples-outline.png',O+'avatar-sheet-after.png')
shutil.copy('after-sheet-hands-outline.png',O+'avatar-sheet-hands-after.png')
# reach-before-after
b=Image.open('before-reach.png');a=Image.open('after-reach.png')
R=Image.new('RGB',(b.width*2+120,b.height+120),'#0E120C');d=ImageDraw.Draw(R)
R.paste(b,(40,80));R.paste(a,(80+b.width,80))
d.text((40,25),'Before',font=font,fill='#D8DCCF');d.text((80+b.width,25),'After',font=font,fill='#D8DCCF');R.save(O+'reach-before-after.png')
sizes=[512,128,32,16];pad=12;gap=60
def tile(im,s):
  t=Image.new('RGBA',(s+2*pad,s+2*pad),'#F4F2F7');t.alpha_composite(im,(pad,pad));return t
W=180+2*sum(s+2*pad+gap for s in sizes)
sh={d:[Image.open(f'{d}-{n}.png').convert('RGBA') for n in['sheet-hands-outline','sheet-examples-outline']] for d in['before','after']}
H=40+2*(512+2*pad+60)+40+2*(max(i.height for i in sh['before'])+50)+20
bd=Image.new('RGBA',(W,H),'#0E120C');dr=ImageDraw.Draw(bd);y=40
for lab in['Before','After']:
  dr.text((30,y+250),lab,font=font,fill='#D8DCCF');x=180
  for k in['filled','outline']:
    for s in sizes:
      im=Image.open(f'src/{k}-1024.png').convert('RGBA').resize((s,s),Image.LANCZOS) if lab=='Before' else Image.open(O+f'logo-{k}-{s}.png').convert('RGBA')
      t=tile(im,s);bd.alpha_composite(t,(x,y+512+2*pad-t.height))
      if s>=128: dr.text((x,y+512+2*pad+8),k,font=sm,fill='#8F9488')
      dr.text((x,y+512+2*pad+30),f'{s}px',font=sm,fill='#8F9488');x+=t.width+gap
  y+=512+2*pad+60
y+=40
for lab,d in[('Before','before'),('After','after')]:
  hs,ex=sh[d];dr.text((30,y+ex.height//2-17),lab,font=font,fill='#D8DCCF')
  bd.alpha_composite(hs,(180,y));bd.alpha_composite(ex,(180+hs.width+60,y));y+=ex.height+50
bd.convert('RGB').save(O+'before-after.png')
