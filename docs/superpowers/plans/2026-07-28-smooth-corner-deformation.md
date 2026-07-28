# Smooth Corner Deformation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the diagonal-seamed radius warp with a C1 corner deformation that preserves the exact `radius` outline and master bezel-depth profile while leaving the complete `virtualRadius` glass calculation unchanged.

**Architecture:** Use the rounded-square map for smooth angular deformation, then project its final virtual coordinate onto a C1 source-depth constraint. Import the shared scalar depth splice for CPU mesh/debug calculations and port the same fixed projection to GLSL. Evaluate height, `profilePower`, slope, normal, and refraction only at the corrected virtual coordinate. Validate boundaries, master diagonal depth, derivative continuity, positive interior Jacobians, CPU/GLSL parity, non-corner identity, and the reported `radius=0`, `virtualRadius=bezel=60` scene.

**Tech Stack:** JavaScript ES modules, Node.js built-in test runner, GLSL ES in Three.js `ShaderMaterial`, Three.js r170, Chromium visual verification.

## Global Constraints

- The visible rounded-rectangle mask continues to use `radius` exactly.
- Surface height, slope, optical normal, and refraction use `virtualRadius` before the final two-dimensional deformation.
- Do not use `dx < dy`, `min/max` nearest-edge selection, a sector-based square-to-disc map, a LUT texture, or normal-only smoothing.
- `radius == virtualRadius` and coordinates outside the corner influence region return the input exactly.
- For `radius=0` and `virtualRadius=bezel`, the corner diagonal preserves the master `t=depth/bezel` profile.
- JavaScript and GLSL use matching constants, clamps, transition functions, and degenerate thresholds.
- An exact `radius = 0` corner may be singular at the boundary point only; no singular line may enter the corner interior.
- A non-positive interior mapping determinant is a failed map, not a value to clamp.

---

## File Structure

- Create `corner-deformation.mjs`: dependency-free rounded-square mapping, inverse mapping, Jacobian, determinant, and GLSL source constants.
- Create `corner-deformation.test.mjs`: Node invariant tests for identity, boundaries, C1 continuity, reverse mapping, and positive Jacobians.
- Modify `index.html`: import the mapping, remove the old radial warp, use the new CPU map/Jacobian for geometry, and embed the matching GLSL implementation.
- Update `docs/superpowers/specs/2026-07-28-smooth-corner-deformation-design.md` only if implementation evidence requires a correction to an approved mathematical claim; do not broaden scope.

### Task 1: Pure corner deformation and invariant tests

**Files:**
- Create: `corner-deformation.mjs`
- Create: `corner-deformation.test.mjs`

**Interfaces:**
- Consumes: numeric point/radius/size/bezel values only; no DOM or Three.js objects.
- Produces:
  - `mapActualToVirtual(point, halfSize, radius, virtualRadius, bezel): [number, number]`
  - `mapActualToVirtualWithJacobian(point, halfSize, radius, virtualRadius, bezel): { point: [number, number], jacobian: [number, number, number, number], determinant: number }`
  - `squareToDisc(u, v): [number, number]`
  - `discToSquare(x, y): [number, number]`
  - `CORNER_EPSILON = 1e-5`
  - `CORNER_EQUAL_RADIUS_EPSILON = 1e-4`

- [ ] **Step 1: Add failing identity and basis round-trip tests**

Create `corner-deformation.test.mjs` with Node's test runner. The first tests must establish exact equal-radius behavior and numerical inversion of the branch-free basis:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  discToSquare,
  mapActualToVirtual,
  squareToDisc,
} from './corner-deformation.mjs';

const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

function assertPointClose(actual, expected, eps = 1e-9) {
  assert.ok(close(actual[0], expected[0], eps), `${actual[0]} != ${expected[0]}`);
  assert.ok(close(actual[1], expected[1], eps), `${actual[1]} != ${expected[1]}`);
}

test('equal radii are an exact identity path', () => {
  const points = [[0, 0], [149.5, 99.5], [-145, 80], [90, -75]];
  for (const point of points) {
    assert.deepEqual(mapActualToVirtual(point, [150, 100], 60, 60, 60), point);
  }
});

