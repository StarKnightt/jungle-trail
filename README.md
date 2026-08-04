# Jungle Trail

A first-person walk down a winding jungle trail into overgrown stone ruins with a
waterfall, built in Three.js with zero external art assets. Every texture, mesh
and sound in the scene is generated procedurally in code. There are no image
files, no models, no audio recordings and no material libraries: the leaf atlas,
the bark, the ground, the stone, the character's skin and all sixty audio buffers
are computed at load time.

Live: **https://starknightt.github.io/jungle-trail/**

![Trailhead under closed canopy](media/01-trailhead.jpg)

## Running it locally

There is no build step. The page is plain ES modules with an importmap, so it
only needs a static file server.

```
git clone https://github.com/StarKnightt/jungle-trail.git
cd jungle-trail
npm run serve
```

Then open `http://localhost:8099/`. Any other static server works equally well;
opening `index.html` from the filesystem does not, because ES modules and workers
need a real origin.

`npm install` is only needed for the capture tools in `tools/`, which use
Playwright. The game itself does not need it.

## Controls

| Input | Action |
|---|---|
| Click | Lock the pointer |
| Mouse | Look |
| W A S D | Move |
| Shift | Sprint |
| Space | Jump |
| 1 - 5 | Teleport along the trail |
| F3 | Show or hide the debug overlay |

The teleport keys are 1 trailhead, 2 mid trail, 3 ruins approach, 4 temple
clearing, 5 the falls. The debug overlay is hidden on load and stays out of the
document until F3 puts it there; once it is up, its header collapses it to a
summary bar and F3 takes it away again.

![Mid trail](media/02-mid-trail.jpg)

## What is in it

- ~12,000 lines of hand-written code across 51 files.
- A 423.8 m trail across a 180 x 492 m world, from a 361 x 985 heightfield
  sampled every 0.5 m.
- 100,799 individual plants across 16 species, all built from two primitives: a
  bent leaf card and a swept tube.
- 536 individually eroded stone blocks. The ruin plan is computed before the
  terrain, so the ground builds a terrace and spoil banks beneath the temple
  rather than the temple being dropped onto whatever the ground happened to do.
- A procedural character: 22 bones, 7,488 triangles, and a 512-square procedural
  body atlas.
- 15 GPU texture bakes producing 29 images. The leaf atlas is 2048-square; the
  bark and ground sets are 1024-square.
- 17 distinct synthesized voices and 60 audio buffers, baked in a worker on the
  first user gesture.

![Ruins approach](media/03-ruins.jpg)

## Performance

8.9 - 9.3 ms per frame on an RTX 4060 at 1600x900 — 108 fps in the corridor at
495 scene draw calls, 113 fps facing the falls at 234. The game caps itself at
60 fps; there is no reason for a walking-pace scene to render at 300.

Those numbers are higher than the ones this file used to quote, and the frame
did not get slower. `glFinish` in a page does not wait for the GPU: Chromium
runs WebGL over a command buffer into a separate process, and finish returns
once the queue has been handed over. The tools now synchronise on a one-pixel
`readPixels`, which cannot return before the frame exists. Under the old timer
the post-processing chain appeared to cost forty microseconds and `ultra`
rendered faster than `medium`.

Of that frame, the whole post stack — volumetrics, occlusion, grade, bloom,
defocus and shutter — is 1.9 to 2.0 ms at `high`. The grading chain is 0.22 ms of
it standing still and 0.28 ms while the camera moves: defocus 0.13, bloom 0.12,
shutter 0.11 when there is motion to integrate, and the grade, the vignette, the
aberration and the grain between 0.01 and 0.06 each, because they are arithmetic
inside a pass that has to run anyway. Those are means of three runs; the spread
between runs on a single figure is about 0.03, which is why the isolated pass
timings are quoted rather than a frame-level difference — a quarter of a
millisecond does not show up reliably against a 9 ms frame that varies by one.

Every tier runs every effect. Defocus and the shutter were `high` and `ultra`
only in the first version, which meant half the quality ladder was shipping a
look nobody had reviewed; measured, six defocus taps cost 0.05 ms, and the tiers
now scale the sampling of each effect rather than its presence.

