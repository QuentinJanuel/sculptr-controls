import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CANONICAL_CONTROL_KEYS,
  CONTROL_ACTIONS,
  gameMakerKey,
  type ControlAction,
  type HostControls,
} from "@sculptr/sdk";
import { remapPairs, type Delivery } from "./index.ts";

/**
 * The remap, and in particular its second half.
 *
 * Mapping the player's key onto the game's is the obvious part and the part that is obviously
 * working when you try it. What is easy to leave out -- and invisible until someone swaps two
 * actions -- is taking the old key *away*: without it, moving jump to Space leaves Shift jumping
 * too, and binding jump to Z while shoot is on Z means Z does both.
 */

const VK = {
  shift: 16,
  space: 32,
  left: 37,
  up: 38,
  right: 39,
  down: 40,
  r: 82,
  x: 88,
  z: 90,
} as const;

function controls(overrides: Partial<Record<ControlAction, readonly string[]>> = {}): HostControls {
  const out: Record<ControlAction, readonly string[]> = {} as Record<
    ControlAction,
    readonly string[]
  >;
  for (const action of CONTROL_ACTIONS) out[action] = [CANONICAL_CONTROL_KEYS[action]];
  return { ...out, ...overrides };
}

/** The pairs as `{ from: to }`, which is what they mean. */
function mapOf(bindings: HostControls, delivery: Delivery = "dom"): Record<number, number> {
  const out: Record<number, number> = {};
  for (const pair of remapPairs(bindings, delivery)) out[Math.floor(pair / 256)] = pair % 256;
  return out;
}

/** The private key each action's controller bindings press. F13 upwards; see PRIVATE_KEYS. */
const PRIVATE = { up: 124, down: 125, left: 126, right: 127, confirm: 128, cancel: 129, retry: 130 };

test("the canonical keys are the virtual keys this expects", () => {
  // Everything below reads as nonsense if these drift, so they are asserted rather than assumed.
  assert.equal(gameMakerKey(CANONICAL_CONTROL_KEYS.confirm), VK.shift);
  assert.equal(gameMakerKey(CANONICAL_CONTROL_KEYS.cancel), VK.z);
  assert.equal(gameMakerKey(CANONICAL_CONTROL_KEYS.retry), VK.r);
  assert.equal(gameMakerKey(CANONICAL_CONTROL_KEYS.up), VK.up);
});

test("the defaults map every key to itself and discard nothing", () => {
  const map = mapOf(controls());
  for (const action of CONTROL_ACTIONS) {
    const vk = gameMakerKey(CANONICAL_CONTROL_KEYS[action]);
    assert.equal(map[vk], vk, `${action} should be left where it is`);
  }
  assert.ok(
    !Object.values(map).includes(0),
    "a player who changed nothing should have nothing taken away",
  );
});

test("a moved action follows its new key and leaves the old one dead", () => {
  const map = mapOf(controls({ confirm: ["Space"] }));
  assert.equal(map[VK.space], VK.shift, "space should jump");
  assert.equal(map[VK.shift], 0, "and shift should no longer jump");
});

test("two actions can be swapped", () => {
  // The case the suppression pass exists for. Both keys are still in use, so neither is discarded
  // -- they simply point at each other.
  const map = mapOf(controls({ confirm: ["KeyZ"], cancel: ["ShiftLeft"] }));
  assert.equal(map[VK.z], VK.shift);
  assert.equal(map[VK.shift], VK.z);
  assert.ok(!Object.values(map).includes(0), "nothing should be discarded in a pure swap");
});

test("several keys can drive one action", () => {
  const map = mapOf(controls({ cancel: ["KeyZ", "KeyX"] }));
  assert.equal(map[VK.z], VK.z);
  assert.equal(map[VK.x], VK.z);
});

test("an action the player unbound takes its key out of use", () => {
  const map = mapOf(controls({ retry: [] }));
  assert.equal(map[VK.r], 0, "R should stop retrying");
});

test("a key with no GameMaker number is skipped rather than discarding the action", () => {
  // `gameMakerKey` answers 0 for a key GameMaker cannot name. Pushing that as a destination would
  // read as "discard", which would disable the action in every game instead of leaving it alone.
  const map = mapOf(controls({ cancel: ["BrowserFavorites"] }));
  assert.ok(!(VK.z in map) || map[VK.z] === 0, "Z is no longer bound, so it should be discarded");
  for (const to of Object.values(map)) {
    assert.ok(to !== undefined);
  }
  assert.equal(
    remapPairs(controls({ cancel: ["BrowserFavorites"] })).filter((pair) => pair < 256).length,
    0,
    "no pair should have come from an unnameable key",
  );
});

