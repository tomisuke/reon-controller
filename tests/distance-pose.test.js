import {test,expect} from 'bun:test';
import {BODY_GAP_METRIC,DetectionHold,measure,publicReading} from '../dist/distance-core.js';
import {bodyGap,posePoints} from '../dist/distance-pose.js';
import {floorCalibration,floorDistance} from '../dist/distance-floor.js';

const pose=(x,y,scale=1)=>{
  const points=Array.from({length:33},()=>({x:0,y:0,visibility:0}));
  const joints={0:[0,-.12],11:[-.05,0],12:[.05,0],13:[-.06,.08],14:[.06,.08],
    15:[-.07,.15],16:[.07,.15],23:[-.04,.15],24:[.04,.15],
    25:[-.04,.25],26:[.04,.25],27:[-.04,.37],28:[.04,.37],
    29:[-.04,.38],30:[.04,.38],31:[-.04,.39],32:[.04,.39]};
  for(const [index,[dx,dy]] of Object.entries(joints)){
    points[index]={x:x+dx*scale,y:y+dy*scale,visibility:.95};
  }
  return points;
};

function posePeople(poses,width,height) {
  return poses.map(pose=>{
    const points=posePoints(pose,{width,height});
    const visible=points.filter(Boolean);
    const xs=visible.map(point=>point.x),ys=visible.map(point=>point.y);
    const left=Math.min(...xs),top=Math.min(...ys);
    return {points,bbox:[left,top,Math.max(...xs)-left,Math.max(...ys)-top]};
  });
}

test('large people near the lens can be close even with distant detection-box centers',()=>{
  const bounds=[1000,1000];
  const small=posePeople([pose(.28,.32,.6),pose(.66,.32,.6)],...bounds);
  const large=posePeople([pose(.28,.16,2),pose(.66,.16,2)],...bounds);
  const centerResult=people=>measure(people,...bounds,1,[0,1]);
  const bodyResult=people=>measure(people,...bounds,1,[0,1],bodyGap);
  expect(centerResult(large).distanceRatio).toBeCloseTo(centerResult(small).distanceRatio,2);
  expect(bodyResult(large).distanceRatio).toBeLessThan(bodyResult(small).distanceRatio / 3);
  expect(bodyResult(large).points).toHaveLength(2);
});

test('shoulders and arms still measure the gap when legs are outside the frame',()=>{
  const people=posePeople([pose(.3,.8,1.8),pose(.66,.8,1.8)],960,540);
  expect(people).toHaveLength(2);
  expect(people[0].points[27]).toBeNull();
  expect(bodyGap(...people)?.distance).toBeLessThan(people[1].bbox[0]-people[0].bbox[0]);
});

test('crossing body parts are ambiguous and an expired hold has no distance sample',()=>{
  const far=posePeople([pose(.25,.3),pose(.75,.3)],1000,1000);
  const overlap=posePeople([pose(.45,.3),pose(.5,.3)],1000,1000);
  const hold=new DetectionHold(1000);
  const sample=people=>measure(people,1000,1000,1,[0,1],bodyGap);
  hold.update(sample(far),100);
  const missing=hold.update(sample(overlap),300);
  expect(missing.status).toBe('holding');
  expect(missing.distanceRatio).toBe(sample(far).distanceRatio);
  const reading=publicReading({...missing,active:true,receivedAt:2000,holdUntil:2800,targetState:'locked',metric:BODY_GAP_METRIC},2800);
  expect(reading.status).toBe('geometry_unavailable');
  expect(reading.distanceRatio).toBeNull();
  expect(reading.targetState).toBe('locked');
  expect(hold.update(sample(overlap),1100).pair).toBeNull();
});

test('perspective calibration measures known floor distances and rejects out-of-bounds feet',()=>{
  const image=(x,y)=>({x:.5+(x-100)/(400+y),y:.2+y/(400+y)});
  const corners=[image(0,300),image(200,300),image(200,0),image(0,0)];
  const floor=floorCalibration(corners,200,300);
  const person=(x,y)=>{
    const points=Array(33).fill(null);
    for(const [heel,toe,dx] of [[29,31,-5],[30,32,5]]){
      const a=image(x+dx,y);
      points[heel]=points[toe]={x:a.x*960,y:a.y*540};
    }
    return {points};
  };
  const a=person(50,100);
  expect(floorDistance(floor,a,person(130,100),960,540)).toBeCloseTo(80);
  expect(floorDistance(floor,a,person(50,260),960,540)).toBeCloseTo(160);
  expect(floorDistance(floor,a,person(110,180),960,540)).toBeCloseTo(100);
  expect(floorDistance(floor,a,person(210,100),960,540)).toBeNull();
  const hidden=person(50,150);hidden.points[29]=null;
  expect(floorDistance(floor,a,hidden,960,540)).toBeNull();
  expect(floorCalibration([corners[0],corners[2],corners[1],corners[3]],200,300)).toBeNull();
});
