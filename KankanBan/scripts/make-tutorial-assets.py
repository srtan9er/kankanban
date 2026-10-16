"""Maintainer-only generator. Pillow is needed to regenerate the bundled assets."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import hashlib, json, io, math

target = Path(__file__).resolve().parents[1] / 'src' / 'tutorial'
target.mkdir(parents=True, exist_ok=True)
scale = 3
assets = {}

def save(key, image):
    image = image.resize((image.width // scale, image.height // scale), Image.Resampling.LANCZOS)
    stream = io.BytesIO()
    image.save(stream, format='PNG', optimize=True)
    raw = stream.getvalue()
    import base64
    assets[key] = {'assetId': hashlib.sha256(raw).hexdigest() + '.png', 'width': image.width, 'height': image.height, 'base64': base64.b64encode(raw).decode('ascii')}

for key,size in [('star',240),('starLarge',900)]:
    image=Image.new('RGBA',(size*scale,size*scale))
    draw=ImageDraw.Draw(image)
    points=[((size/2+size*.43*math.cos(-math.pi/2+i*4*math.pi/5))*scale,
             (size/2+size*.43*math.sin(-math.pi/2+i*4*math.pi/5))*scale) for i in range(5)]
    draw.line(points+[points[0]],fill='#faf7efd0',width=5*scale,joint='curve')
    draw.line(points+[points[0]],fill='#6e8776b0',width=2*scale,joint='curve')
    save(key,image)

for key,sky,ground,sun in [('sunrise','#dcebea','#4a7c59','#e9ba6f'),('night','#252f46','#526a62','#faf1ce')]:
    image=Image.new('RGB',(320*scale,200*scale),sky)
    draw=ImageDraw.Draw(image)
    draw.ellipse(tuple(v*scale for v in (225,25,275,75)),fill=sun)
    draw.polygon([(0,170*scale),(95*scale,70*scale),(190*scale,170*scale),(235*scale,105*scale),(320*scale,175*scale),(320*scale,200*scale),(0,200*scale)],fill=ground)
    draw.line([(35*scale,200*scale),(150*scale,143*scale),(210*scale,200*scale)], fill='#ece8db', width=5*scale)
    save(key,image)

(target/'assets-data.json').write_text(json.dumps(assets,indent=2)+'\n',encoding='utf-8')
