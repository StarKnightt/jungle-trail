/* Procedural first-person body.
 *
 * This is a real world-space character rather than a pair of meshes attached
 * to the camera. Camera-attached arms are easy to keep in frame, but they do
 * not cast a coherent shadow, they rotate with head pitch as if the shoulders
 * were in the skull, and the feet can never agree with the terrain. The rig
 * below follows the walker's unbobbed eye position and yaw; the camera then
 * moves over it by the same few centimetres a person's head moves over their
 * torso.
 *
 * The geometry uses rigid-weight skinning: every procedural piece is weighted
 * to one named bone, while pieces that cross a joint overlap beneath a cuff,
 * trouser fold or boot collar. Smooth blended skin would spend vertices and
 * setup on shoulder and knee deformation that the first-person camera never
 * sees. Plain child meshes would solve that, but would turn every finger,
 * sleeve and boot into another draw call. Rigid pieces merged by material into
 * SkinnedMesh batches keep the useful part of a skeleton — one coherent rig,
 * shared gait and a third-person-ready hierarchy — at five first-person draws.
 */
import * as THREE from 'three';
import { bakeSurface } from '../gfx/bake.js';
import { BODY_ATLAS, BODY_SURFACE } from './bodyTex.js';

export const BODY_WORLD_LAYER = 2;
export const BODY_FIRST_PERSON_LAYER = 3;

const TAU = Math.PI * 2;
const DOWN = new THREE.Vector3(0, -1, 0);
const X_AXIS = new THREE.Vector3(1, 0, 0);
const PAD = 0.035;
const FP_LEG_TILT = 0.30;
const FP_KNEE_Z = -0.12;
const UPPER_LEG = 0.50;
const LOWER_LEG = 0.50;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (v) => {
  const t = clamp(v, 0, 1);
  return t * t * (3 - 2 * t);
};
const fract = (v) => v - Math.floor(v);

function matrixAt(position, scale = null, euler = null) {
  const q = euler ? new THREE.Quaternion().setFromEuler(euler) : new THREE.Quaternion();
  return new THREE.Matrix4().compose(
    position,
    q,
    scale || new THREE.Vector3(1, 1, 1),
  );
}

/* A material batch is also the body atlas mapper. Keeping the remap here means
 * no primitive can accidentally sample the whole atlas and put a shirt weave
 * across a hand; the source geometry remains ordinary zero-to-one UVs. */
class MeshBatch {
  constructor(cell) {
    this.cell = cell;
    this.pos = [];
    this.nor = [];
    this.uv = [];
    this.skin = [];
    this.weight = [];
    this.idx = [];
  }

  add(source, transform, boneIndex) {
    if (!source.attributes.normal) source.computeVertexNormals();
    const p = source.attributes.position;
    const n = source.attributes.normal;
    const uv = source.attributes.uv;
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(transform);
    const P = new THREE.Vector3();
    const N = new THREE.Vector3();
    const base = this.pos.length / 3;
    const col = this.cell % BODY_ATLAS.columns;
    const row = Math.floor(this.cell / BODY_ATLAS.columns);
    const span = 1 - PAD * 2;

    for (let i = 0; i < p.count; i++) {
      P.fromBufferAttribute(p, i).applyMatrix4(transform);
      N.fromBufferAttribute(n, i).applyMatrix3(normalMatrix).normalize();
      this.pos.push(P.x, P.y, P.z);
      this.nor.push(N.x, N.y, N.z);

      const su = uv ? uv.getX(i) : 0.5;
      const sv = uv ? uv.getY(i) : 0.5;
      this.uv.push(
        (col + PAD + su * span) / BODY_ATLAS.columns,
        (row + PAD + sv * span) / BODY_ATLAS.rows,
      );
      this.skin.push(boneIndex, 0, 0, 0);
      this.weight.push(1, 0, 0, 0);
    }

    if (source.index) {
      for (let i = 0; i < source.index.count; i++) {
        this.idx.push(base + source.index.getX(i));
      }
    } else {
      for (let i = 0; i < p.count; i++) this.idx.push(base + i);
    }
    source.dispose();
  }

  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('uv2', new THREE.Float32BufferAttribute(this.uv.slice(), 2));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.skin, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.weight, 4));
    g.setIndex(this.idx);
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }

  get triangles() { return this.idx.length / 3; }
}

/* A limb is not a cylinder. The slight end rounding keeps a cuff or knee from
 * ending in a perfectly planar ring, while the independently tapered x and z
 * radii give forearms, calves and fingers the flattened section they have in
 * life. The ends stay broad because adjacent pieces overlap there; collapsing
 * them to points would make every articulated joint look like a string of
 * beads when it bends. */
