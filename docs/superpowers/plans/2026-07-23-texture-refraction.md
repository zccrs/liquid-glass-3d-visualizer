# Texture Refraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add image upload support to View B so the glass shows a Treeland-style refracted texture beneath it.

**Architecture:** Keep the project single-file. Add a file input in the sidebar, store the uploaded `THREE.Texture` in module state, and rebuild View B with two image layers: a bottom reference plane and a refracted shader mesh using the same rounded-rect footprint. The refracted shader approximates Treeland's `magG` displacement from current UI uniforms.

**Tech Stack:** Single `index.html`, Three.js `0.170.0`, browser File API, CanvasTexture/DataTexture, ShaderMaterial, Chrome DevTools browser verification.

## Global Constraints

- Single HTML file for runtime behavior; no build step.
- UI language remains Chinese; parameter names remain English.
- Texture upload affects only View B.
- Existing View A ray diagram behavior remains unchanged.
- Existing View B glass geometry, labels, legends, and sliders remain visible.
- Use browser-level verification with an uploaded generated PNG.

---

### Task 1: Browser test for texture upload contract

**Files:**
- Modify: `index.html`

**Interfaces:**
- Consumes: existing `window.__viz`, existing `tabB`, existing `.param` controls.
- Produces: expected test contract for implementation:
  - `#textureUpload` exists and accepts `image/*`.
  - `window.__viz.textureLoaded: boolean` starts false and becomes true after upload.
  - `window.__viz.viewB.refractedMesh` exists after upload.
  - `window.__viz.viewB.refractedMesh.material.uniforms.ior.value` follows the `ior` slider.

- [ ] **Step 1: Write the failing browser check**

Run this before implementation:

```js
async () => {
  await new Promise(r => setTimeout(r, 1200));
  document.getElementById('tabB').click();
  await new Promise(r => setTimeout(r, 300));
  const upload = document.getElementById('textureUpload');
  const before = {
    hasUpload: !!upload,
    accept: upload?.getAttribute('accept') || null,
    textureLoaded: window.__viz?.textureLoaded ?? null,
    hasRefractedMesh: !!window.__viz?.viewB?.refractedMesh
  };
  return before;
}
```

Expected before implementation:

```json
{"hasUpload":false,"accept":null,"textureLoaded":null,"hasRefractedMesh":false}
```

- [ ] **Step 2: Run the browser check and confirm RED**

Use Chrome DevTools `evaluate_script` against `http://127.0.0.1:8401/index.html`.
Expected: upload contract is missing exactly as shown above.

---

### Task 2: Add texture state and upload UI

**Files:**
- Modify: `index.html`

**Interfaces:**
- Produces:
  - `state.imageTexture: THREE.Texture`
  - `state.textureLoaded: boolean`
  - `createDefaultTexture(): THREE.CanvasTexture`
  - `setImageTexture(texture, loaded): void`
  - DOM element `#textureUpload`

- [ ] **Step 1: Add sidebar upload block**

Insert before `#controls`:

```html
<div class="upload-panel">
  <div class="upload-title">上传底部贴图</div>
  <input id="textureUpload" type="file" accept="image/*">
  <div class="upload-desc">只作用于视图 B；上传后玻璃下方图片会按折射参数产生位移。</div>
</div>
```

- [ ] **Step 2: Add CSS for upload block**

```css
.upload-panel { margin: 0 0 16px; padding: 10px 12px; background: #1a2332; border: 1px solid #2a3546; border-radius: 8px; }
.upload-title { font-size: 13px; color: #f1f5f9; margin-bottom: 8px; font-weight: 600; }
.upload-panel input { width: 100%; color: #b6c2d2; font-size: 12px; }
.upload-desc { margin-top: 8px; font-size: 12px; color: #94a3b8; line-height: 1.5; }
```

- [ ] **Step 3: Add texture helpers**

```js
function createDefaultTexture() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 512;
  const ctx = c.getContext('2d');
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    ctx.fillStyle = (x + y) % 2 ? '#dbeafe' : '#1d4ed8';
    ctx.fillRect(x * 64, y * 64, 64, 64);
  }
  ctx.strokeStyle = '#f97316'; ctx.lineWidth = 10;
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(512, 512); ctx.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

const textureState = { imageTexture: createDefaultTexture(), textureLoaded: false };
function setImageTexture(texture, loaded) {
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  textureState.imageTexture = texture;
  textureState.textureLoaded = loaded;
  rebuild();
}
```

- [ ] **Step 4: Add file input handler**

```js
document.getElementById('textureUpload').addEventListener('change', ev => {
  const file = ev.target.files?.[0];
  if (!file || !file.type.startsWith('image/')) return;
  const url = URL.createObjectURL(file);
  new THREE.TextureLoader().load(url, tex => {
    URL.revokeObjectURL(url);
    setImageTexture(tex, true);
  });
});
```

---

### Task 3: Add refracted texture mesh in View B

**Files:**
- Modify: `index.html`

**Interfaces:**
- Consumes: `textureState.imageTexture`, `PARAMS`, View B `P`, `loop`, `hx`, `hy`, `thick`, `bezel`, existing top mesh arrays.
- Produces:
  - `makeRefractedMaterial(P, hx, hy, tex): THREE.ShaderMaterial`
  - `viewB.refractedMesh: THREE.Mesh`
  - `viewB.baseImagePlane: THREE.Mesh`

- [ ] **Step 1: Add shader material factory**

The fragment shader computes a local uv, t field, approximate slope, Snell term, content ramp, and offset uv:

```js
function makeRefractedMaterial(P, hx, hy, tex) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      map: { value: tex },
      halfSize: { value: new THREE.Vector2(hx, hy) },
      radius: { value: P.radius },
      bezelWidth: { value: P.bezelWidth },
      thickness: { value: P.thickness },
      ior: { value: P.ior },
      refractionMaxTan: { value: P.refractionMaxTan },
      contentEdgePull: { value: P.contentEdgePull },
      contentRampEnd: { value: P.contentRampEnd },
      profilePower: { value: P.profilePower }
    },
    vertexShader: `varying vec2 vLocal; void main(){ vLocal = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      precision highp float;
      uniform sampler2D map;
      uniform vec2 halfSize;
      uniform float radius, bezelWidth, thickness, ior, refractionMaxTan, contentEdgePull, contentRampEnd, profilePower;
      varying vec2 vLocal;
      float clamp01(float v){ return clamp(v, 0.0, 1.0); }
      float sdRound(vec2 p, vec2 b, float r){ vec2 q = abs(p) - (b - vec2(r)); return min(max(q.x,q.y),0.0)+length(max(q,0.0))-r; }
      vec2 sdfNormal(vec2 p){ float e=0.5; float dx=sdRound(p+vec2(e,0.0),halfSize,radius)-sdRound(p-vec2(e,0.0),halfSize,radius); float dy=sdRound(p+vec2(0.0,e),halfSize,radius)-sdRound(p-vec2(0.0,e),halfSize,radius); return normalize(vec2(dx,dy)+vec2(1e-5)); }
      float fieldT(vec2 p){ float dist=-sdRound(p, halfSize, radius); return clamp01(dist / max(bezelWidth, 1.0)); }
      void main(){
        vec2 uv = vLocal / (halfSize * 2.0) + 0.5;
        float t = fieldT(vLocal);
        float s = 1.0 - t;
        float p = max(profilePower, 1.0);
        float inside = max(1.0 - pow(s, p), 1e-4);
        float h = pow(inside, 1.0 / p);
        float deriv = pow(s, p - 1.0) * h / inside;
        float rawTan = deriv * (thickness / max(bezelWidth, 1.0));
        float slopeMag = min(rawTan, max(refractionMaxTan, 0.1));
        float sinI = slopeMag / sqrt(1.0 + slopeMag * slopeMag);
        float sinT = clamp(sinI / max(ior, 1.0001), 0.0, 0.999);
        float tanT = sinT / sqrt(max(1.0 - sinT * sinT, 1e-4));
        float rampEnd = max(contentRampEnd, 1e-4);
        float ramp = mix(contentEdgePull, 1.0, smoothstep(0.0, rampEnd, t));
        float maxDisp = min(min(bezelWidth * 0.85, thickness * 0.75), 48.0);
        float magG = min(thickness * h * ramp * max(slopeMag - tanT, 0.0), maxDisp);
        vec2 dir = sdfNormal(vLocal);
        vec2 duv = dir * magG / (halfSize * 2.0);
        vec4 color = texture2D(map, clamp(uv + duv, vec2(0.001), vec2(0.999)));
        gl_FragColor = vec4(color.rgb, 0.82);
      }`
  });
}
```

- [ ] **Step 2: Build base image plane**

Create a plane under the glass:

```js
const base = new THREE.Mesh(
  new THREE.PlaneGeometry(P.width * 1.15, P.height * 1.15),
  new THREE.MeshBasicMaterial({ map: textureState.imageTexture, transparent: true, opacity: 0.55, side: THREE.DoubleSide })
);
base.position.z = -skirt - 1;
group.add(base);
viewB.baseImagePlane = base;
```

- [ ] **Step 3: Build refracted mesh**

Reuse the top geometry position data with a tiny z offset below the glass surface:

```js
const rg = tg.clone();
const rp = rg.attributes.position.array;
for (let i = 2; i < rp.length; i += 3) rp[i] -= 0.6;
rg.attributes.position.needsUpdate = true;
const refracted = new THREE.Mesh(rg, makeRefractedMaterial(P, hx, hy, textureState.imageTexture));
refracted.renderOrder = 1;
group.add(refracted);
viewB.refractedMesh = refracted;
```

---

### Task 4: Green test, visual verification, commit

**Files:**
- Modify: `index.html`
- Modify: `docs/design.md`

**Interfaces:**
- Consumes: `#textureUpload`, `window.__viz.textureLoaded`, `viewB.refractedMesh`.
- Produces: pushed GitHub commit.

- [ ] **Step 1: Re-run the browser check**

Expected after implementation before upload:

```json
{"hasUpload":true,"accept":"image/*","textureLoaded":false,"hasRefractedMesh":true}
```

- [ ] **Step 2: Upload generated PNG and verify state**

Use a generated PNG file. Expected:

```json
{"textureLoaded":true,"hasRefractedMesh":true,"uniformIor":1.5}
```

- [ ] **Step 3: Change `ior` and verify uniform update**

Set `ior` slider to `2.2`. Expected:

```json
{"uniformIor":2.2}
```

- [ ] **Step 4: Capture screenshot**

Save screenshot to:

```text
/tmp/liquid-glass-texture-refraction.png
```

Expected: uploaded/generated picture is visible beneath View B, with edge displacement through the glass.

- [ ] **Step 5: Commit and push**

Commit message:

```text
feat: add texture refraction upload

Add image upload and shader-based texture refraction in View B.

新增贴图上传和视图 B 的 shader 折射采样效果。

Log: 添加玻璃底部贴图折射
Influence: 用户可上传图片并观察 Liquid Glass 参数对底部内容折射的影响。
```

Run:

```bash
git add index.html docs/design.md docs/superpowers/plans/2026-07-23-texture-refraction.md
git commit -m "$COMMIT_MSG"
git push
```