test('elliptical-grid basis round-trips away from boundary singularities', () => {
  for (const point of [[0, 0], [.2, -.4], [-.75, .5], [.9, .2]]) {
    assertPointClose(discToSquare(...squareToDisc(...point)), point, 1e-9);
  }
});
```

- [ ] **Step 2: Run the tests and verify the missing module failure**

Run: `node --test corner-deformation.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `corner-deformation.mjs`.

- [ ] **Step 3: Implement the branch-free basis and exact identity guards**

Create `corner-deformation.mjs`. Keep the basis dependency-free and clamp only square-root roundoff:

```js
export const CORNER_EPSILON = 1e-5;
export const CORNER_EQUAL_RADIUS_EPSILON = 1e-4;

const clamp = (value, low, high) => Math.min(Math.max(value, low), high);
const safeSqrt = value => Math.sqrt(Math.max(value, 0));

export function squareToDisc(u, v) {
  return [
    u * safeSqrt(1 - 0.5 * v * v),
    v * safeSqrt(1 - 0.5 * u * u),
  ];
}

export function discToSquare(x, y) {
  const root2 = Math.SQRT2;
  const a = 2 + x * x - y * y;
  const b = 2 - x * x + y * y;
  return [
    0.5 * (safeSqrt(a + 2 * root2 * x) - safeSqrt(a - 2 * root2 * x)),
    0.5 * (safeSqrt(b + 2 * root2 * y) - safeSqrt(b - 2 * root2 * y)),
  ];
}

export function mapActualToVirtual(point, halfSize, radius, virtualRadius, bezel) {
  const limit = Math.min(halfSize[0], halfSize[1]);
  const from = clamp(radius, 0, limit);
  const to = clamp(virtualRadius, 0, limit);
  if (Math.abs(from - to) <= CORNER_EQUAL_RADIUS_EPSILON) return point;
  return mapCornerBetweenRadii(point, halfSize, from, to, bezel);
}
```

Implement `mapCornerBetweenRadii` as the approved `M_to(M_from^-1(point))` rounded-square chart from the design spec. Its local extent is `min(max(bezel, from, to, 1), limit)`. The outer boundary curve is the exact rounded-rectangle arc plus its two tangent straight segments. Use the elliptical-grid basis for the square/disc conversion and the quintic Hermite weight `s*s*s*(s*(s*6-15)+10)` to make displacement and first derivative zero at both identity joins. This function must contain no comparison between the two local corner coordinates.

- [ ] **Step 4: Add failing boundary, continuity, determinant, and reverse tests**

Append deterministic helpers and invariant tests:

```js
import { mapActualToVirtualWithJacobian } from './corner-deformation.mjs';

function roundedRectSdf([x, y], [hx, hy], radius) {
  const r = Math.min(Math.max(radius, 0), Math.min(hx, hy));
  const qx = Math.abs(x) - (hx - r);
  const qy = Math.abs(y) - (hy - r);
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r;
}

function topRightOutline([hx, hy], radius, count = 65) {
  const r = Math.min(Math.max(radius, 0), Math.min(hx, hy));
  if (r === 0) {
    return Array.from({ length: count }, (_, i) => i < count / 2
      ? [hx - (2 * i * 60) / (count - 1), hy]
      : [hx, hy - (2 * (count - 1 - i) * 60) / (count - 1)]);
  }
  return Array.from({ length: count }, (_, i) => {
    const angle = (Math.PI * .5 * i) / (count - 1);
    return [hx - r + r * Math.cos(angle), hy - r + r * Math.sin(angle)];
  });
}

test('actual outline maps to the virtual outline', () => {
  const halfSize = [150, 100];
  for (const [from, to] of [[0, 60], [60, 0], [30, 60], [60, 30]]) {
    for (const point of topRightOutline(halfSize, from)) {
      const mapped = mapActualToVirtual(point, halfSize, from, to, 60);
      assert.ok(Math.abs(roundedRectSdf(mapped, halfSize, to)) < 1e-5);
    }
  }
});

test('the diagonal has no first-derivative jump', () => {
  const halfSize = [150, 100];
  for (const depth of [10, 20, 30, 40, 50]) {
    const a = mapActualToVirtualWithJacobian(
      [halfSize[0] - depth - .01, halfSize[1] - depth + .01],
      halfSize, 0, 60, 60,
    );
    const b = mapActualToVirtualWithJacobian(
      [halfSize[0] - depth + .01, halfSize[1] - depth - .01],
      halfSize, 0, 60, 60,
    );
    assert.ok(Math.max(...a.jacobian.map((value, i) => Math.abs(value - b.jacobian[i]))) < 2e-3);
  }
});

test('the corner interior never folds', () => {
  const halfSize = [150, 100];
  for (const [from, to] of [[0, 60], [60, 0], [30, 60], [60, 30], [0, 100], [100, 0]]) {
    for (let dx = 1; dx < 60; dx += 2) {
      for (let dy = 1; dy < 60; dy += 2) {
        const result = mapActualToVirtualWithJacobian(
          [halfSize[0] - dx, halfSize[1] - dy], halfSize, from, to, 60,
        );
        assert.ok(result.determinant > 0, `${from}->${to} folded at ${dx},${dy}`);
      }
    }
  }
});

test('forward and reverse radius maps round-trip', () => {
  const halfSize = [150, 100];
  for (const point of [[100, 50], [120, 70], [140, 80], [90, 40]]) {
    const virtual = mapActualToVirtual(point, halfSize, 0, 60, 60);
    const actual = mapActualToVirtual(virtual, halfSize, 60, 0, 60);
    assertPointClose(actual, point, 1e-5);
  }
});
```

