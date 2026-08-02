import test from 'node:test';
import assert from 'node:assert/strict';

import { SCENARIOS, explicitScenarioFor, scenarioFor } from '../src/scenario.js';
import {
  DEFAULT_LEVELS, LEVELS, resetLevelOverrides, setLevelOverrides,
} from '../src/audio/score.js';

test('scenarioFor accepts documented forms and rejects prototype keys', () => {
  assert.equal(scenarioFor(''), 'jungle');
  assert.equal(scenarioFor('#forest'), 'forest');
  assert.equal(scenarioFor('#forest&tier=low'), 'forest');
  assert.equal(scenarioFor('#scenario=forest&manual'), 'forest');
  assert.equal(scenarioFor('#constructor'), 'jungle');
  assert.equal(scenarioFor('#scenario=toString'), 'jungle');
  assert.equal(explicitScenarioFor(''), null);
  assert.equal(explicitScenarioFor('#scenario=forest'), 'forest');
  assert.equal(explicitScenarioFor('#constructor'), null);
  assert.ok(Object.hasOwn(SCENARIOS, scenarioFor('#forest')));
});

test('score overrides are finite, own properties and resettable', () => {
  resetLevelOverrides();
  setLevelOverrides({ cicada: -33, constructor: 12, birds: NaN });
  assert.equal(LEVELS.cicada, -33);
  assert.equal(LEVELS.birds, DEFAULT_LEVELS.birds);
  assert.equal(Object.hasOwn(LEVELS, 'constructor'), false);
  resetLevelOverrides();
  assert.deepEqual(LEVELS, DEFAULT_LEVELS);
});
