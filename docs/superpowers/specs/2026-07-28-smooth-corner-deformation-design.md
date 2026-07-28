# Smooth Corner Deformation Design

## Problem

When `radius < virtualRadius`, the visualizer first evaluates the glass surface and
refraction with `virtualRadius`, then maps the result to the outline described by
`radius`. The current `warpBetweenRadiiPoint()` implementation casts a ray from
the inner corner and selects either the horizontal or vertical boundary
intersection.

For `radius = 0` and `virtualRadius = bezel = 60`, the scalar field is continuous
across the corner diagonal, but its first derivative is not. Measurements on the
two sides of the diagonal give gradients close to `(0, 1/60)` and `(1/60, 0)`.
The resulting height field is C0 continuous but not C1 continuous, which produces
the visible diagonal fold in all four corners. Increasing mesh density or
smoothing vertex normals cannot repair the discontinuity in the height and
refraction-coordinate fields.

## Goals

- Preserve the exact visible rounded-rectangle outline described by `radius`.
- Preserve `virtualRadius` as the radius used for the actual glass surface,
  normal, specular, and refraction calculations.
- Apply the radius difference only as the final smooth two-dimensional
  deformation.
- Remove internal diagonal seams from geometry and refracted content.
- Use equivalent formulas in JavaScript and GLSL.
- Preserve the existing result and fast path when both radii are equal.

## Non-goals

- Changing the glass profile, refraction model, Fresnel model, or bezel meaning.
- Hiding the defect by changing only mesh normals, lighting, or tessellation.
- Replacing the analytic mapping with a per-item displacement texture.
- Softening a requested `radius = 0` outline into a nonzero visible radius.

## Root cause

The current corner warp computes a radial scale using the first intersection of
a ray with the source and target rounded-corner boundaries. For a square source,
the selected source boundary changes from the top edge to the side edge on the
corner diagonal. The mapped position remains continuous, but the scale derivative
jumps at that selection boundary. The discontinuity is then propagated into:

- the 3D height `h(t(mappedPosition))`;
- generated vertex normals;
- the base background sampling coordinate;
- the refracted sampling coordinate.

The defect must therefore be fixed in the coordinate deformation itself.

## Architecture

The virtual glass field remains unchanged. A single mapping layer converts an
actual display coordinate into its virtual glass coordinate:

```text
pActual
  -> smoothMapActualToVirtual(radius, virtualRadius, bezel)
  -> pVirtual
  -> virtual glass field, normal, refraction, and background sampling
  -> color displayed at pActual
```

The map is expressed through a shared canonical rounded-square parameterization:

\[
p_v = M_{r_v}\left(M_{r_a}^{-1}(p_a)\right)
\]

where `r_a` is `radius` and `r_v` is `virtualRadius`.

The implementation must maintain one mathematical definition with matching
JavaScript and GLSL translations. The JavaScript path drives the 3D geometry and
debug data. The GLSL path drives the refracted preview. Constants, clamps,
degenerate cases, and transition functions must match.

## Corner mapping

Each corner uses a local influence extent:

\[
E = \min\left(\max(bezel, r_a, r_v, 1),\ \min(halfWidth, halfHeight)\right).
\]

Outside the corner influence region, the map is exactly the identity. Inside the
region, coordinates are normalized to a canonical rounded square.

The square-to-disc basis is the branch-free elliptical-grid mapping:

\[
D(u,v)=\left(
  u\sqrt{1-\frac{v^2}{2}},
  v\sqrt{1-\frac{u^2}{2}}
\right).
\]

Its inverse is used for the reverse direction. Unlike a concentric sector map,
this basis has no `u < v`, `dx < dy`, or nearest-edge selection inside the corner.
The only unavoidable singularity for an exact square outline is the square's
boundary corner itself; it must not extend into an interior seam.

`M_r` generalizes the basis from a square to the exact rounded-rectangle boundary
for `alpha = r / E`:

- `alpha = 0` is the exact square parameterization;
- `alpha = 1` is the exact quarter-disc parameterization;
- intermediate values place the outer boundary on the exact radius-`r` circular
  arc and retain the adjacent straight segments;
