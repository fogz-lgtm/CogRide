// A simple, stylised rider: low-poly bike and figure whose legs turn with
// cadence, who leans into bends, tucks on fast descents and rises a little
// out of the saddle on steep ramps.

import * as THREE from '../../vendor/three/three.module.min.js';

export function createRider() {
  const group = new THREE.Group();
  const mats = {
    frame: new THREE.MeshLambertMaterial({ color: '#d8d8d8' }),
    tyre: new THREE.MeshLambertMaterial({ color: '#1b1b1d' }),
    jersey: new THREE.MeshLambertMaterial({ color: '#e7e2d6' }),
    shorts: new THREE.MeshLambertMaterial({ color: '#202226' }),
    skin: new THREE.MeshLambertMaterial({ color: '#c99a7a' }),
    helmet: new THREE.MeshLambertMaterial({ color: '#f2f2f2' }),
  };
  const lean = new THREE.Group();
  group.add(lean);

  // Bike (x = right, y = up, z = backward in local space; bike faces −z).
  const wheelGeo = new THREE.TorusGeometry(0.34, 0.025, 6, 20);
  const front = new THREE.Mesh(wheelGeo, mats.tyre);
  const rear = new THREE.Mesh(wheelGeo, mats.tyre);
  front.rotation.y = rear.rotation.y = Math.PI / 2;
  front.position.set(0, 0.34, -0.5);
  rear.position.set(0, 0.34, 0.5);
  const tube = (len, x, y, z, rx = 0, rz = 0) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.017, len, 5), mats.frame);
    m.position.set(x, y, z);
    m.rotation.set(rx, 0, rz);
    return m;
  };
  const frame = new THREE.Group();
  frame.add(tube(0.62, 0, 0.62, -0.05, Math.PI / 2 - 0.12), tube(0.55, 0, 0.55, 0.22, 0.35), tube(0.6, 0, 0.45, -0.32, -0.75), tube(0.5, 0, 0.35, 0.33, Math.PI / 2 - 0.2));
  const bars = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.42, 5), mats.frame);
  bars.rotation.z = Math.PI / 2;
  bars.position.set(0, 0.95, -0.47);
  const saddle = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.03, 0.24), mats.tyre);
  saddle.position.set(0, 0.92, 0.18);
  lean.add(front, rear, frame, bars, saddle);

  // Rider.
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.15, 0.42, 3, 8), mats.jersey);
  torso.position.set(0, 1.18, -0.08);
  torso.rotation.x = -1.05;
  const head = new THREE.Group();
  const face = new THREE.Mesh(new THREE.SphereGeometry(0.1, 10, 8), mats.skin);
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), mats.helmet);
  helmet.position.y = 0.02;
  head.add(face, helmet);
  head.position.set(0, 1.38, -0.38);
  const arm = (side) => {
    const m = new THREE.Mesh(new THREE.CapsuleGeometry(0.04, 0.45, 2, 6), mats.jersey);
    m.position.set(side * 0.17, 1.12, -0.36);
    m.rotation.x = 0.75;
    return m;
  };
  lean.add(torso, head, arm(-1), arm(1));

  // Legs: thigh from hip to knee, shin from knee to pedal; pedals orbit the crank.
  const hip = new THREE.Vector3(0, 1.0, 0.16);
  const crank = new THREE.Vector3(0, 0.36, -0.02);
  const legs = [-1, 1].map((side) => {
    const thigh = new THREE.Mesh(new THREE.CapsuleGeometry(0.065, 0.36, 2, 6), mats.shorts);
    const shin = new THREE.Mesh(new THREE.CapsuleGeometry(0.05, 0.36, 2, 6), mats.skin);
    lean.add(thigh, shin);
    return { side, thigh, shin };
  });

  let phase = 0;
  const up = new THREE.Vector3(0, 1, 0);
  const place = (mesh, a, b) => {
    mesh.position.copy(a).add(b).multiplyScalar(0.5);
    mesh.quaternion.setFromUnitVectors(up, b.clone().sub(a).normalize());
  };

  return {
    group,
    setColors(c = {}) {
      if (c.jersey) mats.jersey.color.set(c.jersey);
      if (c.shorts) mats.shorts.color.set(c.shorts);
      if (c.bike) mats.frame.color.set(c.bike);
      if (c.helmet) mats.helmet.color.set(c.helmet);
      if (c.skin) mats.skin.color.set(c.skin);
    },
    update(dt, { cadence = 0, lean: leanAngle = 0, grade = 0, tucked = false }) {
      phase += (cadence / 60) * Math.PI * 2 * dt;
      lean.rotation.z = -leanAngle;
      // Tuck lowers the head; steep climbs pull the body forward and up.
      const climb = Math.max(0, Math.min(1, (grade - 7) / 6));
      torso.rotation.x = tucked ? -1.35 : -1.05 + climb * 0.25;
      head.position.y = tucked ? 1.24 : 1.38 + climb * 0.04;
      for (const leg of legs) {
        const a = phase + (leg.side > 0 ? 0 : Math.PI);
        const pedal = new THREE.Vector3(leg.side * 0.11, crank.y + Math.sin(a) * 0.17, crank.z + Math.cos(a) * 0.17);
        const hipSide = hip.clone().setX(leg.side * 0.1);
        // Two-bone IK in the plane: knee forward of the hip→pedal line.
        const mid = hipSide.clone().add(pedal).multiplyScalar(0.5);
        const span = hipSide.distanceTo(pedal);
        const bend = Math.sqrt(Math.max(0, 0.46 * 0.46 - (span / 2) ** 2));
        const dir = pedal.clone().sub(hipSide).normalize();
        const forward = new THREE.Vector3(0, dir.z, -dir.y).normalize();
        const knee = mid.add(forward.multiplyScalar(bend));
        place(leg.thigh, hipSide, knee);
        place(leg.shin, knee, pedal);
      }
      front.rotation.x -= cadence * 0.02 * dt;
      rear.rotation.x -= cadence * 0.02 * dt;
    },
  };
}