The pool's planar reflection is the one pass that is not free: it is a second
submission of the whole clearing and it costs about 1.4 ms of a falls-facing
frame. It is skipped entirely whenever the pool is off screen, which is most of
the walk, it runs at 36 per cent resolution, it reuses the shadow map the main
pass is about to use, and it refreshes on alternate frames. Off below the `high`
tier, where the water falls back to a graded analytic reflection.

## Techniques

**GPU texture baking.** Every texture is a GLSL `surf()` function rendered into a
render target. Normal maps are derived by Sobel-sampling the same function rather
than being authored separately, so the normal can never disagree with the albedo
it belongs to.

**Noise.** Perlin FBM and ridged Perlin, Ashima simplex in 2D and 3D, periodic
domain-wrapped Perlin taking a `vec2` period so a texture can tile at a different
rate on each axis, and Worley cellular noise.

**Sky and lighting.** Atmospheric scattering is baked to a cube and
PMREM-prefiltered, which means the sky you look at and the image-based lighting on
every surface are literally the same function evaluated twice, instead of a
skybox plus a separately tuned ambient term that drifts away from it.

**Canopy shadowing.** The canopy is not in the shadow map. It is replaced by an
analytic transmittance term, which is both cheaper and better behaved than trying
to resolve a hundred thousand leaf cards in a depth buffer.

**Volumetrics.** A half-resolution dithered raymarch for the light shafts.

**Post-processing.** The scene is never tone mapped more than once, and the tone
map is the last thing that happens rather than the first. Everything that adds
or moves light — in-scattered mist, lens glare, defocus, the shutter — happens
in linear HDR before the curve, because all of it is radiance. The grade sits on
both sides of the curve: channel crosstalk and an ASC slope/offset/power on the
linear side, where a film stock's response lives, and the toe, the midtone
contrast and the split tone after the transfer function, where a print's
densities live. Putting the print half in linear is a mistake worth naming: a
toe lift of 0.014 becomes thirty-two code values there.

The circle of confusion is the thin-lens formula for a 35 mm lens at f/2.8
focused at 5.5 m, with the sensor size derived from the render's own field of
view so the two agree. Motion blur has no velocity buffer behind it; it
reconstructs screen velocity from the depth buffer and the previous frame's
view-projection, which is exact for everything in this world that is not
growing. The sky needs no special case in that reconstruction and gets none: it
has no geometry, so the buffer holds the clear value there, the far plane
unprojects, and under rotation the answer is exactly right. What had made the sky
the sharpest thing in a fast pan was not the velocity but the weight — far taps
were rejected on depth alone, and every tap on a sky pixel is far. Rejection is
now on parallax, which pure rotation puts at zero.

The numbers these were tuned to are all differences of controlled pairs, which is
to say two frames from one frozen world state with one term switched between
them. It matters more than it sounds: the predecessor of `tools/fx.mjs` set each
half of a pair up from scratch, so the two frames were two seconds of falling
water apart and differencing them measured the waterfall. Grain measures a
luminance sigma of 1.24 over a frame and 1.60 at the peak of its density curve,
against 0.88 in deep shadow and 0.82 in the shoulder. Bloom adds 1.17 code values
to the frame mean at the falls and 8.0 across the top of the curtain, and 0.00 —
to the last code value — in a dark corner a third of a frame away, which is the
difference between veiling glare and haze. Defocus removes 42 to 52 per cent of
the laplacian energy of the near understory, at every tier. The shutter's blur
grows monotonically to at least 137 degrees a second, where a frame travels 43
pixels against a sampling limit of 56, and the sky smears with everything else.

Nothing on the walk clips. The largest single channel value in a frame is 241, at
all seven stops on all four tiers, and the share at or above 245 is 0.000 per
cent — which is the standing requirement for the waterfall and is met with room to
spare.

