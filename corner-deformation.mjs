export const CORNER_EPSILON = 1e-5;
export const CORNER_EQUAL_RADIUS_EPSILON = 1e-4;

const clamp = (value, low, high) => Math.min(Math.max(value, low), high);
const safeSqrt = value => Math.sqrt(Math.max(value, 0));

export function postprocessCornerDepth(xProgress, yProgress) {
  const x = clamp(xProgress, 0, 1);
  const y = clamp(yProgress, 0, 1);
  const lower = Math.min(x, y);
  const difference = Math.abs(x - y);
  const blendWidth = 6 * x * y * (1 - x) * (1 - y);
  if (blendWidth <= CORNER_EPSILON || difference >= blendWidth) return lower;

  const blendProgress = difference / blendWidth;
  const remaining = 1 - blendProgress;
  return clamp(lower + 0.5 * difference * remaining * remaining, 0, 1);
}


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


function inverseJacobian([j00, j01, j10, j11]) {
  const determinant = j00 * j11 - j01 * j10;
  return [
    j11 / determinant,
    -j01 / determinant,
    -j10 / determinant,
    j00 / determinant,
  ];
}

function identityResult(point) {
  return { point, jacobian: [1, 0, 0, 1], determinant: 1 };
}

function quintic01(value) {
  const s = clamp(value, 0, 1);
  return s * s * s * (s * (s * 6 - 15) + 10);
}

function quinticDerivative(value) {
  const s = clamp(value, 0, 1);
  return 30 * s * s * (s - 1) * (s - 1);
}

function arcParameter(value) {
  const s = clamp(value, 0, 1);
  const tangent = Math.SQRT2;
  const s2 = s * s;
  const s3 = s2 * s;
  return (s3 - 2 * s2 + s) * tangent
    + (-2 * s3 + 3 * s2)
    + (s3 - s2) * tangent;
}

function arcParameterDerivative(value) {
  const s = clamp(value, 0, 1);
  const tangent = Math.SQRT2;
  return (3 * s * s - 4 * s + 1) * tangent
    + (-6 * s * s + 6 * s)
    + (3 * s * s - 2 * s) * tangent;
}

function unitArc(startX, startY, endX, endY, parameter, parameterDerivative) {
  const dx = endX - startX;
  const dy = endY - startY;
  const x = startX + dx * parameter;
  const y = startY + dy * parameter;
  const length = Math.hypot(x, y);
  const nx = x / length;
  const ny = y / length;
  const rawDx = dx * parameterDerivative;
  const rawDy = dy * parameterDerivative;
  const parallel = nx * rawDx + ny * rawDy;
  return {
    point: [nx, ny],
    derivative: [
      (rawDx - nx * parallel) / length,
      (rawDy - ny * parallel) / length,
    ],
  };
}

function topBoundary(value, alpha) {
  if (alpha <= CORNER_EPSILON || value <= 1 - alpha) {
    return { point: [value, 1], derivative: [1, 0] };
  }
  const local = (value - (1 - alpha)) / alpha;
  const arc = unitArc(
    0, 1, Math.SQRT1_2, Math.SQRT1_2,
    arcParameter(local), arcParameterDerivative(local),
  );
  return {
    point: [
      1 - alpha + alpha * arc.point[0],
      1 - alpha + alpha * arc.point[1],
    ],
    derivative: arc.derivative,
  };
}

function rightBoundary(value, alpha) {
  if (alpha <= CORNER_EPSILON || value <= 1 - alpha) {
    return { point: [1, value], derivative: [0, 1] };
  }
  const local = (value - (1 - alpha)) / alpha;
  const arc = unitArc(
    1, 0, Math.SQRT1_2, Math.SQRT1_2,
    arcParameter(local), arcParameterDerivative(local),
  );
  return {
    point: [
      1 - alpha + alpha * arc.point[0],
      1 - alpha + alpha * arc.point[1],
    ],
    derivative: arc.derivative,
  };
}

function roundedSquareMap(u, v, alpha) {
  const top = topBoundary(u, alpha);
  const right = rightBoundary(v, alpha);
  const topDelta = [top.point[0] - u, top.point[1] - 1];
  const rightDelta = [right.point[0] - 1, right.point[1] - v];
  const cornerDelta = alpha * (Math.SQRT1_2 - 1);
  const hu = quintic01(u);
  const hv = quintic01(v);
  const dhu = quinticDerivative(u);
  const dhv = quinticDerivative(v);
  const point = [
    u + hv * topDelta[0] + hu * rightDelta[0] - hu * hv * cornerDelta,
    v + hv * topDelta[1] + hu * rightDelta[1] - hu * hv * cornerDelta,
  ];
  const topDerivative = [top.derivative[0] - 1, top.derivative[1]];
  const rightDerivative = [right.derivative[0], right.derivative[1] - 1];
  return {
    point,
    jacobian: [
      1 + hv * topDerivative[0] + dhu * rightDelta[0] - dhu * hv * cornerDelta,
      dhv * topDelta[0] + hu * rightDerivative[0] - hu * dhv * cornerDelta,
      hv * topDerivative[1] + dhu * rightDelta[1] - dhu * hv * cornerDelta,
      1 + dhv * topDelta[1] + hu * rightDerivative[1] - hu * dhv * cornerDelta,
    ],
  };
}