test("every pair fits the packing the GML unpacks", () => {
  const pairs = remapPairs(controls({ confirm: ["Space"], cancel: ["KeyZ", "KeyX"] }));
  for (const pair of pairs) {
    assert.ok(Number.isInteger(pair), `${pair} should be an integer`);
    assert.ok(pair >= 0 && pair <= 0xffff, `${pair} should fit two bytes`);
    assert.ok(Math.floor(pair / 256) >= 2, "a source key of 0 or 1 is not a real key");
  }
  // And the message the game parses never has an empty segment, which `real("")` would choke on.
  assert.ok(!pairs.join(",").includes(",,"));
  assert.ok(pairs.length > 0);
});

test("a pad-only action presses a key of its own, and the game's key is retired", () => {
  // The whole point of the private key. The player took jump off Shift and put it on the pad, so
  // Shift must stop jumping -- while the pad still has something to press that reaches the game.
  const map = mapOf(controls({ confirm: ["PadButton0"] }));
  assert.equal(map[PRIVATE.confirm], VK.shift, "the pad's own key reaches the game");
  assert.equal(map[VK.shift], 0, "and Shift really is retired");
});

test("a pad binding alongside a key retires the old key as usual", () => {
  // The pad presses Space here -- the player's own key -- so Shift has nothing left to do and is
  // retired like any other moved-away key. No wart: the press goes through the map.
  const map = mapOf(controls({ confirm: ["Space", "PadButton0"] }));
  assert.equal(map[VK.space], VK.shift);
  assert.equal(map[VK.shift], 0);
});

test("without a pad binding, a moved action still retires its old key", () => {
  const map = mapOf(controls({ confirm: ["Space"] }));
  assert.equal(map[VK.space], VK.shift);
  assert.equal(map[VK.shift], 0);
});

test("pad codes never become keyboard mappings", () => {
  // `gameMakerKey` has no number for them, and a 0 source would be nonsense as a map entry.
  const pairs = remapPairs(controls({ cancel: ["KeyZ", "PadButton2"], retry: ["PadAxis1Plus"] }));
  for (const pair of pairs) {
    assert.ok(Math.floor(pair / 256) >= 2, `${pair} has no real source key`);
  }
});

test("an action unbound entirely is still retired, pad rule or not", () => {
  const map = mapOf(controls({ retry: [] }));
  assert.equal(map[VK.r], 0);
});

test("the private key is the same whichever way the press is delivered", () => {
  // The map stopped depending on the route once both routes press the private key -- which is why
  // `remapPairs` no longer takes one.
  const map = mapOf(controls({ confirm: ["Space", "PadButton0"] }));
  assert.equal(map[VK.space], VK.shift, "the player's own key still works");
  assert.equal(map[PRIVATE.confirm], VK.shift, "and so does the pad's");
  assert.equal(map[VK.shift], 0, "while Shift is retired, pad binding or not");
});

test("each action's private key is distinct, so one pad binding cannot fire two actions", () => {
  const all = controls(
    Object.fromEntries(CONTROL_ACTIONS.map((a) => [a, ["PadButton0"]])) as Partial<
      Record<ControlAction, readonly string[]>
    >,
  );
  const map = mapOf(all);
  const targets = CONTROL_ACTIONS.map((a) => map[PRIVATE[a]]);
  assert.equal(new Set(targets).size, targets.length, "two actions share a private key");
});

test("a player with no pad bindings gets no private keys at all", () => {
  // Nothing about this feature should appear in the map for somebody who never touched a pad.
  const map = mapOf(controls({ confirm: ["Space"] }));
  for (const action of CONTROL_ACTIONS) {
    assert.equal(map[PRIVATE[action]], undefined, `${action} should have no private key`);
  }
});

test("an installed game keeps the key the game reads alive, because the pad presses it", () => {
  // The two routes diverge deliberately. `message` applies a press with keyboard_key_press, which
  // is not documented as being subject to the map -- and when the private key was tried there, the
  // directional bindings stopped reaching the game. So it presses the key the game reads and leaves
  // that key alive, which is what was measured working.
  const map = mapOf(controls({ cancel: ["PadButton0"] }), "message");
  assert.notEqual(map[VK.z], 0, "Z must stay alive for the pad to press it");
  assert.equal(map[PRIVATE.cancel], undefined, "and no private key is involved");
});

test("an emulated game retires it, because the pad presses a key of its own", () => {
  const map = mapOf(controls({ cancel: ["PadButton0"] }), "dom");
  assert.equal(map[PRIVATE.cancel], VK.z, "the pad's own key reaches the game");
  assert.equal(map[VK.z], 0, "and Z is retired as the player asked");
});

test("a player with no pad bindings gets the same map on either route", () => {
  const plain = controls({ confirm: ["Space"] });
  assert.deepEqual(remapPairs(plain, "dom"), remapPairs(plain, "message"));
});

test("both routes leave a player's own keyboard bindings working", () => {
  for (const delivery of ["dom", "message"] as const) {
    const map = mapOf(controls({ cancel: ["KeyU", "PadButton0"] }), delivery);
    assert.equal(map[85], VK.z, `${delivery} should still map U onto Z`);
  }
});
