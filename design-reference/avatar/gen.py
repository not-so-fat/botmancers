import cairosvg
C=dict(purple=("#9b59d9","#3a1f5c"),blue=("#4f8ef0","#14305e"),teal=("#2fb5a8","#0e3f3b"),green=("#5cbf5a","#1d4a1c"),
 amber=("#f0b429","#5a3d00"),orange=("#f07a3a","#5a2408"),pink=("#ef7fb8","#5c1a3c"),slate=("#7d8aa3","#232a38"))
BODY="M100 30 C130 30 142 70 152 110 C162 148 172 168 160 176 C150 182 50 182 40 176 C28 168 38 148 48 110 C58 70 70 30 100 30Z"
def shade(h,f):
  r,g,b=[int(h[i:i+2],16) for i in (1,3,5)];return "#%02x%02x%02x"%tuple(int(min(255,v*f)) for v in (r,g,b))
def eyes(k,d):
  if k=="round": return f'<circle cx="84" cy="88" r="9" fill="{d}"/><circle cx="116" cy="88" r="9" fill="{d}"/><path d="M93 103 q7 6 14 0" stroke="{d}" stroke-width="3" fill="none" stroke-linecap="round"/>'
  if k=="sleepy": return f'<path d="M75 88 a9 9 0 0 0 18 0Z M107 88 a9 9 0 0 0 18 0Z" fill="{d}"/><path d="M73 87 h22 M105 87 h22" stroke="{d}" stroke-width="3" stroke-linecap="round"/><path d="M95 104 h10" stroke="{d}" stroke-width="3" stroke-linecap="round"/>'
  if k=="happy": return f'<path d="M76 92 q8 -12 16 0 M108 92 q8 -12 16 0" stroke="{d}" stroke-width="4.5" fill="none" stroke-linecap="round"/><path d="M92 102 q8 9 16 0" stroke="{d}" stroke-width="3" fill="none" stroke-linecap="round"/>'
  if k=="wide": return f'<ellipse cx="84" cy="88" rx="8" ry="12" fill="{d}"/><ellipse cx="116" cy="88" rx="8" ry="12" fill="{d}"/><circle cx="100" cy="108" r="3.5" fill="{d}"/>'
def hands(k,b):
  s=shade(b,1.12);o=f'fill="{s}" stroke="{shade(b,.8)}" stroke-width="1.5"'
  if k=="reach": return f'<rect x="96" y="118" width="84" height="15" rx="7.5" {o}/><rect x="96" y="140" width="76" height="15" rx="7.5" {o}/>'
  if k=="wave": return f'<rect x="96" y="132" width="70" height="15" rx="7.5" {o}/><g transform="rotate(-55 150 120)"><rect x="140" y="112" width="60" height="15" rx="7.5" {o}/></g>'
  if k=="fold": return f'<g transform="rotate(14 100 140)"><rect x="56" y="132" width="88" height="16" rx="8" {o}/></g><g transform="rotate(-14 100 140)"><rect x="56" y="132" width="88" height="16" rx="8" {o}/></g>'
def acc(k):
  if k=="none": return ""
  if k=="crown": return '<path d="M78 42 L76 18 L89 30 L100 12 L111 30 L124 18 L122 42Z" fill="#f5c542" stroke="#b8860b" stroke-width="2" stroke-linejoin="round"/><circle cx="100" cy="32" r="3.5" fill="#e0457b"/>'
  if k=="glasses": return '<g fill="none" stroke="#1b1b22" stroke-width="3.5"><circle cx="84" cy="88" r="14"/><circle cx="116" cy="88" r="14"/><path d="M98 88 h4"/></g>'
  if k=="headset": return '<path d="M56 92 C56 30 144 30 144 92" fill="none" stroke="#2a2a33" stroke-width="7" stroke-linecap="round"/><rect x="48" y="82" width="14" height="24" rx="6" fill="#2a2a33"/><rect x="138" y="82" width="14" height="24" rx="6" fill="#2a2a33"/><path d="M55 104 q4 18 26 14" stroke="#2a2a33" stroke-width="3.5" fill="none"/><circle cx="83" cy="118" r="4.5" fill="#2a2a33"/>'
  if k=="hat": return '<ellipse cx="100" cy="44" rx="44" ry="8" fill="#2d2d38"/><path d="M76 44 L80 12 Q100 6 120 12 L124 44Z" fill="#2d2d38"/><rect x="77" y="34" width="46" height="7" fill="#c0392b"/>'
  if k=="bow": return '<g transform="translate(120 42) rotate(20)"><path d="M0 0 L-20 -12 Q-24 0 -20 12Z M0 0 L20 -12 Q24 0 20 12Z" fill="#ff5fa2" stroke="#b02a64" stroke-width="2" stroke-linejoin="round"/><circle r="6" fill="#ff8cc0" stroke="#b02a64" stroke-width="2"/></g>'
def bot(color="purple",eye="round",hand="reach",a="none"):
  b,d=C[color]
  return f'<g id="body"><path d="{BODY}" fill="{b}"/></g><g id="eyes">{eyes(eye,d)}</g><g id="hands">{hands(hand,b)}</g><g id="accessory">{acc(a)}</g>'
def sheet(name,title,items,cols=4):
  W,H=230,260;rows=(len(items)+cols-1)//cols
  out=[f'<svg xmlns="http://www.w3.org/2000/svg" width="{cols*W+40}" height="{rows*H+90}"><rect width="100%" height="100%" fill="#0f0f14"/><text x="30" y="50" font-family="Asap" font-size="28" font-weight="700" fill="#eee">{title}</text>']
  for i,(lab,kw) in enumerate(items):
    x=20+(i%cols)*W;y=70+(i//cols)*H
    out.append(f'<rect x="{x+8}" y="{y}" width="{W-16}" height="{H-16}" rx="16" fill="#1a1a23"/><g transform="translate({x+15} {y+5})">{bot(**kw)}</g><text x="{x+W/2}" y="{y+H-32}" text-anchor="middle" font-family="Asap" font-size="17" fill="#ccc">{lab}</text>')
  out.append('</svg>');s="".join(out)
  open(name+".svg","w").write(s);cairosvg.svg2png(bytestring=s.encode(),write_to=name+".png")
sheet("sheet-colors","Colors (8)",[(c,dict(color=c)) for c in C])
sheet("sheet-eyes","Eyes (4)",[(l,dict(eye=e)) for l,e in [("round dots","round"),("sleepy","sleepy"),("happy arcs","happy"),("wide ovals","wide")]])
sheet("sheet-hands","Hands (3)",[(l,dict(hand=h)) for l,h in [("reaching","reach"),("waving","wave"),("folded arms","fold")]],3)
sheet("sheet-accessories","Accessories (6)",[(a,dict(a=a)) for a in ["none","crown","glasses","headset","hat","bow"]],3)
sheet("sheet-examples","Example bots",[("Chief of Staff",dict(color="purple",a="crown")),("Researcher",dict(color="teal",a="glasses",eye="wide")),
 ("Designer",dict(color="pink",a="bow",eye="happy",hand="wave")),("Engineer",dict(color="blue",a="headset")),
 ("Ops / Scheduler",dict(color="amber",a="hat",eye="sleepy",hand="fold")),("Support",dict(color="green",eye="happy",hand="wave"))],3)