- [ ] **Step 5: Implement and expose the analytic Jacobian**

Differentiate the same rounded-square chart used by `mapCornerBetweenRadii`; do not finite-difference in production. Return row-major `[dVx/dAx, dVx/dAy, dVy/dAx, dVy/dAy]` and compute:

```js
export function mapActualToVirtualWithJacobian(
  point, halfSize, radius, virtualRadius, bezel,
) {
  const mapped = mapActualToVirtualAndDerivative(
    point, halfSize, radius, virtualRadius, bezel,
  );
  const [j00, j01, j10, j11] = mapped.jacobian;
  return {
    point: mapped.point,
    jacobian: mapped.jacobian,
    determinant: j00 * j11 - j01 * j10,
  };
}
```

The equal-radius and outside-corner results return the exact identity Jacobian
`[1, 0, 0, 1]`. Do not replace a non-positive determinant with an epsilon.

- [ ] **Step 6: Run the pure mapping tests**

Run: `node --test corner-deformation.test.mjs`

Expected: all tests PASS, including every forward/reverse radius pair and Jacobian sweep.

- [ ] **Step 7: Commit the pure mapping unit**

```bash
git add corner-deformation.mjs corner-deformation.test.mjs
git commit -m "fix(visualizer): add smooth corner deformation map"
```

### Task 2: Integrate the map into CPU geometry and debugging

**Files:**
- Modify: `index.html:168-170`
- Modify: `index.html:421-560`
- Modify: `index.html:1344-1410`
- Test: `corner-deformation.test.mjs`

**Interfaces:**
- Consumes: `mapActualToVirtual` and `mapActualToVirtualWithJacobian` from Task 1.
- Produces: `window.__viz.debugCornerMap(x, y)` and deformed top geometry whose height and normals come from the mapped virtual field.

- [ ] **Step 1: Import the mapping API**

Add beside the existing Three.js imports:

```js
import {
  mapActualToVirtual,
  mapActualToVirtualWithJacobian,
} from './corner-deformation.mjs';
```

- [ ] **Step 2: Remove the radial intersection warp**

Delete `actualCornerOuterDistance`, `warpBetweenRadiiPoint`,
`warpToVirtualRadiusPoint`, and `warpFromVirtualRadiusPoint`. Replace
`opticalCoordinateForMode` with:

```js
function opticalCoordinateForMode(px, py, hx, hy, radius, bezelWidth, virtualRadius) {
  const b = Math.min(Math.max(bezelWidth, 1), Math.max(Math.min(hx, hy) - 1, 1));
  const opticalRadius = resolveVirtualRadiusValue(virtualRadius, b, hx, hy);
  return mapActualToVirtual([px, py], [hx, hy], radius, opticalRadius, b);
}
```

Wrap the base map with a final depth-preservation projection. Derive source corner
depth from the two straight-edge progress values using the shared C1
`postprocessCornerDepth()` splice. Project the mapped virtual coordinate along the
virtual field gradient for three fixed steps. The correction strength must be zero
for equal/reverse radii and must not run outside the corner influence region.

