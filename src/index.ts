import {
  CANONICAL_CONTROL_KEYS,
  CONTROL_ACTIONS,
  createMod,
  gameMakerKey,
  isPadBinding,
  type ControlAction,
  type HostControls,
} from "@sculptr/sdk";

/**
 * Plays any game with the keys you chose in the host.
 *
 * ## The division of labour
 *
 * The keys are **not** this mod's setting. They are chosen in the host and arrive
 * through `mod.getPlayer().controls`; this mod is only what makes a game obey them. That is the same
 * arrangement the Skin mod has with the chosen character, and it is what lets one setting work
 * across all four runtimes -- emulated or installed, GameMaker 8 or GameMaker Studio -- while the
 * host itself knows nothing about how any of them read a keyboard.
 *
 * It also means you can switch this off. If it ever gets in one game's way, untick it for that game
 * and your keys are still there for every other one.
 *
 * ## How the rebind is done
 *
 * For the keyboard, with `keyboard_set_map` -- GameMaker's own answer to "let the player choose the
 * keys". (The controller works differently; see "The controller" below.) It
 * remaps where input is read, so every way a game can ask -- `keyboard_check`, the keyboard events,
 * `keyboard_lastkey` -- agrees about which key was pressed. The game's own code is not touched at
 * all, which is why this works on a game nobody has read.
 *
 * A rebind is two halves, and the second is easy to forget. Mapping Space onto `vk_shift` makes
 * Space jump; it does not stop *Shift* jumping. So every canonical key the player has not bound to
 * something is also mapped, to `vk_nokey`, which discards it. Without that half, swapping two
 * actions -- the commonest rebind there is -- would leave both keys doing the first one.
 *
 * ## What it cannot do
 *
 * - **A game that reads some other key.** This maps the player's keys onto the keys a fangame reads
 *   by convention (arrows, Shift, Z, R). A game whose jump is Space was never reading our
 *   destination, so there is nothing to map onto. Those are the games to untick this for.
 * - **`keyboard_check_direct`.** It reads the device and bypasses the map, in GameMaker itself as
 *   much as here. Rare, and the games that use it would need the call sites rewritten instead --
 *   which would mean a `replace` verb the mod protocol does not have yet.
 * - **A game that sets its own map.** Ours is applied on Create and whenever the keys change; a game
 *   calling `keyboard_set_map` after that wins until the next time.
 *
 * ## No panel
 *
 * This mod draws nothing. It has no setting of its own -- the keys live in the host -- and a
 * panel that only repeated them would be a second place to look that can only ever agree or be
 * stale. The player already sees their bindings where they set them.
 *
 * ## Other mods' keybinds
 *
 * The map is global engine state, so another mod's keybind is read through it too. If you bind an
 * action to X while the Quicksave mod is listening on X, the game sees the canonical key and
 * Quicksave never fires. Nothing can resolve that from in here -- one physical key cannot mean two
 * things -- so the host shows you the bindings and this mod leaves every key it was not given
 * alone.
 */

/**
 * The remap, packed one pair per number: `from * 256 + to`.
 *
 * Packed rather than sent as a pair of fields because the GML that unpacks it is `div` and `mod`
 * against one `real()`, where two fields would be string parsing -- and this has to parse under
 * GameMaker 8, which has no `string_split` and no `is_undefined` to check a miss with.
 *
 * Both halves are virtual-key codes, which fit in a byte (`keyboard_set_map` takes nothing else).
 *
 * The whole list travels as one message, so it is applied in one step rather than a pair at a time.
 * A frame running with jump already moved and shoot not yet would be a frame the player cannot play.
 */
/**
 * How a controller press reaches this game, which decides which key it presses.
 *
 * `dom` -- the host is running the game itself, so a real `KeyboardEvent` in its frame *is* a key
 * press. It enters through the game's ordinary input path, so the remap translates it: the pad
 * presses the player's own key and the game's key is retired as usual.
 *
 * `message` -- the game is an installed `.exe` in a process of its own, and the mod's JavaScript
 * lives in a window with no canvas. The press travels down the channel and the GML applies it with
 * `keyboard_key_press`, and nobody has written down whether *that* is subject to the remap. So it
 * presses the key the game reads directly, and the remap is told to leave that key alone -- correct
 * either way, at the cost of the game's own key still working for that action.
 */
export type Delivery = "dom" | "message";

