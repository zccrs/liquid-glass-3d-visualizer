import test from 'node:test';
import assert from 'node:assert/strict';
import {
  discToSquare,
  mapActualToVirtual,
  mapActualToVirtualWithJacobian,
  postprocessCornerDepth,
  squareToDisc,
} from './corner-deformation.mjs';

const close = (a, b, epsilon = 1e-9) => Math.abs(a - b) <= epsilon;

function assertPointClose(actual, expected, epsilon = 1e-9) {
  assert.ok(close(actual[0], expected[0], epsilon), `${actual[0]} != ${expected[0]}`);
  assert.ok(close(actual[1], expected[1], epsilon), `${actual[1]} != ${expected[1]}`);
}

test('equal radii are an exact identity path', () => {
  const points = [[0, 0], [149.5, 99.5], [-145, 80], [90, -75]];
  for (const point of points) {
    assert.deepEqual(mapActualToVirtual(point, [150, 100], 60, 60, 60), point);
  }
});

test('elliptical-grid basis round-trips away from boundary singularities', () => {
  for (const point of [[0, 0], [.2, -.4], [-.75, .5], [.9, .2]]) {
    assertPointClose(discToSquare(...squareToDisc(...point)), point);
  }
});

function roundedRectSdf([x, y], [hx, hy], radius) {
  const r = Math.min(Math.max(radius, 0), Math.min(hx, hy));
  const qx = Math.abs(x) - (hx - r);
  const qy = Math.abs(y) - (hy - r);
  return Math.min(Math.max(qx, qy), 0)
    + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r;
}

function topRightOutline([hx, hy], radius, extent, steps = 24) {
  const points = [];
  const straight = extent - radius;
  for (let i = 0; i <= steps; i++) {
    const distance = extent - straight * i / steps;
    points.push([hx - distance, hy]);
    points.push([hx, hy - distance]);
  }
  if (radius > 0) {
    for (let i = 0; i <= steps * 2; i++) {
      const angle = Math.PI * .5 * i / (steps * 2);
      points.push([
        hx - radius + radius * Math.cos(angle),
        hy - radius + radius * Math.sin(angle),
      ]);
    }
  }
  return points;
}

test('a square corner maps exactly to the virtual rounded outline', () => {
  const halfSize = [150, 100];
  const outline = [];
  for (let distance = 0; distance <= 60; distance += 2) {
    outline.push([halfSize[0] - distance, halfSize[1]]);
    outline.push([halfSize[0], halfSize[1] - distance]);
  }
  for (const point of outline) {
    const mapped = mapActualToVirtual(point, halfSize, 0, 60, 60);
    assert.ok(Math.abs(roundedRectSdf(mapped, halfSize, 60)) < 1e-9);
  }
});

test('the square-to-round warp has no diagonal derivative seam', () => {
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
    const jump = Math.max(
      ...a.jacobian.map((value, index) => Math.abs(value - b.jacobian[index])),
    );
    assert.ok(jump < 1e-3, `Jacobian jump ${jump} at depth ${depth}`);
    assert.ok(a.determinant > 0);
    assert.ok(b.determinant > 0);
  }
});

test('all radius pairs preserve their exact source and target outlines', () => {
  const halfSize = [150, 100];
  for (const [from, to] of [[0, 60], [60, 0], [20, 60], [60, 20], [20, 45]]) {
    for (const point of topRightOutline(halfSize, from, 60)) {
      const mapped = mapActualToVirtual(point, halfSize, from, to, 60);
      const error = Math.abs(roundedRectSdf(mapped, halfSize, to));
      assert.ok(error < 1e-7, `${from}->${to} ${point} -> ${mapped} error ${error}`);
    }
  }
});

test('all supported radius pairs stay bijective inside the glass', () => {
  const halfSize = [150, 100];
  const pairs = [[0, 60], [60, 0], [20, 60], [60, 20], [20, 45], [45, 20]];
  for (const [from, to] of pairs) {
    for (let dx = 1; dx < 60; dx += 3) {
      for (let dy = 1; dy < 60; dy += 3) {
        const point = [halfSize[0] - dx, halfSize[1] - dy];
        if (roundedRectSdf(point, halfSize, from) >= -1e-4) continue;
        const forward = mapActualToVirtualWithJacobian(
          point, halfSize, from, to, 60,
        );
        assert.ok(
          forward.determinant > 0,
          `${from}->${to} folded at ${point}: ${forward.determinant}`,
        );
        const reversed = mapActualToVirtual(
          forward.point, halfSize, to, from, 60,
        );
        assertPointClose(reversed, point, 2e-5);
      }
    }
  }
});

