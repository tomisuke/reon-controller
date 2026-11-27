const cross = (a,b,c) => (b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
const EPSILON = 1e-8;

function solve(rows) {
  for (let column = 0; column < rows.length; column++) {
    let pivot = column;
    for (let row = column + 1; row < rows.length; row++) {
      if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) pivot = row;
    }
    if (Math.abs(rows[pivot][column]) < EPSILON) return null;
    [rows[pivot], rows[column]] = [rows[column], rows[pivot]];
    const divisor = rows[column][column];
    rows[column] = rows[column].map(value => value/divisor);
    for (let row = 0; row < rows.length; row++) {
      if (row === column) continue;
      const factor = rows[row][column];
      rows[row] = rows[row].map((value,i) => value-factor*rows[column][i]);
    }
  }
  return rows.map(row => row.at(-1));
}

// Points are normalized image coordinates ordered near-left, near-right, far-right, far-left.
export function floorCalibration(corners, widthCm, depthCm) {
  if (corners.length !== 4 || ![widthCm,depthCm].every(value => Number.isFinite(value) && value > 0)) return null;
  if (!corners.every(({x,y}) => [x,y].every(value => Number.isFinite(value) && value >= 0 && value <= 1))) return null;
  const turns = corners.map((point,i) => cross(point,corners[(i+1)%4],corners[(i+2)%4]));
  if (!(turns.every(value => value > .001) || turns.every(value => value < -.001))) return null;
  const coordinates = [[0,depthCm],[widthCm,depthCm],[widthCm,0],[0,0]];
  const rows = corners.flatMap(({x,y},i) => {
    const [u,v] = coordinates[i];
    return [[x,y,1,0,0,0,-u*x,-u*y,u],[0,0,0,x,y,1,-v*x,-v*y,v]];
  });
  const coefficients = solve(rows);
  if (!coefficients?.every(Number.isFinite)) return null;
  return {corners, coefficients, winding:Math.sign(turns[0])};
}

export function floorPoint({corners,coefficients,winding}, point) {
  if (corners.some((corner,i) => winding*cross(corner,corners[(i+1)%4],point) < -EPSILON)) return null;
  const {x,y} = point, [a,b,c,d,e,f,g,h] = coefficients;
  const denominator = g*x+h*y+1;
  if (Math.abs(denominator) < EPSILON) return null;
  return {x:(a*x+b*y+c)/denominator, y:(d*x+e*y+f)/denominator};
}

function floorFeet(calibration, person, width, height) {
  const points = person.points;
  const feet = [[29,31],[30,32]].map(([heel,toe]) => {
    if (!points?.[heel] || !points[toe]) return null;
    const point = {x:(points[heel].x+points[toe].x)/(2*width), y:(points[heel].y+points[toe].y)/(2*height)};
    return floorPoint(calibration,point);
  });
  if (!feet.every(Boolean)) return null;
  return {x:(feet[0].x+feet[1].x)/2, y:(feet[0].y+feet[1].y)/2};
}

export function floorDistance(calibration, first, second, width, height) {
  if (!calibration) return null;
  const a = floorFeet(calibration,first,width,height), b = floorFeet(calibration,second,width,height);
  return a && b ? Math.hypot(a.x-b.x,a.y-b.y) : null;
}