/**
 * The key a controller presses for each action -- one no keyboard has.
 *
 * A controller cannot be remapped the way a keyboard can, so a pad input works by pressing a key on
 * the player's behalf. Pressing a *real* key is what forced an awkward choice: press the key the
 * game reads and it can never be retired, so binding jump to a pad button left Shift jumping too;
 * press the player's own key and an action bound only to a pad has no key to press.
 *
 * A key the player cannot possibly press has neither problem. F13 upwards have not been on a
 * keyboard since the 1980s, they are ordinary virtual keys that GameMaker is happy to map, and each
 * action gets its own -- so the pad presses F13, the remap turns it into `vk_shift`, the game jumps,
 * and Shift itself is retired exactly as the player asked.
 *
 * One per action and never shared: two actions on one key would make a pad binding fire both.
 */
const PRIVATE_KEYS: Readonly<Record<ControlAction, string>> = {
  up: "F13",
  down: "F14",
  left: "F15",
  right: "F16",
  confirm: "F17",
  cancel: "F18",
  retry: "F19",
};

export function remapPairs(controls: HostControls, delivery: Delivery = "dom"): number[] {
  const pairs: number[] = [];
  /** Every physical key the player bound to anything, so the suppression pass can tell a key that
   *  moved from a key that is still in use. */
  const bound = new Set<number>();

  for (const action of CONTROL_ACTIONS) {
    const to = gameMakerKey(CANONICAL_CONTROL_KEYS[action]);
    // `0` is `gameMakerKey` saying it has no number for this key. A destination of 0 would mean
    // "discard", so an action whose canonical key it cannot name has to be skipped rather than
    // mapped onto nothing -- that would silently disable the action for every game.
    if (!to) continue;
    for (const code of controls[action]) {
      const from = gameMakerKey(code);
      if (!from) continue;
      pairs.push(from * 256 + to);
      bound.add(from);
    }
  }

  // An action with a controller binding keeps its canonical key alive, even when the player has
  // moved that action onto a different key.
  //
  // How a controller binding reaches the game, which the two routes answer differently.
  //
  // `dom` gets the private key: the pad presses F13.., the map turns it into the key the game reads,
  // and the player's old key is retired exactly as they asked. Measured working on both emulators.
  //
  // `message` does not. It would depend on `keyboard_key_press` being subject to the map, which
  // GameMaker does not document -- and measuring it from inside a running game was tried and does
  // not work: the mod library runs every receive handler and the object's own step code in one
  // event, so a press and the reading of it land in the same frame, before input state settles.
  // Using the private key there anyway stopped the directional bindings reaching the game.
  //
  // So it keeps what was measured working: press the key the game reads, and leave that key alive.
  // The cost is that unbinding a key does not stop it working on an installed game -- a smaller
  // fault than a control that does nothing, and the only known limitation of this feature.
  for (const action of CONTROL_ACTIONS) {
    if (!controls[action].some(isPadBinding)) continue;
    const to = gameMakerKey(CANONICAL_CONTROL_KEYS[action]);
    if (!to) continue;
    if (delivery === "dom") {
      // A key of the pad's own, pointed at the key the game reads. The canonical key is deliberately
      // not marked bound, so it is retired below unless the player kept it.
      const from = gameMakerKey(PRIVATE_KEYS[action]);
      if (from) {
        pairs.push(from * 256 + to);
        bound.add(from);
      }
    } else {
      // The pad presses this key, so it cannot be retired -- at the cost of the player's old key
      // still working. See `Delivery` for why the installed route cannot do better than this.
      bound.add(to);
    }
  }

  // The second half of a rebind: a canonical key the player no longer uses for anything must stop
  // doing what it used to. A key they *did* bind already has an entry above and must not be
  // discarded -- including the overwhelmingly common case of a key still bound to its own action,
  // whose entry is simply the identity.
  for (const action of CONTROL_ACTIONS) {
    const canonical = gameMakerKey(CANONICAL_CONTROL_KEYS[action]);
    if (!canonical || bound.has(canonical)) continue;
    pairs.push(canonical * 256);
  }

  return pairs;
}