function invertRoundedSquare(point, alpha) {
  const corner = 1 - alpha + alpha * Math.SQRT1_2;
  if (Math.hypot(point[0] - corner, point[1] - corner) <= CORNER_EPSILON) {
    return [1, 1];
  }
  const discInitial = discToSquare(point[0], point[1]);
  let u = clamp(point[0] + alpha * (discInitial[0] - point[0]), 0, 1);
  let v = clamp(point[1] + alpha * (discInitial[1] - point[1]), 0, 1);
  for (let iteration = 0; iteration < 7; iteration++) {
    const mapped = roundedSquareMap(u, v, alpha);
    const errorX = mapped.point[0] - point[0];
    const errorY = mapped.point[1] - point[1];
    const inverse = inverseJacobian(mapped.jacobian);
    u = clamp(u - inverse[0] * errorX - inverse[1] * errorY, 0, 1);
    v = clamp(v - inverse[2] * errorX - inverse[3] * errorY, 0, 1);
  }
  return [u, v];
}

function localMap(point, halfSize, from, to, bezel) {
  const limit = Math.min(halfSize[0], halfSize[1]);
  const extent = Math.min(Math.max(bezel, from, to, 1), limit);
  const sx = point[0] < 0 ? -1 : 1;
  const sy = point[1] < 0 ? -1 : 1;
  const dx = halfSize[0] - Math.abs(point[0]);
  const dy = halfSize[1] - Math.abs(point[1]);
  if (dx >= extent || dy >= extent) return identityResult(point);

  const normalized = [1 - dx / extent, 1 - dy / extent];
  const canonical = invertRoundedSquare(normalized, from / extent);
  const source = roundedSquareMap(...canonical, from / extent);
  const target = roundedSquareMap(...canonical, to / extent);
  let sourceJacobian = source.jacobian;
  let targetJacobian = target.jacobian;
  let sourceDeterminant = sourceJacobian[0] * sourceJacobian[3]
    - sourceJacobian[1] * sourceJacobian[2];
  if (Math.abs(sourceDeterminant) <= CORNER_EPSILON) {
    const oneSided = canonical.map(value => Math.min(value, 1 - 1e-3));
    sourceJacobian = roundedSquareMap(...oneSided, from / extent).jacobian;
    targetJacobian = roundedSquareMap(...oneSided, to / extent).jacobian;
    sourceDeterminant = sourceJacobian[0] * sourceJacobian[3]
      - sourceJacobian[1] * sourceJacobian[2];
  }
  const localJacobian = [
    targetJacobian[0] * sourceJacobian[3]
      - targetJacobian[1] * sourceJacobian[2],
    -targetJacobian[0] * sourceJacobian[1]
      + targetJacobian[1] * sourceJacobian[0],
    targetJacobian[2] * sourceJacobian[3]
      - targetJacobian[3] * sourceJacobian[2],
    -targetJacobian[2] * sourceJacobian[1]
      + targetJacobian[3] * sourceJacobian[0],
  ];
  for (let i = 0; i < localJacobian.length; i++) {
    localJacobian[i] /= sourceDeterminant;
  }
  const jacobian = [
    localJacobian[0],
    sx * sy * localJacobian[1],
    sx * sy * localJacobian[2],
    localJacobian[3],
  ];
  const mappedPoint = [
    sx * (halfSize[0] - extent + target.point[0] * extent),
    sy * (halfSize[1] - extent + target.point[1] * extent),
  ];
  return {
    point: mappedPoint,
    jacobian,
    determinant: jacobian[0] * jacobian[3] - jacobian[1] * jacobian[2],
  };
}

export function mapActualToVirtual(point, halfSize, radius, virtualRadius, bezel) {
  const limit = Math.min(halfSize[0], halfSize[1]);
  const from = clamp(radius, 0, limit);
  const to = clamp(virtualRadius, 0, limit);
  if (Math.abs(from - to) <= CORNER_EQUAL_RADIUS_EPSILON) return point;
  return localMap(point, halfSize, from, to, bezel).point;
}

export function mapActualToVirtualWithJacobian(
  point, halfSize, radius, virtualRadius, bezel,
) {
  const limit = Math.min(halfSize[0], halfSize[1]);
  const from = clamp(radius, 0, limit);
  const to = clamp(virtualRadius, 0, limit);
  if (Math.abs(from - to) <= CORNER_EQUAL_RADIUS_EPSILON) {
    return identityResult(point);
  }
  return localMap(point, halfSize, from, to, bezel);
}