**Audio.** The DSP is pure functions: `Float32Array` in, `Float32Array` out, with
no Web Audio anywhere in the synthesis path. Only `src/audio/engine.js` touches
the Web Audio API. That separation is what lets the exact same code render the
soundscape to WAV files offline in Node, which is how it gets measured.

The ambient beds loop at 9.31, 10.69, 11.73, 12.07, 13.37, 13.93, 14.91 and 16.41
seconds. Those lengths are mutually incommensurate, so the soundscape has no
common period and never audibly repeats.

![Temple clearing](media/04-temple-clearing.jpg)

## Status

Honest version: this is not finished.

- **In:** terrain, vegetation, lighting, ruins, character, audio, water and
  post-processing.
- **Closed at 6/10 after four critic passes:** water. A blind critic scored it
  3, then 4, then 5, then 6 out of 10 and closed it there. It ruled the falling
  curtain itself closed after the third pass — the remaining gap there is satin
  instead of droplets, which is a limit of representing a fall as a swept quad
  sheet rather than something shader tuning can reach. Work after that ruling
  went to everything around the curtain: the churn dome, the plunge basin's foam
  rafts, a feeding stream above the lip, a visible brook, a planar reflection in
  the pool, readable waterline bands on the masonry, and the tongue at the lip.
  The impact zone, the worst offender for three passes, is now the best part of
  the system. What the critic left on the table for a future pass: the brook's
  banks are still straight, the reflection is soft, the masonry bands do not
  quite line up between blocks, and the lip crest wants notching.
- **Reviewed at 7/10:** post-processing. A blind critic called it the best-built
  system in the project and the first whose defining quality is restraint rather
  than effort, scoring the aberration 9 and the vignette, the grade and the
  near-field defocus 8 each. Its punch list has been worked: the sky no longer
  sits sharp in a fast pan, the shutter no longer stops getting blurrier at a
  third of the rate it should, defocus is real on `low` and `medium` instead of
  being a measured no-op there, the bloom pyramid reaches far enough to be worth
  having, and the grain is at an amplitude a soft frame can use.
- **Open, and the largest thing left in the project:** the middle distance.
  Everything past about eight metres reads as a flat khaki wall. The haze is too
  thick, the greens have almost no channel separation — the green channel's lead
  over red in the sunlit canopy is 1.7 code values where footage would have
  several times that — and there is no backlit leaf translucency, so depth is
  carried by fog rather than by silhouette layering and occlusion. It is one
  problem wearing three costumes across the vegetation, lighting and grading
  systems. It was started and backed out again rather than shipped half checked;
  the reasoning is in `a8842aa` and in the comment above `GRADE` in
  `src/render/grade.js`. It should be picked up in the vegetation and lighting
  materials first, because a grade cannot manufacture channel separation the
  render did not hand it.

The vegetation and lighting critics signed off at 5/10 and 6/10 respectively, and
they signed off on diminishing returns rather than on perfection.

![The falls through haze](media/05-falls.jpg)

## A note on dependencies

`package.json` has zero runtime npm dependencies, but this is not a page that
loads nothing over the network: Three.js r170 is fetched from a jsDelivr CDN at
runtime through an importmap in `index.html`. Three.js and nothing else.

The zero-asset claim is a separate one, and it is airtight. There is no
`TextureLoader`, `GLTFLoader`, `RGBELoader`, `AudioLoader`, `fetch`,
`XMLHttpRequest`, `new Image` or `createImageBitmap` anywhere in `src/`.

## How it was built

The original brief this was built from is kept unedited in [PROMPT.md](PROMPT.md).

Each system was built and then reviewed by a separate critic that saw only
rendered screenshots and never the source. The critic scored photorealism against
real jungle photography, and the system was iterated until it passed.

Reviewing renders rather than code caught real bugs that reading the source would
not have:

- Tree trunks rendering black, from inverted quad winding.
- Dark outlines around every leaf, from a premultiplied-alpha bug in the texture
  baker.
- Volumetric light shafts standing vertically at sunset, because canopy distance
  was being measured straight up instead of along the sun ray.

## Licence

MIT. See [LICENSE](LICENSE).
