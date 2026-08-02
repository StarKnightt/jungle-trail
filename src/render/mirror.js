/* A planar reflection of the world in the plunge pool.
 *
 * This exists because of a measurement rather than a preference. The pool is a
 * thirty-metre sheet of water seen from eye height, which means almost all of
 * its visible area is at two to ten degrees of incidence, where a dielectric
 * reflects between a third and two thirds of everything it sees and transmits
 * almost none of it. Whatever is in the reflection *is* the water at those
 * angles: the body colour, the ripple normal and the foam are all arguing over
 * the remaining few per cent.
 *
 * Three's image-based specular cannot supply it. What it has is an environment
 * probe of the sky — one uniform dome with no cliff in it, no ruins in it and
 * no canopy in it — so at grazing incidence over a large surface it integrates
 * to a constant, and a constant is a flat pale sheet. Every previous attempt in
 * water.js worked around that by *grading* the constant: a dark colour for the
 * near-horizontal bounce, a light one for the steep bounce, a threshold on how
 * far the ripple had lifted the reflected ray. All of them are defensible and
 * none of them can produce an image, because there is no image anywhere in the
 * inputs. The critique's phrasing was that the pool "returns nothing at the one
 * angle where Fresnel must appear", and that is exactly right: it returned a
 * value, not a picture.
 *
 * So the picture is rendered. One extra pass of the scene from the camera
 * mirrored in the water plane, at half resolution, reusing the shadow map the
 * main pass is about to use, skipped entirely whenever the pool is not on
 * screen — which is most of the walk. The cost is measured in tools/perf.mjs
 * and reported in the README; it is a few per cent at the falls and nothing
 * anywhere else.
 *
 * Two implementation notes, both of which are the reason this is short:
 *
 *  - The near plane is skewed to the water plane rather than the scene being
 *    clipped against it (Lengyel's oblique frustum). It costs four assignments
 *    instead of a clipping plane in every shader in the world, and because the
 *    modification only touches the third row of the projection matrix the
 *    horizontal and vertical mapping is untouched — which is what makes the
 *    second note true.
 *
 *  - The reflection is therefore sampled at the fragment's *own* screen
 *    position. A point on the mirror plane projects to the same pixel through
 *    both cameras, by construction, so no texture matrix and no extra varying
 *    beyond the projected position is needed. See the patch in world/water.js.
 */
import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);

export class PlanarMirror {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {number} planeY world height of the reflecting surface
   */
  constructor(renderer, planeY, opts = {}) {
    this.renderer = renderer;
    this.y = planeY;
    /* Half resolution in each axis, so a quarter of the pixels. The reflection
     * is being sampled through a rippling surface that displaces it by several
     * texels anyway, and it is multiplied by a Fresnel term that is only large
     * where the surface is foreshortened — so the one place it is strong is
     * also the place where a screen pixel covers metres of the reflected world
     * and no resolution would have helped. */
    this.scale = opts.scale ?? 0.5;
    this.enabled = opts.enabled !== false;
    /* Culling radius around the reflecting patch. The pool is 25 m across and
     * the reflection is invisible past the point where the haze has taken it,
     * so there is no reason to pay for the pass while walking the first two
     * hundred metres of the trail. */
    this.centre = opts.centre || new THREE.Vector3(0, planeY, 0);
    this.radius = opts.radius ?? 16;
    this.range = opts.range ?? 110;
    /* Rendered every `every` frames rather than every frame, holding the
     * previous texture in between.
     *
     * The pass is a second submission of the whole clearing — two hundred and
     * forty draw calls and two and a half million triangles — and it is bound
     * by that submission, not by the pixels it covers, so the half-resolution
     * target above does not touch its cost. It measured at three and a half
     * milliseconds of a nine millisecond falls-facing frame: more than a third
     * of the budget, for the one object in the scene that is allowed to be a
     * frame stale. The reflection is sampled through a surface whose ripple
     * displaces it by several texels each frame and it is multiplied by a
     * Fresnel term; at over a hundred frames a second, alternating means the
     * image is at worst nine milliseconds behind a camera that walks at one and
     * a half metres a second, which is two millimetres of parallax.
     *
     * Not applied to the first frame the pool is visible, which is the one
     * frame where there is no previous texture to hold and a capture tool
     * asking for a single frame would get nothing. */
    this.every = opts.every ?? 2;
    this._frame = 0;

    /* Layer 0 only, which is what keeps the player's body out of the
     * reflection: the first-person representation is a pair of arms posed for
     * a camera at the eye, and seen from the mirrored camera it is a floating
     * fragment of a person. The external body is on its own layer too, so
     * neither is eligible here without a line asking for it. */
    this.cam = new THREE.PerspectiveCamera();
    this.target = null;
    this.active = false;

    this._pos = new THREE.Vector3();
    this._look = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._rot = new THREE.Matrix4();
    this._clip = new THREE.Vector4();
    this._plane = new THREE.Plane();
    this._sphere = new THREE.Sphere();
    this._frustum = new THREE.Frustum();
    this._pv = new THREE.Matrix4();
    this._hidden = [];
  }