/**
 * ## The controller
 *
 * **The host reads the pad and presses a key with it.** The game never learns a controller exists,
 * which is just as well: few GameMaker games were written for one.
 *
 * The reading is the Gamepad API, in the frame the game runs in. The press is a real
 * `KeyboardEvent` dispatched there -- both engines read the keyboard from DOM events and neither
 * checks `isTrusted`, so to the game it is a key press like any other, going through the remap and
 * `keyboard_check_pressed` and the keyboard events with no special case anywhere. The on-screen
 * touch pad has always worked this way.
 *
 * Two designs were tried first and are worth recording, because both look better on paper:
 *
 * 1. **The game reads the pad itself**, with `joystick_*` in GML. One mechanism, no latency, and
 *    what a GameMaker game would normally do. Abandoned because under Wine, DirectInput hands a real
 *    runner a version of the controller that neither matches what the browser sees nor holds still:
 *    on one pad the buttons flicker continuously while it sits untouched on a desk. The browser
 *    reads that same pad perfectly.
 * 2. **The pad read here, the press sent to the game as a message**, applied with
 *    `keyboard_key_press`. That reaches an installed game too, but it needs an engine function that
 *    one of the two emulators does not implement, and it costs a round trip per press.
 *
 * What is here instead costs nothing and needs nothing: the press lands in the same frame, in the
 * same document, through the path the engines already use.
 *
 * **An installed game is reached a second way**, because there is no shared document to dispatch
 * into: the press travels down the channel and the GML applies it with `keyboard_key_press`. That
 * needs no engine work, because an installed game runs on a real GameMaker runner, which has that
 * function -- it is only the emulators where one of the two does not. See `Delivery` for which key
 * each route presses and why they differ.
 *
 * ## Which key a controller input presses
 *
 * Not the same one on both routes, which `Delivery` and `PRIVATE_KEYS` explain in full. In short:
 * where the press is a real key event it presses a key no keyboard has, and the player's own key is
 * retired as they asked; where it travels as a message it presses the key the game reads, because
 * nothing can establish whether `keyboard_key_press` is subject to the map.
 */

/** How far an axis must travel to count as pressed, and how far back before it is released. Two
 *  numbers so a stick resting near the line does not press and release every frame. */
const AXIS_PRESS = 0.5;
const AXIS_RELEASE = 0.35;

/** Every connected pad. The array has holes and stale entries, so it is filtered rather than used. */
function connectedPads(): Gamepad[] {
  if (typeof navigator === "undefined" || !navigator.getGamepads) return [];
  return [...navigator.getGamepads()].filter((pad): pad is Gamepad => pad !== null);
}

