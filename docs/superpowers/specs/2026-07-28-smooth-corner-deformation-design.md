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
  height profile, normal, specular, and refraction calculations.
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
  -> virtual glass field, height, normal, refraction, and background sampling
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

`M_r` is a symmetric Hermite-Coons displacement patch over canonical corner
coordinates `(u, v)` for `alpha = r / E`. Its top and right boundary curves
contain the exact straight segment and the corresponding half of the exact
radius-`r` circular arc. The two curves meet at the arc midpoint, so no internal
top-versus-right selection is needed.

Let `DeltaTop(u)` and `DeltaRight(v)` be the differences between those exact
boundary curves and the square boundary, and let `DeltaCorner` be their shared
corner displacement. The interior map is:

\[
M_r(u,v)=(u,v)
  +H(v)\Delta Top(u)
  +H(u)\Delta Right(v)
  -H(u)H(v)\Delta Corner
\]

where `H(s) = 6s^5 - 15s^4 + 10s^3`. This Boolean-sum construction gives:

- `alpha = 0`: the exact square parameterization;
- `alpha = 1`: the exact quarter-disc boundary;
- intermediate values: the exact radius-`r` arc and adjacent straight segments;
- zero displacement and zero first derivative at both identity joins;
- symmetry across the corner diagonal without a diagonal branch.

The boundary arc parameter uses cubic Hermite endpoint tangents, making the
straight-to-arc join C1. `M_r^-1` is evaluated with seven fixed Newton steps.
The branch-free elliptical-grid disc-to-square inverse supplies the initial
estimate:

\[
q_0 = mix(p, D^{-1}(p), alpha).
\]

The base map's analytic Jacobian is reused by Newton inversion. The only
unavoidable singularity for an exact square outline is the square's boundary
corner itself; it must not extend into an interior seam. After the depth
correction below, the CPU evaluates the complete final Jacobian with a centered
difference for the screen-facing 3D normal only; the fragment shader does not
need that Jacobian.

### Bezel-depth preservation

The Hermite-Coons map preserves outlines and angular continuity but does not by
itself preserve the material's bezel-depth parameter. For
`radius = 0`, `virtualRadius = bezel`, its uncorrected diagonal samples stay too
close to the virtual outer arc, bending a profile that is linear in master.

The final two-dimensional map therefore carries a scalar source depth. On the
corner diagonal it is exactly:

\[
\tau_s = depth / bezel.
\]

Away from the diagonal it equals the nearest straight-edge progress. A compact
C1 splice changes only the derivative transition around equal x/y progress; it
preserves the exact diagonal values, outer boundary, flat-top join, and straight
regions. The correction strength is
`clamp((virtualRadius - radius) / bezel, 0, 1)`, so it vanishes continuously for
equal radii and does not create a `bezel - 1` to `bezel` jump.

Starting from the smooth Coons-mapped point, three fixed normal-projection steps
move only the final virtual coordinate onto the requested virtual-field depth.
All height, profile, shading, and refraction formulas remain unchanged and
consume that corrected virtual coordinate.

The implementation must not linearly interpolate two signed-distance fields or
blend two nearest-edge branches. Those constructions can reintroduce derivative
seams or move the defect to the corner-region boundary.

## Field and normal semantics

The shader evaluates all glass quantities at `pVirtual`:

- field progress `t` and the `profilePower` height curve;
- virtual surface slope and optical normal;
- refraction magnitude and direction;
- Fresnel/specular contribution;
- base and displaced background samples.

Only the actual outline mask and final displayed coordinate use `pActual`. This
preserves the required post-process semantics: render the complete
`virtualRadius` glass first, then deform its final result to the `radius` outline.

For the 3D surface, the displayed position remains `(pActual.x, pActual.y)` and
its height is:

\[
z(p_a)=h\left(t(F(p_a))\right).
\]

The mapping exposes its Jacobian
`J = partial(pVirtual) / partial(pActual)`. The displayed height gradient is:

\[
\nabla_{p_a}z = J^T\nabla_{p_v}z.
\]

Only the screen-facing top geometry uses that transformed gradient. Side walls
and corner columns retain the actual outline and may keep their hard corners.

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
- changing `radius` leaves `t`, height, normal, and refraction samples exactly
  unchanged wherever the mapping returns the identity; in particular,
  `radius = bezel - 1` and `radius = bezel` must not alter non-corner regions.
- for `radius = 0` and `virtualRadius = bezel`, diagonal depth samples at
  `5, 10, 20, 30, 40, 50px` equal the corresponding straight-edge samples and
  `depth / bezel`;

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
