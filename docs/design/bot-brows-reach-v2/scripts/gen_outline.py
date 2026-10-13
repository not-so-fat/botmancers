
import cairosvg,re
exec(open('gen.py').read().split('def sheet')[0])
SW=4
def st(c,w=SW): return f'fill="none" stroke="{c}" stroke-width="{w}" stroke-linecap="round" stroke-linejoin="round"'
def eyes_o(k,c):
  s=st(c,3.5)
  if k=="round": return f'<circle cx="84" cy="88" r="8" {s}/><circle cx="116" cy="88" r="8" {s}/><path d="M93 103 q7 6 14 0" {s}/>'
  if k=="sleepy": return f'<path d="M75 88 a9 9 0 0 0 18 0Z M107 88 a9 9 0 0 0 18 0Z" {s}/><path d="M95 104 h10" {s}/>'
  if k=="happy": return f'<path d="M76 92 q8 -12 16 0 M108 92 q8 -12 16 0" {st(c,4.5)}/><path d="M92 102 q8 9 16 0" {s}/>'
  if k=="wide": return f'<ellipse cx="84" cy="88" rx="7" ry="11" {s}/><ellipse cx="116" cy="88" rx="7" ry="11" {s}/><circle cx="100" cy="108" r="3" {s}/>'
def arms(k,attr):
  if k=="reach": return f'<rect x="96" y="118" width="86" height="15" rx="7.5" {attr}/><rect x="96" y="140" width="86" height="15" rx="7.5" {attr}/>'
  if k=="wave": return f'<rect x="96" y="132" width="70" height="15" rx="7.5" {attr}/><g transform="rotate(-55 150 120)"><rect x="140" y="112" width="60" height="15" rx="7.5" {attr}/></g>'
  if k=="fold": return f'<g transform="rotate(14 100 140)"><rect x="56" y="132" width="88" height="16" rx="8" {attr}/></g><g transform="rotate(-14 100 140)"><rect x="56" y="132" width="88" height="16" rx="8" {attr}/></g>'
def acc_o(k,c):
  s=st(c,3)
  if k=="none": return ""
  if k=="crown": return f'<path d="M78 42 L76 18 L89 30 L100 12 L111 30 L124 18 L122 42Z" {s}/><circle cx="100" cy="32" r="3" {s}/>'
  if k=="glasses": return f'<g {s}><circle cx="84" cy="88" r="14"/><circle cx="116" cy="88" r="14"/><path d="M98 88 h4"/></g>'
  if k=="headset": return f'<path d="M56 92 C56 30 144 30 144 92" {st(c,4)}/><rect x="48" y="82" width="14" height="24" rx="6" {s}/><rect x="138" y="82" width="14" height="24" rx="6" {s}/><path d="M55 106 q4 16 24 12" {s}/><circle cx="83" cy="118" r="4" {s}/>'
  if k=="hat": return f'<ellipse cx="100" cy="44" rx="44" ry="8" {s}/><path d="M77 37 L80 12 Q100 6 120 12 L123 37" {s}/><path d="M77 37 h46" {s}/>'
  if k=="bow": return f'<g transform="translate(120 42) rotate(20)"><path d="M-6 -3 L-20 -12 Q-24 0 -20 12 L-6 3 M6 -3 L20 -12 Q24 0 20 12 L6 3" {s}/><circle r="6" {s}/></g>'
N=[0]
def bot_o(color="purple",eye="round",hand="fold",a="none"):
  c=C[color][0];N[0]+=1;m=f"m{N[0]}"
  # mask hides body/eye lines beneath arms and accessory so overlaps read cleanly with no fill
  hide=arms(hand,'fill="black" stroke="black" stroke-width="10"')
  ahide={"crown":'<path d="M78 42 L76 18 L89 30 L100 12 L111 30 L124 18 L122 42Z" fill="black" stroke="black" stroke-width="8"/>',
   "hat":'<ellipse cx="100" cy="44" rx="44" ry="8" fill="black" stroke="black" stroke-width="8"/><path d="M77 44 L80 12 Q100 6 120 12 L123 44Z" fill="black"/>'}.get(a,"")
  mk=f'<mask id="{m}" maskUnits="userSpaceOnUse" x="-20" y="-20" width="240" height="240"><rect x="-20" y="-20" width="240" height="240" fill="white"/>{hide}{ahide}</mask>'
  # arm 2 hides arm 1 for folded crossing
  am=""
  if hand=="fold":
    am=f'<mask id="{m}a" maskUnits="userSpaceOnUse" x="-20" y="-20" width="240" height="240"><rect x="-20" y="-20" width="240" height="240" fill="white"/><g transform="rotate(-14 100 140)"><rect x="56" y="132" width="88" height="16" rx="8" fill="black" stroke="black" stroke-width="10"/></g></mask>'
    ar=f'<g mask="url(#{m}a)"><g transform="rotate(14 100 140)"><rect x="56" y="132" width="88" height="16" rx="8" {st(c,3.5)}/></g></g><g transform="rotate(-14 100 140)"><rect x="56" y="132" width="88" height="16" rx="8" {st(c,3.5)}/></g>'
  else: ar=arms(hand,st(c,3.5))
  return f'<defs>{mk}{am}</defs><g mask="url(#{m})"><g id="body"><path d="{BODY}" {st(c)}/></g><g id="eyes">{brows(eye,c,5.5)}{eyes_o(eye,c)}</g></g><g id="hands">{ar}</g><g id="accessory">{acc_o(a,c)}</g>'
def sheet(name,title,items,cols=4):
  W,H=230,260;rows=(len(items)+cols-1)//cols
  out=[f'<svg xmlns="http://www.w3.org/2000/svg" width="{cols*W+40}" height="{rows*H+90}"><text x="30" y="50" font-family="Asap" font-size="28" font-weight="700" fill="#8a8a99">{title}</text>']
  for i,(lab,kw) in enumerate(items):
    x=20+(i%cols)*W;y=70+(i//cols)*H
    out.append(f'<g transform="translate({x+15} {y+5})">{bot_o(**kw)}</g><text x="{x+W/2}" y="{y+H-32}" text-anchor="middle" font-family="Asap" font-size="17" fill="#8a8a99">{lab}</text>')
  out.append('</svg>');s="".join(out)
  open(name+".svg","w").write(s);cairosvg.svg2png(bytestring=s.encode(),write_to=name+".png")
sheet("sheet-colors-outline","Colors (8) — outline",[(c,dict(color=c)) for c in C])
sheet("sheet-eyes-outline","Eyes (4) — outline",[(l,dict(eye=e)) for l,e in [("round dots","round"),("sleepy","sleepy"),("happy arcs","happy"),("wide ovals","wide")]])
sheet("sheet-hands-outline","Hands (3) — outline",[(l,dict(hand=h)) for l,h in [("reaching","reach"),("waving","wave"),("folded arms","fold")]],3)
sheet("sheet-accessories-outline","Accessories (6) — outline",[(a,dict(a=a)) for a in ["none","crown","glasses","headset","hat","bow"]],3)
sheet("sheet-examples-outline","Example bots — outline",[("Chief of Staff",dict(color="purple",a="crown")),("Researcher",dict(color="teal",a="glasses",eye="wide")),
 ("Designer",dict(color="pink",a="bow",eye="happy",hand="wave")),("Engineer",dict(color="blue",a="headset")),
 ("Ops / Scheduler",dict(color="amber",a="hat",eye="sleepy",hand="fold")),("Support",dict(color="green",eye="happy",hand="wave"))],3)