- [ ] **Step 3: Add a failing browser-visible debug contract**

Expose the mapped point, Jacobian, and determinant from `syncVizTextureState()`:

```js
window.__viz.debugCornerMap = (x, y) => {
  const P = Object.fromEntries(Object.entries(PARAMS).map(([key, option]) => [key, option.v]));
  const halfSize = [P.width / 2, P.height / 2];
  const virtual = resolveVirtualRadiusValue(P.virtualRadius, P.bezelWidth, ...halfSize);
  return mapActualToVirtualWithJacobian(
    [x, y], halfSize, P.radius, virtual, P.bezelWidth,
  );
};
```

Before wiring the import, load the page and evaluate
`window.__viz.debugCornerMap(120, 70)`.

Expected: FAIL because `debugCornerMap` is not yet defined.

- [ ] **Step 4: Transform only the displayed 3D top geometry**

For each top vertex, evaluate field progress and height at the corrected virtual
coordinate. Evaluate the complete corrected mapping Jacobian with a centered
difference and transform the virtual height gradient with `J^T`; do not redefine
the height field from the actual `radius`.

Set a `normal` buffer attribute explicitly for the screen-facing top geometry.
Side walls retain the actual outline and their existing normals.

- [ ] **Step 5: Replace every CPU warp call and expose the debug hook**

Use `mapActualToVirtual` in `fieldNormal`, `debugRefractionAt`, the view-A optical
field, and the view-B top geometry. Every glass quantity must be evaluated only
after obtaining the mapped virtual coordinate. Ensure no old warp symbol remains.

Run: `node --test corner-deformation.test.mjs`

Expected: all tests PASS.

- [ ] **Step 6: Smoke-test the CPU height field in Chromium**

With the local server running, set `bezelWidth=60` and `virtualRadius=60`.
Compare `radius=59` and `radius=60` throughout straight-edge and interior regions;
their mapped points, `t`, height, normal, and refraction data must be identical.
Then evaluate Jacobians at points 0.01 px on each side of the corner diagonal for
`radius=0` and depths 10, 20, 30, 40, and 50 px.

Expected: non-corner samples are exact identities, the 59/60 corner change is
small and localized, determinant is positive, corresponding Jacobian elements
differ by less than `2e-3`, and the colored top mesh has no diagonal fold.

- [ ] **Step 7: Commit CPU integration**

```bash
git add index.html corner-deformation.test.mjs
git commit -m "fix(visualizer): use smooth map for corner geometry"
```

### Task 3: Port the deformation to GLSL refraction

**Files:**
- Modify: `index.html:949-1147`
- Test: `corner-deformation.test.mjs`

**Interfaces:**
- Consumes: the formulas and thresholds exported by Task 1.
- Produces: `mapActualToVirtualPoint(vec2 p, float fromR, float toR, float b)` in the fragment shader.

- [ ] **Step 1: Add the GLSL elliptical-grid basis**

Add branch-free helpers matching the JavaScript arithmetic:

```glsl
vec2 squareToDisc(vec2 p) {
  return vec2(
    p.x * sqrt(max(1.0 - 0.5 * p.y * p.y, 0.0)),
    p.y * sqrt(max(1.0 - 0.5 * p.x * p.x, 0.0))
  );
}

vec2 discToSquare(vec2 p) {
  float root2 = 1.4142135623730951;
  float a = 2.0 + p.x * p.x - p.y * p.y;
  float b = 2.0 - p.x * p.x + p.y * p.y;
  return 0.5 * vec2(
    sqrt(max(a + 2.0 * root2 * p.x, 0.0)) - sqrt(max(a - 2.0 * root2 * p.x, 0.0)),
    sqrt(max(b + 2.0 * root2 * p.y, 0.0)) - sqrt(max(b - 2.0 * root2 * p.y, 0.0))
  );
}

float quintic01(float s) {
  s = clamp(s, 0.0, 1.0);
  return s * s * s * (s * (s * 6.0 - 15.0) + 10.0);
}
```

- [ ] **Step 2: Port the rounded-square chart without changing its structure**

