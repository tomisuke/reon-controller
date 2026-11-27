const VERSION = '0.10.21';
const CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@' + VERSION;
const MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
const MIN_LANDMARK_CONFIDENCE = 0.5;

export async function loadPoseDetector() {
  const {FilesetResolver, PoseLandmarker} = await import(CDN + '/vision_bundle.mjs');
  const files = await FilesetResolver.forVisionTasks(CDN + '/wasm');
  return PoseLandmarker.createFromOptions(files, {
    baseOptions: {modelAssetPath: MODEL},
    runningMode: 'IMAGE',
    numPoses: 1,
  });
}

export function posePoints(pose, {left=0,top=0,width,height,frameWidth=width,frameHeight=height}) {
  return pose.map(({x,y,visibility,presence}) => {
    const score = Math.min(visibility ?? 1,presence ?? 1);
    const px = left+x*width, py = top+y*height;
    return score >= MIN_LANDMARK_CONFIDENCE && x > 0 && x < 1 && y > 0 && y < 1 &&
      px > 0 && px < frameWidth && py > 0 && py < frameHeight ? {x:px,y:py} : null;
  });
}

export function poseInBox(detector, image, context, [x,y,width,height]) {
  const {width:frameWidth,height:frameHeight} = image;
  const paddingX = width*.08, paddingY = height*.08;
  const left = Math.max(0,x-paddingX), top = Math.max(0,y-paddingY);
  const cropWidth = Math.min(frameWidth,x+width+paddingX)-left;
  const cropHeight = Math.min(frameHeight,y+height+paddingY)-top;
  if (cropWidth < 2 || cropHeight < 2) return null;

  // Crop around the tracked person so nearby poses do not compete in a single detection.
  const scale = Math.min(1,384/Math.max(cropWidth,cropHeight));
  const canvas = context.canvas;
  canvas.width = Math.max(2,Math.round(cropWidth*scale));
  canvas.height = Math.max(2,Math.round(cropHeight*scale));
  context.drawImage(image,left,top,cropWidth,cropHeight,0,0,canvas.width,canvas.height);
  const {landmarks:[pose]} = detector.detect(canvas);
  if (!pose) return null;
  const points = posePoints(pose,{left,top,width:cropWidth,height:cropHeight,frameWidth,frameHeight});
  // Require reliable torso landmarks inside the selected detection.
  const anchors = [11,12,23,24].map(index=>points[index]).filter(point=>
    point && point.x >= x && point.x <= x+width && point.y >= y && point.y <= y+height);
  return anchors.length >= 2 ? points : null;
}

const bodySegments = [
  [7, 8, .22], [0, 7, .14], [0, 8, .14], [0, 0, .22],
  [11, 12, .17], [23, 24, .18], [11, 23, .18], [12, 24, .18],
  [11, 24, .15], [12, 23, .15],
  [11, 13, .12], [12, 14, .12], [13, 15, .09], [14, 16, .09],
  [15, 19, .08], [16, 20, .08], [15, 21, .08], [16, 22, .08],
  [23, 25, .15], [24, 26, .15], [25, 27, .12], [26, 28, .12],
  [27, 31, .08], [28, 32, .08],
];
const subtract = (a,b) => ({x:a.x-b.x, y:a.y-b.y});
const dot = (a,b) => a.x*b.x + a.y*b.y;
const cross = (a,b) => a.x*b.y - a.y*b.x;
const between = (a,b,t) => ({x:a.x + (b.x-a.x)*t, y:a.y + (b.y-a.y)*t});
const length = (a,b) => Math.hypot(a.x-b.x, a.y-b.y);

function body(points) {
  if (!points) return [];
  // Estimate body thickness from visible torso landmarks, independently of the visible crop.
  const scale = Math.max(0, ...[[11,12,1], [23,24,1.15], [11,23,.75], [12,24,.75]]
    .filter(([a,b]) => points[a] && points[b])
    .map(([a,b,factor]) => length(points[a],points[b]) * factor));
  if (!scale) return [];
  return bodySegments.filter(([a,b]) => points[a] && points[b])
    .map(([a,b,radius]) => ({a:points[a], b:points[b], radius:scale*radius}));
}

function closestOnSegment(point, a, b) {
  const direction = subtract(b,a), squared = dot(direction,direction);
  const t = squared ? dot(subtract(point,a),direction)/squared : 0;
  return between(a,b,Math.max(0,Math.min(1,t)));
}

function closestAxes({a,b}, {a:c,b:d}) {
  const ab = subtract(b,a), cd = subtract(d,c), ac = subtract(c,a);
  const area = cross(ab,cd);
  if (area) {
    const t = cross(ac,cd)/area, u = cross(ac,ab)/area;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
      const intersection = between(a,b,t);
      return [intersection,intersection,0];
    }
  }
  const candidates = [[a,closestOnSegment(a,c,d)], [b,closestOnSegment(b,c,d)],
    [closestOnSegment(c,a,b),c], [closestOnSegment(d,a,b),d]];
  return candidates.map(([p,q]) => [p,q,length(p,q)]).sort((p,q) => p[2]-q[2])[0];
}

export function bodyGap(first, second) {
  const a = body(first.points), b = body(second.points);
  let closest = null;
  for (const segment of a) for (const other of b) {
    const [p,q,distance] = closestAxes(segment,other);
    // Crossing pose axes in the image make the visible separation ambiguous.
    if (distance < 1) return null;
    const gap = Math.max(0,distance-segment.radius-other.radius);
    if (closest && closest.distance <= gap) continue;
    const start = between(p,q,Math.min(segment.radius/distance,1));
    const end = gap ? between(q,p,other.radius/distance) : start;
    closest = {distance:gap, points:[start,end]};
  }
  return closest;
}