  setSize(w, h) {
    const tw = Math.max(4, Math.round(w * this.scale));
    const th = Math.max(4, Math.round(h * this.scale));
    if (this.target && this.target.width === tw && this.target.height === th) return;
    this.target?.dispose();
    /* Half-float, because the pass it feeds is half-float. The scene is
     * rendered without tone mapping — a sun shaft on the far bank is radiance
     * well above one — and an eight-bit target would clip exactly the bright
     * content that makes a reflection read as a reflection. */
    this.target = new THREE.WebGLRenderTarget(tw, th, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
    });
  }

  get texture() { return this.target ? this.target.texture : null; }

  /** True if the reflecting patch can be seen from `camera` at all. */
  _visible(camera) {
    if (camera.position.y <= this.y + 0.06) return false;
    if (camera.position.distanceTo(this.centre) > this.range) return false;
    this._sphere.set(this.centre, this.radius);
    // Inverted here rather than read off the camera, because this is also
    // called from the capture harness, which moves the camera by hand.
    this._pv.copy(camera.matrixWorld).invert().premultiply(camera.projectionMatrix);
    this._frustum.setFromProjectionMatrix(this._pv);
    return this._frustum.intersectsSphere(this._sphere);
  }

  /**
   * Render the reflection. Leaves the renderer's target where it found it —
   * which is the canvas, because this runs before the scene pass claims the
   * offscreen buffer.
   *
   * @param {THREE.Object3D[]} hide objects that must not appear in their own
   *   reflection: the water surfaces themselves, which would both feed the
   *   texture back into itself and stand between the mirrored camera and
   *   everything above the plane.
   */
  render(scene, camera, hide = []) {
    if (!this.enabled || !this.target) { this.active = false; return false; }
    if (!this._visible(camera)) { this.active = false; this._frame = 0; return false; }
    /* Held rather than skipped. `active` stays true so the material keeps
     * sampling the texture that is already there — turning the reflection off
     * on alternate frames would be a fifty-hertz flicker, which is the one
     * outcome worse than paying for it. */
    if (this._frame++ % this.every !== 0) return this.active;
    this.active = false;

    const r = this.renderer;

    /* The mirrored camera, built the way three's own Reflector builds it: the
     * eye and the point it looks at are both reflected in the plane, and so is
     * the up vector. Reflecting `up` as well is not cosmetic — lookAt() always
     * produces a right-handed basis, so with the true mirrored up the
     * handedness comes back and the triangle winding in the reflection matches
     * the winding in the scene. Without it every front face in the reflection
     * is a back face and half the world disappears. */
    this._rot.extractRotation(camera.matrixWorld);
    this._pos.copy(camera.position);
    this._look.set(0, 0, -1).applyMatrix4(this._rot).add(this._pos);
    this._up.set(0, 1, 0).applyMatrix4(this._rot);

    this._pos.y = 2 * this.y - this._pos.y;
    this._look.y = 2 * this.y - this._look.y;
    this._up.y = -this._up.y;

    this.cam.near = camera.near;
    this.cam.far = camera.far;
    this.cam.aspect = camera.aspect;
    this.cam.fov = camera.fov;
    this.cam.position.copy(this._pos);
    this.cam.up.copy(this._up);
    this.cam.lookAt(this._look);
    this.cam.updateMatrixWorld(true);
    this.cam.projectionMatrix.copy(camera.projectionMatrix);
    this._oblique();
    this.cam.projectionMatrixInverse.copy(this.cam.projectionMatrix).invert();

    this._hidden.length = 0;
    for (const o of hide) {
      if (o && o.visible) { this._hidden.push(o); o.visible = false; }
    }

    const prevTarget = r.getRenderTarget();
    /* The shadow map the main pass is about to render is the shadow map this
     * pass wants, and it is already correct: the cascade is positioned around
     * the *player*, not around the camera being rendered from, so the mirrored
     * camera is inside it. Re-rendering it would double the depth pass for a
     * reflection at half resolution, which is the single most expensive thing
     * this file could get wrong. Only skipped once there is a map to reuse. */
    const autoShadow = r.shadowMap.autoUpdate;
    if (autoShadow && this._hasShadowMap(scene)) r.shadowMap.autoUpdate = false;

    r.setRenderTarget(this.target);
    r.render(scene, this.cam);

    r.shadowMap.autoUpdate = autoShadow;
    r.setRenderTarget(prevTarget);
    for (const o of this._hidden) o.visible = true;
    this._hidden.length = 0;
    this.active = true;
    return true;
  }

  _hasShadowMap(scene) {
    if (this._shadowOK) return true;
    let ok = false;
    scene.traverse((o) => { if (o.isLight && o.shadow && o.shadow.map) ok = true; });
    this._shadowOK = ok;
    return ok;
  }

  /* Oblique near-plane clipping. The near plane is rotated onto the water
   * plane so that nothing under the water can be drawn — the basin floor is
   * three metres below it and would otherwise fill the reflection with the
   * bed it is supposed to be hiding.
   *
   * Only the third row of the projection is touched, which is worth stating
   * because the whole sampling scheme downstream depends on it: x and y map
   * exactly as the unmodified projection did, so a point on the plane still
   * lands on the same pixel through both cameras.
   */
  _oblique() {
    const p = this.cam.projectionMatrix;
    /* The plane, in view space, facing away from the mirrored camera — which
     * is below the water looking up, so the half-space to keep is the one
     * above the surface. A couple of centimetres of bias stops the surface's
     * own contact line flickering between the two sides of the test. */
    this._plane.setFromNormalAndCoplanarPoint(
      UP, this._tmp.set(0, this.y - 0.02, 0));
    this._plane.applyMatrix4(this.cam.matrixWorldInverse);
    const n = this._plane.normal, d = this._plane.constant;
    const q = this._clip.set(
      (Math.sign(n.x) + p.elements[8]) / p.elements[0],
      (Math.sign(n.y) + p.elements[9]) / p.elements[5],
      -1.0,
      (1.0 + p.elements[10]) / p.elements[14]);
    const c = this._plane.normal;
    const s = 2.0 / (c.x * q.x + c.y * q.y + c.z * q.z + d * q.w);
    p.elements[2] = c.x * s;
    p.elements[6] = c.y * s;
    p.elements[10] = c.z * s + 1.0;
    p.elements[14] = d * s;
  }

  dispose() { this.target?.dispose(); }
}