Translate each JavaScript expression in `mapCornerBetweenRadii` in the same order.
Use `1e-5` for the corner epsilon and `1e-4` for the equal-radius path. Preserve
the exact identity return outside the corner extent. Do not replace the mapping
with GLSL's existing `shaderT`, `fieldT`, or rounded-rectangle SDF.

- [ ] **Step 3: Remove the old GLSL radial warp**

Delete `actualCornerOuterDistance` and `warpToVirtualRadiusPoint`. In `main()`,
replace the old `geometryWarp` coordinate with:

```glsl
vec2 shadeLocal = preservePostprocessDepth(
  vLocal,
  mapActualToVirtualPoint(vLocal, rr0, opticalR, b0),
  rr0, opticalR, b0
);
```

Keep `shapeAlpha` and actual edge masking based on `vLocal` and `radius`. Evaluate
field progress, height, slope, optical normal, refraction, and background sampling
from `shadeLocal` and `opticalR`, matching master before the final deformation.

- [ ] **Step 4: Verify shader compilation and runtime errors**

Reload `http://127.0.0.1:4173/`, open view B, and inspect the browser console.

Expected: no shader compile/link errors and no JavaScript exceptions.

- [ ] **Step 5: Verify CPU/GLSL behavior at the reported scene**

Set `radius=0`, `bezelWidth=60`, `virtualRadius=60`, load a high-contrast image,
and rotate the glass through front, oblique, and grazing angles.

Expected:

- no diagonal geometry highlight;
- no diagonal discontinuity in refracted image features;
- actual outline remains a sharp rectangle;
- all four corners are symmetric;
- straight-edge refraction is unchanged.

- [ ] **Step 6: Commit GLSL integration**

```bash
git add index.html
git commit -m "fix(visualizer): smooth virtual radius shader warp"
```

### Task 4: Regression sweep and cleanup

**Files:**
- Modify: `corner-deformation.test.mjs`
- Modify: `index.html`
- Modify: `docs/superpowers/specs/2026-07-28-smooth-corner-deformation-design.md` only if verified implementation details differ from the approved formula.

**Interfaces:**
- Consumes: completed CPU and GLSL mappings.
- Produces: final invariant coverage and a clean user-facing visualizer.

- [ ] **Step 1: Expand the deterministic parameter matrix**

Drive the existing determinant, boundary, and round-trip helpers with:

```js
const cases = [
  { halfSize: [150, 100], bezel: 60, pairs: [[0, 60], [60, 0], [30, 60], [60, 30], [60, 60]] },
  { halfSize: [200, 40], bezel: 39, pairs: [[0, 39], [39, 0], [20, 39], [39, 20]] },
  { halfSize: [40, 200], bezel: 39, pairs: [[0, 39], [39, 0], [20, 39], [39, 20]] },
  { halfSize: [40, 30], bezel: 60, pairs: [[0, 30], [30, 0], [15, 30], [30, 15]] },
];
```

For every case, test all four corners, boundary samples, diagonal derivatives,
identity joins, determinants, and reverse round-trips.

- [ ] **Step 2: Run the complete automated suite**

Run: `node --test corner-deformation.test.mjs`

Expected: all tests PASS with no skipped cases.

- [ ] **Step 3: Run final browser smoke scenarios**

Exercise view A and view B with:

- `radius=0`, `virtualRadius=60`, `bezelWidth=60`;
- `radius=60`, `virtualRadius=0`, `bezelWidth=60`;
- `radius=30`, `virtualRadius=60`, `bezelWidth=60`;
- `radius=60`, `virtualRadius=30`, `bezelWidth=60`;
- equal radii at 0, 30, and 60;
- width/height extremes from the parameter controls.

Expected: no internal diagonal or corner-region seam, no inverted triangles, exact
visible outline, unchanged straight edges, and no console errors.

- [ ] **Step 4: Remove obsolete helpers and comments**

Remove every unused radial-warp helper, experimental branch comment, and stale
reference to the old expanding-corner deformation. Keep the user-facing
`virtualRadius` description focused on smooth final deformation.

Run: `node --test corner-deformation.test.mjs`

Expected: all tests PASS after cleanup.

- [ ] **Step 5: Commit regression coverage and cleanup**

```bash
git add index.html corner-deformation.test.mjs docs/superpowers/specs/2026-07-28-smooth-corner-deformation-design.md
git commit -m "test(visualizer): cover smooth corner radius warps"
```