function segmentGeometry(length, topX, topZ, bottomX, bottomZ, radial, rings = 5) {
  const pos = [], uv = [], idx = [];
  for (let i = 0; i <= rings; i++) {
    const t = i / rings;
    const rounded = 0.76 + 0.24 * Math.pow(Math.sin(Math.PI * t), 0.55);
    const rx = lerp(topX, bottomX, t) * rounded;
    const rz = lerp(topZ, bottomZ, t) * rounded;
    for (let j = 0; j <= radial; j++) {
      const u = j / radial;
      const a = u * TAU;
      pos.push(Math.cos(a) * rx, -t * length, Math.sin(a) * rz);
      uv.push(u, 1 - t);
    }
  }
  const row = radial + 1;
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * row + j, b = a + 1, c = a + row, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  /* Looking down exposes the top of every thigh and boot shaft. Leaving these
   * procedural sweeps open turns each one into a dark hollow ring — a subtle
   * shortcut on scenery and an immediate mechanical tell on a body. The caps
   * share the rim so their normals roll into the side instead of making a
   * razor edge at every cuff. */
  const top = pos.length / 3;
  pos.push(0, 0, 0); uv.push(0.5, 1);
  const bottom = pos.length / 3;
  pos.push(0, -length, 0); uv.push(0.5, 0);
  const last = rings * row;
  for (let j = 0; j < radial; j++) {
    idx.push(top, j + 1, j);
    idx.push(bottom, last + j, last + j + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/* Torso and pelvis profiles need more control than scaled spheres offer. Each
 * ring has its own depth and centre offset, so the shirt can have a real waist
 * and the backpack can sit behind it without exaggerating anatomy that is not
 * meant to be the subject of the shot. */
function loftGeometry(profile, radial) {
  const pos = [], uv = [], idx = [];
  for (let i = 0; i < profile.length; i++) {
    const r = profile[i];
    for (let j = 0; j <= radial; j++) {
      const u = j / radial;
      const a = u * TAU;
      pos.push(
        (r.x || 0) + Math.cos(a) * r.rx,
        r.y,
        (r.z || 0) + Math.sin(a) * r.rz,
      );
      uv.push(u, 1 - i / (profile.length - 1));
    }
  }
  const row = radial + 1;
  for (let i = 0; i < profile.length - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * row + j, b = a + 1, c = a + row, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function addShape(batch, geometry, bone, position, scale = null, rotation = null) {
  batch.add(geometry, matrixAt(position, scale, rotation), bone);
}

function addSegment(batch, bone, position, length, radii, detail, rotation = null) {
  addShape(
    batch,
    segmentGeometry(
      length,
      radii[0], radii[1], radii[2], radii[3],
      detail.radial,
      detail.rings,
    ),
    bone,
    position,
    null,
    rotation,
  );
}

function addEllipsoid(batch, bone, position, radii, detail, segments = null) {
  addShape(
    batch,
    new THREE.SphereGeometry(
      1,
      segments || detail.sphere,
      Math.max(5, Math.floor((segments || detail.sphere) * 0.66)),
    ),
    bone,
    position,
    new THREE.Vector3(radii[0], radii[1], radii[2]),
  );
}

function addBox(batch, bone, position, size, rotation = null) {
  addShape(
    batch,
    new THREE.BoxGeometry(size[0], size[1], size[2], 1, 1, 1),
    bone,
    position,
    null,
    rotation,
  );
}

export class PlayerBody {
  constructor(renderer, walker, { tier = 'high' } = {}) {
    this.walker = walker;
    this.root = new THREE.Group();
    this.root.name = 'playerBody';
    this.root.frustumCulled = false;
    this.meshes = [];
    this.materials = [];
    this._visibleTriangles = 0;
    this._hiddenTriangles = 0;
    this._moveDir = new THREE.Vector2(0, -1);
    this._prev = new THREE.Vector3(walker.pos.x, 0, walker.pos.z);
    this._tmp = {
      d: new THREE.Vector3(),
      pole: new THREE.Vector3(),
      perp: new THREE.Vector3(),
      knee: new THREE.Vector3(),
      a: new THREE.Vector3(),
      b: new THREE.Vector3(),
      q0: new THREE.Quaternion(),
      q1: new THREE.Quaternion(),
      q2: new THREE.Quaternion(),
      q3: new THREE.Quaternion(),
    };
    this._feet = {
      L: {
        planted: false,
        anchor: new THREE.Vector3(),
        local: new THREE.Vector3(),
      },
      R: {
        planted: false,
        anchor: new THREE.Vector3(),
        local: new THREE.Vector3(),
      },
    };
    this._lastJumpState = walker.jumpState;
    this._reachDrop = 0;

    /* Deriving this once from the placed walker keeps the body aligned if the
     * controller's eye constant is tuned later. Copying 1.66 into two modules
     * is exactly how a neck stump appears after an innocent camera-height pass. */
    this.eyeHeight = walker.pos.y
      - walker.terrain.height(walker.pos.x, walker.pos.z);

    this.detail = tier === 'low'
      ? { radial: 7, rings: 4, sphere: 9 }
      : tier === 'medium'
        ? { radial: 8, rings: 5, sphere: 10 }
        : { radial: 10, rings: 6, sphere: 12 };

    this._buildSkeleton();
    this._buildMaterials(renderer, tier);
    this._buildGeometry();
    this.setQuality(tier);
    this._placeRoot();
    this._poseArms(0, 0);
    this._poseLegs(0, this._moveDir, 0);
    this._poseFirstPersonLegs(0, this._moveDir, 0);
  }

  _addBone(name, parent, x, y, z) {
    const b = new THREE.Bone();
    b.name = name;
    b.position.set(x, y, z);
    parent.add(b);
    this.bone[name] = b;
    this.boneIndex[name] = this.bones.length;
    this.bones.push(b);
    return b;
  }

  _buildSkeleton() {
    this.bones = [];
    this.bone = Object.create(null);
    this.boneIndex = Object.create(null);

    const rig = new THREE.Bone();
    rig.name = 'bodyRoot';
    this.root.add(rig);
    this.bone.bodyRoot = rig;
    this.boneIndex.bodyRoot = 0;
    this.bones.push(rig);

    const hips = this._addBone('hips', rig, 0, 0.92, 0);
    const spine = this._addBone('spine', hips, 0, 0.20, 0);
    const chest = this._addBone('chest', spine, 0, 0.23, -0.005);
    const neck = this._addBone('neck', chest, 0, 0.19, 0);
    this._addBone('head', neck, 0, 0.11, -0.005);

    for (const side of [-1, 1]) {
      const tag = side < 0 ? 'L' : 'R';
      const upperArm = this._addBone(`upperArm${tag}`, chest, side * 0.19, 0.075, -0.018);
      const foreArm = this._addBone(`foreArm${tag}`, upperArm, 0, -0.27, 0);
      this._addBone(`hand${tag}`, foreArm, 0, -0.27, 0);

      /* The render hips sit slightly ahead of the spine. Anatomically exact
       * plumb legs hide one another in a camera whose eye is already in front
       * of the torso; this small offset preserves the shadow silhouette while
       * exposing the trouser length and boot when the player looks down. */
      const thigh = this._addBone(`thigh${tag}`, hips, side * 0.105, -0.01, -0.09);
      const shin = this._addBone(`shin${tag}`, thigh, 0, -UPPER_LEG, 0);
      this._addBone(`foot${tag}`, shin, 0, -LOWER_LEG, 0);

      /* The first-person lower legs have their own camera-facing pivots. The
       * complete anatomical chain above owns grounding and shadow; these two
       * bones only solve the projection problem of looking almost straight
       * down a shin, where a real cylinder collapses to an unhelpful circle. */
      const fpShin = this._addBone(`fpShin${tag}`, rig, side * 0.105, 0.47, FP_KNEE_Z);
      this._addBone(
        `fpFoot${tag}`,
        fpShin,
        0,
        -Math.cos(FP_LEG_TILT) * 0.44,
        -Math.sin(FP_LEG_TILT) * 0.44,
      );
    }

    this.root.updateMatrixWorld(true);
    this.skeleton = new THREE.Skeleton(this.bones);
  }

  _buildMaterials(renderer, tier) {
    /* The body is close enough for a 512 map to matter, but the pinned low
     * tier can halve it at boot. Re-baking during an adaptive tier transition
     * would create a visible hitch and leave old render targets waiting for
     * collection, so topology and texture memory are chosen once while shader
     * compilation is already expected. */
    const size = tier === 'low' ? 256 : 512;
    this.atlas = bakeSurface(renderer, BODY_SURFACE, {
      size,
      normalStrength: 2.2,
    });
    for (const t of [this.atlas.map, this.atlas.normalMap, this.atlas.ormMap]) {
      t.wrapS = THREE.ClampToEdgeWrapping;
      t.wrapT = THREE.ClampToEdgeWrapping;
    }

    const make = (name, normalScale, ao = 0.35) => {
      const m = new THREE.MeshStandardMaterial({
        map: this.atlas.map,
        normalMap: this.atlas.normalMap,
        roughnessMap: this.atlas.ormMap,
        aoMap: this.atlas.ormMap,
        aoMapIntensity: ao,
        roughness: 1,
        metalness: 0,
        normalScale: new THREE.Vector2(normalScale, normalScale),
      });
      m.name = `body-${name}`;
      m.dithering = true;
      m.userData.baseNormalScale = normalScale;
      this.materials.push(m);
      return m;
    };

    this.mat = {
      skin: make('skin', 0.42, 0.18),
      shirt: make('shirt', 0.80, 0.32),
      trousers: make('trousers', 0.82, 0.34),
      leather: make('leather', 0.92, 0.30),
      hair: make('hair', 0.72, 0.28),
      rubber: make('rubber', 0.58, 0.24),
    };
  }

  _bonePosition(name) {
    return new THREE.Vector3().setFromMatrixPosition(this.bone[name].matrixWorld);
  }

  _buildGeometry() {
    const d = this.detail;
    const V = {
      skin: new MeshBatch(BODY_ATLAS.skin),
      shirt: new MeshBatch(BODY_ATLAS.shirt),
      trousers: new MeshBatch(BODY_ATLAS.trousers),
      leather: new MeshBatch(BODY_ATLAS.leather),
      rubber: new MeshBatch(BODY_ATLAS.rubber),
    };
    const H = {
      skin: new MeshBatch(BODY_ATLAS.skin),
      shirt: new MeshBatch(BODY_ATLAS.shirt),
      trousers: new MeshBatch(BODY_ATLAS.trousers),
      leather: new MeshBatch(BODY_ATLAS.leather),
      hair: new MeshBatch(BODY_ATLAS.hair),
      rubber: new MeshBatch(BODY_ATLAS.rubber),
    };
    const bi = this.boneIndex;

    /* The field shirt is fitted only enough to keep a human silhouette. The
     * camera never renders this batch, but the sun does, and a torso-shaped
     * shadow is far more grounding than two disembodied arm shadows. */
    H.shirt.add(loftGeometry([
      { y: 1.50, rx: 0.180, rz: 0.095, z: 0.002 },
      { y: 1.43, rx: 0.205, rz: 0.110, z: -0.004 },
      { y: 1.33, rx: 0.180, rz: 0.112, z: -0.010 },
      { y: 1.22, rx: 0.154, rz: 0.096, z: -0.003 },
      { y: 1.12, rx: 0.137, rz: 0.086, z: 0.004 },
    ], d.radial + 2), new THREE.Matrix4(), bi.chest);

    /* A compact day pack is useful twice: it makes the trekking clothing read
     * as equipment rather than costume, and its shadow breaks the unnaturally
     * straight back edge a bare procedural torso would cast. */
    addEllipsoid(H.shirt, bi.chest, new THREE.Vector3(0, 1.31, 0.125),
      [0.145, 0.215, 0.085], d);
    addBox(H.shirt, bi.chest, new THREE.Vector3(0, 1.20, 0.178),
      [0.19, 0.035, 0.045]);

    /* The head remains complete even though the first-person camera sits
     * inside it. Keeping it on the world-only layer gives the shadow a head
     * while avoiding both a visible neck stump and near-plane slices through
     * cheeks when the player looks sharply down. */
    addEllipsoid(H.skin, bi.head, new THREE.Vector3(0, 1.665, -0.012),
      [0.088, 0.112, 0.092], d);
    addSegment(H.skin, bi.neck, new THREE.Vector3(0, 1.59, 0), 0.11,
      [0.050, 0.047, 0.044, 0.042], d);
    addEllipsoid(H.skin, bi.head, new THREE.Vector3(0, 1.655, -0.096),
      [0.022, 0.031, 0.038], d, 8);
    for (const side of [-1, 1]) {
      addEllipsoid(H.skin, bi.head, new THREE.Vector3(side * 0.088, 1.665, -0.005),
        [0.014, 0.026, 0.010], d, 7);
    }

    /* A close bun and short tied tail have a stable silhouette in shadow.
     * Loose cards would need transparency and would swing across the camera;
     * solid locks cost fewer failure modes than they cost triangles here. */
    addEllipsoid(H.hair, bi.head, new THREE.Vector3(0, 1.702, 0.018),
      [0.092, 0.095, 0.091], d);
    addEllipsoid(H.hair, bi.head, new THREE.Vector3(0, 1.690, 0.103),
      [0.060, 0.058, 0.050], d, 9);
    addSegment(H.hair, bi.head, new THREE.Vector3(0, 1.665, 0.118), 0.205,
      [0.038, 0.034, 0.020, 0.018], d,
      new THREE.Euler(-0.10, 0, 0.08));

    /* The pelvis is required for the shadow and for a future external camera,
     * but not for this camera. Seen from an eye inside the body, even a
     * correctly shaped waist projects as a large floating ring around the
     * bottom of the frame; putting it beside the hidden torso leaves the upper
     * thighs to make the visual connection without drawing that ring. */
    H.trousers.add(loftGeometry([
      { y: 1.13, rx: 0.139, rz: 0.086 },
      { y: 1.06, rx: 0.166, rz: 0.102 },
      { y: 0.96, rx: 0.178, rz: 0.108 },
      { y: 0.87, rx: 0.145, rz: 0.091 },
    ], d.radial + 2), new THREE.Matrix4(), bi.hips);
    H.leather.add(loftGeometry([
      { y: 1.115, rx: 0.148, rz: 0.094 },
      { y: 1.075, rx: 0.156, rz: 0.100 },
    ], d.radial + 2), new THREE.Matrix4(), bi.hips);
    addBox(H.leather, bi.hips, new THREE.Vector3(0, 1.095, -0.102),
      [0.050, 0.040, 0.014]);

    for (const side of [-1, 1]) {
      const tag = side < 0 ? 'L' : 'R';
      const shoulder = this._bonePosition(`upperArm${tag}`);
      const elbow = this._bonePosition(`foreArm${tag}`);
      const wrist = this._bonePosition(`hand${tag}`);
      const hip = this._bonePosition(`thigh${tag}`);
      const knee = this._bonePosition(`shin${tag}`);
      const ankle = this._bonePosition(`foot${tag}`);
      const fpKnee = this._bonePosition(`fpShin${tag}`);
      const fpAnkle = this._bonePosition(`fpFoot${tag}`);

      for (const batch of [V.shirt, H.shirt]) {
        addSegment(batch, bi[`upperArm${tag}`], shoulder, 0.255,
          [0.064, 0.058, 0.053, 0.048], d);
        addSegment(batch, bi[`upperArm${tag}`],
          shoulder.clone().add(new THREE.Vector3(0, -0.230, 0)), 0.050,
          [0.060, 0.054, 0.057, 0.051], d);
      }

      const addHand = (batch) => {
        addSegment(batch, bi[`foreArm${tag}`], elbow, 0.265,
          [0.050, 0.045, 0.035, 0.031], d);
        addEllipsoid(batch, bi[`hand${tag}`],
          wrist.clone().add(new THREE.Vector3(0, -0.066, -0.002)),
          [0.047, 0.077, 0.031], d, 9);

        /* Four separate fingers are only useful because the hands spend time
         * against bright leaf gaps where a mitten silhouette is obvious. Their
         * roots overlap inside the palm, so rigid weights cannot open seams. */
        const fingerX = [-0.028, -0.010, 0.010, 0.028];
        const fingerL = [0.066, 0.075, 0.072, 0.058];
        for (let f = 0; f < 4; f++) {
          const start = wrist.clone().add(new THREE.Vector3(fingerX[f], -0.116, -0.004));
          addShape(
            batch,
            segmentGeometry(fingerL[f], 0.011, 0.010, 0.008, 0.008, 6, 3),
            bi[`hand${tag}`],
            start,
            null,
            new THREE.Euler(0.04 + f * 0.012, 0, (f - 1.5) * 0.035),
          );
          addEllipsoid(batch, bi[`hand${tag}`],
            start.clone().add(new THREE.Vector3(0, -fingerL[f], -0.002)),
            [0.0085, 0.010, 0.008], d, 6);
        }
        const thumb = wrist.clone().add(new THREE.Vector3(side * 0.040, -0.068, -0.003));
        addShape(
          batch,
          segmentGeometry(0.060, 0.014, 0.012, 0.010, 0.009, 7, 3),
          bi[`hand${tag}`],
          thumb,
          null,
          new THREE.Euler(0.18, 0, -side * 0.70),
        );
      };
      addHand(V.skin);
      addHand(H.skin);

      /* The external thigh follows the grounded IK rig, while the first-person
       * thigh is a narrower camera-facing bridge from below the frame to the
       * viewmodel knee. Reusing the full upper leg here puts its broad hip cap
       * against the near plane; omitting it leaves two calf caps floating in
       * space. A short overlap at the knee hides the fact that only the lower
       * leg needs the camera-specific projection. */
      addSegment(H.trousers, bi[`thigh${tag}`], hip, 0.490,
        [0.092, 0.086, 0.070, 0.066], d);
      addSegment(
        V.trousers,
        bi.hips,
        new THREE.Vector3(side * 0.105, 0.91, 0),
        0.475,
        [0.050, 0.045, 0.060, 0.050],
        d,
        new THREE.Euler(0.255, 0, -side * 0.025),
      );

      /* Cargo pockets are intentionally shallow. A deep box on a moving thigh
       * catches the lower edge of the frame as a hard rectangular flash; a
       * centimetre of relief is enough to show function without becoming the
       * thing the camera follows. */
      addBox(H.trousers, bi[`thigh${tag}`],
        hip.clone().add(new THREE.Vector3(side * 0.083, -0.205, 0.006)),
        [0.028, 0.125, 0.105],
        new THREE.Euler(0, 0, side * 0.03));

      const addLowerLeg = (
        trousers, leather, rubber,
        K, A, shinBone, footBone, tilt, legLength,
      ) => {
        const trouserLength = legLength - 0.11;
        addSegment(trousers, bi[shinBone], K, trouserLength,
          [0.073, 0.068, 0.058, 0.053], d,
          new THREE.Euler(tilt, 0, 0));
        addBox(trousers, bi[shinBone],
          K.clone().add(new THREE.Vector3(0, -0.045, -0.067)
            .applyEuler(new THREE.Euler(tilt, 0, 0))),
          [0.102, 0.100, 0.018],
          new THREE.Euler(tilt, 0, 0));

        const shaftTop = K.clone().add(new THREE.Vector3(0, -(legLength - 0.155), 0)
          .applyEuler(new THREE.Euler(tilt, 0, 0)));
        addSegment(leather, bi[shinBone], shaftTop, 0.185,
          [0.064, 0.059, 0.069, 0.064], d,
          new THREE.Euler(tilt, 0, 0));
        addEllipsoid(leather, bi[footBone],
          A.clone().add(new THREE.Vector3(0, 0.012, -0.105)),
          [0.078, 0.058, 0.150], d, 10);
        addBox(rubber, bi[footBone],
          A.clone().add(new THREE.Vector3(0, -0.018, -0.105)),
          [0.164, 0.036, 0.302]);

        for (let lace = 0; lace < 4; lace++) {
          addBox(rubber, bi[footBone],
            A.clone().add(new THREE.Vector3(0, 0.062, -0.060 - lace * 0.030)),
            [0.105 - lace * 0.010, 0.009, 0.010],
            new THREE.Euler(0, 0, (lace % 2 ? 1 : -1) * 0.055));
        }
        for (let tread = 0; tread < 4; tread++) {
          addBox(rubber, bi[footBone],
            A.clone().add(new THREE.Vector3(0, -0.039, -0.205 + tread * 0.067)),
            [0.145, 0.018, 0.030]);
        }
      };
      addLowerLeg(
        V.trousers, V.leather, V.rubber,
        fpKnee, fpAnkle, `fpShin${tag}`, `fpFoot${tag}`, FP_LEG_TILT, 0.44,
      );
      addLowerLeg(
        H.trousers, H.leather, H.rubber,
        knee, ankle, `shin${tag}`, `foot${tag}`, 0, LOWER_LEG,
      );
    }

    const visible = [
      ['skin', V.skin, this.mat.skin],
      ['shirt', V.shirt, this.mat.shirt],
      ['trousers', V.trousers, this.mat.trousers],
      ['leather', V.leather, this.mat.leather],
      ['rubber', V.rubber, this.mat.rubber],
    ];
    const hidden = [
      ['skinWorld', H.skin, this.mat.skin],
      ['shirtWorld', H.shirt, this.mat.shirt],
      ['trousersWorld', H.trousers, this.mat.trousers],
      ['leatherWorld', H.leather, this.mat.leather],
      ['hairWorld', H.hair, this.mat.hair],
      ['rubberWorld', H.rubber, this.mat.rubber],
    ];

    for (const [name, batch, material] of visible) {
      this._makeMesh(name, batch, material, BODY_FIRST_PERSON_LAYER, false);
      this._visibleTriangles += batch.triangles;
    }
    for (const [name, batch, material] of hidden) {
      this._makeMesh(name, batch, material, BODY_WORLD_LAYER, true);
      this._hiddenTriangles += batch.triangles;
    }
  }

  _makeMesh(name, batch, material, layer, worldOnly) {
    const mesh = new THREE.SkinnedMesh(batch.geometry(), material);
    mesh.name = `body-${name}`;
    /* The first-person meshes are deliberately not shadow casters. Their
     * camera-friendly offsets would otherwise duplicate the complete world
     * body's limbs in the shadow map and produce a many-armed silhouette. */
    mesh.castShadow = worldOnly;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.layers.set(layer);
    mesh.userData.worldOnly = worldOnly;
    if (worldOnly) {
      /* Three filters shadow casters against the viewing camera's layers, not
       * the light's shadow camera layers. The mesh is moved back to its hidden
       * layer immediately after its depth draw, before the colour render list
       * is built; otherwise a correctly casting body would also appear around
       * the first-person camera as a clipped torso. */
      mesh.onAfterShadow = () => mesh.layers.set(BODY_WORLD_LAYER);
    }
    this.root.add(mesh);
    this.root.updateMatrixWorld(true);
    mesh.bind(this.skeleton);
    mesh.normalizeSkinWeights();
    this.meshes.push(mesh);
  }

  _placeRoot() {
    const w = this.walker;
    /* Eyes sit in front of the spine, not directly above it. Five centimetres
     * is enough to keep the shoulders behind the near plane without moving the
     * feet far enough to disagree with the camera's terrain contact. */
    const back = 0.055;
    this.root.position.set(
      w.pos.x + Math.sin(w.yaw) * back,
      w.pos.y - this.eyeHeight - w.jumpCrouch * 0.105,
      w.pos.z + Math.cos(w.yaw) * back,
    );
    this.root.rotation.set(0, w.yaw, 0);
    this.root.updateMatrixWorld(true);
  }

  _sampleMoveDirection(dt) {
    const w = this.walker;
    const dx = w.pos.x - this._prev.x;
    const dz = w.pos.z - this._prev.z;
    this._prev.set(w.pos.x, 0, w.pos.z);
    const travel = Math.hypot(dx, dz);

    /* Teleports are common in the screenshot harness. Treating one as a frame
     * of movement points both knees at the horizon and can leave that pose in
     * a capture, so only distances a walker could physically cover update the
     * direction filter. */
    if (dt > 0 && travel > 1e-5 && travel < Math.max(0.5, dt * 8)) {
      const c = Math.cos(w.yaw), s = Math.sin(w.yaw);
      const lx = c * dx - s * dz;
      const lz = s * dx + c * dz;
      const inv = 1 / Math.hypot(lx, lz);
      const k = Math.min(1, dt * 12);
      this._moveDir.x = lerp(this._moveDir.x, lx * inv, k);
      this._moveDir.y = lerp(this._moveDir.y, lz * inv, k);
      this._moveDir.normalize();
    } else if (travel >= Math.max(0.5, dt * 8)) {
      /* A harness warp is not a very fast stride. Any world-space foot anchor
       * left at the old trail point would pull a leg across the whole scene on
       * the next solve, so teleports explicitly release both contacts. */
      this._feet.L.planted = false;
      this._feet.R.planted = false;
    }
    return this._moveDir;
  }

  _poseArms(move, run) {
    const w = this.walker;
    /* The shoulder follows the opposite hip but arrives about six percent of
     * a cycle later. Exact antiphase makes the torso look like a metronome;
     * this small lag is the elastic delay through the spine and shoulder. */
    const phase = (w.bobPhase - 0.06) * TAU;
    /* Looking down is the one time the foliage-clearing pose becomes actively
     * obstructive. Letting the arms return toward a relaxed hang follows what
     * a person does when checking footing and keeps two close sleeves from
     * hiding the legs the player deliberately turned down to see. */
    const lookDown = smooth((-w.pitch - 0.42) / 0.58);
    const baseReach = lerp(0.08, lerp(0.32, 0.46, run), move);
    const swing = Math.sin(phase) * lerp(0.23, 0.38, run) * move;
    const cross = Math.cos(phase) * lerp(0.020, 0.045, run) * move;
    const air = w.jumpAir;
    const takeoff = w.jumpTakeoff;
    const land = w.jumpLand;

    for (const side of [-1, 1]) {
      const tag = side < 0 ? 'L' : 'R';
      const upper = this.bone[`upperArm${tag}`];
      const fore = this.bone[`foreArm${tag}`];
      const hand = this.bone[`hand${tag}`];

      /* Opposite arm and leg phases come from the one bob clock. A separate
       * elapsed-time sine would look acceptable at one speed and then drift
       * visibly against the camera whenever acceleration changed. */
      const asymmetry = side < 0 ? 0.96 : 1.04;
      let reach = baseReach - side * swing * asymmetry;
      let elbow = lerp(0.08, lerp(0.18, 0.42, run), move)
        + Math.max(0, -side * swing) * 0.34;
      let spread = side * (0.105 + cross);

      /* Arms load behind the torso, open for balance in the air, then come
       * forward for landing. These targets are blended weights, so an aborted
       * walk never snaps into a separate jump animation. */
      reach = lerp(reach, -0.08 - side * 0.04, takeoff);
      elbow = lerp(elbow, 0.34, takeoff);
      reach = lerp(reach, 0.36 + side * 0.025, air);
      elbow = lerp(elbow, 0.72 + (side < 0 ? 0.05 : -0.02), air);
      spread = lerp(spread, side * 0.32, air);
      reach = lerp(reach, 0.40, land);
      elbow = lerp(elbow, 0.58, land);

      reach = lerp(reach, 0.06, lookDown * (1 - air * 0.8));
      elbow = lerp(elbow, 0.05, lookDown * (1 - air * 0.8));
      reach = clamp(reach, -0.16, 0.92);
      elbow = clamp(elbow, 0.04, 1.05);

      upper.rotation.order = 'YXZ';
      upper.rotation.set(
        reach,
        cross * side,
        spread + side * lerp(0, 0.04, lookDown),
      );
      fore.rotation.order = 'YXZ';
      fore.rotation.set(elbow, 0, -side * 0.035);
      /* A slight inward roll presents the thumb edge instead of a flat palm.
       * The latter reads as a pair of paddles held toward the camera even when
       * the arm path itself is relaxed. */
      hand.rotation.set(
        lerp(-0.08, -0.22, air),
        side * lerp(0.34, 0.68, air),
        -side * 0.055,
      );
    }
  }

  _footTarget(side, phase, stepLength, move, dir, run) {
    /* Jogging spends less of a gait cycle on one foot. That keeps the distance
     * travelled during support inside the same anatomical reach even though
     * the steps themselves lengthen. The left support is persistently a shade
     * longer, enough to break mirror symmetry without looking like a limp. */
    const stance = lerp(0.60, 0.48, run) + (side < 0 ? 0.008 : -0.008);
    const sideStep = stepLength * (side < 0 ? 0.985 : 1.015);
    const travel = sideStep * 2 * stance * move;
    let along = 0, lift = 0, toe = 0;
    if (phase < stance) {
      const u = phase / stance;
      along = travel * (0.5 - u);
      toe = -0.05 * smooth((u - 0.72) / 0.28) * move;
    } else {
      const u = smooth((phase - stance) / (1 - stance));
      along = lerp(-travel * 0.5, travel * 0.5, u);
      const sideLift = side < 0 ? 0.96 : 1.04;
      lift = Math.sin(u * Math.PI) * lerp(0.035, lerp(0.090, 0.135, run), move) * sideLift;
      toe = Math.sin(u * Math.PI) * lerp(0.13, 0.20, run) * move;
    }

    const lateralX = side * (side < 0 ? 0.103 : 0.108);
    /* A relaxed human stance is not a plumb line from hip to ankle. Keeping
     * the boots a little ahead bends the knees and lets a downward-looking
     * camera see shin and toe instead of only the circular top of each thigh. */
    const stanceForward = lerp(-0.10, -0.04, move) + (side < 0 ? -0.006 : 0.004);
    return {
      point: new THREE.Vector3(
        lateralX + dir.x * along,
        0.055 + lift,
        stanceForward + dir.y * along,
      ),
      toe,
      inStance: phase < stance,
    };
  }

  _plantTarget(tag, localPoint) {
    const state = this._feet[tag];
    state.anchor.copy(localPoint);
    this.root.localToWorld(state.anchor);
    state.anchor.y = this.walker.terrain.height(state.anchor.x, state.anchor.z) + 0.055;
    state.planted = true;
  }

  _lockedTarget(tag, target) {
    const state = this._feet[tag];
    if (!target.inStance) {
      state.planted = false;
      return target.point;
    }
    if (!state.planted) this._plantTarget(tag, target.point);
    state.local.copy(state.anchor);
    return this.root.worldToLocal(state.local);
  }

  _solveLeg(tag, target, toePitch) {
    const upper = this.bone[`thigh${tag}`];
    const lower = this.bone[`shin${tag}`];
    const foot = this.bone[`foot${tag}`];
    const t = this._tmp;
    const L1 = UPPER_LEG, L2 = LOWER_LEG;

    /* Work in the hips' local frame. That keeps the solve independent of the
     * character's world yaw and means a later third-person turn animation can
     * rotate the whole pelvis without teaching the IK about world matrices. */
    const hips = this.bone.hips;
    const H = t.a.copy(upper.position);
    const F = t.b.copy(target).sub(hips.position);
    t.q3.copy(hips.quaternion).invert();
    F.applyQuaternion(t.q3);
    const D = t.d.copy(F).sub(H);
    let dist = D.length();
    if (dist < 1e-5) return;
    D.multiplyScalar(1 / dist);
    dist = clamp(dist, Math.abs(L1 - L2) + 1e-4, L1 + L2 - 0.020);
    F.copy(H).addScaledVector(D, dist);

    const along = (L1 * L1 - L2 * L2 + dist * dist) / (2 * dist);
    const bend = Math.sqrt(Math.max(0, L1 * L1 - along * along));
    /* Knees bend toward the character's forward side even during a backward
     * step. Using travel direction as the pole makes a reverse walk briefly
     * become a bird leg, which is much more visible in shadow than in mesh. */
    t.pole.set(0, 0, -1);
    t.perp.copy(t.pole).addScaledVector(D, -t.pole.dot(D));
    if (t.perp.lengthSq() < 1e-5) t.perp.set(0, 1, 0);
    t.perp.normalize();
    t.knee.copy(H).addScaledVector(D, along).addScaledVector(t.perp, bend);

    const thighDir = t.knee.clone().sub(H).normalize();
    upper.quaternion.setFromUnitVectors(DOWN, thighDir);

    const shinDir = F.clone().sub(t.knee).normalize();
    t.q0.copy(upper.quaternion).invert();
    shinDir.applyQuaternion(t.q0);
    lower.quaternion.setFromUnitVectors(DOWN, shinDir);

    /* Cancel the accumulated leg rotation at the ankle before adding toe roll.
     * Without this, a planted boot inherits the shin angle and points into the
     * soil at heel strike, the clearest possible sign that the feet are not
     * actually carrying weight. */
    t.q1.copy(hips.quaternion).multiply(upper.quaternion).multiply(lower.quaternion).invert();
    t.q2.setFromAxisAngle(X_AXIS, toePitch);
    foot.quaternion.copy(t.q1).multiply(t.q2);
  }

  _poseLegs(move, dir, run, dt = 1 / 60) {
    const w = this.walker;
    const stepLength = w.stepLength;
    const changed = this._lastJumpState !== w.jumpState;
    if (changed && (w.jumpState === 'airborne' || w.jumpState === 'land')) {
      this._feet.L.planted = false;
      this._feet.R.planted = false;
    }
    this._lastJumpState = w.jumpState;

    const solved = [];
    for (const side of [-1, 1]) {
      const tag = side < 0 ? 'L' : 'R';
      let target;
      let toe = 0;

      if (w.jumpState === 'airborne') {
        const state = this._feet[tag];
        state.planted = false;
        /* One knee leads by a few centimetres in the air. Equal tucked legs
         * make the body read as a posed mannequin rather than balancing mass. */
        const fall = smooth((-w.verticalVelocity - 0.25) / 2.4);
        const airTarget = new THREE.Vector3(
          side * 0.11,
          lerp(side < 0 ? 0.25 : 0.20, 0.075, fall),
          lerp(side < 0 ? -0.08 : -0.18, side < 0 ? -0.055 : -0.025, fall),
        );
        state.local.copy(state.anchor);
        this.root.worldToLocal(state.local);
        target = state.local.lerp(airTarget, w.jumpAir);
        toe = side < 0 ? 0.18 : 0.10;
      } else if (w.jumpState === 'takeoff' || w.jumpState === 'land') {
        const brace = {
          point: new THREE.Vector3(side * 0.115, 0.055, side < 0 ? -0.055 : -0.025),
          toe: 0,
          inStance: true,
        };
        target = this._lockedTarget(tag, brace);
      } else {
        const phase = fract(w.bobPhase + (side > 0 ? 0.5 : 0));
        const gait = this._footTarget(side, phase, stepLength, move, dir, run);
        target = this._lockedTarget(tag, gait);
        toe = gait.toe;
      }
      solved.push({ tag, target, toe, planted: this._feet[tag].planted });
    }

    /* A planted foot on the downhill side of a rut can sit below the terrain
     * under the pelvis. Lowering the body just enough to keep that ankle inside
     * leg reach is the procedural equivalent of yielding through the stance
     * hip; clamping the IK instead would make the boot slide toward the body. */
    let neededDrop = 0;
    const maxReach = UPPER_LEG + LOWER_LEG - 0.020;
    for (const step of solved) {
      if (!step.planted) continue;
      const upper = this.bone[`thigh${step.tag}`];
      const joint = this._tmp.a.copy(upper.position)
        .applyQuaternion(this.bone.hips.quaternion)
        .add(this.bone.hips.position);
      const dx = step.target.x - joint.x;
      const dz = step.target.z - joint.z;
      const allowedY = Math.sqrt(Math.max(0.01, maxReach * maxReach - dx * dx - dz * dz));
      neededDrop = Math.max(neededDrop, joint.y - step.target.y - allowedY);
    }
    neededDrop = clamp(neededDrop, 0, 0.12);
    /* Weight accepts the new support height on contact, then rises out of it
     * slowly. Besides matching the requested fast-drop/slow-rise character,
     * this prevents one frame of reach-clamped ankle motion at heel strike. */
    this._reachDrop = neededDrop > this._reachDrop
      ? neededDrop
      : lerp(this._reachDrop, neededDrop, Math.min(1, dt * 5));
    if (this._reachDrop > 1e-4) {
      this.root.position.y -= this._reachDrop;
      this.root.updateMatrixWorld(true);
      for (const step of solved) {
        if (!step.planted) continue;
        const state = this._feet[step.tag];
        state.local.copy(state.anchor);
        step.target = this.root.worldToLocal(state.local);
      }
    }

    for (const step of solved) {
      this._solveLeg(step.tag, step.target, step.toe);
    }
  }

  _poseFirstPersonLegs(move, dir, run) {
    const w = this.walker;
    for (const side of [-1, 1]) {
      const tag = side < 0 ? 'L' : 'R';
      const phase = fract(w.bobPhase + (side > 0 ? 0.5 : 0));
      const target = this._footTarget(side, phase, w.stepLength, move, dir, run);
      const shin = this.bone[`fpShin${tag}`];
      const foot = this.bone[`fpFoot${tag}`];
      const centre = lerp(-0.10, -0.04, move);

      /* The stance displacement is a reduced copy of the grounded target, not
       * another oscillator. The boots therefore reverse direction on the same
       * frame as their shadow and never phase-walk away from the camera bob. */
      shin.position.set(
        side * 0.105 + (target.point.x - side * 0.105) * 0.35,
        0.47 + (target.point.y - 0.055) * 0.32,
        FP_KNEE_Z + (target.point.z - centre) * 0.52,
      );
      shin.rotation.set(
        Math.sin(phase * TAU) * 0.075 * move,
        0,
        side * Math.sin(phase * TAU) * 0.018 * move,
      );
      if (w.jumpAir > 0) {
        const airY = side < 0 ? 0.62 : 0.57;
        const airZ = side < 0 ? -0.02 : -0.09;
        shin.position.y = lerp(shin.position.y, airY, w.jumpAir);
        shin.position.z = lerp(shin.position.z, airZ, w.jumpAir);
        shin.rotation.x = lerp(shin.rotation.x, side < 0 ? -0.24 : -0.16, w.jumpAir);
      }
      foot.quaternion.copy(shin.quaternion).invert();
    }
  }

  update(dt) {
    const w = this.walker;
    const dir = this._sampleMoveDirection(dt);
    const move = smooth((w.speed - 0.04) / 0.86);
    const run = clamp(w.runBlend, 0, 1);

    this._placeRoot();
    const phase = w.bobPhase * TAU;
    const support = w.grounded ? 1 - w.jumpCrouch * 0.7 : 0;
    const pelvisYaw = Math.sin(phase) * lerp(0.026, 0.046, run) * move * support;
    const pelvisRoll = Math.cos(phase) * lerp(0.010, 0.018, run) * move * support;
    const lean = run * 0.055 + w.jumpTakeoff * 0.035;

    /* The pelvis initiates each step and the upper torso counters it through
     * two joints. Rotating the chest alone would leave the backpack swaying on
     * a rigid pole; distributing the cancellation gives the shadow a spine. */
    this.bone.hips.position.set(0, 0.92 + w.gaitBounce * 0.30, 0);
    this.bone.hips.rotation.order = 'YXZ';
    this.bone.hips.rotation.set(0, pelvisYaw, pelvisRoll);
    this.bone.spine.rotation.order = 'YXZ';
    this.bone.spine.rotation.set(lean, -pelvisYaw * 0.72, -pelvisRoll * 0.52);
    this.bone.chest.rotation.order = 'YXZ';
    this.bone.chest.rotation.set(
      -lean * 0.28,
      -pelvisYaw * 0.48 + Math.sin(phase - 0.20) * 0.006 * move,
      -pelvisRoll * 0.35,
    );
    this.bone.neck.rotation.set(0, pelvisYaw * 0.16, pelvisRoll * 0.20);

    this._poseArms(move, run);
    this._poseLegs(move, dir, run, dt);
    this._poseFirstPersonLegs(move, dir, run);

    /* This is breathing, not a second gait clock. It uses the controller's
     * existing continuous time so pausing, scripted warps and capture frames
     * all leave camera and body in the same temporal state. */
    const breath = Math.sin((w._time || 0) * 1.35) * (1 - move * 0.65);
    this.bone.chest.scale.set(1 + breath * 0.006, 1 + breath * 0.004, 1 + breath * 0.010);
  }

  setQuality(tier) {
    this.quality = tier;
    const factor = tier === 'low' ? 0.62 : tier === 'medium' ? 0.80 : tier === 'ultra' ? 1.06 : 1;
    for (const m of this.materials) {
      const n = m.userData.baseNormalScale * factor;
      m.normalScale.set(n, n);
    }
  }

  prepareShadowPass() {
    /* renderer.render() builds the directional shadow map before it builds the
     * colour pass. Temporarily sharing the default world layer makes the full
     * body eligible for that depth traversal; onAfterShadow restores every
     * mesh to BODY_WORLD_LAYER before the first-person render can see it. */
    for (const mesh of this.meshes) {
      if (mesh.userData.worldOnly) mesh.layers.set(0);
    }
  }

  /**
   * A future third-person camera only needs to opt into this layer. The
   * first-person camera deliberately never does; shadow traversal is prepared
   * separately because Three filters casters with the viewing camera.
   */
  showWorldBodyTo(camera, show = true) {
    if (show) {
      camera.layers.enable(BODY_WORLD_LAYER);
      camera.layers.disable(BODY_FIRST_PERSON_LAYER);
    } else {
      camera.layers.disable(BODY_WORLD_LAYER);
      camera.layers.enable(BODY_FIRST_PERSON_LAYER);
    }
  }

  stats() {
    return {
      meshes: this.meshes.length,
      firstPersonDraws: this.meshes.filter(m => !m.userData.worldOnly).length,
      shadowDraws: this.meshes.filter(m => m.userData.worldOnly).length,
      triangles: Math.round(this._visibleTriangles + this._hiddenTriangles),
      firstPersonTriangles: Math.round(this._visibleTriangles),
      shadowTriangles: Math.round(this._hiddenTriangles),
      textures: 3,
      bones: this.bones.length,
      quality: this.quality,
    };
  }

  dispose() {
    for (const mesh of this.meshes) mesh.geometry.dispose();
    for (const material of this.materials) material.dispose();
    this.atlas.dispose();
    this.skeleton.dispose();
    this.root.removeFromParent();
  }
}