test('size, bezel, direction, and corner-sign matrix preserves invariants', () => {
  const cases = [
    { halfSize: [150, 100], bezel: 60, pairs: [[0, 60], [60, 0], [30, 60], [60, 30]] },
    { halfSize: [200, 40], bezel: 39, pairs: [[0, 39], [39, 0], [20, 39], [39, 20]] },
    { halfSize: [40, 200], bezel: 39, pairs: [[0, 39], [39, 0], [20, 39], [39, 20]] },
    { halfSize: [40, 30], bezel: 60, pairs: [[0, 30], [30, 0], [15, 30], [30, 15]] },
  ];
  for (const { halfSize, bezel, pairs } of cases) {
    const limit = Math.min(...halfSize);
    const extent = Math.min(Math.max(bezel, 1), limit);
    for (const [requestedFrom, requestedTo] of pairs) {
      const from = Math.min(requestedFrom, limit);
      const to = Math.min(requestedTo, limit);
      for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
          for (let dx = 1; dx < extent; dx += 3) {
            for (let dy = 1; dy < extent; dy += 3) {
              const point = [
                sx * (halfSize[0] - dx),
                sy * (halfSize[1] - dy),
              ];
              if (roundedRectSdf(point, halfSize, from) >= -1e-4) continue;
              const mapped = mapActualToVirtualWithJacobian(
                point, halfSize, from, to, bezel,
              );
              assert.ok(mapped.determinant > 0);
              const reversed = mapActualToVirtual(
                mapped.point, halfSize, to, from, bezel,
              );
              assertPointClose(reversed, point, 3e-5);
            }
          }
        }
      }
    }
  }
});

test('corner influence joins are exact identities with identity Jacobians', () => {
  const halfSize = [150, 100];
  for (const [from, to] of [[0, 60], [60, 0], [20, 45], [45, 20]]) {
    for (const point of [[90, 70], [120, 40], [-90, -70], [-120, -40]]) {
      assert.deepEqual(mapActualToVirtual(point, halfSize, from, to, 60), point);
      assert.deepEqual(
        mapActualToVirtualWithJacobian(point, halfSize, from, to, 60),
        { point, jacobian: [1, 0, 0, 1], determinant: 1 },
      );
    }
  }
});

test('reverse mapping returns a finite one-sided Jacobian at the virtual sharp corner', () => {
  const halfSize = [150, 100];
  const radius = 60;
  const arcMidpoint = [
    halfSize[0] - radius + radius * Math.SQRT1_2,
    halfSize[1] - radius + radius * Math.SQRT1_2,
  ];
  const result = mapActualToVirtualWithJacobian(
    arcMidpoint, halfSize, radius, 0, 60,
  );
  assert.ok(result.jacobian.every(Number.isFinite), `${result.jacobian}`);
  assert.ok(
    result.jacobian.every(value => Math.abs(value) < 1e4),
    `unbounded one-sided Jacobian ${result.jacobian}`,
  );
  assert.ok(Number.isFinite(result.determinant), `${result.determinant}`);
  assert.deepEqual(result.point, [halfSize[0], halfSize[1]]);
});


test('postprocess corner depth preserves the master diagonal profile', () => {
  for (const progress of [0, 1 / 12, 1 / 6, 1 / 3, 0.5, 2 / 3, 5 / 6, 1]) {
    assert.ok(close(
      postprocessCornerDepth(progress, progress),
      progress,
    ), `diagonal progress changed at ${progress}`);
  }
});

test('postprocess corner depth preserves straight joins', () => {
  for (const progress of [0, 0.1, 0.3, 0.5, 0.8, 1]) {
    assert.ok(close(postprocessCornerDepth(0, progress), 0));
    assert.ok(close(postprocessCornerDepth(1, progress), progress));
    assert.ok(close(postprocessCornerDepth(progress, 1), progress));
  }
});

test('postprocess corner depth is C1 across the diagonal', () => {
  const epsilon = 1e-5;
  for (const progress of [0.1, 0.2, 0.4, 0.5, 0.7, 0.9]) {
    const center = postprocessCornerDepth(progress, progress);
    const leftSlope = (
      center - postprocessCornerDepth(progress - epsilon, progress)
    ) / epsilon;
    const rightSlope = (
      postprocessCornerDepth(progress + epsilon, progress) - center
    ) / epsilon;
    assert.ok(
      Math.abs(leftSlope - rightSlope) < 2e-3,
      `${progress}: ${leftSlope} != ${rightSlope}`,
    );
  }
});