- the interior displacement blends into the identity map with quintic Hermite
  weight `6s^5 - 15s^4 + 10s^3`;
- both displacement and first derivative are zero where the corner region joins
  the unchanged straight-edge/interior region.

The implementation must not linearly interpolate two signed-distance fields or
blend two nearest-edge branches. Those constructions can reintroduce derivative
seams or move the defect to the corner-region boundary.

## Field and normal semantics

The shader evaluates all optical quantities at `pVirtual`:

- field progress `t`;
- virtual surface slope and optical normal;
- refraction magnitude and direction;
- Fresnel/specular contribution;
- base and displaced background samples.

This preserves the agreed semantics: render the real `virtualRadius` glass first,
then deform its final result to the `radius` outline.

For the 3D surface, the displayed position remains `(pActual.x, pActual.y)` and
its height is:

\[
z(p_a)=h\left(t(F(p_a))\right).
\]

The mapping also exposes its Jacobian
`J = partial(pVirtual) / partial(pActual)`. The actual height gradient is:

\[
\nabla_{p_a}z = J^T\nabla_{p_v}z.
\]

The 3D geometry normal is derived from that actual gradient. A normal computed
from tessellated triangles may be retained as a diagnostic comparison, but it is
not the mathematical definition of the deformed surface normal.

## Degenerate and boundary cases

- If `abs(radius - virtualRadius) <= 1e-4`, return the input coordinate exactly.
- Clamp both radii with the existing half-size limit before constructing the map.
- If a coordinate is outside the corner influence region, return it exactly.
- Clamp square-root radicands to zero to absorb floating-point underflow.
- Handle small denominators only at mathematically degenerate boundary points.
- Do not clamp a non-positive interior Jacobian determinant; treat it as a failed
  mapping and correct the parameterization.
- `radius = 0` may have a singular Jacobian at the visible sharp corner only.
- `virtualRadius = 0` uses the same map in the reverse direction.

## Rejected alternatives

### Smooth the existing branch selection

A smooth-min or narrow blend around the diagonal would be a small patch, but it
cannot simultaneously guarantee exact boundaries, a positive Jacobian, and no
new transition seam for all radius pairs.

### Harmonic displacement texture

A Laplace or harmonic map is a useful offline reference because it produces a
smooth interior for fixed boundary constraints. Runtime LUT generation, caching,
and texture sampling are unnecessary for this two-dimensional analytic problem.

### Custom or averaged normals

Normal smoothing changes highlights only. It leaves the height-field and
refraction-coordinate discontinuities intact.

### Increase mesh resolution

More triangles approximate the same non-C1 surface more accurately and can make
the fold sharper rather than remove it.

## Verification

### Mapping invariants

For representative sizes and every tested radius pair:

- points on the actual outline map to the virtual rounded-rectangle outline;
- points on unchanged straight-edge and interior regions map to themselves;
- equal radii take the exact identity path;
- the interior Jacobian determinant remains positive;
- position and first derivatives agree across the corner diagonal and corner
  influence boundaries.

Sweep at least these pairs in both directions:

- `0 <-> bezel`;
- `0 <-> maxRadius`;
- `bezel / 2 <-> bezel`;
- equal radii;
- radii clamped by a narrow dimension.

Run the sweep for square, wide, and tall elements and for minimum and maximum
bezel values.

### JavaScript and GLSL parity

Evaluate the same parameter and coordinate samples through the JavaScript debug
path and a GLSL-rendered diagnostic target. Differences must be limited to the
expected floating-point precision. Both paths must use the same branch and clamp
thresholds.

### Visual verification

Reproduce `radius = 0`, `virtualRadius = bezel = 60` in all of these views:

- colored 3D height mesh;
- transparent physical material;
- background refraction preview;
- rotated model and changing light directions.

No corner diagonal may become visible. Straight-edge profiles and equal-radius
screenshots must remain unchanged.

### Performance

The map uses analytic arithmetic without LUT texture reads. Equal-radius and
outside-corner cases retain early identity paths. Shader compilation and the
interactive parameter controls must remain responsive at the current viewport
size.
