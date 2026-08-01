# The original brief

This is the prompt the project was built from, kept here unedited for reference.

> I want you to build a first-person exploration game set in a dense jungle trail that leads into ancient stone ruins with a waterfall at the end. It should look like a real jungle — not stylized, not low-poly. Think documentary footage: volumetric mist, light filtering through the canopy, wet leaves, moss on stone, the sound of birds and water getting louder as you approach the falls. The player walks a single winding path. Dense canopy at the start, narrowing trail, then it opens into a clearing with crumbling stone ruins overgrown with vines, and a waterfall pouring down a cliff face behind them. No combat, no UI, no HUD. Just movement and atmosphere. Do this in Three.js. Zero external assets. Every texture, every mesh, every sound must be generated procedurally in code.
>
> How to build this: Work on ONE system at a time in this exact order. Do NOT fan out multiple sub-agents in parallel — my machine can't handle it. Build each system sequentially:
>
> 1. Terrain and path geometry
> 2. Vegetation (trees, vines, ferns, ground cover)
> 3. Lighting and atmosphere (god rays, mist, ambient occlusion)
> 4. Stone ruins and temple geometry
> 5. Waterfall and water (river, splash particles, wet surfaces)
> 6. Sound design (procedural ambient: birds, insects, water, wind)
> 7. Post-processing and polish (color grading, depth of field, motion)
>
> For each system: build it, then spawn ONE separate sub-agent as a harsh visual critic. The critic should compare the result against real jungle photography and rate whether it looks photorealistic. If it doesn't, keep iterating on that system before moving to the next one. The critic must never be the same agent that built the thing. It should only see the rendered output, not the code. /loop on each system until the critic says it genuinely looks like a real jungle, not a game. Then move to the next system.
>
> Don't stop until walking this trail feels like watching a nature documentary, not playing a video game.

## How it actually went

The build did follow the system-by-system order above, and the blind-critic loop was
used throughout. The critic only ever saw rendered screenshots and never the source.

The honest scores:

| System | Outcome |
|---|---|
| Vegetation | Signed off at 5/10, after six rounds |
| Lighting | Signed off at 6/10, after three rounds |
| Water | Three passes so far, still being iterated |

One instruction was relaxed during the build: the "no parallel sub-agents"
constraint. The user lifted it later, once they were not gaming.

## What the critic loop caught

Reviewing rendered output rather than code found real bugs, and specifically the
kind a human reviewer would probably have noticed and then not bothered to chase
down:

- **Black tree trunks.** Traced to inverted quad winding in the tube builder,
  compounded by a moss layer that was eating the bark.
- **Dark outlines on every leaf.** A premultiplied-alpha bug in the texture baker.
- **Volumetric shafts standing vertical at sunset.** Canopy distance was being
  measured straight up instead of along the sun ray.
- **A pale slab above the waterfall's lip.** A grazing reflection was painting
  fast broken water with the colour of the canopy gap.