export default createMod((mod) => {
  mod.resource.object.create({
    name: "controls",
    visible: false,
    depth: 0,
    events: {
      // `send("ready")` on every Create, not once at launch. These games restart on death, and a
      // restart rebuilds this object with the engine's map back at its default -- a one-shot push
      // would be quietly undone by the first death. Asking again is what survives that.
      create: ({ send }) => `
        keyboard_unset_map();
        ${send("ready")}
      `,
    },
    receive: {
      // The pairs, comma-separated. Unset first, so this is the whole map rather than a layer on
      // the last one -- a player who unbinds an action would otherwise keep its old entry forever.
      // One controller press or release, for an installed game: `vk * 2 + (down ? 1 : 0)`, so the
      // GML parses one `real`. Several can arrive in a frame -- a stick crossing centre releases one
      // direction and presses the other -- and each is its own message, applied in order.
      key: ({ payload }) => `
        var ck_one;
        ck_one = real(${payload});
        if (ck_one mod 2 == 1) keyboard_key_press(ck_one div 2);
        else keyboard_key_release(ck_one div 2);
      `,
      map: ({ payload }) => `
        var cm_rest, cm_at, cm_pair;
        keyboard_unset_map();
        cm_rest = ${payload};
        while (string_length(cm_rest) > 0) {
          cm_at = string_pos(",", cm_rest);
          if (cm_at == 0) {
            cm_pair = real(cm_rest);
            cm_rest = "";
          } else {
            cm_pair = real(string_copy(cm_rest, 1, cm_at - 1));
            cm_rest = string_delete(cm_rest, 1, cm_at);
          }
          keyboard_set_map(cm_pair div 256, cm_pair mod 256);
        }
      `,
    },
  });

  /** Null until the game has said hello. A push before that has nowhere to go, and the game asks on
   *  its own Create anyway, so there is nothing to queue. */
  let live = false;

  /**
   * How this game can be reached, decided once the game exists.
   *
   * By looking for the canvas, because that is the thing that actually matters: a key event is only
   * a key press if it is dispatched where the engine is listening. The host running the game itself
   * means the mod's JavaScript and the canvas share a document; an installed game means the mod runs
   * in a window of its own and the game is another process entirely.
   */
  let delivery: Delivery = "dom";


  function resolveDelivery(): Delivery {
    const canvas = typeof document === "undefined" ? null : document.querySelector("canvas");
    return canvas ? "dom" : "message";
  }

  function push(): void {
    if (!live) return;
    mod.send("map", remapPairs(mod.getPlayer().controls, delivery).join(","));
  }

  // -- the controller ------------------------------------------------------------------------------

  /** Binding code -> the `KeyboardEvent.code` it presses. Rebuilt whenever the controls change. */
  let bindings = new Map<string, string>();
  /** Keys this mod is holding, and how many pad inputs hold each. Counted because two bindings can
   *  press one key -- the d-pad and a stick both on `left` -- and releasing one must not let go of a
   *  key the other still holds. */
  const held = new Map<string, number>();
  /** Which binding codes were active last poll, so only changes are sent. */
  let active = new Set<string>();

  function rebuild(): void {
    releaseAll();
    const controls = mod.getPlayer().controls;
    const next = new Map<string, string>();
    for (const action of CONTROL_ACTIONS) {
      // The action's private key, whichever route the press takes. What differs between routes is
      // only how it is *spelled*: a `KeyboardEvent.code` for one, a virtual-key number for the
      // other. Both are kept as strings so one map and one held-count serve both.
      // Which key, and how it is spelled: a `KeyboardEvent.code` where the press is a real event,
      // a virtual-key number where it travels as a message.
      const code =
        delivery === "dom" ? PRIVATE_KEYS[action] : CANONICAL_CONTROL_KEYS[action];
      const key = delivery === "dom" ? code : String(gameMakerKey(code));
      if (key === "0") continue;
      for (const code of controls[action]) {
        if (isPadBinding(code)) next.set(code, key);
      }
    }
    bindings = next;
  }

  /**
   * Presses or releases a key where the engine is listening.
   *
   * A real `KeyboardEvent`, dispatched in the frame the game runs in. Both engines read the keyboard
   * from DOM events and neither checks `isTrusted`, so to the game this *is* a key press -- it goes
   * through the remap, through `keyboard_check_pressed`, through the keyboard events, through
   * everything, with no special case anywhere. It is also what the on-screen touch pad has always
   * done.
   *
   * Dispatched on the canvas and allowed to bubble, because the two engines listen in two places:
   * OpenGMK on the canvas element, OpenGM on the frame's `window`.
   */
  function sendKey(key: string, down: boolean): void {
    if (delivery === "message") {
      mod.send("key", String(Number(key) * 2 + (down ? 1 : 0)));
      return;
    }
    const target = document.querySelector("canvas");
    if (!target) return;
    target.dispatchEvent(
      new KeyboardEvent(down ? "keydown" : "keyup", { code: key, bubbles: true, cancelable: true }),
    );
  }

  function press(code: string): void {
    const key = bindings.get(code);
    if (key === undefined) return;
    const count = held.get(key) ?? 0;
    held.set(key, count + 1);
    if (count === 0) sendKey(key, true);
  }

  function lift(code: string): void {
    const key = bindings.get(code);
    if (key === undefined) return;
    const count = held.get(key) ?? 0;
    if (count <= 1) {
      held.delete(key);
      if (count === 1) sendKey(key, false);
      return;
    }
    held.set(key, count - 1);
  }

  function releaseAll(): void {
    for (const key of held.keys()) sendKey(key, false);
    held.clear();
    active = new Set();
  }

  function poll(): void {
    if (bindings.size === 0) return;
    const now = new Set<string>();
    for (const pad of connectedPads()) {
      pad.buttons.forEach((button, index) => {
        if (button.pressed) now.add(`PadButton${index}`);
      });
      pad.axes.forEach((value, index) => {
        const plus = `PadAxis${index}Plus`;
        const minus = `PadAxis${index}Minus`;
        if (value >= (active.has(plus) ? AXIS_RELEASE : AXIS_PRESS)) now.add(plus);
        else if (-value >= (active.has(minus) ? AXIS_RELEASE : AXIS_PRESS)) now.add(minus);
      });
    }
    // Releases first: a stick crossing centre ends one binding and starts another in the same poll,
    // and pressing before releasing would put the game through an instant with both directions held,
    // which that axis physically cannot be in.
    for (const code of active) if (!now.has(code)) lift(code);
    for (const code of now) if (!active.has(code)) press(code);
    active = now;
  }

  /** The poll timer, once the game is actually running. Null until then. */
  let polling: ReturnType<typeof setInterval> | null = null;

  mod.on("ready", () => {
    live = true;
    delivery = resolveDelivery();
    rebuild();
    push();
    // Started here rather than at activate, and this is not a detail. `activate()` runs twice for
    // an installed game -- once in the renderer to decide what GML to bake, once again where the
    // mod's JavaScript actually lives -- so a timer started there would run in a place with no game
    // to talk to. It also never stops: nothing ends an activate pass, which is enough to keep a
    // Node process alive forever.
    //
    // `setInterval`, not `requestAnimationFrame`: for an installed game this runs in a hidden
    // window, which never composites, so rAF would not fire at all. Background throttling is
    // already off for that window, so a 16ms timer really does run at 16ms.
    polling ??= setInterval(poll, 16);
  });

  // Rebinding while a game is up is the one of these a player might actually do, and the host
  // can let them do it mid-game.
  mod.onPlayerChange(() => {
    rebuild();
    push();
  });

});
